// #38 — the bare cache and the source worktree, against real git.
//
// Everything asserted here is a property GIT defines, not one sandbar can fake:
// what `clone --bare` copies and what it leaves out, whether an unborn HEAD
// still supports `worktree add`, whether a configured refspec turns a fetch
// into remote-tracking refs. The module header makes all four claims, and each
// is load-bearing — a cache with no `refs/remotes/origin/*` silently breaks
// every issue branch's seed, and one that keeps the operator's `refs/heads/*`
// silently turns their branch into a preflight refusal.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { SandbarError } from "./errors.js";
import {
  ensureRepoCache,
  ensureSourceWorktree,
  repoLayout,
  worktreePathFor,
} from "./repo-cache.js";

const exec = promisify(execFile);
const git = (repo: string, ...args: string[]) =>
  exec("git", args, { cwd: repo, env: { ...process.env, LC_ALL: "C" } });

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

// origin.git  <- the "remote"
// checkout    <- the operator's repo, cloned from it
async function setup(): Promise<{ origin: string; checkout: string }> {
  const root = await mkdtemp(join(tmpdir(), "sandbar-cache-"));
  dirs.push(root);
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  await exec("git", ["init", "--bare", "-q", "-b", "main", origin]);
  await exec("git", ["clone", "-q", origin, checkout], { cwd: root });
  await git(checkout, "config", "user.email", "t@t");
  await git(checkout, "config", "user.name", "t");
  await writeFile(join(checkout, "a.txt"), "base\n");
  await writeFile(join(checkout, ".gitignore"), "build/\n");
  await git(checkout, "add", "-A");
  await git(checkout, "commit", "-qm", "base");
  await git(checkout, "push", "-q", "origin", "main");
  return { origin, checkout };
}

const refs = async (repo: string, glob: string): Promise<string[]> =>
  (await git(repo, "for-each-ref", "--format=%(refname)", glob)).stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

describe("repoLayout / worktreePathFor (pure)", () => {
  it("hangs everything off <cwd>/<workDir>", () => {
    const l = repoLayout("/repo", ".sandbar");
    expect(l.stateDir).toBe("/repo/.sandbar");
    expect(l.repoDir).toBe("/repo/.sandbar/repo.git");
    expect(l.worktreesDir).toBe("/repo/.sandbar/worktrees");
    expect(l.sourceWorktree).toBe("/repo/.sandbar/worktrees/source");
    expect(l.logsDir).toBe("/repo/.sandbar/logs");
  });

  // The whole reason `worktreePathFor` stopped taking the repo directory. Given
  // the repo it would compose `<…>/repo.git/.sandbar/worktrees/<b>` — inside
  // the bare cache, where `rm -rf .sandbar/repo.git` would take the worktrees
  // with it and a `git clean` of the cache would be a different operation than
  // anyone intended.
  it("puts worktrees beside the cache, never inside it", () => {
    const l = repoLayout("/repo", ".sandbar");
    const wt = worktreePathFor(l.worktreesDir, "sandbar/issue-9-x");
    expect(wt).toBe("/repo/.sandbar/worktrees/sandbar-issue-9-x");
    expect(wt.startsWith(l.repoDir)).toBe(false);
  });
});

