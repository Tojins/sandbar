import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createMergerWorktree,
  gitMountsForWorktree,
  gitlinkCommonDir,
  mergerWorktreePathFor,
} from "./merger-worktree.js";
import { type RepoLayout, ensureRepoCache, repoLayout } from "./repo-cache.js";

const exec = promisify(execFile);

describe("mergerWorktreePathFor", () => {
  // #38: beside the cache, never inside it. Composing the path from the repo
  // directory instead would bury every merge in `repo.git/`, where the orphan
  // sweep and `git worktree prune` would still find it but a human never would.
  it("is not inside the bare cache", () => {
    const layout = repoLayout("/repo", ".sandbar");
    expect(mergerWorktreePathFor(layout.worktreesDir).startsWith(layout.repoDir)).toBe(
      false,
    );
  });
});

describe("gitlinkCommonDir", () => {
  it("resolves the common .git dir two levels up from the gitdir", () => {
    expect(gitlinkCommonDir("gitdir: /repo/.git/worktrees/merger")).toBe(
      "/repo/.git",
    );
  });

  it("trims trailing whitespace / newline", () => {
    expect(gitlinkCommonDir("gitdir: /repo/.git/worktrees/merger\n")).toBe(
      "/repo/.git",
    );
  });

  it("returns null for non-gitlink content", () => {
    expect(gitlinkCommonDir("ref: refs/heads/main")).toBeNull();
    expect(gitlinkCommonDir("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: real git, no podman. Validates the core issue-#10 claim — the
// merge surface is clean regardless of the operator's dirty checkout — plus the
// gitlink mount resolution end-to-end.
// ---------------------------------------------------------------------------

const git = (args: string[], cwd: string) =>
  exec("git", args, { cwd, env: { ...process.env, LC_ALL: "C" } });

async function setupRepoWithOrigin(): Promise<{
  origin: string;
  cwd: string;
  layout: RepoLayout;
}> {
  const root = await mkdtemp(join(tmpdir(), "sandbar-mwt-"));
  const origin = join(root, "origin.git");
  const cwd = join(root, "checkout");
  await exec("git", ["init", "--bare", "-b", "main", origin]);
  await git(["clone", origin, cwd], root);
  await git(["config", "user.email", "t@t"], cwd);
  await git(["config", "user.name", "t"], cwd);
  await writeFile(join(cwd, "a.txt"), "base\n");
  await git(["add", "."], cwd);
  await git(["commit", "-m", "base"], cwd);
  await git(["push", "origin", "main"], cwd);
  // The merge now happens in sandbar's own bare cache (#38), so the fixture
  // has to build one — which is itself the point being tested below: the
  // operator's checkout is not merely avoided, it is not the repo the worktree
  // is registered in.
  const layout = repoLayout(cwd, ".sandbar");
  await ensureRepoCache(layout);
  return { origin, cwd, layout };
}

describe("createMergerWorktree (real git)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("checks out a clean tree at origin/main even when the operator checkout is dirty", async () => {
    const { cwd, layout } = await setupRepoWithOrigin();
    dirs.push(join(cwd, ".."));

    // Operator has unrelated uncommitted work in their primary checkout.
    await writeFile(join(cwd, "unrelated.txt"), "operator wip\n");
    await writeFile(join(cwd, "a.txt"), "base\noperator edit\n");

    const wt = await createMergerWorktree({ layout, sourceBranch: "main" });

    expect(wt.path).toBe(mergerWorktreePathFor(layout.worktreesDir));

    // Registered in the CACHE, not in the operator's checkout (#38). This is
    // the structural half of issue #10: `git worktree remove --force` and the
    // merge itself run in a repo that holds none of the operator's refs.
    const operatorWorktrees = await git(["worktree", "list"], cwd);
    expect(operatorWorktrees.stdout).not.toContain(wt.path);
    const cacheWorktrees = await git(["worktree", "list"], layout.repoDir);
    expect(cacheWorktrees.stdout).toContain(wt.path);

    // The merge surface is clean — the operator's edits are not present.
    const status = await git(["status", "--porcelain"], wt.path);
    expect(status.stdout.trim()).toBe("");
    const hasUnrelated = await stat(join(wt.path, "unrelated.txt")).then(
      () => true,
      () => false,
    );
    expect(hasUnrelated).toBe(false);

    // Detached HEAD at the committed origin tip.
    const head = await git(["rev-parse", "HEAD"], wt.path);
    const originMain = await git(["rev-parse", "origin/main"], cwd);
    expect(head.stdout.trim()).toBe(originMain.stdout.trim());
    await expect(
      git(["symbolic-ref", "--quiet", "HEAD"], wt.path),
    ).rejects.toBeTruthy(); // detached → no symbolic ref

    // The operator's working tree is untouched.
    const opStatus = await git(["status", "--porcelain"], cwd);
    expect(opStatus.stdout).toContain("unrelated.txt");

    await wt.remove();
    const gone = await stat(wt.path).then(
      () => false,
      () => true,
    );
    expect(gone).toBe(true);
  });

  it("gitMountsForWorktree returns the parent common .git for a worktree, [] for a plain repo", async () => {
    const { cwd, layout } = await setupRepoWithOrigin();
    dirs.push(join(cwd, ".."));

    // A plain repo's .git is a directory → no extra mount needed.
    expect(await gitMountsForWorktree(cwd)).toEqual([]);

    const wt = await createMergerWorktree({ layout, sourceBranch: "main" });

    const mounts = await gitMountsForWorktree(wt.path);
    expect(mounts).toHaveLength(1);
    // The gitlink now points into the BARE cache, and "up two levels from the
    // gitdir" lands on the cache directory itself rather than on a `.git`
    // inside a checkout. The mount shape is unchanged, which is the claim: the
    // identity mount is what lets in-container git follow the gitlink either
    // way.
    const gitlink = (await readFile(join(wt.path, ".git"), "utf-8")).trim();
    expect(gitlink).toMatch(/^gitdir:/);
    expect(mounts[0]).toBe(layout.repoDir);

    await wt.remove();
  });


  // Not `[]`. Since #38 the merger worktree is always a linked worktree of the
  // bare cache, so the mount is always required — an empty list means
  // in-container git cannot follow the gitlink and every command the resolve
  // agent runs fails with "not a git repository", which the loop then reads as
  // the agent's own doing. Swallowing it is the same silence #38 removed from
  // `resolveGitMounts` one file over.
  it("gitMountsForWorktree throws rather than returning [] when it cannot answer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbar-nogit-"));
    dirs.push(dir);

    // No `.git` at all.
    await expect(gitMountsForWorktree(dir)).rejects.toThrow(/No `\.git`/);

    // A gitlink that names nothing.
    await writeFile(join(dir, ".git"), "not a gitlink\n");
    await expect(gitMountsForWorktree(dir)).rejects.toThrow(
      /does not name a git directory/,
    );
  });});
