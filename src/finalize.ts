// Per-issue branch lifecycle + label flips + issue annotations.
//
// For each issue the orchestrator touched this iteration, dispatches to the
// right side-effects given its terminal state. Run in two passes per cycle
// (#30): the agent terminals are finalised BEFORE the merge phase — they do not
// depend on it, and a merge phase that dies must not take a full attempt
// budget's worth of questions, traces and reviewer prose with it — and the
// merger's own outcomes after. The inputs for each pass are built by
// finalize-inputs.ts; nothing here cares which pass it is in.
//
// Every kind calls reclaimIssueClone — sandbox.close() in the inner loop
// usually has already reclaimed the issue clone, but crash leftovers still need
// deterministic cleanup. Since #98 the clone is a repository of its own, so
// removing it is where commits can be destroyed; `reclaimIssueClone`
// (agent-sandbox.ts) is the one rule for that, and it publishes into the cache
// BEFORE it deletes, answering `preserved` with a reason when it could not.
// Nothing here decides preservation by terminal kind. Every non-DONE terminal
// that may otherwise discard the cache branch asks structurally whether it is
// ahead of its seed and publishes it first (#158); clone-preservation failures
// still keep that branch because it is what keeps `pruneStaleIssueClones` off
// a preserved clone. The reviewer-write handoff is the one caller that asks for
// the clone to be kept when the rule would reclaim it: the human is told to
// inspect it, and uncommitted evidence cannot travel through a push.
// Human-facing parking comments use the same three-part contract throughout:
// one stop line, the variable payload (with diagnostics collapsed), and one
// final action line naming the branch and label transition (#170).
//
// A SERVER-REFUSED PUSH is the other deliberate local park (#163), for every
// terminal that publishes an issue branch. The shared classifier reads Git's
// `[remote rejected]` ref line as a fact about this branch's content or ref,
// distinct from a non-fast-forward race and from transport. Finalise comments
// with the exact refusal, tip sha, cache ref/path and recovery command, then
// swaps `ready-for-agent` for `agentStuck`; the rest of the queue continues.
// Races and transport failures still halt loudly except at the reviewer-write
// handoff: that pre-existing evidence-preservation path parks after any failed
// publish because its authoritative state is the deliberately retained clone.
// The landing path's `landing-push-refused` input is already commented and
// de-queued by merger, so this module only applies its handoff label and does
// not retry the same refused content. As with every human handoff, the
// explanatory comment precedes the label flip so a comment failure cannot park
// an issue without instructions.
//
// `git branch -d` is escalated to `-D` only where the caller owns the certainty
// that the work is preserved elsewhere. For `merged`/`chunk-landed`/
// `fresh-attempt` that certainty is structural — the merger just landed the
// branch on the source branch or on the chunk branch and PUSHED it (producing
// different bytes, so the tip is no longer an ancestor of HEAD and `-d`
// correctly refuses), or the silent-noop path is deliberately discarding it.
// `needs-ui-prototype` has no such guarantee, so it *verifies* containment via
// branchIsContainedInOrigin before forcing, and keeps the branch otherwise.
// `-d` refusing is never on its own a licence to force.
//
// Human-handoff terminals are guarded on live issue state (#16): stamping
// `agentStuck` + a failure comment on an already-CLOSED issue contradicts its
// state and reads as "merged work is broken". The planner's stale-listing
// re-pick (the root cause) is fixed in plan-resolver, but a human can also
// close an issue mid-run, so finalize re-checks `issueState` before any handoff
// write and no-ops (skipped-closed) when the issue is closed.
//
// finalizeOne is pure orchestration over a FinalizeAdapter. realAdapter wires
// the adapter to git/gh.
//
// Handoff labels are configurable (LabelConfig in config.ts) and NOT
// auto-created — a missing/misconfigured label is a host config error. Every
// agent-failure terminal (merge-conflict, merge-gate-red, forge-unverified,
// silent-noop-exhausted, needs-human, review-budget-exhausted) parks the issue
// under the single `agentStuck` label; the *reason* lives in the bot comment.
//
// `chunk-landed` (#60) must remove `ready-for-agent`: on a published member that
// label now requests rework (#94). It also applies the display-only
// `needs-review` label, whose failure still costs only the human cue and never
// blocks landing. The issue comment remains required: it names the review
// branch even when that optional display-label edit fails.
//
// Required side-effects fail loud, they don't swallow (#8). The original bug was
// `editLabels` catching a "label doesn't exist" error, logging it, and returning
// as if the issue had been parked — so the run continued and the issue, never
// removed from the queue, was re-picked forever. Now required comments and
// label flips fail loud, and pushBranch returns the named git outcome above so
// only a server refusal can become a local park; run() surfaces every other
// failure and stops. editLabels still removes then adds as separate `gh` calls so
// a missing add-label can't abort the queue-removing --remove-label, and it
// returns its outcome structured so the benign `merged` cleanup can ignore a
// failure while the handoff arms turn it into a loud stop.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { type IssueCloneReclaim, reclaimIssueClone } from "./agent-sandbox.js";
import { NEEDS_REVIEW_LABEL } from "./chunks.js";
import { strandedHeadRef } from "./naming.js";
import type { LabelConfig } from "./config.js";
import { SandbarError, isExitCode } from "./errors.js";
import type { HeadMismatch } from "./git-ops.js";
import type { IssueRef } from "./merger.js";
import type { SpecGap } from "./inner-loop.js";
import type { ContextSlot } from "./inner-loop-machine.js";
import type { OriginWriteBarrier } from "./origin-lock.js";
import { type RepoLayout, worktreePathFor } from "./repo-cache.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";
import {
  classifyPushError,
  type LocalBranchRecovery,
  type PushResult,
  pushRefusedRecoveryNote,
} from "./push-result.js";

// Where an implementer's commits ended up when it worked off the issue branch
// (#27). Structural alias of git-ops' HeadMismatch — finalize only ever reads
// it, and only to name a sha nothing else will ever mention again.
type StrandedHead = HeadMismatch;

const exec = promisify(execFile);

// The planner queue label sandbar removes when an issue leaves the queue. Fixed
// (not in LabelConfig) — it's the protocol entry label, shared with the
// planner's list filter and the merger; see config.ts LabelConfig.
export const READY_FOR_AGENT_LABEL = "ready-for-agent";

export const BOT_COMMENT_PREFIX = "**Sandbar:**";

export const PUSH_REFUSED_COMMENT_TEMPLATE = (args: {
  readonly branch: string;
  readonly reasons: readonly string[];
  readonly recovery: LocalBranchRecovery;
  readonly stuckLabel: string;
  readonly readyLabel: string;
  readonly context?: string;
}): string =>
  `${BOT_COMMENT_PREFIX} origin refused to publish \`${args.branch}\`.\n\n` +
  `${pushRefusedRecoveryNote(args)}` +
  (args.context ? `\n\n${args.context}` : "") +
  `\n\nAction: use \`${args.branch}\`; ` +
  (args.context ? "resolve the handoff above, then " : "") +
  `drop \`${args.stuckLabel}\` and re-apply ` +
  `\`${args.readyLabel}\`.`;

// A note that applies to every template below, and to the ones in
// `chunk-land.ts` and `chunk-pr.ts`: these bodies are posted into the HOST
// repository. `#N` in one of them is not a sandbar issue — GitHub resolves it
// against the host's numbering, renders it as a link and files a
// cross-reference event and a notification on whatever issue or pull request
// happens to hold that number. So the `(#N)` citation this codebase uses
// everywhere else stays in module headers and comments; the only `#N` a body
// may carry is one it was HANDED, which is a host issue number by
// construction.
//
// Every parking comment follows one contract: one line naming the fact that
// stopped work; the variable payload immediately below it (agent text and
// reviewer reports open, logs/traces collapsed); one final action line naming
// the branch and label transition. Stable explanations of sandbar's mechanics
// do not belong in a host-repository handoff. #70's branch rule still applies:
// the name is handed in, never reconstructed, and says only where the branch
// is—not what an off-branch attempt may have written. #27's stranded-work note
// is the only text entitled to locate those commits. It names the durable cache
// pin only after reclamation established it; otherwise it points at the exact
// preserved clone. A terminal with no pushed branch says so instead of
// inventing one.

const handoffAction = (
  branch: string | null,
  currentLabel: string,
  readyLabel: string,
  instruction: string,
): string =>
  `Action: ${branch === null ? "no issue branch was pushed" : `use \`${branch}\``}; ` +
  `${instruction}, then drop \`${currentLabel}\` and re-apply \`${readyLabel}\`.`;

