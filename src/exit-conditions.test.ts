import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_TOTAL_ISSUES } from "./config.js";
import {
  EXIT_CODE_BUDGET,
  EXIT_CODE_HALTED,
  EXIT_CODE_RELAUNCH,
  EXIT_CODE_STUCK,
  EXIT_CODE_SUCCESS,
  EXIT_TAGS,
  type ExitTag,
  type TerminalExit,
  applyCycle,
  budgetExit,
  formatExitLine,
  haltedExit,
  iterationCeilingExit,
  newRunState,
  planEmptyExit,
  quotaExit,
  planFingerprint,
  relaunchExit,
  remainingBudget,
  stuckSamePlanExit,
  stuckZeroDonesExit,
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
  // #66 it said "relaunching so the driver is what it just landed", which a
  // pinned launcher made false on every landing cycle. The correction may not
  // claim a pin either: this flag is library config, and a consumer looping
  // `git pull && npm run build` (README) has none. So both over-claims are
  // asserted against — what the line may name is what THIS run re-resolves.
  it("names what the relaunch re-resolves, and claims nothing about the driver", () => {
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
    expect(d.reason).not.toMatch(/pin/);
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

// The whole decision union, one row per tag (#70). A run stops in exactly one
// shape — `Exit (<tag>): <reason>` on stdout, once, on every path — and before
// this issue the halt path printed nothing at all while plan-empty printed a
// success banner. Nothing can assert what `run()` prints (no test calls it, and
// this issue does not change that), so what IS asserted is the pure mapping
// from a terminal to its line: a tag added without a row here fails the last
// assertion in this block, which is what stops the next silent path from being
// noticed six weeks later.
describe("terminal exit lines", () => {
  const TABLE: ReadonlyArray<{
    readonly tag: ExitTag;
    readonly exit: TerminalExit;
    readonly exitCode: number;
    readonly reasonMatches: RegExp;
  }> = [
    {
      tag: "plan-empty",
      exit: planEmptyExit(),
      exitCode: EXIT_CODE_SUCCESS,
      reasonMatches: /no unblocked issues/,
    },
    {
      tag: "quota",
      exit: quotaExit({ provider: "claude", window: "five_hour", resetsAt: 1_788_422_400 }),
      exitCode: 4,
      reasonMatches: /claude five_hour quota window closed/,
    },
    {
      tag: "relaunch",
      exit: relaunchExit(2),
      exitCode: EXIT_CODE_RELAUNCH,
      reasonMatches: /landed 2 merge/,
    },
    {
      tag: "stuck-same-plan",
      exit: stuckSamePlanExit("10,42"),
      exitCode: EXIT_CODE_STUCK,
      reasonMatches: /plan 10,42 repeated/,
    },
    {
      tag: "stuck-zero-dones",
      exit: stuckZeroDonesExit(2),
      exitCode: EXIT_CODE_STUCK,
      reasonMatches: /2 consecutive cycles/,
    },
    {
      tag: "budget",
      exit: budgetExit(50, 50),
      exitCode: EXIT_CODE_BUDGET,
      reasonMatches: /issuesAttempted=50 >= maxTotalIssues=50/,
    },
    {
      tag: "halted",
      exit: haltedExit(["merger-halted"]),
      exitCode: EXIT_CODE_HALTED,
      reasonMatches: /merger-halted/,
    },
    {
      tag: "iteration-ceiling",
      exit: iterationCeilingExit(100),
      exitCode: EXIT_CODE_SUCCESS,
      reasonMatches: /100 cycles/,
    },
  ];

  for (const row of TABLE) {
    it(`${row.tag}: formats one line, with its own tag and code`, () => {
      expect(row.exit.tag).toBe(row.tag);
      expect(row.exit.exitCode).toBe(row.exitCode);
      expect(row.exit.reason).toMatch(row.reasonMatches);
      const line = formatExitLine(row.exit);
      expect(line).toBe(`Exit (${row.tag}): ${row.exit.reason}`);
      // One line. A reason that wrapped would break `grep "^Exit ("`, which is
      // the whole promise being made to an operator here.
      expect(line.includes("\n")).toBe(false);
      expect(row.exit.reason.trim()).not.toBe("");
    });
  }

  it("covers every tag in the union — no terminal path without a line", () => {
    expect(new Set(TABLE.map((r) => r.tag))).toEqual(new Set(EXIT_TAGS));
    expect(TABLE.length).toBe(EXIT_TAGS.length);
  });

  it("halted names every cause, not just the first", () => {
    // The two post-merge reports share a cause — a `gh` having a bad minute —
    // so they fire together more often than chance, and the run log's one
    // handle on why the run stopped must not hide one behind the other.
    const line = formatExitLine(
      haltedExit(["chunk-wrapup-incomplete", "merger-close-failed"]),
    );
    expect(line).toContain("chunk-wrapup-incomplete");
    expect(line).toContain("merger-close-failed");
  });

  it("halted still says something with no cause at all", () => {
    expect(formatExitLine(haltedExit([]))).toMatch(/^Exit \(halted\): \S/);
  });

  it("applyCycle's decisions are the same values the constructors build", () => {
    // The decision the orchestrator prints and the constructor a test pins must
    // not drift: applyCycle spreads these, it does not re-spell them.
    const s = newRunState({ maxTotalIssues: 2, relaunchAfterLanding: true });
    const d = applyCycle(s, {
      planFingerprint: "10,42",
      planSize: 2,
      doneCount: 2,
      landedMerges: 2,
    });
    expect(d).toEqual({ kind: "exit", ...relaunchExit(2) });
  });

  it("the pre-cycle budget stop and applyCycle's agree word for word", () => {
    // Two call sites, one reason. They used to be hand-written copies printed
    // in different words at different moments (#70).
    const s = newRunState({ maxTotalIssues: 2 });
    const d = applyCycle(s, {
      planFingerprint: "10,42",
      planSize: 2,
      doneCount: 1,
      landedMerges: 0,
    });
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.reason).toBe(budgetExit(2, 2).reason);
  });
});
