// The forge repository sandbar's tracker calls address, and the one function
// that decides whether the git remote agrees with it (#34).
//
// Every `gh` call sandbar makes names its repository with
// `--repo <owner>/<name>`, built from `config.ghOwner`/`config.ghRepo` —
// tracker access is a function of the config file, never of a directory's
// remotes. `git push` still follows the cache's `origin`, copied from the
// operator's checkout; if those two name different repositories, sandbar lands
// code in one and closes the issues in the other, silently. So preflight
// compares them once, loudly, at startup — which is why
// `parseRepoFromRemoteUrl` exists.

export type RepoRef = {
  readonly owner: string;
  readonly name: string;
};

// The `--repo` argument: `owner/name`.
export function repoSlug(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

// Whether two refs name the same repository. GitHub owner and repo names are
// case-insensitive (and `gh` follows a case-differing `--repo` without
// complaint), so a case difference is a cosmetic mismatch, not a wrong repo.
export function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.name.toLowerCase() === b.name.toLowerCase()
  );
}

// What a git remote URL points at — its host (when that is confidently a
// hostname) and its `owner/name` — or null when the URL is not one this can
// read confidently.
//
// Null is the important half of the contract. This answer feeds a preflight
// check that REFUSES to run on a mismatch, so a wrong parse is a run that
// cannot start against a perfectly good configuration — strictly worse than the
// silent split it is trying to prevent, because the silent split at least only
// bites the misconfigured.
//
// The first version of this got that exactly backwards for the most likely
// mirror spelling there is, and the bug is worth keeping written down because
// the shape of it is not obvious. It rejected filesystem paths by looking for a
// leading `/`, `.` or `~` on the WHOLE url — which catches `/srv/git/app.git`
// and misses `git@gitserver.internal:/srv/git/app.git` and
// `ssh://git@mirror.internal/srv/git/app.git`, the same path reached over ssh.
// Those fell through to a last-two-segments rule and parsed, confidently, as
// `git/app`: a permanent refusal naming a repository that exists nowhere, which
// is the precise outcome the paragraph above promises cannot happen.
//
// So the rule is now positive rather than subtractive — the path must LOOK like
// a forge path, not merely fail to look like a local one:
//
//   - exactly two segments. Every github.com and GHE repo path is
//     `<owner>/<repo>` and nothing else, so a third segment is evidence this is
//     a directory tree (`/srv/git/app.git`), not a forge. It also takes GitLab
//     subgroups out, which is correct here: `gh` does not talk to GitLab.
//   - no leading `/` or `~` on the scp-side path, which is what separates
//     `git@host:acme/app.git` from `git@host:/srv/git/app.git` and
//     `git@host:~/repos/app.git`.
//   - both segments must match what GitHub actually allows in a name
//     (`[A-Za-z0-9._-]`). `~acme` is a home directory, not an owner.
//
// Every one of those pushes an unrecognised shape towards null, which is the
// safe direction: the check downgrades itself to a warning naming the URL.
//
// Read confidently:
//   https://github.com/owner/repo(.git)     — and any host, so GHE parses
//   ssh://git@github.com/owner/repo(.git)
//   ssh://git@github.com:22/owner/repo.git  — with a port
//   git@github.com:owner/repo(.git)         — scp-like, the `gh`/GitHub default
//   ghalias:owner/repo                      — an `insteadOf` alias. `host` is
//                                             null (an alias is not a
//                                             hostname) but the path still
//                                             names the repository.
//
// Deliberately NOT read (null):
//   /srv/git/repo.git, ../mirror, ~/repos/x — filesystem paths.
//   git@host:/srv/git/repo.git              — the same, over ssh.
//   ssh://host/srv/git/repo.git             — the same, with a scheme.
//   file:///srv/git/repo.git                — the same, with a local scheme.
//   https://github.com/owner                — one path segment names no repo.
//   https://gitlab.com/group/sub/repo.git   — three; not a forge `gh` speaks to.
//
// A local-path origin alongside a real `ghOwner`/`ghRepo` is exactly the case
// the warning is for: it is not obviously wrong (a mirror that syncs would
// work in `direct` mode) and it is not something this can verify.
export type ParsedRemote = {
  // The host, or null when the pre-path half is not confidently a hostname —
  // an `insteadOf` alias, which is a bare word git rewrites. Preflight compares
  // this against the host `gh` will actually talk to, and skips the comparison
  // when it is null.
  readonly host: string | null;
  readonly repo: RepoRef;
};

// GitHub's own rule for owner and repository names. Anchored, so a segment that
// is a home directory (`~acme`), a query string (`app.git?x=1`) or anything
// else with structure in it fails rather than parsing into a confident answer.
const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function parseRepoFromRemoteUrl(url: string): ParsedRemote | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;

  let host: string | null;
  let path: string;

  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(trimmed);
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? "").toLowerCase();
    // `file://` is a filesystem path wearing a scheme; there is no host whose
    // path segments mean owner and repository.
    if (scheme === "file") return null;
    const afterScheme = schemeMatch[2] ?? "";
    const slash = afterScheme.indexOf("/");
    // No path at all — a bare host names no repository.
    if (slash < 0) return null;
    host = hostOf(afterScheme.slice(0, slash));
    path = afterScheme.slice(slash + 1);
  } else if (
    trimmed.startsWith("/") ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("~")
  ) {
    // An unambiguous filesystem path.
    return null;
  } else {
    // scp-like `[user@]host:path`, or an `insteadOf` alias `name:path`.
    const colon = trimmed.indexOf(":");
    if (colon < 0) return null;
    const before = trimmed.slice(0, colon);
    path = trimmed.slice(colon + 1);
    // `host:1234` is a port, not a path. A Windows drive letter (`C:\..` or
    // `C:/..`) lands here too and is caught by the leading-separator test
    // below, but the digits case has to be spelled out.
    if (/^\d+$/.test(path)) return null;
    // The whole point of the rewrite: an absolute or home-relative path on the
    // far side of the colon is a filesystem location, not `<owner>/<repo>`.
    if (path.startsWith("/") || path.startsWith("~") || path.startsWith("\\")) {
      return null;
    }
    // A pre-colon half with no `@` and no `.` is an `insteadOf` alias, not a
    // hostname — and calling it one would let preflight compare a made-up host.
    host = /[@.]/.test(before) ? hostOf(before) : null;
  }

  const segments = path.split("/").filter((s) => s.length > 0);
  // EXACTLY two. See the header: a third segment is a directory tree.
  if (segments.length !== 2) return null;

  const owner = segments[0];
  const rawName = segments[1];
  if (owner === undefined || rawName === undefined) return null;
  const name = rawName.replace(/\.git$/, "");
  if (!NAME_RE.test(owner) || !NAME_RE.test(name)) return null;
  return { host, repo: { owner, name } };
}

// The hostname out of a URL authority, dropping `user[:password]@` and any
// `:port`. Lowercased, since hostnames are case-insensitive and this is
// compared for equality.
function hostOf(authority: string): string | null {
  const at = authority.lastIndexOf("@");
  const hostPort = at < 0 ? authority : authority.slice(at + 1);
  // An IPv6 literal is bracketed; git does not support the scp spelling of one
  // and a `[..]` host is not something a forge URL carries, so this stays null
  // rather than mangling it.
  if (hostPort.startsWith("[")) return null;
  const colon = hostPort.indexOf(":");
  const host = (colon < 0 ? hostPort : hostPort.slice(0, colon)).toLowerCase();
  return host === "" ? null : host;
}
