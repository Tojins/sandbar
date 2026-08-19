// #34 — preflight's verdict, and its one destructive step, are about the repo
// the RUN is configured against, not about wherever the host process happened
// to be launched.
//
// Asserted against two real repos with `process.cwd()` pointed at the WRONG
// one. That arrangement is the whole test: `DEFAULT_CWD()` is `process.cwd()`,
// so on every host that does not set `config.cwd` the two coincide and a test
// that lets them coincide passes just as happily with the `cwd` option deleted
// again. Real git, not a fake exec, because the assertions are about refs that
// did or did not move.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deleteMergedIssueBranches, gatherState } from "./preflight.js";

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

describe("preflight operates on config.cwd, not process.cwd() (#34)", () => {
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

  const cfg = (cwd: string) => ({
    cwd,
    workDir: ".sandbar",
    envFilePath: join(cwd, "does-not-exist.env"),
    sourceBranch: "main",
    pulledImages: [] as readonly string[],
  });

  // The highest-stakes half, and the one that qualified #32's fix: #32 put this
  // delete under the single-instance lock, and the lock is taken on
  // `config.cwd` — so a delete running in `process.cwd()` was under *a* lock,
  // just not the one covering the repo whose branches it destroyed.
  describe("deleteMergedIssueBranches", () => {
    beforeEach(async () => {
      for (const repo of [launchedFrom, target]) {
        await git(repo, "branch", "sandbar/issue-1-merged");
      }
    });

    it("deletes the merged branch in config.cwd", async () => {
      const deleted = await deleteMergedIssueBranches(cfg(target));

      expect(deleted).toEqual(["sandbar/issue-1-merged"]);
      expect(await hasBranch(target, "sandbar/issue-1-merged")).toBe(false);
    });

    it("does not touch the identically-named branch in the launch directory", async () => {
      await deleteMergedIssueBranches(cfg(target));

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

      await deleteMergedIssueBranches(cfg(launchedFrom));

      expect(await hasBranch(launchedFrom, "sandbar/issue-1-merged")).toBe(false);
      expect(await hasBranch(target, "sandbar/issue-1-merged")).toBe(true);
    });

    // Behaviour, not a cwd pin — this one passes either way, and is here to
    // stop the cwd threading being "fixed" by deleting the merged-ness check.
    it("leaves an unmerged branch alone", async () => {
      await git(target, "checkout", "-q", "-b", "sandbar/issue-2-unmerged");
      await git(target, "commit", "-q", "--allow-empty", "-m", "work");
      await git(target, "checkout", "-q", "main");

      const deleted = await deleteMergedIssueBranches(cfg(target));

      expect(deleted).toEqual(["sandbar/issue-1-merged"]);
      expect(await hasBranch(target, "sandbar/issue-2-unmerged")).toBe(true);
    });
  });

  // The other consequence in #34: a clean launch directory would let preflight
  // pass while the actual target repo is mid-merge, on the wrong branch, or
  // carrying unmerged issue branches.
  describe("gatherState", () => {
    it("reports the target's current branch, not the launch directory's", async () => {
      await git(launchedFrom, "checkout", "-q", "-b", "some-other-branch");
      await git(target, "checkout", "-q", "-b", "release");

      const state = await gatherState(cfg(target));

      expect(state.currentBranch).toBe("release");
    });

    it("classifies the target's issue branches, not the launch directory's", async () => {
      await git(launchedFrom, "checkout", "-q", "-b", "sandbar/issue-9-launch");
      await git(launchedFrom, "commit", "-q", "--allow-empty", "-m", "work");
      await git(target, "checkout", "-q", "-b", "sandbar/issue-7-target");
      await git(target, "commit", "-q", "--allow-empty", "-m", "work");
      await git(target, "checkout", "-q", "main");

      const state = await gatherState(cfg(target));

      expect(state.unmergedIssueBranches).toEqual(["sandbar/issue-7-target"]);
    });

    // `git rev-parse --git-dir` prints a path relative to the command's cwd
    // (`.git`), so this stays broken if the command is fixed and the marker
    // probe is not — the run would then start on top of a half-finished merge.
    it("sees an in-progress merge in the target", async () => {
      await writeFile(join(target, ".git", "MERGE_HEAD"), "deadbeef\n");

      const state = await gatherState(cfg(target));

      expect(state.inProgressMarkers).toEqual(["MERGE_HEAD"]);
    });

    it("does not report an in-progress merge that belongs to the launch directory", async () => {
      await writeFile(join(launchedFrom, ".git", "MERGE_HEAD"), "deadbeef\n");

      const state = await gatherState(cfg(target));

      expect(state.inProgressMarkers).toEqual([]);
    });
  });
});
