// Landing a reviewed chunk on the source branch, and reconciling one that
// landed without sandbar (#64, and §5 of the design in #54).
//
// This is the far end of the review lane. #58 derived the chunk, #60 landed its
// members on `sandbar/chunk-<root>-<slug>` and pushed it, #62 opened the DRAFT
// pull request a human reviews. Everything since then has been true of a chunk
// that never lands: the branch grows, the PR is re-bodied, the members sit OPEN
// under `needs-review`, and nothing reaches the source branch. This module is what
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
// and `NEEDS_REVIEW_LABEL` in `chunks.ts`: the configurable labels (`LabelConfig`)
// name a host's own handoff conventions, and this one is protocol — a human
// addressing sandbar. The SPELLING is declared in `chunks.ts` beside
// `NEEDS_REVIEW_LABEL` and re-exported below: the PR body that invites the label,
// the code that reads it and the code that takes it off again are three
// modules, and finalise names it in prose as well — one declaration is what
// stops those four coming to disagree. (It also keeps the import graph a DAG:
// this module reads finalise's bot prefix, so finalise cannot read a constant
// back out of it.)
//
// The label is also the QUEUE, exactly as `ready-for-agent` is the queue for
// issues, and every failure path below is written from that reading:
//
//   * landed        — the label comes OFF and the PR is closed, so it can
//                     never be re-triggered. Both, because either alone can
//                     fail: a `land` still sitting on a pull request that
//                     would not close costs the next cycle a whole merger
//                     worktree and gate-stack bringup to discover the branch
//                     is gone, and answers with prose about a branch somebody
//                     deleted — alarming, for the most routine outcome there
//                     is.
//   * abandoned     — a conflict or a red gate the resolve loop could not fix.
//                     A human has to look, so `land` is REMOVED and the PR
//                     says why: leaving it on would retry the same failing
//                     merge every run, burning a resolve budget per cycle on a
//                     tree nobody has touched.
//   * this cycle    — a push race, a forge verdict that never arrived, a `gh`
//                     or an origin that could not be reached. Nothing about
//                     the chunk is wrong, so `land` STAYS and the next run
//                     tries again. The sharp edge there is that an unreachable
//                     origin LOOKS like the abandoned bucket's neighbour, a
//                     chunk branch that is genuinely gone; `merger.ts` buys
//                     the difference with a second question rather than
//                     guessing (`ChunkRefLookup`), because guessing wrong
//                     spends a label a human applied.
//   * deferred      — the same cycle put ANOTHER member's work on the chunk
//                     branch (#61 plans a whole layer at a time, so a chunk
//                     grows while a request is outstanding). Landing then
//                     would put commits on the source branch that the pull
//                     request did not carry when a human labelled it — the
//                     one thing the review lane exists to prevent — and would
//                     close nothing for them, since the plan's member list was
//                     read before the layer landed and the branch delete would
//                     take their recovery point with it. So `land` STAYS, the
//                     PR says what arrived, and the cycle that adds nothing
//                     new lands the chunk as reviewed.
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
// Close every member explicitly, drop `needs-review`, take `land` back off the
// pull request, close it, delete the chunk branch on origin.
//
// "EVERY MEMBER" MEANS EVERY MEMBER ON THE BRANCH, and that is narrower than
// every member of the chunk. The list arrives already filtered —
// `LandedChunk.members` is the git-derived branch members and nothing else — because a
// chunk grows one LAYER per cycle (#61), so a chunk of three sitting under
// review with one layer landed and the rest still queued is its ordinary
// shape, and closing the queued issues would destroy them while telling a
// human their commits had landed. Whatever this is handed, it closes; the
// filtering argument lives with the list, in `chunks.ts`.
//
// AN EMPTY LIST IS NOT THE SAME CLAIM as a list that all closed, and the branch
// delete below cannot tell them apart — "every member closed" is vacuously true
// of no members. It deletes either way, and that is deliberate: the commits are
// demonstrably on the source branch by then, so the branch is not a recovery
// point for anything, and KEEPING it would make the reconciler pick the same
// chunk up every cycle forever, name nothing again, and never resolve. What it
// costs is the one case where the emptiness is wrong — a missing or manually
// deleted origin issue ref that no longer records a member — where the issue is left OPEN,
// off the queue, with no branch left for anything to retry from. That is why
// both the pull request and the orchestrator's console SAY the list was empty
// rather than reporting a clean landing: it is the only thing that can be done
// about it here, and a human reading either can close the issue in one click.
//
// THE MEMBERS ARE CLOSED IN DEPENDENCY ORDER — dependents first, the root last
// — AND THE LOOP STOPS AT THE FIRST FAILURE. Both halves are about what the
// branch means to the NEXT cycle, and neither is about this one.
//
// A wrap-up that could not close every member keeps the chunk branch, and the
// promise made to a human on the strength of that (below, and in
// `CHUNK_LANDED_PR_COMMENT`) is that the next cycle's reconciler finds the
// branch and retries exactly the closes that failed. The reconciler matches a
// branch to a chunk BY NAME, and the name is `sandbar/chunk-<root>-<slug>` —
// derived every cycle from the queue plus the issues named by fetched chunk
// history. Closing the root therefore no longer removes it immediately, but
// dependents-first remains the recovery-safe order: if history is repaired,
// lost, or the root is closed manually before a later run, every member left
// open still includes the root and re-derives the same branch name.
//
// Closing dependents first and stopping leaves a set that cannot degrade that
// way: everything still open is the failed member plus every member it is
// built on top of, the root included, so the chunk re-derives under the same
// root, on the same branch, carrying exactly those members. `closeOrder` is
// computed by the derivation (`chunks.ts`), which is the only thing that has
// the edges, and its comment carries the argument in full.
//
// EXPLICITLY is the load-bearing word on the first one. GitHub closes an issue
// from a `Closes #N` trailer only when GitHub itself merges the pull request
// carrying it — sandbar composes the merge locally and pushes the result, so no
// trailer would ever fire and a chunk would land with five issues left open.
// The close is sandbar's to make, as it already is for an auto-lane merge.
//
// The display-label drop follows the close. Membership is already irrelevant
// once the issue is closed, so losing the drop is harmless decoration.
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
// as a landing that did not happen. Residue is not one kind of thing, though,
// and a caller must not report it as one — `chunkResidue` at the bottom of
// this file is the split and owns that argument.
//
// ---------------------------------------------------------------------------
// One implementation of the wrap-up's writes, for both callers
// ---------------------------------------------------------------------------
//
// The wrap-up is adapter-driven, and its two callers sit at opposite ends of a
// cycle: the merge phase passes itself (`MergerAdapter` is a superset of
// `ChunkWrapupAdapter`), and the plan-time reconciler has no merger to pass.
// What they need done is nevertheless the same five `gh` calls and one
// `git push --delete`, so `chunkForgeWrites` below is the one place that argv
// is spelled — the same argument `forge-pr.ts` makes one level up (#62).
// Duplicated argv is argv that drifts, and this argv CLOSES ISSUES.
//
// Exactly one thing differs between the two, and it is therefore the one
// parameter: the checkout `git push --delete` runs in. The merger's is its
// ephemeral worktree; the reconciler's is the bare cache, which at plan time is
// the only thing that exists. Neither passes a cwd to `gh` — with `--repo`
// given, gh never looks at a git remote (#34), so there is no directory left
// for one of them to be wrong about.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  type ChunkMember,
  NEEDS_REVIEW_LABEL,
  LAND_LABEL,
  type LandedChunk,
} from "./chunks.js";
import { SandbarError } from "./errors.js";
import { BOT_COMMENT_PREFIX } from "./finalize.js";
import {
  ORIGIN_ISSUE_BRANCH_REFGLOBS,
  issueNumberFromBranch,
  rootIssueFromChunkBranch,
} from "./naming.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";
import {
  type ResolveAttemptSummary,
  formatConflictPaths,
  formatResolveAttempts,
} from "./resolve-loop.js";

