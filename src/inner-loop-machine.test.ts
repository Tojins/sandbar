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
const needsUiPrototype = (uiImpact: string): ParseSignal => ({
  kind: "NEEDS-UI-PROTOTYPE",
  uiImpact,
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
// Clean tree unless a case says otherwise — the dirty routing (#24 D1) has its
// own describe block below.
const impl = (
  signal: ParseSignal,
  dirtyPaths: readonly string[] = [],
): LoopEvent => ({
  kind: "implementer-result",
  signal,
  dirtyPaths,
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

  it("attempt 1 NEEDS-UI-PROTOTYPE short-circuits — no gate, no reviewer (#21)", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(needsUiPrototype("new settings screen, layout invented")),
    ]);
    expect(actions.map((a) => a.kind)).toEqual(["run-implementer", "terminate"]);
    expect(verdict).toEqual({
      type: "NEEDS-UI-PROTOTYPE",
      uiImpact: "new settings screen, layout invented",
    });
  });

  it("a late NEEDS-UI-PROTOTYPE terminates mid-loop without burning further attempts", () => {
    const { actions, verdict } = drive(defaultOpts, [
      impl(complete),
      gate1Red("trace A"),
      impl(needsUiPrototype("only now do I see the invented flow")),
    ]);
    expect(actions.map((a) => a.kind)).toEqual([
      "run-implementer",
      "run-gate-1",
      "run-implementer",
      "terminate",
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-UI-PROTOTYPE",
      uiImpact: "only now do I see the invented flow",
    });
  });

  // The escalation must win over budget exhaustion: on the final attempt the
  // NO-SIGNAL path would emit gate-red NEEDS-HUMAN, which points the human at a
  // failing gate rather than the missing prototype.
  it("escalating on the LAST attempt terminates NEEDS-UI-PROTOTYPE, not budget-exhausted NEEDS-HUMAN", () => {
    const { verdict } = drive(
      { maxAttempts: 2, maxReviewRounds: 3 },
      [
        impl(complete),
        gate1Red("trace A"),
        impl(needsUiPrototype("the remaining work is all invented UI")),
      ],
    );
    expect(verdict).toEqual({
      type: "NEEDS-UI-PROTOTYPE",
      uiImpact: "the remaining work is all invented UI",
    });
  });

  it("escalating after a CHANGES-REQUESTED round discards the stashed reviewer prose", () => {
    const { verdict } = drive(defaultOpts, [
      impl(complete),
      gate1Ok,
      changes("extract the helper"),
      impl(needsUiPrototype("the reviewer's ask means redesigning the screen")),
    ]);
    // The terminal carries only the UI assessment — the human is being asked
    // for a prototype, not for a verdict on the reviewer's request.
    expect(verdict).toEqual({
      type: "NEEDS-UI-PROTOTYPE",
      uiImpact: "the reviewer's ask means redesigning the screen",
    });
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
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      cause: "gate-red",
      failureTrace: "trace 3",
      latestReviewerProse: null,
    });
  });

  it("repeated NO-SIGNAL over maxAttempts → NEEDS-HUMAN with sentinel (no trace recorded)", () => {
    const { verdict } = drive({ maxAttempts: 2, maxReviewRounds: 3 }, [
      impl(noSignal()),
      impl(noSignal()),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      cause: "gate-red",
      failureTrace: NEEDS_HUMAN_BUDGET_EXHAUSTED_MESSAGE,
      latestReviewerProse: null,
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
      cause: "gate-red",
      failureTrace: "recorded trace",
      latestReviewerProse: null,
    });
  });

  it("maxAttempts=1 with one gate-1 red still surfaces NEEDS-HUMAN", () => {
    const { verdict } = drive({ maxAttempts: 1, maxReviewRounds: 3 }, [
      impl(complete),
      gate1Red("trace"),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      cause: "gate-red",
      failureTrace: "trace",
      latestReviewerProse: null,
    });
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
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      cause: "gate-red",
      failureTrace: "trace",
      latestReviewerProse: null,
    });
  });

  it("impl budget exhausted with a GREEN gate + CHANGES-REQUESTED → reviewer-blocked, not 'no green gate' (#17)", () => {
    // The offergeist#404 shape: every attempt's gate is green, the reviewer
    // keeps requesting changes, and the IMPL-attempt budget (not the
    // review-round budget) runs out first. The terminal must name the reviewer
    // as the blocker and carry its latest prose — never claim "no green gate".
    const { verdict } = drive({ maxAttempts: 2, maxReviewRounds: 3 }, [
      impl(complete),
      gate1Ok,
      changes("r1"),
      impl(complete),
      gate1Ok,
      changes("r2"),
    ]);
    expect(verdict).toEqual({
      type: "NEEDS-HUMAN",
      cause: "reviewer-blocked",
      failureTrace: "",
      latestReviewerProse: "r2",
    });
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
      { type: "NEEDS-UI-PROTOTYPE", uiImpact: "invented screen" },
      {
        type: "NEEDS-HUMAN",
        cause: "gate-red",
        failureTrace: "trace",
        latestReviewerProse: null,
      },
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
    expect(r.action.kind).toBe("run-gate-1");
  });

  it("spends an attempt, and exhausting the budget on dirt is NEEDS-HUMAN", () => {
    // Each attempt leaves a DIFFERENT dirty set, so the agent is visibly still
    // working and the loop lets it run to the end of the budget.
    const { actions, verdict } = drive({ maxAttempts: 2, maxReviewRounds: 3 }, [
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
    const { actions, verdict } = drive({ maxAttempts: 8, maxReviewRounds: 3 }, [
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
    const { actions } = drive({ maxAttempts: 8, maxReviewRounds: 3 }, [
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
