import { describe, expect, it } from "vitest";

import { parseVerdict, stripVerdictTokens } from "./verdict-parser.js";

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

  it("reports absence when no verdict tag is present", () => {
    expect(parseVerdict("I think this is fine actually")).toBeNull();
  });

  // A token is one of the two literal strings; anything else inside the tag is
  // prose, and prose without a token is absence — the harness-failure path
  // (#41), never a fabricated rejection (#113).
  it("reports an unknown token as absent", () => {
    expect(parseVerdict("<verdict>MAYBE</verdict>")).toBeNull();
  });

  it("reports an empty/whitespace token as absent", () => {
    expect(parseVerdict("<verdict>   </verdict>")).toBeNull();
  });

  it("reports a tag around a paragraph as absent", () => {
    expect(
      parseVerdict("<verdict>\nI approve, with one nit: APPROVED\n</verdict>"),
    ).toBeNull();
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

  it("answers consistently across repeated parses", () => {
    const stdout = "x<verdict>APPROVED</verdict>";
    parseVerdict(stdout);
    expect(parseVerdict(stdout)?.verdict).toBe("APPROVED");
  });

  it("accepts verdict tags interleaved with prose", () => {
    const r = parseVerdict(
      "## Findings\n- naming nit in foo.ts\n- missing test for bar\n\n<verdict>CHANGES-REQUESTED</verdict>\n\n(End of review.)",
    );
    expect(r.verdict).toBe("CHANGES-REQUESTED");
    expect(r.prose).toContain("naming nit");
    expect(r.prose).toContain("missing test");
  });

  it("reports an unclosed tag as absent", () => {
    expect(parseVerdict("<verdict>APPROVED")).toBeNull();
  });

  it("reports mismatched casing as absent", () => {
    expect(parseVerdict("<verdict>approved</verdict>")).toBeNull();
  });

  // #88 round 8: an approving review quoted the strip regex — an opener whose
  // closer is escaped — and the old non-greedy scan started the token there,
  // ended it at the real closer, and read the page between as a rejection.
  it("a quoted opener without a closer does not swallow the real token", () => {
    const stdout =
      "`reviewFindings`'s `/<verdict>[\\s\\S]*?<\\/verdict>/g` removes both " +
      "well-formed and malformed tokens.\n\nNo defect found.\n" +
      "<verdict>APPROVED</verdict>";
    expect(parseVerdict(stdout)?.verdict).toBe("APPROVED");
  });

  it("a bare quoted opener before the real token is prose", () => {
    expect(
      parseVerdict("the `<verdict>` tag opens it\n<verdict>APPROVED</verdict>")
        ?.verdict,
    ).toBe("APPROVED");
  });

  it("a well-formed token quoted before the real one loses to it", () => {
    expect(
      parseVerdict(
        "the prompt says emit <verdict>CHANGES-REQUESTED</verdict> on a defect.\n" +
          "<verdict>APPROVED</verdict>",
      )?.verdict,
    ).toBe("APPROVED");
  });

  it("a quoted closer alone is prose", () => {
    expect(
      parseVerdict("<verdict>APPROVED</verdict>\nthe `</verdict>` closer ends it")
        ?.verdict,
    ).toBe("APPROVED");
  });
});

describe("stripVerdictTokens", () => {
  // The strip and the parse share one global regex: `replace` must leave
  // `lastIndex` at 0 for the parse that follows, and vice versa.
  it("strip then parse, and parse then strip, see the same tokens", () => {
    const stdout = "fine.\n<verdict>APPROVED</verdict>";
    expect(stripVerdictTokens(stdout)).toBe("fine.\n");
    expect(parseVerdict(stdout)?.verdict).toBe("APPROVED");
    expect(stripVerdictTokens(stdout)).toBe("fine.\n");
  });

  it("removes every well-formed token and nothing else", () => {
    expect(
      stripVerdictTokens(
        "Quoted: <verdict>APPROVED</verdict>.\n" +
          "Malformed: <verdict>changes requested</verdict>.\n" +
          "<verdict> CHANGES-REQUESTED </verdict>",
      ),
    ).toBe("Quoted: .\nMalformed: <verdict>changes requested</verdict>.\n");
  });

  it("keeps the prose between a quoted opener and the real token", () => {
    const stdout =
      "the `/<verdict>[\\s\\S]*?<\\/verdict>/g` strip\nNo defect found.\n" +
      "<verdict>APPROVED</verdict>";
    expect(stripVerdictTokens(stdout)).toBe(
      "the `/<verdict>[\\s\\S]*?<\\/verdict>/g` strip\nNo defect found.\n",
    );
  });
});
