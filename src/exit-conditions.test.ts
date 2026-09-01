import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_TOTAL_ISSUES } from "./config.js";
import {
  EXIT_CODE_BUDGET,
  EXIT_CODE_RELAUNCH,
  EXIT_CODE_STUCK,
  applyCycle,
  newRunState,
  planFingerprint,
  remainingBudget,
} from "./exit-conditions.js";

describe("planFingerprint", () => {
  it("is order-insensitive", () => {
    expect(planFingerprint(["44", "10", "42"])).toBe(
      planFingerprint(["10", "42", "44"]),
    );
  });

  it("differs when the issue set differs", () => {
    expect(planFingerprint(["10", "42"])).not.toBe(
      planFingerprint(["10", "42", "44"]),
    );
  });

  it("empty plan has the empty fingerprint", () => {
    expect(planFingerprint([])).toBe("");
  });

  it("sorts numerically, not lexicographically", () => {
    expect(planFingerprint(["10", "9"])).toBe("9,10");
  });
});

describe("remainingBudget", () => {
  it("starts at maxTotalIssues default", () => {
    expect(remainingBudget(newRunState())).toBe(DEFAULT_MAX_TOTAL_ISSUES);
  });

  it("decreases as issuesAttempted grows", () => {
    const s = newRunState();
    s.issuesAttempted = DEFAULT_MAX_TOTAL_ISSUES - 3;
    expect(remainingBudget(s)).toBe(3);
  });

  it("clamps to 0 when over budget", () => {
    const s = newRunState();
    s.issuesAttempted = DEFAULT_MAX_TOTAL_ISSUES + 5;
    expect(remainingBudget(s)).toBe(0);
  });

  it("respects a custom maxTotalIssues", () => {
    const s = newRunState({ maxTotalIssues: 10 });
    expect(remainingBudget(s)).toBe(10);
    s.issuesAttempted = 7;
    expect(remainingBudget(s)).toBe(3);
  });
});

describe("applyCycle", () => {
  it("continues when the cycle made progress and no caps are hit", () => {
    const s = newRunState();
    const d = applyCycle(s, {
      planFingerprint: "10,42",
      planSize: 2,
      doneCount: 1,
      landedMerges: 0,
    });
    expect(d.kind).toBe("continue");
    expect(s.issuesAttempted).toBe(2);
    expect(s.consecutiveZeroDoneCycles).toBe(0);
    expect(s.lastPlanFingerprint).toBe("10,42");
  });

  it("does not flag (b) on the very first cycle", () => {
    const s = newRunState();
    const d = applyCycle(s, {
      planFingerprint: "10",
      planSize: 1,
      doneCount: 0,
      landedMerges: 0,
    });
    expect(d.kind).toBe("continue");
    expect(s.consecutiveZeroDoneCycles).toBe(1);
  });

  it("(b) stuck when the same plan repeats with zero DONEs the second time", () => {
    const s = newRunState();
    applyCycle(s, { planFingerprint: "10,42", planSize: 2, doneCount: 0, landedMerges: 0 });
    const d = applyCycle(s, {
      planFingerprint: "10,42",
      planSize: 2,
      doneCount: 0,
      landedMerges: 0,
    });
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.tag).toBe("stuck-same-plan");
    expect(d.exitCode).toBe(EXIT_CODE_STUCK);
    expect(d.reason).toMatch(/plan 10,42 repeated/);
  });

  it("(c) stuck when two consecutive zero-DONE cycles have different plans", () => {
    const s = newRunState();
    const d1 = applyCycle(s, {
      planFingerprint: "10,42",
      planSize: 2,
      doneCount: 0,
      landedMerges: 0,
    });
    expect(d1.kind).toBe("continue");
    const d2 = applyCycle(s, {
      planFingerprint: "11,43",
      planSize: 2,
      doneCount: 0,
      landedMerges: 0,
    });
    expect(d2.kind).toBe("exit");
    if (d2.kind !== "exit") throw new Error("unreachable");
    expect(d2.tag).toBe("stuck-zero-dones");
    expect(d2.exitCode).toBe(EXIT_CODE_STUCK);
    expect(d2.reason).toMatch(/2 consecutive/);
  });

  it("zero-DONE streak resets when a cycle produces a DONE", () => {
    const s = newRunState();
    applyCycle(s, { planFingerprint: "a", planSize: 1, doneCount: 0, landedMerges: 0 });
    applyCycle(s, { planFingerprint: "b", planSize: 1, doneCount: 1, landedMerges: 0 });
    expect(s.consecutiveZeroDoneCycles).toBe(0);
    const d = applyCycle(s, {
      planFingerprint: "c",
      planSize: 1,
      doneCount: 0,
      landedMerges: 0,
    });
    expect(d.kind).toBe("continue");
  });

  it("(d) budget when issuesAttempted reaches maxTotalIssues", () => {
    const s = newRunState();
    s.issuesAttempted = DEFAULT_MAX_TOTAL_ISSUES - 3;
    const d = applyCycle(s, {
      planFingerprint: "x",
      planSize: 3,
      doneCount: 1,
      landedMerges: 0,
    });
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.tag).toBe("budget");
    expect(d.exitCode).toBe(EXIT_CODE_BUDGET);
    expect(d.reason).toMatch(new RegExp(`>= maxTotalIssues=${DEFAULT_MAX_TOTAL_ISSUES}`));
  });

  it("stuck checks fire before budget when both apply", () => {
    const s = newRunState();
    s.issuesAttempted = DEFAULT_MAX_TOTAL_ISSUES - 2;
    s.lastPlanFingerprint = "10,42";
    s.consecutiveZeroDoneCycles = 1;
    const d = applyCycle(s, {
      planFingerprint: "10,42",
      planSize: 2,
      doneCount: 0,
      landedMerges: 0,
    });
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.tag).toBe("stuck-same-plan");
  });

  it("each call advances issuesAttempted by planSize regardless of outcome", () => {
    const s = newRunState();
    applyCycle(s, { planFingerprint: "a", planSize: 3, doneCount: 0, landedMerges: 0 });
    applyCycle(s, { planFingerprint: "b", planSize: 2, doneCount: 1, landedMerges: 0 });
    expect(s.issuesAttempted).toBe(5);
  });
});

