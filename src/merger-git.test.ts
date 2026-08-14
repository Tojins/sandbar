// realAdapter's git predicates, against REAL repositories — specifically in a
// LINKED WORKTREE, because that is what the merger has run in since #10 and it
// is where the naive filesystem path silently stops working.
//
// `git worktree add` writes a `.git` FILE (a gitlink), not a directory, and
// puts per-worktree state under `<repo>/.git/worktrees/<name>/`. A predicate
// that stats `<cwd>/.git/MERGE_HEAD` therefore returns false forever in
// production while looking correct in any test that uses a plain clone.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

async function commit(cwd: string, file: string, body: string): Promise<void> {
  await writeFile(join(cwd, file), body);
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", `edit ${file}`);
}

describe("realAdapter.isMergeInProgress (real linked worktree)", () => {
  let root: string;
  let repo: string;
  let wt: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-mg-"));
    repo = join(root, "repo");
    wt = join(root, "wt");
    await exec("git", ["init", "-b", "main", repo], { env: GIT_ENV });
    await commit(repo, "a.txt", "one\n");
    await git(repo, "checkout", "-qb", "side");
    await commit(repo, "a.txt", "side\n");
    await git(repo, "checkout", "-q", "main");
    await commit(repo, "a.txt", "main\n");
    // Exactly how createMergerWorktree sets up: a detached linked worktree.
    await git(repo, "worktree", "add", "--detach", wt, "HEAD");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const adapterAt = (cwd: string) =>
    realAdapter({
      cwd,
      sourceBranch: "main",
      botName: "bot",
      botEmail: "bot@e",
      coauthorTrailer: "",
      mergerModelId: "opus",
      ghOwner: "o",
      ghRepo: "r",
      gateImage: "img",
      gateCommands: {
        check: { cmd: "true", args: [] },
        test: { cmd: "true", args: [] },
      },
    } as unknown as Parameters<typeof realAdapter>[0]);

  it("is false on a clean worktree", async () => {
    expect(await adapterAt(wt).isMergeInProgress()).toBe(false);
  });

  it("is TRUE mid-conflict, where the naive .git/MERGE_HEAD path reads false", async () => {
    // Deliberately conflicting: both branches rewrote the same line.
    await expect(git(wt, "merge", "--no-ff", "side")).rejects.toThrow();

    expect(await adapterAt(wt).isMergeInProgress()).toBe(true);
    // The bug this replaced, pinned so it cannot come back: the file simply is
    // not there under the worktree's own `.git`, which is a gitlink file.
    const naive = join(wt, ".git", "MERGE_HEAD");
    const { existsSync } = await import("node:fs");
    expect(existsSync(naive)).toBe(false);
  });

  it("goes back to false after the merge is aborted", async () => {
    await expect(git(wt, "merge", "--no-ff", "side")).rejects.toThrow();
    await git(wt, "merge", "--abort");
    expect(await adapterAt(wt).isMergeInProgress()).toBe(false);
  });

  it("still works in a plain (non-worktree) checkout", async () => {
    await expect(git(repo, "merge", "--no-ff", "side")).rejects.toThrow();
    expect(await adapterAt(repo).isMergeInProgress()).toBe(true);
  });
});
