import { describe, expect, it } from "vitest";

import { parseVerdict } from "./verdict-parser.js";

describe("parseVerdict", () => {
  it("returns APPROVED when a single APPROVED token is present", () => {
    const r = parseVerdict("looks good.\n<verdict>APPROVED</verdict>");
    expect(r.verdict).toBe("APPROVED");
    expect(r.prose).toBe("looks good.\n<verdict>APPROVED</verdict>");
  });

  it("returns CHANGES-REQUESTED when the token is present", () => {
    const r = parseVerdict(
      "needs work:\n- foo\n<verdict>CHANGES-REQUESTED</verdict>",
    );
    expect(r.verdict).toBe("CHANGES-REQUESTED");
  });

  it("defaults to CHANGES-REQUESTED when no verdict tag is present", () => {
    const r = parseVerdict("I think this is fine actually");
    expect(r.verdict).toBe("CHANGES-REQUESTED");
    expect(r.prose).toBe("I think this is fine actually");
  });

  it("defaults to CHANGES-REQUESTED on unknown token", () => {
    const r = parseVerdict("<verdict>MAYBE</verdict>");
    expect(r.verdict).toBe("CHANGES-REQUESTED");
  });

  it("defaults to CHANGES-REQUESTED on empty/whitespace token", () => {
    const r = parseVerdict("<verdict>   </verdict>");
    expect(r.verdict).toBe("CHANGES-REQUESTED");
  });

  it("treats whitespace-padded APPROVED identically", () => {
    expect(parseVerdict("<verdict>  APPROVED  </verdict>").verdict).toBe(
      "APPROVED",
    );
  });

  it("last verdict wins when multiple are emitted", () => {
    const r = parseVerdict(
      "<verdict>CHANGES-REQUESTED</verdict>\non reflection:\n<verdict>APPROVED</verdict>",
    );
    expect(r.verdict).toBe("APPROVED");
  });

  it("last-wins also overrides APPROVED with later CHANGES-REQUESTED", () => {
    const r = parseVerdict(
      "<verdict>APPROVED</verdict>\nwait actually:\n<verdict>CHANGES-REQUESTED</verdict>",
    );
    expect(r.verdict).toBe("CHANGES-REQUESTED");
  });

  it("accepts verdict tags interleaved with prose", () => {
    const r = parseVerdict(
      "## Findings\n- naming nit in foo.ts\n- missing test for bar\n\n<verdict>CHANGES-REQUESTED</verdict>\n\n(End of review.)",
    );
    expect(r.verdict).toBe("CHANGES-REQUESTED");
    expect(r.prose).toContain("naming nit");
    expect(r.prose).toContain("missing test");
  });

  it("rejects malformed: unclosed tag → defaults to CHANGES-REQUESTED", () => {
    const r = parseVerdict("<verdict>APPROVED");
    expect(r.verdict).toBe("CHANGES-REQUESTED");
  });

  it("rejects malformed: mismatched casing → defaults to CHANGES-REQUESTED", () => {
    const r = parseVerdict("<verdict>approved</verdict>");
    expect(r.verdict).toBe("CHANGES-REQUESTED");
  });

  it("preserves the prose unchanged for either verdict", () => {
    const stdout =
      "## Bar check\n\nStandards consulted: anti-overengineering.\n\n" +
      "Branch adds three abstractions where one direct function suffices.\n\n" +
      "<verdict>CHANGES-REQUESTED</verdict>";
    const r = parseVerdict(stdout);
    expect(r.prose).toBe(stdout);
  });
});
