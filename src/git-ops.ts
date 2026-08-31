// Thin git wrapper for the inner loop: branch seeding, and the two asserts
// that make a gate verdict a statement about a commit ON THE ISSUE BRANCH —
// `dirtyWorktreePaths` (tree ≡ HEAD, #24 D1) and `headMismatch` (HEAD ≡
// refs/heads/<branch>, #27). Neither is optional and neither implies the other.
//
// One export serves a second caller: `fetchOriginChunkBranch` answers "what is
// this chunk's tip" for the seeding below AND for the merge phase's choice of
// base (`merger.ts`, `chunkBase`). Deliberately one function — the tree a chunk
// member is developed against and the tree it is merged onto have to be the
// same, and two spellings of that question are two chances for them to drift.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { type ChunkTarget, IN_CHUNK_LABEL } from "./chunks.js";
import { issueNumberFromBranch } from "./naming.js";

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

// A chunk member that is not its chunk's root, whose chunk branch the cache can
// name no ref for. Deliberately NOT a `SandbarError`: this is not sandbar's own
// machinery malfunctioning and it is not the run's problem, it is ONE issue
// whose premise no longer holds. The inner loop wraps a plain throw out of
// setup as HARD-ERROR, which costs two futile retries (seeding is the first
// thing a sandbox cycle does, so they are nearly free) and then hands this
// issue to a human while every other issue in the cycle carries on.
export class ChunkBaseMissingError extends Error {
  constructor(
    readonly branch: string,
    readonly chunk: ChunkTarget,
  ) {
    super(
      `${branch} is a chunk member behind #${chunk.root}, but neither origin nor ` +
        `sandbar's object cache has \`${chunk.branch}\` — the branch its blockers' ` +
        `commits are supposed to be on. Seeding it from the source branch would ` +
        `develop it against a tree missing that work (#61), and nothing downstream ` +
        `would reject the result. The usual cause is the chunk RE-ROOTING: close ` +
        `a chunk's root issue and the surviving members re-derive under a new root ` +
        `and so a new branch name, while their commits stay on the old one. Look for ` +
        `a recently closed issue carrying \`${IN_CHUNK_LABEL}\` and reopen it, or ` +
        `land the chunk's real branch and close every member on it — either way the ` +
        `chunk stops being half-visible to sandbar.`,
    );
    this.name = "ChunkBaseMissingError";
  }
}

