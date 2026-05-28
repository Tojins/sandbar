// Pure inner-loop state machine.
//
// Drives an issue-attempts loop without any I/O. After every observation the
// runner calls step(state, event) and executes the returned action; when the
// action is `terminate` the loop is done and the verdict is the runner's
// outcome. Every decision that used to live inlined in inner-loop.ts —
// COMPLETE/NEEDS-INFO/NO-SIGNAL routing, gate-1 red re-prompt, gate-2 verdict
// selection, attempt-budget exhaustion — now lives here and is table-driven
// tested in inner-loop-machine.test.ts.
//
// Sandbox lifecycle (setup, HARD-ERROR retry-with-fresh-sandbox) sits one
// layer above this machine: decideAfterTerminal answers "retry or surface?"
// for the runner's outer loop, and the rest of the lifecycle is pure I/O
// that doesn't need state-machine modelling.

import type { ParseSignal } from "./promise-parser.js";

export const HARD_ERROR_MAX_RETRIES = 2;

export const NEEDS_HUMAN_BUDGET_EXHAUSTED_MESSAGE =
  "Attempt budget exhausted with no green gate.";

export type LoopPhase =
  | "needs-implementer"
  | "needs-gate-1"
  | "needs-reviewer-and-gate-2"
  | "terminated";

export type LoopState = {
  readonly maxAttempts: number;
  readonly attempt: number;
  readonly lastFailureTrace: string;
  readonly extraReprompt: string | null;
  readonly phase: LoopPhase;
};

// Verdict is the pure terminal value the SM emits. The runner turns it into a
// Terminal by attaching commit lists and (for REVERT-THEN-DONE) running the
// reset — those are I/O state and would pollute the SM.
export type Verdict =
  | { readonly type: "DONE" }
  | { readonly type: "REVERT-THEN-DONE" }
  | { readonly type: "NEEDS-INFO"; readonly questions: string }
  | { readonly type: "NEEDS-HUMAN"; readonly failureTrace: string }
  | { readonly type: "HARD-ERROR"; readonly reason: string };

export type LoopAction =
  | {
      readonly kind: "run-implementer";
      readonly attempt: number;
      readonly failureTrace: string;
      readonly extraReprompt: string | null;
    }
  | { readonly kind: "run-gate-1"; readonly attempt: number }
  | { readonly kind: "run-reviewer-and-gate-2"; readonly attempt: number }
  | { readonly kind: "terminate"; readonly verdict: Verdict };

export type LoopEvent =
  | { readonly kind: "implementer-result"; readonly signal: ParseSignal }
  | {
      readonly kind: "gate-1-result";
      readonly ok: boolean;
      readonly failureTrace: string;
    }
  | {
      readonly kind: "gate-2-result";
      readonly ok: boolean;
      readonly reviewerCommitCount: number;
      readonly failureTrace: string;
      readonly failedStep: "check" | "test" | null;
    };

export type StepResult = {
  readonly state: LoopState;
  readonly action: LoopAction;
};

export function initialState(maxAttempts: number): LoopState {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`maxAttempts must be a positive integer, got ${maxAttempts}`);
  }
  return {
    maxAttempts,
    attempt: 1,
    lastFailureTrace: "",
    extraReprompt: null,
    phase: "needs-implementer",
  };
}

export function initialAction(state: LoopState): LoopAction {
  return {
    kind: "run-implementer",
    attempt: state.attempt,
    failureTrace: state.lastFailureTrace,
    extraReprompt: state.extraReprompt,
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

    case "gate-2-result":
      if (state.phase !== "needs-reviewer-and-gate-2") {
        throw new Error(
          `gate-2-result event in phase ${state.phase}; expected needs-reviewer-and-gate-2`,
        );
      }
      return onGate2Result(
        state,
        event.ok,
        event.reviewerCommitCount,
        event.failureTrace,
        event.failedStep,
      );
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
  });
}

function onGate1Result(
  state: LoopState,
  ok: boolean,
  failureTrace: string,
): StepResult {
  if (ok) {
    return {
      state: { ...state, phase: "needs-reviewer-and-gate-2" },
      action: { kind: "run-reviewer-and-gate-2", attempt: state.attempt },
    };
  }
  return advanceAttempt(
    { ...state, lastFailureTrace: failureTrace },
    { failureTrace, extraReprompt: null },
  );
}

function onGate2Result(
  state: LoopState,
  ok: boolean,
  reviewerCommitCount: number,
  failureTrace: string,
  failedStep: "check" | "test" | null,
): StepResult {
  if (ok) return terminate(state, { type: "DONE" });
  if (reviewerCommitCount > 0) return terminate(state, { type: "REVERT-THEN-DONE" });
  // gate-1 was green moments ago; gate-2 red with no reviewer edits is
  // treated as infra flake. Verdict is HARD-ERROR; the runner's outer layer
  // decides whether to retry with a fresh sandbox (decideAfterTerminal).
  return terminate(state, {
    type: "HARD-ERROR",
    reason: `gate-2 red with no reviewer commits (failed step: ${failedStep ?? "unknown"})\n${failureTrace}`,
  });
}

function advanceAttempt(
  state: LoopState,
  next: { readonly failureTrace: string; readonly extraReprompt: string | null },
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
  };
  return {
    state: ns,
    action: {
      kind: "run-implementer",
      attempt: newAttempt,
      failureTrace: next.failureTrace,
      extraReprompt: next.extraReprompt,
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
