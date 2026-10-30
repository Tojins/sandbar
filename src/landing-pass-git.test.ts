// The landing pass's git facts (#258) as realAdapter reads them, in a LINKED
// WORKTREE like the merger's: what a landing changed, and the shape an attempt
// left on top of the merge.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitShapeProblem } from "./landing-pass.js";
import { realAdapter } from "./merger.js";

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

async function commit(cwd: string, file: string, body: string): Promise<string> {
  await mkdir(dirname(join(cwd, file)), { recursive: true });
  await writeFile(join(cwd, file), body);
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", `edit ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

describe("realAdapter landing-pass facts (real merge in a linked worktree)", () => {
  let root: string;
  let repo: string;
  let wt: string;
  let pre: string;
  let merged: string;

  const adapter = () =>
    realAdapter({ cwd: wt } as unknown as Parameters<typeof realAdapter>[0]);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-lp-"));
    repo = join(root, "repo");
    wt = join(root, "wt");
    await exec("git", ["init", "-qb", "main", repo], { env: GIT_ENV });
    pre = await commit(repo, "README.md", "base\n");
    await git(repo, "checkout", "-qb", "side");
    await commit(repo, "src/app/screen.ts", "screen\n");
    await commit(repo, "services.php", "appversion=4\n");
    await git(repo, "checkout", "-q", "main");
    await git(repo, "worktree", "add", "-q", "--detach", wt, "main");
    await git(wt, "merge", "--no-ff", "-q", "-m", "Merge side", "side");
    merged = await git(wt, "rev-parse", "HEAD");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists what the landing changed", async () => {
    expect([...await adapter().changedPaths(pre, "HEAD")].sort())
      .toEqual(["services.php", "src/app/screen.ts"]);
  });

  it("reads the prompt file at the pre-merge sha and refuses a directory there", async () => {
    await commit(repo, "docs/landing-pass.md", "rules\n");
    const tip = await git(repo, "rev-parse", "main");

    expect(await adapter().readFileAt(tip, "docs/landing-pass.md")).toBe("rules\n");
    expect(await adapter().readFileAt(tip, "docs/absent.md")).toBeNull();
    await expect(adapter().readFileAt(tip, "docs")).rejects.toThrow(/not a file/);
  });

  it("keeps a clean single-parent chain on the merge", async () => {
    const first = await commit(wt, "services.php", "appversion=5\n");
    const second = await commit(wt, "src/app/required.ts", "5\n");
    const shape = await adapter().commitShape(merged);

    expect(shape).toEqual({
      mergeInProgress: false,
      dirtyPaths: [],
      descends: true,
      commits: [{ sha: first, parents: 1 }, { sha: second, parents: 1 }],
    });
    expect(commitShapeProblem(shape)).toBeNull();
  });

  it("sees no commits when the pass changed nothing", async () => {
    expect(await adapter().commitShape(merged)).toEqual({
      mergeInProgress: false,
      dirtyPaths: [],
      descends: true,
      commits: [],
    });
  });

  it("refuses an amended merge", async () => {
    await writeFile(join(wt, "services.php"), "appversion=5\n");
    await git(wt, "commit", "-qam", "amended", "--amend");
    const shape = await adapter().commitShape(merged);

    expect(shape.descends).toBe(false);
    expect(commitShapeProblem(shape)).toMatch(/no longer descended/);
  });

  it("refuses a merge commit on top of the merge", async () => {
    await git(repo, "checkout", "-qb", "other", "main");
    await commit(repo, "docs/x.md", "x\n");
    await git(wt, "merge", "--no-ff", "-q", "-m", "Merge other", "other");
    const mergeCommit = await git(wt, "rev-parse", "HEAD");
    const shape = await adapter().commitShape(merged);

    expect(shape.commits).toContainEqual({ sha: mergeCommit, parents: 2 });
    expect(commitShapeProblem(shape)).toBe(
      `commit ${mergeCommit} has 2 parents, and only single-parent commits may follow the merge`,
    );
  });

  it("refuses a dirty tree", async () => {
    await writeFile(join(wt, "services.php"), "appversion=5\n");
    const shape = await adapter().commitShape(merged);

    expect(shape.dirtyPaths).toEqual(["M services.php"]);
    expect(commitShapeProblem(shape)).toMatch(/worktree was left dirty/);
  });

  it("refuses a merge left in progress", async () => {
    await git(repo, "checkout", "-qb", "clash", "main");
    await commit(repo, "services.php", "appversion=9\n");
    await expect(exec("git", ["merge", "--no-ff", "clash"], { cwd: wt, env: GIT_ENV }))
      .rejects.toMatchObject({ stdout: expect.stringContaining("CONFLICT") });
    const shape = await adapter().commitShape(merged);

    expect(shape.mergeInProgress).toBe(true);
    expect(commitShapeProblem(shape)).toBe("a merge was left in progress");
  });
});
