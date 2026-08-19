// #34 — `parseRepoFromRemoteUrl` feeds a preflight check that REFUSES to run on
// a mismatch, so its two failure modes are asymmetric and both are pinned here:
// a wrong parse turns a working configuration into a run that cannot start,
// while a null merely downgrades the check to a warning. That is why every
// shape it cannot read confidently returns null rather than the closest guess.
import { describe, expect, it } from "vitest";

import { parseRepoFromRemoteUrl, repoSlug, sameRepo } from "./repo-ref.js";

describe("repoSlug", () => {
  it("is the --repo argument gh expects", () => {
    expect(repoSlug({ owner: "acme", name: "app" })).toBe("acme/app");
  });
});

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
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["https://github.com/acme/app.git", "acme/app"],
    ["https://github.com/acme/app", "acme/app"],
    ["http://github.com/acme/app.git", "acme/app"],
    // A token or username in the URL, which credential helpers write.
    ["https://x-access-token:ghp_xxx@github.com/acme/app.git", "acme/app"],
    ["ssh://git@github.com/acme/app.git", "acme/app"],
    ["ssh://git@github.com:22/acme/app.git", "acme/app"],
    // scp-like, which is what `gh` and GitHub's own UI hand out.
    ["git@github.com:acme/app.git", "acme/app"],
    ["git@github.com:acme/app", "acme/app"],
    // GitHub Enterprise: a different host, the same two trailing segments.
    ["https://github.acme-corp.com/acme/app.git", "acme/app"],
    ["git@github.acme-corp.com:acme/app.git", "acme/app"],
    // An `insteadOf` alias. The host half is not a hostname and is unusable,
    // but the path half still names the repository, which is all this needs.
    ["ghalias:acme/app.git", "acme/app"],
    // Trailing slash, and a repo whose name legitimately ends in `.git`-ish
    // text that is not the suffix.
    ["https://github.com/acme/app/", "acme/app"],
    ["https://github.com/acme/gitignore.git", "acme/gitignore"],
    // Surrounding whitespace, since this comes off `git remote get-url`.
    ["  https://github.com/acme/app.git\n", "acme/app"],
  ];

  for (const [url, expected] of cases) {
    it(`reads ${url} as ${expected}`, () => {
      const parsed = parseRepoFromRemoteUrl(url);
      expect(parsed && repoSlug(parsed)).toBe(expected);
    });
  }
});

describe("parseRepoFromRemoteUrl — shapes it refuses to guess at", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    // The case that makes refusing matter: last-two-segments would read
    // `git/app` out of this and refuse a run over a local mirror.
    ["/srv/git/app.git", "an absolute filesystem path"],
    ["../mirrors/app.git", "a relative filesystem path"],
    ["~/repos/app.git", "a home-relative filesystem path"],
    ["file:///srv/git/app.git", "a filesystem path wearing a scheme"],
    // One path segment names an owner, not a repository.
    ["https://github.com/acme", "a URL with one path segment"],
    ["https://github.com/", "a URL with no path"],
    ["https://github.com", "a bare host"],
    // Not a remote at all.
    ["", "an empty string"],
    ["origin", "a bare word"],
    // `host:port` is a port, not a path.
    ["github.com:22", "a host and port"],
    ["C:\\repos\\app", "a Windows drive path"],
  ];

  for (const [url, why] of cases) {
    it(`returns null for ${why} (${JSON.stringify(url)})`, () => {
      expect(parseRepoFromRemoteUrl(url)).toBeNull();
    });
  }
});
