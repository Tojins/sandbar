import { describe, expect, it } from "vitest";

import { parsePartitionCheck } from "./partition-check-parser.js";

describe("parsePartitionCheck", () => {
  it("accepts CLEAR", () => {
    expect(parsePartitionCheck("<partition-check>CLEAR</partition-check>"))
      .toEqual({ kind: "CLEAR" });
  });

  it("requires a reason for PARTITION", () => {
    expect(parsePartitionCheck(
      "<partition-check>PARTITION</partition-check>\n" +
      "<partition-reason>API and UI can land independently.</partition-reason>",
    )).toEqual({
      kind: "PARTITION",
      reason: "API and UI can land independently.",
    });
    expect(parsePartitionCheck("<partition-check>PARTITION</partition-check>"))
      .toMatchObject({ kind: "NO-SIGNAL" });
  });

  it("rejects malformed tokens and uses the last well-formed token", () => {
    expect(parsePartitionCheck("<partition-check>MAYBE</partition-check>"))
      .toMatchObject({ kind: "NO-SIGNAL" });
    expect(parsePartitionCheck(
      "<partition-check>PARTITION</partition-check>\n" +
      "<partition-reason>old</partition-reason>\n" +
      "<partition-check>CLEAR</partition-check>",
    )).toEqual({ kind: "CLEAR" });
  });
});