export const NEEDS_INFO_COMMENT_TEMPLATE = (
  branch: string,
  questions: string,
  needsInfoLabel: string,
  readyLabel: string,
  strandedHead: StrandedHead | null,
  reclaim: IssueCloneReclaim,
): string =>
  `${BOT_COMMENT_PREFIX} stopped for requested information.\n\n` +
  `${questions}` +
  (strandedHead === null ? "" : STRANDED_COMMITS_NOTE(strandedHead, reclaim)) +
  `\n\n` +
  handoffAction(branch, needsInfoLabel, readyLabel, "answer the questions");

// #21 — the implementer stopped before writing code because the issue implies
// non-trivial user-visible UI and carries no prototype. Same human round-trip
// as NEEDS-INFO (supply the missing artifact, re-label), so it reuses the
// needsInfo label; the comment is what makes the ask concrete.
//
// The unblocking routes are spelled out because most of them silently don't
// work: the agent reads this issue as text (`gh issue view --json`), so a
// pasted screenshot is a URL it can neither authenticate to nor see. An
// in-repo file must be on the source branch before re-labelling, because issue
// branches seed from `origin/<sourceBranch>`, not the operator's local.
// The escape phrase is deliberately verbatim in both this comment and
// prompts/implementer.md ("no prototype needed"): the human types it here and
// the next run's implementer must recognise it in the issue anchor. That
// coupling is pinned by a test.
export const NO_PROTOTYPE_NEEDED_PHRASE = "no prototype needed";

const needsUiPrototypeExplanation = (
  issueNum: number,
  uiImpact: string,
): string =>
  `${uiImpact}\n\n` +
  `- In-repo route: commit a file such as \`docs/prototypes/issue-${issueNum}.html\` and push it to the source branch before re-labelling.\n` +
  `- Comment route: add inline fenced markup, an ASCII wireframe, or a precise prose specification.\n` +
  `- A screenshot alone does not work; the agent reads this issue as text.\n` +
  `- Or reply \`${NO_PROTOTYPE_NEEDED_PHRASE}\` in your own comment.`;

export const NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE = (
  issueNum: number,
  uiImpact: string,
  needsInfoLabel: string,
  readyLabel: string,
  // Null on the ordinary pre-code escalation; named on a late escalation whose
  // partial branch was published.
  branchPushed: string | null,
  strandedHead: StrandedHead | null,
  reclaim: IssueCloneReclaim,
): string =>
  `${BOT_COMMENT_PREFIX} stopped for a UI prototype.\n\n` +
  `${needsUiPrototypeExplanation(issueNum, uiImpact)}` +
  (strandedHead === null ? "" : STRANDED_COMMITS_NOTE(strandedHead, reclaim)) +
  `\n\n` +
  handoffAction(
    branchPushed,
    needsInfoLabel,
    readyLabel,
    "supply a readable prototype or the exact opt-out reply",
  );

const needsPartitionExplanation = (
  budget: number,
  detail: string,
): string =>
  `${detail}\n\nPartition into a \`## Blocked by\` chain of independently landable issues ` +
  `within the ${budget.toLocaleString("en-US")}-character budget.`;

const quotaExplanation = (
  provider: "claude" | "codex",
  window: string,
  reset: string,
): string =>
  `The \`${provider}\` subscription quota window \`${window}\` closed; it ` +
  `resets at ${reset}.`;

const credentialExplanation = (provider: "codex", detail: string): string =>
  `The \`${provider}\` provider refused its credential: ` +
  `${detail}${/[.!?]$/.test(detail) ? " " : ". "}` +
  `Log in again on the host using the credential file your config reads into ` +
  `\`CODEX_AUTH_JSON\`, then restart Sandbar.`;

export const NEEDS_PARTITION_COMMENT_TEMPLATE = (
  cause: "classifier" | "measured" | "provider-refused",
  slot: ContextSlot,
  size: number,
  budget: number,
  detail: string,
  needsInfoLabel: string,
  readyLabel: string,
  branchPushed: string | null,
): string =>
  `${BOT_COMMENT_PREFIX} stopped for partitioning (${cause}, \`${slot}\`: ` +
  `${size.toLocaleString("en-US")} characters).\n\n` +
  `${needsPartitionExplanation(budget, detail)}\n\n` +
  handoffAction(
    branchPushed,
    needsInfoLabel,
    readyLabel,
    "partition the work and select the first ready issue",
  );

const needsHumanGateExplanation = (
  failureTrace: string,
  latestReviewerProse: string | null,
): string =>
  (latestReviewerProse === null
    ? ""
    : `Latest quality review from the red round:\n\n${latestReviewerProse}\n\n`) +
  `<details><summary>Gate trace</summary>\n\n` +
  `\`\`\`\n${failureTrace}\n\`\`\`\n\n</details>`;

export const NEEDS_HUMAN_COMMENT_TEMPLATE = (
  branch: string,
  failedStep: string,
  roundsUsed: number,
  failureTrace: string,
  latestReviewerProse: string | null,
  stuckLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} ${gateRedStop(failedStep, roundsUsed)}\n\n` +
  `${needsHumanGateExplanation(failureTrace, latestReviewerProse)}\n\n` +
  handoffAction(branch, stuckLabel, readyLabel, "push a fix");

const gateRedStop = (failedStep: string, roundsUsed: number): string =>
  `gate-1 was red for ${roundsUsed} consecutive ` +
  `round${roundsUsed === 1 ? "" : "s"}; latest failing step: ` +
  `\`${failedStep}\`.`;

const noSignalStop = (roundsUsed: number): string =>
  `the quality pass stopped after ${roundsUsed} consecutive ` +
  `failure${roundsUsed === 1 ? "" : "s"}; the final attempt had no actionable signal.`;

const needsHumanNoSignalExplanation = (failureTrace: string): string =>
  `<details><summary>Attempt summary</summary>\n\n` +
  `\`\`\`\n${failureTrace}\n\`\`\`\n\n</details>`;

export const NEEDS_HUMAN_NO_SIGNAL_COMMENT_TEMPLATE = (
  branch: string,
  roundsUsed: number,
  failureTrace: string,
  stuckLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} ${noSignalStop(roundsUsed)}\n\n` +
  `${needsHumanNoSignalExplanation(failureTrace)}\n\n` +
  handoffAction(branch, stuckLabel, readyLabel, "inspect the transcripts and push a fix");

// The worktree could not be brought to a committed state, so no gate ever ran
// (#24 D1). Distinct from NEEDS_HUMAN_COMMENT_TEMPLATE, which says "exhausted
// the quality budget without a green gate" — true-ish but it sends the reader
// looking for a failing test. It may fire early when two attempts leave the
// same dirty set, or when the quality budget expires across changing sets.
// What the human needs is the path list and the knowledge that the cause is
// almost never the branch's code.
const needsHumanUncommittableExplanation = (
  failureTrace: string,
): string =>
  `<details><summary>Uncommitted paths</summary>\n\n` +
  `\`\`\`\n${failureTrace}\n\`\`\`\n\n</details>`;

const uncommittableStop = (qualityRounds: number | null): string =>
  qualityRounds === null
    ? "stopped because the worktree stayed uncommitted."
    : `the quality pass stopped after ${qualityRounds} consecutive failures; the worktree stayed uncommitted.`;

export const NEEDS_HUMAN_UNCOMMITTABLE_COMMENT_TEMPLATE = (
  branch: string,
  qualityRounds: number | null,
  failureTrace: string,
  stuckLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} ${uncommittableStop(qualityRounds)}\n\n` +
  `${needsHumanUncommittableExplanation(failureTrace)}\n\n` +
  handoffAction(branch, stuckLabel, readyLabel, "commit or ignore the paths");

// Appended to any handoff comment whose run left commits off the issue branch
// (#27). Split out because three arms need it and only one of them is the
// off-branch terminal itself: NEEDS-INFO and NEEDS-UI-PROTOTYPE are exempt from
// the correction, so for them this note is the ONLY place the work is recorded.
//
// The prose branches on `headRef`, and that distinction is not cosmetic. A
// DETACHED head needs a new branch name; a scratch BRANCH already has one.
// Successful reclamation names the cache pin that outlives the clone. Failed
// reclamation names the preserved clone instead, because claiming a pin the
// cache refused to create would send the human to a nonexistent recovery ref.
export const STRANDED_COMMITS_NOTE = (
  m: StrandedHead,
  reclaim: IssueCloneReclaim,
): string => {
  if (reclaim.kind === "preserved") {
    return m.headRef === null
      ? `\n\nStranded work: \`${m.headSha}\` remains in preserved clone ` +
        `\`${reclaim.worktreePath}\`; recover it there with ` +
        `\`git -C '${reclaim.worktreePath}' branch <rescue-name> ${m.headSha}\`, ` +
        `then cherry-pick or merge it into \`${m.branch}\`.`
      : `\n\nStranded work: \`${m.headRef}\` at \`${m.headSha}\` remains in ` +
        `preserved clone \`${reclaim.worktreePath}\`; from that clone, cherry-pick ` +
        `or merge it into \`${m.branch}\`.`;
  }
  const location = reclaim.kind === "removed"
    ? ` is pinned as \`${strandedHeadRef(m.headSha)}\``
    : " is off the issue branch";
  return m.headRef === null
    ? `\n\nStranded work: \`${m.headSha}\`${location}; recover it with ` +
      `\`git branch <rescue-name> ${m.headSha}\`, then cherry-pick or merge it into ` +
      `\`${m.branch}\`.`
    : `\n\nStranded work: \`${m.headRef}\` at \`${m.headSha}\`${location}; ` +
      `cherry-pick or merge it into \`${m.branch}\`.`;
};

