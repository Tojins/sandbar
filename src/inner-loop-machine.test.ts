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
  visiblePhases,
} from "./inner-loop-machine.js";
import { DEFAULT_MAX_GATE_ROUNDS } from "./config.js";
import type { HeadMismatch } from "./git-ops.js";
import type { ParseSignal } from "./promise-parser.js";

const defaultOpts = {
  issueBranch: "sandbar/issue-1-x",
  maxQualityRounds: 3,
  maxGateRounds: 4,
  maxReviewRounds: 3,
  uiPrototypeCheck: false,
  partitionCheck: false,
} as const;

// Tiny driver: runs the machine to completion given a script of events.
// Returns the verdict and the full action trace so each case can assert both.
function drive(
  opts: Partial<typeof defaultOpts> & {
    readonly maxQualityRounds?: number;
    readonly maxGateRounds?: number;
    readonly maxReviewRounds?: number;
  },
  script: readonly LoopEvent[],
): { readonly actions: readonly LoopAction[]; readonly verdict: Verdict } {
  let state: LoopState = initialState({ ...defaultOpts, ...opts });
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
    `script exhausted without termination; last action: ${actions.at(-1)?.kind}`,
  );
}

// Applies several events in order, for cases that assert an intermediate state.
function stepAll(state: LoopState, events: readonly LoopEvent[]): {
  readonly state: LoopState;
  readonly action: LoopAction;
} {
  let result: { state: LoopState; action: LoopAction } = {
    state,
    action: initialAction(state),
  };
  for (const event of events) result = step(result.state, event);
  return result;
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

const gate1Ok: Gate1Result = { ok: true, failureTrace: "", failedStep: null };
const gate1Red = (trace: string, failedStep = "test"): Gate1Result => ({
  ok: false,
  failureTrace: trace,
  failedStep,
});
const approved = (prose = "lgtm"): ReviewerResult => ({
  kind: "reviewer-result",
  verdict: "APPROVED",
  prose,
});
const changes = (prose: string): ReviewerResult => ({
  kind: "reviewer-result",
  verdict: "CHANGES-REQUESTED",
  prose,
});
// The reviewer was invoked its full budget and reviewed nothing (#41).
const harnessFailed = (detail = "invocation 1/2: …"): ReviewerResult => ({
  kind: "reviewer-harness-failed",
  detail,
});

// Clean tree and HEAD on the issue branch unless a case says otherwise — the
// dirty routing (#24 D1) and the off-branch routing (#27) each have their own
// describe block below.
const impl = (
  signal: ParseSignal,
  dirtyPaths: readonly string[] = [],
  offBranch: HeadMismatch | null = null,
  fastForwarded: { readonly fromSha: string; readonly toSha: string } | null = null,
  commits = 1,
  head = "head",
): LoopEvent => ({
  kind: "implementer-result",
  signal,
  dirtyPaths,
  offBranch,
  fastForwarded,
  commits,
  head,
});

// The quality pass's three roles (#187).
const listed = (review: ReviewerResult, head = "head"): LoopEvent => ({
  kind: "quality-review-result",
  mode: "list",
  head,
  review,
});
const verified = (review: ReviewerResult, head = "fixed"): LoopEvent => ({
  kind: "quality-review-result",
  mode: "verify",
  head,
  review,
});
const fixed = (
  commits = 1,
  { startHead = "head", head = commits === 0 ? startHead : "fixed", exited = "completed" }: {
    readonly startHead?: string;
    readonly head?: string;
    readonly exited?: "completed" | "failed";
  } = {},
): LoopEvent => ({ kind: "quality-fix-result", startHead, head, commits, exited });
// A quality pass whose lister approves outright.
const quality: LoopEvent = listed(approved());
const qualityApproved = { verdict: "APPROVED", rounds: 0 } as const;
const gated = (gate: Gate1Result, head = "head"): LoopEvent => ({
  kind: "gate-result",
  gate,
  head,
});
const reviewed = (reviewer: ReviewerResult, head = "head"): LoopEvent => ({
  kind: "correctness-result",
  head,
  reviewer,
});

// One serial round after a COMPLETE (#185): the fixer, gate-1 on the head it
// left, and the correctness pass only when that gate is green.
const round = (
  gate: Gate1Result,
  reviewer: ReviewerResult | null = null,
  head = "head",
): readonly LoopEvent[] => [
  listed(approved(), head),
  gated(gate, head),
  ...(reviewer === null ? [] : [reviewed(reviewer, head)]),
];

// A HEAD that is detached, i.e. the #27 shape that leaves a CLEAN tree.
const detached = (headSha = "dead1", branchSha = "base0"): HeadMismatch => ({
  branch: "sandbar/issue-1-x",
  headRef: null,
  headSha,
  branchSha,
  branchIsAncestor: false,
});

const asImpl = (a: LoopAction) => {
  if (a.kind !== "run-implementer") throw new Error(`expected run-implementer, got ${a.kind}`);
  return a;
};

describe("inner-loop-machine — the serial round (#185)", () => {
  it("runs the quality pass, then gate-1, then correctness, then DONE", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete),
      ...round(gate1Ok, approved()),
    ]);
    expect(actions.map((a) => a.kind)).toEqual([
      "run-implementer",
      "run-quality-list",
      "run-gate",
      "run-correctness",
      "terminate",
    ]);
    expect(verdict).toEqual({ type: "DONE" });
  });

  it("numbers each step of the round by the attempt that opened it", () => {
    const { actions } = drive(defaultOpts, [
      impl(complete),
      ...round(gate1Red("red")),
      impl(complete),
      ...round(gate1Ok, approved()),
    ]);
    expect(actions.filter((a) => a.kind !== "terminate")).toEqual([
      { kind: "run-implementer", attempt: 1, failureTrace: "", extraReprompt: null, latestReviewerFeedback: null },
      { kind: "run-quality-list", attempt: 1, scope: { kind: "full" } },
      { kind: "run-gate", attempt: 1, quality: qualityApproved },
      { kind: "run-implementer", attempt: 2, failureTrace: "red", extraReprompt: null, latestReviewerFeedback: null },
      { kind: "run-quality-list", attempt: 2, scope: { kind: "since", sha: "head" } },
      { kind: "run-gate", attempt: 2, quality: qualityApproved },
      { kind: "run-correctness", attempt: 2 },
    ]);
  });

  // Correctness reads a green head and nothing else; a red gate returns to
  // the implementer with no review spent on it.
  it("never dispatches correctness on a red gate", () => {
    const red = stepAll(initialState(defaultOpts), [impl(complete), quality, gated(gate1Red("FAIL x"))]);
    expect(red.action).toMatchObject({ kind: "run-implementer", attempt: 2, failureTrace: "FAIL x" });
    expect(red.state.correctnessFailures).toBe(0);
  });

  it("exposes one UI phase per serial step", () => {
    expect(visiblePhases({ kind: "run-quality-list", attempt: 1, scope: { kind: "full" } }))
      .toEqual(["quality"]);
    expect(visiblePhases({ kind: "run-quality-fix", attempt: 1, fixRound: 1, report: "r", ruling: null }))
      .toEqual(["quality"]);
    expect(visiblePhases({ kind: "run-quality-verify", attempt: 1, fixRound: 1, anchor: "a", report: "r" }))
      .toEqual(["quality"]);
    expect(visiblePhases({ kind: "run-gate", attempt: 1, quality: qualityApproved })).toEqual(["gate-1"]);
    expect(visiblePhases({ kind: "run-correctness", attempt: 1 })).toEqual(["review"]);
  });

  it.each([
    ["the quality lister", [impl(complete)]],
    ["the quality fixer", [impl(complete), listed(changes("### Tests\nx"))]],
    ["the quality verify", [impl(complete), listed(changes("### Tests\nx")), fixed()]],
    ["the correctness pass", [impl(complete), quality, gated(gate1Ok)]],
  ] as const)("parks a context overage measured before %s", (_name, events) => {
    const state = stepAll(initialState(defaultOpts), events).state;
    const measured = step(state, {
      kind: "context-over-budget",
      slot: "review-correctness",
      size: 700_000,
      budget: 600_000,
      detail: "completed branch is too large",
    });
    expect(measured.action).toMatchObject({
      kind: "terminate",
      verdict: { type: "NEEDS-PARTITION", cause: "measured", slot: "review-correctness" },
    });
  });

  it("refuses a context overage reported by gate-1, which measures nothing", () => {
    const state = stepAll(initialState(defaultOpts), [impl(complete), quality]).state;
    expect(() =>
      step(state, {
        kind: "context-over-budget",
        slot: "review-quality",
        size: 1,
        budget: 0,
        detail: "x",
      }),
    ).toThrow(/context-over-budget event in phase needs-gate/);
  });
});

