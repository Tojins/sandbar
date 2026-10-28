import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLandingWindow } from "./config.js";
import { landingClosedUntil, waitsForLandingWindow } from "./landing-window.js";

const outdoor = resolveLandingWindow({
  timeZone: "Europe/Brussels",
  closedFrom: "Fri 12:00",
  closedUntil: "Mon 08:00",
});

describe("landingClosedUntil (#244)", () => {
  it("is always open with no window configured", () => {
    expect(landingClosedUntil(null, new Date("2026-10-31T12:00:00Z"))).toBeNull();
  });

  it.each([
    // Brussels is UTC+2 until 25 Oct 2026, UTC+1 after.
    ["Fri 11:59 local", "2026-10-30T10:59:00Z", null],
    ["Fri 12:00 local", "2026-10-30T11:00:00Z", "Mon 08:00 (Europe/Brussels)"],
    ["Sat noon", "2026-10-31T11:00:00Z", "Mon 08:00 (Europe/Brussels)"],
    ["Mon 07:59 local", "2026-11-02T06:59:00Z", "Mon 08:00 (Europe/Brussels)"],
    ["Mon 08:00 local", "2026-11-02T07:00:00Z", null],
    ["Wed noon", "2026-11-04T11:00:00Z", null],
  ])("a span wrapping the week: %s", (_, at, expected) => {
    expect(landingClosedUntil(outdoor, new Date(at))).toBe(expected);
  });

  it("reads the wall clock in the configured zone across a DST change", () => {
    // Friday 23 Oct is UTC+2: 10:30Z is 12:30 local, so closed — the same
    // UTC instant a week later (UTC+1) is 11:30 local, still open.
    expect(landingClosedUntil(outdoor, new Date("2026-10-23T10:30:00Z"))).not.toBeNull();
    expect(landingClosedUntil(outdoor, new Date("2026-10-30T10:30:00Z"))).toBeNull();
  });

  it("handles a span inside one week", () => {
    const nightly = resolveLandingWindow({
      timeZone: "UTC",
      closedFrom: "Tue 01:00",
      closedUntil: "Tue 05:30",
    });
    expect(landingClosedUntil(nightly, new Date("2026-11-03T00:59:00Z"))).toBeNull();
    expect(landingClosedUntil(nightly, new Date("2026-11-03T03:00:00Z")))
      .toBe("Tue 05:30 (UTC)");
    expect(landingClosedUntil(nightly, new Date("2026-11-03T05:30:00Z"))).toBeNull();
  });
});

describe("resolveLandingWindow (#244)", () => {
  it("is null when unset", () => {
    expect(resolveLandingWindow(undefined)).toBeNull();
  });

  it("resolves each end to minutes since Monday 00:00", () => {
    expect(outdoor).toEqual({
      timeZone: "Europe/Brussels",
      closedFrom: { text: "Fri 12:00", minuteOfWeek: 4 * 1440 + 720 },
      closedUntil: { text: "Mon 08:00", minuteOfWeek: 480 },
    });
  });

  it.each([
    [{ timeZone: "Europe/Bruxelles", closedFrom: "Fri 12:00", closedUntil: "Mon 08:00" }, /timeZone must be an IANA/],
    [{ timeZone: "UTC", closedFrom: "Friday 12:00", closedUntil: "Mon 08:00" }, /closedFrom must be a weekday/],
    [{ timeZone: "UTC", closedFrom: "Fri 12:00", closedUntil: "Mon 24:00" }, /closedUntil must be a weekday/],
    [{ timeZone: "UTC", closedFrom: "Fri 12:00", closedUntil: "Fri 12:00" }, /must differ/],
    ["Fri 12:00", /must be \{ timeZone, closedFrom, closedUntil \}/],
  ])("refuses %j", (window, message) => {
    expect(() => resolveLandingWindow(window as never)).toThrow(message);
  });
});

describe("waitsForLandingWindow (#244)", () => {
  it("holds every request but a hotfix", () => {
    expect(waitsForLandingWindow({ landLabels: ["land"] })).toBe(true);
    expect(waitsForLandingWindow({ landLabels: ["land-hotfix"] })).toBe(false);
    expect(waitsForLandingWindow({ landLabels: ["land", "land-hotfix"] })).toBe(false);
  });
});

describe("landingClosedUntil on an incomplete Intl answer (#244)", () => {
  afterEach(() => vi.restoreAllMocks());

  const stubParts = (parts: Intl.DateTimeFormatPart[]): void => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      function () {
        return { formatToParts: () => parts };
      } as unknown as typeof Intl.DateTimeFormat,
    );
  };
  const all: Intl.DateTimeFormatPart[] = [
    { type: "weekday", value: "Fri" },
    { type: "hour", value: "12" },
    { type: "minute", value: "00" },
  ];

  it.each(["weekday", "hour", "minute"])("throws without a %s part", (type) => {
    stubParts(all.filter((p) => p.type !== type));
    expect(() => landingClosedUntil(outdoor, new Date(0))).toThrow(`no ${type}`);
  });

  it("throws on a weekday it does not know", () => {
    stubParts(all.map((p) => (p.type === "weekday" ? { ...p, value: "Fre" } : p)));
    expect(() => landingClosedUntil(outdoor, new Date(0))).toThrow("unknown weekday");
  });
});
