import { describe, expect, it } from "vitest";
import { checkInvariants, type RepoState } from "./preflight.js";

const cleanState: RepoState = {
  hasGit: true,
  hasGh: true,
  hasContainerRuntime: true,
  missingImages: [],
  ghAuthOk: true,
  sandboxGhTokenOk: true,
  hasAgentCredential: true,
  sourceBranch: "main",
  hasOriginBranch: true,
  unmergedIssueBranches: [],
  discardedIssueBranches: [],
  resumableIssueBranches: [],
  configuredRepo: { owner: "acme", name: "app" },
  originUrl: "https://github.com/acme/app.git",
  originRepo: { owner: "acme", name: "app" },
};

function failures(s: RepoState): string[] {
  return checkInvariants(s).flatMap((r) => (r.ok ? [] : [r.message]));
}

// #34 — `gh` now names `ghOwner`/`ghRepo` on every call while `git push` still
// goes to the cache's `origin`, which is copied from the operator's checkout
// and declared by nobody. Naming the tracker cannot make the two AGREE, so
// preflight compares them; every symptom of a mismatch is silent and lands
// somewhere real (issues closed in one repo for commits pushed to another).
describe("checkInvariants — the tracker and the git remote name one repo (#34)", () => {
  it("passes when origin and ghOwner/ghRepo are the same repo", () => {
    expect(failures(cleanState)).toEqual([]);
  });

  it("refuses when origin points at a different repo, naming both", () => {
    const f = failures({
      ...cleanState,
      originUrl: "https://github.com/acme/app-fork.git",
      originRepo: { owner: "acme", name: "app-fork" },
    });
    const msg = f.find((m) => m.includes("ghOwner/ghRepo"));
    expect(msg).toBeDefined();
    expect(msg).toContain("acme/app");
    expect(msg).toContain("acme/app-fork");
    // The URL itself, because "origin is acme/app-fork" is not actionable
    // without knowing which remote said so.
    expect(msg).toContain("https://github.com/acme/app-fork.git");
  });

  // GitHub owner and repo names are case-insensitive and `gh` follows a
  // case-differing --repo without complaint, so refusing here would be
  // refusing a working configuration.
  it("accepts a case difference", () => {
    expect(
      failures({
        ...cleanState,
        originUrl: "git@github.com:ACME/App.git",
        originRepo: { owner: "ACME", name: "App" },
      }),
    ).toEqual([]);
  });

  // A URL `parseRepoFromRemoteUrl` will not commit to (a local mirror, most
  // likely) is reported by runPreflight as a warning, not turned into a guess
  // here: a wrong parse REFUSES a working configuration, which is worse than
  // the split it is trying to catch.
  it("stays silent when origin could not be read as a repo", () => {
    expect(
      failures({
        ...cleanState,
        originUrl: "/srv/git/app.git",
        originRepo: null,
      }),
    ).toEqual([]);
  });

  it("stays silent when there is no origin URL at all", () => {
    expect(
      failures({ ...cleanState, originUrl: null, originRepo: null }),
    ).toEqual([]);
  });
});

