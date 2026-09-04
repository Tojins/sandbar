import { describe, expect, it } from "vitest";

import { parseUiCheck } from "./ui-check-parser.js";

describe("parseUiCheck", () => {
  it("accepts CLEAR", () => {
    expect(parseUiCheck("done\n<ui-check>CLEAR</ui-check>")).toEqual({
      kind: "CLEAR",
    });
  });

  it("accepts PROTOTYPE-NEEDED only with an impact block", () => {
    expect(
      parseUiCheck(
        "<ui-check>PROTOTYPE-NEEDED</ui-check>\n" +
          "<ui-impact>A new wizard; its steps and empty state need a design.</ui-impact>",
      ),
    ).toEqual({
      kind: "PROTOTYPE-NEEDED",
      uiImpact: "A new wizard; its steps and empty state need a design.",
    });
    expect(parseUiCheck("<ui-check>PROTOTYPE-NEEDED</ui-check>")).toMatchObject({
      kind: "NO-SIGNAL",
      reprompt: expect.stringContaining("no `<ui-impact>` block"),
    });
  });

  it("uses the last well-formed token and cannot swallow a block with a quoted opener", () => {
    expect(
      parseUiCheck(
        "The literal `<ui-check>` is quoted without a closer.\n" +
          "<ui-check>PROTOTYPE-NEEDED</ui-check>\n" +
          "draft <ui-impact>ignored opener\n" +
          "<ui-impact>final assessment</ui-impact>",
      ),
    ).toEqual({ kind: "PROTOTYPE-NEEDED", uiImpact: "final assessment" });
    expect(
      parseUiCheck(
        "<ui-check>PROTOTYPE-NEEDED</ui-check>\n" +
          "<ui-check>CLEAR</ui-check>",
      ),
    ).toEqual({ kind: "CLEAR" });
  });

  it("rejects unknown and malformed tokens", () => {
    expect(parseUiCheck("<ui-check>MAYBE</ui-check>")).toMatchObject({
      kind: "NO-SIGNAL",
    });
    expect(parseUiCheck("<ui-check>clear</ui-check>")).toMatchObject({
      kind: "NO-SIGNAL",
    });
  });
});