describe("ensureRepoCache (real git)", () => {
  it("clones bare, retargets origin at the REMOTE, and populates remote-tracking refs", async () => {
    const { origin, checkout } = await setup();
    const layout = repoLayout(checkout, ".sandbar");

    await ensureRepoCache(layout);

    expect((await git(layout.repoDir, "rev-parse", "--is-bare-repository")).stdout.trim()).toBe(
      "true",
    );
    // NOT the checkout it was cloned from: the clone is a local shortcut for
    // the objects, the remote is where branches are pushed and merges land.
    expect((await git(layout.repoDir, "remote", "get-url", "origin")).stdout.trim()).toBe(
      origin,
    );
    // `clone --bare` sets NO fetch refspec, and `--mirror` sets one that maps
    // onto refs/heads/*. Neither produces this, and everything downstream —
    // issue-branch seeding, the merger worktree, branchIsContainedInOrigin —
    // reads it.
    expect(
      (await git(layout.repoDir, "config", "remote.origin.fetch")).stdout.trim(),
    ).toBe("+refs/heads/*:refs/remotes/origin/*");
    expect(await refs(layout.repoDir, "refs/remotes/")).toEqual([
      "refs/remotes/origin/main",
    ]);
  });

  it("drops the operator's local branches instead of importing them", async () => {
    const { checkout } = await setup();
    await git(checkout, "branch", "my-wip");
    // The case that matters: an issue branch the operator happens to have
    // checked out for review would otherwise be imported and then refuse the
    // next run as an "unmerged sandbar/issue-*" branch.
    await git(checkout, "branch", "sandbar/issue-77-review");
    const layout = repoLayout(checkout, ".sandbar");

    await ensureRepoCache(layout);

    expect(await refs(layout.repoDir, "refs/heads/")).toEqual([]);
    // And the operator still has them.
    expect(await refs(checkout, "refs/heads/")).toContain("refs/heads/my-wip");
  });

  // The module header rests on this: with every head deleted the cache's HEAD
  // is unborn, and sandbar never adds a worktree without naming its commit-ish.
  it("supports worktree add despite an unborn HEAD", async () => {
    const { checkout } = await setup();
    const layout = repoLayout(checkout, ".sandbar");
    await ensureRepoCache(layout);

    const detached = join(layout.worktreesDir, "detached");
    await git(layout.repoDir, "worktree", "add", "--detach", detached, "origin/main");
    expect(existsSync(join(detached, "a.txt"))).toBe(true);

    await git(
      layout.repoDir,
      "branch",
      "--no-track",
      "sandbar/issue-1-x",
      "origin/main",
    );
    const branched = worktreePathFor(layout.worktreesDir, "sandbar/issue-1-x");
    await git(layout.repoDir, "worktree", "add", branched, "sandbar/issue-1-x");
    expect((await git(branched, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim()).toBe(
      "sandbar/issue-1-x",
    );
  });

  it("is idempotent, and re-syncs the remote when the operator retargets theirs", async () => {
    const { origin, checkout } = await setup();
    const layout = repoLayout(checkout, ".sandbar");
    await ensureRepoCache(layout);

    // A marker only the first clone could have left. If the second call
    // re-cloned, it would be gone — and with it any issue branch in flight.
    await git(layout.repoDir, "branch", "--no-track", "sandbar/issue-5-live", "origin/main");

    const moved = `${origin}-moved`;
    await exec("cp", ["-r", origin, moved]);
    await git(checkout, "remote", "set-url", "origin", moved);

    await ensureRepoCache(layout);

    expect(await refs(layout.repoDir, "refs/heads/")).toEqual([
      "refs/heads/sandbar/issue-5-live",
    ]);
    expect((await git(layout.repoDir, "remote", "get-url", "origin")).stdout.trim()).toBe(
      moved,
    );
  });

  // A relative filesystem remote is relative to the CHECKOUT, not to
  // `<stateDir>/repo.git`. Copied verbatim it would name a directory that does
  // not exist, and the operator would be sent to debug a remote that works
  // perfectly well from where they stand.
  it("resolves a relative filesystem remote against the checkout", async () => {
    const { origin, checkout } = await setup();
    await git(checkout, "remote", "set-url", "origin", "../origin.git");
    const layout = repoLayout(checkout, ".sandbar");

    await ensureRepoCache(layout);

    expect((await git(layout.repoDir, "remote", "get-url", "origin")).stdout.trim()).toBe(
      origin,
    );
    expect(await refs(layout.repoDir, "refs/remotes/")).toEqual([
      "refs/remotes/origin/main",
    ]);
  });

  it("refuses loudly when cwd is not a repo, or has no origin", async () => {
    const plain = await mkdtemp(join(tmpdir(), "sandbar-plain-"));
    dirs.push(plain);
    await expect(
      ensureRepoCache(repoLayout(plain, ".sandbar")),
    ).rejects.toBeInstanceOf(SandbarError);

    await git(plain, "init", "-q", "-b", "main");
    await expect(
      ensureRepoCache(repoLayout(plain, ".sandbar")),
    ).rejects.toThrow(/no `origin` remote/);
  });
});

describe("ensureSourceWorktree (real git)", () => {
  it("locks source so cache-wide prune cannot unregister a missing directory", async () => {
    const { checkout } = await setup();
    const layout = repoLayout(checkout, ".sandbar");
    await ensureRepoCache(layout);
    await ensureSourceWorktree(layout, "main");

    const sourceEntry = (listing: string): string | undefined =>
      listing
        .split("\n\n")
        .find((entry) => entry.startsWith(`worktree ${layout.sourceWorktree}\n`));
    const before = sourceEntry(
      (await git(layout.repoDir, "worktree", "list", "--porcelain")).stdout,
    );
    expect(before).toBeDefined();
    expect(before).toMatch(/(?:^|\n)locked(?:\n|$)/);

    await rm(layout.sourceWorktree, { recursive: true, force: true });
    await git(layout.repoDir, "worktree", "prune");

    const after = sourceEntry(
      (await git(layout.repoDir, "worktree", "list", "--porcelain")).stdout,
    );
    expect(after).toBeDefined();
    expect(after).toMatch(/(?:^|\n)locked(?:\n|$)/);

    const recreated = await ensureSourceWorktree(layout, "main");
    expect(recreated).toBe(layout.sourceWorktree);
    expect((await git(recreated, "rev-parse", "HEAD")).stdout.trim()).toBe(
      (await git(layout.repoDir, "rev-parse", "origin/main")).stdout.trim(),
    );
    const replacement = sourceEntry(
      (await git(layout.repoDir, "worktree", "list", "--porcelain")).stdout,
    );
    expect(replacement).toMatch(/(?:^|\n)locked(?:\n|$)/);
  });

  it("checks out origin/<sourceBranch>, detached", async () => {
    const { checkout } = await setup();
    const layout = repoLayout(checkout, ".sandbar");
    await ensureRepoCache(layout);

    const path = await ensureSourceWorktree(layout, "main");

    expect(path).toBe(layout.sourceWorktree);
    expect((await git(path, "rev-parse", "HEAD")).stdout.trim()).toBe(
      (await git(layout.repoDir, "rev-parse", "origin/main")).stdout.trim(),
    );
    await expect(git(path, "symbolic-ref", "--quiet", "HEAD")).rejects.toBeTruthy();
  });

  // The build context is a claim about a COMMIT. A second run must not build
  // from last run's tree, and `-x` is deliberate: an ignored file left in the
  // directory would still be tarred into the context and make the fingerprint
  // recorded on the image a lie.
  it("resets to the current origin tip and clears even ignored leftovers", async () => {
    const { checkout } = await setup();
    const layout = repoLayout(checkout, ".sandbar");
    await ensureRepoCache(layout);
    const path = await ensureSourceWorktree(layout, "main");

    await writeFile(join(path, "a.txt"), "tampered\n");
    await writeFile(join(path, "untracked.txt"), "junk\n");
    await exec("mkdir", ["-p", join(path, "build")]);
    await writeFile(join(path, "build", "ignored.txt"), "junk\n");

    // origin moves under it.
    await writeFile(join(checkout, "b.txt"), "second\n");
    await git(checkout, "add", "-A");
    await git(checkout, "commit", "-qm", "second");
    await git(checkout, "push", "-q", "origin", "main");
    await git(layout.repoDir, "fetch", "-q", "origin", "main");

    const again = await ensureSourceWorktree(layout, "main");

    expect(again).toBe(path);
    expect((await readFile(join(path, "a.txt"), "utf8")).trim()).toBe("base");
    expect(existsSync(join(path, "b.txt"))).toBe(true);
    expect(existsSync(join(path, "untracked.txt"))).toBe(false);
    expect(existsSync(join(path, "build"))).toBe(false);
    expect((await git(path, "status", "--porcelain")).stdout.trim()).toBe("");
  });

  // A killed run can leave the directory without the registration (or the
  // registration without the directory). Self-healing matters because the whole
  // premise of the state dir is that `rm -rf` costs nothing but time.
  it("recovers from a leftover directory with no worktree registration", async () => {
    const { checkout } = await setup();
    const layout = repoLayout(checkout, ".sandbar");
    await ensureRepoCache(layout);
    await ensureSourceWorktree(layout, "main");

    await rm(layout.sourceWorktree, { recursive: true, force: true });

    const path = await ensureSourceWorktree(layout, "main");
    expect(existsSync(join(path, "a.txt"))).toBe(true);
  });
});

// The state `rm -rf .sandbar` leaves when it is interrupted, and the one this
// whole design has to survive: a directory that exists inside the operator's
// checkout and is not a repository. `git rev-parse --git-dir` answers 0 there
// — with the operator's own `.git` — so a probe that lets git DISCOVER the
// repo reports the cache as present and points every later call, `branch -D`
// and `reset --hard` included, at the human's repository.
//
// These cases build the degenerate states directly. A fixture that builds a
// valid cache cannot see the bug: every assertion above passes with the
// discovering probe restored.
describe("a directory is not a repository just because git finds one above it", () => {
  it("pins Git's missing-config and explicit non-repository exit codes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbar-git-exits-"));
    dirs.push(root);
    const bare = join(root, "bare.git");
    const plain = join(root, "plain");
    await exec("git", ["init", "--bare", "-q", bare]);
    await mkdir(plain);

    await expect(
      exec("git", ["--git-dir", bare, "config", "--get", "sandbar.cache"]),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      exec("git", ["--git-dir", plain, "rev-parse", "--is-bare-repository"]),
    ).rejects.toMatchObject({ code: 128 });
  });

  it("does not mistake a non-repo `repo.git` inside the checkout for the cache", async () => {
    const { checkout } = await setup();
    await git(checkout, "branch", "my-wip");
    await git(checkout, "branch", "sandbar/issue-1-x");
    const layout = repoLayout(checkout, ".sandbar");
    // What an interrupted `rm -rf` leaves: the directory shell, no repository.
    await mkdir(layout.repoDir, { recursive: true });

    await ensureRepoCache(layout);

    // A real cache was built, rather than the operator's repo being adopted
    // as one. Both halves matter: bare, and holding none of their branches.
    expect(
      (await git(layout.repoDir, "rev-parse", "--is-bare-repository")).stdout.trim(),
    ).toBe("true");
    expect(await refs(layout.repoDir, "refs/heads/")).toEqual([]);
    expect(await refs(layout.repoDir, "refs/remotes/origin/")).toContain(
      "refs/remotes/origin/main",
    );
    // And the operator still has everything they had.
    expect(await refs(checkout, "refs/heads/")).toEqual([
      "refs/heads/main",
      "refs/heads/my-wip",
      "refs/heads/sandbar/issue-1-x",
    ]);
  });

  // The same trap on the other probe, where the recovery path is `reset --hard`
  // — so a mis-answer does not merely adopt the operator's repo, it moves their
  // branch and orphans unpushed commits.
  it("does not mistake a plain directory inside the checkout for the source worktree", async () => {
    const { checkout } = await setup();
    const layout = repoLayout(checkout, ".sandbar");
    await ensureRepoCache(layout);
    await ensureSourceWorktree(layout, "main");

    // A partially-removed state directory: the path is there, the worktree is
    // not. (`rm` empties depth-first, so a directory shell is what an
    // interrupted `rm -rf .sandbar` leaves behind.)
    await rm(layout.sourceWorktree, { recursive: true, force: true });
    await rm(join(layout.repoDir, "worktrees"), { recursive: true, force: true });
    await mkdir(layout.sourceWorktree, { recursive: true });
    // The operator has work that only exists locally.
    await writeFile(join(checkout, "b.txt"), "unpushed\n");
    await git(checkout, "add", "-A");
    await git(checkout, "commit", "-qm", "unpushed work");
    const before = (await git(checkout, "rev-parse", "HEAD")).stdout.trim();

    await ensureSourceWorktree(layout, "main");

    // Their commit is still their branch's tip...
    expect((await git(checkout, "rev-parse", "HEAD")).stdout.trim()).toBe(before);
    // Tracked paths only: the state directory itself is legitimately untracked
    // here (this fixture has no gitignore for it).
    expect(
      (await git(checkout, "status", "--porcelain", "-uno")).stdout.trim(),
    ).toBe("");
    // ...and the source worktree is a real worktree of the cache again.
    expect(
      (await git(layout.sourceWorktree, "rev-parse", "--git-common-dir")).stdout.trim(),
    ).toBe(layout.repoDir);
  });
});

