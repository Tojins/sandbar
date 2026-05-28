import { describe, expect, it } from "vitest";

import {
  HARD_ERROR_MAX_RETRIES,
  NEEDS_HUMAN_BUDGET_EXHAUSTED_MESSAGE,
  NEEDS_HUMAN_REVIEW_BUDGET_EXHAUSTED_MESSAGE,
  type LoopAction,
  type LoopEvent,
  type LoopState,
  type Verdict,
  decideAfterTerminal,
  initialAction,
  initialState,
  step,
} from "./inner-loop-machine.js";
import type { ParseSignal } from "./promise-parser.js";

// Tiny driver: runs the machine to completion given a script of events. Each
// event is paired with the action the runner just observed. Returns the
// verdict and the full action trace so each case can assert both.
function drive(
  opts: { maxAttempts: number; maxReviewRounds: number },
  script: readonly LoopEvent[],
): { readonly actions: readonly LoopAction[]; readonly verdict: Verdict } {
  let state: LoopState = initialState(opts);
  const actions: LoopAction[] = [initialAction(state)];
  for (const event of script) {
    const r = step(state, event);
    state = r.state;
    actions.push(r.action);
    if (r.action.kind === "terminate") {
      return { actions, verdict: r.action.verdict };
    }
  }
  throw new Error(
    `script exhausted without termination; last action: ${
      actions[actions.length - 1]?.kind
    }`,
  );
}

const complete: ParseSignal = { kind: "COMPLETE" };
const noSignal = (reprompt?: string): ParseSignal => ({
  kind: "NO-SIGNAL",
  ...(reprompt !== undefined ? { reprompt } : {}),
});
const needsInfo = (questions: string): ParseSignal => ({
  kind: "NEEDS-INFO",
  questions,
});

const gate1Ok: LoopEvent = { kind: "gate-1-result", ok: true, failureTrace: "" };
const gate1Red = (trace: string): LoopEvent => ({
  kind: "gate-1-result",
  ok: false,
  failureTrace: trace,
});
const approved = (prose: string = "lgtm"): LoopEvent => ({
  kind: "reviewer-result",
  verdict: "APPROVED",
  prose,
});
const changes = (prose: string): LoopEvent => ({
  kind: "reviewer-result",
  verdict: "CHANGES-REQUESTED",
  prose,
});
const impl = (signal: ParseSignal): LoopEvent => ({
  kind: "implementer-result",
  signal,
});

const defaultOpts = { maxAttempts: 8, maxReviewRounds: 3 } as const;

describe("inner-loop-machine — happy paths", () => {
  it("attempt 1 COMPLETE → gate-1 green → APPROVED → DONE", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete),
      gate1Ok,
      approved(),
    ]);
    expect(actions.map((a) => a.kind)).toEqual([
      "run-implementer",
      "run-gate-1",
      "run-reviewer",
      "terminate",
    ]);
    expect(verdict).toEqual({ type: "DONE" });
  });

  it("attempt 1 NEEDS-INFO short-circuits to NEEDS-INFO with questions block", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(needsInfo("what's the foo?")),
    ]);
    expect(actions.map((a) => a.kind)).toEqual(["run-implementer", "terminate"]);
    expect(verdict).toEqual({ type: "NEEDS-INFO", questions: "what's the foo?" });
  });
});

describe("inner-loop-machine — gate-1 red re-prompts", () => {
  it("multiple gate-1 reds before green, then APPROVED → DONE", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete),
      gate1Red("trace A"),
      impl(complete),
      gate1Red("trace B"),
      impl(complete),
      gate1Ok,
      approved(),
    ]);

    expect(actions.map((a) => a.kind)).toEqual([
      "run-implementer",
      "run-gate-1",
      "run-implementer",
      "run-gate-1",
      "run-implementer",
      "run-gate-1",
      "run-reviewer",
      "terminate",
    ]);

    const third = actions[4] as Extract<LoopAction, { kind: "run-implementer" }>;
    expect(third.attempt).toBe(3);
    expect(third.failureTrace).toBe("trace B");
    expect(third.extraReprompt).toBeNull();
    expect(third.latestReviewerProse).toBeNull();

    expect(verdict).toEqual({ type: "DONE" });
  });
});

