// The reconciler's one question that is a fact about GIT rather than about a
// decision (#64): is this chunk branch already contained in the source branch?
// Everything the reconciler does hangs off that answer — issues closed, a pull
// request closed, a branch deleted on origin — and no fake can produce it, so
// it is asserted by running git against real repositories, in the shape the
// bare object cache actually has (origin's refs under `refs/remotes/origin/*`,
// no local heads).
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findLandedChunkBranches } from "./chunk-reconcile.js";
import { readChunkMembers } from "./plan-resolver.js";

const exec = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@e",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

describe("findLandedChunkBranches (real git)", () => {
  let root: string;
  let origin: string;
  let cache: string;
  let work: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-recon-"));
    origin = join(root, "origin.git");
    cache = join(root, "cache.git");
    work = join(root, "work");
    await exec("git", ["init", "-b", "main", work], { env: GIT_ENV });
    await writeFile(join(work, "a.txt"), "a");
    await git(work, "add", ".");
    await git(work, "commit", "-m", "base");
    await exec("git", ["init", "--bare", "-b", "main", origin], { env: GIT_ENV });
    await git(work, "remote", "add", "origin", origin);
    await git(work, "push", "origin", "main");

    // A chunk branch that IS on main, and one that is not.
    await git(work, "checkout", "-b", "sandbar/chunk-42-landed");
    await writeFile(join(work, "b.txt"), "b");
    await git(work, "add", ".");
    await git(work, "commit", "-m", "chunk 42");
    await git(work, "push", "origin", "sandbar/chunk-42-landed");
    await git(work, "checkout", "main");
    await git(work, "merge", "--no-ff", "-m", "land 42", "sandbar/chunk-42-landed");
    await git(work, "push", "origin", "main");

    await git(work, "checkout", "-b", "sandbar/chunk-77-open");
    await writeFile(join(work, "c.txt"), "c");
    await git(work, "add", ".");
    await git(work, "commit", "-m", "chunk 77");
    await git(work, "push", "origin", "sandbar/chunk-77-open");

    await exec("git", ["clone", "--bare", origin, cache], { env: GIT_ENV });
    // A bare clone's `origin` is the URL it came from, but its refs live under
    // `refs/heads`; the cache sandbar builds keeps origin's under
    // `refs/remotes/origin/*`, which is what the fetch below establishes.
    await git(cache, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await git(cache, "fetch", "origin", "--quiet");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns only the chunk branch whose commits are on the source branch", async () => {
    expect(await findLandedChunkBranches(cache, "main")).toEqual([
      "sandbar/chunk-42-landed",
    ]);
  });

  it("fetches member refs beside chunk refs before deriving membership", async () => {
    // Push from the work repository so the cache cannot learn this ref as a
    // push-side remote-tracking update. The reconciler's fetch is therefore
    // the only operation that can make the membership record visible there.
    await git(
      work,
      "push",
      "origin",
      "sandbar/chunk-42-landed:refs/heads/sandbar/member-42",
    );

    await findLandedChunkBranches(cache, "main");

    expect(await readChunkMembers(cache)).toEqual(
      new Map([
        ["sandbar/chunk-42-landed", new Set([42])],
        ["sandbar/chunk-77-open", new Set([42])],
      ]),
    );
  });

  it("says nothing has landed when the repository has no chunk branch at all", async () => {
    await git(cache, "push", "origin", "--delete", "refs/heads/sandbar/chunk-42-landed");
    await git(cache, "push", "origin", "--delete", "refs/heads/sandbar/chunk-77-open");
    // Not vacuous: the fetch has to SUCCEED for this to be the empty answer
    // rather than the fail-soft one below, and a wildcard refspec that matches
    // nothing is not a git error.
    expect(await findLandedChunkBranches(cache, "main")).toEqual([]);
  });

  it("says nothing has landed when the fetch itself failed, however fresh the cache looks", async () => {
    // The reviewer's scenario, and the reason the fetch's exit status is read
    // rather than discarded: `gh` reaches the forge over HTTPS while git's
    // transport is down (an expired key, a proxy). The cache still holds a
    // chunk ref that IS contained in its `origin/main`, so every local question
    // answers "landed" — and acting on that closes issues, deletes a branch and
    // comments on a pull request for a chunk somebody may have already
    // reconciled. Only the failed prune knows the cache cannot be trusted.
    await git(cache, "remote", "set-url", "origin", join(root, "gone.git"));
    expect(await findLandedChunkBranches(cache, "main")).toEqual([]);
    // And the stale ref really is still there, so the guard is what produced
    // the empty answer.
    expect(
      await git(cache, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/sandbar/*"),
    ).toContain("sandbar/chunk-42-landed");
  });
});
