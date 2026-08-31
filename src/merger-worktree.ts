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
// merger), registered in the bare cache since #38, so the existing
// `git worktree prune` + orphan sweep at the next cycle's sandbox bring-up
// reclaims any leftover after a crash. We still remove
// it explicitly in run.ts's finally, and register removal with the cleanup
// registry before creating it so a signal mid-bringup tears it down — as a
// disposable (#55), since run.ts creates one of these per CYCLE.
//
// The merge result is pushed with `git push origin HEAD:<sourceBranch>`; the
// operator's local branch is never touched. It catches up on the next
// `git pull`, consistent with how issue branches already seed from origin
// rather than local (see git-ops.ts / preflight.ts).

import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { registerDisposable } from "./cleanup.js";
import { SandbarError } from "./errors.js";
import type { RepoLayout } from "./repo-cache.js";

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
// existing prune/orphan-sweep reclaims it. Takes the worktrees directory since
// #38: the repo is `<stateDir>/repo.git` and the worktrees sit beside it, so
// composing this from the repo directory would put the merge inside the cache.
export function mergerWorktreePathFor(worktreesDir: string): string {
  return join(worktreesDir, MERGER_WORKTREE_NAME);
}

// Given the contents of a worktree's `.git` gitlink file ("gitdir: <abs>"),
// return the repo's common git dir, or null when the content isn't a gitlink.
// Since #38 that is sandbar's bare cache rather than a `.git` inside a
// checkout — "up two levels from the gitdir" lands correctly on either. The
// container running the resolve agent must mount this path at its own absolute
// location so in-container git can follow the gitlink. Pure; `resolveGitMounts`
// in agent-sandbox.ts answers the same question by asking
// `git rev-parse --git-common-dir`, which it can because it has a worktree to
// ask from and this one is handed only the file's bytes.
export function gitlinkCommonDir(gitFileContent: string): string | null {
  const match = gitFileContent.trim().match(/^gitdir:\s*(.+)$/);
  if (!match || match[1] === undefined) return null;
  // <commonDir>/.git/worktrees/<name>  →  up two levels  →  <commonDir>/.git
  return resolve(match[1].trim(), "..", "..");
}

// Resolve the extra identity bind-mount the resolve-agent container needs so
// in-container git works against a worktree. Returns [] only for the one case
// that legitimately needs no extra mount: a normal repo, whose `.git` is a
// directory already covered by mounting the workspace.
//
// Every other outcome THROWS rather than returning []. Since #38 the merger
// worktree is always a linked worktree of the bare cache, so its `.git` is
// always a gitlink and the mount is always required — an empty list means
// in-container git cannot follow it, and every command the resolve agent runs
// fails with "not a git repository" while the loop reads the result as the
// agent's own doing. That is the same swallow #38 removed from
// `resolveGitMounts` one file over, and it belongs removed here for the same
// reason.
export async function gitMountsForWorktree(
  worktreeCwd: string,
): Promise<readonly string[]> {
  const gitPath = join(worktreeCwd, ".git");
  let isDir: boolean;
  try {
    isDir = (await stat(gitPath)).isDirectory();
  } catch (err) {
    throw new SandbarError(
      `No \`.git\` at ${gitPath}: the merger worktree must be a git worktree ` +
        "for the resolve agent's container to see the repository.",
      { cause: err },
    );
  }
  if (isDir) return [];
  let content: string;
  try {
    content = await readFile(gitPath, "utf-8");
  } catch (err) {
    throw new SandbarError(
      `Cannot read the gitlink at ${gitPath}, so the resolve agent's ` +
        "container cannot be given the repository it points at.",
      { cause: err },
    );
  }
  const commonDir = gitlinkCommonDir(content);
  if (commonDir === null) {
    throw new SandbarError(
      `The gitlink at ${gitPath} does not name a git directory ` +
        `(expected a \`gitdir: <path>\` line, got ${JSON.stringify(content.trim().slice(0, 120))}).`,
    );
  }
  return [commonDir];
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
  const sweep = async (): Promise<void> => {
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
