import { describe, expect, it } from "vitest";
import {
  EXIT_CODE_BUDGET, EXIT_CODE_HALTED, EXIT_CODE_QUOTA, EXIT_CODE_RELAUNCH,
  EXIT_CODE_STUCK, EXIT_CODE_SUCCESS, EXIT_TAGS, budgetExit, formatExitLine,
  haltedExit, iterationCeilingExit, newRunState, planEmptyExit, quotaExit,
  relaunchExit, remainingBudget, stuckExit,
} from "./exit-conditions.js";

describe("continuous-pool exits", () => {
  const table = [
    ["plan-empty", planEmptyExit(), EXIT_CODE_SUCCESS, /no unblocked issues/],
    ["quota", quotaExit({ provider: "claude", window: "five_hour", resetsAt: 42 }), EXIT_CODE_QUOTA, /1970-01-01T00:00:42/],
    ["relaunch", relaunchExit(2), EXIT_CODE_RELAUNCH, /2 landing\(s\)/],
    ["stuck", stuckExit(6), EXIT_CODE_STUCK, /6 consecutive issue terminals/],
    ["budget", budgetExit(50, 50), EXIT_CODE_BUDGET, /issuesStarted=50/],
    ["halted", haltedExit(["merge", "tracker"]), EXIT_CODE_HALTED, /merge \+ tracker/],
    ["iteration-ceiling", iterationCeilingExit(100), EXIT_CODE_SUCCESS, /100 recomputes/],
  ] as const;

  it.each(table)("%s has the stable code, reason, and one-line format", (tag, exit, code, reason) => {
    expect(exit).toMatchObject({ tag, exitCode: code });
    expect(exit.reason).toMatch(reason);
    expect(formatExitLine(exit)).toBe(`Exit (${tag}): ${exit.reason}`);
    expect(formatExitLine(exit)).not.toContain("\n");
  });

  it("covers every exit tag", () => {
    expect(table.map((row) => row[0])).toEqual(EXIT_TAGS);
  });

  it("reports an unknown quota reset and an unspecified halt", () => {
    expect(quotaExit({ provider: "codex", window: "seven_day" }).reason)
      .toContain("unknown time");
    expect(haltedExit([]).reason).toContain("unspecified");
  });

  it("relaunch names what the next run re-resolves and claims nothing about the driver", () => {
    const exit = relaunchExit(1);
    expect(exit.reason).toContain("config file");
    expect(exit.reason).toContain("launcher's to decide");
    expect(exit.reason).not.toMatch(/driver is/);
  });

  it("EXIT_CODE_RELAUNCH collides with none of the codes that must break the launcher's loop", () => {
    const loopBreakers = [
      EXIT_CODE_SUCCESS, EXIT_CODE_HALTED, EXIT_CODE_STUCK, EXIT_CODE_BUDGET, EXIT_CODE_QUOTA,
    ];
    expect(loopBreakers).not.toContain(EXIT_CODE_RELAUNCH);
    expect(new Set(loopBreakers).size).toBe(loopBreakers.length);
  });

  it("counts the start budget directly and clamps at zero", () => {
    const state = newRunState({ maxTotalIssues: 2 });
    expect(remainingBudget(state)).toBe(2);
    state.issuesAttempted = 1;
    expect(remainingBudget(state)).toBe(1);
    state.issuesAttempted = 4;
    expect(remainingBudget(state)).toBe(0);
  });
});
