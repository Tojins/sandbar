import { describe, expect, it } from "vitest";

import {
  HARD_ERROR_MAX_RETRIES,
  NEEDS_HUMAN_BUDGET_EXHAUSTED_MESSAGE,
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
  maxAttempts: number,
  script: readonly LoopEvent[],
): { readonly actions: readonly LoopAction[]; readonly verdict: Verdict } {
  let state: LoopState = initialState(maxAttempts);
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
const gate2Ok: LoopEvent = {
  kind: "gate-2-result",
  ok: true,
  reviewerCommitCount: 0,
  failureTrace: "",
  failedStep: null,
};
const gate2Red = (reviewerCommitCount: number, opts: { trace?: string; failedStep?: "check" | "test" | null } = {}): LoopEvent => ({
  kind: "gate-2-result",
  ok: false,
  reviewerCommitCount,
  failureTrace: opts.trace ?? "",
  failedStep: opts.failedStep ?? null,
});
const impl = (signal: ParseSignal): LoopEvent => ({
  kind: "implementer-result",
  signal,
});

describe("inner-loop-machine — happy paths", () => {
  it("attempt 1 COMPLETE → gate-1 green → gate-2 green → DONE", () => {
    const { actions, verdict } = drive(8, [impl(complete), gate1Ok, gate2Ok]);
    expect(actions.map((a) => a.kind)).toEqual([
      "run-implementer",
      "run-gate-1",
      "run-reviewer-and-gate-2",
      "terminate",
    ]);
    expect(verdict).toEqual({ type: "DONE" });
  });

  it("attempt 1 NEEDS-INFO short-circuits to NEEDS-INFO with the questions block", () => {
    const { actions, verdict } = drive(8, [impl(needsInfo("what's the foo?"))]);
    expect(actions.map((a) => a.kind)).toEqual(["run-implementer", "terminate"]);
    expect(verdict).toEqual({ type: "NEEDS-INFO", questions: "what's the foo?" });
  });
});

describe("inner-loop-machine — gate-1 red re-prompts", () => {
  it("first attempt gate-1 red, second attempt COMPLETE then green → DONE", () => {
    const { actions, verdict } = drive(8, [
      impl(complete),
      gate1Red("npm test failed at foo.test.ts:42"),
      impl(complete),
      gate1Ok,
      gate2Ok,
    ]);

    expect(actions.map((a) => a.kind)).toEqual([
      "run-implementer",
      "run-gate-1",
      "run-implementer",
      "run-gate-1",
      "run-reviewer-and-gate-2",
      "terminate",
    ]);

    const second = actions[2] as Extract<LoopAction, { kind: "run-implementer" }>;
    expect(second.attempt).toBe(2);
    expect(second.failureTrace).toBe("npm test failed at foo.test.ts:42");
    expect(second.extraReprompt).toBeNull();

    expect(verdict).toEqual({ type: "DONE" });
  });

  it("gate-1 red persists the trace into the next attempt's run-implementer", () => {
    const { actions } = drive(8, [
      impl(complete),
      gate1Red("trace A"),
      impl(complete),
      gate1Red("trace B"),
      impl(complete),
      gate1Ok,
      gate2Ok,
    ]);
    const thirdImpl = actions[4] as Extract<LoopAction, { kind: "run-implementer" }>;
    expect(thirdImpl.attempt).toBe(3);
    expect(thirdImpl.failureTrace).toBe("trace B");
  });
});

describe("inner-loop-machine — gate-2 decision", () => {
  it("gate-2 red with reviewer commits → REVERT-THEN-DONE", () => {
    const { verdict } = drive(8, [impl(complete), gate1Ok, gate2Red(2)]);
    expect(verdict).toEqual({ type: "REVERT-THEN-DONE" });
  });

  it("gate-2 red with no reviewer commits → HARD-ERROR with formatted reason", () => {
    const { verdict } = drive(8, [
      impl(complete),
      gate1Ok,
      gate2Red(0, { trace: "tsc: type error in src/x.ts", failedStep: "check" }),
    ]);
    expect(verdict.type).toBe("HARD-ERROR");
    if (verdict.type !== "HARD-ERROR") throw new Error("unreachable");
    expect(verdict.reason).toContain("gate-2 red with no reviewer commits");
    expect(verdict.reason).toContain("failed step: check");
    expect(verdict.reason).toContain("tsc: type error in src/x.ts");
  });

  it("HARD-ERROR reason names 'unknown' when failedStep is null", () => {
    const { verdict } = drive(8, [impl(complete), gate1Ok, gate2Red(0)]);
    if (verdict.type !== "HARD-ERROR") throw new Error("unreachable");
    expect(verdict.reason).toContain("failed step: unknown");
  });
});

describe("inner-loop-machine — NO-SIGNAL re-prompting", () => {
  it("carries the parser's reprompt into the next attempt", () => {
    const { actions } = drive(8, [
      impl(noSignal("Still working. Emit <promise>...")),
      impl(complete),
      gate1Ok,
      gate2Ok,
    ]);
    const second = actions[1] as Extract<LoopAction, { kind: "run-implementer" }>;
    expect(second.attempt).toBe(2);
    expect(second.extraReprompt).toBe("Still working. Emit <promise>...");
  });

  it("clears the reprompt after one use (next attempt has no reprompt unless re-emitted)", () => {
    const { actions } = drive(8, [
      impl(noSignal("first reprompt")),
      impl(complete),
      gate1Red("trace"),
      impl(complete),
      gate1Ok,
      gate2Ok,
    ]);
    const third = actions[3] as Extract<LoopAction, { kind: "run-implementer" }>;
    expect(third.attempt).toBe(3);
    expect(third.extraReprompt).toBeNull();
  });

  it("NO-SIGNAL without reprompt still advances the attempt", () => {
    const { actions } = drive(8, [impl(noSignal()), impl(complete), gate1Ok, gate2Ok]);
    const second = actions[1] as Extract<LoopAction, { kind: "run-implementer" }>;
    expect(second.attempt).toBe(2);
    expect(second.extraReprompt).toBeNull();
  });
});

describe("inner-loop-machine — budget exhaustion", () => {
  it("repeated gate-1 red over maxAttempts → NEEDS-HUMAN with last trace", () => {
    const { verdict } = drive(3, [
      impl(complete),
      gate1Red("trace 1"),
      impl(complete),
      gate1Red("trace 2"),
      impl(complete),
      gate1Red("trace 3"),
    ]);
    expect(verdict).toEqual({ type: "NEEDS-HUMAN", failureTrace: "trace 3" });
  });

  it("repeated NO-SIGNAL over maxAttempts → NEEDS-HUMAN with sentinel message (no failure trace recorded)", () => {
    const { verdict } = drive(2, [impl(noSignal()), impl(noSignal())]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      failureTrace: NEEDS_HUMAN_BUDGET_EXHAUSTED_MESSAGE,
    });
  });

  it("NO-SIGNAL after a recorded gate-1 trace surfaces that trace, not the sentinel", () => {
    const { verdict } = drive(3, [
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
    const { verdict } = drive(1, [impl(complete), gate1Red("trace")]);
    expect(verdict).toEqual({ type: "NEEDS-HUMAN", failureTrace: "trace" });
  });
});

describe("inner-loop-machine — phase invariants", () => {
  it("stepping after terminate throws", () => {
    let state = initialState(8);
    state = step(state, impl(needsInfo("q"))).state;
    expect(() => step(state, impl(complete))).toThrow(/after termination/);
  });

  it("gate-1-result before COMPLETE throws", () => {
    const state = initialState(8);
    expect(() => step(state, gate1Ok)).toThrow(
      /gate-1-result.*expected needs-gate-1/,
    );
  });

  it("gate-2-result before reviewer phase throws", () => {
    const state = initialState(8);
    expect(() => step(state, gate2Ok)).toThrow(
      /gate-2-result.*expected needs-reviewer-and-gate-2/,
    );
  });

  it("implementer-result during gate-1 phase throws", () => {
    let state = initialState(8);
    state = step(state, impl(complete)).state;
    expect(() => step(state, impl(complete))).toThrow(
      /implementer-result.*expected needs-implementer/,
    );
  });

  it("initialState rejects non-positive maxAttempts", () => {
    expect(() => initialState(0)).toThrow();
    expect(() => initialState(-1)).toThrow();
    expect(() => initialState(1.5)).toThrow();
  });
});

describe("decideAfterTerminal", () => {
  it("surfaces any non-HARD-ERROR verdict regardless of retries", () => {
    const verdicts: Verdict[] = [
      { type: "DONE" },
      { type: "REVERT-THEN-DONE" },
      { type: "NEEDS-INFO", questions: "q" },
      { type: "NEEDS-HUMAN", failureTrace: "trace" },
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
