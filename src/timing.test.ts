import { describe, expect, it } from "vitest";

import { durationField, startTimer } from "./timing.js";

describe("startTimer", () => {
  it("reports elapsed time on the injected clock", () => {
    let now = 1000;
    const elapsed = startTimer(() => now);
    expect(elapsed()).toBe(0);
    now = 1250;
    expect(elapsed()).toBe(250);
    // Callable more than once, and still measuring from the START rather than
    // from the previous read.
    now = 1400;
    expect(elapsed()).toBe(400);
  });

  it("rounds to whole milliseconds", () => {
    let now = 0;
    const elapsed = startTimer(() => now);
    now = 12.4;
    expect(elapsed()).toBe(12);
    now = 12.6;
    expect(elapsed()).toBe(13);
  });

  it("defaults to a monotonic clock, so an interval is never negative", () => {
    const elapsed = startTimer();
    expect(elapsed()).toBeGreaterThanOrEqual(0);
  });
});

describe("durationField", () => {
  it("is the one spelling of the field", () => {
    expect(durationField(0)).toBe("durationMs=0");
    expect(durationField(97210)).toBe("durationMs=97210");
  });
});