describe("inner-loop-machine — the quality pass (#187)", () => {
  const report = "### Tests\nsrc/a.ts:3 is uncovered";
  // A COMPLETE whose lister rejects: the pass is in front of the fixer.
  const listedRejection = () =>
    stepAll(initialState(defaultOpts), [impl(complete), listed(changes(report))]);
  const asGate = (a: LoopAction) => {
    if (a.kind !== "run-gate") throw new Error(`expected run-gate, got ${a.kind}`);
    return a;
  };

  it("hands a rejecting lister's report to the fixer", () => {
    expect(listedRejection().action).toEqual({
      kind: "run-quality-fix",
      attempt: 1,
      fixRound: 1,
      report,
      ruling: null,
    });
  });

  it("verifies a fixer's commits from the head before it, against the same report", () => {
    const r = step(listedRejection().state, fixed(1, { startHead: "head", head: "fixed" }));
    expect(r.action).toEqual({
      kind: "run-quality-verify",
      attempt: 1,
      fixRound: 1,
      anchor: "head",
      report,
    });
  });

  it("gates once on an approving verify and anchors the next lister at its head", () => {
    const { actions } = drive(defaultOpts, [
      impl(complete),
      listed(changes(report)),
      fixed(),
      verified(approved(), "fixed"),
      gated(gate1Red("red"), "fixed"),
      impl(complete, [], null, null, 1, "next"),
      listed(approved(), "next"),
      gated(gate1Ok, "next"),
      reviewed(approved(), "next"),
    ]);
    expect(actions.filter((a) => a.kind === "run-gate")).toEqual([
      { kind: "run-gate", attempt: 1, quality: { verdict: "APPROVED", rounds: 0 } },
      { kind: "run-gate", attempt: 2, quality: { verdict: "APPROVED", rounds: 0 } },
    ]);
    expect(actions.filter((a) => a.kind === "run-quality-list")).toEqual([
      { kind: "run-quality-list", attempt: 1, scope: { kind: "full" } },
      { kind: "run-quality-list", attempt: 2, scope: { kind: "since", sha: "fixed" } },
    ]);
  });

  it("sends a verify rejection's restated report to the next fixer and charges the pass", () => {
    const r = stepAll(listedRejection().state, [fixed(), verified(changes("still open"))]);
    expect(r.action).toEqual({
      kind: "run-quality-fix",
      attempt: 1,
      fixRound: 2,
      report: "still open",
      ruling: null,
    });
    expect(r.state.qualityFailures).toBe(1);
  });

  it("goes on to gate-1 with the items open when maxQualityRounds runs out", () => {
    const { actions, verdict } = drive({ maxQualityRounds: 2 }, [
      impl(complete),
      listed(changes(report)),
      fixed(),
      verified(changes("open 1")),
      fixed(1, { startHead: "fixed", head: "fixed2" }),
      verified(changes("open 2"), "fixed2"),
      gated(gate1Ok, "fixed2"),
      reviewed(approved(), "fixed2"),
    ]);
    expect(actions.find((a) => a.kind === "run-gate")).toEqual({
      kind: "run-gate",
      attempt: 1,
      quality: { verdict: "CHANGES-REQUESTED", rounds: 2 },
    });
    expect(verdict).toEqual({ type: "DONE" });
  });

  it("never hands a quality report to the implementer", () => {
    const r = stepAll(initialState({ ...defaultOpts, maxQualityRounds: 1 }), [
      impl(complete),
      listed(changes(report)),
      fixed(),
      verified(changes("still open")),
      gated(gate1Red("red"), "fixed"),
    ]);
    expect(asImpl(r.action)).toMatchObject({ latestReviewerFeedback: null, extraReprompt: null });
  });

  it("opens every pass with a fresh budget and lists the whole branch until one approves", () => {
    const exhausted = stepAll(initialState({ ...defaultOpts, maxQualityRounds: 1 }), [
      impl(complete),
      listed(changes(report)),
      fixed(),
      verified(changes("still open")),
      gated(gate1Red("red"), "fixed"),
    ]);
    const relisted = step(exhausted.state, impl(complete, [], null, null, 1, "next"));
    expect(relisted.action).toEqual({ kind: "run-quality-list", attempt: 2, scope: { kind: "full" } });
    expect(relisted.state.qualityFailures).toBe(0);
    expect(relisted.state.qualityReport).toBeNull();
  });

  it.each([
    ["lister", [] as readonly LoopEvent[], listed(harnessFailed()), 0],
    ["verify", [listed(changes(report)), fixed()], verified(harnessFailed()), 0],
  ] as const)("goes on to gate-1 when the %s produced no review", (_role, before, failed, rounds) => {
    const r = stepAll(initialState(defaultOpts), [impl(complete), ...before, failed]);
    expect(asGate(r.action).quality).toEqual({ verdict: "REVIEW-FAILED", rounds });
    // Not a correctness harness failure: the #41 bound is untouched.
    expect(r.state.reviewerHarnessFailures).toBe(0);
  });

  it.each([
    ["lister", [] as readonly LoopEvent[], listed({ kind: "reviewer-wrote", detail: "it wrote" })],
    ["verify", [listed(changes(report)), fixed()], verified({ kind: "reviewer-wrote", detail: "it wrote" })],
  ] as const)("parks a %s that writes", (_role, before, wrote) => {
    const r = stepAll(initialState(defaultOpts), [impl(complete), ...before, wrote]);
    expect(r.action).toEqual({
      kind: "terminate",
      verdict: {
        type: "NEEDS-HUMAN-REVIEW",
        cause: "quality-reviewer-wrote",
        latestReviewerProse: "it wrote",
      },
    });
  });

  it("goes on to gate-1 when the fixer crashed on its retry too, whatever it committed", () => {
    const r = step(listedRejection().state, fixed(1, { exited: "failed" }));
    expect(asGate(r.action).quality).toEqual({ verdict: "FIX-FAILED", rounds: 0 });
  });

  it("sends a fixer that commits nothing to the adjudicator with the latest report", () => {
    const r = step(listedRejection().state, fixed(0));
    expect(r.action).toEqual({
      kind: "run-adjudicator",
      attempt: 1,
      pass: "quality",
      fixRound: 1,
      rejection: { round: 1, head: "head", report },
    });
  });

  it("approves the head for the quality pass when the adjudicator overrules", () => {
    const { actions } = drive(defaultOpts, [
      impl(complete),
      listed(changes(report)),
      fixed(0),
      { kind: "adjudicator-result", head: "head", ruling: "OVERRULED", reasoning: "covered" },
      gated(gate1Red("red")),
      impl(complete, [], null, null, 1, "next"),
      listed(approved(), "next"),
      gated(gate1Ok, "next"),
      reviewed(approved(), "next"),
    ]);
    expect(actions.filter((a) => a.kind === "run-gate").map((a) => asGate(a).quality)).toEqual([
      { verdict: "OVERRULED", rounds: 0 },
      { verdict: "APPROVED", rounds: 0 },
    ]);
    expect(actions.filter((a) => a.kind === "run-quality-list").at(-1)).toEqual({
      kind: "run-quality-list",
      attempt: 2,
      scope: { kind: "since", sha: "head" },
    });
  });

  it("runs the fixer once more with an upheld ruling, charged to the pass", () => {
    const upheld = stepAll(listedRejection().state, [
      fixed(0),
      { kind: "adjudicator-result", head: "head", ruling: "UPHELD", reasoning: " line 3 is uncovered " },
    ]);
    expect(upheld.action).toEqual({
      kind: "run-quality-fix",
      attempt: 1,
      fixRound: 2,
      report,
      ruling: "line 3 is uncovered",
    });
    expect(upheld.state.qualityFailures).toBe(1);
    // The ruling was for that fixer alone.
    const afterFix = step(upheld.state, fixed());
    expect(afterFix.state.qualityRuling).toBeNull();
    expect(afterFix.action.kind).toBe("run-quality-verify");
  });

  it("takes the budget-exhausted path when the fixer refuses again after an upheld ruling", () => {
    const r = stepAll(listedRejection().state, [
      fixed(0),
      { kind: "adjudicator-result", head: "head", ruling: "UPHELD", reasoning: "true" },
      fixed(0),
    ]);
    expect(asGate(r.action).quality).toEqual({ verdict: "CHANGES-REQUESTED", rounds: 1 });
  });

  it("adjudicates a later refusal at a new head", () => {
    const r = stepAll(listedRejection().state, [
      fixed(0),
      { kind: "adjudicator-result", head: "head", ruling: "UPHELD", reasoning: "true" },
      fixed(1, { startHead: "head", head: "fixed" }),
      verified(changes("still open")),
      fixed(0, { startHead: "fixed" }),
    ]);
    expect(r.action).toMatchObject({
      kind: "run-adjudicator",
      pass: "quality",
      fixRound: 3,
      rejection: { head: "fixed", report: "still open" },
    });
  });

  it("does not run the fixer again when an upheld ruling spends the last round", () => {
    const r = stepAll(initialState({ ...defaultOpts, maxQualityRounds: 1 }), [
      impl(complete),
      listed(changes(report)),
      fixed(0),
      { kind: "adjudicator-result", head: "head", ruling: "UPHELD", reasoning: "true" },
    ]);
    expect(asGate(r.action).quality).toEqual({ verdict: "CHANGES-REQUESTED", rounds: 1 });
  });

  it("goes on to gate-1 when the quality adjudicator produced nothing", () => {
    const r = stepAll(listedRejection().state, [
      fixed(0),
      { kind: "adjudicator-harness-failed", detail: "no ruling" },
    ]);
    expect(asGate(r.action).quality).toEqual({ verdict: "REVIEW-FAILED", rounds: 0 });
    expect(r.state.reviewerHarnessFailures).toBe(0);
  });

  it("parks a quality adjudicator that writes", () => {
    const r = stepAll(listedRejection().state, [
      fixed(0),
      { kind: "adjudicator-wrote", detail: "it committed" },
    ]);
    expect(r.action).toMatchObject({
      kind: "terminate",
      verdict: { type: "NEEDS-HUMAN-REVIEW", cause: "adjudicator-wrote" },
    });
  });

  it("refuses a quality ruling about another head", () => {
    const disputed = step(listedRejection().state, fixed(0));
    expect(() =>
      step(disputed.state, {
        kind: "adjudicator-result",
        head: "zzz",
        ruling: "OVERRULED",
        reasoning: "",
      }),
    ).toThrow(/other than the pending head/);
  });

  it("refuses a verify result while the fixer is pending", () => {
    expect(() => step(listedRejection().state, verified(approved()))).toThrow(
      /quality-review-result event in phase needs-quality-fix; expected needs-quality-verify/,
    );
  });
});

