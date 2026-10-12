// Pure inner-loop state machine — no I/O. The runner calls step(state, event)
// and executes the returned action; `terminate` ends the loop. Every decision
// (the pre-attempt partition and UI classifications, promise routing, the
// serial quality → gate-1 → correctness order, per-budget exhaustion, and
// context-budget parking) lives here and is table-driven tested in
// inner-loop-machine.test.ts.
//
// After a clean, on-branch COMPLETE the round is SERIAL (#185): the quality
// pass — a fixer that commits standards fixes and tests and has no verdict —
// then gate-1 on the head the fixer left, then the correctness reviewer only
// on a green gate there. Gate-1 mounts the worktree the fixer writes, so #123's
// concurrent gate/quality dispatch is gone. A red gate goes back to the
// implementer; a test the fixer wrote that fails is how a correctness defect
// reaches it.
//
// Two independent consecutive-failure budgets bound non-convergence (#129,
// #143, #185). `gateFailures` counts red gate-1 results AND every attempt that
// failed to produce a commit the gate could judge — NO-SIGNAL, COMPLETE over a
// dirty tree, an unrepaired off-branch HEAD — and every green gate-1 resets
// it. `correctnessFailures` counts correctness rejections only. Neither
// counter spends or resets the other. There is no implementer-attempt budget:
// `attempt` remains only a sequence number.
//
// Reviewer harness failure keeps #41's separate rule: it charges neither
// budget. `reviewerHarnessFailures` is a per-inner-loop total over the
// correctness pass and the adjudicator that never resets; its second failure
// terminates. The quality fixer has no harness failure: whatever it leaves, the
// runner settles host-side and the round goes on to gate-1.
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
// A zero-commit COMPLETE at the head of a pending correctness rejection enters
// one adjudication per head (#167). UPHELD keeps the original charge and makes
// another zero-commit attempt take the ordinary round; OVERRULED refunds the
// charge and finishes the issue as approved. With no quality rejection,
// adjudication is correctness-only (#185).
//
// A reviewer that produced NO review is not a verdict (#41); that judgment is
// reviewer-run.ts's. `reviewer-harness-failed` consumes no review round,
// leaves retained reviewer feedback untouched, and names itself in exhaustion
// rather than a rejection. The next implementer attempt is dispatched anyway
// — unreviewed work must not read as DONE — with an orchestrator note,
// not a finding.
//
// HARD-ERROR is not a verdict the SM ever emits — it's how the runner wraps
// unhandled exceptions; decideAfterTerminal answers "retry with a fresh
// sandbox or surface?" for the runner's outer loop.

import type { HeadMismatch } from "./git-ops.js";
import type { ParseSignal } from "./promise-parser.js";
import type { UiCheckResult } from "./ui-check-parser.js";
import type { PartitionCheckResult } from "./partition-check-parser.js";
import { loadTemplate } from "./prompts.js";

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

// The correctness rejection the next zero-commit attempt may dispute (#167).
export type PendingRejection = {
  readonly round: number;
  readonly head: string;
  readonly report: string;
};

export const HARD_ERROR_MAX_RETRIES = 2;
export const REVIEWER_HARNESS_FAILURE_LIMIT = 2;

export type LoopPhase =
  | "needs-partition-check"
  | "needs-ui-check"
  | "needs-implementer"
  | "needs-quality"
  | "needs-gate"
  | "needs-correctness"
  | "needs-adjudicator"
  | "terminated";

