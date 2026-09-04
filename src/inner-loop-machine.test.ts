import { describe, expect, it } from "vitest";

import {
  HARD_ERROR_MAX_RETRIES,
  type LoopAction,
  type LoopEvent,
  type LoopState,
  type Gate1Result,
  type ReviewerResult,
  type Verdict,
  decideAfterTerminal,
  initialAction,
  initialState,
  offBranchHeadReprompt,
  reviewerHarnessFailedReprompt,
  step,
} from "./inner-loop-machine.js";
import {
  DEFAULT_MAX_QUALITY_ROUNDS,
  DEFAULT_MAX_REVIEW_ROUNDS,
} from "./config.js";
import type { HeadMismatch } from "./git-ops.js";
import type { ParseSignal } from "./promise-parser.js";

// Tiny driver: runs the machine to completion given a script of events. Each
// event is paired with the action the runner just observed. Returns the
// verdict and the full action trace so each case can assert both.
function drive(
  opts: {
    maxQualityRounds: number;
    maxReviewRounds: number;
    uiPrototypeCheck: boolean;
  },
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
  reprompt: reprompt ?? "Still working. Emit <promise>...",
  missingTag: reprompt === undefined,
});
const needsInfo = (questions: string): ParseSignal => ({
  kind: "NEEDS-INFO",
  questions,
});
const needsUiPrototype = (uiImpact: string): ParseSignal => ({
  kind: "NEEDS-UI-PROTOTYPE",
  uiImpact,
});

const gate1Ok: Gate1Result = { ok: true, failureTrace: "" };
const gate1Red = (trace: string): Gate1Result => ({
  ok: false,
  failureTrace: trace,
});
const approved = (prose: string = "lgtm"): ReviewerResult => ({
  kind: "reviewer-result",
  verdict: "APPROVED",
  prose,
});
const changes = (prose: string): ReviewerResult => ({
  kind: "reviewer-result",
  verdict: "CHANGES-REQUESTED",
  rejectingPass: "correctness",
  prose,
});
const qualityChanges = (prose: string): ReviewerResult => ({
  kind: "reviewer-result",
  verdict: "CHANGES-REQUESTED",
  rejectingPass: "quality",
  prose,
});
// The reviewer was invoked its full budget and reviewed nothing (#41).
const harnessFailed = (
  detail = "invocation 1/2: …",
  pass: "quality" | "correctness" = "quality",
): ReviewerResult => ({
  kind: "reviewer-harness-failed",
  pass,
  detail,
});
const judged = (gate: Gate1Result, reviewer: ReviewerResult): LoopEvent => ({
  kind: "gate-and-reviewer-result",
  gate,
  reviewer,
});
// Clean tree and HEAD on the issue branch unless a case says otherwise — the
// dirty routing (#24 D1) and the off-branch routing (#27) each have their own
// describe block below.
const impl = (
  signal: ParseSignal,
  dirtyPaths: readonly string[] = [],
  offBranch: HeadMismatch | null = null,
): LoopEvent => ({
  kind: "implementer-result",
  signal,
  dirtyPaths,
  offBranch,
});

// A HEAD that is detached, i.e. the #27 shape that leaves a CLEAN tree.
const detached = (
  headSha = "dead1",
  branchSha = "base0",
): HeadMismatch => ({
  branch: "sandbar/issue-1-x",
  headRef: null,
  headSha,
  branchSha,
});

const defaultOpts = {
  maxQualityRounds: 4,
  maxReviewRounds: 3,
  uiPrototypeCheck: false,
} as const;

const asImpl = (a: LoopAction) =>
  a as Extract<LoopAction, { kind: "run-implementer" }>;
const asReviewer = (a: LoopAction) =>
  a as Extract<LoopAction, { kind: "run-gate-and-reviewer" }>;

describe("inner-loop-machine — one pre-attempt UI check (#126)", () => {
  it("runs before attempt 1 without spending an attempt, then proceeds on CLEAR", () => {
    let state = initialState({ ...defaultOpts, uiPrototypeCheck: true });
    expect(initialAction(state)).toEqual({ kind: "run-ui-check" });
    const result = step(state, {
      kind: "ui-check-result",
      result: { kind: "CLEAR" },
    });
    state = result.state;
    expect(result.action).toMatchObject({ kind: "run-implementer", attempt: 1 });
    expect(state.attempt).toBe(1);
    expect(state.qualityFailures).toBe(0);
    expect(state.correctnessFailures).toBe(0);
  });

  it("terminates before attempt 1 when a prototype is needed", () => {
    const state = initialState({ ...defaultOpts, uiPrototypeCheck: true });
    const result = step(state, {
      kind: "ui-check-result",
      result: { kind: "PROTOTYPE-NEEDED", uiImpact: "new navigation flow" },
    });
    expect(result.action).toEqual({
      kind: "terminate",
      verdict: {
        type: "NEEDS-UI-PROTOTYPE",
        uiImpact: "new navigation flow",
        strandedHead: null,
      },
    });
    expect(result.state.attempt).toBe(1);
    expect(result.state.qualityFailures).toBe(0);
    expect(result.state.correctnessFailures).toBe(0);
  });

  it("starts directly with the implementer when disabled", () => {
    const state = initialState({ ...defaultOpts, uiPrototypeCheck: false });
    expect(initialAction(state)).toMatchObject({
      kind: "run-implementer",
      attempt: 1,
    });
  });

  it("parks a checker that writes before trusting its classification", () => {
    const state = initialState({ ...defaultOpts, uiPrototypeCheck: true });
    const result = step(state, {
      kind: "ui-checker-wrote",
      detail: "UI checker changed git state",
    });
    expect(result.action).toEqual({
      kind: "terminate",
      verdict: {
        type: "NEEDS-HUMAN-REVIEW",
        cause: "ui-checker-wrote",
        latestReviewerProse: "UI checker changed git state",
      },
    });
  });
});