// The implementer committed off the issue branch and stayed off it after being
// told (#27). Neither the gate-red nor a review-budget comment applies —
// and neither would mention the fact that matters, which is that work exists and
// is not where anyone will look for it.
//
// Deliberately says NOTHING about whether a gate ran, whether the branch moved,
// or whether anything merged. The tempting version of this comment asserts all
// three ("no gate ran, the branch never moved, nothing was merged") because that
// is true of the case #27 describes — an agent detached from its first attempt.
// But that case cannot reach this terminal *or* any other interesting one: with
// no commit on the branch, `parsePromise`'s zero-commit guard downgrades every
// COMPLETE. The path that actually gets here is the ordinary review round-trip,
// where attempt 1 committed on the branch, a gate ran and went green, and only
// the later attempts wandered off — so all three claims would be false, and the
// author would be sent to look for a failing gate that passed.
//
// What is invariant is the part worth saying: the later work is not on the
// branch. STRANDED_COMMITS_NOTE says where it is instead.
const needsHumanOffBranchExplanation = (
  failureTrace: string,
): string =>
  `<details><summary>What the implementer was told</summary>\n\n` +
  `\`\`\`\n${failureTrace}\n\`\`\`\n\n</details>`;

const offBranchStop = (branch: string, qualityRounds: number | null): string =>
  qualityRounds === null
    ? `stopped because the implementer remained off \`${branch}\`.`
    : `the quality pass stopped after ${qualityRounds} consecutive failures; the implementer remained off \`${branch}\`.`;

export const NEEDS_HUMAN_OFF_BRANCH_COMMENT_TEMPLATE = (
  branch: string,
  qualityRounds: number | null,
  failureTrace: string,
  strandedHead: StrandedHead,
  reclaim: IssueCloneReclaim,
  stuckLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} ${offBranchStop(branch, qualityRounds)}\n\n` +
  `${needsHumanOffBranchExplanation(failureTrace)}` +
  `${STRANDED_COMMITS_NOTE(strandedHead, reclaim)}\n\n` +
  handoffAction(branch, stuckLabel, readyLabel, "fold in the stranded commits");

// A second reviewer-harness failure (#41) is not a review rejection. The stop
// line names the harness count, the diagnostic stays collapsed, and the action
// offers review or harness repair. If an EARLIER round produced a genuine
// report, it remains open and explicitly labelled as earlier; presenting the
// harness trace as `CHANGES-REQUESTED`, or the earlier report as a verdict on
// the current commits, would make the handoff false in opposite directions.
const needsHumanReviewerHarnessExplanation = (
  failureTrace: string,
  latestReviewerProse: string | null,
): string =>
  (latestReviewerProse === null
    ? ""
    : `Earlier-round reviewer report (not a verdict on the current commits):\n\n` +
      `${latestReviewerProse}\n\n`) +
  `<details><summary>Reviewer-harness trace</summary>\n\n` +
  `\`\`\`\n${failureTrace}\n\`\`\`\n\n</details>`;

const REVIEWER_HARNESS_STOP =
  "stopped after 2 reviewer-harness failures; no reviewer verdict was produced " +
  "in the failing round.";

export const NEEDS_HUMAN_REVIEWER_HARNESS_COMMENT_TEMPLATE = (
  branch: string,
  failureTrace: string,
  latestReviewerProse: string | null,
  stuckLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} ${REVIEWER_HARNESS_STOP}\n\n` +
  `${needsHumanReviewerHarnessExplanation(failureTrace, latestReviewerProse)}\n\n` +
  handoffAction(branch, stuckLabel, readyLabel, "review the branch or repair the harness");

const reviewBudgetExhaustedExplanation = (
  budget: "quality" | "correctness",
  latestReviewerProse: string,
): string => {
  return `Latest ${budget} reviewer report:\n\n${latestReviewerProse}`;
};

export const REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE = (
  branch: string,
  budget: "quality" | "correctness",
  roundsUsed: number,
  latestReviewerProse: string,
  stuckLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} the ${budget} review pass stopped after ${roundsUsed} ` +
  `consecutive ${budget === "quality" ? "failure" : "rejection"}` +
  `${roundsUsed === 1 ? "" : "s"}.\n\n` +
  `${reviewBudgetExhaustedExplanation(budget, latestReviewerProse)}\n\n` +
  handoffAction(branch, stuckLabel, readyLabel, "push a fix or correct the governing instructions");

export const SILENT_NOOP_EXHAUSTED_COMMENT_TEMPLATE = (
  attempts: number,
  stuckLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} merge resolution aborted without a merge commit ` +
  `${attempts} time${attempts === 1 ? "" : "s"}.\n\n` +
  handoffAction(null, stuckLabel, readyLabel, "resolve manually or re-scope the issue");

// #60 — one line for a chunk member: the durable chunk branch and, when the PR
// write succeeded before finalization, the review surface that will land it.
export const CHUNK_LANDED_COMMENT_TEMPLATE = (
  chunkBranch: string,
  pullRequestNumber: number | null,
): string =>
  `${BOT_COMMENT_PREFIX} merged to \`${chunkBranch}\`; lands with chunk PR` +
  `${pullRequestNumber === null ? "." : ` #${pullRequestNumber}.`}`;

