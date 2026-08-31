// Thin git wrapper for the inner loop: branch seeding, and the two asserts
// that make a gate verdict a statement about a commit ON THE ISSUE BRANCH —
// `dirtyWorktreePaths` (tree ≡ HEAD, #24 D1) and `headMismatch` (HEAD ≡
// refs/heads/<branch>, #27). Neither is optional and neither implies the other.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ChunkTarget } from "./chunks.js";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Where an issue branch comes from (#61)
// ---------------------------------------------------------------------------
//
// One value, two consumers, and they MUST be the same answer: the ref the issue
// branch is seeded from, and the ref every range in the agents' prompts is
// anchored at (#40, prompt.ts). Split them and the implementer is shown a diff
// measured against a tree its branch was never cut from — for a chunk member
// that is the whole chunk arriving as "your work", which is the failure mode
// #61 names. `ensureIssueBranch` therefore RETURNS the base it used rather than
// leaving each caller to re-derive one.
export type IssueBranchBase = {
  // What to pass to git: `origin/<sourceBranch>`, or the remote-tracking ref of
  // a chunk branch. Always a ref that resolves in the bare cache — never a bare
  // branch name, which the cache's local head namespace does not hold (#40).
  readonly ref: string;
  // The chunk branch `ref` is the tip of, when it is one. Null for the source
  // branch — an auto-lane issue, a chunk's root, or a chunk whose branch origin
  // does not carry yet. The prompt layer reads this to tell the agent that the
  // work under its feet is a chunk's rather than the source branch's.
  readonly chunkBranch: string | null;
};

export function sourceBranchBase(sourceBranch: string): IssueBranchBase {
  return { ref: `origin/${sourceBranch}`, chunkBranch: null };
}

// Fetch ORIGIN's copy of a chunk branch into `cwd`'s object store and return
// the remote-tracking ref, or null when origin has no such branch.
//
// Origin, every time, and never a local ref: a chunk branch outlives the run
// that created it and nothing in the state directory is authoritative, so a
// local copy is at best a cache and at worst a stale answer that would seed a
// member on a base missing an earlier one. The refspec is explicit (and forced)
// because a plain `git fetch origin <branch>` writes only FETCH_HEAD in a BARE
// repository, which is what the object cache is.
//
// Shared by the two places that ask (#61): this module, seeding a chunk
// member's issue branch, and the merger, choosing the base to land that member
// on. One function because the two have to agree — a member developed against
// one base and merged onto another is exactly the conflict the by-construction
// property (#54 round-1 Q4) exists to rule out.
//
// Null is TWO answers wearing one hat: origin has no such branch, and the fetch
// failed for some other reason (network, auth). Both callers read it as the
// first and fall back to the source branch, and the two do not pay the same
// price for that. For the merger it is genuinely safe — a composition based on
// the source branch is rejected as non-fast-forward on push rather than
// overwriting the chunk. For the seeding here it is merely LOUD: a chained
// member developed on a tree missing its blockers' work is what #61 exists to
// prevent, and what it costs is an implementer budget spent against the wrong
// base, ending in a conflicting chunk merge that the resolve loop or a human
// then untangles. Nothing lands wrongly either way, which is why the two share
// one function; telling the readings apart (an extra `ls-remote`, or stderr
// matching) buys a better error message for a case in which `gh` and podman are
// failing too.
export async function fetchOriginChunkBranch(
  cwd: string,
  chunkBranch: string,
): Promise<string | null> {
  const remoteRef = `refs/remotes/origin/${chunkBranch}`;
  try {
    await exec(
      "git",
      ["fetch", "origin", `+refs/heads/${chunkBranch}:${remoteRef}`, "--quiet"],
      { cwd },
    );
    return remoteRef;
  } catch {
    return null;
  }
}

// Create the issue's branch if it doesn't already exist, and report the base it
// is measured against either way. Seeding from origin (not a local branch) means
// a per-issue worktree never inherits in-progress state from the host's working
// tree — sandbar can run while the user is mid-edit on cwd. Existing branches
// keep their accumulated commits (resumed runs); we only pre-create when
// missing, and the base is computed BEFORE that check so a resumed branch and a
// fresh one report the same anchor.
//
// `repoDir` is explicit for the same reason preflight's is (#34): every other
// function in this module is handed a worktree path, and this one — the only
// one that WRITES a ref — was the one running wherever the host process was
// launched. On a host that sets `config.cwd`, that created the issue branch in
// a different repo from the one the worktree, the gate and the merger all
// operate on, so `prepareWorktree` then failed to find a branch that had just
// been created successfully. Since #38 it is `layout.repoDir`, the bare cache —
// which is also why writing this ref cannot reach the operator's own branches.
//
// TWO SEEDS since #61, and which one an issue gets is decided by the `chunk`
// the planner attached to it (`PlannedIssue.chunk`), never re-derived here:
//
//   - No chunk (the auto lane) → `origin/<sourceBranch>`, as it always was.
//   - A chunk whose branch is on ORIGIN → that branch's tip. This is the
//     chained member (#61): its blocker's commits live on the chunk branch and
//     nowhere else, so seeding from the source branch would develop it against
//     a tree missing the very work it declares itself blocked by. Seeded from
//     the tip, its commits sit on top of every ancestor's, so the chunk-merge
//     of it cannot conflict with them (#54 round-1 Q4) — an UNRELATED member of
//     the same chunk still can, and that stays the resolve loop's job.
//   - A chunk whose branch origin does not have yet → `origin/<sourceBranch>`,
//     which is exactly where the merge phase creates a chunk branch (#60). That
//     is the chunk's ROOT, and the two agreeing is what makes its landing
//     honest. A non-root member cannot reach this case where "does not have
//     yet" is the truth: it plans only once a blocker of its own carries
//     `in-chunk`, and finalise applies that label only after the chunk branch
//     carrying the commits is on origin. It CAN reach it on a failed fetch,
//     which answers the same null — see `fetchOriginChunkBranch` for what that
//     costs and why it is not told apart.
//
// The residual, stated rather than engineered around: a member whose commits
// are ALREADY on the chunk branch while its issue still reads `ready-for-agent`
// — the window a run leaves behind if it dies between the chunk push and the
// label flip — is re-planned and seeded from a tip that already contains it, so
// its diff slot renders empty. That window ends in a loud halt (finalise's
// `requireChunkFlip`) and an operator, and the alternative reading (seed from
// the source branch) would develop the retry against a tree the chunk has
// already moved past, which is worse.
export async function ensureIssueBranch(
  repoDir: string,
  branch: string,
  sourceBranch: string,
  chunk?: ChunkTarget | null,
): Promise<IssueBranchBase> {
  const base = chunk
    ? await chunkOrSourceBase(repoDir, chunk, sourceBranch)
    : sourceBranchBase(sourceBranch);
  try {
    await exec(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: repoDir },
    );
    return base; // exists
  } catch {
    // fall through
  }
  // --no-track: don't write upstream config (a) we never `git pull` these
  // branches and (b) parallel `git branch` calls race on `.git/config`.
  await exec("git", ["branch", "--no-track", branch, base.ref], {
    cwd: repoDir,
  });
  return base;
}

async function chunkOrSourceBase(
  repoDir: string,
  chunk: ChunkTarget,
  sourceBranch: string,
): Promise<IssueBranchBase> {
  const ref = await fetchOriginChunkBranch(repoDir, chunk.branch);
  return ref === null
    ? sourceBranchBase(sourceBranch)
    : { ref, chunkBranch: chunk.branch };
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
