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
