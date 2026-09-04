import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandbarError } from "./errors.js";
import {
  ChunkBaseMissingError,
  IssueBranchDeletedOnOriginError,
  IssueBranchDivergedError,
  dirtyWorktreePaths,
  ensureIssueBranch,
  headMismatch,
  symbolicHeadRef,
} from "./git-ops.js";

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

  it("reports symbolic HEAD movement even when the tree and issue ref stay unchanged", async () => {
    expect(await symbolicHeadRef(wt)).toBe("refs/heads/sandbar/issue-1-x");
    await inWt("checkout", "-q", "--detach");
    expect(await dirtyWorktreePaths(wt)).toEqual([]);
    expect(await symbolicHeadRef(wt)).toBeNull();
  });

  it("reports an unborn symbolic HEAD after its issue ref is deleted", async () => {
    await inWt("update-ref", "-d", "refs/heads/sandbar/issue-1-x");
    expect(await symbolicHeadRef(wt)).toBe("refs/heads/sandbar/issue-1-x");
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
  // #112's missing-branch arm against the chunk seed: origin's copy of a
  // member's branch is resumed when the chunk tip does not contain it, and a
  // copy the chunk tip already contains (the member landed) is a leftover.
  it("resumes a missing member branch from origin's copy when the chunk tip lacks it", async () => {
    await landRootOnChunkBranch();
    await git(seed, "checkout", "-q", "-b", MEMBER, `origin/${CHUNK.branch}`);
    await git(seed, "commit", "-q", "--allow-empty", "-m", "member work, parked");
    await git(seed, "push", "-q", "origin", MEMBER);
    const parkedTip = (await git(seed, "rev-parse", "HEAD")).stdout.trim();

    const base = await ensureIssueBranch(cache, MEMBER, "main", CHUNK);

    expect(base).toMatchObject({
      ref: `refs/remotes/origin/${CHUNK.branch}`,
      chunkBranch: CHUNK.branch,
      originSync: { kind: "resumed-from-origin", tip: parkedTip },
    });
    expect((await git(cache, "rev-parse", MEMBER)).stdout.trim()).toBe(parkedTip);
  });

  it("seeds a missing member branch fresh when the chunk tip already contains origin's copy", async () => {
    const tip = await landRootOnChunkBranch();
    await git(seed, "push", "-q", "origin", `${tip}:refs/heads/${MEMBER}`);

    const base = await ensureIssueBranch(cache, MEMBER, "main", CHUNK);

    expect(base.originSync).toBeUndefined();
    expect((await git(cache, "rev-parse", MEMBER)).stdout.trim()).toBe(tip);
  });

  it("reports the chunk tip for a branch that already exists", async () => {
    const tip = await landRootOnChunkBranch();
    const first = await ensureIssueBranch(cache, MEMBER, "main", CHUNK);
    await git(cache, "worktree", "add", "-q", join(root, "wt"), MEMBER);
    const wt = join(root, "wt");
    await exec("git", ["config", "user.email", "t@t"], { cwd: wt });
    await exec("git", ["config", "user.name", "t"], { cwd: wt });
    await exec("git", ["commit", "-q", "--allow-empty", "-m", "member work"], { cwd: wt });

    const again = await ensureIssueBranch(cache, MEMBER, "main", CHUNK);

    // Same base; the resume additionally reports what origin's copy said (#112).
    expect(again).toMatchObject(first);
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

// #61 — a failed fetch is not "origin has no such branch". The distinction is
// invisible from inside `ensureIssueBranch` and load-bearing outside it: read
// as "no such branch", a fetch that failed for any other reason falls back to
// `origin/<sourceBranch>` and develops a chained member against a tree missing
// its blockers' work, which is the one outcome #61 exists to prevent. Nothing
// downstream rejects that (unlike the merger's fallback, which a
// non-fast-forward push catches), so it can only be caught here.
//
// Real repos again, and necessarily: the losing fetch, its exit status and the
// state of the ref it failed to write are all git's, and the concurrency case
// below has nothing to assert if the fetches are faked.
describe("ensureIssueBranch — a failed fetch falls back to the cached tip (#61)", () => {
  let root: string;
  let origin: string;
  let seed: string;
  let cache: string;

  const CHUNK = { root: 10, branch: "sandbar/chunk-10-thing" };
  const ON_CHUNK = "chunk-member-1.txt";

  const git = (repo: string, ...args: string[]) => exec("git", args, { cwd: repo });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-gitops-fetchfail-"));
    origin = join(root, "origin.git");
    seed = join(root, "seed");
    cache = join(root, "repo.git");

    await exec("git", ["init", "--bare", "-q", "-b", "main", origin]);
    await exec("git", ["clone", "-q", origin, seed], { cwd: root });
    await git(seed, "config", "user.email", "t@t");
    await git(seed, "config", "user.name", "t");
    await writeFile(join(seed, "main.txt"), "base\n");
    await git(seed, "add", "-A");
    await git(seed, "commit", "-qm", "base");
    await git(seed, "push", "-q", "origin", "main");

    // The chunk's root has landed: a chunk branch on origin, one commit ahead.
    await writeFile(join(seed, ON_CHUNK), "root member work\n");
    await git(seed, "add", "-A");
    await git(seed, "commit", "-qm", "root member");
    await git(seed, "push", "-q", "origin", `HEAD:refs/heads/${CHUNK.branch}`);
    await git(seed, "reset", "-q", "--hard", "origin/main");

    await exec("git", ["clone", "--bare", "-q", origin, cache], { cwd: root });
    await git(cache, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    // Preflight's fetch of the chunk namespace: the cache knows the tip before
    // any of this cycle's seeding runs.
    await git(cache, "fetch", "-q", "origin", "--prune");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Every member of a LAYER is seeded in parallel (run.ts), against the one
  // bare cache, with the same refspec. When the fetch actually moves the ref,
  // git fails all but one of them — "cannot lock ref ...: is at X but expected
  // Y", where X is precisely the value the loser wanted to write. Every member
  // must still come out seeded from the tip; one of them silently getting
  // `origin/main` is the bug, and which one loses the race is not decidable, so
  // the assertion is over all of them.
  it("seeds every member of a layer from the tip when they race on the ref", async () => {
    // Move the branch on origin, so the concurrent fetches below have a ref to
    // WRITE and therefore a lock to contend for. A no-op fetch never races.
    await git(seed, "fetch", "-q", "origin", `${CHUNK.branch}:${CHUNK.branch}`);
    await git(seed, "checkout", "-q", CHUNK.branch);
    await git(seed, "commit", "-q", "--allow-empty", "-m", "another member landed");
    await git(seed, "push", "-q", "origin", CHUNK.branch);
    await git(seed, "checkout", "-q", "main");
    const tip = (await git(origin, "rev-parse", CHUNK.branch)).stdout.trim();

    const members = [11, 12, 13, 14, 15, 16].map((n) => `sandbar/issue-${n}-member`);
    const bases = await Promise.all(
      members.map((branch) => ensureIssueBranch(cache, branch, "main", CHUNK)),
    );

    for (const base of bases) {
      expect(base).toEqual({
        ref: `refs/remotes/origin/${CHUNK.branch}`,
        chunkBranch: CHUNK.branch,
      });
    }
    for (const branch of members) {
      expect((await git(cache, "rev-parse", branch)).stdout.trim()).toBe(tip);
      expect(
        (await git(cache, "ls-tree", "--name-only", branch)).stdout,
      ).toContain(ON_CHUNK);
    }
  });

  // The other reading of a failed fetch: origin is unreachable. The cache still
  // holds what preflight fetched, and a chunk branch only ever moves forward,
  // so that tip is at worst an ancestor of origin's — still under the member's
  // feet, where `origin/main` is not.
  it("seeds from the cached tip when origin is unreachable", async () => {
    await git(cache, "remote", "set-url", "origin", join(root, "no-such-origin.git"));

    const base = await ensureIssueBranch(cache, "sandbar/issue-11-member", "main", CHUNK);

    expect(base).toEqual({
      ref: `refs/remotes/origin/${CHUNK.branch}`,
      chunkBranch: CHUNK.branch,
      // The same unreachable origin could not be asked for its copy of the
      // issue branch either, and the seed says so rather than staying quiet
      // about it (#112).
      originSync: { kind: "origin-unreadable", detail: expect.any(String) },
    });
    expect(
      (await git(cache, "ls-tree", "--name-only", "sandbar/issue-11-member")).stdout,
    ).toContain(ON_CHUNK);
  });

  // And the case the fallback must NOT swallow: no ref to name, which is the
  // chunk's first landing. Preflight prunes this namespace at the top of every
  // run, so a branch that is not on origin is not in the cache either — and the
  // root's seed has to be `origin/main`, where the merge phase creates the
  // branch.
  it("still falls back to the source branch when the cache has no such ref", async () => {
    const other = { root: 20, branch: "sandbar/chunk-20-other" };

    const base = await ensureIssueBranch(cache, "sandbar/issue-20-root", "main", other);

    expect(base).toEqual({ ref: "origin/main", chunkBranch: null });
    expect(
      (await git(cache, "ls-tree", "--name-only", "sandbar/issue-20-root")).stdout,
    ).not.toContain(ON_CHUNK);
  });
});

// #61 — the source-branch fallback belongs to a chunk's ROOT, and this is the
// case that proves it is guarded rather than merely argued for.
//
// The argument said a non-root member can never find its chunk branch missing:
// it plans only once chunk history names its blocker, which can happen only
// after the chunk branch is on origin. What that argument leaves out is that
// `chunk.branch` is DERIVED per cycle from the chunk's current root, and a
// chunk can re-root only when its root's durable member ref is missing or
// repaired away. Ordinary closes do not do that: git-derived members are
// fetched by number without a state filter, so a closed root stays in the graph.
//
// Falling back there is the exact outcome #61 exists to prevent, and it is the
// silent kind: the merge phase CREATES the chunk branch it cannot find, so
// there is no non-fast-forward push to reject it the way the merger's identical
// fallback is rejected.
describe("ensureIssueBranch — a non-root member with no chunk branch refuses (#61)", () => {
  let root: string;
  let origin: string;
  let seed: string;
  let cache: string;

  const git = (repo: string, ...args: string[]) => exec("git", args, { cwd: repo });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-gitops-reroot-"));
    origin = join(root, "origin.git");
    seed = join(root, "seed");
    cache = join(root, "repo.git");

    await exec("git", ["init", "--bare", "-q", "-b", "main", origin]);
    await exec("git", ["clone", "-q", origin, seed], { cwd: root });
    await git(seed, "config", "user.email", "t@t");
    await git(seed, "config", "user.name", "t");
    await writeFile(join(seed, "main.txt"), "base\n");
    await git(seed, "add", "-A");
    await git(seed, "commit", "-qm", "base");
    await git(seed, "push", "-q", "origin", "main");

    // The chunk really did land, under its ORIGINAL root #10.
    await writeFile(join(seed, "chunk.txt"), "members 10 and 11\n");
    await git(seed, "add", "-A");
    await git(seed, "commit", "-qm", "the chunk so far");
    await git(seed, "push", "-q", "origin", "HEAD:refs/heads/sandbar/chunk-10-thing");
    await git(seed, "reset", "-q", "--hard", "origin/main");

    await exec("git", ["clone", "--bare", "-q", origin, cache], { cwd: root });
    await git(cache, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await git(cache, "fetch", "-q", "origin", "--prune");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // #10 was closed by a human, so `deriveChunks` re-rooted the chunk at #11 and
  // the planner handed #12 a target of `sandbar/chunk-11-mid` — a branch that
  // has never existed. Before the guard, #12 was seeded from `origin/main`,
  // missing both #10's and #11's work, and nothing said so.
  const REROOTED = { root: 11, branch: "sandbar/chunk-11-mid" };

  it("throws instead of seeding a chained member from the source branch", async () => {
    const attempt = ensureIssueBranch(cache, "sandbar/issue-12-leaf", "main", REROOTED);

    await expect(attempt).rejects.toBeInstanceOf(ChunkBaseMissingError);
    await expect(attempt).rejects.toThrow(/sandbar\/chunk-11-mid/);
    // Named so an operator can act on it rather than reading it as an infra blip.
    await expect(attempt).rejects.toThrow(/re-rooting/i);
  });

  // And it refuses BEFORE writing anything: a branch created at the wrong base
  // is kept verbatim by the next attempt, so a throw that left one behind would
  // hand the retry the very tree it refused to seed.
  it("creates no branch when it refuses", async () => {
    await expect(
      ensureIssueBranch(cache, "sandbar/issue-12-leaf", "main", REROOTED),
    ).rejects.toBeInstanceOf(ChunkBaseMissingError);

    await expect(
      git(cache, "show-ref", "--verify", "refs/heads/sandbar/issue-12-leaf"),
    ).rejects.toBeTruthy();
  });

  // Not a SandbarError, deliberately: that class means "stop the whole run",
  // and one issue whose premise broke is the inner loop's HARD-ERROR → a
  // per-issue human handoff, with the rest of the cycle unaffected.
  it("is not a SandbarError, so the run does not stop for it", async () => {
    const err = await ensureIssueBranch(
      cache,
      "sandbar/issue-12-leaf",
      "main",
      REROOTED,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SandbarError);
  });

  // The chunk's own root is what the fallback is FOR, and it still gets it —
  // the guard must not turn a first landing into a halt.
  //
  // And this fixture is the LIMIT of the guard, pinned rather than left to the
  // prose: #11 is not a first landing at all, it is the RE-ROOTED root of the
  // chunk #10 already landed on. `chunk.root` says 11 and the branch says 11,
  // so seeding cannot tell it from a new chunk — it takes the source branch and
  // #10's work stays stranded on `sandbar/chunk-10-thing`. Asserted because it
  // is the one case the host-facing docs have to describe as silent
  // (`config.ts`, `defaultLane`); were it ever to become detectable here, this
  // is the test that should fail and send someone to those docs.
  it("gives a re-rooted chunk's new root the source branch, stranding the old work", async () => {
    const base = await ensureIssueBranch(cache, "sandbar/issue-11-mid", "main", REROOTED);

    expect(base).toEqual({ ref: "origin/main", chunkBranch: null });
    // The stranding itself: the landed chunk's file is on the old branch and
    // NOT under the new root's feet.
    expect(
      (await git(cache, "ls-tree", "--name-only", "refs/remotes/origin/sandbar/chunk-10-thing"))
        .stdout,
    ).toContain("chunk.txt");
    expect(
      (await git(cache, "ls-tree", "--name-only", "sandbar/issue-11-mid")).stdout,
    ).not.toContain("chunk.txt");
  });

  // A branch name the parser cannot read is not a root either. It cannot be
  // shown to be one, and the cost of guessing wrong is the silent bug above.
  it("refuses a branch whose number cannot be parsed", async () => {
    await expect(
      ensureIssueBranch(cache, "not-a-sandbar-branch", "main", REROOTED),
    ).rejects.toBeInstanceOf(ChunkBaseMissingError);
  });
});

// #112 — origin's copy of the issue branch. Finalise's parking comment says
// "push a fix on the branch and re-queue"; the cache's copy of that branch is
// therefore stale the moment the human does, and a resume that read only the
// cache built eight commits over the fix and had its push rejected. Real repos
// again, because every claim is git's: what a fast-forward is, what `merge
// --ff-only` does to a worktree's index, that `ls-remote --exit-code` says 2
// for a ref origin does not have and something else for an origin it cannot
// reach.
describe("ensureIssueBranch — origin's copy of the branch (#112)", () => {
  const B = "sandbar/issue-12-thing";
  let root: string;
  let origin: string;
  let work: string;
  let cache: string;

  const git = (repo: string, ...args: string[]) => exec("git", args, { cwd: repo });
  const tip = async (repo: string, ref: string): Promise<string> =>
    (await git(repo, "rev-parse", "--verify", ref)).stdout.trim();
  const hasRef = (repo: string, ref: string): Promise<boolean> =>
    git(repo, "show-ref", "--verify", "--quiet", ref).then(
      () => true,
      () => false,
    );

  // A commit on `B` in the working clone, pushed to origin. Not `--allow-empty`
  // for the worktree case: a tree change is what shows the checkout moved.
  let n = 0;
  const pushOnBranch = async (): Promise<string> => {
    n += 1;
    await git(work, "checkout", "-q", "-B", B);
    await writeFile(join(work, `f${n}.txt`), `${n}\n`);
    await git(work, "add", "-A");
    await git(work, "commit", "-qm", `push ${n}`);
    await git(work, "push", "-q", "origin", B);
    return tip(work, "HEAD");
  };
  // The cache's branch at origin's current copy, the state a park leaves.
  const cacheLevelWithOrigin = async (): Promise<string> => {
    await git(cache, "fetch", "-q", "origin", `+refs/heads/${B}:refs/remotes/origin/${B}`);
    await git(cache, "branch", "--no-track", B, `refs/remotes/origin/${B}`);
    return tip(cache, `refs/heads/${B}`);
  };
  // A commit on the cache's branch that origin never saw — a run that died
  // before its push — made through a worktree, then the worktree removed.
  const commitInCache = async (): Promise<string> => {
    const wt = join(root, "wt-cache");
    await git(cache, "worktree", "add", "-q", wt, B);
    await exec("git", ["config", "user.email", "t@t"], { cwd: wt });
    await exec("git", ["config", "user.name", "t"], { cwd: wt });
    await exec("git", ["commit", "-q", "--allow-empty", "-m", "unpushed"], { cwd: wt });
    await git(cache, "worktree", "remove", "--force", wt);
    return tip(cache, `refs/heads/${B}`);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-112-"));
    origin = join(root, "origin.git");
    work = join(root, "work");
    cache = join(root, "cache.git");
    await mkdir(origin);
    await git(origin, "init", "-q", "--bare", "-b", "main");
    await git(root, "clone", "-q", origin, work);
    await git(work, "config", "user.email", "t@t");
    await git(work, "config", "user.name", "t");
    await writeFile(join(work, "a.txt"), "a\n");
    await git(work, "add", "-A");
    await git(work, "commit", "-qm", "init");
    await git(work, "push", "-q", "-u", "origin", "main");
    await mkdir(cache);
    await git(cache, "init", "-q", "--bare");
    await git(cache, "remote", "add", "origin", origin);
    await git(cache, "fetch", "-q", "origin");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("leaves a branch level with origin alone", async () => {
    await pushOnBranch();
    const before = await cacheLevelWithOrigin();

    const base = await ensureIssueBranch(cache, B, "main");

    expect(base.originSync).toEqual({ kind: "in-sync", tip: before });
    expect(await tip(cache, `refs/heads/${B}`)).toBe(before);
  });

  // The #98 shape: parked at c1, the human pushes c2, re-queues.
  it("fast-forwards a branch origin has moved ahead of", async () => {
    await pushOnBranch();
    const c1 = await cacheLevelWithOrigin();
    const c2 = await pushOnBranch();

    const base = await ensureIssueBranch(cache, B, "main");

    expect(base.originSync).toEqual({ kind: "fast-forwarded", from: c1, to: c2 });
    expect(await tip(cache, `refs/heads/${B}`)).toBe(c2);
    expect(base).toMatchObject({ ref: "origin/main", chunkBranch: null });
  });

  // A stranded worktree still has the branch checked out. Moving the ref under
  // it would leave the worktree's index describing c1 as uncommitted changes
  // against c2; the fast-forward has to go THROUGH the worktree.
  it("fast-forwards through the worktree that holds the branch, leaving it clean", async () => {
    await pushOnBranch();
    await cacheLevelWithOrigin();
    const wt = join(root, "wt");
    await git(cache, "worktree", "add", "-q", wt, B);
    const c2 = await pushOnBranch();

    const base = await ensureIssueBranch(cache, B, "main");

    expect(base.originSync).toMatchObject({ kind: "fast-forwarded", to: c2 });
    expect(await tip(wt, "HEAD")).toBe(c2);
    expect((await git(wt, "status", "--porcelain")).stdout).toBe("");
    expect(await tip(cache, `refs/heads/${B}`)).toBe(c2);
  });

  it("keeps a branch the cache is ahead of — a run that died before its push", async () => {
    const c1 = await pushOnBranch();
    await cacheLevelWithOrigin();
    const c2 = await commitInCache();

    const base = await ensureIssueBranch(cache, B, "main");

    expect(base.originSync).toEqual({ kind: "local-ahead", local: c2, origin: c1 });
    expect(await tip(cache, `refs/heads/${B}`)).toBe(c2);
  });

  it("refuses a diverged branch, naming both tips, and moves nothing", async () => {
    await pushOnBranch();
    await cacheLevelWithOrigin();
    const local = await commitInCache();
    const remote = await pushOnBranch();

    const err = await ensureIssueBranch(cache, B, "main").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(IssueBranchDivergedError);
    const message = (err as Error).message;
    expect(message).toContain(local.slice(0, 7));
    expect(message).toContain(remote.slice(0, 7));
    expect(message).toContain(cache);
    expect(err).not.toBeInstanceOf(SandbarError);
    expect(await tip(cache, `refs/heads/${B}`)).toBe(local);
  });

  it("keeps a branch origin has no copy of and never had", async () => {
    await git(cache, "branch", "--no-track", B, "origin/main");
    const before = await commitInCache();

    const base = await ensureIssueBranch(cache, B, "main");

    expect(base.originSync).toEqual({ kind: "origin-absent" });
    expect(await tip(cache, `refs/heads/${B}`)).toBe(before);
  });

  // The cache follows origin in both directions. A park's push left the
  // remote-tracking ref behind, so origin now saying "no such branch" is the
  // human's deletion — the one way to abandon a parked issue's work — and the
  // cache drops its copy and seeds the issue afresh.
  it("drops the cache's copy of a branch deleted on origin and seeds afresh", async () => {
    await pushOnBranch();
    const c1 = await cacheLevelWithOrigin();
    await git(work, "push", "-q", "origin", "--delete", B);

    const base = await ensureIssueBranch(cache, B, "main");

    expect(base.originSync).toEqual({ kind: "abandoned", tip: c1 });
    expect(await tip(cache, `refs/heads/${B}`)).toBe(await tip(cache, "origin/main"));
    expect(await hasRef(cache, `refs/remotes/origin/${B}`)).toBe(false);
    // Still in the reflog, as the announcement says.
    expect((await git(cache, "cat-file", "-t", c1)).stdout.trim()).toBe("commit");
  });

  it("refuses to drop a branch deleted on origin when the cache holds work past origin's tip", async () => {
    const c1 = await pushOnBranch();
    await cacheLevelWithOrigin();
    const c2 = await commitInCache();
    await git(work, "push", "-q", "origin", "--delete", B);

    const err = await ensureIssueBranch(cache, B, "main").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(IssueBranchDeletedOnOriginError);
    expect((err as Error).message).toContain(`${c1.slice(0, 7)}..${c2.slice(0, 7)}`);
    expect(err).not.toBeInstanceOf(SandbarError);
    expect(await tip(cache, `refs/heads/${B}`)).toBe(c2);
  });

  it("refuses to drop a branch deleted on origin while a worktree has it checked out", async () => {
    await pushOnBranch();
    const c1 = await cacheLevelWithOrigin();
    const wt = join(root, "wt");
    await git(cache, "worktree", "add", "-q", wt, B);
    await git(work, "push", "-q", "origin", "--delete", B);

    const err = await ensureIssueBranch(cache, B, "main").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(IssueBranchDeletedOnOriginError);
    expect((err as Error).message).toContain(wt);
    expect(await tip(cache, `refs/heads/${B}`)).toBe(c1);
  });

  // `git worktree list` keeps listing the branch of a worktree whose directory
  // was deleted by hand, marked `prunable`. There is nothing to fast-forward
  // through there; the ref moves directly.
  it("fast-forwards past a prunable worktree registration", async () => {
    await pushOnBranch();
    await cacheLevelWithOrigin();
    const wt = join(root, "wt");
    await git(cache, "worktree", "add", "-q", wt, B);
    await rm(wt, { recursive: true, force: true });
    const c2 = await pushOnBranch();

    const base = await ensureIssueBranch(cache, B, "main");

    expect(base.originSync).toMatchObject({ kind: "fast-forwarded", to: c2 });
    expect(await tip(cache, `refs/heads/${B}`)).toBe(c2);
  });

  it("continues from the cache's copy when origin cannot be asked, and says so", async () => {
    await pushOnBranch();
    const before = await cacheLevelWithOrigin();
    await git(cache, "remote", "set-url", "origin", join(root, "nowhere.git"));

    const base = await ensureIssueBranch(cache, B, "main");

    expect(base.originSync).toMatchObject({ kind: "origin-unreadable" });
    expect(await tip(cache, `refs/heads/${B}`)).toBe(before);
  });

  // `rm -rf .sandbar` costs agent time, never correctness (#38): a parked
  // branch the cache has lost is on origin, and that is where it resumes from.
  it("cuts a missing branch from origin's copy when origin has one", async () => {
    const c1 = await pushOnBranch();

    const base = await ensureIssueBranch(cache, B, "main");

    expect(base.originSync).toEqual({ kind: "resumed-from-origin", tip: c1 });
    expect(await tip(cache, `refs/heads/${B}`)).toBe(c1);
    expect(base).toMatchObject({ ref: "origin/main", chunkBranch: null });
  });

  // A copy the base already contains is a leftover of work that landed; a
  // re-opened issue starts fresh rather than on a tip behind the source branch.
  it("seeds fresh when origin's copy is already contained in the base", async () => {
    await git(work, "push", "-q", "origin", `main:refs/heads/${B}`);

    const base = await ensureIssueBranch(cache, B, "main");

    expect(base.originSync).toBeUndefined();
    expect(await tip(cache, `refs/heads/${B}`)).toBe(await tip(cache, "origin/main"));
  });

  it("seeds fresh and says so when origin cannot be asked about a missing branch", async () => {
    await git(cache, "remote", "set-url", "origin", join(root, "nowhere.git"));

    const base = await ensureIssueBranch(cache, B, "main");

    expect(base.originSync).toMatchObject({ kind: "origin-unreadable" });
    expect(await tip(cache, `refs/heads/${B}`)).toBe(await tip(cache, "origin/main"));
  });
});