describe("inner-loop-machine — happy paths", () => {
  it("attempt 1 COMPLETE → gate-1 green → APPROVED → DONE", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Ok, approved()),
    ]);
    expect(actions.map((a) => a.kind)).toEqual([
      "run-implementer",
      "run-gate-and-reviewer",
      "terminate",
    ]);
    expect(verdict).toEqual({ type: "DONE" });
  });

  it("attempt 1 NEEDS-INFO short-circuits to NEEDS-INFO with questions block", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(needsInfo("what's the foo?")),
    ]);
    expect(actions.map((a) => a.kind)).toEqual(["run-implementer", "terminate"]);
    expect(verdict).toEqual({ type: "NEEDS-INFO", questions: "what's the foo?", strandedHead: null });
  });

  it("attempt 1 NEEDS-UI-PROTOTYPE short-circuits — no gate, no reviewer (#21)", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(needsUiPrototype("new settings screen, layout invented")),
    ]);
    expect(actions.map((a) => a.kind)).toEqual(["run-implementer", "terminate"]);
    expect(verdict).toEqual({
      type: "NEEDS-UI-PROTOTYPE",
      uiImpact: "new settings screen, layout invented",
      strandedHead: null,
    });
  });

  it("a late NEEDS-UI-PROTOTYPE terminates mid-loop without burning further attempts", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Red("trace A"), approved("discarded")),
      impl(needsUiPrototype("only now do I see the invented flow")),
    ]);
    expect(actions.map((a) => a.kind)).toEqual([
      "run-implementer",
      "run-gate-and-reviewer",
      "run-implementer",
      "terminate",
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-UI-PROTOTYPE",
      uiImpact: "only now do I see the invented flow",
      strandedHead: null,
    });
  });

  // The escalation must win over budget exhaustion: on the final attempt the
  // NO-SIGNAL path would emit gate-red NEEDS-HUMAN, which points the human at a
  // failing gate rather than the missing prototype.
  it("escalating on the LAST attempt terminates NEEDS-UI-PROTOTYPE, not budget-exhausted NEEDS-HUMAN", () => {
    const { verdict } = drive(
      { maxQualityRounds: 2, maxReviewRounds: 3 },
      [
        impl(complete),
        judged(gate1Red("trace A"), approved("discarded")),
        impl(needsUiPrototype("the remaining work is all invented UI")),
      ],
    );
    expect(verdict).toEqual({
      type: "NEEDS-UI-PROTOTYPE",
      uiImpact: "the remaining work is all invented UI",
      strandedHead: null,
    });
  });

  it("escalating after a CHANGES-REQUESTED round discards the stashed reviewer prose", () => {
    const { verdict } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Ok, changes("extract the helper")),
      impl(needsUiPrototype("the reviewer's ask means redesigning the screen")),
    ]);
    // The terminal carries only the UI assessment — the human is being asked
    // for a prototype, not for a verdict on the reviewer's request.
    expect(verdict).toEqual({
      type: "NEEDS-UI-PROTOTYPE",
      uiImpact: "the reviewer's ask means redesigning the screen",
      strandedHead: null,
    });
  });
});

describe("inner-loop-machine — gate-1 red re-prompts", () => {
  it("multiple gate-1 reds before green, then APPROVED → DONE", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Red("trace A"), approved("discarded")),
      impl(complete),
      judged(gate1Red("trace B"), approved("discarded")),
      impl(complete),
      judged(gate1Ok, approved()),
    ]);

    expect(actions.map((a) => a.kind)).toEqual([
      "run-implementer",
      "run-gate-and-reviewer",
      "run-implementer",
      "run-gate-and-reviewer",
      "run-implementer",
      "run-gate-and-reviewer",
      "terminate",
    ]);

    const third = actions[4] as Extract<LoopAction, { kind: "run-implementer" }>;
    expect(third.attempt).toBe(3);
    expect(third.failureTrace).toBe("trace B");
    expect(third.extraReprompt).toBeNull();
    expect(third.latestReviewerProse).toBeNull();

    expect(verdict).toEqual({ type: "DONE" });
  });

  it("discards reviewer prose and does not spend its round", () => {
    const { actions } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Ok, changes("earlier gated review")),
      impl(complete),
      judged(gate1Red("trace X"), changes("discard me")),
      impl(complete),
      judged(gate1Ok, approved()),
    ]);
    expect(asImpl(actions[4]!).latestReviewerProse).toBe("earlier gated review");
    expect(asReviewer(actions[5]!).reviewRound).toBe(3);
  });
});

