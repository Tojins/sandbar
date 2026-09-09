// Pure inner-loop state machine — no I/O. The runner calls step(state, event)
// and executes the returned action; `terminate` ends the loop. Every decision
// (one pre-attempt UI classification, promise routing, concurrent
// gate/reviewer routing, per-pass budget exhaustion)
// lives here and is table-driven tested in inner-loop-machine.test.ts.
//
// Three independent consecutive-failure budgets bound three kinds of
// non-convergence (#129, #143). `qualityFailures` counts quality rejection,
// NO-SIGNAL, dirty tree, and off-branch HEAD; a completed reviewer verdict
// after quality approval resets it. `gateFailures` counts red gate-1 results
// and every green gate-1 resets it. `correctnessFailures` counts correctness
// rejections only. No counter spends or resets another counter. There is no
// implementer-attempt budget: `attempt` remains only a sequence number.
//
// Reviewer harness failure keeps #41's separate rule: it charges none of the
// three budgets and leaves their streaks alone (apart from a green gate's own
// reset). `reviewerHarnessFailures` is a per-inner-loop total that never resets;
// its second failure terminates. This closes the otherwise unbounded
// red+quality-approved / green+harness-failed alternation.
//
// A COMPLETE claim is routed on THREE inputs, not one: the promise token, a
// clean worktree (#24 D1), and HEAD still being the issue branch (#27). The
// runner repairs an ancestor mismatch before this event (#127); a surviving
// mismatch runs FIRST because it subsumes the dirty check: commits on a
// detached HEAD leave a CLEAN tree, so the gate would go green on a tree the
// branch does not contain (git-ops.ts spells out the reachable shape).
// COMPLETE + dirty spends an attempt on a re-prompt to commit rather than
// dispatching the gate. The branch check also applies to NO-SIGNAL; the
// hand-to-human terminals NEEDS-INFO and NEEDS-UI-PROTOTYPE (#21, stops
// before the gate) are exempt — they land nothing by construction.
//
// Gate-1 and quality review run concurrently against the same immutable commit
// (#123/#143). Reviewer writes always park. A red gate keeps the quality result
// and history, then ends the round; correctness runs only after quality approval
// AND a green gate. Thus red+quality-rejected spends both relevant counters,
// while red+quality-approved spends only the gate counter.
//
// A reviewer that produced NO review is not a verdict (#41); that judgment is
// reviewer-run.ts's. `reviewer-harness-failed` consumes no review round,
// leaves retained reviewer feedback untouched, and names itself in exhaustion
// rather than a rejection. The next implementer attempt is dispatched anyway
// — unreviewed work must not read as DONE — with an orchestrator note,
// not a finding. The SECOND harness failure anywhere in this inner loop
// terminates instead.
//
// HARD-ERROR is not a verdict the SM ever emits — it's how the runner wraps
// unhandled exceptions; decideAfterTerminal answers "retry with a fresh
// sandbox or surface?" for the runner's outer loop.

import type { HeadMismatch } from "./git-ops.js";
import type { ParseSignal } from "./promise-parser.js";
import type { UiCheckResult } from "./ui-check-parser.js";

export const HARD_ERROR_MAX_RETRIES = 2;
export const REVIEWER_HARNESS_FAILURE_LIMIT = 2;

export type ReviewerFeedback = {
  readonly disposition:
    | "CHANGES-REQUESTED"
    | "APPROVED-CORRECTNESS-SKIPPED";
  readonly prose: string;
};

export type LoopPhase =
  | "needs-ui-check"
  | "needs-implementer"
  | "needs-gate-and-reviewer"
  | "terminated";

