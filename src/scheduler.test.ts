import { describe, expect, it } from "vitest";
import { admit, finishLanding, freeSlots, landingBatch, newPoolState, settle } from "./scheduler.js";

describe("continuous pool", () => {
  it("never exceeds its width and starts each issue once", () => {
    let s = admit(newPoolState(2), ["3", "1", "2"]);
    expect([...s.running]).toEqual(["3", "1"]);
    s = settle(s, "3", "terminal");
    s = admit(s, ["3", "2"]);
    expect([...s.running]).toEqual(["1", "2"]);
    expect([...s.started]).toEqual(["3", "1", "2"]);
    expect(freeSlots(s)).toBe(0);
  });

  it("rejections free slots without aborting the pool", () => {
    let s = admit(newPoolState(1), ["1"]);
    s = settle(s, "1", "rejected");
    expect(freeSlots(s)).toBe(1);
    expect(s.ongoing.size).toBe(0);
  });

  it("queues DONE without a slot and reports landing order deterministically", () => {
    let s = admit(newPoolState(3), ["10", "2", "7"]);
    s = settle(s, "10", "done");
    s = settle(s, "2", "done");
    expect(freeSlots(s)).toBe(2);
    expect(s.ongoing.size).toBe(3);
    expect(landingBatch(s)).toEqual(["2", "10"]);
    s = finishLanding(s, ["2", "10"]);
    expect([...s.ongoing]).toEqual(["7"]);
  });
});