describe("inner-loop-machine — unchanged rejection adjudication (#167)", () => {
  const reachRejection = (head = "abc") =>
    stepAll(initialState(defaultOpts), [
      impl(complete, [], null, null, 1, head),
      ...round(gate1Ok, changes("finding"), head),
    ]);

  it("routes a zero-commit COMPLETE at the rejected head to the adjudicator", () => {
    const disputed = step(reachRejection().state, impl(complete, [], null, null, 0, "abc"));
    expect(disputed.action).toEqual({
      kind: "run-adjudicator",
      attempt: 2,
      pass: "correctness",
      rejection: { round: 1, head: "abc", report: "finding" },
    });
  });

  it("does not adjudicate after the implementer changes the head", () => {
    const changed = step(reachRejection().state, impl(complete, [], null, null, 1, "def"));
    expect(changed.action).toEqual({
      kind: "run-quality-list",
      attempt: 2,
      scope: { kind: "since", sha: "abc" },
    });
  });

  it("makes an overruled correctness rejection final approval", () => {
    const disputed = step(reachRejection().state, impl(complete, [], null, null, 0, "abc"));
    const ruled = step(disputed.state, {
      kind: "adjudicator-result",
      head: "abc",
      ruling: "OVERRULED",
      reasoning: "the cited branch is handled",
    });
    expect(ruled.action).toEqual({ kind: "terminate", verdict: { type: "DONE" } });
  });

  it("offers one adjudication per head after an upheld ruling", () => {
    const disputed = step(reachRejection().state, impl(complete, [], null, null, 0, "abc"));
    const upheld = step(disputed.state, {
      kind: "adjudicator-result",
      head: "abc",
      ruling: "UPHELD",
      reasoning: "the null branch still crashes",
    });
    const feedback = asImpl(upheld.action).latestReviewerFeedback;
    expect(feedback).toBe("Independent adjudicator: UPHELD\nthe null branch still crashes\n\nfinding");
    expect(upheld.state.correctnessFailures).toBe(1);
    // The same zero-commit move at the same head now takes the ordinary round.
    const again = step(upheld.state, impl(complete, [], null, null, 0, "abc"));
    expect(again.action).toEqual({
      kind: "run-quality-list",
      attempt: 3,
      scope: { kind: "since", sha: "abc" },
    });
    // A repeated rejection at that head carries the ruling's reasoning.
    const rejectedAgain = stepAll(again.state, round(gate1Ok, changes("finding"), "abc"));
    expect(asImpl(rejectedAgain.action).latestReviewerFeedback).toContain(
      "Independent adjudicator: UPHELD",
    );
  });

  it("refuses a ruling about a head other than the pending one", () => {
    const disputed = step(reachRejection().state, impl(complete, [], null, null, 0, "abc"));
    expect(() =>
      step(disputed.state, {
        kind: "adjudicator-result",
        head: "zzz",
        ruling: "OVERRULED",
        reasoning: "",
      }),
    ).toThrow(/other than the pending head/);
  });

  it("parks immediately if the read-only adjudicator writes", () => {
    const disputed = step(reachRejection().state, impl(complete, [], null, null, 0, "abc"));
    const wrote = step(disputed.state, { kind: "adjudicator-wrote", detail: "it committed" });
    expect(wrote.action).toEqual({
      kind: "terminate",
      verdict: {
        type: "NEEDS-HUMAN-REVIEW",
        cause: "adjudicator-wrote",
        latestReviewerProse: "it committed",
      },
    });
  });

  it("charges no budget for missing rulings and stops on the second harness failure", () => {
    const disputed = step(reachRejection().state, impl(complete, [], null, null, 0, "abc"));
    const failed = step(disputed.state, { kind: "adjudicator-harness-failed", detail: "no ruling" });
    const retry = asImpl(failed.action);
    expect(retry.extraReprompt).toContain("independent adjudicator could not be run");
    expect(failed.state.correctnessFailures).toBe(1);
    expect(failed.state.gateFailures).toBe(0);
    const disputedAgain = step(failed.state, impl(complete, [], null, null, 0, "abc"));
    expect(disputedAgain.action.kind).toBe("run-adjudicator");
    const failedTwice = step(disputedAgain.state, {
      kind: "adjudicator-harness-failed",
      detail: "no ruling again",
    });
    expect(failedTwice.action).toMatchObject({
      kind: "terminate",
      verdict: {
        type: "NEEDS-HUMAN",
        cause: "reviewer-harness-failed",
        failureTrace: "adjudicator: no ruling again",
        latestReviewerProse: "finding",
      },
    });
  });
});

