import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dirtyWorktreePaths, ensureIssueBranch, headMismatch } from "./git-ops.js";

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

  // Regression: the first cut used `git symbolic-ref -q HEAD` and read "exit 1
  // with empty stderr" as "detached". `-q` suppresses only git's OWN message —
  // GIT_TRACE writes to the same stream, so a detached HEAD then exits 1 with
  // ~80 bytes of trace, the discrimination fails, headMismatch throws, and
  // runImplementer's caller turns it into an infra HARD-ERROR: two pointless
  // fresh-sandbox retries, then a terminal that deletes the branch and posts no
  // comment. An env var in the operator's shell was enough to re-hide exactly
  // the failure this module exists to expose.
  it("still reports a detached HEAD when git's stderr is noisy (GIT_TRACE)", async () => {
    await inWt("checkout", "-q", "--detach");
    const prev = process.env["GIT_TRACE"];
    process.env["GIT_TRACE"] = "1";
    try {
      const m = await headMismatch(wt, "sandbar/issue-1-x");
      expect(m).not.toBeNull();
      expect(m?.headRef).toBeNull();
    } finally {
      if (prev === undefined) delete process.env["GIT_TRACE"];
      else process.env["GIT_TRACE"] = prev;
    }
  });

  // A broken repo is a different bug with a different fix, so it must not
  // degrade into "detached HEAD". GIT_CEILING_DIRECTORIES keeps the test
  // hermetic: without it, a TMPDIR that happens to sit inside a git repo would
  // have git resolve the PARENT repo and return a mismatch instead of throwing.
  it("throws rather than reporting a detached HEAD when the path is not a repo", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "sandbar-norepo-"));
    const prev = process.env["GIT_CEILING_DIRECTORIES"];
    process.env["GIT_CEILING_DIRECTORIES"] = notARepo;
    try {
      await expect(headMismatch(notARepo, "sandbar/issue-1-x")).rejects.toThrow();
    } finally {
      if (prev === undefined) delete process.env["GIT_CEILING_DIRECTORIES"];
      else process.env["GIT_CEILING_DIRECTORIES"] = prev;
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});

// #34 — the branch has to be created in the repo the RUN is about.
//
// Every other function in git-ops takes a worktree path, so this was the one
// that ran wherever the host process was launched. It is asserted against two
// real repos with the process cwd pointed at the WRONG one, because that is the
// only arrangement in which the bug is visible at all: with `config.cwd`
// defaulting to `process.cwd()` the two coincide, and a test that lets them
// coincide passes just as happily with the `cwd` option deleted again.
describe("ensureIssueBranch — operates on repoDir, not process.cwd() (#34)", () => {
  let launchedFrom: string;
  let target: string;
  let originalCwd: string;

  const seed = async (repo: string) => {
    const git = (...args: string[]) => exec("git", args, { cwd: repo });
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await writeFile(join(repo, "a.txt"), "a\n");
    await git("add", "-A");
    await git("commit", "-qm", "init");
    // ensureIssueBranch seeds from origin/<sourceBranch>, so the ref has to
    // exist. A self-remote is enough and needs no network.
    await git("remote", "add", "origin", repo);
    await git("fetch", "-q", "origin");
  };

  beforeEach(async () => {
    originalCwd = process.cwd();
    launchedFrom = await mkdtemp(join(tmpdir(), "sandbar-launch-"));
    target = await mkdtemp(join(tmpdir(), "sandbar-target-"));
    await seed(launchedFrom);
    await seed(target);
    process.chdir(launchedFrom);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(launchedFrom, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });

  const hasBranch = async (repo: string, branch: string): Promise<boolean> =>
    exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repo,
    }).then(
      () => true,
      () => false,
    );

  it("creates the branch in repoDir and leaves the launch directory alone", async () => {
    await ensureIssueBranch(target, "sandbar/issue-1-thing", "main");

    expect(await hasBranch(target, "sandbar/issue-1-thing")).toBe(true);
    expect(await hasBranch(launchedFrom, "sandbar/issue-1-thing")).toBe(false);
  });

  // The "already exists" short-circuit has to ask the same repo the create
  // would write to. Asking the launch directory instead is the silent half of
  // the bug: a branch present there suppresses a create the target still needs.
  it("does not treat a same-named branch in the launch directory as existing", async () => {
    await exec("git", ["branch", "sandbar/issue-2-thing"], { cwd: launchedFrom });

    await ensureIssueBranch(target, "sandbar/issue-2-thing", "main");

    expect(await hasBranch(target, "sandbar/issue-2-thing")).toBe(true);
  });

  // Resumed runs depend on this: an existing branch keeps its commits.
  it("leaves an existing branch in repoDir untouched", async () => {
    await exec("git", ["branch", "sandbar/issue-3-thing"], { cwd: target });
    await exec("git", ["commit", "-q", "--allow-empty", "-m", "more"], {
      cwd: target,
    });
    const { stdout: before } = await exec(
      "git",
      ["rev-parse", "sandbar/issue-3-thing"],
      { cwd: target },
    );

    await ensureIssueBranch(target, "sandbar/issue-3-thing", "main");

    const { stdout: after } = await exec(
      "git",
      ["rev-parse", "sandbar/issue-3-thing"],
      { cwd: target },
    );
    expect(after.trim()).toBe(before.trim());
  });
});

