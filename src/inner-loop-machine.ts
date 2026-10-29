// Pure inner-loop state machine — no I/O. The runner calls step(state, event)
// and executes the returned action; `terminate` ends the loop. Every decision
// (the pre-attempt anchor, partition and UI steps, promise routing, the
// serial quality → gate-1 → verifier order, the quality pass's own
// list → fix → verify loop, per-budget exhaustion, and context-budget parking)
// lives here and is table-driven tested in inner-loop-machine.test.ts.
//
// Every loop opens on `needs-anchor` (#217): the runner condenses the issue
// thread when it is long enough and not already cached, ahead of the
// partition check that measures the anchor. Whether it condensed is the
// runner's business — the machine knows no threshold. `anchor-ready` moves on
// to the partition check, the UI check or the implementer, whichever is the
// first enabled; a condenser that wrote parks the issue like any read-only
// role.
//
// The scenario writer (#203) is a background task around two synchronous
// steps. Wherever the machine first moves to the implementer in a sandbox
// cycle — after the anchor, partition and UI steps clear — a `pending` writer
// routes through `start-scenario-writer` first, whose `scenario-writer-started`
// dispatches attempt 1 at once: nothing waits for the writer. The join is
// `await-scenario-writer`, in front of the verifier slot: a green gate-1 with
// the writer still `running` waits for its result. A write parks the issue
// like any read-only role; any other outcome is recorded as `settled` and the
// verifier runs. The runner passes the task's status into every cycle's
// initial state, so a fresh HARD-ERROR cycle never starts a second writer. No
// budget is touched, and a writer outcome is never a verdict about the branch.
//
// After a clean, on-branch COMPLETE the round is SERIAL (#185, #187): the
// quality pass, then gate-1 ONCE on the head it left, then the verifier only
// on a green gate there. A red gate goes back to the implementer; a failing
// test the quality fixer committed is how a correctness defect reaches it.
//
// The verifier (#180, verifier.ts) holds the slot the correctness pass held,
// with its budget (`correctnessFailures` against `maxReviewRounds`), its
// harness rule and its adjudicator path. Its outcome arrives already combined:
// a write parks, a harness failure takes #41's path, an approval is DONE, and a
// rejection is a list of tagged units charged once, whichever agents it came
// from. `run-verifier` carries the scenario writer's set when it wrote one, so
// the scenario runner joins the white-box review (#238). A rejection keeps the
// white-box verdict beside its units, so a white-box review that produced
// nothing beside a failing scenario is said in both renderings. A rejection is
// kept in two renderings: `latestReviewerFeedback`, which the implementer
// reads, and `latestReviewerPublic`, which is the only one any terminal
// carries, so whatever finalise publishes is the public rendering by
// construction; beside a scenario unit it withholds an upheld ruling's
// reasoning, which may quote the scenario.
//
// The quality pass (#187) is three cold roles. A read-only LISTER walks the
// branch — the whole branch until a quality pass has approved a head, then
// only what changed since that head — and lists every tests/standards finding
// above a verdict. APPROVED goes straight to gate-1. CHANGES-REQUESTED hands
// the report to the writable FIXER, whose text is ignored. A read-only VERIFY
// anchored at the head before the fixer then judges whether each listed item
// was dealt with and whether the fixer's own lines meet the standards, and
// restates every item still open, so the fixer only ever gets the latest
// report. A verify rejection goes back to the fixer. `maxQualityRounds` bounds
// one pass: verify rejections and upheld quality adjudications charge it, and
// running out continues to gate-1 with the open items left in the record. No
// quality outcome reaches the implementer, which does not see the coding
// standards. A lister or verify that produced no review after its retry, or a
// fixer that crashed on its retry too, also continues to gate-1; the runner
// owns those retries. The lister's result may be the runner's fold of one
// lister per rule group (#204); this machine reads it as one review. A lister
// or verify result may also carry findings from the runner's early run of the
// stack's standalone gate steps (#247), which this machine reads as open items
// like any other.
//
// A fixer that exits normally with no commits disputes the latest report:
// once per head, that report goes to the adjudicator. OVERRULED approves the
// head for the quality pass and continues to gate-1, unless the report also
// held step findings: those stay open, so the pass is charged and the fixer
// runs again on them alone. UPHELD charges `maxQualityRounds` and runs the
// fixer once more with the ruling attached; a second refusal at the same head
// takes the budget-exhausted path. A report
// that held only step findings is never adjudicated: a step's verdict is
// mechanical, so its refusal goes straight to gate-1.
//
// Three independent budgets bound non-convergence (#129, #143, #185, #187).
// `gateFailures` counts red gate-1 results AND every attempt that failed to
// produce a commit the gate could judge — NO-SIGNAL, COMPLETE over a dirty
// tree, an unrepaired off-branch HEAD — and every green gate-1 resets it.
// `correctnessFailures` counts verifier rejections only. `qualityFailures`
// is per quality pass and never stops the loop. No counter spends or resets
// another. There is no implementer-attempt budget: `attempt` remains only a
// sequence number.
//
// Reviewer harness failure keeps #41's separate rule for the verifier and its
// adjudicator: it charges no budget. `reviewerHarnessFailures` is a
// per-inner-loop total that never resets; its second failure terminates.
//
// A COMPLETE claim is routed on THREE inputs, not one: the promise token, a
// clean worktree (#24 D1), and HEAD still being the issue branch (#27). The
// runner repairs an ancestor mismatch before this event (#127); a surviving
// mismatch runs FIRST because it subsumes the dirty check: commits on a
// detached HEAD leave a CLEAN tree, so the gate would go green on a tree the
// branch does not contain (git-ops.ts spells out the reachable shape).
// COMPLETE + dirty spends an attempt on a re-prompt to commit rather than
// dispatching the round. The branch check also applies to NO-SIGNAL; the
// hand-to-human terminals NEEDS-INFO and NEEDS-UI-PROTOTYPE (#21, stops
// before the round) are exempt — they land nothing by construction.
//
// A zero-commit COMPLETE at the head of a pending verifier rejection enters
// one adjudication per head (#167). UPHELD keeps the original charge and makes
// another zero-commit attempt take the ordinary round; OVERRULED finishes the
// issue as approved. A report with scenario units is ruled unit by unit
// (#239), and is UPHELD when any unit is: the implementer then gets only the
// upheld units, with the overruled ones named. Every unit OVERRULED is an
// approval unless the white-box review produced nothing at that head; then
// the verifier runs again at the same head, unbudgeted, since unreviewed code
// never reads as DONE.
//
// A reviewer that produced NO review is not a verdict (#41); that judgment is
// reviewer-run.ts's. `reviewer-harness-failed` consumes no review round,
// leaves retained reviewer feedback untouched, and names itself in exhaustion
// rather than a rejection. The next implementer attempt is dispatched anyway
// — unreviewed work must not read as DONE — with an orchestrator note,
// not a finding.
//
// A gate-1 result that carries a stack change — the branch edits its gate
// stack file beyond container `env` (#186, stack-change.ts) — ends the loop
// with NEEDS-STACK-CHANGE, green or red, and charges no budget: a green on the
// source tip's stack never exercised the branch's stack, and landing would
// have to refuse the ungated grader change anyway. The gate verdict rides
// along as evidence for the human: green means the edit is not needed, red
// means it has to land first.
//
// HARD-ERROR is not a verdict the SM ever emits — it's how the runner wraps
// unhandled exceptions; decideAfterTerminal answers "retry with a fresh
// sandbox or surface?" for the runner's outer loop.

import type { AdjudicationRuling } from "./adjudication-parser.js";
import type { HeadMismatch } from "./git-ops.js";
import type { ParseSignal } from "./promise-parser.js";
import type { UiCheckResult } from "./ui-check-parser.js";
import type { PartitionCheckResult } from "./partition-check-parser.js";
import { loadTemplate } from "./prompts.js";
import type { ScenarioSet } from "./scenario-parser.js";
import type { StackChange } from "./stack-change.js";
import {
  type ScenarioTally,
  type VerifierOutcome,
  type VerifierUnit,
  type WhiteBoxVerdict,
  renderRejection,
} from "./verifier.js";

