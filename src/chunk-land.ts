// Landing a reviewed chunk on the source branch, and reconciling one that
// landed without sandbar (#64, and §5 of the design in #54).
//
// This is the far end of the review lane. #58 derived the chunk, #60 landed its
// members on `sandbar/chunk-<root>-<slug>` and pushed it, #62 opened the DRAFT
// pull request a human reviews. Everything since then has been true of a chunk
// that never lands: the branch grows, the PR is re-bodied, the members sit OPEN
// under `in-chunk`, and nothing reaches the source branch. This module is what
// closes that loop.
//
// ---------------------------------------------------------------------------
// The trigger is a LABEL on the pull request, not an approval
// ---------------------------------------------------------------------------
//
// A human puts `land` on the chunk's PR and the next run lands it. Approval is
// deliberately NOT the trigger, and the difference is a workflow a reviewer
// actually has: approving says "this code is good", which a reviewer may well
// want to say at 18:00 on a Friday without also saying "put it on main now".
// Separating the two keeps approve-now-land-later available, and it keeps the
// act that moves the source branch an act somebody performed on purpose.
//
// The label is on the PULL REQUEST rather than on an issue because that is
// where the reviewer is standing. They have just read the diff; the issues are
// a click away and there may be five of them, with no one of them obviously
// "the" issue to label. Sandbar already keeps exactly one open PR per chunk
// branch (`forge-pr.ts`), so the PR is a unique handle on the chunk — which an
// issue is not.
//
// `land` is HARDCODED, on the same ground as `AUTO_LAND_LABEL` in `lanes.ts`
// and `IN_CHUNK_LABEL` in `chunks.ts`: the configurable labels (`LabelConfig`)
// name a host's own handoff conventions, and this one is protocol — a human
// addressing sandbar. The SPELLING is declared in `chunks.ts` beside
// `IN_CHUNK_LABEL` and re-exported below: the PR body that invites the label,
// the code that reads it and the code that takes it off again are three
// modules, and finalise names it in prose as well — one declaration is what
// stops those four coming to disagree. (It also keeps the import graph a DAG:
// this module reads finalise's bot prefix, so finalise cannot read a constant
// back out of it.)
//
// The label is also the QUEUE, exactly as `ready-for-agent` is the queue for
// issues, and every failure path below is written from that reading:
//
//   * landed        — the PR is closed, so it can never be re-triggered.
//   * abandoned     — a conflict or a red gate the resolve loop could not fix.
//                     A human has to look, so `land` is REMOVED and the PR
//                     says why: leaving it on would retry the same failing
//                     merge every run, burning a resolve budget per cycle on a
//                     tree nobody has touched.
//   * this cycle    — a push race, a forge verdict that never arrived, a `gh`
//                     that could not be reached. Nothing about the chunk is
//                     wrong, so `land` STAYS and the next run tries again.
//
// ---------------------------------------------------------------------------
// Reconciliation — the same wrap-up, without the merge
// ---------------------------------------------------------------------------
//
// Draft state disables GitHub's merge button; it does not disable a human. A
// reviewer can mark the PR ready and merge it by hand, and #62's `forge-pr.ts`
// deliberately never re-drafts a PR that happened to — that override is
// tolerated, and this is where it is paid for. The identical state arises from
// a crash: the landing push moved the source branch and the run died before it
// could close a single member.
//
// Both look the same from the outside, and the test is a fact about git rather
// than about intent: a chunk branch on origin whose tip is CONTAINED IN
// `origin/<sourceBranch>` has landed, however it got there. Such a chunk gets
// the wrap-up and nothing else — no merge, no gate, no push, because the work
// is already on the source branch and re-merging it would be a no-op at best.
//
// It runs at PLAN time rather than in the merge phase, and that is what makes
// it defense in depth rather than a second landing path: it needs no worktree,
// no gate stack and no merger, so it still runs on a cycle that plans nothing
// and merges nothing — which is exactly the cycle a hand-merged chunk leaves
// behind.
//
// ---------------------------------------------------------------------------
// What the wrap-up does, and the order it does it in
// ---------------------------------------------------------------------------
//
// Close every member explicitly, drop `in-chunk`, close the pull request,
// delete the chunk branch on origin.
//
// EXPLICITLY is the load-bearing word on the first one. GitHub closes an issue
// from a `Closes #N` trailer only when GitHub itself merges the pull request
// carrying it — sandbar composes the merge locally and pushes the result, so no
// trailer would ever fire and a chunk would land with five issues left open.
// The close is sandbar's to make, as it already is for an auto-lane merge.
//
// The label drop follows the close and never precedes it. `in-chunk` is what
// keeps a member out of the planner's queue; an OPEN member that lost the label
// before a failed close is an issue on NO queue at all, which is the #8 failure
// this codebase keeps re-deriving. Closed first, the label is decoration —
// `fetchChunkMembers` lists open issues only — so losing the drop costs
// nothing.
//
// THE BRANCH DELETE IS LAST AND IT IS CONDITIONAL. Deleting it is what stops
// reconciliation firing on this chunk again, so a chunk whose members did not
// all close keeps its branch: the next run finds it contained in the source
// branch, reconciles it again, and retries exactly the writes that failed. That
// is why there is no retry loop here — the retry is the next cycle, which is a
// better one than three `gh` attempts a second apart.
//
// Every failure is collected as RESIDUE rather than thrown. The source branch
// has already moved by the time any of this runs; a throw here would abandon
// the members after the failing one and report a landing that did not finish
// as a landing that did not happen.

