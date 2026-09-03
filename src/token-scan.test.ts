import { describe, expect, it } from "vitest";

import { lastToken, literalTokenPattern, temperedBlockPattern } from "./token-scan.js";

describe("literalTokenPattern", () => {
  const p = literalTokenPattern("t", ["A", "B-C"]);

  it.each([
    ["<t>A</t>", "A"],
    ["<t>  B-C\n</t>", "B-C"],
    ["<t>A</t> then <t>B-C</t>", "B-C"],
    ["quoted `<t>` opener\n<t>A</t>", "A"],
    ["`/<t>([\\s\\S]*?)<\\/t>/g`\n<t>A</t>", "A"],
    ["<t>a</t>", null],
    ["<t></t>", null],
    ["<t>A B-C</t>", null],
    ["<t>A", null],
    ["nothing", null],
  ])("%j → %j", (stdout, want) => {
    expect(lastToken(stdout, p)).toBe(want);
  });

  it("escapes regex metacharacters in tokens", () => {
    expect(lastToken("<t>A.B</t>", literalTokenPattern("t", ["A.B"]))).toBe("A.B");
    expect(lastToken("<t>AxB</t>", literalTokenPattern("t", ["A.B"]))).toBeNull();
  });

  it("does not leak lastIndex across parses", () => {
    expect(lastToken("<t>A</t>", p)).toBe("A");
    expect(lastToken("<t>A</t>", p)).toBe("A");
  });
});

describe("temperedBlockPattern", () => {
  const p = temperedBlockPattern("q");

  it.each([
    ["<q>\nfree text\n</q>", "free text"],
    ["<q>one</q><q>two</q>", "two"],
    ["a `<q>` opener\n<q>real</q>", "real"],
    ["<q>real</q> then `</q>` closer", "real"],
    ["<q>unclosed", null],
  ])("%j → %j", (stdout, want) => {
    expect(lastToken(stdout, p)).toBe(want);
  });
});