describe("inner-loop-machine — reviewer CHANGES-REQUESTED loop", () => {
  it("one impl + CHANGES-REQUESTED → next impl carries latestReviewerProse + clears trace", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Ok, changes("- naming nit in foo.ts")),
      impl(complete),
      judged(gate1Ok, approved()),
    ]);

    const reviewerAction = actions[1] as Extract<
      LoopAction,
      { kind: "run-gate-and-reviewer" }
    >;
    expect(reviewerAction.reviewRound).toBe(1);

    const secondImpl = actions[2] as Extract<
      LoopAction,
      { kind: "run-implementer" }
    >;
    expect(secondImpl.attempt).toBe(2);
    expect(secondImpl.latestReviewerProse).toBe("- naming nit in foo.ts");
    expect(secondImpl.failureTrace).toBe("");
    expect(secondImpl.extraReprompt).toBeNull();

    expect(verdict).toEqual({ type: "DONE" });
  });

  it("reviewer round records retain the attempt number when intervening work is unreviewed", () => {
    const { actions } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Ok, changes("round 1 notes")),
      impl(complete),
      judged(gate1Red("trace"), approved("discarded")),
      impl(complete),
      judged(gate1Ok, changes("round 2 notes")),
      impl(complete),
      judged(gate1Ok, approved()),
    ]);
    const firstReviewer = actions[1] as Extract<
      LoopAction,
      { kind: "run-gate-and-reviewer" }
    >;
    const secondReviewer = actions[5] as Extract<
      LoopAction,
      { kind: "run-gate-and-reviewer" }
    >;
    const thirdReviewer = actions[7] as Extract<
      LoopAction,
      { kind: "run-gate-and-reviewer" }
    >;
    expect(firstReviewer.reviewRound).toBe(1);
    expect(secondReviewer.reviewRound).toBe(3);
    expect(thirdReviewer.reviewRound).toBe(4);
  });

  it("reviewer prose persists across an intervening gate-1 red", () => {
    const { actions } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Ok, changes("prose-from-round-1")),
      impl(complete),
      judged(gate1Red("trace X"), approved("discarded")),
      impl(complete),
      judged(gate1Ok, approved()),
    ]);
    const implAfterGateRed = actions[4] as Extract<
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
      judged(gate1Ok, changes("old prose")),
      impl(complete),
      judged(gate1Ok, changes("new prose")),
      impl(complete),
      judged(gate1Ok, approved()),
    ]);
    const finalImpl = actions[4] as Extract<
      LoopAction,
      { kind: "run-implementer" }
    >;
    expect(finalImpl.latestReviewerProse).toBe("new prose");
  });
});

describe("inner-loop-machine — reviewer harness failure (#41)", () => {
  it("parks immediately when a reviewer writes git state (#98)", () => {
    const { verdict } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Ok, { kind: "reviewer-wrote", detail: "before a; after b; M src/x.ts" }),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN-REVIEW",
      cause: "reviewer-wrote",
      latestReviewerProse: "before a; after b; M src/x.ts",
    });
  });

  it("reviewer-wrote still parks when the concurrent gate is red", () => {
    const { verdict } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Red("red"), { kind: "reviewer-wrote", detail: "changed HEAD" }),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN-REVIEW",
      cause: "reviewer-wrote",
      latestReviewerProse: "changed HEAD",
    });
  });
  it("spends neither failure budget", () => {
    let state = initialState(defaultOpts);
    state = step(state, impl(complete)).state;
    const result = step(state, judged(gate1Ok, harnessFailed()));
    expect(result.state.qualityFailures).toBe(0);
    expect(result.state.correctnessFailures).toBe(0);
    expect(result.action).toMatchObject({ kind: "run-implementer", attempt: 2 });
  });

  it("cannot exhaust the review budget — a maxReviewRounds of 1 survives it", () => {
    // The charge #41 objects to, at its sharpest: with one round to spend, a
    // reviewer that emitted nothing used to end the issue as
    // NEEDS-HUMAN-REVIEW quoting its own error message as the reviewer's
    // report. The real CHANGES-REQUESTED that follows is what spends the round.
    const { verdict } = drive(
      { maxQualityRounds: 8, maxReviewRounds: 1 },
      [
        impl(complete),
        judged(gate1Ok, harnessFailed()),
        impl(complete),
        judged(gate1Ok, changes("a real report")),
      ],
    );
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN-REVIEW",
      cause: "correctness-budget-exhausted",
      roundsUsed: 1,
      latestReviewerProse: "a real report",
    });
  });

  it("re-prompts as an ORCHESTRATOR note and quotes none of the harness detail", () => {
    const { actions } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Ok, harnessFailed("invocation 1/2: podman exec died\ninvocation 2/2: idle 600s")),
      impl(complete),
      judged(gate1Ok, approved()),
    ]);
    const next = asImpl(actions[2]!);
    expect(next.attempt).toBe(2);
    expect(next.extraReprompt).toBe(reviewerHarnessFailedReprompt());
    // The whole of #41: the harness's error text is not reviewer feedback, and
    // an implementer must not be handed one as the other.
    expect(next.latestReviewerProse).toBeNull();
    expect(next.extraReprompt).not.toContain("podman");
    expect(next.extraReprompt).not.toContain("idle 600s");
  });

  it("leaves an earlier round's real prose exactly as it was", () => {
    const { actions } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Ok, changes("round 1: rename the thing")),
      impl(complete),
      judged(gate1Ok, harnessFailed("the reviewer emitted nothing")),
      impl(complete),
      judged(gate1Ok, approved()),
    ]);
    const next = asImpl(actions[4]!);
    expect(next.latestReviewerProse).toBe("round 1: rename the thing");
    expect(next.latestReviewerProse).not.toContain("emitted nothing");

    // And the note rendered beside it must not contradict it. `prompt.ts`
    // renders that prose under "## Previous reviewer feedback
    // (CHANGES-REQUESTED)" with "Address the reviewer's concerns" beneath it,
    // so a note claiming there is no reviewer feedback above would be false in
    // exactly the case this issue is about — an implementer told something
    // untrue about what the reviewer said.
    expect(next.extraReprompt).toBe(reviewerHarnessFailedReprompt());
    expect(next.extraReprompt).not.toContain("there is none");
    expect(next.extraReprompt).toContain("Previous reviewer feedback");
    expect(next.extraReprompt).toContain("earlier round's");
  });

  it("carries no gate trace forward — gate-1 was green to reach the reviewer", () => {
    const { actions } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Red("an OLD red from attempt 1"), approved("discarded")),
      impl(complete),
      judged(gate1Ok, harnessFailed()),
      impl(complete),
      judged(gate1Ok, approved()),
    ]);
    expect(asImpl(actions[4]!).failureTrace).toBe("");
  });

  it("a SECOND consecutive harness failure terminates instead of grinding the budget", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Ok, harnessFailed("first")),
      impl(complete),
      judged(gate1Ok, harnessFailed("second")),
    ]);
    expect(actions[actions.length - 1]?.kind).toBe("terminate");
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      cause: "reviewer-harness-failed",
      failureTrace: "second",
      latestReviewerProse: null,
      qualityBudgetExhausted: null,
      strandedHead: null,
    });
  });

  it("a real verdict between two failures makes them non-consecutive", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Ok, harnessFailed("first")),
      impl(complete),
      judged(gate1Ok, changes("a real report")),
      impl(complete),
      judged(gate1Ok, harnessFailed("second")),
      impl(complete),
      judged(gate1Ok, approved()),
    ]);
    // Not terminated at the second failure: an attempt with a genuine review in
    // it separates them, so the reviewer is not wedged.
    expect(asImpl(actions[6]!).attempt).toBe(4);
    expect(verdict).toEqual({ type: "DONE" });
  });

  it("a gate red between two failures makes them non-consecutive too", () => {
    const { actions } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Ok, harnessFailed("first")),
      impl(complete),
      judged(gate1Red("red"), approved("discarded")),
      impl(complete),
      judged(gate1Ok, harnessFailed("second")),
      impl(complete),
      judged(gate1Ok, approved()),
    ]);
    expect(asImpl(actions[6]!).attempt).toBe(4);
  });

  it("a second harness failure keeps an earlier round's prose for the handoff", () => {
    const { verdict } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Ok, changes("round 1 prose")),
      impl(complete),
      judged(gate1Ok, harnessFailed("first")),
      impl(complete),
      judged(gate1Ok, harnessFailed("second")),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      cause: "reviewer-harness-failed",
      failureTrace: "second",
      latestReviewerProse: "round 1 prose",
      qualityBudgetExhausted: null,
      strandedHead: null,
    });
  });
});

