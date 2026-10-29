import { describe, expect, it } from "vitest";

import {
  parseAdjudicationRuling,
  parseUnitRulings,
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

describe("per-unit rulings (#239)", () => {
  it("reads one literal ruling per unit, by its lower-cased id, the last well-formed one winning", () => {
    expect(parseUnitRulings(
      "<ruling-white-box>UPHELD</ruling-white-box>\n<ruling-s2>UPHELD</ruling-s2>\n" +
        "on reflection\n<ruling-s2> OVERRULED </ruling-s2>\n<ruling-s10>overruled</ruling-s10>" +
        "<ruling-s10>UPHELD</ruling-s10>",
      ["white-box", "S2", "S10"],
    )).toEqual({ "white-box": "UPHELD", S2: "OVERRULED", S10: "UPHELD" });
  });

  it("has no rulings when any unit's token is missing or malformed", () => {
    expect(parseUnitRulings("<ruling-s2>UPHELD</ruling-s2>", ["S2", "S3"])).toBeNull();
    expect(parseUnitRulings("<ruling-s2>maybe</ruling-s2>", ["S2"])).toBeNull();
    expect(parseUnitRulings("<ruling>OVERRULED</ruling>", ["S2"])).toBeNull();
  });

  it("does not read a unit token as the whole-report ruling", () => {
    expect(parseAdjudicationRuling("<ruling-s2>UPHELD</ruling-s2>")).toBeNull();
  });

  it("strips every unit token with the whole-report one", () => {
    expect(stripAdjudicationRulingTokens(
      "why\n<ruling-white-box>UPHELD</ruling-white-box>\n<ruling-s2>OVERRULED</ruling-s2>\n" +
        "<ruling-s2>UPHELD</ruling-s3>",
    )).toBe("why\n\n\n<ruling-s2>UPHELD</ruling-s3>");
  });
});