describe("checkInvariants", () => {
  it("passes on a fully clean state", () => {
    expect(failures(cleanState)).toEqual([]);
  });

  it("flags missing git", () => {
    const f = failures({ ...cleanState, hasGit: false });
    expect(f.some((m) => m.includes("`git` is not on PATH"))).toBe(true);
  });

  it("flags missing gh", () => {
    const f = failures({ ...cleanState, hasGh: false });
    expect(f.some((m) => m.includes("`gh` is not on PATH"))).toBe(true);
  });

  it("flags missing container runtime", () => {
    const f = failures({ ...cleanState, hasContainerRuntime: false });
    expect(f.some((m) => m.includes("podman") && m.includes("PATH"))).toBe(true);
  });

  // The referenced-but-not-built images (#24 D7). Preflight refuses rather than
  // pulling, so the message has to be the pull command itself — an operator who
  // has to go and derive it from config is the failure mode this replaces.
  it("flags every missing gate-stack image with the exact pull command", () => {
    const f = failures({
      ...cleanState,
      missingImages: ["docker.io/library/mariadb:10.11", "docker.io/mailhog/mailhog:latest"],
    });
    const msg = f.find((m) => m.includes("gate-stack image"));
    expect(msg).toBeDefined();
    expect(msg).toContain("podman pull docker.io/library/mariadb:10.11");
    expect(msg).toContain("podman pull docker.io/mailhog/mailhog:latest");
    expect(msg).toContain("2 gate-stack image(s)");
  });

  it("does not flag images when none are missing", () => {
    expect(failures({ ...cleanState, missingImages: [] })).toEqual([]);
  });

  it("flags failed gh auth", () => {
    const f = failures({ ...cleanState, ghAuthOk: false });
    expect(f.some((m) => m.includes("gh auth status"))).toBe(true);
  });

  // Names `config.env` rather than a file path (#38): sandbar no longer knows
  // where the value came from, so pointing at a path it invented would send the
  // operator to a file they may not have.
  it("flags an invalid sandbox GH_TOKEN (points at config.env)", () => {
    const f = failures({ ...cleanState, sandboxGhTokenOk: false });
    expect(
      f.some(
        (m) =>
          m.includes("GH_TOKEN") &&
          m.includes("config.env") &&
          m.includes("rejected by GitHub"),
      ),
    ).toBe(true);
  });

  it("flags missing agent credential and names both env-var options", () => {
    const f = failures({ ...cleanState, hasAgentCredential: false });
    expect(
      f.some(
        (m) =>
          m.includes("CLAUDE_CODE_OAUTH_TOKEN") &&
          m.includes("ANTHROPIC_API_KEY"),
      ),
    ).toBe(true);
  });

  // The operator-state invariants ("not on <sourceBranch>", "an in-progress
  // merge/rebase was detected") are GONE, not moved (#38 item 7). They existed
  // only because a human might be standing in the directory sandbar operated
  // on. Against the bare cache they are vacuous; pointed at `config.cwd` they
  // would fail runs because the operator is mid-rebase in their own repo.
  it("says nothing about the operator's branch or in-progress operations", () => {
    const f = failures(cleanState);
    expect(f).toEqual([]);
    const all = checkInvariants({ ...cleanState, hasOriginBranch: false })
      .flatMap((r) => (r.ok ? [] : [r.message]))
      .join("\n");
    expect(all).not.toMatch(/MERGE_HEAD|rebase|Not on/);
  });

  it("flags missing origin/<sourceBranch>", () => {
    const f = failures({ ...cleanState, hasOriginBranch: false });
    expect(f.some((m) => m.includes("origin/main"))).toBe(true);
  });

  it("flags unmerged issue branches and lists each one", () => {
    const f = failures({
      ...cleanState,
      unmergedIssueBranches: [
        "sandbar/issue-42-foo",
        "sandbar/issue-43-bar",
      ],
    });
    expect(f.length).toBe(1);
    expect(f[0]).toContain("sandbar/issue-42-foo");
    expect(f[0]).toContain("sandbar/issue-43-bar");
    expect(f[0]).toContain("git branch -D");
  });

  it("flags discarded issue branches separately from unmerged ones", () => {
    const f = failures({
      ...cleanState,
      unmergedIssueBranches: ["sandbar/issue-42-foo"],
      discardedIssueBranches: ["sandbar/issue-43-bar"],
    });
    expect(f.length).toBe(2);
    const unmergedMsg = f.find((m) => m.includes("Unmerged"));
    const discardedMsg = f.find((m) => m.includes("Discarded"));
    expect(unmergedMsg).toBeDefined();
    expect(unmergedMsg).toContain("sandbar/issue-42-foo");
    expect(unmergedMsg).not.toContain("sandbar/issue-43-bar");
    expect(discardedMsg).toBeDefined();
    expect(discardedMsg).toContain("sandbar/issue-43-bar");
    expect(discardedMsg).toContain("remote deleted");
    expect(discardedMsg).toContain("git branch -D");
  });

  it("does not flag resumable issue branches (open + queued → resumed, not refused)", () => {
    // #13: stranded work from an interrupted run is handed back to the normal
    // loop, so its branch must not be a hard pre-flight error.
    const f = failures({
      ...cleanState,
      resumableIssueBranches: ["sandbar/issue-296-keyword-escape"],
    });
    expect(f).toEqual([]);
  });

  it("flags genuinely-unmerged branches but not resumable ones alongside them", () => {
    const f = failures({
      ...cleanState,
      unmergedIssueBranches: ["sandbar/issue-99-stale"],
      resumableIssueBranches: ["sandbar/issue-296-keyword-escape"],
    });
    expect(f.length).toBe(1);
    expect(f[0]).toContain("sandbar/issue-99-stale");
    expect(f[0]).not.toContain("sandbar/issue-296-keyword-escape");
  });

  it("returns multiple distinct failures when several invariants fail", () => {
    const f = failures({
      ...cleanState,
      hasGh: false,
      hasOriginBranch: false,
      hasAgentCredential: false,
    });
    expect(f.length).toBe(3);
  });

  it("error messages are operator-actionable (mention what to run/check)", () => {
    const broken: RepoState = {
      ...cleanState,
      hasGh: false,
      hasContainerRuntime: false,
      missingImages: ["docker.io/library/mariadb:10.11"],
      ghAuthOk: false,
      sandboxGhTokenOk: false,
      hasAgentCredential: false,
      hasOriginBranch: false,
      unmergedIssueBranches: ["sandbar/issue-1-x"],
    };
    const f = failures(broken);
    for (const msg of f) {
      expect(msg).toMatch(
        /git|gh|origin|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|Resolve|Switch|Install|stash|Configure|build|pull/,
      );
    }
  });
});