type FinalizeKindInput =
  | { readonly kind: "merged"; readonly issue: IssueRef }
  // #158 — coarse per-deliverable sizing, measured budget, or provider refusal.
  | {
      readonly kind: "needs-partition";
      readonly issue: IssueRef;
      readonly cause: "classifier" | "measured" | "provider-refused";
      readonly slot: ContextSlot;
      readonly size: number;
      readonly budget: number;
      readonly detail: string;
    }
  // #60 — a review-gated issue whose branch landed on its chunk's branch, which
  // is now on origin. NOT a close: nothing has reached the source branch and
  // the review that would justify closing has not happened. The issue stays
  // OPEN and attempts to swap `ready-for-agent` for `needs-review` for display.
  | {
      readonly kind: "chunk-landed";
      readonly issue: IssueRef;
      readonly chunkBranch: string;
      readonly pullRequestNumber: number | null;
    }
  | { readonly kind: "merge-conflict"; readonly issue: IssueRef }
  | { readonly kind: "merge-gate-red"; readonly issue: IssueRef }
  // Verified merge mode (#22): merged + locally gated green, but the forge
  // rejected the cycle's composed result, so the merge was reverted and nothing
  // landed. Same handoff shape as merge-gate-red — the merger already posted the
  // explanatory comment and dropped the queue label; finalize pushes the branch
  // (the human needs it on the forge to inspect) and parks it.
  | { readonly kind: "forge-unverified"; readonly issue: IssueRef }
  // #163 — origin refused the Phase-A atomic chunk push. The merger already
  // posted exact cache recovery instructions and removed the queue label.
  // Finalise applies the human-handoff label but MUST NOT push the issue branch:
  // it contains the same refused content and would turn a per-branch park back
  // into a run-wide halt.
  | { readonly kind: "landing-push-refused"; readonly issue: IssueRef }
  | {
      readonly kind: "needs-info";
      readonly issue: IssueRef;
      readonly questions: string;
      // #27 — see needs-ui-prototype. This arm always pushes, but an off-branch
      // agent moved nothing, so the push carries none of what it wrote.
      readonly strandedHead: StrandedHead | null;
    }
  // #21 — implementer escalated on non-trivial UI impact with no prototype.
  // Same handoff shape as needs-info (comment + `ready-for-agent` → needsInfo),
  // but the branch is pushed only when structurally ahead of its seed: the
  // escalation normally fires before code exists, and pushing then would
  // publish a remote branch identical to the source tip — one junk ref per
  // escalation.
  | {
      readonly kind: "needs-ui-prototype";
      readonly issue: IssueRef;
      readonly uiImpact: string;
      // #27 — the agent escalated from off the branch. The branch-ahead check
      // cannot see that detached work, so this arm is about to delete a branch
      // while the work sits on an unnamed dangling commit.
      readonly strandedHead: StrandedHead | null;
    }
  | {
      // Quality-budget exhaustion, or a blocker the agent cannot clear.
      // `cause` selects the comment so the human is pointed at the real blocker
      // (#17): gate-red surfaces the failure trace; uncommittable-worktree surfaces
      // the paths that stayed dirty across attempts (no gate ever ran, so a
      // gate-red comment would describe a failure that did not happen);
      // off-branch-head surfaces where HEAD went (#27) — likewise no gate ran,
      // and the comment is the only place the stranded commit's sha survives;
      // reviewer-harness-failed says the gate is green and nothing reviewed the
      // current commits (#41), which is the one arm where `latestReviewerProse`
      // may be a real report from an EARLIER round: it is rendered, because
      // nothing else surfaces it, but as that earlier round's and never as the
      // reason the issue stopped.
      readonly kind: "needs-human";
      readonly issue: IssueRef;
      readonly cause:
        | "gate-red"
        | "no-signal-exhausted"
        | "uncommittable-worktree"
        | "off-branch-head"
        | "reviewer-harness-failed";
      readonly failureTrace: string;
      readonly latestReviewerProse: string | null;
      readonly budgetExhausted: {
        readonly budget: "quality";
        readonly roundsUsed: number;
      } | {
        readonly budget: "gate";
        readonly roundsUsed: number;
        readonly failedStep: string;
      } | null;
      readonly strandedHead: StrandedHead | null;
    }
  | {
      readonly kind: "review-budget-exhausted";
      readonly issue: IssueRef;
      readonly budget: "quality" | "correctness";
      readonly roundsUsed: number;
      readonly latestReviewerProse: string;
    }
  | {
      readonly kind: "read-only-agent-wrote";
      readonly issue: IssueRef;
      readonly latestReviewerProse: string;
      readonly actor: "reviewer" | "adjudicator" | "UI checker" | "partition checker";
    }
  | {
      readonly kind: "hard-error";
      readonly issue: IssueRef;
    }
  | {
      readonly kind: "quota";
      readonly issue: IssueRef;
      readonly provider: "claude" | "codex";
      readonly window: string;
      readonly resetsAt?: number;
    }
  | {
      readonly kind: "credential";
      readonly issue: IssueRef;
      readonly provider: "codex";
      readonly detail: string;
    }
  // Silent-noop under the retry cap: discard the branch + worktree so the
  // next execution starts fresh against current source. The issue
  // stays `ready-for-agent` and the planner re-picks it.
  | { readonly kind: "fresh-attempt"; readonly issue: IssueRef }
  // Silent-noop retries exhausted: drop `ready-for-agent`, add the handoff
  // label, post a comment explaining the failure mode. No branch is pushed
  // (each silent-noop deleted it; there's nothing on the remote to inspect).
  | {
      readonly kind: "silent-noop-exhausted";
      readonly issue: IssueRef;
      readonly attempts: number;
    };

export type FinalizeInput = FinalizeKindInput & {
  // Correctness-review decisions caused by missing specification, in the order
  // the rounds declared them. Evidence only: this field affects no terminal,
  // label, branch lifecycle, or state-machine decision (#108).
  readonly specGaps: readonly SpecGap[];
};

export const SPEC_GAPS_COMMENT = (gaps: readonly SpecGap[]): string =>
  `${BOT_COMMENT_PREFIX} the correctness reviewer recorded the following ` +
  `specification gap${gaps.length === 1 ? "" : "s"} and the decision it applied:` +
  gaps.map((gap) => `\n\n### Review round ${gap.round}\n\n${gap.text}`).join("");

export type FinalizeAdapter = {
  pushBranch(branch: string): Promise<PushResult>;
  // Exact durable cache location used in a refused-push handoff. Asked only
  // after pushBranch returns `refused`.
  localBranchRecovery(branch: string): Promise<LocalBranchRecovery>;
  // git branch -d — refuses if the branch isn't merged, which is desirable.
  // Returns ok=false with the error message instead of throwing so the
  // orchestrator can keep finalising the rest.
  deleteBranch(
    branch: string,
  ): Promise<{ readonly ok: boolean; readonly error?: string }>;
  // git branch -D — force-delete. Only safe in contexts where the caller
  // knows the work is already preserved elsewhere (e.g., the merger just
  // landed it on the source branch via the resolve-loop, where the merge
  // tree differs from the branch's diff so `-d` refuses).
  forceDeleteBranch(
    branch: string,
  ): Promise<{ readonly ok: boolean; readonly error?: string }>;
  // Reclaim the issue clone through `reclaimIssueClone` (agent-sandbox.ts):
  // publish into the cache, then delete — or keep it and say why. `keep` is a
  // reason to preserve a clone the rule would reclaim. sandbox.close() in the
  // inner loop usually has already reclaimed it, in which case `absent`.
  reclaimIssueClone(branch: string, keep?: string): Promise<IssueCloneReclaim>;
  // Structural replacement for per-cycle commit bookkeeping (#158). The cache
  // answers whether the issue branch contains commits beyond the seed it would
  // be cut from now (chunk tip when present, otherwise source).
  branchIsAheadOfSeed(issue: IssueRef): Promise<boolean>;
  // True iff every commit on `branch` is already contained in
  // origin/<sourceBranch> — i.e. deleting it destroys nothing. This is the
  // *verified* form of the certainty forceDeleteBranch requires; `-d` refusing
  // is NOT that certainty (it also refuses when the local source branch merely
  // trails origin). Git's exit 1 answers false; other failures propagate.
  branchIsContainedInOrigin(branch: string): Promise<boolean>;
  postComment(issueNum: number, body: string): Promise<void>;
  // Removes then adds, as SEPARATE `gh issue edit` calls (remove first). A
  // single `gh issue edit` is atomic: if any --add-label target doesn't exist,
  // gh rejects the whole command and the --remove-label is collateral damage —
  // the issue keeps `ready-for-agent` and the planner re-picks it forever (#8).
  // Splitting guarantees the queue-removal lands even when the handoff label is
  // missing/misconfigured, and the result reports what failed so the caller can
  // fail loud instead of swallowing.
  editLabels(
    issueNum: number,
    remove: readonly string[],
    add: readonly string[],
  ): Promise<LabelEditResult>;
  // Live issue state from the tracker. Read before any human-handoff write so a
  // closed issue (merged earlier this run, or human-closed mid-run) never gets
  // stamped with a handoff label + failure comment (#16).
  issueState(issueNum: number): Promise<"OPEN" | "CLOSED">;
  // Read-back after finalization. A successful write is not accepted until the
  // tracker reports the queue label absent (#87).
  issueLabels(issueNum: number): Promise<readonly string[]>;
};

export type LabelEditResult = {
  readonly ok: boolean;
  // Present iff !ok. Describes which leg(s) failed (remove and/or add).
  readonly error?: string;
};

export type FinalizeAction =
  | { readonly kind: "deleted-local" }
  | { readonly kind: "delete-failed"; readonly error: string }
  | { readonly kind: "pushed" }
  | { readonly kind: "parked-local" }
  | { readonly kind: "kept-branch"; readonly reason: string }
  // A human-handoff terminal landed on an already-CLOSED issue, so the label
  // flip + comment were skipped. Its clone is reclaimed unless it contains
  // evidence the corresponding open-issue handoff would preserve. See #16.
  | { readonly kind: "skipped-closed" }
  | { readonly kind: "noop" };

// Terminals that write a human-handoff annotation (handoff label + a comment)
// to the issue. These are the kinds guarded against an already-CLOSED issue in
// finalizeOne (#16); merged/hard-error/fresh-attempt touch no issue state and
// are exempt.
const HANDOFF_KINDS: ReadonlySet<FinalizeInput["kind"]> = new Set([
  "merge-conflict",
  "merge-gate-red",
  "forge-unverified",
  "landing-push-refused",
  "needs-info",
  "needs-ui-prototype",
  "needs-partition",
  "needs-human",
  "review-budget-exhausted",
  "read-only-agent-wrote",
  "silent-noop-exhausted",
]);