describe("inner-loop-machine — review-round budget exhaustion", () => {
  it("3 CHANGES-REQUESTED rounds → NEEDS-HUMAN-REVIEW with latest prose", () => {
    const { verdict } = drive(defaultOpts, [
      impl(complete),
      judged(gate1Ok, changes("r1")),
      impl(complete),
      judged(gate1Ok, changes("r2")),
      impl(complete),
      judged(gate1Ok, changes("r3")),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN-REVIEW",
      cause: "correctness-budget-exhausted",
      roundsUsed: 3,
      latestReviewerProse: "r3",
    });
  });

  it("at the defaults reaches four correctness rejections before parking", () => {
    const script: LoopEvent[] = [];
    for (let round = 1; round <= DEFAULT_MAX_REVIEW_ROUNDS; round++) {
      script.push(impl(complete), judged(gate1Ok, changes(`r${round}`)));
    }
    const { actions, verdict } = drive(
      {
        maxQualityRounds: DEFAULT_MAX_QUALITY_ROUNDS,
        maxReviewRounds: DEFAULT_MAX_REVIEW_ROUNDS,
        uiPrototypeCheck: false,
      },
      script,
    );
    const rounds = actions
      .filter((a) => a.kind === "run-gate-and-reviewer")
      .map((a) => asReviewer(a).reviewRound);
    expect(rounds).toEqual(
      Array.from({ length: DEFAULT_MAX_REVIEW_ROUNDS }, (_, i) => i + 1),
    );
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN-REVIEW",
      cause: "correctness-budget-exhausted",
      roundsUsed: DEFAULT_MAX_REVIEW_ROUNDS,
      latestReviewerProse: `r${DEFAULT_MAX_REVIEW_ROUNDS}`,
    });
  });

  it("maxReviewRounds=1 with one CHANGES-REQUESTED surfaces immediately", () => {
    const { verdict } = drive({ ...defaultOpts, maxReviewRounds: 1 }, [
      impl(complete),
      judged(gate1Ok, changes("only round")),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN-REVIEW",
      cause: "correctness-budget-exhausted",
      roundsUsed: 1,
      latestReviewerProse: "only round",
    });
  });

  it("quality rejections exhaust only the quality budget", () => {
    const { verdict } = drive({ ...defaultOpts, maxQualityRounds: 2 }, [
      impl(complete),
      judged(gate1Ok, qualityChanges("q1")),
      impl(complete),
      judged(gate1Ok, qualityChanges("q2")),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN-REVIEW",
      cause: "quality-budget-exhausted",
      roundsUsed: 2,
      latestReviewerProse: "q2",
    });
  });
});