describe("inner-loop-machine — one pre-attempt UI check (#126)", () => {
  it("runs before attempt 1 without spending an attempt, then proceeds on CLEAR", () => {
    const state = initialState({ ...defaultOpts, uiPrototypeCheck: true });
    expect(initialAction(state)).toEqual({ kind: "run-ui-check" });
    const result = step(state, { kind: "ui-check-result", result: { kind: "CLEAR" } });
    expect(result.action).toMatchObject({ kind: "run-implementer", attempt: 1 });
    expect(result.state.attempt).toBe(1);
    expect(result.state.gateFailures).toBe(0);
    expect(result.state.correctnessFailures).toBe(0);
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
  });

  it("starts directly with the implementer when disabled", () => {
    expect(initialAction(initialState(defaultOpts))).toMatchObject({
      kind: "run-implementer",
      attempt: 1,
    });
  });

  it("parks a checker that writes before trusting its classification", () => {
    const state = initialState({ ...defaultOpts, uiPrototypeCheck: true });
    const result = step(state, { kind: "ui-checker-wrote", detail: "UI checker changed git state" });
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

describe("inner-loop-machine — issue partition check (#158)", () => {
  it("runs before UI and attempt 1, then proceeds on CLEAR", () => {
    const state = initialState({ ...defaultOpts, partitionCheck: true, uiPrototypeCheck: true });
    expect(initialAction(state)).toEqual({ kind: "run-partition-check" });
    const checked = step(state, {
      kind: "partition-check-result",
      result: { kind: "CLEAR" },
      size: 12_000,
      budget: 600_000,
    });
    expect(checked.action).toEqual({ kind: "run-ui-check" });
    expect(checked.state.attempt).toBe(1);
  });

  it("terminates with structured classifier evidence", () => {
    const state = initialState({ ...defaultOpts, partitionCheck: true });
    const checked = step(state, {
      kind: "partition-check-result",
      result: { kind: "PARTITION", reason: "API and UI can land alone." },
      size: 13_000,
      budget: 600_000,
    });
    expect(checked.action).toEqual({
      kind: "terminate",
      verdict: {
        type: "NEEDS-PARTITION",
        cause: "classifier",
        slot: "partition-check",
        size: 13_000,
        budget: 600_000,
        detail: "API and UI can land alone.",
      },
    });
  });

  it("parks a checker that writes", () => {
    const state = initialState({ ...defaultOpts, partitionCheck: true });
    const result = step(state, { kind: "partition-checker-wrote", detail: "wrote" });
    expect(result.action).toMatchObject({
      kind: "terminate",
      verdict: { type: "NEEDS-HUMAN-REVIEW", cause: "partition-checker-wrote" },
    });
  });
});

describe("inner-loop-machine — implementer escalations", () => {
  it("attempt 1 NEEDS-INFO short-circuits to NEEDS-INFO with questions block", () => {
    const { verdict } = drive(defaultOpts, [impl(needsInfo("which currency?"))]);
    expect(verdict).toEqual({ type: "NEEDS-INFO", questions: "which currency?", strandedHead: null });
  });

  it("attempt 1 NEEDS-UI-PROTOTYPE short-circuits — no round (#21)", () => {
    const { actions, verdict } = drive(defaultOpts, [impl(needsUiPrototype("a modal"))]);
    expect(actions.map((a) => a.kind)).toEqual(["run-implementer", "terminate"]);
    expect(verdict).toEqual({ type: "NEEDS-UI-PROTOTYPE", uiImpact: "a modal", strandedHead: null });
  });

  it("a late NEEDS-UI-PROTOTYPE terminates mid-loop without burning further attempts", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete),
      ...round(gate1Ok, changes("add the error state")),
      impl(needsUiPrototype("the error state needs a screen")),
    ]);
    expect(actions.filter((a) => a.kind === "run-implementer")).toHaveLength(2);
    expect(verdict.type).toBe("NEEDS-UI-PROTOTYPE");
  });
});