import {
  type ChunkMember,
  IN_CHUNK_LABEL,
  LAND_LABEL,
  type NamedChunk,
} from "./chunks.js";
import { BOT_COMMENT_PREFIX } from "./finalize.js";
import { rootIssueFromChunkBranch } from "./naming.js";

// Re-exported because every consumer of this module wants the label and the
// behaviour together, and none of them should have to know the string lives one
// module down. `chunks.ts` owns the spelling; this file owns what it means.
export { LAND_LABEL };

// One chunk that is to be landed on the source branch, or that already has
// been. Built by the two selectors below and consumed by the merge phase and
// the reconciler alike — the wrap-up is the same operation whichever produced
// it.
export type ChunkLandTarget = {
  readonly root: number;
  readonly branch: string;
  // The root issue's title where a member list is known, else the pull
  // request's own title. Names the chunk in the merge commit and in prose.
  readonly title: string;
  // Every member on the branch, ascending. EMPTY is a real answer, not a
  // failure: see `selectLandRequests`.
  readonly members: readonly ChunkMember[];
  // The pull request carrying the chunk. 0 when there is none to act on —
  // a reconciled chunk whose PR a human already closed.
  readonly pullRequest: number;
};

// The fields of an open pull request this module reads. `headRefName` is the
// branch it is FOR, which is the only thing tying a PR to a chunk.
export type PullRequestSummary = {
  readonly number: number;
  readonly headRefName: string;
  readonly title: string;
};

const byRoot = (a: ChunkLandTarget, b: ChunkLandTarget): number =>
  a.root - b.root;

// The open pull request for each chunk branch, lowest number winning. There
// should only ever be one — `ensurePullRequest` finds the open PR for a
// head→base pair before it creates one — but a human can open a second by
// hand, and picking the lowest deterministically beats picking whichever the
// forge listed first.
function pullRequestsByHead(
  prs: readonly PullRequestSummary[],
): ReadonlyMap<string, PullRequestSummary> {
  const byHead = new Map<string, PullRequestSummary>();
  for (const pr of prs) {
    const existing = byHead.get(pr.headRefName);
    if (!existing || pr.number < existing.number) byHead.set(pr.headRefName, pr);
  }
  return byHead;
}

/**
 * The chunks a human has asked to land: one per open pull request carrying
 * `land` whose head is a chunk branch.
 *
 * `chunks` is the plan's derivation, and it is how a request learns its
 * members — the PR names a branch and nothing else, and only the graph knows
 * which issues are on it. A request whose branch matches no derived chunk is
 * still returned, with NO members: the branch exists on origin and a human has
 * asked for it, so refusing would leave them holding a label nothing reads. It
 * lands and its PR closes; what it cannot do is close issues nobody named.
 *
 * A `land` label on a pull request whose head is not a chunk branch is not
 * sandbar's business at all, and is dropped without comment.
 */
export function selectLandRequests(
  prs: readonly PullRequestSummary[],
  chunks: readonly NamedChunk[],
): readonly ChunkLandTarget[] {
  const chunkByBranch = new Map(chunks.map((c) => [c.branch, c] as const));
  const targets: ChunkLandTarget[] = [];
  for (const pr of pullRequestsByHead(prs).values()) {
    const root = rootIssueFromChunkBranch(pr.headRefName);
    if (root === null) continue;
    const chunk = chunkByBranch.get(pr.headRefName);
    targets.push({
      root: chunk?.root ?? root,
      branch: pr.headRefName,
      title: chunk?.title ?? pr.title,
      members: chunk?.members ?? [],
      pullRequest: pr.number,
    });
  }
  return targets.sort(byRoot);
}