describe("inner-loop-machine — NO-SIGNAL re-prompting", () => {
  it("carries the parser's reprompt into the next attempt", () => {
    const { actions } = drive(defaultOpts, [
      impl(noSignal("Still working. Emit <promise>...")),
      impl(complete),
      judged(gate1Ok, approved()),
    ]);
    const second = actions[1] as Extract<LoopAction, { kind: "run-implementer" }>;
    expect(second.attempt).toBe(2);
    expect(second.extraReprompt).toBe("Still working. Emit <promise>...");
  });

  it("clears the reprompt after one use", () => {
    const { actions } = drive(defaultOpts, [
      impl(noSignal("first reprompt")),
      impl(complete),
      judged(gate1Red("trace"), approved("discarded")),
      impl(complete),
      judged(gate1Ok, approved()),
    ]);
    const third = actions[3] as Extract<LoopAction, { kind: "run-implementer" }>;
    expect(third.attempt).toBe(3);
    expect(third.extraReprompt).toBeNull();
  });

  it("carries the missing-tag correction into the next attempt", () => {
    const { actions } = drive(defaultOpts, [
      impl(noSignal()),
      impl(complete),
      judged(gate1Ok, approved()),
    ]);
    const second = actions[1] as Extract<LoopAction, { kind: "run-implementer" }>;
    expect(second.attempt).toBe(2);
    expect(second.extraReprompt).toBe("Still working. Emit <promise>...");
  });
});

describe("inner-loop-machine — quality budget exhaustion", () => {
  it("repeated gate-1 red exhausts quality with the last trace", () => {
    const { verdict } = drive({ ...defaultOpts, maxQualityRounds: 3 }, [
      impl(complete),
      judged(gate1Red("trace 1"), approved("discarded")),
      impl(complete),
      judged(gate1Red("trace 2"), approved("discarded")),
      impl(complete),
      judged(gate1Red("trace 3"), approved("discarded")),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      cause: "gate-red",
      failureTrace: "trace 3",
      latestReviewerProse: null,
      qualityBudgetExhausted: 3,
      strandedHead: null,
    });
  });

  it("repeated NO-SIGNAL exhausts with its own honest cause", () => {
    const { verdict } = drive({ ...defaultOpts, maxQualityRounds: 2 }, [
      impl(noSignal()),
      impl(noSignal()),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      cause: "no-signal-exhausted",
      failureTrace: "The final implementer attempt emitted no <promise> token.",
      latestReviewerProse: null,
      qualityBudgetExhausted: 2,
      strandedHead: null,
    });
  });

  it("NO-SIGNAL exhaustion preserves an older gate trace", () => {
    const { verdict } = drive({ ...defaultOpts, maxQualityRounds: 3 }, [
      impl(complete),
      judged(gate1Red("recorded trace"), approved("discarded")),
      impl(noSignal()),
      impl(noSignal()),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      cause: "no-signal-exhausted",
      failureTrace:
        "Last gate failure:\nrecorded trace\n\n" +
        "The final implementer attempt emitted no <promise> token.",
      latestReviewerProse: null,
      qualityBudgetExhausted: 3,
      strandedHead: null,
    });
  });

  it("NO-SIGNAL guard exhaustion carries the parser correction", () => {
    const correction =
      "You declared <promise>COMPLETE</promise> but made no commits this run.";
    const { verdict } = drive({ ...defaultOpts, maxQualityRounds: 1 }, [
      impl(noSignal(correction)),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      cause: "no-signal-exhausted",
      failureTrace: `The final implementer signal failed validation:\n${correction}`,
      latestReviewerProse: null,
      qualityBudgetExhausted: 1,
      strandedHead: null,
    });
  });

  it("maxQualityRounds=1 with one gate-1 red surfaces NEEDS-HUMAN", () => {
    const { verdict } = drive({ ...defaultOpts, maxQualityRounds: 1 }, [
      impl(complete),
      judged(gate1Red("trace"), approved("discarded")),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      cause: "gate-red",
      failureTrace: "trace",
      latestReviewerProse: null,
      qualityBudgetExhausted: 1,
      strandedHead: null,
    });
  });
});

describe("inner-loop-machine — interleaved budgets", () => {
  it("a correctness rejection resets the consecutive quality count", () => {
    const { verdict } = drive({ ...defaultOpts, maxQualityRounds: 2 }, [
      impl(complete),
      judged(gate1Red("quality failure 1"), approved("discarded")),
      impl(complete),
      judged(gate1Ok, changes("correctness 1")),
      impl(complete),
      judged(gate1Red("quality failure after reset"), approved("discarded")),
      impl(complete),
      judged(gate1Ok, approved()),
    ]);
    expect(verdict).toEqual({ type: "DONE" });
  });

  it("quality rejections do not spend the correctness budget", () => {
    const { verdict } = drive(
      { maxQualityRounds: 3, maxReviewRounds: 2, uiPrototypeCheck: false },
      [
        impl(complete),
        judged(gate1Ok, changes("correctness 1")),
        impl(complete),
        judged(gate1Ok, qualityChanges("quality 1")),
        impl(complete),
        judged(gate1Ok, qualityChanges("quality 2")),
        impl(complete),
        judged(gate1Ok, changes("correctness 2")),
      ],
    );
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN-REVIEW",
      cause: "correctness-budget-exhausted",
      roundsUsed: 2,
      latestReviewerProse: "correctness 2",
    });
  });

  it("correctness rejections do not spend the quality budget", () => {
    const { verdict } = drive({ ...defaultOpts, maxQualityRounds: 1 }, [
      impl(complete),
      judged(gate1Ok, changes("r1")),
      impl(complete),
      judged(gate1Ok, changes("r2")),
      impl(complete),
      judged(gate1Ok, changes("r3")),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN-REVIEW",
      cause: "correctness-budget-exhausted",
      roundsUsed: 3,
      latestReviewerProse: "r3",
    });
  });

  it("a correctness harness failure resets quality after its approval", () => {
    let state = initialState({ ...defaultOpts, maxQualityRounds: 2 });
    state = step(state, impl(complete)).state;
    state = step(state, judged(gate1Red("red"), approved("discarded"))).state;
    expect(state.qualityFailures).toBe(1);
    state = step(state, impl(complete)).state;
    const failed = step(
      state,
      judged(gate1Ok, harnessFailed("correctness failed", "correctness")),
    );
    expect(failed.state.qualityFailures).toBe(0);
    expect(failed.state.correctnessFailures).toBe(0);
  });
});