describe("inner-loop-machine — gate-1 red re-prompts", () => {
  it("multiple gate-1 reds before green, then APPROVED → DONE", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete),
      ...round(gate1Red("red 1")),
      impl(complete),
      ...round(gate1Red("red 2")),
      impl(complete),
      ...round(gate1Ok, approved()),
    ]);
    expect(verdict).toEqual({ type: "DONE" });
    const implementers = actions.filter((a) => a.kind === "run-implementer");
    expect(implementers.map((a) => asImpl(a).failureTrace)).toEqual(["", "red 1", "red 2"]);
  });

  it("red-red-green resets the gate streak", () => {
    const state = stepAll(initialState(defaultOpts), [
      impl(complete), ...round(gate1Red("r1")),
      impl(complete), ...round(gate1Red("r2")),
      impl(complete), quality, gated(gate1Ok),
    ]).state;
    expect(state.gateFailures).toBe(0);
    expect(state.lastFailureTrace).toBe("");
  });

  it("keeps an earlier correctness rejection beside a later gate failure", () => {
    const r = stepAll(initialState(defaultOpts), [
      impl(complete), ...round(gate1Ok, changes("handle null")),
      impl(complete), ...round(gate1Red("the quality pass's new test fails")),
    ]);
    const next = asImpl(r.action);
    expect(next.failureTrace).toBe("the quality pass's new test fails");
    expect(next.latestReviewerFeedback).toBe("handle null");
    expect(r.state.correctnessFailures).toBe(1);
    expect(r.state.gateFailures).toBe(1);
  });

  it("repeated gate-1 red exhausts the gate budget with the latest step, trace and review", () => {
    const { verdict } = drive({ maxGateRounds: 2 }, [
      impl(complete), ...round(gate1Ok, changes("earlier finding")),
      impl(complete), ...round(gate1Red("first", "lint")),
      impl(complete), ...round(gate1Red("second", "test")),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      cause: "gate-red",
      failureTrace: "second",
      latestReviewerProse: "earlier finding",
      budgetExhausted: { budget: "gate", roundsUsed: 2, failedStep: "test" },
      strandedHead: null,
    });
  });

  it("maxGateRounds=1 with one gate-1 red surfaces NEEDS-HUMAN", () => {
    const { verdict } = drive({ maxGateRounds: 1 }, [impl(complete), ...round(gate1Red("boom"))]);
    expect(verdict).toMatchObject({ type: "NEEDS-HUMAN", cause: "gate-red" });
  });
});

describe("inner-loop-machine — correctness CHANGES-REQUESTED loop", () => {
  it("one impl + CHANGES-REQUESTED → next impl carries the prose and clears the trace", () => {
    const r = stepAll(initialState(defaultOpts), [
      impl(complete),
      ...round(gate1Ok, changes("handle null")),
    ]);
    expect(r.action).toEqual({
      kind: "run-implementer",
      attempt: 2,
      failureTrace: "",
      extraReprompt: null,
      latestReviewerFeedback: "handle null",
    });
    expect(r.state.pendingRejection).toEqual({ round: 1, head: "head", report: "handle null" });
  });

  it("latest reviewer prose replaces an older one on a subsequent CHANGES-REQUESTED", () => {
    const r = stepAll(initialState(defaultOpts), [
      impl(complete), ...round(gate1Ok, changes("first")),
      impl(complete), ...round(gate1Ok, changes("second")),
    ]);
    expect(asImpl(r.action).latestReviewerFeedback).toBe("second");
  });

  it("maxReviewRounds CHANGES-REQUESTED rounds → NEEDS-HUMAN-REVIEW with latest prose", () => {
    const { verdict } = drive(defaultOpts, [
      impl(complete), ...round(gate1Ok, changes("one")),
      impl(complete), ...round(gate1Ok, changes("two")),
      impl(complete), ...round(gate1Ok, changes("three")),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN-REVIEW",
      cause: "correctness-budget-exhausted",
      roundsUsed: 3,
      latestReviewerProse: "three",
    });
  });

  it("correctness rejections do not spend the gate budget", () => {
    const state = stepAll(initialState({ ...defaultOpts, maxGateRounds: 1 }), [
      impl(complete), ...round(gate1Ok, changes("one")),
      impl(complete), ...round(gate1Ok, changes("two")),
    ]).state;
    expect(state.gateFailures).toBe(0);
    expect(state.correctnessFailures).toBe(2);
  });

  it("gate failures and pre-gate re-prompts do not spend the review budget", () => {
    const state = stepAll(initialState({ ...defaultOpts, maxReviewRounds: 1 }), [
      impl(complete), ...round(gate1Red("red")),
      impl(noSignal()),
      impl(complete), quality, gated(gate1Ok),
    ]).state;
    expect(state.correctnessFailures).toBe(0);
    expect(state.phase).toBe("needs-correctness");
  });

  it("parks immediately when the reviewer writes git state (#98)", () => {
    const { verdict } = drive(defaultOpts, [
      impl(complete),
      ...round(gate1Ok, { kind: "reviewer-wrote", detail: "reviewer committed" }),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN-REVIEW",
      cause: "reviewer-wrote",
      latestReviewerProse: "reviewer committed",
    });
  });
});

