// Thin git wrapper for inner-loop branch seeding.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Create the issue's branch at origin/<sourceBranch> if it doesn't already
// exist. Seeding from origin (not local sourceBranch) means a per-issue
// worktree never inherits in-progress state from the host's working tree —
// sandbar can run while the user is mid-edit on cwd. Existing branches keep
// their accumulated commits (resumed runs); we only pre-create when missing.
export async function ensureIssueBranch(
  branch: string,
  sourceBranch: string,
): Promise<void> {
  try {
    await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return; // exists
  } catch {
    // fall through
  }
  // --no-track: don't write upstream config (a) we never `git pull` these
  // branches and (b) parallel `git branch` calls race on `.git/config`.
  await exec("git", ["branch", "--no-track", branch, `origin/${sourceBranch}`]);
}

// The paths `git status --porcelain` reports in a worktree — tracked
// modifications and untracked, non-ignored files alike.
//
// This is what makes a gate verdict a statement about a COMMIT rather than
// about a directory (#24 D1). The gate bind-mounts the worktree itself: it must,
// because a repo's build artifacts (node_modules, vendor, dist) are gitignored
// and have to survive between attempts, so a materialized `git archive` tree
// would pay a cold build every attempt and a second reset-and-clean tree would
// pay ~768M of copying per issue for an identical verdict. Asserting the tree
// is clean gets the same guarantee for the cost of one `git status`.
//
// Refusing beats cleaning. The rejected alternative — `git clean -fd` before
// each gate — deletes exactly the set this reports: untracked, non-ignored
// files. That set is overwhelmingly a forgotten `git add`, and destroying the
// agent's work silently is worse than telling it to commit.
//
// Corollary for consumers, enforced by nothing but stated here and in the gate
// stack's docs: a gate step must write only into gitignored paths, or its own
// exhaust is reported as uncommitted work on every attempt until the budget
// dies.
export async function dirtyWorktreePaths(
  worktreePath: string,
): Promise<readonly string[]> {
  const { stdout } = await exec("git", ["status", "--porcelain"], {
    cwd: worktreePath,
  });
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