export type LoopState = {
  readonly issueBranch: string;
  readonly maxQualityRounds: number;
  readonly maxGateRounds: number;
  readonly maxReviewRounds: number;
  readonly attempt: number;
  readonly qualityFailures: number;
  readonly gateFailures: number;
  readonly correctnessFailures: number;
  readonly lastFailureTrace: string;
  readonly extraReprompt: string | null;
  // Includes disposition because paid-for quality prose under a red gate can
  // be an approval even though correctness was deliberately skipped (#143).
  readonly latestReviewerFeedback: ReviewerFeedback | null;
  // The dirty set that sent the PREVIOUS attempt back to commit its work, or
  // null if the last attempt didn't end that way. Only used to detect that an
  // attempt changed nothing — see onImplementerResult.
  readonly lastDirtyPaths: readonly string[] | null;
  // Whether the PREVIOUS attempt was sent back because HEAD was not the issue
  // branch (#27). One re-prompt is offered; a second consecutive off-branch
  // attempt terminates — see onImplementerResult.
  readonly lastOffBranch: boolean;
  // Total review rounds in this inner loop that yielded no review at all (#41,
  // #143). Never reset: infrastructure faults are bounded independently of
  // convergence streaks, including when ordinary verdicts occur between them.
  readonly reviewerHarnessFailures: number;
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
      // Quality- or gate-round budget exhausted, or a dedicated early-stop rule
      // fired.
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
      //     no gate ever ran.
      //   off-branch-head — the implementer committed somewhere other than
      //     `refs/heads/<branch>` (detached HEAD, or a branch of its own) and a
      //     second consecutive attempt was still off it (#27). `failureTrace`
      //     carries where HEAD actually is, which is the only handle anyone has
      //     on the stranded commits once the worktree is removed.
      //   reviewer-harness-failed — the reviewer produced no review at all twice
      //     in this inner loop (#41/#143). `failureTrace` carries why every
      //     invocation in the latest failed round yielded nothing. Distinct
      //     from a rejection because the code was never judged: there is no
      //     CHANGES-REQUESTED to act on, and the
      //     thing to fix is the harness. `latestReviewerProse` is whatever an
      //     EARLIER round said, if any — never the harness error.
      readonly type: "NEEDS-HUMAN";
      readonly cause:
        | "gate-red"
        | "no-signal-exhausted"
        | "uncommittable-worktree"
        | "off-branch-head"
        | "reviewer-harness-failed";
      readonly failureTrace: string;
      readonly latestReviewerProse: string | null;
      // Present exactly when a convergence budget, rather than a dedicated
      // early-stop rule, ended the loop.
      readonly budgetExhausted: {
        readonly budget: "quality" | "gate";
        readonly roundsUsed: number;
      } | null;
      // Set only by `off-branch-head`, so finalize can render the rescue note
      // from structure rather than parse it back out of the trace prose.
      readonly strandedHead: HeadMismatch | null;
    }
  | {
      readonly type: "NEEDS-HUMAN-REVIEW";
      readonly latestReviewerProse: string;
      readonly cause:
        | "quality-budget-exhausted"
        | "correctness-budget-exhausted";
      readonly roundsUsed: number;
    }
  | {
      readonly type: "NEEDS-HUMAN-REVIEW";
      readonly latestReviewerProse: string;
      readonly cause: "reviewer-wrote" | "ui-checker-wrote";
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
  | { readonly kind: "run-ui-check" }
  | {
      readonly kind: "run-implementer";
      readonly attempt: number;
      readonly failureTrace: string;
      readonly extraReprompt: string | null;
      readonly latestReviewerFeedback: ReviewerFeedback | null;
    }
  | {
      readonly kind: "run-gate-and-reviewer";
      readonly attempt: number;
      readonly reviewRound: number;
    }
  | { readonly kind: "terminate"; readonly verdict: Verdict };

// The UI phase is derived from the machine's transition result, never guessed
// by the I/O runner. Gate-1 and review are a set because they run concurrently
// after COMPLETE (#123, #132).
export function visiblePhases(
  action: LoopAction,
): readonly ("ui-check" | "implementer" | "gate-1" | "review")[] {
  switch (action.kind) {
    case "run-ui-check": return ["ui-check"];
    case "run-implementer": return ["implementer"];
    case "run-gate-and-reviewer": return ["gate-1", "review"];
    case "terminate": return [];
  }
}

export type LoopEvent =
  | { readonly kind: "ui-check-result"; readonly result: UiCheckResult }
  | { readonly kind: "ui-checker-wrote"; readonly detail: string }
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
      // consume the off-branch correction budget.
      readonly fastForwarded: {
        readonly fromSha: string;
        readonly toSha: string;
      } | null;
    }
  | {
      readonly kind: "gate-and-reviewer-result";
      readonly gate: Gate1Result;
      readonly reviewer: ReviewerResult;
      // Observation produced beside the machine decision. The runner emits it
      // only after this event has been applied once, using the returned state
      // for the three post-round budgets (#132/#143).
      readonly reviewRound?: {
        readonly head: string;
        readonly qualityMode: "list" | "verify";
        readonly quality: "APPROVED" | "CHANGES-REQUESTED" | "HARNESS-FAILED";
        readonly correctness: "APPROVED" | "CHANGES-REQUESTED" | "SKIPPED" | "HARNESS-FAILED";
        readonly rejectingPass: "quality" | "correctness" | null;
        readonly durationMs: number;
      };
    };

