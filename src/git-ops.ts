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
// agrees with it: gate-1 mounts that tree and goes green, and the reviewer reads
// those commits and can APPROVE. Meanwhile the merger only ever reads the
// branch, which did not move.
//
// Be precise about how far that gets, because the two reachable shapes want
// different words and #27 describes only the one that is currently unreachable:
//
//   - The agent detaches from its FIRST attempt and never commits on the branch.
//     Commit capture reads `refs/heads/<branch>` (agent-sandbox.ts), so
//     `commitsAccumulated` stays 0 and `parsePromise` already downgrades
//     COMPLETE to NO-SIGNAL. The loop cannot reach DONE — it burns all eight
//     attempts being told "you made no commits this run" while the agent can see
//     the commits it made, and dies as `NEEDS-HUMAN gate-red` naming a gate that
//     never ran. Wrong diagnosis, wasted budget, but nothing lands.
//
//   - The agent commits on the branch, THEN detaches — the review round-trip
//     makes this the ordinary case: attempt 1 lands work, the reviewer asks for
//     changes, attempt 2 writes the fix on a detached HEAD. Now
//     `commitsAccumulated` is already positive, so COMPLETE stands, gate-1 goes
//     green on a tree containing the fix, the reviewer approves, DONE — and the
//     merger lands attempt 1's commits WITHOUT the fix. A green gate certifying
//     a tree the branch does not contain, and a partial land presented as a
//     complete one. This is the live bug.
//
// Neither shape is one an existing check can see, and the fix is the same
// question for both.
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
  readonly headSha: string;
  // The issue branch's tip, or null when the ref is missing entirely.
  readonly branchSha: string | null;
};

// The ref HEAD points at, or null when HEAD is detached.
//
// `git rev-parse --symbolic-full-name HEAD` and NOT `git symbolic-ref -q HEAD`.
// The obvious reading of symbolic-ref is that exit 1 means detached and exit 128
// means broken, so the two can be told apart by the code — but `-q` suppresses
// only git's OWN message, and anything else writing to stderr still comes
// through. `GIT_TRACE=1` in the operator's environment is enough: the command
// then exits 1 with 82 bytes of trace on stderr, an exit-code-plus-empty-stderr
// test rethrows, `runImplementer` throws, and a detached HEAD is reported as an
// infra HARD-ERROR — two pointless fresh-sandbox retries, then a terminal that
// deletes the branch and posts no comment at all. Exactly the failure this
// module exists to make visible, made invisible again by an env var.
//
// rev-parse has no such fork: inside a valid repo it exits 0 either way and
// prints the literal `HEAD` when detached, so a non-zero exit is unambiguously a
// real failure and is left to throw. It is also, not incidentally, the command
// prompts/implementer.md tells the agent to verify itself with — the check and
// the instruction are now the same question.
async function headRef(worktreePath: string): Promise<string | null> {
  const { stdout } = await exec(
    "git",
    ["rev-parse", "--symbolic-full-name", "HEAD"],
    { cwd: worktreePath },
  );
  const ref = stdout.trim();
  // Detached: rev-parse echoes the input rather than naming a ref.
  return ref === "HEAD" || ref === "" ? null : ref;
}

// The issue branch's tip, or null when the ref does not exist. Null-on-failure
// ONLY here: a missing branch is data the message should report, not an error.
// The HEAD sha is read with a plain `exec` that throws, because it is the whole
// payload — once the worktree is removed, the sha printed in the handoff comment
// is the only remaining handle on the stranded commits, and degrading it to "an
// unknown commit" would lose the work quietly rather than loudly.
async function branchTip(
  worktreePath: string,
  branch: string,
): Promise<string | null> {
  try {
    const { stdout } = await exec(
      "git",
      ["rev-parse", "--verify", `refs/heads/${branch}`],
      { cwd: worktreePath },
    );
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
  const ref = await headRef(worktreePath);
  if (ref === `refs/heads/${branch}`) return null;
  const [headSha, branchSha] = await Promise.all([
    exec("git", ["rev-parse", "HEAD"], { cwd: worktreePath }),
    branchTip(worktreePath, branch),
  ]);
  return {
    branch,
    headRef: ref,
    headSha: headSha.stdout.trim(),
    branchSha,
  };
}