/**
 * The chunks that are already on the source branch and still carry the
 * bookkeeping of one that is not.
 *
 * `landedBranches` are origin's chunk branches whose tips are contained in
 * `origin/<sourceBranch>` — the caller asks git, because that is the only
 * source that cannot be lied to by a label. Everything else is the same shape
 * as a land request, and a branch with no derived chunk is again kept rather
 * than dropped: its members are gone or were never there, and deleting a
 * branch whose commits are demonstrably on the source branch is safe on that
 * ground alone.
 *
 * The pull request is optional here. A human who merged by hand may well have
 * closed it already, and a chunk with no open PR still owes its members a
 * close.
 */
export function selectReconciliations(
  landedBranches: readonly string[],
  chunks: readonly NamedChunk[],
  prs: readonly PullRequestSummary[],
): readonly ChunkLandTarget[] {
  const chunkByBranch = new Map(chunks.map((c) => [c.branch, c] as const));
  const prByHead = pullRequestsByHead(prs);
  const targets: ChunkLandTarget[] = [];
  for (const branch of [...new Set(landedBranches)]) {
    const root = rootIssueFromChunkBranch(branch);
    if (root === null) continue;
    const chunk = chunkByBranch.get(branch);
    const pr = prByHead.get(branch);
    targets.push({
      root: chunk?.root ?? root,
      branch,
      title: chunk?.title ?? pr?.title ?? "",
      members: chunk?.members ?? [],
      pullRequest: pr?.number ?? 0,
    });
  }
  return targets.sort(byRoot);
}

// ---------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------

// How the chunk reached the source branch. The wrap-up is identical either way;
// only what it tells a human differs, and telling a reviewer sandbar landed a
// chunk they merged themselves would be a plain lie.
export type LandingProvenance = "sandbar" | "reconciled";

export const CHUNK_MEMBER_CLOSED_COMMENT = (args: {
  readonly chunkBranch: string;
  readonly sourceBranch: string;
  readonly provenance: LandingProvenance;
  // The chunk's OTHER members — the caller drops the issue being commented on.
  // Empty for a chunk of one, which is the common shape today.
  readonly others: readonly ChunkMember[];
}): string => {
  const others = args.others;
  const how =
    args.provenance === "sandbar"
      ? `its review chunk was approved to land (the \`${LAND_LABEL}\` label went on the ` +
        `chunk's pull request), so sandbar merged \`${args.chunkBranch}\` into ` +
        `\`${args.sourceBranch}\`, gated the composition and pushed it`
      : `\`${args.chunkBranch}\` was found already contained in ` +
        `\`${args.sourceBranch}\` — merged by hand, or landed by a run that died ` +
        `before it could reconcile the tracker — so sandbar is finishing the ` +
        `bookkeeping now`;
  return (
    `${BOT_COMMENT_PREFIX} closing this issue: ${how}.\n\n` +
    `A chunk is reviewed and lands as one unit, so this issue closes together ` +
    `with the rest of \`${args.chunkBranch}\`` +
    (others.length > 0
      ? `: ${others.map((m) => `#${m.number}`).join(", ")}`
      : "") +
    `. Its \`${IN_CHUNK_LABEL}\` label is dropped and the chunk branch is deleted ` +
    `— the commits live on \`${args.sourceBranch}\` from here.`
  );
};

export const CHUNK_LANDED_PR_COMMENT = (args: {
  readonly chunkBranch: string;
  readonly sourceBranch: string;
  readonly provenance: LandingProvenance;
  readonly members: readonly ChunkMember[];
}): string => {
  const lines = [
    args.provenance === "sandbar"
      ? `${BOT_COMMENT_PREFIX} landed. \`${args.chunkBranch}\` was merged into ` +
        `\`${args.sourceBranch}\`, the composition passed the gate, and the result ` +
        `is pushed.`
      : `${BOT_COMMENT_PREFIX} reconciled. \`${args.chunkBranch}\` was already ` +
        `contained in \`${args.sourceBranch}\` — merged by hand, or landed by a run ` +
        `that stopped before it finished — so sandbar has done the rest of the ` +
        `bookkeeping.`,
    "",
  ];
  if (args.members.length > 0) {
    lines.push("Issues closed:", "");
    for (const m of args.members) lines.push(`- #${m.number} — ${m.title}`);
  } else {
    lines.push(
      "No open chunk members were found for this branch, so no issue was closed " +
        "here. If any are still open, close them by hand.",
    );
  }
  lines.push(
    "",
    `This pull request is closed rather than merged: its commits reached ` +
      `\`${args.sourceBranch}\` through sandbar's own merge, not through GitHub's ` +
      `merge button, so there is nothing left for it to do. The chunk branch is ` +
      `deleted.`,
  );
  return lines.join("\n");
};

