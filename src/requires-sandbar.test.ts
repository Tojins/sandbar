import { describe, expect, it } from "vitest";

import { SandbarError } from "./errors.js";
import {
  checkRequiresSandbar,
  compareVersions,
  parseVersion,
} from "./requires-sandbar.js";

describe("parseVersion (#66)", () => {
  it("accepts a plain X.Y.Z, whitespace included", () => {
    expect(parseVersion("0.21.0")).toEqual({ major: 0, minor: 21, patch: 0 });
    expect(parseVersion("  1.2.3\n")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("10.20.30")).toEqual({
      major: 10,
      minor: 20,
      patch: 30,
    });
  });

  it("rejects every spelling that is not exactly that", () => {
    for (const raw of [
      "v1.2.3",
      "1.2",
      "1.2.3.4",
      ">=1.2.3",
      "^1.2.3",
      "1.2.3-rc.1",
      "1.2.3+build",
      "unknown",
      "",
      "one.two.three",
    ]) {
      expect(parseVersion(raw), raw).toBeNull();
    }
  });
});

describe("compareVersions (#66)", () => {
  it("orders by major, then minor, then patch", () => {
    const v = (s: string) => parseVersion(s)!;
    expect(compareVersions(v("1.0.0"), v("0.99.99"))).toBeGreaterThan(0);
    expect(compareVersions(v("0.21.0"), v("0.9.99"))).toBeGreaterThan(0);
    expect(compareVersions(v("0.20.33"), v("0.20.34"))).toBeLessThan(0);
    expect(compareVersions(v("2.3.4"), v("2.3.4"))).toBe(0);
  });

  // The whole reason a string compare is not enough: "0.9.0" > "0.21.0"
  // lexically, and 0.9 is the older release.
  it("is numeric, not lexical", () => {
    expect(
      compareVersions(parseVersion("0.9.0")!, parseVersion("0.21.0")!),
    ).toBeLessThan(0);
  });
});

describe("checkRequiresSandbar (#66)", () => {
  it("is inert when the config declares no floor", () => {
    expect(() => checkRequiresSandbar(undefined, "0.1.0")).not.toThrow();
    expect(() => checkRequiresSandbar(undefined, "unknown")).not.toThrow();
  });

  it("passes an equal or newer driver", () => {
    expect(() => checkRequiresSandbar("0.21.0", "0.21.0")).not.toThrow();
    expect(() => checkRequiresSandbar("0.21.0", "0.21.1")).not.toThrow();
    expect(() => checkRequiresSandbar("0.21.0", "1.0.0")).not.toThrow();
  });

  it("refuses an older driver, naming both versions", () => {
    let err: unknown;
    try {
      checkRequiresSandbar("0.21.0", "0.20.33");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SandbarError);
    const message = (err as Error).message;
    expect(message).toContain("0.21.0");
    expect(message).toContain("0.20.33");
  });

  // The driver's version degrades to "unknown" when its package.json cannot be
  // read (version.ts). That is a fine answer for a reuse token and the wrong
  // one here: the check exists to PROVE a floor is met.
  it("refuses a driver that cannot name its own version", () => {
    expect(() => checkRequiresSandbar("0.21.0", "unknown")).toThrow(
      /cannot say which version it is/,
    );
  });

  it("rejects a floor that is not a plain X.Y.Z", () => {
    for (const raw of [">=0.21.0", "^0.21.0", "v0.21.0", "0.21", "latest"]) {
      expect(() => checkRequiresSandbar(raw, "9.9.9"), raw).toThrow(
        /plain X\.Y\.Z/,
      );
    }
  });

  it("rejects a non-string floor, since .mjs is type-checked by nothing", () => {
    expect(() =>
      checkRequiresSandbar(21 as unknown as string, "9.9.9"),
    ).toThrow(SandbarError);
  });
});