export type Gate1Result = {
  readonly ok: boolean;
  readonly failureTrace: string;
};
export type ReviewerResult =
  | {
      readonly kind: "reviewer-result";
      readonly verdict: "APPROVED";
      readonly prose: string;
    }
  | {
      readonly kind: "reviewer-result";
      readonly verdict: "CHANGES-REQUESTED";
      readonly rejectingPass: "quality" | "correctness";
      readonly prose: string;
    }
  | {
      // The reviewer was invoked its full invocation budget and none of the runs
      // produced a review (#41). NOT a verdict — see the module header for what
      // that changes. `detail` says why each invocation yielded nothing; it is
      // diagnostics, never prose attributed to the reviewer.
      readonly kind: "reviewer-harness-failed";
      readonly pass: "quality" | "correctness";
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
};

export function initialState(opts: InitialStateOptions): LoopState {
  if (!Number.isInteger(opts.maxQualityRounds) || opts.maxQualityRounds < 1) {
    throw new Error(
      `maxQualityRounds must be a positive integer, got ${opts.maxQualityRounds}`,
    );
  }
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
    maxQualityRounds: opts.maxQualityRounds,
    maxGateRounds: opts.maxGateRounds,
    maxReviewRounds: opts.maxReviewRounds,
    attempt: 1,
    qualityFailures: 0,
    gateFailures: 0,
    correctnessFailures: 0,
    lastFailureTrace: "",
    extraReprompt: null,
    latestReviewerFeedback: null,
    lastDirtyPaths: null,
    lastOffBranch: false,
    reviewerHarnessFailures: 0,
    phase: opts.uiPrototypeCheck ? "needs-ui-check" : "needs-implementer",
  };
}

export function initialAction(state: LoopState): LoopAction {
  if (state.phase === "needs-ui-check") return { kind: "run-ui-check" };
  return {
    kind: "run-implementer",
    attempt: state.attempt,
    failureTrace: state.lastFailureTrace,
    extraReprompt: state.extraReprompt,
    latestReviewerFeedback: state.latestReviewerFeedback,
  };
}

