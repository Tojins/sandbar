// #34 + #38 — preflight's verdict, and its one destructive step, are about a
// NAMED repo, and since #38 that repo is sandbar's bare cache rather than
// anything a human stands in.
//
// Asserted against two real repos with `process.cwd()` pointed at the WRONG
// one. That arrangement is the whole test: `DEFAULT_CWD()` is `process.cwd()`,
// so on every host that does not set `config.cwd` the two coincide and a test
// that lets them coincide passes just as happily with the threading deleted
// again. Real git, not a fake exec, because the assertions are about refs that
// did or did not move.
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeEnvReader } from "./env.js";
import {
  type DeclaredMount,
  deleteMergedSandbarBranches,
  gatherState,
} from "./preflight.js";
import { type RepoLayout, ensureRepoCache, repoLayout } from "./repo-cache.js";

const exec = promisify(execFile);

const git = (repo: string, ...args: string[]) =>
  exec("git", args, { cwd: repo });

const hasBranch = async (repo: string, branch: string): Promise<boolean> =>
  exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repo,
  }).then(
    () => true,
    () => false,
  );

// A repo on `main` with one commit and a self-remote, so `origin/main` exists
// without a network.
async function seedRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "t@t");
  await git(repo, "config", "user.name", "t");
  await writeFile(join(repo, "a.txt"), "a\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "init");
  await git(repo, "remote", "add", "origin", repo);
  await git(repo, "fetch", "-q", "origin");
  return repo;
}