const ADJUDICATOR_HARNESS_FAILED_REPROMPT = loadTemplate(
  "implementer-adjudicator-harness-failed",
);

export type ContextSlot =
  | "partition-check"
  | "ui-check"
  | "implementer"
  | "adjudication"
  | "review-quality"
  | "review-correctness";

// The two reviewing passes an adjudicator can rule on (#167, #187).
export type ReviewPass = "quality" | "correctness";

// A rejected report at the head it judged: the quality report a zero-commit
// fixer disputed (#187), or a verifier rejection.
export type PendingRejection = {
  readonly round: number;
  readonly head: string;
  readonly report: string;
};

// The verifier rejection the next zero-commit attempt may dispute (#167): its
// `report` is the units' private rendering, and the units keep the public one.
export type VerifierRejection = PendingRejection & {
  readonly units: readonly VerifierUnit[];
  readonly whiteBox: WhiteBoxVerdict;
};

// What a quality lister or the verifier's white-box review reads (#187, #180):
// the whole branch, or only what changed since an earlier head.
export type ReviewScope =
  | { readonly kind: "full" }
  | { readonly kind: "since"; readonly sha: string };

// How a round's quality pass ended (#187). CHANGES-REQUESTED means the budget
// ran out with items open; REVIEW-FAILED that a lister, verify or quality
// adjudicator produced nothing; FIX-FAILED that the fixer crashed on its retry.
export type QualityOutcome = {
  readonly verdict:
    | "APPROVED"
    | "OVERRULED"
    | "CHANGES-REQUESTED"
    | "REVIEW-FAILED"
    | "FIX-FAILED";
  // `qualityFailures` spent by the pass.
  readonly rounds: number;
};

// How the scenario writer's one run per admission ended (#203). `failed`
// covers every failure that is not sandbar's own and an answer still
// malformed after its nudge.
export type ScenarioWriterOutcome =
  | { readonly kind: "written"; readonly set: ScenarioSet }
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "wrote"; readonly detail: string };

// The writer as the machine sees it. A write never settles: the join hears it
// and parks.
export type ScenarioWriterStatus =
  | { readonly kind: "off" }
  | { readonly kind: "pending" }
  | { readonly kind: "running" }
  | {
      readonly kind: "settled";
      readonly outcome: Exclude<ScenarioWriterOutcome, { readonly kind: "wrote" }>;
    };

export const HARD_ERROR_MAX_RETRIES = 2;
export const REVIEWER_HARNESS_FAILURE_LIMIT = 2;

export type LoopPhase =
  | "needs-anchor"
  | "needs-partition-check"
  | "needs-ui-check"
  | "needs-scenario-writer-start"
  | "needs-implementer"
  | "needs-quality-list"
  | "needs-quality-fix"
  | "needs-quality-verify"
  | "needs-gate"
  | "needs-scenario-writer-result"
  | "needs-verifier"
  | "needs-adjudicator"
  | "terminated";

export type LoopState = {
  readonly issueBranch: string;
  readonly maxQualityRounds: number;
  readonly maxGateRounds: number;
  readonly maxReviewRounds: number;
  readonly attempt: number;
  // Spent by the current quality pass; reset when a lister opens one.
  readonly qualityFailures: number;
  readonly gateFailures: number;
  readonly correctnessFailures: number;
  readonly lastFailureTrace: string;
  readonly lastFailedStep: string | null;
  readonly extraReprompt: string | null;
  // The latest verifier rejection's prose, with any upheld adjudication
  // prepended. The quality pass never hands the implementer feedback.
  readonly latestReviewerFeedback: string | null;
  // The same rejection in its public rendering: what every terminal carries.
  readonly latestReviewerPublic: string | null;
  // The dirty set that sent the PREVIOUS attempt back to commit its work, or
  // null if the last attempt didn't end that way. Only used to detect that an
  // attempt changed nothing — see onImplementerResult.
  readonly lastDirtyPaths: readonly string[] | null;
  // Whether the PREVIOUS attempt was sent back because HEAD was not the issue
  // branch (#27). One re-prompt is offered; a second consecutive off-branch
  // attempt terminates — see onImplementerResult.
  readonly lastOffBranch: boolean;
  // Total verifier or adjudicator runs in this inner loop that yielded no
  // review at all (#41, #143). Never reset: infrastructure faults are bounded
  // independently of convergence streaks.
  readonly reviewerHarnessFailures: number;
  readonly pendingRejection: VerifierRejection | null;
  // Heads whose verifier rejection has already been adjudicated once.
  readonly adjudicatedHeads: readonly string[];
  readonly upheldAdjudication: {
    readonly head: string;
    readonly reasoning: string;
    // Whether it ruled on a scenario unit, so its reasoning may quote one.
    readonly ruledScenarios: boolean;
  } | null;
  // The latest CHANGES-REQUESTED quality report — the lister's, or the
  // verify's restatement of what is still open. The fixer's input.
  readonly qualityReport: string | null;
  // An upheld quality adjudication's reasoning, for the next fixer only.
  readonly qualityRuling: string | null;
  // Fixer dispatches in the current quality pass; numbers its steps.
  readonly qualityFixRounds: number;
  // The head a quality pass last approved, or whose quality report an
  // adjudicator overruled. Anchors a later lister's scope.
  readonly qualityApprovedHead: string | null;
  // Heads whose quality report has already been adjudicated once.
  readonly qualityAdjudicatedHeads: readonly string[];
  // What the adjudicator now running was asked to judge.
  readonly adjudicating:
    | {
        readonly pass: "quality";
        readonly rejection: PendingRejection;
        // The report's gate-step findings, which no ruling closes (#247).
        readonly stepFindings: string | null;
      }
    | { readonly pass: "correctness"; readonly rejection: VerifierRejection }
    | null;
  readonly uiPrototypeCheck: boolean;
  readonly partitionCheck: boolean;
  readonly scenarioWriter: ScenarioWriterStatus;
  readonly phase: LoopPhase;
};

