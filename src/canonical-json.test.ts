import { describe, expect, it } from "vitest";

import { canonicalSha256 } from "./canonical-json.js";

describe("canonicalSha256", () => {
  it("is the same for reordered keys at any depth, and differs for reordered arrays", () => {
    expect(canonicalSha256({ a: 1, b: { c: 2, d: 3 } }))
      .toBe(canonicalSha256({ b: { d: 3, c: 2 }, a: 1 }));
    expect(canonicalSha256([1, 2])).not.toBe(canonicalSha256([2, 1]));
  });

  it("hashes an undefined member as an absent one", () => {
    expect(canonicalSha256({ a: 1, b: undefined })).toBe(canonicalSha256({ a: 1 }));
  });

  it("refuses a value JSON cannot carry", () => {
    expect(() => canonicalSha256({ a: () => 1 })).toThrow(TypeError);
    expect(() => canonicalSha256({ a: 1n })).toThrow(TypeError);
  });
});
