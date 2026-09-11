import { describe, expect, it } from "vitest";
import {
  EXIT_CODE_HALTED,
  EXIT_CODE_QUOTA,
  EXIT_CODE_RESTART,
  EXIT_CODE_STUCK,
  EXIT_TAGS,
  credentialExit,
  haltedExit,
  quotaExit,
  restartExit,
  stuckExit,
} from "./exit-conditions.js";

describe("daemon-pool exits", () => {
  const table = [
    ["quota", quotaExit({ provider: "claude", window: "five_hour", resetsAt: 42 }), EXIT_CODE_QUOTA, /1970-01-01T00:00:42/],
    ["credential", credentialExit({ provider: "codex", detail: "refresh refused" }), EXIT_CODE_QUOTA, /Log in again on the host and restart/],
    ["stuck", stuckExit(6), EXIT_CODE_STUCK, /6 consecutive issue terminals/],
    ["halted", haltedExit(["merge", "tracker"]), EXIT_CODE_HALTED, /merge \+ tracker/],
    ["restart", restartExit("abc1234"), EXIT_CODE_RESTART, /deployment of abc1234/],
  ] as const;

  it.each(table)("%s has the stable code and reason", (tag, exit, code, reason) => {
    expect(exit).toMatchObject({ tag, exitCode: code });
    expect(exit.reason).toMatch(reason);
  });

  it("covers every exit tag", () => {
    expect(table.map((row) => row[0])).toEqual(EXIT_TAGS);
  });

  // The unit's `RestartForceExitStatus=` is the whole reason this number is
  // load-bearing: sharing it with a stop a human is meant to inspect would turn
  // that stop into a relaunch.
  it("keeps the restartable code out of every deliberate stop", () => {
    expect(EXIT_CODE_RESTART).not.toBe(EXIT_CODE_HALTED);
    expect(EXIT_CODE_RESTART).not.toBe(EXIT_CODE_STUCK);
    expect(EXIT_CODE_RESTART).not.toBe(EXIT_CODE_QUOTA);
  });

  it("reports an unknown quota reset and an unspecified halt", () => {
    expect(quotaExit({ provider: "codex", window: "seven_day" }).reason)
      .toContain("unknown time");
    expect(haltedExit([]).reason).toContain("unspecified");
  });
});