export const CHUNK_LAND_ABANDONED_PR_COMMENT = (args: {
  readonly chunkBranch: string;
  readonly sourceBranch: string;
  readonly mode: "conflict" | "gate-red" | "install-failed";
  readonly reason: string;
  readonly attempts: number;
}): string => {
  const what =
    args.mode === "conflict"
      ? `merging \`${args.chunkBranch}\` into \`${args.sourceBranch}\` conflicted, and ` +
        `the agentic resolve loop bailed after ${args.attempts} attempt${args.attempts === 1 ? "" : "s"}`
      : args.mode === "gate-red"
        ? `\`${args.chunkBranch}\` merged into \`${args.sourceBranch}\` cleanly, but the ` +
          `post-merge gate was still red after ${args.attempts} agentic fix ` +
          `attempt${args.attempts === 1 ? "" : "s"}`
        : `\`${args.chunkBranch}\` merged into \`${args.sourceBranch}\` cleanly, but ` +
          "`npm install` against the merged tree failed, so the post-merge gate " +
          "could not run";
  return (
    `${BOT_COMMENT_PREFIX} this chunk was NOT landed: ${what}.\n\n` +
    (args.reason ? `Agent's reason: ${args.reason}\n\n` : "") +
    `The merge was reverted, nothing reached \`${args.sourceBranch}\`, and the ` +
    `\`${LAND_LABEL}\` label has been removed so the same failing merge is not ` +
    `retried every cycle. The chunk branch and its issues are untouched — fix the ` +
    `collision (most likely by rebuilding on a \`${args.sourceBranch}\` that has ` +
    `since moved) and re-apply \`${LAND_LABEL}\` when it is worth another try.`
  );
};

// Verified merge mode (#22) rejected the cycle's composed result, and this
// chunk's commits were in it. Cycle-level, exactly as for an auto-lane issue:
// the forge judged the whole composition and there is no sound way to blame one
// part of it, so the comment says so rather than telling a reviewer their
// approved chunk is broken.
export const CHUNK_LAND_FORGE_UNVERIFIED_PR_COMMENT = (args: {
  readonly chunkBranch: string;
  readonly sourceBranch: string;
  readonly detail: string;
  readonly siblings: readonly number[];
}): string =>
  `${BOT_COMMENT_PREFIX} this chunk was NOT landed. \`${args.chunkBranch}\` merged ` +
  `into \`${args.sourceBranch}\` cleanly and the post-merge gate passed, but the ` +
  `forge's verification of the cycle's composed result did not — so nothing was ` +
  `landed on \`${args.sourceBranch}\` and the merge was reverted.\n\n` +
  `Verification failure: ${args.detail}\n\n` +
  (args.siblings.length > 0
    ? `The forge judged this chunk together with ${args.siblings
        .map((n) => `#${n}`)
        .join(", ")}, so the failure is not necessarily this chunk's. ` +
      "Those were reverted and parked too.\n\n"
    : "") +
  `The \`${LAND_LABEL}\` label has been removed. Nothing about the chunk changed — ` +
  `re-apply it once the composition has a reason to pass.`;

export const CHUNK_BRANCH_MISSING_PR_COMMENT = (args: {
  readonly chunkBranch: string;
}): string =>
  `${BOT_COMMENT_PREFIX} this pull request is labelled \`${LAND_LABEL}\`, but origin ` +
  `has no \`${args.chunkBranch}\` to land — the branch is gone. Nothing was merged ` +
  `and the \`${LAND_LABEL}\` label has been removed. If the work landed some other ` +
  `way, close this pull request and its issues by hand; if the branch was deleted ` +
  `by mistake, it is recoverable only from a clone that still has it.`;

// ---------------------------------------------------------------------------
// The wrap-up
// ---------------------------------------------------------------------------

