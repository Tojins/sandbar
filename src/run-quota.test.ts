import { describe, expect, it, vi } from "vitest";

import { AgentQuotaError } from "./agent-sandbox.js";
import { formatExitLine, relaunchExit } from "./exit-conditions.js";
import { selectCompletedCycleExit } from "./run.js";

describe("completed-cycle quota exit orchestration (#109)", () => {
  const measurement = {
    status: "rejected" as const,
    window: "five_hour",
    resetsAt: 1_788_422_400,
  };

  it("emits exit 4 for an issue quota and outranks relaunch after landed work", () => {
    const otherwise = vi.fn(() => relaunchExit(1));
    const exit = selectCompletedCycleExit({
      mergerQuota: null,
      haltReasons: [],
      terminals: [{ type: "QUOTA", provider: "claude", ...measurement }],
      otherwise,
    });

    expect(exit).toMatchObject({ tag: "quota", exitCode: 4 });
    expect(formatExitLine(exit!)).toMatch(
      /^Exit \(quota\): claude five_hour quota window closed;/,
    );
    expect(otherwise).not.toHaveBeenCalled();
  });

  it("emits exit 4 for merger quota instead of the merger halt", () => {
    const exit = selectCompletedCycleExit({
      mergerQuota: new AgentQuotaError("codex", {
        ...measurement,
        window: "seven_day",
      }),
      haltReasons: ["merger-halted"],
      terminals: [],
      otherwise: () => relaunchExit(1),
    });

    expect(exit).toMatchObject({ tag: "quota", exitCode: 4 });
    expect(formatExitLine(exit!)).toMatch(
      /^Exit \(quota\): codex seven_day quota window closed;/,
    );
  });
});