describe("inner-loop-machine — reviewer CHANGES-REQUESTED loop", () => {
  it("one impl + CHANGES-REQUESTED → next impl carries latestReviewerProse + clears trace", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete),
      gate1Ok,
      changes("- naming nit in foo.ts"),
      impl(complete),
      gate1Ok,
      approved(),
    ]);

    const reviewerAction = actions[2] as Extract<
      LoopAction,
      { kind: "run-reviewer" }
    >;
    expect(reviewerAction.reviewRound).toBe(1);

    const secondImpl = actions[3] as Extract<
      LoopAction,
      { kind: "run-implementer" }
    >;
    expect(secondImpl.attempt).toBe(2);
    expect(secondImpl.latestReviewerProse).toBe("- naming nit in foo.ts");
    expect(secondImpl.failureTrace).toBe("");
    expect(secondImpl.extraReprompt).toBeNull();

    expect(verdict).toEqual({ type: "DONE" });
  });

  it("reviewer round counter increments per reviewer pass, not per impl attempt", () => {
    const { actions } = drive(defaultOpts, [
      impl(complete),
      gate1Ok,
      changes("round 1 notes"),
      impl(complete),
      gate1Red("trace"),
      impl(complete),
      gate1Ok,
      changes("round 2 notes"),
      impl(complete),
      gate1Ok,
      approved(),
    ]);
    const firstReviewer = actions[2] as Extract<
      LoopAction,
      { kind: "run-reviewer" }
    >;
    const secondReviewer = actions[7] as Extract<
      LoopAction,
      { kind: "run-reviewer" }
    >;
    const thirdReviewer = actions[10] as Extract<
      LoopAction,
      { kind: "run-reviewer" }
    >;
    expect(firstReviewer.reviewRound).toBe(1);
    expect(secondReviewer.reviewRound).toBe(2);
    expect(thirdReviewer.reviewRound).toBe(3);
  });

  it("reviewer prose persists across an intervening gate-1 red", () => {
    const { actions } = drive(defaultOpts, [
      impl(complete),
      gate1Ok,
      changes("prose-from-round-1"),
      impl(complete),
      gate1Red("trace X"),
      impl(complete),
      gate1Ok,
      approved(),
    ]);
    const implAfterGateRed = actions[5] as Extract<
      LoopAction,
      { kind: "run-implementer" }
    >;
    expect(implAfterGateRed.attempt).toBe(3);
    expect(implAfterGateRed.failureTrace).toBe("trace X");
    expect(implAfterGateRed.latestReviewerProse).toBe("prose-from-round-1");
  });

  it("latest reviewer prose replaces an older one on a subsequent CHANGES-REQUESTED", () => {
    const { actions } = drive(defaultOpts, [
      impl(complete),
      gate1Ok,
      changes("old prose"),
      impl(complete),
      gate1Ok,
      changes("new prose"),
      impl(complete),
      gate1Ok,
      approved(),
    ]);
    const finalImpl = actions[6] as Extract<
      LoopAction,
      { kind: "run-implementer" }
    >;
    expect(finalImpl.latestReviewerProse).toBe("new prose");
  });
});

describe("inner-loop-machine — review-round budget exhaustion", () => {
  it("3 CHANGES-REQUESTED rounds → NEEDS-HUMAN-REVIEW with latest prose", () => {
    const { verdict } = drive(defaultOpts, [
      impl(complete),
      gate1Ok,
      changes("r1"),
      impl(complete),
      gate1Ok,
      changes("r2"),
      impl(complete),
      gate1Ok,
      changes("r3"),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN-REVIEW",
      latestReviewerProse: "r3",
    });
  });

  it("maxReviewRounds=1 with one CHANGES-REQUESTED surfaces immediately", () => {
    const { verdict } = drive({ maxAttempts: 8, maxReviewRounds: 1 }, [
      impl(complete),
      gate1Ok,
      changes("only round"),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN-REVIEW",
      latestReviewerProse: "only round",
    });
  });
});

