import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dirtyWorktreePaths, headMismatch } from "./git-ops.js";

const exec = promisify(execFile);

// Run against a real repo rather than a mocked `git status`. What counts as
// "dirty" is git's definition, and the whole D1 argument turns on one detail of
// it that no fake would preserve: ignored files are NOT reported, which is what
// lets build artifacts survive between attempts while the tree still proves the
// gate is testing a commit.
describe("dirtyWorktreePaths (#24 D1)", () => {
  let repo: string;

  const git = (...args: string[]) => exec("git", args, { cwd: repo });

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "sandbar-gitops-"));
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await writeFile(join(repo, ".gitignore"), "node_modules/\ntest-results/\n");
    await writeFile(join(repo, "app.ts"), "export const a = 1;\n");
    await git("add", "-A");
    await git("commit", "-qm", "init");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("is empty on a tree that equals HEAD", async () => {
    expect(await dirtyWorktreePaths(repo)).toEqual([]);
  });

  // The whole D1 invariant fails OPEN on this one setting, so it is asserted
  // against a repo that has it. `git status --porcelain` honours
  // status.showUntrackedFiles, and `no` is common in large repos — it reaches a
  // per-issue worktree from ~/.gitconfig, from $GIT_CONFIG_GLOBAL, or from the
  // repo's own .git/config, which every linked worktree shares. Inherit it and
  // a forgotten `git add` reads clean: the gate then mounts files that are in
  // no commit, goes green, and the merger lands a branch that does not contain
  // what was tested. Nothing else in the system notices.
  it("still reports untracked files when the repo sets showUntrackedFiles=no", async () => {
    await git("config", "status.showUntrackedFiles", "no");
    await writeFile(join(repo, "forgotten.ts"), "export const b = 2;\n");
    // Proof the setting is live, so this test cannot silently stop testing it.
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: repo });
    expect(stdout.trim()).toBe("");

    const dirty = await dirtyWorktreePaths(repo);
    expect(dirty).toHaveLength(1);
    expect(dirty[0]).toContain("forgotten.ts");
  });

  it("still reports untracked files when showUntrackedFiles=no is global", async () => {
    // The likelier route in practice: the operator's own ~/.gitconfig.
    const home = await mkdtemp(join(tmpdir(), "sandbar-gitconfig-"));
    const cfg = join(home, "gitconfig");
    await writeFile(cfg, "[status]\n\tshowUntrackedFiles = no\n");
    const prev = process.env["GIT_CONFIG_GLOBAL"];
    process.env["GIT_CONFIG_GLOBAL"] = cfg;
    try {
      await writeFile(join(repo, "forgotten.ts"), "export const b = 2;\n");
      const dirty = await dirtyWorktreePaths(repo);
      expect(dirty).toHaveLength(1);
      expect(dirty[0]).toContain("forgotten.ts");
    } finally {
      if (prev === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
      else process.env["GIT_CONFIG_GLOBAL"] = prev;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports a modified tracked file", async () => {
    await writeFile(join(repo, "app.ts"), "export const a = 2;\n");
    const dirty = await dirtyWorktreePaths(repo);
    expect(dirty).toHaveLength(1);
    expect(dirty[0]).toContain("app.ts");
  });

  // The forgotten `git add` — overwhelmingly the common case, and the reason
  // the design refuses rather than running `git clean -fd`, which would have
  // deleted exactly this file.
  it("reports an untracked, non-ignored file", async () => {
    await writeFile(join(repo, "new.ts"), "export const b = 2;\n");
    const dirty = await dirtyWorktreePaths(repo);
    expect(dirty).toHaveLength(1);
    expect(dirty[0]).toContain("new.ts");
  });

  // The load-bearing half: a gate step's own exhaust and the repo's build
  // artifacts live here. If these counted as dirty, every attempt after the
  // first would be re-prompted to commit node_modules until the budget died —
  // and the alternative design (a second, cleaned tree) would pay a cold build
  // every attempt to avoid it.
  it("does NOT report ignored artifacts", async () => {
    await mkdir(join(repo, "node_modules/pkg"), { recursive: true });
    await writeFile(join(repo, "node_modules/pkg/index.js"), "x\n");
    await mkdir(join(repo, "test-results"), { recursive: true });
    await writeFile(join(repo, "test-results/out.xml"), "<x/>\n");
    expect(await dirtyWorktreePaths(repo)).toEqual([]);
  });

  it("is clean again once the work is committed", async () => {
    await writeFile(join(repo, "new.ts"), "export const b = 2;\n");
    expect(await dirtyWorktreePaths(repo)).toHaveLength(1);
    await git("add", "-A");
    await git("commit", "-qm", "work");
    expect(await dirtyWorktreePaths(repo)).toEqual([]);
  });

  // A staged-but-uncommitted change is still not a commit: the gate would test
  // it and the merger would never see it.
  it("reports staged changes", async () => {
    await writeFile(join(repo, "new.ts"), "export const b = 2;\n");
    await git("add", "-A");
    const dirty = await dirtyWorktreePaths(repo);
    expect(dirty).toHaveLength(1);
    expect(dirty[0]).toContain("new.ts");
  });

  it("reports a deleted tracked file", async () => {
    await rm(join(repo, "app.ts"));
    const dirty = await dirtyWorktreePaths(repo);
    expect(dirty).toHaveLength(1);
    expect(dirty[0]).toContain("app.ts");
  });
});

