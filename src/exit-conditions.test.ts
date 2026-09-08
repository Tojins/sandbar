import { describe, expect, it } from "vitest";
import {
  EXIT_CODE_HALTED, EXIT_CODE_QUOTA, EXIT_CODE_STUCK, EXIT_TAGS,
  formatExitLine, haltedExit, quotaExit, stuckExit,
} from "./exit-conditions.js";

describe("continuous-pool exits", () => {
  const table = [
    ["quota", quotaExit({ provider: "claude", window: "five_hour", resetsAt: 42 }), EXIT_CODE_QUOTA, /1970-01-01T00:00:42/],
    ["stuck", stuckExit(6), EXIT_CODE_STUCK, /6 consecutive issue terminals/],
    ["halted", haltedExit(["merge", "tracker"]), EXIT_CODE_HALTED, /merge \+ tracker/],
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

});