export type LoopState = {
  readonly issueBranch: string;
  readonly maxGateRounds: number;
  readonly maxReviewRounds: number;
  readonly attempt: number;
  readonly gateFailures: number;
  readonly correctnessFailures: number;
  readonly lastFailureTrace: string;
  readonly lastFailedStep: string | null;
  readonly extraReprompt: string | null;
  // The latest correctness rejection's prose, with any upheld adjudication
  // prepended. Only correctness rejects since #185.
  readonly latestReviewerFeedback: string | null;
  // The dirty set that sent the PREVIOUS attempt back to commit its work, or
  // null if the last attempt didn't end that way. Only used to detect that an
  // attempt changed nothing — see onImplementerResult.
  readonly lastDirtyPaths: readonly string[] | null;
  // Whether the PREVIOUS attempt was sent back because HEAD was not the issue
  // branch (#27). One re-prompt is offered; a second consecutive off-branch
  // attempt terminates — see onImplementerResult.
  readonly lastOffBranch: boolean;
  // Total correctness or adjudicator runs in this inner loop that yielded no
  // review at all (#41, #143). Never reset: infrastructure faults are bounded
  // independently of convergence streaks.
  readonly reviewerHarnessFailures: number;
  readonly pendingRejection: PendingRejection | null;
  // Heads whose rejection has already been adjudicated once.
  readonly adjudicatedHeads: readonly string[];
  readonly upheldAdjudication: {
    readonly head: string;
    readonly reasoning: string;
  } | null;
  readonly uiPrototypeCheck: boolean;
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
      //   reviewer-harness-failed — the correctness reviewer or adjudicator
      //     produced nothing twice in this inner loop (#41/#143). `failureTrace`
      //     carries why every invocation in the latest failed run yielded
      //     nothing. `latestReviewerProse` is whatever an EARLIER round said,
      //     if any — never the harness error.
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
        | "adjudicator-wrote"
        | "ui-checker-wrote"
        | "partition-checker-wrote";
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
  | { readonly kind: "run-partition-check" }
  | { readonly kind: "run-ui-check" }
  | {
      readonly kind: "run-implementer";
      readonly attempt: number;
      readonly failureTrace: string;
      readonly extraReprompt: string | null;
      readonly latestReviewerFeedback: string | null;
    }
  | { readonly kind: "run-quality"; readonly attempt: number }
  | { readonly kind: "run-gate"; readonly attempt: number }
  | { readonly kind: "run-correctness"; readonly attempt: number }
  | {
      readonly kind: "run-adjudicator";
      readonly attempt: number;
      readonly rejection: PendingRejection;
    }
  | { readonly kind: "terminate"; readonly verdict: Verdict };

// The UI phase is derived from the machine's transition result, never guessed
// by the I/O runner (#132).
export function visiblePhases(
  action: LoopAction,
): readonly (
  | "partition-check"
  | "ui-check"
  | "implementer"
  | "quality"
  | "gate-1"
  | "review"
  | "adjudication"
)[] {
  switch (action.kind) {
    case "run-partition-check": return ["partition-check"];
    case "run-ui-check": return ["ui-check"];
    case "run-implementer": return ["implementer"];
    case "run-quality": return ["quality"];
    case "run-gate": return ["gate-1"];
    case "run-correctness": return ["review"];
    case "run-adjudicator": return ["adjudication"];
    case "terminate": return [];
  }
}

export type LoopEvent =
  | {
      readonly kind: "partition-check-result";
      readonly result: PartitionCheckResult;
      readonly size: number;
      readonly budget: number;
    }
  | { readonly kind: "partition-checker-wrote"; readonly detail: string }
  | { readonly kind: "ui-check-result"; readonly result: UiCheckResult }
  | { readonly kind: "ui-checker-wrote"; readonly detail: string }
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
  // The fixer has no verdict; its commits and settled residue are run
  // evidence the runner records, not decision inputs (#185).
  | { readonly kind: "quality-result" }
  | {
      readonly kind: "gate-result";
      readonly gate: Gate1Result;
      // The head gated — the one the quality pass left. Record material for
      // the runner's `review-round` event; no transition reads it.
      readonly head: string;
    }
  | {
      readonly kind: "correctness-result";
      readonly head: string;
      readonly reviewer: ReviewerResult;
    }
  | {
      readonly kind: "adjudicator-result";
      readonly head: string;
      readonly ruling: "UPHELD" | "OVERRULED";
      readonly reasoning: string;
    }
  | { readonly kind: "adjudicator-wrote"; readonly detail: string }
  | { readonly kind: "adjudicator-harness-failed"; readonly detail: string };

export type Gate1Result = {
  readonly ok: boolean;
  readonly failureTrace: string;
  readonly failedStep: string | null;
};

// What one correctness pass yielded (#41, #98).
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
  readonly maxGateRounds: number;
  readonly maxReviewRounds: number;
  readonly uiPrototypeCheck: boolean;
  readonly partitionCheck: boolean;
};