describe("inner-loop-machine — phase invariants", () => {
  it("stepping after terminate throws", () => {
    let state = initialState(defaultOpts);
    state = step(state, impl(needsInfo("q"))).state;
    expect(() => step(state, impl(complete))).toThrow(/after termination/);
  });

  it("combined gate/reviewer result before COMPLETE throws", () => {
    const state = initialState(defaultOpts);
    expect(() => step(state, judged(gate1Ok, approved()))).toThrow(
      /gate-and-reviewer-result.*expected needs-gate-and-reviewer/,
    );
  });

  it("implementer-result during gate-1 phase throws", () => {
    let state = initialState(defaultOpts);
    state = step(state, impl(complete)).state;
    expect(() => step(state, impl(complete))).toThrow(
      /implementer-result.*expected needs-implementer/,
    );
  });

  it("initialState rejects non-positive maxQualityRounds", () => {
    expect(() => initialState({ ...defaultOpts, maxQualityRounds: 0 })).toThrow();
    expect(() => initialState({ ...defaultOpts, maxQualityRounds: -1 })).toThrow();
    expect(() => initialState({ ...defaultOpts, maxQualityRounds: 1.5 })).toThrow();
  });

  it("initialState rejects non-positive maxReviewRounds", () => {
    expect(() => initialState({ ...defaultOpts, maxReviewRounds: 0 })).toThrow();
    expect(() => initialState({ ...defaultOpts, maxReviewRounds: -1 })).toThrow();
    expect(() => initialState({ ...defaultOpts, maxReviewRounds: 1.5 })).toThrow();
  });
});