describe("inner-loop-machine — reviewer harness failure (#41)", () => {
  it("spends neither budget and re-prompts with an orchestrator note", () => {
    const r = stepAll(initialState(defaultOpts), [impl(complete), ...round(gate1Ok, harnessFailed("idle 600s"))]);
    const next = asImpl(r.action);
    expect(r.state.gateFailures).toBe(0);
    expect(r.state.correctnessFailures).toBe(0);
    expect(r.state.reviewerHarnessFailures).toBe(1);
    expect(next.extraReprompt).toBe(reviewerHarnessFailedReprompt(false));
    expect(next.extraReprompt).not.toContain("idle 600s");
    expect(next.failureTrace).toBe("");
    expect(next.latestReviewerFeedback).toBeNull();
  });

  it("cannot exhaust the review budget — a maxReviewRounds of 1 survives it", () => {
    const r = stepAll(initialState({ ...defaultOpts, maxReviewRounds: 1 }), [
      impl(complete), ...round(gate1Ok, harnessFailed()),
    ]);
    expect(r.action.kind).toBe("run-implementer");
  });

  it("leaves an earlier round's real prose exactly as it was", () => {
    const r = stepAll(initialState(defaultOpts), [
      impl(complete), ...round(gate1Ok, changes("real finding")),
      impl(complete), ...round(gate1Ok, harnessFailed()),
    ]);
    const next = asImpl(r.action);
    expect(next.latestReviewerFeedback).toBe("real finding");
    expect(next.extraReprompt).toBe(reviewerHarnessFailedReprompt(true));
  });

  it("a second harness failure terminates instead of grinding the budget", () => {
    const { verdict } = drive(defaultOpts, [
      impl(complete), ...round(gate1Ok, changes("real finding")),
      impl(complete), ...round(gate1Ok, harnessFailed("first")),
      impl(complete), ...round(gate1Red("red between")),
      impl(complete), ...round(gate1Ok, harnessFailed("second")),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      cause: "reviewer-harness-failed",
      failureTrace: "second",
      latestReviewerProse: "real finding",
      budgetExhausted: null,
      strandedHead: null,
    });
  });
});

// #185 folds every attempt that produced no commit the gate could judge into
// the gate budget, and a green gate resets that streak.
describe("inner-loop-machine — pre-gate re-prompts spend the gate budget", () => {
  it("charges NO-SIGNAL to the gate streak", () => {
    const r = step(initialState(defaultOpts), impl(noSignal("Emit a token.")));
    expect(r.state.gateFailures).toBe(1);
    expect(asImpl(r.action).extraReprompt).toBe("Emit a token.");
  });

  it("a green gate resets a streak of pre-gate failures", () => {
    const state = stepAll(initialState(defaultOpts), [
      impl(noSignal()),
      impl(complete, ["?? a.ts"]),
      impl(complete), quality, gated(gate1Ok),
    ]).state;
    expect(state.gateFailures).toBe(0);
  });

  it("mixes red gates and pre-gate failures in one streak", () => {
    const { verdict } = drive({ maxGateRounds: 3 }, [
      impl(complete), ...round(gate1Red("red", "lint")),
      impl(noSignal()),
      impl(noSignal("still nothing")),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      cause: "no-signal-exhausted",
      failureTrace: "Last gate failure:\nred\n\nThe final implementer signal failed validation:\nstill nothing",
      latestReviewerProse: null,
      budgetExhausted: { budget: "gate", roundsUsed: 3, failedStep: null },
      strandedHead: null,
    });
  });

  it("repeated NO-SIGNAL exhausts with its own honest cause", () => {
    const { verdict } = drive({ maxGateRounds: 2 }, [impl(noSignal()), impl(noSignal())]);
    expect(verdict).toMatchObject({
      type: "NEEDS-HUMAN",
      cause: "no-signal-exhausted",
      failureTrace: "The final implementer attempt emitted no <promise> token.",
      budgetExhausted: { budget: "gate", roundsUsed: 2, failedStep: null },
    });
  });

  it("clears the NO-SIGNAL reprompt after one use", () => {
    const r = stepAll(initialState(defaultOpts), [
      impl(noSignal("correction")),
      impl(complete), ...round(gate1Red("red")),
    ]);
    expect(asImpl(r.action).extraReprompt).toBeNull();
  });

  it("defaults the shared budget to four", () => {
    expect(initialState({ ...defaultOpts, maxGateRounds: DEFAULT_MAX_GATE_ROUNDS }).maxGateRounds).toBe(4);
  });
});

