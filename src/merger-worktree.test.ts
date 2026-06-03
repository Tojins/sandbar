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

const exec = promisify(execFile);

describe("mergerWorktreePathFor", () => {
  it("lives beside the per-issue worktrees", () => {
    expect(mergerWorktreePathFor("/repo", ".sandbar")).toBe(
      "/repo/.sandbar/worktrees/merger",
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

async function setupRepoWithOrigin(): Promise<{ origin: string; cwd: string }> {
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
  return { origin, cwd };
}

describe("createMergerWorktree (real git)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("checks out a clean tree at origin/main even when the operator checkout is dirty", async () => {
    const { cwd } = await setupRepoWithOrigin();
    dirs.push(join(cwd, ".."));

    // Operator has unrelated uncommitted work in their primary checkout.
    await writeFile(join(cwd, "unrelated.txt"), "operator wip\n");
    await writeFile(join(cwd, "a.txt"), "base\noperator edit\n");

    const wt = await createMergerWorktree({
      cwd,
      workDir: ".sandbar",
      sourceBranch: "main",
    });

    expect(wt.path).toBe(mergerWorktreePathFor(cwd, ".sandbar"));

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
    const { cwd } = await setupRepoWithOrigin();
    dirs.push(join(cwd, ".."));

    // A plain repo's .git is a directory → no extra mount needed.
    expect(await gitMountsForWorktree(cwd)).toEqual([]);

    const wt = await createMergerWorktree({
      cwd,
      workDir: ".sandbar",
      sourceBranch: "main",
    });

    const mounts = await gitMountsForWorktree(wt.path);
    expect(mounts).toHaveLength(1);
    // It must be the operator repo's real .git dir, mounted identity so
    // in-container git can follow the worktree gitlink.
    const gitlink = (await readFile(join(wt.path, ".git"), "utf-8")).trim();
    expect(gitlink).toMatch(/^gitdir:/);
    expect(mounts[0]).toBe(join(cwd, ".git"));

    await wt.remove();
  });
});
