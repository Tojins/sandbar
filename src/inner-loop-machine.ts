// Pure inner-loop state machine.
//
// Drives an issue-attempts loop without any I/O. After every observation the
// runner calls step(state, event) and executes the returned action; when the
// action is `terminate` the loop is done and the verdict is the runner's
// outcome. Every decision — COMPLETE/NEEDS-INFO/NO-SIGNAL routing, gate-1
// red re-prompt, reviewer APPROVED/CHANGES-REQUESTED routing, attempt and
// review-round budget exhaustion — lives here and is table-driven tested in
// inner-loop-machine.test.ts.
//
// Reviewer is strictly advisory: it never commits and the SM never asks the
// runner to revert anything. Convergence comes from the bar being sharp
// enough for the reviewer to issue a deterministic verdict, not from
// commit-and-revert round-trips.
//
// Sandbox lifecycle (setup, HARD-ERROR retry-with-fresh-sandbox) sits one
// layer above this machine: decideAfterTerminal answers "retry or surface?"
// for the runner's outer loop. HARD-ERROR is not a verdict the SM ever emits
// itself — it's how the runner wraps unhandled exceptions (setup failures,
// container errors, etc.) so the outer loop can decide whether to retry.

import type { ParseSignal } from "./promise-parser.js";

export const HARD_ERROR_MAX_RETRIES = 2;

export const NEEDS_HUMAN_BUDGET_EXHAUSTED_MESSAGE =
  "Attempt budget exhausted with no green gate.";

export const NEEDS_HUMAN_REVIEW_BUDGET_EXHAUSTED_MESSAGE =
  "Review-round budget exhausted without an APPROVED verdict.";

export type LoopPhase =
  | "needs-implementer"
  | "needs-gate-1"
  | "needs-reviewer"
  | "terminated";

export type LoopState = {
  readonly maxAttempts: number;
  readonly maxReviewRounds: number;
  readonly attempt: number;
  readonly reviewRoundsUsed: number;
  readonly lastFailureTrace: string;
  readonly extraReprompt: string | null;
  readonly latestReviewerProse: string | null;
  readonly phase: LoopPhase;
};

// Verdict is the pure terminal value the SM emits. The runner translates it
// into a Terminal for the outer orchestrator. HARD-ERROR is never emitted by
// the SM itself — it's the runner's wrapper for unhandled exceptions and
// lives in this type only so decideAfterTerminal can pattern-match on it.
export type Verdict =
  | { readonly type: "DONE" }
  | { readonly type: "NEEDS-INFO"; readonly questions: string }
  | { readonly type: "NEEDS-HUMAN"; readonly failureTrace: string }
  | {
      readonly type: "NEEDS-HUMAN-REVIEW";
      readonly latestReviewerProse: string;
    }
  | { readonly type: "HARD-ERROR"; readonly reason: string };

export type LoopAction =
  | {
      readonly kind: "run-implementer";
      readonly attempt: number;
      readonly failureTrace: string;
      readonly extraReprompt: string | null;
      readonly latestReviewerProse: string | null;
    }
  | { readonly kind: "run-gate-1"; readonly attempt: number }
  | {
      readonly kind: "run-reviewer";
      readonly attempt: number;
      readonly reviewRound: number;
    }
  | { readonly kind: "terminate"; readonly verdict: Verdict };

export type LoopEvent =
  | { readonly kind: "implementer-result"; readonly signal: ParseSignal }
  | {
      readonly kind: "gate-1-result";
      readonly ok: boolean;
      readonly failureTrace: string;
    }
  | {
      readonly kind: "reviewer-result";
      readonly verdict: "APPROVED" | "CHANGES-REQUESTED";
      readonly prose: string;
    };

export type StepResult = {
  readonly state: LoopState;
  readonly action: LoopAction;
};

export type InitialStateOptions = {
  readonly maxAttempts: number;
  readonly maxReviewRounds: number;
};

export function initialState(opts: InitialStateOptions): LoopState {
  if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) {
    throw new Error(
      `maxAttempts must be a positive integer, got ${opts.maxAttempts}`,
    );
  }
  if (!Number.isInteger(opts.maxReviewRounds) || opts.maxReviewRounds < 1) {
    throw new Error(
      `maxReviewRounds must be a positive integer, got ${opts.maxReviewRounds}`,
    );
  }
  return {
    maxAttempts: opts.maxAttempts,
    maxReviewRounds: opts.maxReviewRounds,
    attempt: 1,
    reviewRoundsUsed: 0,
    lastFailureTrace: "",
    extraReprompt: null,
    latestReviewerProse: null,
    phase: "needs-implementer",
  };
}

