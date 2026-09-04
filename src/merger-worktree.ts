// Ephemeral merger worktree (#10).
//
// The merger works in a dedicated, throwaway worktree checked out (detached)
// at `origin/<sourceBranch>` — never the operator's checkout, whose unrelated
// uncommitted edits are physically absent here and so cannot be swept into a
// merge commit.
//
// The merger clone lives beside the per-issue clones and owns a real `.git`
// directory (#98), so no resolve container needs the cache. Removal is
// registered with the cleanup registry
// before creation so a signal mid-bringup tears it down — as a disposable
// (#55), since run.ts creates one per CYCLE.
//
// The merge result is pushed with `git push origin HEAD:<sourceBranch>`; the
// operator's local branch is never touched.

import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { registerDisposable } from "./cleanup.js";
import { SandbarError } from "./errors.js";
import { MERGER_WORKTREE_NAME, type RepoLayout } from "./repo-cache.js";

const exec = promisify(execFile);

// Where the merger worktree lives. Pure — beside the per-issue worktrees so the
// existing prune/orphan-sweep reclaims it. Takes the worktrees directory since
// #38: the repo is `<stateDir>/repo.git` and the worktrees sit beside it, so
// composing this from the repo directory would put the merge inside the cache.
export function mergerWorktreePathFor(worktreesDir: string): string {
  return join(worktreesDir, MERGER_WORKTREE_NAME);
}

export type MergerWorktree = {
  readonly path: string;
  // Idempotent teardown of the standalone clone. Safe to call
  // more than once (onCleanup + the explicit finally may both fire).
  remove(): Promise<void>;
};

// Create the ephemeral merger worktree at origin/<sourceBranch>. Fetches first
// so the merge bases on the latest committed source — including any work the
// operator pushed while phase 2 ran. Detached HEAD avoids the "branch already
// checked out in another worktree" error when the operator's checkout is on
// sourceBranch.
export async function createMergerWorktree(opts: {
  readonly layout: RepoLayout;
  readonly sourceBranch: string;
}): Promise<MergerWorktree> {
  const { layout, sourceBranch } = opts;
  // The bare cache (#38). The operator's checkout is not merely avoided here,
  // it is unreachable: the worktree is registered in a repo that holds none of
  // their refs and no working tree of their own.
  const cwd = layout.repoDir;
  const path = mergerWorktreePathFor(layout.worktreesDir);

  // The removal itself, unlatched — this runs twice on the ordinary path, once
  // to clear a prior crashed run's leftover and once as the teardown.
  // Since #98 the merger tree is a standalone clone with its own `.git`, so
  // there is no worktree registration to unpick and the removal is the
  // directory alone. `force` already makes an absent path the success it
  // reads as, which leaves nothing this may legitimately absorb: a sweep that
  // fails propagates (#99), and on the teardown path `runCleanup` reports it
  // with its cause rather than losing it to a "best-effort" comment.
  const sweep = async (): Promise<void> => {
    await rm(path, { recursive: true, force: true });
  };

  let removed = false;
  const remove = async (): Promise<void> => {
    if (removed) return;
    removed = true;
    // Latched, so this can never do anything again — drop it from the registry
    // rather than leave a spent closure there for the rest of the run (#55).
    dispose();
    await sweep();
  };
  // Register before creating, so a signal during fetch/add still tears down.
  const dispose = registerDisposable(remove);

  // Clear any leftover from a prior crashed run before re-creating. `sweep`
  // rather than `remove`: the pre-clear is not this worktree's teardown and
  // must not spend its latch — going through `remove` and resetting `removed`
  // afterwards would leave the flag re-armed but the registration already
  // disposed, so a signal during the fetch/add below would sweep nothing.
  await sweep();

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
    await exec("git", ["clone", "--local", "--no-checkout", cwd, path], { cwd });
    await exec("git", ["fetch", cwd, "+refs/remotes/origin/*:refs/remotes/origin/*"], { cwd: path });
    const { stdout: originUrl } = await exec("git", ["config", "--get", "remote.origin.url"], { cwd });
    await exec("git", ["config", "remote.origin.url", originUrl.trim()], { cwd: path });
    await exec("git", ["checkout", "--detach", `origin/${sourceBranch}`], { cwd: path });
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