// Verdict is the pure terminal value the SM emits. The runner translates it
// into a Terminal for the outer orchestrator. HARD-ERROR is never emitted by
// the SM itself — it's the runner's wrapper for unhandled exceptions and
// lives in this type only so decideAfterTerminal can pattern-match on it.
export type Verdict =
  | { readonly type: "DONE" }
  | {
      readonly type: "NEEDS-INFO";
      readonly questions: string;
      // Where HEAD was when the agent asked, if it was not the issue branch
      // (#27). These two terminals are exempt from the off-branch correction —
      // see onImplementerResult — but exempt must not mean silent: whatever the
      // agent committed off the branch is about to be deleted along with the
      // worktree, and this is the only record of where it went.
      readonly strandedHead: HeadMismatch | null;
    }
  | {
      // #21/#126 — either the pre-attempt checker, or an implementer that
      // discovered UI work later, judged the issue to imply non-trivial
      // user-visible UI with no prototype. Immediate terminal: no gate or
      // reviewer. The classification itself spends no attempt.
      readonly type: "NEEDS-UI-PROTOTYPE";
      readonly uiImpact: string;
      // As NEEDS-INFO above, and the case is sharper here: #21 accepts a LATE
      // escalation precisely so an agent that has already written code can stop,
      // and finalize pushes the branch when it has commits. Off the branch it
      // has none to push, so without this the partial work vanishes unrecorded.
      readonly strandedHead: HeadMismatch | null;
    }
  | {
      readonly type: "NEEDS-PARTITION";
      readonly cause: "classifier" | "measured" | "provider-refused";
      readonly slot: ContextSlot;
      readonly size: number;
      readonly budget: number;
      readonly detail: string;
    }
  | {
      // Gate budget exhausted, or a dedicated early-stop rule fired.
      // `cause` names the real blocker so the human handoff is accurate:
      //   gate-red — the last gate failed;
      //     `failureTrace` carries the gate trace.
      //   no-signal-exhausted — the last attempt did not produce an actionable
      //     promise signal; `failureTrace` carries its parser correction and
      //     any gate trace preserved from an earlier attempt.
      //   uncommittable-worktree — the implementer reported COMPLETE over a
      //     dirty tree and a further attempt left the dirty set UNCHANGED, so
      //     it is something the agent cannot remove (a file written by a gate
      //     container under another uid, a step's non-gitignored exhaust).
      //     `failureTrace` carries the paths. Distinct from gate-red because
      //     no gate ran on the deciding attempt.
      //   off-branch-head — the implementer committed somewhere other than
      //     `refs/heads/<branch>` (detached HEAD, or a branch of its own) and a
      //     second consecutive attempt was still off it (#27). `failureTrace`
      //     carries where HEAD actually is, which is the only handle anyone has
      //     on the stranded commits once the worktree is removed.
      //   reviewer-harness-failed — the verifier or adjudicator
      //     produced nothing twice in this inner loop (#41/#143). `failureTrace`
      //     carries why every invocation in the latest failed run yielded
      //     nothing. `latestReviewerProse` is whatever an EARLIER round said,
      //     if any — never the harness error.
      // Like every terminal's `latestReviewerProse`, it is the public
      // rendering (`latestReviewerPublic`).
      readonly type: "NEEDS-HUMAN";
      readonly cause:
        | "gate-red"
        | "no-signal-exhausted"
        | "uncommittable-worktree"
        | "off-branch-head"
        | "reviewer-harness-failed";
      readonly failureTrace: string;
      readonly latestReviewerProse: string | null;
      // Present exactly when the gate budget, rather than a dedicated
      // early-stop rule, ended the loop. `failedStep` is null when the
      // deciding attempt never reached the gate (#185 charges those here).
      readonly budgetExhausted: {
        readonly budget: "gate";
        readonly roundsUsed: number;
        readonly failedStep: string | null;
      } | null;
      // Set only by `off-branch-head`, so finalize can render the rescue note
      // from structure rather than parse it back out of the trace prose.
      readonly strandedHead: HeadMismatch | null;
    }
  | {
      readonly type: "NEEDS-HUMAN-REVIEW";
      readonly latestReviewerProse: string;
      readonly cause: "correctness-budget-exhausted";
      readonly roundsUsed: number;
    }
  | {
      readonly type: "NEEDS-HUMAN-REVIEW";
      readonly latestReviewerProse: string;
      readonly cause:
        | "reviewer-wrote"
        | "verifier-wrote"
        | "quality-reviewer-wrote"
        | "adjudicator-wrote"
        | "ui-checker-wrote"
        | "partition-checker-wrote"
        | "anchor-condenser-wrote"
        | "scenario-writer-wrote";
    }
  | {
      // The branch changes its gate stack beyond container env (#186). `gate`
      // is gate-1's verdict on the source tip's stack.
      readonly type: "NEEDS-STACK-CHANGE";
      readonly stackChange: StackChange;
      readonly gate: Gate1Result;
    }
  | { readonly type: "HARD-ERROR"; readonly reason: string }
  | {
      readonly type: "QUOTA";
      readonly provider: "claude" | "codex";
      readonly window: string;
      readonly resetsAt?: number;
    }
  | {
      readonly type: "CREDENTIAL";
      readonly provider: "codex";
      readonly detail: string;
    };

export type LoopAction =
  | { readonly kind: "run-anchor-condense" }
  | { readonly kind: "run-partition-check" }
  | { readonly kind: "run-ui-check" }
  | { readonly kind: "start-scenario-writer" }
  | {
      readonly kind: "run-implementer";
      readonly attempt: number;
      readonly failureTrace: string;
      readonly extraReprompt: string | null;
      readonly latestReviewerFeedback: string | null;
    }
  | {
      readonly kind: "run-quality-list";
      readonly attempt: number;
      readonly scope: ReviewScope;
    }
  | {
      readonly kind: "run-quality-fix";
      readonly attempt: number;
      readonly fixRound: number;
      readonly report: string;
      readonly ruling: string | null;
    }
  | {
      readonly kind: "run-quality-verify";
      readonly attempt: number;
      readonly fixRound: number;
      // The head before the fixer ran: verify reads only what changed since.
      readonly anchor: string;
      readonly report: string;
    }
  | {
      readonly kind: "run-gate";
      readonly attempt: number;
      // Record material for the round's `review-round` event; gate-1 runs
      // whatever the pass ended with.
      readonly quality: QualityOutcome;
    }
  | { readonly kind: "await-scenario-writer" }
  | {
      readonly kind: "run-verifier";
      readonly attempt: number;
      // The scenario writer's set when it wrote one; null runs the white-box
      // review alone.
      readonly scenarios: ScenarioSet | null;
    }
  | {
      readonly kind: "run-adjudicator";
      readonly attempt: number;
      readonly pass: "correctness";
      readonly rejection: VerifierRejection;
    }
  | {
      readonly kind: "run-adjudicator";
      readonly attempt: number;
      readonly pass: "quality";
      readonly fixRound: number;
      readonly rejection: PendingRejection;
    }
  | { readonly kind: "terminate"; readonly verdict: Verdict };

// The UI phase is derived from the machine's transition result, never guessed
// by the I/O runner (#132).
export function visiblePhases(
  action: LoopAction,
): readonly (
  | "anchor"
  | "partition-check"
  | "ui-check"
  | "implementer"
  | "quality"
  | "gate-1"
  | "scenarios"
  | "review"
  | "adjudication"
)[] {
  switch (action.kind) {
    case "run-anchor-condense": return ["anchor"];
    case "run-partition-check": return ["partition-check"];
    case "run-ui-check": return ["ui-check"];
    // Returns at once; attempt 1 is the phase that follows.
    case "start-scenario-writer": return [];
    case "run-implementer": return ["implementer"];
    case "run-quality-list":
    case "run-quality-fix":
    case "run-quality-verify":
      return ["quality"];
    case "run-gate": return ["gate-1"];
    case "await-scenario-writer": return ["scenarios"];
    case "run-verifier": return ["review"];
    case "run-adjudicator": return ["adjudication"];
    case "terminate": return [];
  }
}

export type LoopEvent =
  | { readonly kind: "anchor-ready" }
  | { readonly kind: "anchor-condenser-wrote"; readonly detail: string }
  | {
      readonly kind: "partition-check-result";
      readonly result: PartitionCheckResult;
      readonly size: number;
      readonly budget: number;
    }
  | { readonly kind: "partition-checker-wrote"; readonly detail: string }
  | { readonly kind: "ui-check-result"; readonly result: UiCheckResult }
  | { readonly kind: "ui-checker-wrote"; readonly detail: string }
  | { readonly kind: "scenario-writer-started" }
  | { readonly kind: "scenario-writer-result"; readonly outcome: ScenarioWriterOutcome }
  | {
      readonly kind: "context-over-budget";
      readonly slot: ContextSlot;
      readonly size: number;
      readonly budget: number;
      readonly detail: string;
    }
  | {
      readonly kind: "implementer-result";
      readonly signal: ParseSignal;
      // `git status --porcelain` lines in the issue worktree after the attempt
      // (#24 D1). A COMPLETE claim over a dirty tree is not a claim about any
      // commit — the gate bind-mounts this worktree, so gating it would produce
      // a verdict the merger cannot reproduce from the branch.
      readonly dirtyPaths: readonly string[];
      // Where HEAD is, when it is not `refs/heads/<branch>`; null when it is
      // (#27). An ancestor mismatch repaired by the runner arrives as null
      // (#127). A clean tree says nothing about this — that is the whole gap.
      readonly offBranch: HeadMismatch | null;
      // The ref advance the runner safely completed before building this event,
      // or null. It is prompt context only: the repair is free and does not
      // consume the off-branch correction.
      readonly fastForwarded: {
        readonly fromSha: string;
        readonly toSha: string;
      } | null;
      readonly commits: number;
      readonly head: string;
    }
  | {
      // A quality lister or verify outcome at `head` (#187). Same shape as the
      // verifier's white-box review: a verdict, no review, or a write.
      readonly kind: "quality-review-result";
      readonly mode: "list" | "verify";
      readonly head: string;
      readonly review: ReviewerResult;
    }
  | {
      // What the fixer left (#187). Its text is ignored; whether it committed
      // and whether its process exited normally are the only inputs.
      readonly kind: "quality-fix-result";
      // The head before the fixer's first invocation, and after its last.
      readonly startHead: string;
      readonly head: string;
      readonly commits: number;
      readonly exited: "completed" | "failed";
      // The gate-step findings of the report it was given (#247), and whether
      // they were all it held; null when it held none.
      readonly steps: { readonly findings: string; readonly only: boolean } | null;
    }
  | {
      readonly kind: "gate-result";
      readonly gate: Gate1Result;
      // What the branch changed in its gate stack beyond env, when it did; the
      // gate then ran on the source tip's stack alone (#186).
      readonly stackChange: StackChange | null;
      // The head gated — the one the quality pass left. Record material for
      // the runner's `review-round` event; no transition reads it.
      readonly head: string;
    }
  | {
      readonly kind: "verifier-result";
      readonly head: string;
      readonly outcome: VerifierOutcome;
      // How the round's scenarios ended, null when it selected none. Record
      // material for the runner's `review-round` event; no transition reads it.
      readonly scenarios: ScenarioTally | null;
    }
  | {
      readonly kind: "adjudicator-result";
      readonly head: string;
      // With `rulings`, UPHELD exactly when some unit is.
      readonly ruling: AdjudicationRuling;
      // Each unit's ruling, keyed by unit id, for a verifier report with
      // scenario units; null for one ruled as a whole.
      readonly rulings: Readonly<Record<string, AdjudicationRuling>> | null;
      readonly reasoning: string;
    }
  | { readonly kind: "adjudicator-wrote"; readonly detail: string }
  | { readonly kind: "adjudicator-harness-failed"; readonly detail: string };