describe("inner-loop-machine — NO-SIGNAL re-prompting", () => {
  it("carries the parser's reprompt into the next attempt", () => {
    const { actions } = drive(defaultOpts, [
      impl(noSignal("Still working. Emit <promise>...")),
      impl(complete),
      gate1Ok,
      approved(),
    ]);
    const second = actions[1] as Extract<LoopAction, { kind: "run-implementer" }>;
    expect(second.attempt).toBe(2);
    expect(second.extraReprompt).toBe("Still working. Emit <promise>...");
  });

  it("clears the reprompt after one use", () => {
    const { actions } = drive(defaultOpts, [
      impl(noSignal("first reprompt")),
      impl(complete),
      gate1Red("trace"),
      impl(complete),
      gate1Ok,
      approved(),
    ]);
    const third = actions[3] as Extract<LoopAction, { kind: "run-implementer" }>;
    expect(third.attempt).toBe(3);
    expect(third.extraReprompt).toBeNull();
  });

  it("NO-SIGNAL without reprompt still advances the attempt", () => {
    const { actions } = drive(defaultOpts, [
      impl(noSignal()),
      impl(complete),
      gate1Ok,
      approved(),
    ]);
    const second = actions[1] as Extract<LoopAction, { kind: "run-implementer" }>;
    expect(second.attempt).toBe(2);
    expect(second.extraReprompt).toBeNull();
  });
});

describe("inner-loop-machine — impl-attempt budget exhaustion", () => {
  it("repeated gate-1 red over maxAttempts → NEEDS-HUMAN with last trace", () => {
    const { verdict } = drive({ maxAttempts: 3, maxReviewRounds: 3 }, [
      impl(complete),
      gate1Red("trace 1"),
      impl(complete),
      gate1Red("trace 2"),
      impl(complete),
      gate1Red("trace 3"),
    ]);
    expect(verdict).toEqual({ type: "NEEDS-HUMAN", failureTrace: "trace 3" });
  });

  it("repeated NO-SIGNAL over maxAttempts → NEEDS-HUMAN with sentinel (no trace recorded)", () => {
    const { verdict } = drive({ maxAttempts: 2, maxReviewRounds: 3 }, [
      impl(noSignal()),
      impl(noSignal()),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      failureTrace: NEEDS_HUMAN_BUDGET_EXHAUSTED_MESSAGE,
    });
  });

  it("NO-SIGNAL after a recorded gate-1 trace surfaces that trace, not the sentinel", () => {
    const { verdict } = drive({ maxAttempts: 3, maxReviewRounds: 3 }, [
      impl(complete),
      gate1Red("recorded trace"),
      impl(noSignal()),
      impl(noSignal()),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      failureTrace: "recorded trace",
    });
  });

  it("maxAttempts=1 with one gate-1 red still surfaces NEEDS-HUMAN", () => {
    const { verdict } = drive({ maxAttempts: 1, maxReviewRounds: 3 }, [
      impl(complete),
      gate1Red("trace"),
    ]);
    expect(verdict).toEqual({ type: "NEEDS-HUMAN", failureTrace: "trace" });
  });
});

describe("inner-loop-machine — interleaved budgets", () => {
  it("CHANGES-REQUESTED can exhaust impl budget if it advances past the cap", () => {
    // maxAttempts=2: attempt 1 COMPLETE+green+CHANGES-REQUESTED advances to
    // attempt 2; attempt 2 gate-1 red has nowhere to go → NEEDS-HUMAN.
    const { verdict } = drive({ maxAttempts: 2, maxReviewRounds: 3 }, [
      impl(complete),
      gate1Ok,
      changes("r1"),
      impl(complete),
      gate1Red("trace"),
    ]);
    expect(verdict).toEqual({ type: "NEEDS-HUMAN", failureTrace: "trace" });
  });
});

