import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_TOTAL_ISSUES } from "./config.js";
import {
  EXIT_CODE_BUDGET,
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
    });
    expect(d.kind).toBe("continue");
    expect(s.consecutiveZeroDoneCycles).toBe(1);
  });

  it("(b) stuck when the same plan repeats with zero DONEs the second time", () => {
    const s = newRunState();
    applyCycle(s, { planFingerprint: "10,42", planSize: 2, doneCount: 0 });
    const d = applyCycle(s, {
      planFingerprint: "10,42",
      planSize: 2,
      doneCount: 0,
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
    });
    expect(d1.kind).toBe("continue");
    const d2 = applyCycle(s, {
      planFingerprint: "11,43",
      planSize: 2,
      doneCount: 0,
    });
    expect(d2.kind).toBe("exit");
    if (d2.kind !== "exit") throw new Error("unreachable");
    expect(d2.tag).toBe("stuck-zero-dones");
    expect(d2.exitCode).toBe(EXIT_CODE_STUCK);
    expect(d2.reason).toMatch(/2 consecutive/);
  });

  it("zero-DONE streak resets when a cycle produces a DONE", () => {
    const s = newRunState();
    applyCycle(s, { planFingerprint: "a", planSize: 1, doneCount: 0 });
    applyCycle(s, { planFingerprint: "b", planSize: 1, doneCount: 1 });
    expect(s.consecutiveZeroDoneCycles).toBe(0);
    const d = applyCycle(s, {
      planFingerprint: "c",
      planSize: 1,
      doneCount: 0,
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
    });
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.tag).toBe("budget");
    expect(d.exitCode).toBe(EXIT_CODE_BUDGET);
    expect(d.reason).toMatch(new RegExp(`>= maxTotalIssues=${DEFAULT_MAX_TOTAL_ISSUES}`));
  });

  it("(b) takes priority over (c) when both would fire", () => {
    const s = newRunState();
    applyCycle(s, { planFingerprint: "10,42", planSize: 2, doneCount: 0 });
    const d = applyCycle(s, {
      planFingerprint: "10,42",
      planSize: 2,
      doneCount: 0,
    });
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.tag).toBe("stuck-same-plan");
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
    });
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.tag).toBe("stuck-same-plan");
  });

  it("each call advances issuesAttempted by planSize regardless of outcome", () => {
    const s = newRunState();
    applyCycle(s, { planFingerprint: "a", planSize: 3, doneCount: 0 });
    applyCycle(s, { planFingerprint: "b", planSize: 2, doneCount: 1 });
    expect(s.issuesAttempted).toBe(5);
  });
});