export function step(state: LoopState, event: LoopEvent): StepResult {
  if (state.phase === "terminated") {
    throw new Error("inner-loop machine stepped after termination");
  }

  switch (event.kind) {
    case "ui-checker-wrote":
      if (state.phase !== "needs-ui-check") {
        throw new Error(
          `ui-checker-wrote event in phase ${state.phase}; expected needs-ui-check`,
        );
      }
      return terminate(state, {
        type: "NEEDS-HUMAN-REVIEW",
        cause: "ui-checker-wrote",
        latestReviewerProse: event.detail,
      });

    case "ui-check-result":
      if (state.phase !== "needs-ui-check") {
        throw new Error(
          `ui-check-result event in phase ${state.phase}; expected needs-ui-check`,
        );
      }
      if (event.result.kind === "PROTOTYPE-NEEDED") {
        return terminate(state, {
          type: "NEEDS-UI-PROTOTYPE",
          uiImpact: event.result.uiImpact,
          strandedHead: null,
        });
      }
      const nextState: LoopState = { ...state, phase: "needs-implementer" };
      return { state: nextState, action: initialAction(nextState) };

    case "implementer-result":
      if (state.phase !== "needs-implementer") {
        throw new Error(
          `implementer-result event in phase ${state.phase}; expected needs-implementer`,
        );
      }
      return onImplementerResult(
        state,
        event.signal,
        event.dirtyPaths,
        event.offBranch,
        event.fastForwarded,
      );

    case "gate-and-reviewer-result":
      if (state.phase !== "needs-gate-and-reviewer") {
        throw new Error(
          `gate-and-reviewer-result event in phase ${state.phase}; expected needs-gate-and-reviewer`,
        );
      }
      return onGateAndReviewerResult(state, event.gate, event.reviewer);
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

// The orchestrator note for an attempt whose review round produced no review
// (#41). Exported so the wording is asserted where the routing is.
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
// Every claim it makes is scoped to this round, and that scoping is the whole
// of its correctness. `latestReviewerProse` is carried forward untouched, so
// `renderAttemptSlot` may well render an EARLIER round's real report directly
// above this note, under an "Address the reviewer's concerns" imperative. A
// note saying there is no reviewer feedback above would then be false — and
// handing an implementer a false statement about what the reviewer said is the
// thing this issue exists to stop, moved one slot over. So the note names the
// two cases explicitly rather than asserting either.
//
// It deliberately quotes NONE of the harness detail. The detail names an idle
// timeout in seconds and a podman exec — an implementer cannot act on any of it
// from inside its sandbox, and an agent handed a failure it cannot fix will
// try anyway. That text goes to the run log and, if this recurs, to the human
// handoff, which are the two places someone can do something with it.
export function reviewerHarnessFailedReprompt(
  gateOk: boolean,
  priorDisposition: ReviewerFeedback["disposition"] | null = null,
): string {
  return [
    "The code reviewer could not be run this round: every invocation returned",
    "no review at all. That is a fault in the orchestrator's harness, not a",
    "finding about your work — nothing was said about your code this round, and",
    "neither review-pass budget was charged for it.",
    "",
    gateOk
      ? "Gate-1 passed on your last commit, and that verdict stands. Do not rework"
      : "Gate-1 failed on your last commit; its independent trace appears above. Do not",
    gateOk
      ? "or revert anything on the strength of this note. There is no NEW reviewer"
      : "infer any additional code finding from this harness fault. There is no NEW reviewer",
    ...(priorDisposition === "CHANGES-REQUESTED"
      ? [
          "feedback. The retained CHANGES-REQUESTED report above is from an earlier",
          "round; its concerns still stand and are still what to address.",
        ]
      : priorDisposition === "APPROVED-CORRECTNESS-SKIPPED"
        ? [
            "feedback. The retained quality approval above is from an earlier red-gate",
            "round; it is informational, and correctness was not run in that round.",
          ]
        : [
            "feedback. No reviewer has said anything about this branch at all.",
          ]),
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
  signal: ParseSignal,
  dirtyPaths: readonly string[],
  offBranch: HeadMismatch | null,
  fastForwarded: Extract<
    LoopEvent,
    { kind: "implementer-result" }
  >["fastForwarded"],
): StepResult {
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
  // case remains. A detached
  // HEAD leaves a CLEAN tree, so the dirty check below cannot see it, and the
  // gate would go green on a tree `refs/heads/<branch>` does not contain.
  //
  // ONE re-prompt, then terminate — and the asymmetry with the dirty-set rule
  // above is deliberate. The mechanical ancestor case spent no correction
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
    const exhausted: Verdict = {
      type: "NEEDS-HUMAN",
      cause: "off-branch-head",
      failureTrace: trace,
      latestReviewerProse: reviewerProse(state),
      budgetExhausted: null,
      strandedHead: offBranch,
    };
    return transitionAfterQualityFailure(
      state,
      state.lastOffBranch
        ? null
        : {
            // Becomes the NEEDS-HUMAN trace if this was the last attempt, so the
            // handoff names where the commits went rather than a gate that never ran.
            failureTrace: trace,
            extraReprompt: trace,
            latestReviewerFeedback: state.latestReviewerFeedback,
            offBranch: true,
          },
      exhausted,
    );
  }
  if (signal.kind === "COMPLETE") {
    // Dirty tree: another attempt with "commit your work", NOT the gate. Cheaper
    // than letting the gate refuse (no attempt containers get built) and far
    // more actionable than a red verdict, and it is the only routing that keeps
    // the forgotten `git add` — the overwhelmingly common cause — rather than
    // letting a `git clean` destroy it.
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
      if (
        state.lastDirtyPaths !== null &&
        sameDirtySet(state.lastDirtyPaths, dirtyPaths)
      ) {
        const earlyStop: Verdict = {
          type: "NEEDS-HUMAN",
          cause: "uncommittable-worktree",
          failureTrace: trace,
          latestReviewerProse: reviewerProse(state),
          budgetExhausted: null,
          strandedHead: null,
        };
        return transitionAfterQualityFailure(state, null, earlyStop);
      }
      return transitionAfterQualityFailure(
        state,
        {
          // Becomes the NEEDS-HUMAN trace if the budget runs out here, so the
          // human gets the paths rather than "budget exhausted with no green
          // gate" for a run in which the gate never executed.
          failureTrace: trace,
          extraReprompt: joinOrchestratorNotes(fastForwardedNote, trace),
          latestReviewerFeedback: state.latestReviewerFeedback,
          dirtyPaths,
        },
        // Built from the dirty trace, not from state.lastFailureTrace: the gate
        // never ran on this route, so the generic "budget exhausted with no
        // green gate" would describe a failure that did not happen.
        {
          type: "NEEDS-HUMAN",
          cause: "uncommittable-worktree",
          failureTrace: trace,
          latestReviewerProse: null,
          budgetExhausted: null,
          strandedHead: null,
        },
      );
    }
    return {
      state: {
        ...state,
        phase: "needs-gate-and-reviewer",
        // Keep the repair note only long enough to render it if gate/reviewer
        // routing produces another implementer attempt.
        extraReprompt: fastForwardedNote,
        lastDirtyPaths: null,
        lastOffBranch: false,
      },
      action: {
        kind: "run-gate-and-reviewer",
        attempt: state.attempt,
        reviewRound: state.attempt,
      },
    };
  }
  // NO-SIGNAL — either re-prompt for next attempt or exhaust the budget. This
  // route has its own cause because the deciding attempt did not run a gate,
  // while its trace preserves any gate failure from an earlier attempt (#116).
  const correction = signal.missingTag
    ? "The final implementer attempt emitted no <promise> token."
    : `The final implementer signal failed validation:\n${signal.reprompt}`;
  const failureTrace = state.lastFailureTrace
    ? `Last gate failure:\n${state.lastFailureTrace}\n\n${correction}`
    : correction;
  return transitionAfterQualityFailure(
    state,
    {
      failureTrace: state.lastFailureTrace,
      extraReprompt: joinOrchestratorNotes(fastForwardedNote, signal.reprompt),
      latestReviewerFeedback: state.latestReviewerFeedback,
    },
    {
      type: "NEEDS-HUMAN",
      cause: "no-signal-exhausted",
      failureTrace,
      latestReviewerProse: null,
      budgetExhausted: null,
      strandedHead: null,
    },
  );
}

function onGateAndReviewerResult(
  state: LoopState,
  gate: Gate1Result,
  reviewer: ReviewerResult,
): StepResult {
  const gatedState: LoopState = gate.ok
    ? { ...state, gateFailures: 0, lastFailureTrace: "" }
    : {
        ...state,
        gateFailures: state.gateFailures + 1,
        lastFailureTrace: gate.failureTrace,
      };
  if (reviewer.kind === "reviewer-wrote") {
    return {
      state: { ...gatedState, phase: "terminated" },
      action: {
        kind: "terminate",
        verdict: {
          type: "NEEDS-HUMAN-REVIEW",
          cause: "reviewer-wrote",
          latestReviewerProse: reviewer.detail,
        },
      },
    };
  }
  if (!gate.ok) return onRedGateReviewerResult(gatedState, reviewer);
  return reviewer.kind === "reviewer-result"
    ? onReviewerResult(gatedState, reviewer)
    : onReviewerHarnessFailed(gatedState, gate, reviewer.detail);
}

function onRedGateReviewerResult(
  state: LoopState,
  reviewer: Exclude<ReviewerResult, { kind: "reviewer-wrote" }>,
): StepResult {
  if (reviewer.kind === "reviewer-harness-failed") {
    return onReviewerHarnessFailed(
      state,
      { ok: false, failureTrace: state.lastFailureTrace },
      reviewer.detail,
    );
  }
  if (
    reviewer.verdict === "CHANGES-REQUESTED" &&
    reviewer.rejectingPass === "correctness"
  ) {
    throw new Error("correctness review completed under a red gate");
  }

  if (reviewer.verdict === "CHANGES-REQUESTED") {
    const reviewedState: LoopState = {
      ...state,
      qualityFailures: state.qualityFailures + 1,
      latestReviewerFeedback: {
        disposition: "CHANGES-REQUESTED",
        prose: reviewer.prose,
      },
    };
    if (reviewedState.gateFailures >= reviewedState.maxGateRounds) {
      return terminate(
        reviewedState,
        gateRedExhaustion(reviewedState, reviewer.prose),
      );
    }
    if (reviewedState.qualityFailures >= reviewedState.maxQualityRounds) {
      return terminate(reviewedState, {
        type: "NEEDS-HUMAN-REVIEW",
        cause: "quality-budget-exhausted",
        roundsUsed: reviewedState.qualityFailures,
        latestReviewerProse: reviewer.prose,
      });
    }
    return advanceAttempt(reviewedState, {
      failureTrace: state.lastFailureTrace,
      extraReprompt: state.extraReprompt,
      latestReviewerFeedback: reviewedState.latestReviewerFeedback,
    });
  }

  // Quality approved but the red gate prevented a completed reviewer verdict:
  // preserve the quality streak, skip correctness, spend only the gate streak,
  // and keep the paid-for quality prose for the implementer and history.
  const reviewedState: LoopState = {
    ...state,
    latestReviewerFeedback: {
      disposition: "APPROVED-CORRECTNESS-SKIPPED",
      prose: reviewer.prose,
    },
  };
  if (reviewedState.gateFailures >= reviewedState.maxGateRounds) {
    return terminate(
      reviewedState,
      gateRedExhaustion(reviewedState, reviewer.prose),
    );
  }
  return advanceAttempt(reviewedState, {
    failureTrace: reviewedState.lastFailureTrace,
    extraReprompt: reviewedState.extraReprompt,
    latestReviewerFeedback: reviewedState.latestReviewerFeedback,
  });
}

function onReviewerResult(
  state: LoopState,
  reviewer: Extract<ReviewerResult, { kind: "reviewer-result" }>,
): StepResult {
  if (reviewer.verdict === "APPROVED") {
    return terminate({ ...state, qualityFailures: 0 }, { type: "DONE" });
  }
  if (reviewer.rejectingPass === "quality") {
    const reviewingState: LoopState = {
      ...state,
      latestReviewerFeedback: {
        disposition: "CHANGES-REQUESTED",
        prose: reviewer.prose,
      },
      lastFailureTrace: "",
    };
    return transitionAfterQualityFailure(
      reviewingState,
      {
        failureTrace: "",
        extraReprompt: state.extraReprompt,
        latestReviewerFeedback: reviewingState.latestReviewerFeedback,
      },
      {
        type: "NEEDS-HUMAN-REVIEW",
        cause: "quality-budget-exhausted",
        roundsUsed: state.qualityFailures + 1,
        latestReviewerProse: reviewer.prose,
      },
    );
  }

  const correctnessFailures = state.correctnessFailures + 1;
  const reviewedState: LoopState = {
    ...state,
    qualityFailures: 0,
    correctnessFailures,
    latestReviewerFeedback: {
      disposition: "CHANGES-REQUESTED",
      prose: reviewer.prose,
    },
    lastFailureTrace: "",
  };
  if (correctnessFailures >= state.maxReviewRounds) {
    return terminate(reviewedState, {
      type: "NEEDS-HUMAN-REVIEW",
      cause: "correctness-budget-exhausted",
      roundsUsed: correctnessFailures,
      latestReviewerProse: reviewer.prose,
    });
  }
  return advanceAttempt(
    reviewedState,
    {
      failureTrace: "",
      extraReprompt: state.extraReprompt,
      latestReviewerFeedback: reviewedState.latestReviewerFeedback,
    },
  );
}

// The reviewer produced no review at all (#41/#143). No convergence budget is
// charged by that fault; a red gate still increments its own streak and a green
// gate still resets it. `latestReviewerFeedback` keeps whatever an earlier
// round actually said, including its disposition.
//
// The attempt number still advances so one more implementer run can do real
// work and re-reach the reviewer through a fresh gate. The per-loop total below
// bounds a component that has already exhausted its own invocation retries.
function onReviewerHarnessFailed(
  state: LoopState,
  gate: Gate1Result,
  detail: string,
): StepResult {
  const reviewerHarnessFailures = state.reviewerHarnessFailures + 1;
  const failedState = { ...state, reviewerHarnessFailures };
  const exhausted: Verdict = {
    type: "NEEDS-HUMAN",
    cause: "reviewer-harness-failed",
    failureTrace: gate.ok
      ? detail
      : `Gate-1 failure:\n${gate.failureTrace}\n\nReviewer harness failure:\n${detail}`,
    // An earlier round's real report, if there was one. Never `detail` — the
    // handoff renders this as the reviewer speaking.
    latestReviewerProse: reviewerProse(state),
    budgetExhausted: null,
    strandedHead: null,
  };
  if (reviewerHarnessFailures >= REVIEWER_HARNESS_FAILURE_LIMIT) {
    return terminate(failedState, exhausted);
  }
  if (!gate.ok && failedState.gateFailures >= failedState.maxGateRounds) {
    return terminate(
      failedState,
      gateRedExhaustion(failedState, reviewerProse(failedState)),
    );
  }
  return advanceAttempt(
    failedState,
    {
      failureTrace: gate.failureTrace,
      extraReprompt: joinOrchestratorNotes(
        state.extraReprompt,
        reviewerHarnessFailedReprompt(
          gate.ok,
          state.latestReviewerFeedback?.disposition ?? null,
        ),
      ),
      latestReviewerFeedback: state.latestReviewerFeedback,
    },
  );
}

// Gate-red is only reachable after a real gate execution, so its trace is
// always present. NO-SIGNAL exhaustion has a distinct cause above (#116).
function gateRedExhaustion(
  state: LoopState,
  latestReviewerProse: string | null,
): Verdict {
  return {
    type: "NEEDS-HUMAN",
    cause: "gate-red",
    failureTrace: state.lastFailureTrace,
    latestReviewerProse,
    budgetExhausted: {
      budget: "gate",
      roundsUsed: state.gateFailures,
    },
    strandedHead: null,
  };
}

function transitionAfterQualityFailure(
  state: LoopState,
  // `null` means a dedicated rule (repeated dirt or off-branch HEAD) stops the
  // loop even if the quality budget still has room.
  next: Parameters<typeof advanceAttempt>[1] | null,
  onBudgetExhausted: Verdict,
): StepResult {
  const charged = {
    ...state,
    qualityFailures: state.qualityFailures + 1,
  };
  const budgetExhausted =
    charged.qualityFailures >= charged.maxQualityRounds;
  if (!budgetExhausted && next !== null) {
    return advanceAttempt(charged, next);
  }
  const verdict =
    budgetExhausted && onBudgetExhausted.type === "NEEDS-HUMAN"
      ? {
          ...onBudgetExhausted,
          budgetExhausted: {
            budget: "quality" as const,
            roundsUsed: charged.qualityFailures,
          },
        }
      : onBudgetExhausted;
  return terminate(charged, verdict);
}

function advanceAttempt(
  state: LoopState,
  next: {
    readonly failureTrace: string;
    readonly extraReprompt: string | null;
    readonly latestReviewerFeedback: ReviewerFeedback | null;
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
      latestReviewerFeedback: ns.latestReviewerFeedback,
    },
  };
}

function reviewerProse(state: LoopState): string | null {
  return state.latestReviewerFeedback?.prose ?? null;
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
