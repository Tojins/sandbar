import { describe, expect, it } from "vitest";
import { checkInvariants, type RepoState } from "./preflight.js";

const cleanState: RepoState = {
  hasGit: true,
  hasGh: true,
  hasContainerRuntime: true,
  hasPgImage: true,
  ghAuthOk: true,
  sandboxGhTokenOk: true,
  hasAgentCredential: true,
  inProgressMarkers: [],
  currentBranch: "main",
  expectedBranch: "main",
  hasOriginBranch: true,
  envFilePath: ".sandbar/.env",
  unmergedIssueBranches: [],
  discardedIssueBranches: [],
};

function failures(s: RepoState): string[] {
  return checkInvariants(s).flatMap((r) => (r.ok ? [] : [r.message]));
}

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

  it("flags missing postgres image", () => {
    const f = failures({ ...cleanState, hasPgImage: false });
    expect(
      f.some(
        (m) =>
          m.includes("Postgres image") &&
          m.includes("pgvector/pgvector:pg18") &&
          m.includes("pull"),
      ),
    ).toBe(true);
  });

  it("flags failed gh auth", () => {
    const f = failures({ ...cleanState, ghAuthOk: false });
    expect(f.some((m) => m.includes("gh auth status"))).toBe(true);
  });

  it("flags an invalid sandbox GH_TOKEN (mentions env file path)", () => {
    const f = failures({ ...cleanState, sandboxGhTokenOk: false });
    expect(
      f.some(
        (m) =>
          m.includes("GH_TOKEN") &&
          m.includes(cleanState.envFilePath) &&
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

  it("flags MERGE_HEAD marker", () => {
    const f = failures({ ...cleanState, inProgressMarkers: ["MERGE_HEAD"] });
    expect(f.some((m) => m.includes("MERGE_HEAD"))).toBe(true);
  });

  it("flags rebase-merge marker", () => {
    const f = failures({
      ...cleanState,
      inProgressMarkers: ["rebase-merge"],
    });
    expect(f.some((m) => m.includes("rebase-merge"))).toBe(true);
  });

  it("flags multiple in-progress markers in one message", () => {
    const f = failures({
      ...cleanState,
      inProgressMarkers: ["MERGE_HEAD", "CHERRY_PICK_HEAD"],
    });
    expect(f.length).toBe(1);
    expect(f[0]).toContain("MERGE_HEAD");
    expect(f[0]).toContain("CHERRY_PICK_HEAD");
  });

  it("flags being on a feature branch (names the expected branch)", () => {
    const f = failures({ ...cleanState, currentBranch: "feature/foo" });
    expect(
      f.some((m) => m.includes("Not on `main`") && m.includes("feature/foo")),
    ).toBe(true);
  });

  it("flags a different expected branch (e.g., trunk)", () => {
    const f = failures({
      ...cleanState,
      expectedBranch: "trunk",
      currentBranch: "main",
    });
    expect(f.some((m) => m.includes("Not on `trunk`") && m.includes("main"))).toBe(
      true,
    );
  });

  it("flags missing origin/<expectedBranch>", () => {
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

  it("returns multiple distinct failures when several invariants fail", () => {
    const f = failures({
      ...cleanState,
      hasGh: false,
      currentBranch: "feature/x",
      hasAgentCredential: false,
    });
    expect(f.length).toBe(3);
  });

  it("error messages are operator-actionable (mention what to run/check)", () => {
    const broken: RepoState = {
      ...cleanState,
      hasGh: false,
      hasContainerRuntime: false,
      hasPgImage: false,
      ghAuthOk: false,
      sandboxGhTokenOk: false,
      hasAgentCredential: false,
      inProgressMarkers: ["MERGE_HEAD"],
      currentBranch: "feature/x",
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
