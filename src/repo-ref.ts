// The forge repository sandbar's tracker calls address, and the one function
// that decides whether the git remote agrees with it (#34).
//
// Every `gh` call sandbar makes now names its repository with
// `--repo <owner>/<name>`, built from `config.ghOwner`/`config.ghRepo`. Before
// that, all of them except `forge-verify.ts`'s identified the repo the way `gh`
// does by default: from the git remotes of the directory the command ran in.
// #34 fixed the *directory* (nothing inherits `process.cwd()` any more) but not
// the *class* — it moved the answer from "wherever the process was launched" to
// "wherever the cache's origin points", which is still not the configured repo
// and still nothing anyone declared.
//
// Naming the repo is the structural fix: `ghOwner`/`ghRepo` are required config
// fields, so tracker access becomes a function of the config file rather than
// of a directory's remotes, and `fetchCandidates` (the planner queue) and
// `fetchIssueStates` (the authoritative state batch) can no longer resolve the
// same issue numbers in two different repositories.
//
// What that leaves — and why `parseRepoFromRemoteUrl` exists — is the OTHER
// half of the same disagreement. `gh` now follows the config; `git push` still
// follows the cache's `origin`, which is copied from the operator's checkout.
// If those two name different repositories, sandbar lands code in one and closes
// the issues in the other, silently, and `mergeMode: "verified"` polls checks
// for a sha the configured repo has never seen. So preflight compares them
// once, loudly, at startup.

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

// The `owner/name` a git remote URL points at, or null when the URL is not one
// this can read confidently.
//
// Null is the important half of the contract. This answer feeds a preflight
// check that REFUSES to run on a mismatch, so a wrong parse is a run that
// cannot start against a perfectly good configuration — strictly worse than the
// silent split it is trying to prevent, because the silent split at least only
// bites the misconfigured. Every shape that cannot be read as a forge URL with
// an owner and a repository therefore returns null and the check downgrades
// itself to a warning naming the URL.
//
// Read confidently:
//   https://github.com/owner/repo(.git)     — and any host, so GHE works
//   ssh://git@github.com/owner/repo(.git)
//   git@github.com:owner/repo(.git)         — scp-like, the `gh`/GitHub default
//   ghalias:owner/repo                      — an `insteadOf` alias, where the
//                                             host is unknowable but the path
//                                             still names the repository
//
// Deliberately NOT read (null):
//   /srv/git/repo.git, ../mirror, ~/repos/x — filesystem paths. `git/repo`
//                                             would parse out of the first one
//                                             and refuse the run.
//   file:///srv/git/repo.git                — the same thing with a scheme.
//   https://github.com/owner                — one path segment names no repo.
//
// A local-path origin alongside a real `ghOwner`/`ghRepo` is exactly the case
// the warning is for: it is not obviously wrong (a mirror that syncs would
// work in `direct` mode) and it is not something this can verify.
export function parseRepoFromRemoteUrl(url: string): RepoRef | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;

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
    path = afterScheme.slice(slash + 1);
  } else if (
    trimmed.startsWith("/") ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("~")
  ) {
    // An unambiguous filesystem path.
    return null;
  } else {
    // scp-like `[user@]host:path`, or an `insteadOf` alias `name:path`. The
    // host half is unusable (an alias is not a hostname) but the path half
    // still names the repository, which is all this needs.
    const colon = trimmed.indexOf(":");
    if (colon < 0) return null;
    path = trimmed.slice(colon + 1);
    // `host:1234` is a port, not a path — and a Windows drive letter (`C:\..`)
    // lands here too. Neither names a repository.
    if (/^\d+$/.test(path) || path.startsWith("\\")) return null;
  }

  const segments = path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;

  const owner = segments[segments.length - 2];
  const rawName = segments[segments.length - 1];
  if (owner === undefined || rawName === undefined) return null;
  const name = rawName.replace(/\.git$/, "");
  if (owner === "" || name === "") return null;
  return { owner, name };
}
