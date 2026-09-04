import { describe, expect, it } from "vitest";
import { EXIT_TAGS, budgetExit, formatExitLine, haltedExit, iterationCeilingExit, newRunState, planEmptyExit, quotaExit, relaunchExit, remainingBudget, stuckExit } from "./exit-conditions.js";
describe("continuous-pool exits", () => {
  it("has one formatted line for every exit", () => {
    const exits = [planEmptyExit(), quotaExit({ provider: "claude", window: "five_hour" }), relaunchExit(2), stuckExit(6), budgetExit(50, 50), haltedExit(["merge"]), iterationCeilingExit(100)];
    expect(exits.map((exit) => exit.tag)).toEqual(EXIT_TAGS);
    for (const exit of exits) expect(formatExitLine(exit)).toBe(`Exit (${exit.tag}): ${exit.reason}`);
  });
  it("counts start budget directly", () => {
    const state = newRunState({ maxTotalIssues: 2 });
    expect(remainingBudget(state)).toBe(2);
    state.issuesAttempted += 1;
    expect(remainingBudget(state)).toBe(1);
  });
});