// Only these successful finalizations decide to remove `ready-for-agent`.
// Quota and infrastructure terminals deliberately leave the issue queued, and
// a closed-issue handoff performs no tracker write at all (#16).
export function finalizationIntendsNotReady(result: FinalizeResult): boolean {
  return result.action.kind === "parked-local" ||
    (result.action.kind !== "skipped-closed" && HANDOFF_KINDS.has(result.input.kind));
}

// The one caller that keeps a clone the reclaim rule would remove — see the
// module header.
const READ_ONLY_AGENT_WROTE_KEEP =
  "a read-only agent changed the repository; kept for human inspection";

const reclaimClone = (
  input: FinalizeInput,
  adapter: FinalizeAdapter,
): Promise<IssueCloneReclaim> =>
  adapter.reclaimIssueClone(
    input.issue.branch,
    input.kind === "read-only-agent-wrote" ? READ_ONLY_AGENT_WROTE_KEEP : undefined,
  );

// What a preserved clone means for the cache branch an arm was about to
// delete: keep it. `pruneStaleIssueClones` removes a marked clone whose cache
// branch is gone, so deleting the branch would hand the preserved clone — and
// whatever the publish could not move out of it — to the next sweep.
const keptForPreservedClone = (reason: string): FinalizeAction => ({
  kind: "kept-branch",
  reason: `kept the cache branch: the issue clone was preserved (${reason})`,
});

export type FinalizeResult = {
  readonly input: FinalizeInput;
  readonly action: FinalizeAction;
};

export function issueNumberOf(issue: IssueRef): number {
  const n = Number(issue.id);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid issue id (expected positive integer): ${issue.id}`);
  }
  return n;
}

// A required human-handoff label flip. The split-call adapter already ran the
// remove first (so the issue leaves the agent queue regardless), but if either
// leg failed we fail loud rather than report a successful handoff that didn't
// happen — the #8 bug. A failed flip is almost always a config error: the
// handoff label doesn't exist in the repo and sandbar never creates labels.
function requireFlip(r: LabelEditResult, issueNum: number): void {
  if (r.ok) return;
  throw new SandbarError(
    `Could not park issue #${issueNum} for a human: applying the handoff labels ` +
      `failed (${r.error ?? "unknown error"}). This is almost certainly a config ` +
      `error — the label does not exist in the repo (sandbar never creates ` +
      `labels). Create it or set config.labels, then re-run.`,
  );
}

function needsHumanComments(
  input: Extract<FinalizeInput, { readonly kind: "needs-human" }>,
  labels: LabelConfig,
  reclaim: IssueCloneReclaim,
): { readonly published: string; readonly refused: string } {
  const qualityRounds = input.budgetExhausted?.budget === "quality"
    ? input.budgetExhausted.roundsUsed
    : null;
  const pair = (() => {
    switch (input.cause) {
      case "reviewer-harness-failed":
        return {
          published: NEEDS_HUMAN_REVIEWER_HARNESS_COMMENT_TEMPLATE(
            input.issue.branch,
            input.failureTrace,
            input.latestReviewerProse,
            labels.agentStuck,
            READY_FOR_AGENT_LABEL,
          ),
          refused:
            `${REVIEWER_HARNESS_STOP}\n\n` +
            needsHumanReviewerHarnessExplanation(
              input.failureTrace,
              input.latestReviewerProse,
            ),
        };
      case "uncommittable-worktree":
        return {
          published: NEEDS_HUMAN_UNCOMMITTABLE_COMMENT_TEMPLATE(
            input.issue.branch,
            qualityRounds,
            input.failureTrace,
            labels.agentStuck,
            READY_FOR_AGENT_LABEL,
          ),
          refused:
            `${uncommittableStop(qualityRounds)}\n\n` +
            needsHumanUncommittableExplanation(input.failureTrace),
        };
      case "off-branch-head":
        if (input.strandedHead === null) {
          throw new Error("off-branch handoff missing stranded head");
        }
        return {
          published: NEEDS_HUMAN_OFF_BRANCH_COMMENT_TEMPLATE(
            input.issue.branch,
            qualityRounds,
            input.failureTrace,
            input.strandedHead,
            reclaim,
            labels.agentStuck,
            READY_FOR_AGENT_LABEL,
          ),
          refused:
            `${offBranchStop(input.issue.branch, qualityRounds)}\n\n` +
            needsHumanOffBranchExplanation(input.failureTrace) +
            STRANDED_COMMITS_NOTE(input.strandedHead, reclaim),
        };
      case "gate-red": {
        if (input.budgetExhausted?.budget !== "gate") {
          throw new Error("gate-red handoff missing gate budget");
        }
        const { failedStep, roundsUsed } = input.budgetExhausted;
        return {
          published: NEEDS_HUMAN_COMMENT_TEMPLATE(
            input.issue.branch,
            failedStep,
            roundsUsed,
            input.failureTrace,
            input.latestReviewerProse,
            labels.agentStuck,
            READY_FOR_AGENT_LABEL,
          ),
          refused:
            `${gateRedStop(failedStep, roundsUsed)}\n\n` +
            needsHumanGateExplanation(input.failureTrace, input.latestReviewerProse),
        };
      }
      case "no-signal-exhausted": {
        if (qualityRounds === null) {
          throw new Error("no-signal handoff missing quality budget");
        }
        return {
          published: NEEDS_HUMAN_NO_SIGNAL_COMMENT_TEMPLATE(
            input.issue.branch,
            qualityRounds,
            input.failureTrace,
            labels.agentStuck,
            READY_FOR_AGENT_LABEL,
          ),
          refused:
            `${noSignalStop(qualityRounds)}\n\n` +
            needsHumanNoSignalExplanation(input.failureTrace),
        };
      }
    }
  })();
  return pair;
}

const readOnlyAgentWroteExplanation = (
  input: Extract<FinalizeInput, { readonly kind: "read-only-agent-wrote" }>,
  reclaim: Extract<IssueCloneReclaim, { readonly kind: "preserved" }>,
  pushFailure?: string,
): string =>
  `Preserved clone: \`${reclaim.worktreePath}\`.\n\n` +
  `Read-only ${input.actor} output:\n\n${input.latestReviewerProse}` +
  (pushFailure === undefined
    ? ""
    : `\n\nPush failed: ${pushFailure}. Inspect the preserved clone.`);

const readOnlyAgentWroteStop = (
  actor: Extract<FinalizeInput, { readonly kind: "read-only-agent-wrote" }>["actor"],
): string => `stopped because the read-only ${actor} changed the repository.`;

type PushRefusal = Extract<PushResult, { readonly kind: "refused" }>;

async function parkRefusedPush(
  input: FinalizeInput,
  adapter: FinalizeAdapter,
  labels: LabelConfig,
  push: PushRefusal,
  options: {
    readonly context?: string;
    readonly queueAlreadyRemoved?: boolean;
  } = {},
): Promise<Extract<FinalizeAction, { kind: "parked-local" | "skipped-closed" }>> {
  const n = issueNumberOf(input.issue);
  // Quota, credential, and hard-error are not normally human handoffs, so the
  // top-level guard intentionally does not read issue state for them. A refusal
  // turns them into one: check at that transition, after preserving/publishing
  // local git state but before making any tracker write. Rechecking the regular
  // handoffs also closes the race where a human closes the issue during push.
  if ((await adapter.issueState(n)) === "CLOSED") {
    return { kind: "skipped-closed" };
  }
  const recovery = await adapter.localBranchRecovery(input.issue.branch);
  await adapter.postComment(
    n,
    PUSH_REFUSED_COMMENT_TEMPLATE({
      branch: input.issue.branch,
      reasons: push.reasons,
      recovery,
      stuckLabel: labels.agentStuck,
      readyLabel: READY_FOR_AGENT_LABEL,
      ...(options.context === undefined ? {} : { context: options.context }),
    }),
  );
  const flip = await adapter.editLabels(
    n,
    options.queueAlreadyRemoved ? [] : [READY_FOR_AGENT_LABEL],
    [labels.agentStuck],
  );
  requireFlip(flip, n);
  return { kind: "parked-local" };
}

// One policy for every issue-branch publish. A server refusal is attributable
// to this branch and becomes the same recoverable local park whichever terminal
// happened to reach finalise. Races and transport failures say nothing about
// the branch's content and retain the existing fail-loud behavior.
async function pushBranchOrPark(
  input: FinalizeInput,
  adapter: FinalizeAdapter,
  labels: LabelConfig,
  options: {
    readonly context?: string;
    readonly queueAlreadyRemoved?: boolean;
  } = {},
): Promise<
  Extract<FinalizeAction, { kind: "parked-local" | "skipped-closed" }> | null
