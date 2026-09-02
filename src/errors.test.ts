import { describe, expect, it } from "vitest";

import { hasExitCode, isErrno, isExitCode, isExitStatus } from "./errors.js";

describe("error condition predicates", () => {
  it("recognizes the child-process and errno shapes", () => {
    expect(isExitCode({ code: 128 }, 128)).toBe(true);
    expect(hasExitCode({ code: 1 })).toBe(true);
    expect(isErrno({ code: "ENOENT" }, "ENOENT")).toBe(true);
    expect(isExitStatus({ status: 1 }, 1)).toBe(true);
  });

  it("rejects primitives and mismatched property types without throwing", () => {
    for (const err of [null, undefined, "failure", 128, { code: "128" }]) {
      expect(isExitCode(err, 128)).toBe(false);
      expect(hasExitCode(err)).toBe(false);
    }
  });
});
