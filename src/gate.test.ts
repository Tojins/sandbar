import { describe, expect, it } from "vitest";

import { lastNLines, stripAnsi } from "./gate.js";

describe("stripAnsi", () => {
  it("removes SGR colour codes, leaving the text intact", () => {
    // The shape vitest emits — exactly what leaked into issue #396's comment.
    const colored = "\x1b[31m\x1b[1m FAIL \x1b[22m\x1b[49m queries.test.ts";
    expect(stripAnsi(colored)).toBe(" FAIL  queries.test.ts");
  });

  it("strips cursor/erase CSI sequences too, not just colours", () => {
    expect(stripAnsi("a\x1b[2Kb\x1b[1;5Hc")).toBe("abc");
  });

  it("is a no-op on text with no escapes", () => {
    expect(stripAnsi("plain line\nsecond line")).toBe("plain line\nsecond line");
  });

  it("leaves a literal caret-bracket (already-mangled) string alone", () => {
    // We strip real ESC bytes, not the printable mojibake; the fix is at the
    // source so the mojibake never gets produced in the first place.
    expect(stripAnsi("^[[90m209|")).toBe("^[[90m209|");
  });
});

describe("lastNLines", () => {
  it("keeps the trailing n lines", () => {
    expect(lastNLines("a\nb\nc\nd", 2)).toBe("c\nd");
  });
});