> {
  const push = await adapter.pushBranch(input.issue.branch);
  if (push.kind === "ok") return null;
  if (push.kind === "race") {
    throw new SandbarError(
      `Failed to push branch '${input.issue.branch}' to origin: the remote branch moved (non-fast-forward).`,
    );
  }
  if (push.kind === "fatal") {
    throw new SandbarError(
      `Failed to push branch '${input.issue.branch}' to origin: ${push.reason}`,
    );
  }
  return parkRefusedPush(input, adapter, labels, push, options);
}

// `-d`, escalating to `-D` when it refuses. ONLY for callers that own the
// certainty the work is preserved elsewhere — see the module header. Callers
// without that certainty must verify it (branchIsContainedInOrigin) instead of
// reaching for this.
async function deleteBranchForcing(
  adapter: FinalizeAdapter,
  branch: string,
): Promise<FinalizeAction> {
  const d = await adapter.deleteBranch(branch);
  if (d.ok) return { kind: "deleted-local" };
  const f = await adapter.forceDeleteBranch(branch);
  return f.ok
    ? { kind: "deleted-local" }
    : { kind: "delete-failed", error: f.error ?? d.error ?? "" };
}

export async function finalizeOne(
  input: FinalizeInput,
  adapter: FinalizeAdapter,
  labels: LabelConfig,
): Promise<FinalizeAction> {
  // #16: never write a handoff annotation to an issue that's already CLOSED.
  // The planner can re-pick a merged+closed issue while `gh issue list` lags
  // (root cause fixed in plan-resolver), and a human can close an issue
  // mid-run — in both cases the handoff write would contradict the closed
  // state. Reclaim ordinary clones, preserve evidence clones, and skip the
  // issue-facing side effects.
  //
  // Correctness-review specification gaps (#108) are a separate required issue
  // comment, posted once per issue and terminal after that closed-handoff guard
  // and before terminal dispatch. This deliberately includes `merged`, whose
  // old arm wrote no comment. The ordered records are evidence only; they do not
  // select an arm or alter any terminal side effect.
  if (HANDOFF_KINDS.has(input.kind)) {
    const n = issueNumberOf(input.issue);
    if ((await adapter.issueState(n)) === "CLOSED") {
      await reclaimClone(input, adapter);
      return { kind: "skipped-closed" };
    }
  }
  if (input.specGaps.length > 0) {
    await adapter.postComment(
      issueNumberOf(input.issue),
      SPEC_GAPS_COMMENT(input.specGaps),
    );
  }
  switch (input.kind) {
    case "merged": {
      // AC: worktree first, then branch — so an interrupt mid-cleanup never
      // leaves a dangling worktree pointing at a deleted ref.
      await adapter.reclaimIssueClone(input.issue.branch);
      // The merger's merge commit auto-closes the issue, but GitHub doesn't
      // strip labels on close — drop `ready-for-agent` so the closed issue
      // isn't left advertising itself as plannable (#7). Best-effort: a failure
      // here is benign (the planner lists open issues, so a closed issue still
      // carrying the label is never re-picked).
      await adapter.editLabels(
        issueNumberOf(input.issue),
        [READY_FOR_AGENT_LABEL],
        [],
      );
      // `-d` may refuse: if the resolve loop produced a different tree on the
      // source branch than the branch's diff, the branch tip isn't an ancestor
      // of HEAD. The merger just landed this branch, so we own the certainty
      // and escalate to `-D`.
      return deleteBranchForcing(adapter, input.issue.branch);
    }
    case "chunk-landed": {
      // #60. Same branch lifecycle as `merged` — the commits are on the chunk
      // branch and that branch is on origin, so the local issue branch is a
      // duplicate and `-D` is safe on the same structural certainty. What
      // differs is everything issue-facing: no close (the review has not
      // happened), and the label flip moves the issue out of the agent queue.
      // It is required because `ready-for-agent` on a published member now
      // deliberately requests another implementation pass (#94).
      const n = issueNumberOf(input.issue);
      await adapter.reclaimIssueClone(input.issue.branch);
      const dequeue = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [],
      );
      if (!dequeue.ok) {
        throw new SandbarError(
          `Could not move chunk member #${n} into review: removing ` +
            `\`${READY_FOR_AGENT_LABEL}\` failed ` +
            `(${dequeue.error ?? "unknown error"}). The issue may still be in the ` +
            `agent queue, so its local branch was kept; fix the label configuration ` +
            `or forge failure, then re-run.`,
        );
      }
      // Display only: the durable comment below still points the human to the
      // review branch when a host has not created `needs-review`.
      await adapter.editLabels(n, [], [NEEDS_REVIEW_LABEL]);
      await adapter.postComment(
        n,
        CHUNK_LANDED_COMMENT_TEMPLATE(
          input.chunkBranch,
          input.pullRequestNumber,
        ),
      );
      return deleteBranchForcing(adapter, input.issue.branch);
    }
    case "merge-conflict": {
      const n = issueNumberOf(input.issue);
      await adapter.reclaimIssueClone(input.issue.branch);
      const refused = await pushBranchOrPark(input, adapter, labels, {
        queueAlreadyRemoved: true,
      });
      if (refused) return refused;
      // The merger already dropped `ready-for-agent`; finalize only parks it
      // under the handoff label.
      const r = await adapter.editLabels(n, [], [labels.agentStuck]);
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "merge-gate-red":
    case "forge-unverified": {
      const n = issueNumberOf(input.issue);
      await adapter.reclaimIssueClone(input.issue.branch);
      const refused = await pushBranchOrPark(input, adapter, labels, {
        queueAlreadyRemoved: true,
      });
      if (refused) return refused;
      const r = await adapter.editLabels(n, [], [labels.agentStuck]);
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "landing-push-refused": {
      const n = issueNumberOf(input.issue);
      await adapter.reclaimIssueClone(input.issue.branch);
      const r = await adapter.editLabels(n, [], [labels.agentStuck]);
      requireFlip(r, n);
      return { kind: "parked-local" };
    }
    case "needs-info": {
      const n = issueNumberOf(input.issue);
      const reclaim = await adapter.reclaimIssueClone(input.issue.branch);
      const body = NEEDS_INFO_COMMENT_TEMPLATE(
        input.issue.branch,
        input.questions,
        labels.needsInfo,
        READY_FOR_AGENT_LABEL,
        input.strandedHead,
        reclaim,
      );
      const refused = await pushBranchOrPark(input, adapter, labels, {
        context:
          input.questions +
          (input.strandedHead
            ? STRANDED_COMMITS_NOTE(input.strandedHead, reclaim)
            : ""),
      });
      if (refused) return refused;
      await adapter.postComment(
        n,
        body,
      );
      const r = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.needsInfo],
      );
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "needs-ui-prototype": {
      const n = issueNumberOf(input.issue);
      const reclaim = await adapter.reclaimIssueClone(input.issue.branch);
      const aheadOfSeed = await adapter.branchIsAheadOfSeed(input.issue);
      if (aheadOfSeed) {
        // Late escalation: the agent had already committed before it realised
        // it was inventing UI. Hand the partial work to the human.
        const refused = await pushBranchOrPark(input, adapter, labels, {
          context:
            needsUiPrototypeExplanation(n, input.uiImpact) +
            (input.strandedHead
              ? STRANDED_COMMITS_NOTE(input.strandedHead, reclaim)
              : ""),
        });
        if (refused) return refused;
      }
      await adapter.postComment(
        n,
        NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE(
          n,
          input.uiImpact,
          labels.needsInfo,
          READY_FOR_AGENT_LABEL,
          aheadOfSeed ? input.issue.branch : null,
          input.strandedHead,
          reclaim,
        ),
      );
      const r = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.needsInfo],
      );
      requireFlip(r, n);
      if (aheadOfSeed) return { kind: "pushed" };
      if (reclaim.kind === "preserved") return keptForPreservedClone(reclaim.reason);
      // Nothing was written this sandbox cycle, so drop the local branch:
      // ensureIssueBranch reuses an existing branch verbatim, and keeping an
      // empty one would pin the next run (after the human supplies the
      // prototype) to a stale origin tip.
      //
      // The off-branch case returned above because its clone is evidence that
      // must outlive the handoff. For an ordinary empty attempt, `-d` refusing
      // is not permission to force: it also refuses when the
      // local source branch merely trails the origin tip we seeded from. And
      // The structural ahead check sees previous HARD-ERROR cycles and branches
      // left by interrupted earlier runs. So escalate to `-D` only once the
      // branch is *verified* to contain nothing that isn't already on origin;
      // otherwise keep it and report the failure. The other force-deleting arms own that
      // certainty by construction (the merger just landed the work, or the
      // silent-noop path deliberately discards it) — this one does not.
      const d = await adapter.deleteBranch(input.issue.branch);
      if (d.ok) return { kind: "deleted-local" };
      if (!(await adapter.branchIsContainedInOrigin(input.issue.branch))) {
        return {
          kind: "kept-branch",
          reason:
            `${d.error ?? "branch -d refused"} — kept: it carries commits that ` +
            `are not on origin (an earlier attempt's work), and this handoff ` +
            `did not push it.`,
        };
      }
      const f = await adapter.forceDeleteBranch(input.issue.branch);
      return f.ok
        ? { kind: "deleted-local" }
        : { kind: "delete-failed", error: f.error ?? d.error ?? "" };
    }
    case "needs-partition": {
      const n = issueNumberOf(input.issue);
      const reclaim = await adapter.reclaimIssueClone(input.issue.branch);
      const aheadOfSeed = await adapter.branchIsAheadOfSeed(input.issue);
      if (aheadOfSeed) {
        const refused = await pushBranchOrPark(input, adapter, labels, {
          context: needsPartitionExplanation(input.budget, input.detail),
        });
        if (refused) return refused;
      }
      await adapter.postComment(
        n,
        NEEDS_PARTITION_COMMENT_TEMPLATE(
          input.cause,
          input.slot,
          input.size,
          input.budget,
          input.detail,
          labels.needsInfo,
          READY_FOR_AGENT_LABEL,
          aheadOfSeed ? input.issue.branch : null,
        ),
      );
      const labelsResult = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.needsInfo],
      );
      requireFlip(labelsResult, n);
      if (aheadOfSeed) return { kind: "pushed" };
      if (reclaim.kind === "preserved") return keptForPreservedClone(reclaim.reason);
      return deleteBranchForcing(adapter, input.issue.branch);
    }
    case "needs-human": {
      const n = issueNumberOf(input.issue);
      const reclaim = await adapter.reclaimIssueClone(input.issue.branch);
      // #17: one renderer selects the exact blocker explanation, including
      // off-branch recovery and any exhausted budget. Publication and label
      // instructions live only in the published form; a refusal receives the
      // same explanation beside the cache recovery recipe.
      const comments = needsHumanComments(input, labels, reclaim);
      const refused = await pushBranchOrPark(input, adapter, labels, {
        context: comments.refused,
      });
      if (refused) return refused;
      await adapter.postComment(n, comments.published);
      const r = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.agentStuck],
      );
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "quota": {
      const n = issueNumberOf(input.issue);
      await adapter.reclaimIssueClone(input.issue.branch);
      const reset = input.resetsAt === undefined
        ? "an unknown time"
        : new Date(input.resetsAt * 1000).toISOString();
      const explanation = quotaExplanation(input.provider, input.window, reset);
      const refused = await pushBranchOrPark(input, adapter, labels, {
        context: explanation,
      });
      if (refused) return refused;
      await adapter.postComment(
        n,
        `${BOT_COMMENT_PREFIX} ${explanation} The branch ` +
          `\`${input.issue.branch}\` was pushed. This issue remains ` +
          `\`ready-for-agent\` for the next run.`,
      );
      return { kind: "pushed" };
    }
    case "credential": {
      const n = issueNumberOf(input.issue);
      const detail = input.detail.trim();
      await adapter.reclaimIssueClone(input.issue.branch);
      const explanation = credentialExplanation(input.provider, detail);
      const refused = await pushBranchOrPark(input, adapter, labels, {
        context: explanation,
      });
      if (refused) return refused;
      await adapter.postComment(
        n,
        `${BOT_COMMENT_PREFIX} ${explanation} The ` +
          `branch \`${input.issue.branch}\` was pushed. This issue remains ` +
          `\`ready-for-agent\` for the next run.`,
      );
      return { kind: "pushed" };
    }
    case "review-budget-exhausted": {
      const n = issueNumberOf(input.issue);
      await adapter.reclaimIssueClone(input.issue.branch);
      const body = REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE(
        input.issue.branch,
        input.budget,
        input.roundsUsed,
        input.latestReviewerProse,
        labels.agentStuck,
        READY_FOR_AGENT_LABEL,
      );
      const refused = await pushBranchOrPark(input, adapter, labels, {
        context: reviewBudgetExhaustedExplanation(
          input.budget,
          input.latestReviewerProse,
        ),
      });
      if (refused) return refused;
      await adapter.postComment(
        n,
        body,
      );
      const r = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.agentStuck],
      );
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "read-only-agent-wrote": {
      const n = issueNumberOf(input.issue);
      // Keep the clone: uncommitted read-only-agent writes cannot travel through a
      // push, and deleting it would destroy the evidence this terminal exists
      // to hand to a human. Reclaiming still publishes the branch first, which
      // is what the push below reads.
      const reclaim = await reclaimClone(input, adapter);
      if (reclaim.kind !== "preserved") {
        throw new Error("read-only agent handoff missing its preserved clone");
      }
      const explanation =
        `${readOnlyAgentWroteStop(input.actor)}\n\n` +
        readOnlyAgentWroteExplanation(input, reclaim);
      const push = await adapter.pushBranch(input.issue.branch);
      if (push.kind === "refused") {
        return parkRefusedPush(input, adapter, labels, push, {
          context: explanation,
        });
      }
      const pushFailure = push.kind === "race"
        ? "the remote branch moved (non-fast-forward)"
        : push.kind === "fatal"
        ? push.reason
        : undefined;
      await adapter.postComment(
        n,
        `${BOT_COMMENT_PREFIX} ${readOnlyAgentWroteStop(input.actor)}\n\n` +
          `${readOnlyAgentWroteExplanation(input, reclaim, pushFailure)}\n\n` +
          handoffAction(
            input.issue.branch,
            labels.agentStuck,
            READY_FOR_AGENT_LABEL,
            "inspect the preserved clone",
          ),
      );
      const r = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.agentStuck],
      );
      requireFlip(r, n);
      return { kind: pushFailure === undefined ? "pushed" : "parked-local" };
    }
    case "hard-error": {
      const reclaim = await adapter.reclaimIssueClone(input.issue.branch);
      if (await adapter.branchIsAheadOfSeed(input.issue)) {
        const refused = await pushBranchOrPark(input, adapter, labels);
        if (refused) return refused;
        // A preserved clone may hold commits the push did not carry (the
        // reason says so when the publish is what failed); name it rather than
        // report a plain push.
        return reclaim.kind === "preserved"
          ? {
              kind: "kept-branch",
              reason: `pushed the cache's copy of the branch and kept the issue clone (${reclaim.reason})`,
            }
          : { kind: "pushed" };
      }
      if (reclaim.kind === "preserved") return keptForPreservedClone(reclaim.reason);
      const r = await adapter.deleteBranch(input.issue.branch);
      return r.ok
        ? { kind: "deleted-local" }
        : { kind: "delete-failed", error: r.error ?? "" };
    }
    case "fresh-attempt": {
      // Same shape as `merged`: worktree first, then branch (with `-D`
      // fallback because the silent-noop branch has commits that aren't on
      // the source branch and `-d` would refuse). No push, no comment, no
      // label flip — the issue stays `ready-for-agent` while its ongoing unit
      // reacquires a pool slot.
      await adapter.reclaimIssueClone(input.issue.branch);
      return deleteBranchForcing(adapter, input.issue.branch);
    }
    case "silent-noop-exhausted": {
      const n = issueNumberOf(input.issue);
      await adapter.reclaimIssueClone(input.issue.branch);
      // The branch from the final silent-noop attempt was already deleted by
      // the merger (we don't push it for human inspection because the work
      // didn't survive the abort). Best-effort delete in case anything's
      // left, but the primary side-effect is the comment + label flip.
      const r = await adapter.deleteBranch(input.issue.branch);
      if (!r.ok) await adapter.forceDeleteBranch(input.issue.branch);
      await adapter.postComment(
        n,
        SILENT_NOOP_EXHAUSTED_COMMENT_TEMPLATE(
          input.attempts,
          labels.agentStuck,
          READY_FOR_AGENT_LABEL,
        ),
      );
      const r2 = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.agentStuck],
      );
      requireFlip(r2, n);
      return { kind: "deleted-local" };
    }
  }
}