const exec = promisify(execFile);

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
  // The members whose work is ON the branch, ascending — the git-derived ones,
  // which is what `LandedChunk.members` carries and why it is filtered there.
  // This list is what the wrap-up CLOSES, so a component member that has never
  // been worked must not be in it. EMPTY is a real answer, not a failure: see
  // `selectLandRequests`.
  readonly members: readonly ChunkMember[];
  // The same members in the order they must be closed — dependents before
  // blockers, root last. `LandedChunk.closeOrder` owns the argument for why a
  // landing may not close them in any other order, and why it stops at the
  // first failure.
  readonly closeOrder: readonly ChunkMember[];
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

// One branch, whatever is known about it, as a landing target — or null when
// the branch is not a chunk's at all and neither selector wants it.
//
// The two selectors differ only in where their branches come from and in which
// of `chunk`/`pr` can be missing; what a target IS is this. `root` prefers the
// derivation's over the branch name's (they agree, but the derivation is the
// authority on its own chunk), and both fall back the same way, so a branch
// with neither a chunk nor a pull request still yields a target — which is a
// case both selectors want and for reasons written on each.
function targetFor(
  branch: string,
  chunk: LandedChunk | undefined,
  pr: PullRequestSummary | undefined,
): ChunkLandTarget | null {
  const root = rootIssueFromChunkBranch(branch);
  if (root === null) return null;
  return {
    root: chunk?.root ?? root,
    branch,
    title: chunk?.title ?? pr?.title ?? "",
    members: chunk?.members ?? [],
    closeOrder: chunk?.closeOrder ?? [],
    pullRequest: pr?.number ?? 0,
  };
}

