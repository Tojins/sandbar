// Thin git wrapper for the inner loop: branch seeding, and the two asserts
// that make a gate verdict a statement about a commit ON THE ISSUE BRANCH —
// `dirtyWorktreePaths` (tree ≡ HEAD, #24 D1) and `headMismatch` (HEAD ≡
// refs/heads/<branch>, #27). Neither is optional and neither implies the other.

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
//
// `-c status.showUntrackedFiles=normal` is load-bearing, not boilerplate. A bare
// `git status --porcelain` HONOURS that setting, and `no` is common in big
// repos; it reaches a per-issue worktree from `~/.gitconfig`, from
// `$GIT_CONFIG_GLOBAL`, or from the repo's own `.git/config`, which every linked
// worktree shares. Inherit it and this function returns empty for a forgotten
// `git add`: the tree reads clean, the gate bind-mounts files that are in no
// commit, green means nothing, and the merger lands a branch that does not
// contain what was tested. It fails OPEN and silently, and both D1 entry points
// go blind together, so gate-2 does not catch it either. Pinning the value on
// the command line costs nothing and cannot be overridden from config.
export async function dirtyWorktreePaths(
  worktreePath: string,
): Promise<readonly string[]> {
  const { stdout } = await exec(
    "git",
    ["-c", "status.showUntrackedFiles=normal", "status", "--porcelain"],
    { cwd: worktreePath },
  );
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// --------------------------------------------------------------------------
// #27 — HEAD must BE the issue branch, not merely agree with it.
// --------------------------------------------------------------------------
//
// `dirtyWorktreePaths` proves the tree equals HEAD. Nothing proved HEAD equals
// `refs/heads/<branch>`, and the whole system downstream assumes it does. An
// implementer that commits on a detached HEAD — or on a scratch branch it
// created itself — leaves a perfectly CLEAN worktree, so every existing check
// agrees with it: gate-1 mounts that tree and goes green, the reviewer reads
// those commits and can APPROVE, the loop terminates DONE. The merge phase then
// reads the *branch*, which never moved: `git merge --no-ff` says "Already up to
// date", the merger records ok, and the issue is closed as completed with
// nothing on origin. The work is not destroyed, but it is unreachable and the
// tracker says it shipped.
//
// The check is on the SYMBOLIC ref, not on `rev-parse HEAD == rev-parse
// refs/heads/<branch>` as the issue first proposed. Comparing shas accepts a
// HEAD detached exactly AT the branch tip, which is honest for the commits that
// already exist and is one commit away from the bug for every commit that comes
// next — and the corrective instruction is identical either way, so there is
// nothing to gain by waiting for the divergence. The shas are still read, for
// the message: they are what tells the agent (and later a human) where the work
// actually went.
//
// Only the inner loop asks this. The merger's worktree is detached at
// `origin/<sourceBranch>` BY DESIGN (merger-worktree.ts), so unlike D1's
// clean-tree assert this cannot move into the shared `stack.runGate()` — there
// is no branch it should be on. Nor does it need a second entry point there:
// nothing runs between the implementer result and gate-1.
export type HeadMismatch = {
  // The branch HEAD was supposed to be on — carried so the re-prompt can name
  // it without the pure state machine having to know the issue.
  readonly branch: string;
  // The ref HEAD points at, or null when HEAD is detached.
  readonly headRef: string | null;
  readonly headSha: string | null;
  // The issue branch's tip, or null when the ref is missing entirely.
  readonly branchSha: string | null;
};

// The ref HEAD symbolically points at, or null when HEAD is detached.
//
// `git symbolic-ref -q HEAD` answers "detached" with exit 1 and an EMPTY
// stderr; every real failure (not a repo, unreadable HEAD) exits 128 and says
// why. Distinguishing them is the point of reading the code rather than
// catch-and-return-null: a swallowed 128 would report a broken repo as a
// detached HEAD, which is a different bug with a different fix.
async function symbolicHead(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["symbolic-ref", "-q", "HEAD"], {
      cwd: worktreePath,
    });
    return stdout.trim() || null;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    if (code === 1 && stderr === "") return null;
    throw err;
  }
}

// `git rev-parse --verify <rev>`, or null when the rev does not resolve. Used
// only to enrich the mismatch message, so a missing ref is data, not an error.
async function revParseOrNull(
  worktreePath: string,
  rev: string,
): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--verify", rev], {
      cwd: worktreePath,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// null when HEAD is exactly `refs/heads/<branch>`; otherwise where it actually
// is, for the re-prompt.
export async function headMismatch(
  worktreePath: string,
  branch: string,
): Promise<HeadMismatch | null> {
  const headRef = await symbolicHead(worktreePath);
  if (headRef === `refs/heads/${branch}`) return null;
  const [headSha, branchSha] = await Promise.all([
    revParseOrNull(worktreePath, "HEAD"),
    revParseOrNull(worktreePath, `refs/heads/${branch}`),
  ]);
  return { branch, headRef, headSha, branchSha };
}