describe("inner-loop-machine — phase invariants", () => {
  it("stepping after terminate throws", () => {
    let state = initialState(defaultOpts);
    state = step(state, impl(needsInfo("q"))).state;
    expect(() => step(state, impl(complete))).toThrow(/after termination/);
  });

  it("gate-1-result before COMPLETE throws", () => {
    const state = initialState(defaultOpts);
    expect(() => step(state, gate1Ok)).toThrow(
      /gate-1-result.*expected needs-gate-1/,
    );
  });

  it("reviewer-result before reviewer phase throws", () => {
    const state = initialState(defaultOpts);
    expect(() => step(state, approved())).toThrow(
      /reviewer-result.*expected needs-reviewer/,
    );
  });

  it("implementer-result during gate-1 phase throws", () => {
    let state = initialState(defaultOpts);
    state = step(state, impl(complete)).state;
    expect(() => step(state, impl(complete))).toThrow(
      /implementer-result.*expected needs-implementer/,
    );
  });

  it("initialState rejects non-positive maxAttempts", () => {
    expect(() => initialState({ maxAttempts: 0, maxReviewRounds: 3 })).toThrow();
    expect(() => initialState({ maxAttempts: -1, maxReviewRounds: 3 })).toThrow();
    expect(() => initialState({ maxAttempts: 1.5, maxReviewRounds: 3 })).toThrow();
  });

  it("initialState rejects non-positive maxReviewRounds", () => {
    expect(() => initialState({ maxAttempts: 8, maxReviewRounds: 0 })).toThrow();
    expect(() => initialState({ maxAttempts: 8, maxReviewRounds: -1 })).toThrow();
    expect(() => initialState({ maxAttempts: 8, maxReviewRounds: 1.5 })).toThrow();
  });
});

describe("NEEDS_HUMAN_REVIEW_BUDGET_EXHAUSTED_MESSAGE", () => {
  it("is a non-empty string the finalizer can reference", () => {
    expect(typeof NEEDS_HUMAN_REVIEW_BUDGET_EXHAUSTED_MESSAGE).toBe("string");
    expect(NEEDS_HUMAN_REVIEW_BUDGET_EXHAUSTED_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe("decideAfterTerminal", () => {
  it("surfaces any non-HARD-ERROR verdict regardless of retries", () => {
    const verdicts: Verdict[] = [
      { type: "DONE" },
      { type: "NEEDS-INFO", questions: "q" },
      { type: "NEEDS-HUMAN", failureTrace: "trace" },
      { type: "NEEDS-HUMAN-REVIEW", latestReviewerProse: "prose" },
    ];
    for (const v of verdicts) {
      expect(decideAfterTerminal(v, 0)).toEqual({ kind: "surface" });
      expect(decideAfterTerminal(v, HARD_ERROR_MAX_RETRIES)).toEqual({
        kind: "surface",
      });
    }
  });

  it("retries on HARD-ERROR until the budget is hit", () => {
    const hardError: Verdict = { type: "HARD-ERROR", reason: "infra flake" };
    expect(decideAfterTerminal(hardError, 0)).toEqual({
      kind: "retry-with-fresh-sandbox",
      nextRetriesUsed: 1,
    });
    expect(decideAfterTerminal(hardError, 1)).toEqual({
      kind: "retry-with-fresh-sandbox",
      nextRetriesUsed: 2,
    });
    expect(decideAfterTerminal(hardError, HARD_ERROR_MAX_RETRIES)).toEqual({
      kind: "surface",
    });
  });

  it("respects an injected maxRetries", () => {
    const hardError: Verdict = { type: "HARD-ERROR", reason: "x" };
    expect(decideAfterTerminal(hardError, 0, 0)).toEqual({ kind: "surface" });
    expect(decideAfterTerminal(hardError, 0, 1)).toEqual({
      kind: "retry-with-fresh-sandbox",
      nextRetriesUsed: 1,
    });
  });
});