const isTarget = (t: ChunkLandTarget | null): t is ChunkLandTarget => t !== null;

/**
 * The chunks a human has asked to land: one per open pull request carrying
 * `land` whose head is a chunk branch.
 *
 * `chunks` is the plan's derivation, and it is how a request learns its
 * members — the PR names a branch and nothing else, and only the graph knows
 * which issues are on it, and which of those have actually landed on it. A
 * request whose branch matches no derived chunk is still returned, with NO
 * members: the branch exists on origin and a human has asked for it, so
 * refusing would leave them holding a label nothing reads. It lands and its PR
 * closes; what it cannot do is close issues nobody named.
 *
 * A `land` label on a pull request whose head is not a chunk branch is not
 * sandbar's business at all, and is dropped without comment.
 */
export function selectLandRequests(
  prs: readonly PullRequestSummary[],
  chunks: readonly LandedChunk[],
): readonly ChunkLandTarget[] {
  const chunkByBranch = new Map(chunks.map((c) => [c.branch, c] as const));
  return [...pullRequestsByHead(prs).values()]
    .map((pr) => targetFor(pr.headRefName, chunkByBranch.get(pr.headRefName), pr))
    .filter(isTarget)
    .sort(byRoot);
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
  chunks: readonly LandedChunk[],
  prs: readonly PullRequestSummary[],
): readonly ChunkLandTarget[] {
  const chunkByBranch = new Map(chunks.map((c) => [c.branch, c] as const));
  const prByHead = pullRequestsByHead(prs);
  return [...new Set(landedBranches)]
    .map((branch) => targetFor(branch, chunkByBranch.get(branch), prByHead.get(branch)))
    .filter(isTarget)
    .sort(byRoot);
}

// ---------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------

// How the chunk reached the source branch. The wrap-up is identical either way;
// only what it tells a human differs, and telling a reviewer sandbar landed a
// chunk they merged themselves would be a plain lie.
export type LandingProvenance = "sandbar" | "reconciled";

// Written inside the member loop, so it knows less than anything else here:
// the closes after this one have not been attempted and the branch delete is
// gated on all of them. It therefore says what will be true of the branch
// EVENTUALLY ("retired once every issue on it has closed") rather than claiming
// a delete it cannot see — the reviewer's own copy of that sentence lives on
// the pull request, where the answer is known.
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
    `. Its \`${NEEDS_REVIEW_LABEL}\` label is dropped — the commits live on ` +
    `\`${args.sourceBranch}\` from here, and the chunk branch is retired once every ` +
    `issue on it has closed.`
  );
};