export type Gate1Result = {
  readonly ok: boolean;
  readonly failureTrace: string;
  readonly failedStep: string | null;
};

// What one read-only review yielded: the verifier's white-box review, or a
// quality lister or verify (#41, #98, #187).
export type ReviewerResult =
  | {
      readonly kind: "reviewer-result";
      readonly verdict: "APPROVED" | "CHANGES-REQUESTED";
      readonly prose: string;
    }
  | {
      // The reviewer was invoked its full invocation budget and none of the runs
      // produced a review (#41). NOT a verdict — see the module header for what
      // that changes. `detail` says why each invocation yielded nothing; it is
      // diagnostics, never prose attributed to the reviewer.
      readonly kind: "reviewer-harness-failed";
      readonly detail: string;
    }
  | { readonly kind: "reviewer-wrote"; readonly detail: string };

export type StepResult = {
  readonly state: LoopState;
  readonly action: LoopAction;
};

export type InitialStateOptions = {
  readonly issueBranch: string;
  readonly maxQualityRounds: number;
  readonly maxGateRounds: number;
  readonly maxReviewRounds: number;
  readonly uiPrototypeCheck: boolean;
  readonly partitionCheck: boolean;
  // The admission's writer task as it stands at this cycle's start.
  readonly scenarioWriter: ScenarioWriterStatus;
};

export function initialState(opts: InitialStateOptions): LoopState {
  for (const budget of ["maxQualityRounds", "maxGateRounds", "maxReviewRounds"] as const) {
    if (!Number.isInteger(opts[budget]) || opts[budget] < 1) {
      throw new Error(`${budget} must be a positive integer, got ${opts[budget]}`);
    }
  }
  return {
    issueBranch: opts.issueBranch,
    maxQualityRounds: opts.maxQualityRounds,
    maxGateRounds: opts.maxGateRounds,
    maxReviewRounds: opts.maxReviewRounds,
    attempt: 1,
    qualityFailures: 0,
    gateFailures: 0,
    correctnessFailures: 0,
    lastFailureTrace: "",
    lastFailedStep: null,
    extraReprompt: null,
    latestReviewerFeedback: null,
    latestReviewerPublic: null,
    lastDirtyPaths: null,
    lastOffBranch: false,
    reviewerHarnessFailures: 0,
    pendingRejection: null,
    adjudicatedHeads: [],
    upheldAdjudication: null,
    qualityReport: null,
    qualityRuling: null,
    qualityFixRounds: 0,
    qualityApprovedHead: null,
    qualityAdjudicatedHeads: [],
    adjudicating: null,
    uiPrototypeCheck: opts.uiPrototypeCheck,
    partitionCheck: opts.partitionCheck,
    scenarioWriter: opts.scenarioWriter,
    phase: "needs-anchor",
  };
}

// Attempt 1, behind the scenario writer's start when it is still pending.
const toImplementer = (state: LoopState): LoopPhase =>
  state.scenarioWriter.kind === "pending"
    ? "needs-scenario-writer-start"
    : "needs-implementer";

// The first enabled pre-attempt check after the anchor, else the implementer.
const afterAnchor = (state: LoopState): LoopPhase =>
  state.partitionCheck
    ? "needs-partition-check"
    : state.uiPrototypeCheck
      ? "needs-ui-check"
      : toImplementer(state);

export function initialAction(state: LoopState): LoopAction {
  if (state.phase === "needs-anchor") return { kind: "run-anchor-condense" };
  if (state.phase === "needs-partition-check") return { kind: "run-partition-check" };
  if (state.phase === "needs-ui-check") return { kind: "run-ui-check" };
  if (state.phase === "needs-scenario-writer-start") return { kind: "start-scenario-writer" };
  return {
    kind: "run-implementer",
    attempt: state.attempt,
    failureTrace: state.lastFailureTrace,
    extraReprompt: state.extraReprompt,
    latestReviewerFeedback: state.latestReviewerFeedback,
  };
}

const EVENT_PHASE: Readonly<Record<
  Exclude<LoopEvent["kind"], "context-over-budget" | "quality-review-result">,
  LoopPhase
>> = {
  "anchor-ready": "needs-anchor",
  "anchor-condenser-wrote": "needs-anchor",
  "partition-check-result": "needs-partition-check",
  "partition-checker-wrote": "needs-partition-check",
  "ui-check-result": "needs-ui-check",
  "ui-checker-wrote": "needs-ui-check",
  "scenario-writer-started": "needs-scenario-writer-start",
  "scenario-writer-result": "needs-scenario-writer-result",
  "implementer-result": "needs-implementer",
  "quality-fix-result": "needs-quality-fix",
  "gate-result": "needs-gate",
  "verifier-result": "needs-verifier",
  "adjudicator-result": "needs-adjudicator",
  "adjudicator-wrote": "needs-adjudicator",
  "adjudicator-harness-failed": "needs-adjudicator",
};

const expectedPhase = (
  event: Exclude<LoopEvent, { kind: "context-over-budget" }>,
): LoopPhase =>
  event.kind === "quality-review-result"
    ? event.mode === "list" ? "needs-quality-list" : "needs-quality-verify"
    : EVENT_PHASE[event.kind];

// A role measures its own context before it runs (#158): the partition check
// its anchor, and the quality roles and the verifier the branch
// picture they are about to read. Gate-1 reads no prompt and measures nothing.
const CONTEXT_MEASURING_PHASES: readonly LoopPhase[] = [
  "needs-partition-check",
  "needs-implementer",
  "needs-quality-list",
  "needs-quality-fix",
  "needs-quality-verify",
  "needs-verifier",
];