export function initialState(opts: InitialStateOptions): LoopState {
  if (!Number.isInteger(opts.maxGateRounds) || opts.maxGateRounds < 1) {
    throw new Error(
      `maxGateRounds must be a positive integer, got ${opts.maxGateRounds}`,
    );
  }
  if (!Number.isInteger(opts.maxReviewRounds) || opts.maxReviewRounds < 1) {
    throw new Error(
      `maxReviewRounds must be a positive integer, got ${opts.maxReviewRounds}`,
    );
  }
  return {
    issueBranch: opts.issueBranch,
    maxGateRounds: opts.maxGateRounds,
    maxReviewRounds: opts.maxReviewRounds,
    attempt: 1,
    gateFailures: 0,
    correctnessFailures: 0,
    lastFailureTrace: "",
    lastFailedStep: null,
    extraReprompt: null,
    latestReviewerFeedback: null,
    lastDirtyPaths: null,
    lastOffBranch: false,
    reviewerHarnessFailures: 0,
    pendingRejection: null,
    adjudicatedHeads: [],
    upheldAdjudication: null,
    uiPrototypeCheck: opts.uiPrototypeCheck,
    phase: opts.partitionCheck
      ? "needs-partition-check"
      : opts.uiPrototypeCheck
        ? "needs-ui-check"
        : "needs-implementer",
  };
}

export function initialAction(state: LoopState): LoopAction {
  if (state.phase === "needs-partition-check") return { kind: "run-partition-check" };
  if (state.phase === "needs-ui-check") return { kind: "run-ui-check" };
  return {
    kind: "run-implementer",
    attempt: state.attempt,
    failureTrace: state.lastFailureTrace,
    extraReprompt: state.extraReprompt,
    latestReviewerFeedback: state.latestReviewerFeedback,
  };
}

const EVENT_PHASE: Readonly<Record<
  Exclude<LoopEvent["kind"], "context-over-budget">,
  LoopPhase
>> = {
  "partition-check-result": "needs-partition-check",
  "partition-checker-wrote": "needs-partition-check",
  "ui-check-result": "needs-ui-check",
  "ui-checker-wrote": "needs-ui-check",
  "implementer-result": "needs-implementer",
  "quality-result": "needs-quality",
  "gate-result": "needs-gate",
  "correctness-result": "needs-correctness",
  "adjudicator-result": "needs-adjudicator",
  "adjudicator-wrote": "needs-adjudicator",
  "adjudicator-harness-failed": "needs-adjudicator",
};

// A role measures its own context before it runs (#158): the partition check
// its anchor, and the fixer and the correctness reviewer the branch picture
// they are about to read. Gate-1 reads no prompt and measures nothing.
const CONTEXT_MEASURING_PHASES: readonly LoopPhase[] = [
  "needs-partition-check",
  "needs-implementer",
  "needs-quality",
  "needs-correctness",
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

  const expected = EVENT_PHASE[event.kind];
  if (state.phase !== expected) {
    throw new Error(
      `${event.kind} event in phase ${state.phase}; expected ${expected}`,
    );
  }

  switch (event.kind) {
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
        phase: state.uiPrototypeCheck ? "needs-ui-check" : "needs-implementer",
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
      const nextState: LoopState = { ...state, phase: "needs-implementer" };
      return { state: nextState, action: initialAction(nextState) };
    }

    case "implementer-result":
      return onImplementerResult(state, event);

    case "quality-result":
      return {
        state: { ...state, phase: "needs-gate" },
        action: { kind: "run-gate", attempt: state.attempt },
      };

    case "gate-result":
      return onGateResult(state, event.gate);

    case "correctness-result":
      return onCorrectnessResult(state, event.head, event.reviewer);

    case "adjudicator-result":
      return onAdjudicatorResult(state, event);

    case "adjudicator-wrote":
      return terminate(state, {
        type: "NEEDS-HUMAN-REVIEW",
        cause: "adjudicator-wrote",
        latestReviewerProse: event.detail,
      });

    case "adjudicator-harness-failed":
      return onReviewerHarnessFailed(
        state,
        `adjudicator: ${event.detail}`,
        ADJUDICATOR_HARNESS_FAILED_REPROMPT,
      );
  }
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

