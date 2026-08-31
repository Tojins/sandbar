// #34 — `parseRepoFromRemoteUrl` feeds a preflight check that REFUSES to run on
// a mismatch, so its two failure modes are asymmetric and both are pinned here:
// a wrong parse turns a working configuration into a run that cannot start,
// while a null merely downgrades the check to a warning. That is why every
// shape it cannot read confidently returns null rather than the closest guess.
//
// The refuse-to-guess table below is the important one, and the ssh cases in it
// are why the first version of this function was wrong: it rejected filesystem
// paths by testing the WHOLE url for a leading `/`, `.` or `~`, which catches
// `/srv/git/app.git` and sails straight past `git@host:/srv/git/app.git` — the
// same path, over ssh, which is how a mirror remote is actually written. That
// parsed confidently as `git/app` and refused the run for good.
import { describe, expect, it } from "vitest";

import { parseRepoFromRemoteUrl, repoSlug, sameRepo } from "./repo-ref.js";

describe("sameRepo", () => {
  it("is case-insensitive, because GitHub names are", () => {
    expect(
      sameRepo({ owner: "ACME", name: "App" }, { owner: "acme", name: "app" }),
    ).toBe(true);
  });

  it("separates different repos under the same owner", () => {
    expect(
      sameRepo({ owner: "acme", name: "app" }, { owner: "acme", name: "app-fork" }),
    ).toBe(false);
  });
});

describe("parseRepoFromRemoteUrl — shapes it reads", () => {
  const cases: ReadonlyArray<readonly [string, string, string | null]> = [
    // [url, owner/name, host]
    ["https://github.com/acme/app.git", "acme/app", "github.com"],
    ["https://github.com/acme/app", "acme/app", "github.com"],
    ["http://github.com/acme/app.git", "acme/app", "github.com"],
    // A token or username in the URL, which credential helpers write. The
    // userinfo must not end up in the host.
    [
      "https://x-access-token:ghp_xxx@github.com/acme/app.git",
      "acme/app",
      "github.com",
    ],
    ["ssh://git@github.com/acme/app.git", "acme/app", "github.com"],
    ["ssh://git@github.com:22/acme/app.git", "acme/app", "github.com"],
    // scp-like, which is what `gh` and GitHub's own UI hand out.
    ["git@github.com:acme/app.git", "acme/app", "github.com"],
    ["git@github.com:acme/app", "acme/app", "github.com"],
    // GitHub Enterprise: a different host, the same two path segments. The
    // host is carried, because preflight refuses when it is not the host gh
    // will actually talk to.
    ["https://github.acme-corp.com/acme/app.git", "acme/app", "github.acme-corp.com"],
    ["git@github.acme-corp.com:acme/app.git", "acme/app", "github.acme-corp.com"],
    // Hostnames are case-insensitive and this one is compared for equality.
    ["https://GitHub.COM/acme/app.git", "acme/app", "github.com"],
    // An `insteadOf` alias. The pre-colon half is a bare word, not a hostname,
    // so the host is null and preflight skips the host comparison rather than
    // refusing over a made-up one.
    ["ghalias:acme/app.git", "acme/app", null],
    // Trailing slash, and a repo whose name merely contains `git`.
    ["https://github.com/acme/app/", "acme/app", "github.com"],
    ["https://github.com/acme/gitignore.git", "acme/gitignore", "github.com"],
    // Surrounding whitespace, since this comes off `git remote get-url`.
    ["  https://github.com/acme/app.git\n", "acme/app", "github.com"],
  ];

  for (const [url, expected, host] of cases) {
    it(`reads ${url} as ${expected} on ${host ?? "(unknown host)"}`, () => {
      const parsed = parseRepoFromRemoteUrl(url);
      expect(parsed && repoSlug(parsed.repo)).toBe(expected);
      expect(parsed?.host ?? null).toBe(host);
    });
  }
});

describe("parseRepoFromRemoteUrl — shapes it refuses to guess at", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    // The plain filesystem forms.
    ["/srv/git/app.git", "an absolute filesystem path"],
    ["../mirrors/app.git", "a relative filesystem path"],
    ["~/repos/app.git", "a home-relative filesystem path"],
    ["file:///srv/git/app.git", "a filesystem path wearing a scheme"],

    // THE REGRESSION CASES. Each is the same filesystem path as above, reached
    // over ssh — the normal spelling of a self-hosted or mirror remote. Under a
    // last-two-segments rule these parse as `git/app` and `repos/app`, i.e. a
    // permanent refusal naming a repository that exists nowhere.
    ["git@gitserver.internal:/srv/git/app.git", "an ssh scp-style absolute path"],
    ["ssh://git@mirror.internal/srv/git/app.git", "an ssh URL with a deep path"],
    ["git@host:~/repos/app.git", "an scp-style home-relative path"],
    ["ssh://git@github.com/~acme/app.git", "a home directory as the owner"],

    // Exactly two segments, so a directory tree is not mistaken for a forge.
    ["https://gitlab.com/group/subgroup/app.git", "three path segments"],
    ["https://github.com/acme", "a URL with one path segment"],
    ["https://github.com/", "a URL with no path"],
    ["https://github.com", "a bare host"],

    // The name charset, which is what makes "confident" mean anything.
    ["https://github.com/acme/app.git?x=1", "a query string on the repo name"],
    ["https://github.com/acme/app#frag", "a fragment on the repo name"],
    ["https://github.com/ac me/app", "a space in the owner"],

    // Not a remote at all.
    ["", "an empty string"],
    ["origin", "a bare word"],
    ["github.com:22", "a host and port"],
    ["C:\\repos\\app", "a Windows drive path, backslash spelling"],
    ["C:/repos/app", "a Windows drive path, forward-slash spelling"],
  ];

  for (const [url, why] of cases) {
    it(`returns null for ${why} (${JSON.stringify(url)})`, () => {
      expect(parseRepoFromRemoteUrl(url)).toBeNull();
    });
  }
});
