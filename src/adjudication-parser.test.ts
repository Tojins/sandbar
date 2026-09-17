import { describe, expect, it } from "vitest";

import {
  parseAdjudicationRuling,
  stripAdjudicationRulingTokens,
} from "./adjudication-parser.js";

describe("adjudication ruling parser (#167)", () => {
  it("accepts only literal rulings and lets the last well-formed token win", () => {
    expect(parseAdjudicationRuling(
      "<ruling>UPHELD</ruling>\nreconsidered\n<ruling> OVERRULED </ruling>",
    )).toBe("OVERRULED");
    expect(parseAdjudicationRuling("<ruling>overruled</ruling>")).toBeNull();
    expect(parseAdjudicationRuling("<ruling>maybe</ruling>")).toBeNull();
  });

  it("removes exactly the tokens the parser recognizes", () => {
    expect(stripAdjudicationRulingTokens(
      "evidence\n<ruling>UPHELD</ruling>\n<ruling>maybe</ruling>",
    )).toBe("evidence\n\n<ruling>maybe</ruling>");
  });
});