describe("preflight operates on the named repo, not process.cwd() (#34, #38)", () => {
  let launchedFrom: string;
  let target: string;
  let originalCwd: string;
  let originalPath: string | undefined;
  let shimBin: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    launchedFrom = await seedRepo("sandbar-launch-");
    target = await seedRepo("sandbar-target-");
    process.chdir(launchedFrom);

    // A `gh` that fails instantly, so `gatherState` exercises its real code
    // path (hasGh true, every gh call failing) without a network round-trip.
    // The gh-dependent fields are not what this file asserts; the git-derived
    // ones are, and they must not be hostage to whether the machine running
    // the suite is logged in.
    shimBin = await mkdtemp(join(tmpdir(), "sandbar-shim-"));
    await writeFile(join(shimBin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    originalPath = process.env["PATH"];
    process.env["PATH"] = `${shimBin}:${originalPath ?? ""}`;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    await rm(launchedFrom, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    await rm(shimBin, { recursive: true, force: true });
  });

  // A layout that names `repoDir` directly, so these cases can point preflight
  // at an ordinary repo and read its refs afterwards. The cache-shaped case is
  // the separate describe below, where the point is that the two directories
  // are DIFFERENT rather than that either is bare.
  const layoutAt = (repoDir: string, hostCwd = repoDir): RepoLayout => ({
    ...repoLayout(hostCwd, ".sandbar"),
    repoDir,
  });

  const cfg = (layout: RepoLayout) => ({
    layout,
    repo: { owner: "acme", name: "app" },
    env: makeEnvReader({}),
    sourceBranch: "main",
    pulledImages: [] as readonly string[],
    mountSources: [] as readonly DeclaredMount[],
  });

  // The highest-stakes half, and the one that qualified #32's fix: #32 put this
  // delete under the single-instance lock, and the lock is taken on
  // `config.cwd` — so a delete running in `process.cwd()` was under *a* lock,
  // just not the one covering the repo whose branches it destroyed.
  describe("deleteMergedSandbarBranches", () => {
    beforeEach(async () => {
      for (const repo of [launchedFrom, target]) {
        await git(repo, "branch", "sandbar/issue-1-merged");
      }
    });

    it("deletes the merged branch in the named repo", async () => {
      const deleted = await deleteMergedSandbarBranches(cfg(layoutAt(target)));

      expect(deleted).toEqual(["sandbar/issue-1-merged"]);
      expect(await hasBranch(target, "sandbar/issue-1-merged")).toBe(false);
    });

    it("does not touch the identically-named branch in the launch directory", async () => {
      await deleteMergedSandbarBranches(cfg(layoutAt(target)));

      expect(await hasBranch(launchedFrom, "sandbar/issue-1-merged")).toBe(true);
    });

    // The converse, so the pair cannot both pass by the two repos agreeing.
    // The chdir is the whole point: pointing config at `launchedFrom` while
    // ALSO standing in it is the coinciding arrangement this file exists to
    // avoid, and a test written that way passes with the fix deleted. So stand
    // in `target` and delete in `launchedFrom` — the mirror image of the pair
    // above, wrong in the opposite direction if the cwd is ignored.
    it("deletes in whichever repo it is pointed at", async () => {
      process.chdir(target);

      await deleteMergedSandbarBranches(cfg(layoutAt(launchedFrom)));

      expect(await hasBranch(launchedFrom, "sandbar/issue-1-merged")).toBe(false);
      expect(await hasBranch(target, "sandbar/issue-1-merged")).toBe(true);
    });

    // Behaviour, not a cwd pin — this one passes either way, and is here to
    // stop the cwd threading being "fixed" by deleting the merged-ness check.
    it("leaves an unmerged branch alone", async () => {
      await git(target, "checkout", "-q", "-b", "sandbar/issue-2-unmerged");
      await git(target, "commit", "-q", "--allow-empty", "-m", "work");
      await git(target, "checkout", "-q", "main");

      const deleted = await deleteMergedSandbarBranches(cfg(layoutAt(target)));

      expect(deleted).toEqual(["sandbar/issue-1-merged"]);
      expect(await hasBranch(target, "sandbar/issue-2-unmerged")).toBe(true);
    });

    // #58's second branch shape, and the one thing about a chunk branch that
    // does not wait on the lifecycle #54 still owes it: commits reachable from
    // the source branch have said everything they had to say, whether one issue
    // wrote them or a whole chunk did.
    it("deletes a merged chunk branch too", async () => {
      await git(target, "branch", "sandbar/chunk-5-review-series");

      const deleted = await deleteMergedSandbarBranches(cfg(layoutAt(target)));

      expect([...deleted].sort()).toEqual([
        "sandbar/chunk-5-review-series",
        "sandbar/issue-1-merged",
      ]);
      expect(await hasBranch(target, "sandbar/chunk-5-review-series")).toBe(false);
    });
  });

  // #38 item 3, stated as the thing it protects rather than as a path. `cwd`
  // stopped being a dedicated operating clone and became the human's own
  // checkout, so a `git branch -D` that followed `cwd` would now destroy THEIR
  // branches. The pin is not "the argument says repoDir" — it is that a real
  // preflight against a real cache leaves the operator's refs where they were.
  describe("with a real bare cache, the operator's checkout is never written", () => {
    it("deletes only in the cache, and only sandbar's own refs exist there", async () => {
      // The operator's checkout carries a branch of their own AND an
      // identically-named sandbar branch — the case a prefix-glob delete would
      // reach if it followed `cwd`.
      await git(target, "branch", "my-wip");
      await git(target, "branch", "sandbar/issue-1-merged");

      const layout = repoLayout(target, ".sandbar");
      await ensureRepoCache(layout);

      // The clone imports the operator's branches; the cache clears them, so
      // preflight's `refs/heads/sandbar/issue-*` glob cannot refuse a run over
      // a branch sandbar itself imported from the human's repo.
      const headsInCache = await git(
        layout.repoDir,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/",
      );
      expect(headsInCache.stdout.trim()).toBe("");

      // Now sandbar's own branch, created the way the inner loop creates it.
      await git(
        layout.repoDir,
        "branch",
        "--no-track",
        "sandbar/issue-1-merged",
        "refs/remotes/origin/main",
      );

      const deleted = await deleteMergedSandbarBranches({
        layout,
        sourceBranch: "main",
      });

      expect(deleted).toEqual(["sandbar/issue-1-merged"]);
      expect(await hasBranch(layout.repoDir, "sandbar/issue-1-merged")).toBe(false);
      // The operator's repo is untouched — both their own branch and their
      // same-named one survive.
      expect(await hasBranch(target, "my-wip")).toBe(true);
      expect(await hasBranch(target, "sandbar/issue-1-merged")).toBe(true);
    });
  });

  // The other consequence in #34: a clean launch directory would let preflight
  // pass while the actual target repo carries unmerged issue branches.
  describe("gatherState", () => {
    it("classifies the target's issue branches, not the launch directory's", async () => {
      await git(launchedFrom, "checkout", "-q", "-b", "sandbar/issue-9-launch");
      await git(launchedFrom, "commit", "-q", "--allow-empty", "-m", "work");
      await git(target, "checkout", "-q", "-b", "sandbar/issue-7-target");
      await git(target, "commit", "-q", "--allow-empty", "-m", "work");
      await git(target, "checkout", "-q", "main");

      const state = await gatherState(cfg(layoutAt(target)));

      expect(state.unmergedIssueBranches).toEqual(["sandbar/issue-7-target"]);
    });

    // A chunk branch (#58) is unmerged for exactly as long as the human
    // reviewing it takes, which is the point of the review lane. Classifying it
    // `unmerged` would turn every open review into a hard refusal to start —
    // the loop stopping because it is waiting for the review it was told to
    // wait for. It is not `resumable` either: the number in it is a chunk ROOT,
    // not one issue whose inner loop could pick the branch up.
    it("takes none of the three classifications for a chunk branch", async () => {
      await git(target, "checkout", "-q", "-b", "sandbar/chunk-5-review-series");
      await git(target, "commit", "-q", "--allow-empty", "-m", "work");
      await git(target, "checkout", "-q", "main");

      const state = await gatherState(cfg(layoutAt(target)));

      expect(state.unmergedIssueBranches).toEqual([]);
      expect(state.discardedIssueBranches).toEqual([]);
      expect(state.resumableIssueBranches).toEqual([]);
    });

    // #34 — the tracker is `ghOwner`/`ghRepo` and the push target is the
    // cache's `origin`, and nothing declares the second. Read from the repo
    // preflight was pointed at, through real git, so the assertion covers
    // `git remote get-url` rather than a string this test also wrote.
    it("reads the origin URL of the named repo and parses it", async () => {
      await git(
        target,
        "remote",
        "set-url",
        "origin",
        "https://github.com/acme/app-fork.git",
      );
      await git(
        launchedFrom,
        "remote",
        "set-url",
        "origin",
        "https://github.com/acme/app.git",
      );

      const state = await gatherState(cfg(layoutAt(target)));

      expect(state.originUrl).toBe("https://github.com/acme/app-fork.git");
      expect(state.originRepo).toEqual({ owner: "acme", name: "app-fork" });
      expect(state.originHost).toBe("github.com");
      expect(state.configuredRepo).toEqual({ owner: "acme", name: "app" });
    });

    // A local-path remote is the shape the parser refuses to guess at, and a
    // fixture repo built with a self-remote is exactly that shape — so this is
    // also the default state of every other test in this file.
    it("reports a remote it cannot read as a repo without guessing", async () => {
      const state = await gatherState(cfg(layoutAt(target)));

      expect(state.originUrl).toBe(target);
      expect(state.originRepo).toBeNull();
      expect(state.originHost).toBeNull();
    });

    // The regression the parser rewrite exists for, exercised through real git
    // rather than the parser's own table: an ssh-reached filesystem path is a
    // perfectly ordinary mirror remote, and reading `git/app` out of it made
    // preflight refuse a working configuration for good.
    it("does not invent a repo out of an ssh-reached filesystem path", async () => {
      await git(
        target,
        "remote",
        "set-url",
        "origin",
        "git@gitserver.internal:/srv/git/app.git",
      );

      const state = await gatherState(cfg(layoutAt(target)));

      expect(state.originUrl).toBe("git@gitserver.internal:/srv/git/app.git");
      expect(state.originRepo).toBeNull();
      expect(state.originHost).toBeNull();
    });

    it("reads origin/<sourceBranch> from the named repo", async () => {
      const state = await gatherState(cfg(layoutAt(target)));
      expect(state.hasOriginBranch).toBe(true);

      // A repo with no `origin/main` at all — the invariant must be about the
      // repo it was pointed at, not about the one the process stands in.
      const bare = await mkdtemp(join(tmpdir(), "sandbar-empty-"));
      await git(bare, "init", "-q", "-b", "main");
      const empty = await gatherState(cfg(layoutAt(bare, target)));
      expect(empty.hasOriginBranch).toBe(false);
      await rm(bare, { recursive: true, force: true });
    });

    // #51 — host state, read with a real stat against real paths. The gate
    // stack is the whole of sandbar's consumer-supplied host-path surface, and
    // a source podman cannot resolve fails an `attempt` container at bringup,
    // which #24 D5 reports as a gate red against the branch.
    it("reports a declared mount source that does not exist, and not one that does", async () => {
      const present = join(target, "a.txt");
      const absent = join(target, "run", "podman.sock");

      const state = await gatherState({
        ...cfg(layoutAt(target)),
        mountSources: [
          { container: "gate", hostPath: present },
          { container: "gate", hostPath: absent },
        ],
      });

      expect(state.missingMountSources).toEqual([
        {
          container: "gate",
          hostPath: absent,
          detail: "no such file or directory",
        },
      ]);
    });

    // `stat`, not `lstat`: podman resolves the `-v` source through symlinks, so
    // a link whose target is gone is a bringup failure and has to read as one.
    it("follows a symlink and reports a dangling one as missing", async () => {
      const dangling = join(target, "dangling");
      await symlink(join(target, "nothing-here"), dangling);

      const state = await gatherState({
        ...cfg(layoutAt(target)),
        mountSources: [{ container: "db", hostPath: dangling }],
      });

      expect(state.missingMountSources).toEqual([
        {
          container: "db",
          hostPath: dangling,
          detail: "no such file or directory",
        },
      ]);
    });

    it("reports nothing when the stack declares no absolute sources", async () => {
      const state = await gatherState(cfg(layoutAt(target)));
      expect(state.missingMountSources).toEqual([]);
    });
  });
});