// (e) relaunch-after-landing (#65). The launcher's loop continues on exactly
// EXIT_CODE_RELAUNCH and propagates everything else, so what these pin is the
// loop's no-spin argument: the code requires a landing (progress), and a cycle
// that lands nothing falls through to the codes that break the loop.
describe("applyCycle — relaunch after landing (#65)", () => {
  it("exits EXIT_CODE_RELAUNCH when the cycle landed merges and the flag is set", () => {
    const s = newRunState({ relaunchAfterLanding: true });
    const d = applyCycle(s, {
      planFingerprint: "10,42",
      planSize: 2,
      doneCount: 2,
      landedMerges: 2,
    });
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.tag).toBe("relaunch");
    expect(d.exitCode).toBe(EXIT_CODE_RELAUNCH);
    expect(d.reason).toMatch(/landed 2 merge/);
  });

  // The reason is stdout and `orchestrator.log`, and it is what an operator
  // reads to decide whether the change they just landed is now in play. Before
  // #66 it said "relaunching so the driver is what it just landed", which the
  // pin made false on every landing cycle — the driver is the release
  // `sandbar.pin` names and a landing does not become it. Asserted here so the
  // claim cannot drift back.
  it("names what the relaunch re-resolves, and does not claim the driver moved", () => {
    const s = newRunState({ relaunchAfterLanding: true });
    const d = applyCycle(s, {
      planFingerprint: "10",
      planSize: 1,
      doneCount: 1,
      landedMerges: 1,
    });
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.reason).toMatch(/images/);
    expect(d.reason).toMatch(/config/);
    expect(d.reason).not.toMatch(/driver is what it just landed/);
  });

  it("is inert without the flag — a landing cycle continues as before", () => {
    const s = newRunState();
    const d = applyCycle(s, {
      planFingerprint: "10,42",
      planSize: 2,
      doneCount: 2,
      landedMerges: 2,
    });
    expect(d.kind).toBe("continue");
  });

  it("does not fire without a landing — a DONE the merger skipped moved nothing on origin", () => {
    const s = newRunState({ relaunchAfterLanding: true });
    const d = applyCycle(s, {
      planFingerprint: "10",
      planSize: 1,
      doneCount: 1,
      landedMerges: 0,
    });
    expect(d.kind).toBe("continue");
  });

  it("(e) beats (d): a cycle that landed and exhausted the budget relaunches", () => {
    // Budgets are per-run and reset across runs by design, so stopping here
    // would end a series mid-progress that a fresh (re)launch would continue.
    const s = newRunState({ maxTotalIssues: 3, relaunchAfterLanding: true });
    const d = applyCycle(s, {
      planFingerprint: "1,2,3",
      planSize: 3,
      doneCount: 3,
      landedMerges: 3,
    });
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.tag).toBe("relaunch");
  });

  it("the flag does not weaken the loop-breaking exits: a landless repeat is still stuck", () => {
    const s = newRunState({ relaunchAfterLanding: true });
    applyCycle(s, { planFingerprint: "10,42", planSize: 2, doneCount: 0, landedMerges: 0 });
    const d = applyCycle(s, {
      planFingerprint: "10,42",
      planSize: 2,
      doneCount: 0,
      landedMerges: 0,
    });
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.tag).toBe("stuck-same-plan");
    expect(d.exitCode).toBe(EXIT_CODE_STUCK);
  });

  it("EXIT_CODE_RELAUNCH collides with none of the codes that must break the launcher's loop", () => {
    // The launcher continues on exactly this number; 0/1/2/3 (success, halt,
    // stuck, budget) must all propagate out of the loop.
    expect([0, 1, EXIT_CODE_STUCK, EXIT_CODE_BUDGET]).not.toContain(
      EXIT_CODE_RELAUNCH,
    );
  });
});