// Written AFTER the member loop and BEFORE the branch delete, which is what
// bounds what it may say. The closes have happened, so it reports them rather
// than reciting the target's member list — a comment that said "#42, #43 closed"
// while #43 was still open would be the exact class of claim #60 had to go back
// and unpick. The delete has NOT happened, and cannot be moved earlier: GitHub
// closes a pull request when its head branch is deleted, so deleting first
// would race this comment onto a PR that closed itself and make the `gh pr
// close` below an error. So the branch is described as what is about to be
// done, and only when the closes that gate it all worked.
export const CHUNK_LANDED_PR_COMMENT = (args: {
  readonly chunkBranch: string;
  readonly sourceBranch: string;
  readonly provenance: LandingProvenance;
  // The members that actually closed, and the ones that did not. Together they
  // are the target's member list; apart, they are the only two things this
  // comment is entitled to say about it.
  readonly closed: readonly ChunkMember[];
  readonly unclosed: readonly ChunkMember[];
}): string => {
  const list = (ms: readonly ChunkMember[]): string[] =>
    ms.map((m) => `- #${m.number} — ${m.title}`);
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
  if (args.closed.length > 0) {
    lines.push("Issues closed:", "", ...list(args.closed));
  } else if (args.unclosed.length === 0) {
    lines.push(
      "No open chunk members were found for this branch, so no issue was closed " +
        "here. If any are still open, close them by hand.",
    );
  }
  if (args.unclosed.length > 0) {
    // The one thing a reviewer standing here can act on immediately, so it is
    // named issue by issue rather than summarised.
    lines.push(
      "",
      "Still OPEN — sandbar stopped at the first issue it could not close, so " +
        "this is that one and everything the rest of the chunk is built on top " +
        `of. They keep their \`${NEEDS_REVIEW_LABEL}\` label, so they stay off the ` +
        "agent queue:",
      "",
      ...list(args.unclosed),
      "",
      `\`${args.chunkBranch}\` is KEPT on origin because of them: the next run finds ` +
        `it already contained in \`${args.sourceBranch}\` and retries exactly these ` +
        `closes. Closing them all by hand is just as good — the branch retires ` +
        `either way, once nothing on it is open.`,
    );
  } else {
    lines.push("", "The chunk branch is being deleted.");
  }
  lines.push(
    "",
    `This pull request is closed rather than merged: its commits reached ` +
      `\`${args.sourceBranch}\` through sandbar's own merge, not through GitHub's ` +
      `merge button, so there is nothing left for it to do.`,
  );
  return lines.join("\n");
};