// The tracker and forge writes the wrap-up needs. A structural subset of
// `MergerAdapter`, so the merge phase passes itself; the reconciler builds its
// own against the same shape.
export type ChunkWrapupAdapter = {
  closeIssue(issueNum: number, comment: string): Promise<void>;
  removeLabel(issueNum: number, label: string): Promise<void>;
  commentOnPullRequest(pr: number, body: string): Promise<void>;
  closePullRequest(pr: number): Promise<void>;
  deleteChunkBranch(chunkBranch: string): Promise<void>;
};

export type ChunkWrapupResult = {
  // Members actually closed, ascending.
  readonly closed: readonly number[];
  // True iff the chunk branch was deleted on origin — which is also "this
  // chunk is fully reconciled and will not be seen again".
  readonly branchDeleted: boolean;
  // Everything that failed, one operator-readable line each. Non-empty means
  // the branch was KEPT and the next run reconciles the remainder.
  readonly residue: readonly string[];
};

const detail = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Close the chunk out: members, labels, pull request, branch.
 *
 * Never throws. The source branch has already moved by the time this runs, so
 * every failure is residue the caller reports; see the header for the order and
 * for why the branch delete is conditional on the closes having worked.
 */
export async function wrapUpLandedChunk(
  target: ChunkLandTarget,
  adapter: ChunkWrapupAdapter,
  opts: {
    readonly sourceBranch: string;
    readonly provenance: LandingProvenance;
    readonly log?: (line: string) => void | Promise<void>;
  },
): Promise<ChunkWrapupResult> {
  const log = opts.log ?? ((): void => undefined);
  const residue: string[] = [];
  const closed: number[] = [];

  for (const member of target.members) {
    try {
      await adapter.closeIssue(
        member.number,
        CHUNK_MEMBER_CLOSED_COMMENT({
          chunkBranch: target.branch,
          sourceBranch: opts.sourceBranch,
          provenance: opts.provenance,
          others: target.members.filter((m) => m.number !== member.number),
        }),
      );
      closed.push(member.number);
    } catch (err) {
      residue.push(
        `#${member.number} could not be closed after ${target.branch} landed: ${detail(err)}`,
      );
      // The label stays with the issue that could not close. Dropping it here
      // would leave an OPEN member on no queue at all — see the header.
      continue;
    }
    try {
      await adapter.removeLabel(member.number, IN_CHUNK_LABEL);
    } catch (err) {
      // Benign, and said so: `fetchChunkMembers` lists OPEN issues, so a
      // closed one carrying the label is invisible to the planner either way.
      residue.push(
        `#${member.number} is closed but kept its \`${IN_CHUNK_LABEL}\` label (harmless): ${detail(err)}`,
      );
    }
  }
  await log(
    `chunk ${target.branch}: closed ${closed.length}/${target.members.length} member(s)`,
  );

  if (target.pullRequest > 0) {
    try {
      await adapter.commentOnPullRequest(
        target.pullRequest,
        CHUNK_LANDED_PR_COMMENT({
          chunkBranch: target.branch,
          sourceBranch: opts.sourceBranch,
          provenance: opts.provenance,
          members: target.members,
        }),
      );
      await adapter.closePullRequest(target.pullRequest);
      await log(`chunk ${target.branch}: closed PR #${target.pullRequest}`);
    } catch (err) {
      residue.push(
        `the pull request #${target.pullRequest} for ${target.branch} could not be closed: ${detail(err)}`,
      );
    }
  }

  // Conditional, and the condition is the members rather than the pull
  // request: keeping the branch is what makes the next run reconcile this
  // chunk again, and a member left OPEN under `in-chunk` is the one residue
  // worth another attempt. A PR that would not close is cosmetic by
  // comparison, and a branch kept for it would re-run the whole wrap-up every
  // cycle forever.
  const closesComplete = closed.length === target.members.length;
  let branchDeleted = false;
  if (closesComplete) {
    try {
      await adapter.deleteChunkBranch(target.branch);
      branchDeleted = true;
      await log(`chunk ${target.branch}: deleted on origin`);
    } catch (err) {
      residue.push(
        `the chunk branch ${target.branch} is landed but could not be deleted on origin: ${detail(err)}`,
      );
    }
  } else {
    residue.push(
      `${target.branch} is kept on origin so the next run retries the ${
        target.members.length - closed.length
      } member(s) it could not close`,
    );
  }

  return { closed: [...closed].sort((a, b) => a - b), branchDeleted, residue };
}