describe("inner-loop-machine — phase invariants", () => {
  it("stepping after terminate throws", () => {
    const r = step(initialState(defaultOpts), impl(needsInfo("q")));
    expect(() => step(r.state, impl(complete))).toThrow(/after termination/);
  });

  it.each([
    ["a quality review before COMPLETE", quality, /quality-review-result event in phase needs-implementer/],
    ["a fixer result before COMPLETE", fixed(), /quality-fix-result event in phase needs-implementer/],
    ["a gate result before COMPLETE", gated(gate1Ok), /gate-result event in phase needs-implementer/],
    ["a correctness result before COMPLETE", reviewed(approved()), /correctness-result event in phase needs-implementer/],
  ] as const)("%s throws", (_name, event, message) => {
    expect(() => step(initialState(defaultOpts), event)).toThrow(message);
  });

  it("a correctness result before the gate throws", () => {
    const state = stepAll(initialState(defaultOpts), [impl(complete), quality]).state;
    expect(() => step(state, reviewed(approved()))).toThrow(/expected needs-correctness/);
  });

  it.each([
    ["maxQualityRounds", 0],
    ["maxGateRounds", 0],
    ["maxReviewRounds", 1.5],
  ] as const)("initialState rejects non-positive %s", (field, value) => {
    expect(() => initialState({ ...defaultOpts, [field]: value })).toThrow(
      new RegExp(`${field} must be a positive integer`),
    );
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
        budgetExhausted: { budget: "gate", roundsUsed: 4, failedStep: "tests" },
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
      expect(decideAfterTerminal(v, HARD_ERROR_MAX_RETRIES)).toEqual({ kind: "surface" });
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
    expect(decideAfterTerminal(hardError, HARD_ERROR_MAX_RETRIES)).toEqual({ kind: "surface" });
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

  it("routes back to the implementer instead of the round", () => {
    const r = step(initialState(defaultOpts), impl(complete, dirty));
    expect(r.action.kind).toBe("run-implementer");
    expect(r.state.phase).toBe("needs-implementer");
    expect(r.state.attempt).toBe(2);
  });

  it("names the dirty paths in the re-prompt", () => {
    const next = asImpl(step(initialState(defaultOpts), impl(complete, dirty)).action);
    expect(next.extraReprompt).toContain("?? src/new-file.ts");
    expect(next.extraReprompt).toContain(" M src/existing.ts");
    expect(next.extraReprompt).toContain("uncommitted");
  });

  it("elides a long dirty list rather than filling the prompt with it", () => {
    const many = Array.from({ length: 25 }, (_, i) => `?? f${i}.ts`);
    const next = asImpl(step(initialState(defaultOpts), impl(complete, many)).action);
    expect(next.extraReprompt).toContain("?? f19.ts");
    expect(next.extraReprompt).not.toContain("?? f20.ts");
    expect(next.extraReprompt).toContain("… and 5 more");
  });

  it("tells the agent its gate artifacts must be gitignored", () => {
    const next = asImpl(step(initialState(defaultOpts), impl(complete, dirty)).action);
    expect(next.extraReprompt).toContain("gitignored");
  });

  it("starts the round normally once the tree is clean", () => {
    const r = stepAll(initialState(defaultOpts), [impl(complete, dirty), impl(complete)]);
    expect(r.action.kind).toBe("run-quality-list");
  });

  it("spends the gate budget, and exhausting it on dirt is NEEDS-HUMAN", () => {
    // Each attempt leaves a DIFFERENT dirty set, so the agent is visibly still
    // working and the loop lets it run to the end of the budget.
    const { actions, verdict } = drive({ maxGateRounds: 2 }, [
      impl(complete, ["?? a.ts"]),
      impl(complete, ["?? b.ts"]),
    ]);
    expect(actions.map((a) => a.kind)).toEqual(["run-implementer", "run-implementer", "terminate"]);
    expect(verdict).toMatchObject({
      type: "NEEDS-HUMAN",
      cause: "uncommittable-worktree",
      budgetExhausted: { budget: "gate", roundsUsed: 2, failedStep: null },
    });
    if (verdict.type !== "NEEDS-HUMAN") throw new Error("unreachable");
    expect(verdict.failureTrace).toContain("?? b.ts");
  });

  it("stops immediately when an attempt leaves the dirty set unchanged", () => {
    const { actions, verdict } = drive(defaultOpts, [impl(complete, dirty), impl(complete, dirty)]);
    expect(actions.map((a) => a.kind)).toEqual(["run-implementer", "run-implementer", "terminate"]);
    expect(verdict).toMatchObject({
      type: "NEEDS-HUMAN",
      cause: "uncommittable-worktree",
      budgetExhausted: null,
    });
  });

  it("annotates a repeated dirty-set stop that also exhausts the gate budget", () => {
    const { verdict } = drive({ maxGateRounds: 2 }, [impl(complete, dirty), impl(complete, dirty)]);
    expect(verdict).toMatchObject({
      type: "NEEDS-HUMAN",
      cause: "uncommittable-worktree",
      budgetExhausted: { budget: "gate", roundsUsed: 2, failedStep: null },
    });
  });

  it("treats a reordered dirty set as unchanged", () => {
    const { actions } = drive(defaultOpts, [
      impl(complete, ["?? a.ts", "?? b.ts"]),
      impl(complete, ["?? b.ts", "?? a.ts"]),
    ]);
    expect(actions.at(-1)?.kind).toBe("terminate");
  });

  it("keeps going when the agent commits SOME of the dirt", () => {
    const r = stepAll(initialState(defaultOpts), [
      impl(complete, ["?? a.ts", "?? b.ts"]),
      impl(complete, ["?? b.ts"]),
    ]);
    expect(r.action.kind).toBe("run-implementer");
  });

  it("clears the dirty memory once the tree comes back clean", () => {
    const state = stepAll(initialState(defaultOpts), [impl(complete, dirty), impl(complete)]).state;
    expect(state.lastDirtyPaths).toBeNull();
  });

  it("does not block the short-circuit terminals — dirt is irrelevant to them", () => {
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
    branchIsAncestor: false,
  };

  it("does NOT start the round for COMPLETE over a clean tree off the branch", () => {
    const r = step(initialState(defaultOpts), impl(complete, [], detached()));
    expect(r.action.kind).toBe("run-implementer");
    expect(r.state.attempt).toBe(2);
    expect(r.state.gateFailures).toBe(1);
  });

  it("names where HEAD actually is, and where the branch still is", () => {
    const next = asImpl(step(initialState(defaultOpts), impl(complete, [], detached("dead1", "base0"))).action);
    expect(next.extraReprompt).toContain("DETACHED at dead1");
    expect(next.extraReprompt).toContain("sandbar/issue-1-x");
    expect(next.extraReprompt).toContain("base0");
  });

  it("names the scratch branch when HEAD is on one", () => {
    const next = asImpl(step(initialState(defaultOpts), impl(complete, [], onBranchScratch)).action);
    expect(next.extraReprompt).toContain("refs/heads/scratch");
  });

  it("unconditionally warns against `git branch -f`", () => {
    const text = offBranchHeadReprompt(detached());
    expect(text).toContain("Do not force the ref");
    expect(text).toContain("cherry-pick");
  });

  const repaired = { fromSha: "base0", toSha: "head1" } as const;
  const roundAfterRepair = (events: readonly LoopEvent[]) =>
    stepAll(initialState(defaultOpts), [impl(complete, [], null, repaired), ...events]);

  it.each([
    {
      route: "dirty tree",
      next: () => step(initialState(defaultOpts), impl(complete, ["?? pending.ts"], null, repaired)),
      routeContext: "?? pending.ts",
    },
    {
      route: "NO-SIGNAL",
      next: () =>
        step(initialState(defaultOpts), impl(noSignal("Emit a valid promise token."), [], null, repaired)),
      routeContext: "Emit a valid promise token.",
    },
    {
      route: "gate red",
      next: () => roundAfterRepair(round(gate1Red("gate exploded"))),
      routeContext: "gate exploded",
    },
    {
      route: "correctness rejection",
      next: () => roundAfterRepair(round(gate1Ok, changes("adjust this"))),
      routeContext: "adjust this",
    },
    {
      route: "reviewer harness failure",
      next: () => roundAfterRepair(round(gate1Ok, harnessFailed())),
      routeContext: "reviewer could not be run",
    },
  ])("carries the free repair note and $route context into the next attempt", ({ next, routeContext }) => {
    const result = next();
    const action = asImpl(result.action);
    expect(action.extraReprompt).toContain("moved `sandbar/issue-1-x` from base0");
    expect(action.extraReprompt).toContain("HEAD at head1");
    expect([action.extraReprompt, action.failureTrace, action.latestReviewerFeedback].join("\n"))
      .toContain(routeContext);
    expect(result.state.lastOffBranch).toBe(false);
  });

  it("does not spend the off-branch correction when a repair precedes another route", () => {
    const state = step(initialState(defaultOpts), impl(noSignal(), [], null, repaired)).state;
    expect(state.lastOffBranch).toBe(false);
    expect(step(state, impl(complete, [], detached("head2"))).action.kind).toBe("run-implementer");
  });

  it.each([
    ["NEEDS-INFO", needsInfo("which currency?")],
    ["NEEDS-UI-PROTOTYPE", needsUiPrototype("a new settings screen")],
  ] as const)("does not report repaired commits as stranded on a %s escalation", (expectedType, signal) => {
    const { verdict } = drive(defaultOpts, [impl(signal, [], null, repaired)]);
    expect(verdict).toMatchObject({ type: expectedType, strandedHead: null });
  });

  it("also fires on NO-SIGNAL, replacing the generic hint", () => {
    const next = asImpl(step(
      initialState(defaultOpts),
      impl({ kind: "NO-SIGNAL", reprompt: "Still working.", missingTag: true }, [], detached()),
    ).action);
    expect(next.extraReprompt).toContain("not on the issue branch");
    expect(next.extraReprompt).not.toContain("Still working.");
  });

  it("starts the round normally once HEAD is back on the branch", () => {
    const r = stepAll(initialState(defaultOpts), [impl(complete, [], detached()), impl(complete)]);
    expect(r.action.kind).toBe("run-quality-list");
  });

  it("terminates on a SECOND consecutive off-branch attempt, well inside the budget", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete, [], detached("dead1")),
      impl(complete, [], detached("dead2")),
    ]);
    expect(actions.map((a) => a.kind)).toEqual(["run-implementer", "run-implementer", "terminate"]);
    expect(verdict).toMatchObject({
      type: "NEEDS-HUMAN",
      cause: "off-branch-head",
      budgetExhausted: null,
      strandedHead: { headSha: "dead2" },
    });
    if (verdict.type !== "NEEDS-HUMAN") throw new Error("unreachable");
    expect(verdict.failureTrace).toContain("dead2");
  });

  it("annotates a repeated off-branch stop that also exhausts the gate budget", () => {
    const { verdict } = drive({ maxGateRounds: 2 }, [
      impl(complete, [], detached("dead1")),
      impl(complete, [], detached("dead2")),
    ]);
    expect(verdict).toMatchObject({
      type: "NEEDS-HUMAN",
      cause: "off-branch-head",
      budgetExhausted: { budget: "gate", roundsUsed: 2, failedStep: null },
    });
  });

  it("counts CONSECUTIVE attempts, so a later relapse gets its own correction", () => {
    const relapse = stepAll(initialState(defaultOpts), [
      impl(complete, [], detached()),
      impl(noSignal()),
      impl(complete, [], detached()),
    ]);
    expect(relapse.action.kind).toBe("run-implementer");
    expect(step(relapse.state, impl(complete, [], detached())).action.kind).toBe("terminate");
  });

  it("exhausting the budget off-branch is off-branch-head, not gate-red", () => {
    const { verdict } = drive({ maxGateRounds: 1 }, [impl(complete, [], detached())]);
    expect(verdict).toMatchObject({ type: "NEEDS-HUMAN", cause: "off-branch-head" });
  });

  it("is checked BEFORE the dirty tree — the branch is the deeper problem", () => {
    const next = asImpl(step(initialState(defaultOpts), impl(complete, ["?? src/new.ts"], detached())).action);
    expect(next.extraReprompt).toContain("not on the issue branch");
  });

  // Exempt must not mean silent: the commits are counted on the BRANCH, so an
  // off-branch escalation reports zero and the sha would otherwise exist
  // nowhere once the worktree goes.
  it("carries the mismatch into both exempted terminals so the sha survives", () => {
    const m = detached("stranded1");
    expect(drive(defaultOpts, [impl(needsInfo("q"), [], m)]).verdict).toMatchObject({
      type: "NEEDS-INFO",
      strandedHead: { headSha: "stranded1" },
    });
    expect(drive(defaultOpts, [impl(needsUiPrototype("a modal"), [], m)]).verdict).toMatchObject({
      type: "NEEDS-UI-PROTOTYPE",
      strandedHead: { headSha: "stranded1" },
    });
  });

  it("leaves strandedHead null on the other NEEDS-HUMAN causes", () => {
    const { verdict } = drive({ maxGateRounds: 1 }, [impl(complete), ...round(gate1Red("boom"))]);
    expect(verdict).toMatchObject({ type: "NEEDS-HUMAN", cause: "gate-red", strandedHead: null });
  });
});