export async function finalizeAll(
  inputs: readonly FinalizeInput[],
  adapter: FinalizeAdapter,
  labels: LabelConfig,
): Promise<readonly FinalizeResult[]> {
  const results: FinalizeResult[] = [];
  for (const input of inputs) {
    const action = await finalizeOne(input, adapter, labels);
    results.push({ input, action });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Real adapter — shells out to git and gh.
// ---------------------------------------------------------------------------

export type RealFinalizeAdapterDeps = {
  // Every GIT call below runs in `layout.repoDir`, the bare cache (#38) —
  // including the `git branch -d`/`-D` pair, which is the reason that matters.
  // The worktree path it removes still comes from `layout.worktreesDir`, which
  // is BESIDE the cache rather than inside it. The `gh` calls pass no cwd at
  // all since #34: they name the repository with `--repo`, so no directory is
  // consulted and none can be wrong.
  readonly layout: RepoLayout;
  // The tracker the comment/label/state calls address. NAMED, never inferred
  // from the cache's git remotes (#34): these are the writes that hand an issue
  // to a human, and a `gh` that resolved the repository from a directory would
  // post them wherever that directory's `origin` pointed.
  readonly repo: RepoRef;
  // Needed by branchIsContainedInOrigin: issue branches are seeded from
  // origin/<sourceBranch>, so that ref is what "already preserved" means here.
  //
  // Since #61 that is not the only seed — a chained chunk member is cut from
  // `origin/<chunk branch>` — and this check does not know about the second
  // one. It reads conservatively (false ⇒ keep the branch), so the cost is a
  // kept branch and an error line saying it "carries commits that are not on
  // origin (an earlier attempt's work)" about commits that are on origin, on
  // the chunk branch. Narrow: it needs a chunk member reaching the one arm that
  // asks — a NEEDS-UI-PROTOTYPE handoff whose `branch -d` refused. Fixing it
  // means threading the chunk into this adapter, which is #60's shape, not the
  // seeding change's.
  readonly sourceBranch: string;
  readonly onNotice?: (message: string) => void | Promise<void>;
  // Daemon ownership barrier (#139), immediately before each remote write.
  readonly beforeOriginWrite: OriginWriteBarrier;
};

export function realAdapter(deps: RealFinalizeAdapterDeps): FinalizeAdapter {
  const cwd = deps.layout.repoDir;
  return {
    async pushBranch(branch) {
      // The pure layer decides whether a classified failure is a per-branch
      // refusal to park or a race/transport failure to surface loudly.
      await deps.beforeOriginWrite();
      try {
        await exec("git", ["push", "origin", `${branch}:${branch}`], { cwd });
        return { kind: "ok" };
      } catch (err) {
        return classifyPushError(err);
      }
    },
    async localBranchRecovery(branch) {
      const ref = `refs/heads/${branch}`;
      const { stdout } = await exec("git", ["rev-parse", "--verify", ref], {
        cwd,
      });
      return { tipSha: stdout.trim(), ref, repoDir: cwd };
    },
    async deleteBranch(branch) {
      try {
        await exec("git", ["branch", "-d", branch], { cwd });
        return { ok: true };
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const msg = (e.stderr ?? "").trim() || e.message || String(err);
        return { ok: false, error: msg };
      }
    },
    async forceDeleteBranch(branch) {
      try {
        await exec("git", ["branch", "-D", branch], { cwd });
        return { ok: true };
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const msg = (e.stderr ?? "").trim() || e.message || String(err);
        return { ok: false, error: msg };
      }
    },
    async branchIsAheadOfSeed(issue) {
      try {
        await exec(
          "git",
          ["show-ref", "--verify", "--quiet", `refs/heads/${issue.branch}`],
          { cwd },
        );
      } catch (err) {
        // A setup failure can terminate before ensureIssueBranch creates the
        // ref. That terminal has no branch work to publish; other git failures
        // do not establish absence and must still stop finalization.
        if (isExitCode(err, 1)) return false;
        throw err;
      }
      let seed = `origin/${deps.sourceBranch}`;
      const chunkBranch = issue.chunk?.branch;
      if (chunkBranch) {
        try {
          await exec("git", ["rev-parse", "--verify", "--quiet", `origin/${chunkBranch}`], {
            cwd,
          });
          seed = `origin/${chunkBranch}`;
        } catch (err) {
          if (!isExitCode(err, 1)) throw err;
        }
      }
      const { stdout } = await exec(
        "git",
        ["rev-list", "--count", `${seed}..${issue.branch}`],
        { cwd },
      );
      return Number(stdout.trim()) > 0;
    },
    async branchIsContainedInOrigin(branch) {
      // Exit 0 iff the branch tip is an ancestor of (or equal to) the origin
      // tip — every commit on it is already published. Exit 1 answers false;
      // other failures propagate because they do not establish non-containment.
      try {
        await exec(
          "git",
          [
            "merge-base",
            "--is-ancestor",
            branch,
            `origin/${deps.sourceBranch}`,
          ],
          { cwd },
        );
        return true;
      } catch (err) {
        if (!isExitCode(err, 1)) throw err;
        return false;
      }
    },
    async reclaimIssueClone(branch, keep) {
      const path = worktreePathFor(deps.layout.worktreesDir, branch);
      const reclaim = await reclaimIssueClone(cwd, path, branch, keep);
      if (reclaim.kind === "preserved") {
        await (deps.onNotice ?? ((message: string) => console.error(message)))(
          `Issue clone preserved at ${path}: ${reclaim.reason}`,
        );
      }
      return reclaim;
    },
    async postComment(issueNum, body) {
      // Required: the comment is the issue's handoff payload (questions, failure
      // trace, reviewer prose). A silently-dropped comment strands the human
      // without the context they need — fail loud.
      await deps.beforeOriginWrite();
      try {
        await exec("gh", [
          "issue",
          "comment",
          String(issueNum),
          "--repo",
          repoSlug(deps.repo),
          "--body",
          body,
        ]);
      } catch (err) {
        throw new SandbarError(
          `Failed to post comment on issue #${issueNum}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
    async editLabels(issueNum, remove, add) {
      // Two separate `gh issue edit` calls, remove FIRST. A single combined
      // edit is atomic: if any --add-label target doesn't exist, gh rejects the
      // whole command and the --remove-label never applies — leaving the issue
      // on the agent queue forever. Removing first guarantees the queue-removal
      // lands even when the handoff label is missing/misconfigured (#8).
      const ghEdit = async (flag: "--remove-label" | "--add-label", labelsToApply: readonly string[]): Promise<string | undefined> => {
        if (labelsToApply.length === 0) return undefined;
        const args = [
          "issue",
          "edit",
          String(issueNum),
          "--repo",
          repoSlug(deps.repo),
        ];
        for (const l of labelsToApply) args.push(flag, l);
        await deps.beforeOriginWrite();
        try {
          await exec("gh", args);
          return undefined;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      };

      const removeErr = await ghEdit("--remove-label", remove);
      const addErr = await ghEdit("--add-label", add);
      if (!removeErr && !addErr) return { ok: true };

      // Return the failure structured rather than logging-and-swallowing: a
      // required-handoff caller turns this into a loud SandbarError (requireFlip),
      // while the benign `merged` caller (#7 cosmetic cleanup on a closed issue)
      // ignores it.
      const parts: string[] = [];
      if (removeErr) parts.push(`remove [${remove.join(",")}]: ${removeErr}`);
      if (addErr) parts.push(`add [${add.join(",")}]: ${addErr}`);
      return { ok: false, error: parts.join("; ") };
    },
    async issueState(issueNum) {
      // Required precondition for the handoff guard (#16): if we can't read the
      // issue's state we don't guess — fail loud rather than risk stamping a
      // closed issue or skipping a live handoff. `gh issue view` works on
      // closed issues too.
      try {
        const { stdout } = await exec("gh", [
          "issue",
          "view",
          String(issueNum),
          "--repo",
          repoSlug(deps.repo),
          "--json",
          "state",
        ]);
        const parsed = JSON.parse(stdout) as { state?: string };
        return parsed.state === "CLOSED" ? "CLOSED" : "OPEN";
      } catch (err) {
        throw new SandbarError(
          `Failed to read state of issue #${issueNum} before finalising: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
    async issueLabels(issueNum) {
      try {
        const { stdout } = await exec("gh", [
          "issue", "view", String(issueNum), "--repo", repoSlug(deps.repo),
          "--json", "labels", "--jq", ".labels[].name",
        ]);
        return stdout.split("\n").map((label) => label.trim()).filter(Boolean);
      } catch (err) {
        throw new SandbarError(
          `Failed to read labels of issue #${issueNum} after finalising: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
  };
}
