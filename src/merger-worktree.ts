// Ephemeral merger worktree (issue #10).
//
// The merger merges DONE branches into the source branch and pushes. Doing
// that in the operator's primary checkout means a `git merge` / agentic
// conflict-resolution runs against a working tree that may hold the operator's
// unrelated uncommitted edits — which then get swept into the merge commit and
// pushed under an unrelated issue. The cure is structural: do the merge in a
// dedicated, throwaway worktree checked out (detached) at
// `origin/<sourceBranch>`. The operator's edits live only in their own
// checkout's working tree and are physically absent here, so nothing can
// absorb them — in the clean path or the conflict path.
//
// The worktree lives beside the per-issue worktrees (<cwd>/<workDir>/worktrees/
// merger) so the existing `git worktree prune` + orphan sweep at the next
// cycle's sandbox bring-up reclaims any leftover after a crash. We still remove
// it explicitly in run.ts's finally, and register removal with onCleanup before
// creating it so a signal mid-bringup tears it down.
//
// The merge result is pushed with `git push origin HEAD:<sourceBranch>`; the
// operator's local branch is never touched. It catches up on the next
// `git pull`, consistent with how issue branches already seed from origin
// rather than local (see git-ops.ts / preflight.ts).

import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { onCleanup } from "./cleanup.js";
import { SandbarError } from "./errors.js";

const exec = promisify(execFile);

// Mirror agent-sandbox's worktree flags: keep `git worktree add` from mutating
// the repo's merge/push autosetup config under us.
const NO_CONFIG_LOCK_FLAGS = [
  "-c",
  "branch.autoSetupMerge=false",
  "-c",
  "push.autoSetupRemote=false",
];

export const MERGER_WORKTREE_NAME = "merger";

// Where the merger worktree lives. Pure — beside the per-issue worktrees so the
// existing prune/orphan-sweep reclaims it.
export function mergerWorktreePathFor(cwd: string, workDir: string): string {
  return join(cwd, workDir, "worktrees", MERGER_WORKTREE_NAME);
}

// Given the contents of a worktree's `.git` gitlink file ("gitdir: <abs>"),
// return the repo's common git dir (the parent repo's `.git`), or null when the
// content isn't a gitlink. The container running the resolve agent must mount
// this path at its own absolute location so in-container git can follow the
// gitlink. Pure — mirrors resolveGitMounts in agent-sandbox.ts.
export function gitlinkCommonDir(gitFileContent: string): string | null {
  const match = gitFileContent.trim().match(/^gitdir:\s*(.+)$/);
  if (!match || match[1] === undefined) return null;
  // <commonDir>/.git/worktrees/<name>  →  up two levels  →  <commonDir>/.git
  return resolve(match[1].trim(), "..", "..");
}

// Resolve the extra identity bind-mount the resolve-agent container needs so
// in-container git works against a worktree. Returns [] when `worktreeCwd` is a
// normal repo (its `.git` is a directory, already covered by mounting the
// workspace) or has no readable gitlink.
export async function gitMountsForWorktree(
  worktreeCwd: string,
): Promise<readonly string[]> {
  const gitPath = join(worktreeCwd, ".git");
  let isDir: boolean;
  try {
    isDir = (await stat(gitPath)).isDirectory();
  } catch {
    return [];
  }
  if (isDir) return [];
  let content: string;
  try {
    content = await readFile(gitPath, "utf-8");
  } catch {
    return [];
  }
  const commonDir = gitlinkCommonDir(content);
  return commonDir ? [commonDir] : [];
}

export type MergerWorktree = {
  readonly path: string;
  // Idempotent teardown — `git worktree remove --force` + prune. Safe to call
  // more than once (onCleanup + the explicit finally may both fire).
  remove(): Promise<void>;
};

// Create the ephemeral merger worktree at origin/<sourceBranch>. Fetches first
// so the merge bases on the latest committed source — including any work the
// operator pushed while phase 2 ran. Detached HEAD avoids the "branch already
// checked out in another worktree" error when the operator's checkout is on
// sourceBranch.
export async function createMergerWorktree(opts: {
  readonly cwd: string;
  readonly workDir: string;
  readonly sourceBranch: string;
}): Promise<MergerWorktree> {
  const { cwd, workDir, sourceBranch } = opts;
  const path = mergerWorktreePathFor(cwd, workDir);

  let removed = false;
  const remove = async (): Promise<void> => {
    if (removed) return;
    removed = true;
    try {
      await exec("git", ["worktree", "remove", "--force", path], { cwd });
    } catch {
      // Not registered (or already gone) — fall through to the dir sweep.
    }
    try {
      await rm(path, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      await exec("git", ["worktree", "prune"], { cwd });
    } catch {
      /* best-effort */
    }
  };
  // Register before creating, so a signal during fetch/add still tears down.
  onCleanup(remove);

  // Clear any leftover from a prior crashed run before re-creating.
  await remove();
  removed = false;

  try {
    await exec("git", ["fetch", "origin", sourceBranch, "--quiet"], { cwd });
  } catch (err) {
    throw new SandbarError(
      `merger: failed to fetch origin/${sourceBranch} before creating the merge worktree: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  try {
    await exec(
      "git",
      [
        ...NO_CONFIG_LOCK_FLAGS,
        "worktree",
        "add",
        "--detach",
        path,
        `origin/${sourceBranch}`,
      ],
      { cwd },
    );
  } catch (err) {
    throw new SandbarError(
      `merger: failed to create the merge worktree at ${path} (origin/${sourceBranch}): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  return { path, remove };
}
