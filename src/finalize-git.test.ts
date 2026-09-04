import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { realAdapter } from "./finalize.js";
import { repoLayout, worktreePathFor } from "./repo-cache.js";

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@e",
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd, env: GIT_ENV });
}

describe("finalize real adapter git classifications", () => {
  let root: string;
  let seed: string;
  let cache: string;
  const merged = "sandbar/issue-1-merged";
  const unmerged = "sandbar/issue-2-unmerged";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-finalize-git-"));
    seed = join(root, "seed");
    const origin = join(root, "origin.git");
    const layout = repoLayout(root, ".sandbar");
    cache = layout.repoDir;

    await exec("git", ["init", "--bare", "-b", "main", origin], { env: GIT_ENV });
    await exec("git", ["init", "-b", "main", seed], { env: GIT_ENV });
    await writeFile(join(seed, "a.txt"), "base\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "base");
    await git(seed, "remote", "add", "origin", origin);
    await git(seed, "push", "-q", "origin", "main");
    await git(seed, "checkout", "-qb", unmerged);
    await writeFile(join(seed, "b.txt"), "work\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "work");

    await exec("git", ["clone", "--bare", "--quiet", origin, cache], { env: GIT_ENV });
    await git(cache, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await git(cache, "fetch", "origin", "--quiet");
    await git(cache, "branch", merged, "origin/main");
    await git(cache, "fetch", seed, `${unmerged}:${unmerged}`);
    await git(
      cache,
      "worktree",
      "add",
      worktreePathFor(layout.worktreesDir, merged),
      merged,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const adapter = () =>
    realAdapter({
      layout: repoLayout(root, ".sandbar"),
      repo: { owner: "o", name: "r" },
      sourceBranch: "main",
    });

  it("classifies branches by containment in origin/main", async () => {
    expect(await adapter().branchIsContainedInOrigin(merged)).toBe(true);
    expect(await adapter().branchIsContainedInOrigin(unmerged)).toBe(false);
  });

  // #98 made the issue tree a marked clone and `reclaimIssueClone` the one
  // spelling of its removal, so what the adapter has to get right is the two
  // named answers: a directory carrying no marker for this branch is debris the
  // rule removes, and a path that is simply gone — which sandbox.close() has
  // usually already produced — is `absent` rather than a failure.
  it("reports a reclaimed issue clone as removed, then absent", async () => {
    expect(await adapter().reclaimIssueClone(merged)).toEqual({ kind: "removed" });
    expect(await adapter().reclaimIssueClone(merged)).toEqual({ kind: "absent" });
  });
});