// Bring `cwd`'s copy of origin's chunk branch up to date and return the
// remote-tracking ref, or null when there is no such ref to name at all.
//
// Origin, every time, and never a LOCAL branch: a chunk branch outlives the run
// that created it and nothing in the state directory is authoritative, so
// `refs/heads/<chunk>` is at best a cache and at worst a stale answer that
// would seed a member on a base missing an earlier one. The refspec is explicit
// (and forced) because a plain `git fetch origin <branch>` writes only
// FETCH_HEAD in a BARE repository, which is what the object cache is.
//
// Shared by the two places that ask (#61): this module, seeding a chunk
// member's issue branch, and the merger, choosing the base to land that member
// on. One function because the two have to agree — a member developed against
// one base and merged onto another is exactly the conflict the by-construction
// property (#54 round-1 Q4) exists to rule out.
//
// A FAILED FETCH IS NOT "NO SUCH BRANCH", and reading it as one was a silent
// hole. Phase 2 runs a layer's members in parallel (`run.ts`), so every member
// of one chunk fetches the SAME refspec into the one bare cache at the same
// instant; when that fetch actually moves the ref, git fails the losers with
//
//     error: cannot lock ref '<remote ref>': is at <new> but expected <old>
//
// — a failure whose own message says the ref now holds exactly the value the
// loser wanted to write. Read as "origin has no such branch" that became a
// fall back to `origin/<sourceBranch>`, i.e. a chained member developed against
// a tree missing its blockers' work, which is the one outcome #61 exists to
// prevent — and unlike the merger's fallback nothing downstream rejects it, so
// the member could merge onto the chunk cleanly while being built on the wrong
// base. Hence the second look: if the ref is THERE, it is the answer, whatever
// the fetch thought. That covers the race (the winner just wrote the current
// tip) and a network or auth failure (the last tip preflight fetched, which a
// chunk branch only ever moves forward from) with one cheap read, and it adds
// nothing to the happy path.
//
// Null therefore means the cache can name no such ref, which is the chunk's
// FIRST landing: no branch on origin and none cached, since preflight prunes
// this namespace at the top of every run. The two callers then base on
// `origin/<sourceBranch>` — for the merger that is the correct creation point
// for a new chunk branch, and for the seeding it is the chunk root's correct
// seed. A branch a human deleted on origin MID-RUN answers null too late to be
// pruned and so keeps answering with the cached tip for the rest of the run;
// that costs nothing extra, because a member seeded from that tip carries the
// old chunk's commits into the landing either way.
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
    // Fall through: what the cache already holds outranks what the fetch said.
  }
  try {
    await exec("git", ["show-ref", "--verify", "--quiet", remoteRef], { cwd });
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
//   - A chunk the cache can name no branch for, AND this issue is that chunk's
//     root → `origin/<sourceBranch>`, which is exactly where the merge phase
//     creates a chunk branch (#60). The two agreeing is what makes the root's
//     landing honest. (Root is one issue, not several — a chunk has exactly ONE
//     parentless member, which is chunks.ts's own argument from the rule that a
//     chunk never grows to accommodate an issue whose blockers straddle two.
//     Two gated issues both blocking a third do not make one chunk with two
//     roots; they stay two chunks and the third is `two-chunk-parent`.) A
//     failed fetch does not land here — see `fetchOriginChunkBranch`.
//
//     What this arm CANNOT tell apart, and the limit of the guard below: a
//     genuine first landing, and a chunk that RE-ROOTED onto this very issue.
//     Close the root of {#10 → #11} once #10 has landed and #11 becomes
//     parentless, so `chunk.branch` is `sandbar/chunk-11-…` — a name nobody has
//     pushed — while #10's commits sit on `sandbar/chunk-10-…`. #11 IS the root
//     of the chunk as derived, the two agree, and it is seeded from the source
//     branch and lands on a fresh chunk branch with #10's work stranded on the
//     old one. Nothing here can see it: `ChunkTarget` carries the root and the
//     branch, and both say "new chunk". The signal that would separate the two
//     — an origin chunk branch whose root issue is now closed — lives in the
//     namespace preflight fetches, not in anything this function is handed, so
//     closing it means threading that namespace into the planner rather than
//     tightening a comparison here. Documented for the host instead, where the
//     lane is chosen (`config.ts`, `defaultLane`, and the README's lane
//     blockquote): don't close one member of a chunk with issues still queued
//     behind it. The guard below covers the members BEHIND the new root, which
//     is the case that has a fact to check.
//   - A chunk the cache can name no branch for, and this issue is NOT its root
//     → `ChunkBaseMissingError`. The ordinary argument says this cannot happen:
//     a non-root member plans only once a blocker of its own carries
//     `in-chunk`, and finalise applies that label only after the chunk branch
//     carrying the commits is on origin. But the branch NAME is derived per
//     cycle from the chunk's current root, and a chunk RE-ROOTS when that root
//     leaves the graph — close it and the planner's two open-only listings
//     (`fetchCandidates`, `fetchChunkMembers`) both drop it, so the survivors
//     re-derive under a new root and `chunk.branch` names a branch nobody has
//     ever pushed. Falling back there is the one outcome #61 exists to prevent,
//     and unlike the merger's identical fallback nothing downstream catches it:
//     the landing CREATES the branch, so there is no non-fast-forward push to
//     be rejected, and the member merges cleanly onto a base its ancestors'
//     commits are absent from. So the fallback is guarded by the very condition
//     that justifies it rather than by a paragraph asserting the condition
//     holds, and one issue with a broken premise goes to a human.
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
    ? await chunkOrSourceBase(repoDir, branch, chunk, sourceBranch)
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
  branch: string,
  chunk: ChunkTarget,
  sourceBranch: string,
): Promise<IssueBranchBase> {
  const ref = await fetchOriginChunkBranch(repoDir, chunk.branch);
  if (ref !== null) return { ref, chunkBranch: chunk.branch };
  // The source-branch fallback is the ROOT'S seed, and this is where that stops
  // being an assumption. `issueNumberFromBranch` reads the number back out of
  // the branch sandbar built from it (naming.ts owns both directions), so the
  // comparison is against the same `chunk.root` the merge phase will land on.
  // An unparseable branch name lands here too, and refuses for the same reason:
  // what cannot be shown to be the root must not be given the root's seed.
  if (issueNumberFromBranch(branch) !== chunk.root) {
    throw new ChunkBaseMissingError(branch, chunk);
  }
  return sourceBranchBase(sourceBranch);
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