export const CHUNK_LAND_ABANDONED_PR_COMMENT = (args: {
  readonly chunkBranch: string;
  readonly sourceBranch: string;
  readonly mode: "conflict" | "gate-red" | "install-failed";
  readonly reason: string;
  // The resolve loop's own journal (#67), and the paths it was still stuck on.
  // Empty for `install-failed`, which never reaches the loop — so the comment
  // renders no attempt list rather than an empty heading. A reviewer has to
  // tell a genuine collision from a container that died at startup exactly as
  // an issue's author does, which is why this is the same block `merger.ts`
  // puts on an issue.
  readonly attempts: readonly ResolveAttemptSummary[];
  readonly conflictPaths: readonly string[];
}): string => {
  const what =
    args.mode === "conflict"
      ? `merging \`${args.chunkBranch}\` into \`${args.sourceBranch}\` conflicted, and ` +
        `the agentic resolve loop bailed after ${args.attempts.length} attempt${args.attempts.length === 1 ? "" : "s"}`
      : args.mode === "gate-red"
        ? `\`${args.chunkBranch}\` merged into \`${args.sourceBranch}\` cleanly, but the ` +
          `post-merge gate was still red after ${args.attempts.length} agentic fix ` +
          `attempt${args.attempts.length === 1 ? "" : "s"}`
        : `\`${args.chunkBranch}\` merged into \`${args.sourceBranch}\` cleanly, but ` +
          "`npm install` against the merged tree failed, so the post-merge gate " +
          "could not run";
  const paths = formatConflictPaths(args.conflictPaths);
  return (
    `${BOT_COMMENT_PREFIX} this chunk was NOT landed: ${what}.\n\n` +
    (args.reason ? `Agent's reason: ${args.reason}\n\n` : "") +
    (paths ? `${paths}\n\n` : "") +
    (args.attempts.length > 0
      ? `**What each attempt did:**\n${formatResolveAttempts(args.attempts)}\n\n`
      : "") +
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

// The chunk grew in the very cycle it was asked to land (#61 + #64). Nothing
// was merged and the label is untouched — this comment exists because a human
// asked for something and did not get it, and the pull request is where they
// asked.
export const CHUNK_LAND_DEFERRED_PR_COMMENT = (args: {
  readonly chunkBranch: string;
  readonly sourceBranch: string;
  // What this cycle put on the branch after the request was read.
  readonly landedNow: readonly ChunkMember[];
}): string =>
  `${BOT_COMMENT_PREFIX} this chunk is labelled \`${LAND_LABEL}\`, and it was NOT ` +
  `landed this cycle: sandbar had just put more of it on \`${args.chunkBranch}\` — ` +
  args.landedNow.map((m) => `#${m.number} — ${m.title}`).join(", ") +
  `.\n\nMerging now would move commits onto \`${args.sourceBranch}\` that this pull ` +
  `request did not carry when you labelled it, which is the one thing the review ` +
  `lane exists to prevent. Nothing was merged and the \`${LAND_LABEL}\` label is ` +
  `untouched: the description above now lists the new work, and the next cycle ` +
  `that adds nothing further lands the chunk. Take the label off if you would ` +
  `rather look again first.`;

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
  // Takes `land` back off. Used by the wrap-up on the way to closing the pull
  // request, and by the merge phase on its own to park a chunk that would not
  // merge — the label is the queue either way.
  removePullRequestLabel(pr: number, label: string): Promise<void>;
  closePullRequest(pr: number): Promise<void>;
  deleteChunkBranch(
    chunkBranch: string,
    memberIssues: readonly number[],
  ): Promise<void>;
};

/**
 * The one implementation of those writes — see the header for why there is
 * exactly one, and why `gitCwd` is its only parameter.
 *
 * Every method throws on failure rather than swallowing. That is not in tension
 * with `wrapUpLandedChunk` never throwing: the wrap-up is what catches these
 * and turns them into residue, and it can only do that if they are raised.
 */
export function chunkForgeWrites(deps: {
  readonly repo: RepoRef;
  // The checkout `git push --delete` runs in. The `gh` calls get no cwd.
  readonly gitCwd: string;
  // Which layer a failure is reported as — `merger` or `reconcile`. The two
  // callers are a whole cycle apart, and the residue an operator reads is the
  // only thing that says which of them was standing there.
  readonly errPrefix: string;
}): ChunkWrapupAdapter {
  // Read per call, not once at construction. `realAdapter` is built for its git
  // primitives alone in places that have no tracker to name (merger-git's
  // real-repository tests are the standing example), and making the factory
  // throw there would move a `gh` concern into a `git` one.
  const slug = (): string => repoSlug(deps.repo);
  const wrap = (what: string, err: unknown): SandbarError =>
    new SandbarError(
      `${deps.errPrefix}: ${what}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  const gh = async (args: readonly string[], what: string): Promise<void> => {
    try {
      await exec("gh", [...args]);
    } catch (err) {
      throw wrap(what, err);
    }
  };
  return {
    // Throws on a single failed attempt, and both callers layer their own
    // policy over that: the merger's auto-lane close loop retries with backoff
    // and records `MergerSummary.unclosed` (#14), while the chunk wrap-up
    // records residue and KEEPS the chunk branch so the next run retries.
    closeIssue: (n, comment) =>
      gh(
        ["issue", "close", String(n), "--repo", slug(), "--comment", comment],
        `failed to close issue #${n} after its work landed`,
      ),
    // Required, never best-effort: this is the #8 bug's shape. A label silently
    // not dropped leaves whatever it queues on that queue forever.
    removeLabel: (n, label) =>
      gh(
        ["issue", "edit", String(n), "--repo", slug(), "--remove-label", label],
        `failed to remove label '${label}' from issue #${n}`,
      ),
    commentOnPullRequest: (pr, body) =>
      gh(
        ["pr", "comment", String(pr), "--repo", slug(), "--body", body],
        `failed to comment on pull request #${pr}`,
      ),
    // The twin of `removeLabel`'s #8 argument, one level up: `land` is the
    // chunk's queue, so silently failing to drop it retries the same request
    // every cycle.
    removePullRequestLabel: (pr, label) =>
      gh(
        ["pr", "edit", String(pr), "--repo", slug(), "--remove-label", label],
        `failed to remove label '${label}' from pull request #${pr}`,
      ),
    // Closed, never merged: the commits reached the source branch through
    // sandbar's own push, so there is nothing for GitHub's merge to do — and
    // the PR is a DRAFT, which has no merge available anyway (#62).
    // `--delete-branch` is deliberately not passed: the branch delete is the
    // wrap-up's own last step and it is conditional on every member having
    // closed, which this call cannot know.
    closePullRequest: (pr) =>
      gh(
        ["pr", "close", String(pr), "--repo", slug()],
        `failed to close pull request #${pr}`,
      ),
    async deleteChunkBranch(chunkBranch, memberIssues) {
      // Fully qualified, and not `--force`-anything: `git push --delete` has no
      // force to give. It is safe on the one precondition every caller
      // establishes first — the branch's commits are contained in
      // `origin/<sourceBranch>`, so nothing is lost with the ref.
      try {
        const { stdout } = await exec(
          "git",
          ["for-each-ref", "--format=%(refname)", ...ORIGIN_ISSUE_BRANCH_REFGLOBS],
          { cwd: deps.gitCwd },
        );
        const wanted = new Set(memberIssues);
        const issueRefs = stdout.split("\n").flatMap((ref) => {
          const number = issueNumberFromBranch(ref.trim());
          return number !== null && wanted.has(number)
            ? [ref.trim().replace(/^refs\/remotes\/origin\//, "refs/heads/")]
            : [];
        });
        await exec(
          "git",
          [
            "push",
            "--atomic",
            "origin",
            "--delete",
            `refs/heads/${chunkBranch}`,
            ...issueRefs,
          ],
          { cwd: deps.gitCwd },
        );
      } catch (err) {
        throw wrap(
          `failed to delete the landed chunk branch ${chunkBranch} on origin`,
          err,
        );
      }
    },
  };
}

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

// One chunk that has been through the wrap-up, named. The result alone says
// what happened and not to what, and both callers had to attach the target
// back — under two different field names, for one object that reaches one
// reporting path in `run.ts`. It is spelled here instead, beside the wrap-up
// that produces the result half.
export type ChunkWrapup = ChunkWrapupResult & {
  readonly target: ChunkLandTarget;
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
  // Swallowed, unlike everything else here. The caller in the merge phase logs
  // through a sink that THROWS once the source branch has moved (`merger.ts`
  // deliberately stops wrapping errors past that point), and a run log that
  // could not be written is not worth abandoning a member's close for — which
  // is exactly what an escaping throw would do, silently, halfway through.
  const log = async (line: string): Promise<void> => {
    try {
      await opts.log?.(line);
    } catch {
      /* the wrap-up's result is the record that matters */
    }
  };
  const residue: string[] = [];
  const closed: number[] = [];

  // `closeOrder`, never `members`: dependents first and the root last, and the
  // loop STOPS at the first failure rather than carrying on. That pair is what
  // makes the retry this chunk is about to be promised a real one — see the
  // header, and `LandedChunk.closeOrder` for the derivation half of it.
  for (const member of target.closeOrder) {
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
      //
      // And nothing after it is attempted. Every member still to come is one
      // this one is built on top of, up to and including the root; closing any
      // of them would cut this member out of the chunk that names the branch
      // its commits are on, and the next cycle would find that branch matching
      // no chunk, delete it, and close nothing.
      break;
    }
    try {
      await adapter.removeLabel(member.number, NEEDS_REVIEW_LABEL);
    } catch (err) {
      // Benign, and said so: the planner never reads this display label, and
      // the issue is already closed.
      residue.push(
        `#${member.number} is closed but kept its \`${NEEDS_REVIEW_LABEL}\` label (harmless): ${detail(err)}`,
      );
    }
  }
  await log(
    `chunk ${target.branch}: closed ${closed.length}/${target.members.length} member(s)`,
  );

  // Known before the pull request is written to, and read by both the comment
  // and the delete below: a comment that recited `target.members` would tell a
  // reviewer an issue closed that is sitting open two lines above it.
  const closesComplete = closed.length === target.members.length;
  const unclosed = target.members.filter((m) => !closed.includes(m.number));

  if (target.pullRequest > 0) {
    // Three writes, and each one guarded on its own rather than as a
    // transaction, because the middle one must not be skipped by a failure
    // above it. `land` is the QUEUE: left on an open pull request it is a
    // landing the next cycle honours, and that cycle spends a whole merger
    // worktree and gate-stack bringup to discover the branch is gone, then
    // answers with `CHUNK_BRANCH_MISSING_PR_COMMENT` — prose about a deleted
    // branch and a clone that might still have it, for the most routine
    // outcome the review lane has.
    //
    // Comment FIRST all the same: it is what explains the other two, and a
    // label that vanished with no note is worse than a note with no label.
    try {
      await adapter.commentOnPullRequest(
        target.pullRequest,
        CHUNK_LANDED_PR_COMMENT({
          chunkBranch: target.branch,
          sourceBranch: opts.sourceBranch,
          provenance: opts.provenance,
          closed: target.members.filter((m) => closed.includes(m.number)),
          unclosed,
        }),
      );
    } catch (err) {
      residue.push(
        `the pull request #${target.pullRequest} for ${target.branch} landed but could not be commented on: ${detail(err)}`,
      );
    }
    try {
      await adapter.removePullRequestLabel(target.pullRequest, LAND_LABEL);
    } catch (err) {
      residue.push(
        `the pull request #${target.pullRequest} for ${target.branch} kept its \`${LAND_LABEL}\` label: ${detail(err)}`,
      );
    }
    try {
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
  // chunk again, and a member left OPEN under `needs-review` is the one residue
  // worth another attempt. A PR that would not close is cosmetic by
  // comparison, and a branch kept for it would re-run the whole wrap-up every
  // cycle forever. `closesComplete` is vacuously true for a chunk that named
  // no member at all, which deletes the branch too — see the header for why
  // that is the right answer and what it costs.
  let branchDeleted = false;
  if (closesComplete) {
    try {
      await adapter.deleteChunkBranch(
        target.branch,
        target.members.map((member) => member.number),
      );
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
      } member(s) still open on it`,
    );
  }

  return { closed: [...closed].sort((a, b) => a - b), branchDeleted, residue };
}

// ---------------------------------------------------------------------------
// Reading the residue back: three classes, and only one of them is retried
// ---------------------------------------------------------------------------
//
// `residue` is a flat list of lines because the wrap-up writes it as it goes,
// but the lines are not one kind of thing, and a caller that reports them as
// one makes a promise it cannot keep. The question that separates them is the
// BRANCH, not the lines:
//
//   * KEPT     — the branch is still on origin, because a member would not
//                close or the delete itself failed. Something WILL retry
//                this: the next cycle's reconciler finds the branch contained
//                in the source branch and does exactly the writes that
//                failed. Operator-actionable, and honestly described as
//                temporary.
//   * UNTIDY   — the branch retired and a line was left behind anyway: an
//                `needs-review` label that would not come off a CLOSED issue, a
//                pull request that would not close or lose its `land`. NOTHING
//                will retry these — the branch a retry would be found through
//                is gone — so they are cosmetic by construction, and telling a
//                human otherwise sends them back next week to check on a
//                repair that was never scheduled.
//   UNNAMED  — the branch retired having closed nothing, because the chunk
//                named no member. Every write worked, so there is no residue
//                at all, and it is reported beside the other two because it is
//                the same kind of news: durable work whose tracker state may
//                still be wrong, with nothing left that will look at it again.
//
// A kept chunk always has residue (both paths that keep the branch push a
// line), so `kept` needs no residue filter and `untidy` does. Both callers in
// `run.ts` — the merge phase's own landings and the plan-time reconciler's —
// report off this rather than off the flat list, and each counts its own
// chunks: three chunks and one stray label is one chunk with bookkeeping left
// over, not three.

export type ChunkResidue = {
  readonly kept: readonly ChunkWrapup[];
  readonly untidy: readonly ChunkWrapup[];
  // Retired without closing anything, because the chunk named no member at
  // all. Not residue in the sense above — no write went wrong — but the one
  // outcome a human may still have to finish by hand, and the branch that
  // would have led them to it is gone. A chunk can be `untidy` as well; the
  // two say different things and both are worth saying.
  readonly unnamed: readonly ChunkWrapup[];
};

export function chunkResidue(
  wrapups: readonly ChunkWrapup[],
): ChunkResidue {
  return {
    kept: wrapups.filter((w) => !w.branchDeleted),
    untidy: wrapups.filter((w) => w.branchDeleted && w.residue.length > 0),
    unnamed: wrapups.filter(
      (w) => w.branchDeleted && w.target.members.length === 0,
    ),
  };
}

// One banner: a headline, the lines it is about, and the one sentence that
// says whether anything will come back for them. What is worth spelling once
// is not the words but that pairing — the way these were wrong before was one
// banner keeping the other's closing sentence.
type ResidueBanner = {
  readonly chunks: readonly ChunkWrapup[];
  readonly sourceBranch: string;
  readonly provenance: LandingProvenance;
};

const banner = (headline: string, args: ResidueBanner, tail: string): string =>
  `\n${headline}\n` +
  args.chunks
    .flatMap((c) => c.residue)
    .map((r) => `  ${r}`)
    .join("\n") +
  `\n${tail}`;

export const CHUNK_RESIDUE_KEPT_BANNER = (args: ResidueBanner): string =>
  banner(
    args.provenance === "sandbar"
      ? `Sandbar landed ${args.chunks.length} chunk(s) on ` +
        `\`${args.sourceBranch}\` and could not finish reconciling them:`
      : `Sandbar found ${args.chunks.length} chunk(s) already on ` +
        `\`${args.sourceBranch}\` and could not finish reconciling them:`,
    args,
    "The work is durable, and the chunk branch(es) were KEPT on origin: the " +
      `next cycle's reconciler finds them contained in \`${args.sourceBranch}\` ` +
      "and retries exactly these writes. Fix them by hand if that is quicker.",
  );

// A chunk that reached the wrap-up naming NO member to close, and whose branch
// is therefore gone with nothing closed. Sandbar does that on purpose — see the
// header on why an empty list still deletes — and this is the one repair that
// remains available: telling a human, while the branch name is still on their
// screen.
//
// Both passes report it. The merge phase's version is a `land` request whose
// branch the derivation could not name; the reconciler's is a branch already on
// the source branch that no chunk claims, which is the ordinary end of a chunk
// somebody closed out by hand and the only trace of one whose members the graph
// lost. Neither halts: the commits are durable, and every repair left is a
// human's to make on the tracker.
export const CHUNK_LANDED_UNNAMED_BANNER = (args: {
  readonly chunks: readonly ChunkWrapup[];
  readonly sourceBranch: string;
  readonly provenance: LandingProvenance;
}): string =>
  `\nSandbar ${args.provenance === "sandbar" ? "landed" : "found"} ` +
  `${args.chunks.length} chunk(s) ${
    args.provenance === "sandbar" ? "on" : "already on"
  } \`${args.sourceBranch}\` for which it knew no member issue, so it closed ` +
  "none:\n" +
  args.chunks.map((c) => `  ${c.target.branch}`).join("\n") +
  "\nUsually that means they were closed by hand already. If any issue is still " +
  `open under \`${NEEDS_REVIEW_LABEL}\` for one of these, close it yourself — the ` +
  "branch is deleted, so no later run will find it.";

export const CHUNK_RESIDUE_RETIRED_BANNER = (args: ResidueBanner): string =>
  banner(
    args.provenance === "sandbar"
      ? `Sandbar landed and retired ${args.chunks.length} chunk(s) on ` +
        `\`${args.sourceBranch}\`, with some bookkeeping left over:`
      : `Sandbar reconciled and retired ${args.chunks.length} chunk(s) ` +
        `already on \`${args.sourceBranch}\`, with some bookkeeping left over:`,
    args,
    "Every member closed and the chunk branch is gone, so NOTHING retries " +
      "these — they are cosmetic, and yours to tidy if you care to.",
  );