// #61 — the second seed. A chunk member chained behind a landed one has to be
// cut from the chunk branch's TIP, because that is the only place its
// blocker's commits exist; cut from `origin/<sourceBranch>` it would be
// developed against a tree missing the very work it declares itself blocked by.
//
// Asserted against real repos rather than a scripted git, because every claim
// here is git's: that the explicit refspec writes a remote-tracking ref in a
// BARE cache at all (a plain `git fetch origin <branch>` writes only
// FETCH_HEAD there), that a branch created at that ref really contains the
// chunk's commits, and that a chunk branch origin does not have makes the
// fetch FAIL rather than quietly succeed. A fake would preserve none of them.
describe("ensureIssueBranch — the chunk tip is the other seed (#61)", () => {
  let root: string;
  let origin: string;
  let seed: string;
  let cache: string;

  const CHUNK = { root: 10, branch: "sandbar/chunk-10-thing" };
  const MEMBER = "sandbar/issue-11-member";
  // Distinct content per commit, so "seeded from the right ref" cannot pass on
  // the branch merely existing.
  const ON_MAIN = "main.txt";
  const ON_CHUNK = "chunk-member-1.txt";

  const git = (repo: string, ...args: string[]) => exec("git", args, { cwd: repo });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-gitops-chunk-"));
    origin = join(root, "origin.git");
    seed = join(root, "seed");
    cache = join(root, "repo.git");

    await exec("git", ["init", "--bare", "-q", "-b", "main", origin]);
    await exec("git", ["clone", "-q", origin, seed], { cwd: root });
    await git(seed, "config", "user.email", "t@t");
    await git(seed, "config", "user.name", "t");
    await writeFile(join(seed, ON_MAIN), "base\n");
    await git(seed, "add", "-A");
    await git(seed, "commit", "-qm", "base");
    await git(seed, "push", "-q", "origin", "main");

    // The bare object cache, configured exactly as repo-cache.ts leaves it.
    await exec("git", ["clone", "--bare", "-q", origin, cache], { cwd: root });
    await git(cache, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await git(cache, "fetch", "-q", "origin", "--prune");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // What the merge phase leaves behind after the chunk's root lands: a chunk
  // branch on ORIGIN, one commit ahead of main, and not in the cache yet.
  const landRootOnChunkBranch = async (): Promise<string> => {
    await writeFile(join(seed, ON_CHUNK), "root member work\n");
    await git(seed, "add", "-A");
    await git(seed, "commit", "-qm", "root member");
    await git(seed, "push", "-q", "origin", `HEAD:refs/heads/${CHUNK.branch}`);
    await git(seed, "reset", "-q", "--hard", "origin/main");
    return (await git(origin, "rev-parse", CHUNK.branch)).stdout.trim();
  };

  const filesOn = async (branch: string): Promise<string[]> =>
    (await git(cache, "ls-tree", "--name-only", branch)).stdout.trim().split("\n");

  it("seeds a chained member from the chunk tip and says so", async () => {
    const tip = await landRootOnChunkBranch();

    const base = await ensureIssueBranch(cache, MEMBER, "main", CHUNK);

    expect(base).toEqual({
      ref: `refs/remotes/origin/${CHUNK.branch}`,
      chunkBranch: CHUNK.branch,
    });
    const created = (await git(cache, "rev-parse", MEMBER)).stdout.trim();
    expect(created).toBe(tip);
    // The point of all of it: the blocker's file is under the member's feet.
    expect(await filesOn(MEMBER)).toContain(ON_CHUNK);
  });

  // The refspec, not the fetch. `git fetch origin <branch>` in a bare repo
  // writes FETCH_HEAD and nothing else, so the `git branch` below would then
  // fail on an unresolvable base — a failure the caller would see as a
  // HARD-ERROR rather than as the wrong tree, but a failure all the same.
  it("leaves the remote-tracking ref in the cache, not just FETCH_HEAD", async () => {
    const tip = await landRootOnChunkBranch();

    const base = await ensureIssueBranch(cache, MEMBER, "main", CHUNK);

    expect((await git(cache, "rev-parse", "--verify", base.ref)).stdout.trim()).toBe(tip);
  });

  // The root's case. Origin has no chunk branch yet — the merge phase creates
  // it, at `origin/<sourceBranch>` — so the two agree by construction.
  it("falls back to the source branch when origin has no chunk branch yet", async () => {
    const base = await ensureIssueBranch(cache, "sandbar/issue-10-root", "main", CHUNK);

    expect(base).toEqual({ ref: "origin/main", chunkBranch: null });
    expect(await filesOn("sandbar/issue-10-root")).toEqual([ON_MAIN]);
  });

  it("seeds from the source branch when the issue has no chunk at all", async () => {
    const base = await ensureIssueBranch(cache, "sandbar/issue-9-auto", "main", null);

    expect(base).toEqual({ ref: "origin/main", chunkBranch: null });
  });

  // The base is computed BEFORE the exists check, so a resumed run gets the
  // same anchor a fresh one would. Without that, attempt 2 of a chained member
  // would be handed `origin/main` and shown its ancestors' whole chunk as "the
  // work done so far" — #61's failure mode, reached by the back door.
  it("reports the chunk tip for a branch that already exists", async () => {
    const tip = await landRootOnChunkBranch();
    const first = await ensureIssueBranch(cache, MEMBER, "main", CHUNK);
    await git(cache, "worktree", "add", "-q", join(root, "wt"), MEMBER);
    const wt = join(root, "wt");
    await exec("git", ["config", "user.email", "t@t"], { cwd: wt });
    await exec("git", ["config", "user.name", "t"], { cwd: wt });
    await exec("git", ["commit", "-q", "--allow-empty", "-m", "member work"], { cwd: wt });

    const again = await ensureIssueBranch(cache, MEMBER, "main", CHUNK);

    expect(again).toEqual(first);
    // And the accumulated commit is still there — the resume did not re-seed.
    expect((await git(cache, "rev-parse", `${MEMBER}~1`)).stdout.trim()).toBe(tip);
  });

  // The chunk branch moved on origin between the two attempts, which is what a
  // sibling landing in the meantime looks like. An existing branch keeps its
  // own commits, but the ref reported must be the tip as origin has it NOW —
  // that is the tree the merge phase will land this member onto.
  it("re-fetches the tip rather than trusting the cache's copy", async () => {
    await landRootOnChunkBranch();
    await ensureIssueBranch(cache, MEMBER, "main", CHUNK);
    await git(seed, "fetch", "-q", "origin", `${CHUNK.branch}:${CHUNK.branch}`);
    await git(seed, "checkout", "-q", CHUNK.branch);
    await git(seed, "commit", "-q", "--allow-empty", "-m", "sibling landed");
    await git(seed, "push", "-q", "origin", CHUNK.branch);
    const moved = (await git(origin, "rev-parse", CHUNK.branch)).stdout.trim();

    const base = await ensureIssueBranch(cache, MEMBER, "main", CHUNK);

    expect((await git(cache, "rev-parse", base.ref)).stdout.trim()).toBe(moved);
  });
});