export function step(state: LoopState, event: LoopEvent): StepResult {
  if (state.phase === "terminated") {
    throw new Error("inner-loop machine stepped after termination");
  }

  if (event.kind === "context-over-budget") {
    if (!CONTEXT_MEASURING_PHASES.includes(state.phase)) {
      throw new Error(`context-over-budget event in phase ${state.phase}`);
    }
    return terminate(state, {
      type: "NEEDS-PARTITION",
      cause: "measured",
      slot: event.slot,
      size: event.size,
      budget: event.budget,
      detail: event.detail,
    });
  }

  const expected = expectedPhase(event);
  if (state.phase !== expected) {
    throw new Error(
      `${event.kind} event in phase ${state.phase}; expected ${expected}`,
    );
  }

  switch (event.kind) {
    case "anchor-condenser-wrote":
      return terminate(state, {
        type: "NEEDS-HUMAN-REVIEW",
        cause: "anchor-condenser-wrote",
        latestReviewerProse: event.detail,
      });

    case "anchor-ready": {
      const afterAnchorState: LoopState = { ...state, phase: afterAnchor(state) };
      return { state: afterAnchorState, action: initialAction(afterAnchorState) };
    }

    case "partition-checker-wrote":
      return terminate(state, {
        type: "NEEDS-HUMAN-REVIEW",
        cause: "partition-checker-wrote",
        latestReviewerProse: event.detail,
      });

    case "partition-check-result": {
      if (event.result.kind === "PARTITION") {
        return terminate(state, {
          type: "NEEDS-PARTITION",
          cause: "classifier",
          slot: "partition-check",
          size: event.size,
          budget: event.budget,
          detail: event.result.reason,
        });
      }
      const afterPartition: LoopState = {
        ...state,
        phase: state.uiPrototypeCheck ? "needs-ui-check" : toImplementer(state),
      };
      return { state: afterPartition, action: initialAction(afterPartition) };
    }

    case "ui-checker-wrote":
      return terminate(state, {
        type: "NEEDS-HUMAN-REVIEW",
        cause: "ui-checker-wrote",
        latestReviewerProse: event.detail,
      });

    case "ui-check-result": {
      if (event.result.kind === "PROTOTYPE-NEEDED") {
        return terminate(state, {
          type: "NEEDS-UI-PROTOTYPE",
          uiImpact: event.result.uiImpact,
          strandedHead: null,
        });
      }
      const nextState: LoopState = { ...state, phase: toImplementer(state) };
      return { state: nextState, action: initialAction(nextState) };
    }

    case "scenario-writer-started": {
      const started: LoopState = {
        ...state,
        scenarioWriter: { kind: "running" },
        phase: "needs-implementer",
      };
      return { state: started, action: initialAction(started) };
    }

    case "scenario-writer-result":
      return event.outcome.kind === "wrote"
        ? terminate(state, {
            type: "NEEDS-HUMAN-REVIEW",
            cause: "scenario-writer-wrote",
            latestReviewerProse: event.outcome.detail,
          })
        : toVerifier({
            ...state,
            scenarioWriter: { kind: "settled", outcome: event.outcome },
          });

    case "implementer-result":
      return onImplementerResult(state, event);

    case "quality-review-result":
      return onQualityReviewResult(state, event);

    case "quality-fix-result":
      return onQualityFixResult(state, event);

    case "gate-result":
      return event.stackChange === null
        ? onGateResult(state, event.gate)
        : terminate(state, {
            type: "NEEDS-STACK-CHANGE",
            stackChange: event.stackChange,
            gate: event.gate,
          });

    case "verifier-result":
      return onVerifierResult(state, event.head, event.outcome);

    case "adjudicator-result":
      return onAdjudicatorResult(state, event);

    case "adjudicator-wrote":
      return terminate(state, {
        type: "NEEDS-HUMAN-REVIEW",
        cause: "adjudicator-wrote",
        latestReviewerProse: event.detail,
      });

    case "adjudicator-harness-failed": {
      const adjudicating = requireAdjudicating(state);
      const next: LoopState = { ...state, adjudicating: null };
      // A quality adjudicator that produced nothing is a quality review that
      // failed: the pass ends and the round goes on (#187).
      if (adjudicating.pass === "quality") return toGate(next, "REVIEW-FAILED");
      return onReviewerHarnessFailed(
        next,
        `adjudicator: ${event.detail}`,
        ADJUDICATOR_HARNESS_FAILED_REPROMPT,
      );
    }
  }
}

function requireAdjudicating(
  state: LoopState,
): NonNullable<LoopState["adjudicating"]> {
  if (state.adjudicating === null) {
    throw new Error("adjudicator event with no adjudication dispatched");
  }
  return state.adjudicating;
}

// How many dirty paths to name before eliding. The list is a prompt to an
// agent that can run `git status` itself; twenty is enough to make the problem
// concrete without spending the context window on it.
const MAX_DIRTY_PATHS_SHOWN = 20;

// The re-prompt for a COMPLETE claim over a dirty worktree (#24 D1). Exported
// so the wording is asserted where the routing is.
export function uncommittedWorkReprompt(
  dirtyPaths: readonly string[],
): string {
  const shown = dirtyPaths.slice(0, MAX_DIRTY_PATHS_SHOWN);
  const elided = dirtyPaths.length - shown.length;
  return [
    "You reported COMPLETE, but the worktree still has uncommitted changes, so",
    "there is no commit that means what you said. The gate runs against this",
    "worktree and the merger will only ever see your commits — anything left",
    "uncommitted is invisible to it and would be lost.",
    "",
    "`git status --porcelain` reports:",
    ...shown.map((p) => `  ${p}`),
    ...(elided > 0 ? [`  … and ${elided} more`] : []),
    "",
    "Commit the work that belongs to this issue (or remove what does not), then",
    "report COMPLETE again. Note that build artifacts your gate steps produce",
    "must be gitignored — if they are showing up here, that is the bug to fix.",
  ].join("\n");
}

// The re-prompt for a non-ancestor HEAD that is not the issue branch (#27/#127).
// Exported so the
// wording is asserted where the routing is, and reused verbatim as the
// NEEDS-HUMAN trace — the shas in it are the only handle on the stranded
// commits once the worktree (and its HEAD reflog) is removed.
//
// The ancestor case never reaches this function: the runner has gathered that
// evidence and advanced the ref without rewriting history. Every mismatch left
// here is unsafe to force because HEAD is older/diverged or the branch is gone.
export function offBranchHeadReprompt(m: HeadMismatch): string {
  const where =
    m.headRef === null
      ? `HEAD is DETACHED at ${m.headSha}`
      : `HEAD is on \`${m.headRef}\`, at ${m.headSha}`;
  return [
    `You are not on the issue branch. ${where}, but this issue's branch is`,
    `\`${m.branch}\`, still at ${m.branchSha ?? "(the branch does not exist)"}.`,
    "",
    "Any commit you made is therefore not on `" + m.branch + "`. The merger only",
    "ever reads that branch, so as things stand your work would be silently",
    "dropped and the issue closed with nothing landed.",
    "",
    "Get back onto `" + m.branch + "` with your commits on it.",
    "Do not force the ref — it would discard whatever is on the branch that",
    "your HEAD does not have. Check the branch out and bring your commits over",
    "with `git cherry-pick` or `git merge`.",
    "",
    "Verify with `git rev-parse --symbolic-full-name HEAD` before you report",
    "again. Do not report COMPLETE until that prints `refs/heads/" + m.branch + "`.",
  ].join("\n");
}

function offBranchFastForwardedNote(issueBranch: string, fastForwarded: {
  readonly fromSha: string;
  readonly toSha: string;
}): string {
  return (
    `The orchestrator moved \`${issueBranch}\` from ${fastForwarded.fromSha} to ` +
    `the attempt's HEAD at ${fastForwarded.toSha}; HEAD is now on that branch.`
  );
}

function joinOrchestratorNotes(
  ...notes: readonly (string | null)[]
): string | null {
  const present = notes.filter((note): note is string => note !== null);
  return present.length === 0 ? null : present.join("\n\n");
}