// The orchestrator note for an attempt whose correctness pass produced no
// review (#41). Exported so the wording is asserted where the routing is.
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
    "The correctness reviewer could not be run this round: every invocation",
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
        latestReviewerProse: state.latestReviewerFeedback,
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
          latestReviewerProse: repeated ? state.latestReviewerFeedback : null,
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
        state: { ...state, phase: "needs-adjudicator" },
        action: { kind: "run-adjudicator", attempt: state.attempt, rejection },
      };
    }
    return {
      state: {
        ...state,
        phase: "needs-quality",
        // Keep the repair note only long enough to render it if the round
        // produces another implementer attempt.
        extraReprompt: fastForwardedNote,
        lastDirtyPaths: null,
        lastOffBranch: false,
      },
      action: { kind: "run-quality", attempt: state.attempt },
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

function onGateResult(state: LoopState, gate: Gate1Result): StepResult {
  if (gate.ok) {
    return {
      state: {
        ...state,
        gateFailures: 0,
        lastFailureTrace: "",
        lastFailedStep: null,
        phase: "needs-correctness",
      },
      action: { kind: "run-correctness", attempt: state.attempt },
    };
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
      latestReviewerProse: state.latestReviewerFeedback,
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

function onCorrectnessResult(
  state: LoopState,
  head: string,
  reviewer: ReviewerResult,
): StepResult {
  if (reviewer.kind === "reviewer-wrote") {
    return terminate(state, {
      type: "NEEDS-HUMAN-REVIEW",
      cause: "reviewer-wrote",
      latestReviewerProse: reviewer.detail,
    });
  }
  if (reviewer.kind === "reviewer-harness-failed") {
    return onReviewerHarnessFailed(
      state,
      reviewer.detail,
      reviewerHarnessFailedReprompt(state.latestReviewerFeedback !== null),
    );
  }
  if (reviewer.verdict === "APPROVED") {
    return terminate({ ...state, pendingRejection: null }, { type: "DONE" });
  }
  const correctnessFailures = state.correctnessFailures + 1;
  const pendingRejection: PendingRejection = {
    round: state.attempt,
    head,
    report: reviewer.prose,
  };
  const prose = adjudicationNotice(state, pendingRejection);
  const reviewedState: LoopState = {
    ...state,
    correctnessFailures,
    latestReviewerFeedback: prose,
    pendingRejection,
  };
  if (correctnessFailures >= state.maxReviewRounds) {
    return terminate(reviewedState, {
      type: "NEEDS-HUMAN-REVIEW",
      cause: "correctness-budget-exhausted",
      roundsUsed: correctnessFailures,
      latestReviewerProse: prose,
    });
  }
  return advanceAttempt(reviewedState, {
    failureTrace: "",
    extraReprompt: state.extraReprompt,
    latestReviewerFeedback: prose,
  });
}

// A rejection repeated at a head an adjudicator already UPHELD carries that
// ruling's reasoning, so the implementer is not handed the report as if it
// were still disputable.
function adjudicationNotice(
  state: LoopState,
  rejection: PendingRejection,
): string {
  if (state.upheldAdjudication?.head !== rejection.head) return rejection.report;
  return [
    "Independent adjudicator: UPHELD",
    state.upheldAdjudication.reasoning,
    "",
    rejection.report,
  ].join("\n");
}

function onAdjudicatorResult(
  state: LoopState,
  event: Extract<LoopEvent, { kind: "adjudicator-result" }>,
): StepResult {
  const rejection = state.pendingRejection;
  if (rejection === null || rejection.head !== event.head) {
    throw new Error("adjudicator ruled on a rejection other than the pending head");
  }
  const adjudicatedHeads = [...state.adjudicatedHeads, rejection.head];
  if (event.ruling === "OVERRULED") {
    return terminate(
      {
        ...state,
        adjudicatedHeads,
        pendingRejection: null,
        upheldAdjudication: null,
        latestReviewerFeedback: null,
        correctnessFailures: Math.max(0, state.correctnessFailures - 1),
      },
      { type: "DONE" },
    );
  }
  const upheldState: LoopState = {
    ...state,
    adjudicatedHeads,
    upheldAdjudication: { head: rejection.head, reasoning: event.reasoning.trim() },
  };
  const feedback = adjudicationNotice(upheldState, rejection);
  return advanceAttempt(
    { ...upheldState, latestReviewerFeedback: feedback },
    {
      failureTrace: state.lastFailureTrace,
      extraReprompt: state.extraReprompt,
      latestReviewerFeedback: feedback,
    },
  );
}

// The correctness reviewer or adjudicator produced nothing at all (#41/#143).
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
      latestReviewerProse: state.latestReviewerFeedback,
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