// #27. Run against real repos — and specifically against a real LINKED
// worktree, because that is the only shape the inner loop ever sees and it is
// the one where HEAD is per-worktree rather than shared. A fake `git` would
// preserve none of that.
describe("headMismatch (#27)", () => {
  let repo: string;
  let wt: string;

  const git = (...args: string[]) => exec("git", args, { cwd: repo });
  const inWt = (...args: string[]) => exec("git", args, { cwd: wt });

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "sandbar-head-"));
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await writeFile(join(repo, "app.ts"), "export const a = 1;\n");
    await git("add", "-A");
    await git("commit", "-qm", "init");
    await git("branch", "--no-track", "sandbar/issue-1-x", "main");
    wt = join(repo, "wt");
    await git("worktree", "add", "-q", wt, "sandbar/issue-1-x");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("is null in the worktree git worktree add just created", async () => {
    expect(await headMismatch(wt, "sandbar/issue-1-x")).toBeNull();
  });

  it("is null after committing normally on the branch", async () => {
    await writeFile(join(wt, "b.ts"), "export const b = 2;\n");
    await inWt("add", "-A");
    await inWt("commit", "-qm", "work");
    expect(await headMismatch(wt, "sandbar/issue-1-x")).toBeNull();
  });

  // The bug verbatim: commits on a detached HEAD, worktree spotless, branch
  // unmoved. dirtyWorktreePaths — every other check the loop has — sees nothing.
  it("reports a detached HEAD that carries commits over a CLEAN tree", async () => {
    await inWt("checkout", "-q", "--detach");
    await writeFile(join(wt, "b.ts"), "export const b = 2;\n");
    await inWt("add", "-A");
    await inWt("commit", "-qm", "stranded");

    expect(await dirtyWorktreePaths(wt)).toEqual([]);

    const m = await headMismatch(wt, "sandbar/issue-1-x");
    expect(m).not.toBeNull();
    expect(m?.headRef).toBeNull();
    expect(m?.branch).toBe("sandbar/issue-1-x");
    // Distinct shas: the commit exists, the branch does not contain it.
    expect(m?.headSha).not.toBe(m?.branchSha);
    const tip = (await git("rev-parse", "sandbar/issue-1-x")).stdout.trim();
    expect(m?.branchSha).toBe(tip);
  });

  it("reports a scratch branch the agent created for itself", async () => {
    await inWt("checkout", "-q", "-b", "my-work");
    const m = await headMismatch(wt, "sandbar/issue-1-x");
    expect(m?.headRef).toBe("refs/heads/my-work");
  });

  // A sha comparison would call this on-branch. It is one commit away from the
  // bug and the correction is identical, so the symbolic ref is what is asked.
  it("reports a HEAD detached exactly AT the branch tip", async () => {
    await inWt("checkout", "-q", "--detach");
    const m = await headMismatch(wt, "sandbar/issue-1-x");
    expect(m).not.toBeNull();
    expect(m?.headSha).toBe(m?.branchSha);
  });

  it("reports a missing branch ref rather than throwing", async () => {
    // Not reachable through the inner loop (ensureIssueBranch runs first), but
    // the message must degrade to something readable rather than a stack trace.
    await inWt("checkout", "-q", "--detach");
    const m = await headMismatch(wt, "no-such-branch");
    expect(m?.branchSha).toBeNull();
    expect(m?.headSha).not.toBeNull();
  });

  // The distinction the exit-code check exists for: `symbolic-ref -q` exits 1
  // with an EMPTY stderr to say "detached", and 128 with a message to say the
  // repo is broken. Swallowing the second would report a broken repo as a
  // detached HEAD — a different bug with a different fix.
  it("throws rather than reporting a detached HEAD when the path is not a repo", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "sandbar-norepo-"));
    try {
      await expect(headMismatch(notARepo, "sandbar/issue-1-x")).rejects.toThrow();
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});