describe("decideAfterTerminal", () => {
  it("surfaces any non-HARD-ERROR verdict regardless of retries", () => {
    const verdicts: Verdict[] = [
      { type: "DONE" },
      { type: "NEEDS-INFO", questions: "q", strandedHead: null },
      { type: "NEEDS-UI-PROTOTYPE", uiImpact: "invented screen", strandedHead: null },
      {
        type: "NEEDS-HUMAN",
        cause: "gate-red",
        failureTrace: "trace",
        latestReviewerProse: null,
        qualityBudgetExhausted: 4,
        strandedHead: null,
      },
      {
        type: "NEEDS-HUMAN-REVIEW",
        cause: "correctness-budget-exhausted",
        roundsUsed: 4,
        latestReviewerProse: "prose",
      },
      { type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42 },
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

// A verdict is about a COMMIT (#24 D1). The gate bind-mounts the worktree, so a
// COMPLETE claim over a dirty tree would produce a verdict the merger — which
// only ever sees commits — cannot reproduce.
describe("inner-loop-machine — COMPLETE over a dirty worktree (#24 D1)", () => {
  const dirty = ["?? src/new-file.ts", " M src/existing.ts"];

  it("routes back to the implementer instead of the gate", () => {
    const r = step(initialState(defaultOpts), impl(complete, dirty));
    expect(r.action.kind).toBe("run-implementer");
    // Not run-gate-1: the whole point is that no stack bringup is paid for a
    // claim that cannot be gated.
    expect(r.state.phase).toBe("needs-implementer");
    expect(r.state.attempt).toBe(2);
  });

  it("names the dirty paths in the re-prompt", () => {
    const r = step(initialState(defaultOpts), impl(complete, dirty));
    if (r.action.kind !== "run-implementer") throw new Error("expected re-prompt");
    expect(r.action.extraReprompt).toContain("?? src/new-file.ts");
    expect(r.action.extraReprompt).toContain(" M src/existing.ts");
    expect(r.action.extraReprompt).toContain("uncommitted");
  });

  it("elides a long dirty list rather than filling the prompt with it", () => {
    const many = Array.from({ length: 25 }, (_, i) => `?? f${i}.ts`);
    const r = step(initialState(defaultOpts), impl(complete, many));
    if (r.action.kind !== "run-implementer") throw new Error("expected re-prompt");
    expect(r.action.extraReprompt).toContain("?? f19.ts");
    expect(r.action.extraReprompt).not.toContain("?? f20.ts");
    expect(r.action.extraReprompt).toContain("… and 5 more");
  });

  it("tells the agent its gate artifacts must be gitignored", () => {
    // The consumer-side corollary of mounting the worktree: a step that writes
    // outside .gitignore reports its own exhaust as uncommitted work on every
    // attempt, and the loop dies of budget exhaustion with no other symptom.
    const r = step(initialState(defaultOpts), impl(complete, dirty));
    if (r.action.kind !== "run-implementer") throw new Error("expected re-prompt");
    expect(r.action.extraReprompt).toContain("gitignored");
  });

  it("gates normally once the tree is clean", () => {
    let state = initialState(defaultOpts);
    state = step(state, impl(complete, dirty)).state;
    const r = step(state, impl(complete));
    expect(r.action.kind).toBe("run-gate-and-reviewer");
  });

  it("spends an attempt, and exhausting the budget on dirt is NEEDS-HUMAN", () => {
    // Each attempt leaves a DIFFERENT dirty set, so the agent is visibly still
    // working and the loop lets it run to the end of the budget.
    const { actions, verdict } = drive({ ...defaultOpts, maxQualityRounds: 2 }, [
      impl(complete, ["?? a.ts"]),
      impl(complete, ["?? b.ts"]),
    ]);
    expect(actions.map((a) => a.kind)).toEqual([
      "run-implementer",
      "run-implementer",
      "terminate",
    ]);
    expect(verdict.type).toBe("NEEDS-HUMAN");
    if (verdict.type !== "NEEDS-HUMAN") throw new Error("unreachable");
    expect(verdict.cause).toBe("uncommittable-worktree");
    // Not the generic "budget exhausted with no green gate": no gate ran.
    expect(verdict.failureTrace).toContain("?? b.ts");
  });

  it("stops immediately when an attempt leaves the dirty set unchanged", () => {
    // The realistic causes — a gate step's non-gitignored exhaust, a file a
    // container wrote as another uid — are not the implementer's to remove, so
    // every remaining attempt would be a full agent run ending in the identical
    // reprompt. Terminates on attempt 2 of a budget of 8.
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete, dirty),
      impl(complete, dirty),
    ]);
    expect(actions.map((a) => a.kind)).toEqual([
      "run-implementer",
      "run-implementer",
      "terminate",
    ]);
    if (verdict.type !== "NEEDS-HUMAN") throw new Error("expected NEEDS-HUMAN");
    expect(verdict.cause).toBe("uncommittable-worktree");
  });

  it("treats a reordered dirty set as unchanged", () => {
    const { actions } = drive(defaultOpts, [
      impl(complete, ["?? a.ts", "?? b.ts"]),
      impl(complete, ["?? b.ts", "?? a.ts"]),
    ]);
    expect(actions.filter((a) => a.kind === "run-implementer")).toHaveLength(2);
    expect(actions[actions.length - 1]?.kind).toBe("terminate");
  });

  it("keeps going when the agent commits SOME of the dirt", () => {
    // Shrinking the set is progress, so the budget is not cut short.
    const r1 = step(initialState(defaultOpts), impl(complete, ["?? a.ts", "?? b.ts"]));
    const r2 = step(r1.state, impl(complete, ["?? b.ts"]));
    expect(r2.action.kind).toBe("run-implementer");
  });

  it("clears the dirty memory once the tree comes back clean", () => {
    // A later dirty attempt must not be compared against a stale set from
    // before a green run — that would terminate on a first offence.
    let state = initialState(defaultOpts);
    state = step(state, impl(complete, dirty)).state;
    state = step(state, impl(complete)).state; // clean → gate
    expect(state.lastDirtyPaths).toBeNull();
  });

  it("does not block the short-circuit terminals — dirt is irrelevant to them", () => {
    // NEEDS-INFO / NEEDS-UI-PROTOTYPE hand the issue to a human with a question,
    // not a verdict, so there is nothing for a clean tree to be a proof of.
    const info = drive(defaultOpts, [impl(needsInfo("which currency?"), dirty)]);
    expect(info.verdict.type).toBe("NEEDS-INFO");
  });
});

// #27. The failure this block pins is the one every OTHER check agrees with:
// commits on a detached HEAD leave the worktree CLEAN, so the D1 assert passes,
// gate-1 mounts a tree that has the work and goes green, the reviewer reads the
// commits and approves, and DONE closes an issue whose branch never moved.
describe("inner-loop-machine — HEAD off the issue branch (#27)", () => {
  const onBranchScratch: HeadMismatch = {
    branch: "sandbar/issue-1-x",
    headRef: "refs/heads/scratch",
    headSha: "aaa1",
    branchSha: "base0",
  };

  it("does NOT dispatch the gate for COMPLETE over a clean tree off the branch", () => {
    // The whole bug in one assertion: dirtyPaths is [], so nothing else in the
    // system would object.
    const r = step(initialState(defaultOpts), impl(complete, [], detached()));
    expect(r.action.kind).toBe("run-implementer");
    expect(r.state.attempt).toBe(2);
  });

  it("names where HEAD actually is, and where the branch still is", () => {
    const r = step(
      initialState(defaultOpts),
      impl(complete, [], detached("dead1", "base0")),
    );
    if (r.action.kind !== "run-implementer") throw new Error("expected re-prompt");
    expect(r.action.extraReprompt).toContain("DETACHED at dead1");
    expect(r.action.extraReprompt).toContain("sandbar/issue-1-x");
    expect(r.action.extraReprompt).toContain("base0");
  });

  it("names the scratch branch when HEAD is on one", () => {
    const r = step(initialState(defaultOpts), impl(complete, [], onBranchScratch));
    if (r.action.kind !== "run-implementer") throw new Error("expected re-prompt");
    expect(r.action.extraReprompt).toContain("refs/heads/scratch");
  });

  it("warns against a blind `git branch -f`", () => {
    // The correction is only safe when the branch is an ancestor of HEAD.
    // Telling the agent to force the ref unconditionally would swap a visible
    // failure for a silent one — commits already on the branch, dropped.
    const text = offBranchHeadReprompt(detached());
    expect(text).toContain("do NOT force the ref");
    expect(text).toContain("cherry-pick");
  });

  it("also fires on NO-SIGNAL, replacing the generic hint", () => {
    // An off-branch agent usually reads as "made no commits this run" (commit
    // capture reads refs/heads/<branch>), which sends it to fix the wrong thing.
    const r = step(
      initialState(defaultOpts),
      impl(
        { kind: "NO-SIGNAL", reprompt: "Still working.", missingTag: true },
        [],
        detached(),
      ),
    );
    if (r.action.kind !== "run-implementer") throw new Error("expected re-prompt");
    expect(r.action.extraReprompt).toContain("not on the issue branch");
    expect(r.action.extraReprompt).not.toContain("Still working.");
  });

  it("gates normally once HEAD is back on the branch", () => {
    let state = initialState(defaultOpts);
    state = step(state, impl(complete, [], detached())).state;
    const r = step(state, impl(complete));
    expect(r.action.kind).toBe("run-gate-and-reviewer");
  });

  it("terminates on a SECOND consecutive off-branch attempt, well inside the budget", () => {
    // One correction, not a whole budget: unlike a dirty set there is no partial
    // progress to wait for, and each further attempt buries the stranded commits
    // under more stranded commits. Deliberately unlike sameDirtySet, the sha is
    // not compared either — a NEW detached sha is not progress, just another
    // commit landing nowhere.
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete, [], detached("dead1")),
      impl(complete, [], detached("dead2")),
    ]);
    expect(actions.map((a) => a.kind)).toEqual([
      "run-implementer",
      "run-implementer",
      "terminate",
    ]);
    if (verdict.type !== "NEEDS-HUMAN") throw new Error("expected NEEDS-HUMAN");
    expect(verdict.cause).toBe("off-branch-head");
    // The sha is the only handle on the stranded commits once the worktree goes.
    expect(verdict.failureTrace).toContain("dead2");
  });

  it("counts CONSECUTIVE attempts, so a later relapse gets its own correction", () => {
    // Off-branch, back on (no signal), off-branch again: the third attempt is
    // the first of a new run, so it is re-prompted rather than terminated.
    let state = initialState(defaultOpts);
    state = step(state, impl(complete, [], detached())).state;
    state = step(state, impl(noSignal())).state;
    const relapse = step(state, impl(complete, [], detached()));
    expect(relapse.action.kind).toBe("run-implementer");
    // And the one after THAT does terminate.
    const r = step(relapse.state, impl(complete, [], detached()));
    expect(r.action.kind).toBe("terminate");
  });

  it("exhausting the budget off-branch is off-branch-head, not gate-red", () => {
    // No gate ever ran, so the generic "budget exhausted with no green gate"
    // would describe a failure that did not happen.
    const { verdict } = drive({ ...defaultOpts, maxQualityRounds: 1 }, [
      impl(complete, [], detached()),
    ]);
    if (verdict.type !== "NEEDS-HUMAN") throw new Error("expected NEEDS-HUMAN");
    expect(verdict.cause).toBe("off-branch-head");
    expect(verdict.failureTrace).toContain("HEAD");
  });

  it("is checked BEFORE the dirty tree — the branch is the deeper problem", () => {
    // Committing first would only put the commit further off the branch.
    const r = step(
      initialState(defaultOpts),
      impl(complete, ["?? src/new.ts"], detached()),
    );
    if (r.action.kind !== "run-implementer") throw new Error("expected re-prompt");
    expect(r.action.extraReprompt).toContain("not on the issue branch");
  });

  it("does not block the two hand-to-human terminals", () => {
    // Re-prompting would risk spending the budget on a question the agent had
    // already formed, and would swap a precise handoff (the question, the UI
    // assessment) for a generic one.
    const info = drive(defaultOpts, [
      impl(needsInfo("which currency?"), [], detached()),
    ]);
    expect(info.verdict.type).toBe("NEEDS-INFO");
    const ui = drive(defaultOpts, [
      impl({ kind: "NEEDS-UI-PROTOTYPE", uiImpact: "a modal" }, [], detached()),
    ]);
    expect(ui.verdict.type).toBe("NEEDS-UI-PROTOTYPE");
  });

  // Exempt must not mean silent. The commits are counted on the BRANCH, so an
  // off-branch escalation reports zero, and finalize then deletes the branch and
  // posts a comment about the UI question only — the sha would exist nowhere and
  // the work would go at the next gc. That is the loss #27 exists to prevent,
  // arriving through the terminal the check chose not to guard.
  it("carries the mismatch into both exempted terminals so the sha survives", () => {
    const m = detached("stranded1");
    const info = drive(defaultOpts, [impl(needsInfo("which currency?"), [], m)]);
    if (info.verdict.type !== "NEEDS-INFO") throw new Error("expected NEEDS-INFO");
    expect(info.verdict.strandedHead?.headSha).toBe("stranded1");

    const ui = drive(defaultOpts, [
      impl({ kind: "NEEDS-UI-PROTOTYPE", uiImpact: "a modal" }, [], m),
    ]);
    if (ui.verdict.type !== "NEEDS-UI-PROTOTYPE") throw new Error("expected UI");
    expect(ui.verdict.strandedHead?.headSha).toBe("stranded1");
  });

  it("leaves strandedHead null on the ordinary on-branch escalations", () => {
    const info = drive(defaultOpts, [impl(needsInfo("which currency?"))]);
    if (info.verdict.type !== "NEEDS-INFO") throw new Error("expected NEEDS-INFO");
    expect(info.verdict.strandedHead).toBeNull();
  });

  it("carries the mismatch on the off-branch-head terminal too", () => {
    const { verdict } = drive(defaultOpts, [
      impl(complete, [], detached("dead1")),
      impl(complete, [], detached("dead2")),
    ]);
    if (verdict.type !== "NEEDS-HUMAN") throw new Error("expected NEEDS-HUMAN");
    expect(verdict.strandedHead?.headSha).toBe("dead2");
  });

  it("leaves strandedHead null on the other NEEDS-HUMAN causes", () => {
    const { verdict } = drive({ ...defaultOpts, maxQualityRounds: 1 }, [
      impl(complete),
      judged(gate1Red("boom"), approved("discarded")),
    ]);
    if (verdict.type !== "NEEDS-HUMAN") throw new Error("expected NEEDS-HUMAN");
    expect(verdict.cause).toBe("gate-red");
    expect(verdict.strandedHead).toBeNull();
  });
});