// The orchestrator note for an attempt whose verifier's code review produced
// no review (#41). Exported so the wording is asserted where the routing is.
//
// It goes in the ORCHESTRATOR NOTE slot, not the reviewer-feedback slot, and
// that is the whole point of the terminal: the previous behaviour handed the
// implementer `reviewer run errored: Agent idle for 600 seconds` under a
// "Previous reviewer feedback (CHANGES-REQUESTED)" heading, so an agent whose
// work had just passed a green gate was told it had been reviewed and rejected,
// by a reviewer that never read a line of it. This note therefore says three
// things and no more: what happened, that nothing was said about the code THIS
// ROUND, and that the green gate still stands.
//
// `latestReviewerFeedback` is carried forward untouched, so `renderAttemptSlot`
// may render an EARLIER round's real report directly above this note. A note
// saying there is no reviewer feedback above would then be false, so the note
// names the two cases explicitly rather than asserting either.
//
// It deliberately quotes NONE of the harness detail. The detail names an idle
// timeout in seconds and a podman exec — an implementer cannot act on any of it
// from inside its sandbox, and an agent handed a failure it cannot fix will
// try anyway. That text goes to the run log and, if this recurs, to the human
// handoff, which are the two places someone can do something with it.
export function reviewerHarnessFailedReprompt(
  hasPriorRejection: boolean,
): string {
  return [
    "The verifier's code review could not be run this round: every invocation",
    "returned no review at all. That is a fault in the orchestrator's harness,",
    "not a finding about your work — nothing was said about your code this",
    "round, and the review budget was not charged for it.",
    "",
    "Gate-1 passed on the branch's last commit, and that verdict stands. Do not",
    "rework or revert anything on the strength of this note. There is no NEW reviewer",
    ...(hasPriorRejection
      ? [
          "feedback. The retained CHANGES-REQUESTED report above is from an earlier",
          "round; its concerns still stand and are still what to address.",
        ]
      : ["feedback. No reviewer has said anything about this branch at all."]),
    "",
    "Use this attempt for whatever you already knew was outstanding. If the work",
    "is genuinely finished, confirm the worktree is clean and every commit is on",
    "the issue branch, then report COMPLETE again so the reviewer can be retried.",
  ].join("\n");
}

// Order-insensitive: `git status --porcelain` order is stable in practice, but
// "the same files are still dirty" is the question being asked, and a reordering
// is not progress.
function sameDirtySet(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((p) => seen.has(p));
}

function onImplementerResult(
  state: LoopState,
  event: Extract<LoopEvent, { kind: "implementer-result" }>,
): StepResult {
  const { signal, dirtyPaths, offBranch, fastForwarded, commits, head } = event;
  const fastForwardedNote = fastForwarded === null
    ? null
    : offBranchFastForwardedNote(state.issueBranch, fastForwarded);
  // These two hand the issue to a human and land nothing, so they are exempt
  // from the off-branch correction below (re-prompting would risk spending the
  // budget on a question the agent had already formed, and would swap a precise
  // handoff — the question, the UI assessment — for a generic one). They carry
  // the mismatch instead, so the commits the agent stranded are named in the
  // handoff rather than deleted in silence.
  if (signal.kind === "NEEDS-INFO") {
    return terminate(state, {
      type: "NEEDS-INFO",
      questions: signal.questions,
      strandedHead: offBranch,
    });
  }
  if (signal.kind === "NEEDS-UI-PROTOTYPE") {
    return terminate(state, {
      type: "NEEDS-UI-PROTOTYPE",
      uiImpact: signal.uiImpact,
      strandedHead: offBranch,
    });
  }
  // #27/#127 — before anything that treats this attempt's work as real. The
  // runner already repaired an ancestor mismatch for free; only the unsafe
  // case remains. A detached HEAD leaves a CLEAN tree, so the dirty check below
  // cannot see it, and the gate would go green on a tree `refs/heads/<branch>`
  // does not contain.
  //
  // ONE re-prompt, then terminate — and the asymmetry with the dirty-set rule
  // below is deliberate. The mechanical ancestor case spent no correction
  // because the runner fixed it. What remains requires the agent to reconcile
  // histories without discarding branch commits, but the result is still
  // binary: either HEAD is the issue branch or it is not. An attempt that had
  // that focused instruction and is still off the branch is not one that needs
  // another go, and each further attempt can bury the stranded commits under
  // more stranded commits. The test is on the PREVIOUS attempt having been
  // off-branch, not on it having been off-branch in the same PLACE: a new
  // detached sha is not progress toward being on the branch, so comparing
  // positions would let an agent grind the whole budget by committing again.
  if (offBranch !== null) {
    const trace = offBranchHeadReprompt(offBranch);
    return transitionAfterPreGateFailure(
      state,
      state.lastOffBranch
        ? null
        : {
            failureTrace: trace,
            extraReprompt: trace,
            latestReviewerFeedback: state.latestReviewerFeedback,
            offBranch: true,
          },
      {
        type: "NEEDS-HUMAN",
        cause: "off-branch-head",
        failureTrace: trace,
        latestReviewerProse: state.latestReviewerPublic,
        budgetExhausted: null,
        strandedHead: offBranch,
      },
    );
  }
  if (signal.kind === "COMPLETE") {
    // Dirty tree: another attempt with "commit your work", NOT the round.
    // Cheaper than letting the gate refuse and far more actionable than a red
    // verdict, and it is the only routing that keeps the forgotten `git add` —
    // the overwhelmingly common cause — rather than letting a `git clean`
    // destroy it.
    if (dirtyPaths.length > 0) {
      const trace = uncommittedWorkReprompt(dirtyPaths);
      // An attempt that was told to commit and came back with the IDENTICAL
      // dirty set did not fail to try — it cannot succeed. The realistic causes
      // are all outside the implementer's reach: a file a gate container wrote
      // as a uid the sandbox user cannot unlink, a path an issue-lifecycle
      // container keeps recreating, a gate step's non-gitignored exhaust.
      // Without this check every one of the remaining attempts is a full agent
      // run ending in the same reprompt, and the budget dies pointing at a gate
      // that never ran.
      const repeated = state.lastDirtyPaths !== null &&
        sameDirtySet(state.lastDirtyPaths, dirtyPaths);
      return transitionAfterPreGateFailure(
        state,
        repeated
          ? null
          : {
              failureTrace: trace,
              extraReprompt: joinOrchestratorNotes(fastForwardedNote, trace),
              latestReviewerFeedback: state.latestReviewerFeedback,
              dirtyPaths,
            },
        // Built from the dirty trace, not from state.lastFailureTrace: the gate
        // never ran on this route.
        {
          type: "NEEDS-HUMAN",
          cause: "uncommittable-worktree",
          failureTrace: trace,
          latestReviewerProse: repeated ? state.latestReviewerPublic : null,
          budgetExhausted: null,
          strandedHead: null,
        },
      );
    }
    const rejection = state.pendingRejection;
    if (
      commits === 0 &&
      rejection !== null &&
      rejection.head === head &&
      !state.adjudicatedHeads.includes(rejection.head)
    ) {
      return {
        state: {
          ...state,
          phase: "needs-adjudicator",
          adjudicating: { pass: "correctness", rejection },
        },
        action: {
          kind: "run-adjudicator",
          attempt: state.attempt,
          pass: "correctness",
          rejection,
        },
      };
    }
    // A new quality pass: its own budget, no report, no ruling.
    const listing: LoopState = {
      ...state,
      phase: "needs-quality-list",
      qualityFailures: 0,
      qualityReport: null,
      qualityRuling: null,
      qualityFixRounds: 0,
      // Keep the repair note only long enough to render it if the round
      // produces another implementer attempt.
      extraReprompt: fastForwardedNote,
      lastDirtyPaths: null,
      lastOffBranch: false,
    };
    return {
      state: listing,
      action: {
        kind: "run-quality-list",
        attempt: state.attempt,
        scope: state.qualityApprovedHead === null
          ? { kind: "full" }
          : { kind: "since", sha: state.qualityApprovedHead },
      },
    };
  }
  // NO-SIGNAL — either re-prompt for next attempt or exhaust the budget. This
  // route has its own cause because the deciding attempt did not run a gate,
  // while its trace preserves any gate failure from an earlier attempt (#116).
  const correction = signal.missingTag
    ? "The final implementer attempt emitted no <promise> token."
    : `The final implementer signal failed validation:\n${signal.reprompt}`;
  return transitionAfterPreGateFailure(
    state,
    {
      failureTrace: state.lastFailureTrace,
      extraReprompt: joinOrchestratorNotes(fastForwardedNote, signal.reprompt),
      latestReviewerFeedback: state.latestReviewerFeedback,
    },
    {
      type: "NEEDS-HUMAN",
      cause: "no-signal-exhausted",
      failureTrace: state.lastFailureTrace
        ? `Last gate failure:\n${state.lastFailureTrace}\n\n${correction}`
        : correction,
      latestReviewerProse: null,
      budgetExhausted: null,
      strandedHead: null,
    },
  );
}

