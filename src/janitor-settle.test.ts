// #205 — a janitor run as the daemon holds it: a failure is recorded and the
// daemon carries on, a lease lost to cleanup is cleanup's, and the slot is
// freed either way.
import { describe, expect, it } from "vitest";

import type { EventInput } from "./events.js";
import { settleJanitorRun } from "./janitor.js";
import { OriginLeaseLostDuringCleanupError } from "./origin-lock.js";

describe("settleJanitorRun (#205)", () => {
  const settle = (run: () => Promise<unknown>) => {
    const events: EventInput[] = [];
    let ended = 0;
    const settled = settleJanitorRun({
      task: "tidy",
      run,
      emit: async (event) => {
        events.push(event);
      },
      durationMs: () => 7,
      onEnd: () => {
        ended += 1;
      },
    });
    return { settled, events, ended: () => ended };
  };

  it("records a run that throws as a complaint and a failed run, settles, and frees the slot", async () => {
    const { settled, events, ended } = settle(async () => {
      throw new Error("boom");
    });
    // A rejection here would reach cleanup's unhandled-rejection trap and stop
    // the daemon, every issue in flight with it.
    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([
      { kind: "complaint", severity: "error", message: expect.stringContaining("Janitor task 'tidy' failed: ") },
      {
        kind: "janitor-run", task: "tidy", branch: "sandbar/janitor-tidy",
        outcome: "failed", scope: [], durationMs: 7,
      },
    ]);
    expect(events[0]).toMatchObject({ message: expect.stringContaining("boom") });
    expect(ended()).toBe(1);
  });

  it("leaves a lease lost to cleanup unrecorded, and frees the slot", async () => {
    const { settled, events, ended } = settle(async () => {
      throw new OriginLeaseLostDuringCleanupError("lost");
    });
    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([]);
    expect(ended()).toBe(1);
  });

  it("records nothing for a run that returns, and frees the slot", async () => {
    const { settled, events, ended } = settle(async () => "committed");
    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([]);
    expect(ended()).toBe(1);
  });
});
