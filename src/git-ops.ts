// Thin git wrappers used by the inner-loop's reviewer + gate-2 step.
// Kept separate from the gate so the gate stays single-responsibility.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function getHeadSha(cwd: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

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

export async function resetHard(cwd: string, sha: string): Promise<void> {
  await exec("git", ["reset", "--hard", sha], { cwd });
}

export async function commitsSince(
  cwd: string,
  baseSha: string,
): Promise<{ sha: string }[]> {
  const { stdout } = await exec("git", ["rev-list", `${baseSha}..HEAD`], {
    cwd,
  });
  return stdout
    .trim()
    .split("\n")
    .filter((s) => s.length > 0)
    .map((sha) => ({ sha }));
}