export function initialAction(state: LoopState): LoopAction {
  return {
    kind: "run-implementer",
    attempt: state.attempt,
    failureTrace: state.lastFailureTrace,
    extraReprompt: state.extraReprompt,
    latestReviewerProse: state.latestReviewerProse,
  };
}

export function step(state: LoopState, event: LoopEvent): StepResult {
  if (state.phase === "terminated") {
    throw new Error("inner-loop machine stepped after termination");
  }

  switch (event.kind) {
    case "implementer-result":
      if (state.phase !== "needs-implementer") {
        throw new Error(
          `implementer-result event in phase ${state.phase}; expected needs-implementer`,
        );
      }
      return onImplementerResult(state, event.signal);

    case "gate-1-result":
      if (state.phase !== "needs-gate-1") {
        throw new Error(
          `gate-1-result event in phase ${state.phase}; expected needs-gate-1`,
        );
      }
      return onGate1Result(state, event.ok, event.failureTrace);

    case "reviewer-result":
      if (state.phase !== "needs-reviewer") {
        throw new Error(
          `reviewer-result event in phase ${state.phase}; expected needs-reviewer`,
        );
      }
      return onReviewerResult(state, event.verdict, event.prose);
  }
}

function onImplementerResult(state: LoopState, signal: ParseSignal): StepResult {
  if (signal.kind === "NEEDS-INFO") {
    return terminate(state, { type: "NEEDS-INFO", questions: signal.questions });
  }
  if (signal.kind === "COMPLETE") {
    return {
      state: { ...state, phase: "needs-gate-1", extraReprompt: null },
      action: { kind: "run-gate-1", attempt: state.attempt },
    };
  }
  // NO-SIGNAL — either re-prompt for next attempt or exhaust the budget.
  return advanceAttempt(state, {
    failureTrace: state.lastFailureTrace,
    extraReprompt: signal.reprompt ?? null,
    latestReviewerProse: state.latestReviewerProse,
  });
}

function onGate1Result(
  state: LoopState,
  ok: boolean,
  failureTrace: string,
): StepResult {
  if (ok) {
    return {
      state: { ...state, phase: "needs-reviewer" },
      action: {
        kind: "run-reviewer",
        attempt: state.attempt,
        reviewRound: state.reviewRoundsUsed + 1,
      },
    };
  }
  return advanceAttempt(
    { ...state, lastFailureTrace: failureTrace },
    {
      failureTrace,
      extraReprompt: null,
      latestReviewerProse: state.latestReviewerProse,
    },
  );
}

function onReviewerResult(
  state: LoopState,
  verdict: "APPROVED" | "CHANGES-REQUESTED",
  prose: string,
): StepResult {
  const reviewRoundsUsed = state.reviewRoundsUsed + 1;
  if (verdict === "APPROVED") {
    return terminate({ ...state, reviewRoundsUsed }, { type: "DONE" });
  }
  // CHANGES-REQUESTED. If the review-round budget is now exhausted, surface
  // NEEDS-HUMAN-REVIEW with the latest prose. Otherwise dispatch another
  // implementer attempt carrying the prose (and clearing the gate trace —
  // gate-1 was green this attempt).
  if (reviewRoundsUsed >= state.maxReviewRounds) {
    return terminate(
      { ...state, reviewRoundsUsed, latestReviewerProse: prose },
      { type: "NEEDS-HUMAN-REVIEW", latestReviewerProse: prose },
    );
  }
  return advanceAttempt(
    {
      ...state,
      reviewRoundsUsed,
      latestReviewerProse: prose,
      lastFailureTrace: "",
    },
    { failureTrace: "", extraReprompt: null, latestReviewerProse: prose },
  );
}

function advanceAttempt(
  state: LoopState,
  next: {
    readonly failureTrace: string;
    readonly extraReprompt: string | null;
    readonly latestReviewerProse: string | null;
  },
): StepResult {
  if (state.attempt >= state.maxAttempts) {
    return terminate(state, {
      type: "NEEDS-HUMAN",
      failureTrace: state.lastFailureTrace || NEEDS_HUMAN_BUDGET_EXHAUSTED_MESSAGE,
    });
  }
  const newAttempt = state.attempt + 1;
  const ns: LoopState = {
    ...state,
    attempt: newAttempt,
    phase: "needs-implementer",
    extraReprompt: next.extraReprompt,
    latestReviewerProse: next.latestReviewerProse,
  };
  return {
    state: ns,
    action: {
      kind: "run-implementer",
      attempt: newAttempt,
      failureTrace: next.failureTrace,
      extraReprompt: next.extraReprompt,
      latestReviewerProse: next.latestReviewerProse,
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