function onQualityReviewResult(
  state: LoopState,
  event: Extract<LoopEvent, { kind: "quality-review-result" }>,
): StepResult {
  const { review } = event;
  if (review.kind === "reviewer-wrote") {
    return terminate(state, {
      type: "NEEDS-HUMAN-REVIEW",
      cause: "quality-reviewer-wrote",
      latestReviewerProse: review.detail,
    });
  }
  if (review.kind === "reviewer-harness-failed") {
    return toGate(state, "REVIEW-FAILED");
  }
  if (review.verdict === "APPROVED") {
    return toGate({ ...state, qualityApprovedHead: event.head }, "APPROVED");
  }
  if (event.mode === "list") {
    return dispatchFixer({ ...state, qualityReport: review.prose });
  }
  return chargeQuality({ ...state, qualityReport: review.prose });
}

function onQualityFixResult(
  state: LoopState,
  event: Extract<LoopEvent, { kind: "quality-fix-result" }>,
): StepResult {
  // The ruling was for this fixer run only.
  const next: LoopState = { ...state, qualityRuling: null };
  // Retried by the runner already; a second crash ends the pass, and gate-1
  // judges whatever it committed.
  if (event.exited === "failed") return toGate(next, "FIX-FAILED");
  const report = requireQualityReport(state);
  if (event.commits === 0) {
    // A fixer that changed nothing disputes the report. Once per head; a
    // refusal after an upheld ruling at the same head is out of road. A
    // step's verdict is mechanical, so a report of nothing else has nothing
    // to adjudicate.
    if (event.steps?.only === true || state.qualityAdjudicatedHeads.includes(event.head)) {
      return toGate(next, "CHANGES-REQUESTED");
    }
    const rejection: PendingRejection = {
      round: state.attempt,
      head: event.head,
      report,
    };
    return {
      state: {
        ...next,
        phase: "needs-adjudicator",
        adjudicating: { pass: "quality", rejection, stepFindings: event.steps?.findings ?? null },
      },
      action: {
        kind: "run-adjudicator",
        attempt: state.attempt,
        pass: "quality",
        fixRound: state.qualityFixRounds,
        rejection,
      },
    };
  }
  return {
    state: { ...next, phase: "needs-quality-verify" },
    action: {
      kind: "run-quality-verify",
      attempt: state.attempt,
      fixRound: state.qualityFixRounds,
      anchor: event.startHead,
      report,
    },
  };
}

function requireQualityReport(state: LoopState): string {
  if (state.qualityReport === null) {
    throw new Error("quality fixer step without a CHANGES-REQUESTED report");
  }
  return state.qualityReport;
}

// A rejection the pass is charged for — a verify that still finds items open,
// or an upheld adjudication. Exhaustion continues the round rather than
// stopping the loop (#187).
function chargeQuality(state: LoopState): StepResult {
  const charged: LoopState = {
    ...state,
    qualityFailures: state.qualityFailures + 1,
  };
  if (charged.qualityFailures >= charged.maxQualityRounds) {
    return toGate(charged, "CHANGES-REQUESTED");
  }
  return dispatchFixer(charged);
}

function dispatchFixer(state: LoopState): StepResult {
  const fixRound = state.qualityFixRounds + 1;
  return {
    state: { ...state, phase: "needs-quality-fix", qualityFixRounds: fixRound },
    action: {
      kind: "run-quality-fix",
      attempt: state.attempt,
      fixRound,
      report: requireQualityReport(state),
      ruling: state.qualityRuling,
    },
  };
}

// The quality pass is over, however it ended: gate-1 runs once on the head it
// left.
function toGate(
  state: LoopState,
  verdict: QualityOutcome["verdict"],
): StepResult {
  return {
    state: {
      ...state,
      phase: "needs-gate",
      qualityReport: null,
      qualityRuling: null,
    },
    action: {
      kind: "run-gate",
      attempt: state.attempt,
      quality: { verdict, rounds: state.qualityFailures },
    },
  };
}

function onGateResult(state: LoopState, gate: Gate1Result): StepResult {
  if (gate.ok) {
    return toVerifier({
      ...state,
      gateFailures: 0,
      lastFailureTrace: "",
      lastFailedStep: null,
    });
  }
  const redState: LoopState = {
    ...state,
    gateFailures: state.gateFailures + 1,
    lastFailureTrace: gate.failureTrace,
    lastFailedStep: gate.failedStep,
  };
  if (redState.gateFailures >= redState.maxGateRounds) {
    if (gate.failedStep === null) {
      throw new Error("red gate exhausted without a failing step");
    }
    return terminate(redState, {
      type: "NEEDS-HUMAN",
      cause: "gate-red",
      failureTrace: gate.failureTrace,
      latestReviewerProse: state.latestReviewerPublic,
      budgetExhausted: {
        budget: "gate",
        roundsUsed: redState.gateFailures,
        failedStep: gate.failedStep,
      },
      strandedHead: null,
    });
  }
  return advanceAttempt(redState, {
    failureTrace: gate.failureTrace,
    extraReprompt: state.extraReprompt,
    latestReviewerFeedback: state.latestReviewerFeedback,
  });
}

// The verifier slot, behind the scenario writer's join while it still runs.
// The runner joins the white-box review only when the writer wrote a set.
function toVerifier(state: LoopState): StepResult {
  if (state.scenarioWriter.kind === "running") {
    return {
      state: { ...state, phase: "needs-scenario-writer-result" },
      action: { kind: "await-scenario-writer" },
    };
  }
  const writer = state.scenarioWriter;
  return {
    state: { ...state, phase: "needs-verifier" },
    action: {
      kind: "run-verifier",
      attempt: state.attempt,
      scenarios: writer.kind === "settled" && writer.outcome.kind === "written"
        ? writer.outcome.set
        : null,
    },
  };
}

function onVerifierResult(
  state: LoopState,
  head: string,
  outcome: VerifierOutcome,
): StepResult {
  switch (outcome.kind) {
    case "wrote":
      return terminate(state, {
        type: "NEEDS-HUMAN-REVIEW",
        cause: outcome.cause,
        latestReviewerProse: outcome.detail,
      });
    case "harness-failed":
      return onReviewerHarnessFailed(
        state,
        outcome.detail,
        reviewerHarnessFailedReprompt(state.latestReviewerFeedback !== null),
      );
    case "approved":
      return terminate({ ...state, pendingRejection: null }, { type: "DONE" });
    case "rejected":
      return onVerifierRejected(state, head, outcome);
  }
}

// One charge per rejected round, whichever units it holds.
function onVerifierRejected(
  state: LoopState,
  head: string,
  { units, whiteBox }: Extract<VerifierOutcome, { kind: "rejected" }>,
): StepResult {
  const correctnessFailures = state.correctnessFailures + 1;
  const pendingRejection: VerifierRejection = {
    round: state.attempt,
    head,
    report: renderRejection({ units, whiteBox }, "text"),
    units,
    whiteBox,
  };
  const feedback = rejectionFeedback(state, pendingRejection);
  const reviewedState: LoopState = {
    ...state,
    ...feedback,
    correctnessFailures,
    pendingRejection,
  };
  if (correctnessFailures >= state.maxReviewRounds) {
    return terminate(reviewedState, {
      type: "NEEDS-HUMAN-REVIEW",
      cause: "correctness-budget-exhausted",
      roundsUsed: correctnessFailures,
      latestReviewerProse: feedback.latestReviewerPublic,
    });
  }
  return advanceAttempt(reviewedState, {
    failureTrace: "",
    extraReprompt: state.extraReprompt,
    latestReviewerFeedback: feedback.latestReviewerFeedback,
  });
}