// #38's head-deletion and initial fetch used to run only on the creation path,
// so a run killed between the clone and the deletion left a structurally valid
// bare repo carrying the operator's branches — and no later run ever looked
// again. Creation is atomic now: `repo.git` exists only once it is finished.
describe("cache creation is all-or-nothing", () => {
  it("leaves no half-prepared cache to be adopted after an interrupted create", async () => {
    const { checkout } = await setup();
    await git(checkout, "branch", "sandbar/issue-42-stale");
    const layout = repoLayout(checkout, ".sandbar");

    // Exactly what dying between the clone and the preparation produces.
    await mkdir(layout.stateDir, { recursive: true });
    await exec("git", ["clone", "--bare", "--quiet", checkout, layout.repoDir]);
    expect(await refs(layout.repoDir, "refs/heads/")).toContain(
      "refs/heads/sandbar/issue-42-stale",
    );

    await ensureRepoCache(layout);

    // Not adopted: the imported branches are gone and the remote refs exist,
    // which together mean every skipped step ran.
    expect(await refs(layout.repoDir, "refs/heads/")).toEqual([]);
    expect(await refs(layout.repoDir, "refs/remotes/origin/")).toContain(
      "refs/remotes/origin/main",
    );
  });

  it("does not publish the cache before it is prepared", async () => {
    const { checkout } = await setup();
    await git(checkout, "branch", "sandbar/issue-7-x");
    const layout = repoLayout(checkout, ".sandbar");
    await ensureRepoCache(layout);

    // The scratch name is not left behind on the happy path.
    expect(existsSync(`${layout.repoDir}.incoming`)).toBe(false);
    expect(await refs(layout.repoDir, "refs/heads/")).toEqual([]);
  });
});