// A verifier rejection in both renderings. One repeated at a head an
// adjudicator already UPHELD carries that ruling's reasoning, so the
// implementer is not handed the report as if it were still disputable. The
// public rendering withholds that reasoning beside a scenario unit, or when
// the ruling was on one, since it may quote the scenario or its evidence.
function rejectionFeedback(
  state: LoopState,
  rejection: VerifierRejection,
): { readonly latestReviewerFeedback: string; readonly latestReviewerPublic: string } {
  const adjudication = state.upheldAdjudication?.head === rejection.head
    ? state.upheldAdjudication
    : null;
  const ruling = adjudication?.reasoning ?? null;
  const upheld = (reasoning: string): string[] => ["Independent adjudicator: UPHELD", reasoning, ""];
  const publicReasoning = adjudication?.ruledScenarios ||
      rejection.units.some((unit) => unit.id !== "white-box")
    ? "(reasoning withheld beside scenario findings)"
    : ruling;
  return {
    latestReviewerFeedback: [...(ruling === null ? [] : upheld(ruling)), rejection.report]
      .join("\n"),
    latestReviewerPublic: [
      ...(ruling === null || publicReasoning === null ? [] : upheld(publicReasoning)),
      renderRejection(rejection, "publicText"),
    ].join("\n"),
  };
}

function onAdjudicatorResult(
  state: LoopState,
  event: Extract<LoopEvent, { kind: "adjudicator-result" }>,
): StepResult {
  const adjudicating = requireAdjudicating(state);
  if (adjudicating.rejection.head !== event.head) {
    throw new Error("adjudicator ruled on a rejection other than the pending head");
  }
  const ruled: LoopState = { ...state, adjudicating: null };
  if (adjudicating.pass === "quality") {
    if (event.ruling === "OVERRULED") {
      return adjudicating.stepFindings === null
        ? toGate({ ...ruled, qualityApprovedHead: event.head }, "OVERRULED")
        : chargeQuality({ ...ruled, qualityReport: adjudicating.stepFindings });
    }
    return chargeQuality({
      ...ruled,
      qualityAdjudicatedHeads: [...state.qualityAdjudicatedHeads, event.head],
      qualityRuling: event.reasoning.trim(),
    });
  }
  const { rejection } = adjudicating;
  if (event.ruling === "OVERRULED") {
    // Every finding in the only rejection the head carries is false; one
    // whose white-box review produced nothing has yet to review that head.
    return rejection.whiteBox === "HARNESS-FAILED"
      ? toVerifier({ ...ruled, pendingRejection: null })
      : terminate(ruled, { type: "DONE" });
  }
  const { rulings } = event;
  const units = rulings === null
    ? rejection.units
    : rejection.units.filter((unit) => rulings[unit.id] === "UPHELD");
  const overruled = rejection.units.filter((unit) => !units.includes(unit));
  const upheldState: LoopState = {
    ...ruled,
    adjudicatedHeads: [...state.adjudicatedHeads, rejection.head],
    upheldAdjudication: {
      head: rejection.head,
      reasoning: event.reasoning.trim(),
      ruledScenarios: rulings !== null,
    },
  };
  const overruledLine = overruled.length === 0
    ? []
    : [`The adjudicator overruled: ${overruled.map((unit) => unit.id).join(", ")}.`];
  const { latestReviewerFeedback, latestReviewerPublic } = rejectionFeedback(upheldState, {
    ...rejection,
    units,
    report: renderRejection({ units, whiteBox: rejection.whiteBox }, "text"),
  });
  const feedback = {
    latestReviewerFeedback: [latestReviewerFeedback, ...overruledLine].join("\n\n"),
    latestReviewerPublic: [latestReviewerPublic, ...overruledLine].join("\n\n"),
  };
  return advanceAttempt(
    { ...upheldState, ...feedback },
    {
      failureTrace: state.lastFailureTrace,
      extraReprompt: state.extraReprompt,
      latestReviewerFeedback: feedback.latestReviewerFeedback,
    },
  );
}

// The verifier or adjudicator produced nothing at all (#41/#143).
// No convergence budget is charged by that fault, and `latestReviewerFeedback`
// keeps whatever an earlier round actually said.
//
// The attempt number still advances so one more implementer run can do real
// work and re-reach the reviewer through a fresh round. The per-loop total
// bounds a component that has already exhausted its own invocation retries.
function onReviewerHarnessFailed(
  state: LoopState,
  detail: string,
  note: string,
): StepResult {
  const failedState: LoopState = {
    ...state,
    reviewerHarnessFailures: state.reviewerHarnessFailures + 1,
  };
  if (failedState.reviewerHarnessFailures >= REVIEWER_HARNESS_FAILURE_LIMIT) {
    return terminate(failedState, {
      type: "NEEDS-HUMAN",
      cause: "reviewer-harness-failed",
      failureTrace: detail,
      // An earlier round's real report, if there was one. Never `detail` — the
      // handoff renders this as the reviewer speaking.
      latestReviewerProse: state.latestReviewerPublic,
      budgetExhausted: null,
      strandedHead: null,
    });
  }
  return advanceAttempt(failedState, {
    failureTrace: "",
    extraReprompt: joinOrchestratorNotes(state.extraReprompt, note),
    latestReviewerFeedback: state.latestReviewerFeedback,
  });
}

// An attempt that produced no commit the gate could judge (#185): charged to
// the gate budget, which a green gate resets.
function transitionAfterPreGateFailure(
  state: LoopState,
  // `null` means a dedicated rule (repeated dirt or off-branch HEAD) stops the
  // loop even if the gate budget still has room.
  next: Parameters<typeof advanceAttempt>[1] | null,
  onExhausted: Extract<Verdict, { type: "NEEDS-HUMAN" }>,
): StepResult {
  const charged: LoopState = {
    ...state,
    gateFailures: state.gateFailures + 1,
  };
  const budgetExhausted = charged.gateFailures >= charged.maxGateRounds;
  if (!budgetExhausted && next !== null) {
    return advanceAttempt(charged, next);
  }
  return terminate(
    charged,
    budgetExhausted
      ? {
          ...onExhausted,
          budgetExhausted: {
            budget: "gate",
            roundsUsed: charged.gateFailures,
            failedStep: null,
          },
        }
      : onExhausted,
  );
}

function advanceAttempt(
  state: LoopState,
  next: {
    readonly failureTrace: string;
    readonly extraReprompt: string | null;
    readonly latestReviewerFeedback: string | null;
    // Carried only by the COMPLETE-over-a-dirty-tree route, so the next
    // attempt can tell "still dirty in a new way" from "changed nothing".
    // Every other route clears it.
    readonly dirtyPaths?: readonly string[];
    // Same shape for #27/#127: only an unsafe off-branch route sets it. A
    // host-repaired ancestor mismatch therefore cannot spend this correction.
    readonly offBranch?: boolean;
  },
): StepResult {
  const newAttempt = state.attempt + 1;
  const ns: LoopState = {
    ...state,
    attempt: newAttempt,
    phase: "needs-implementer",
    extraReprompt: next.extraReprompt,
    latestReviewerFeedback: next.latestReviewerFeedback,
    lastDirtyPaths: next.dirtyPaths ?? null,
    lastOffBranch: next.offBranch ?? false,
  };
  return {
    state: ns,
    action: {
      kind: "run-implementer",
      attempt: newAttempt,
      failureTrace: next.failureTrace,
      extraReprompt: next.extraReprompt,
      latestReviewerFeedback: next.latestReviewerFeedback,
    },
  };
}

function terminate(state: LoopState, verdict: Verdict): StepResult {
  return {
    state: { ...state, phase: "terminated" },
    action: { kind: "terminate", verdict },
  };
}

// Outer-layer decision: should the runner re-create the sandbox and run the
// machine again, or surface this verdict? Crosses the sandbox lifecycle
// boundary so it lives outside the in-sandbox SM. Pure for testability.
export type RetryDecision =
  | { readonly kind: "retry-with-fresh-sandbox"; readonly nextRetriesUsed: number }
  | { readonly kind: "surface" };

export function decideAfterTerminal(
  verdict: Verdict,
  retriesUsed: number,
  maxRetries: number = HARD_ERROR_MAX_RETRIES,
): RetryDecision {
  if (verdict.type !== "HARD-ERROR") return { kind: "surface" };
  if (retriesUsed >= maxRetries) return { kind: "surface" };
  return { kind: "retry-with-fresh-sandbox", nextRetriesUsed: retriesUsed + 1 };
}
