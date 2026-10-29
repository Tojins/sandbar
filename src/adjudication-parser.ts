// Adjudicator ruling-token parser (#167, #239).
//
// The adjudicator resolves one rejected review report against the immutable
// head it judged. Its free-form reasoning remains in the invocation record;
// only the literal final ruling enters orchestration. As with every other
// agent signal, token-scan.ts owns last-well-formed-token-wins semantics so a
// quoted or malformed tag cannot become a ruling.
//
// A verifier report with scenario units is ruled unit by unit (#239): one
// `<ruling-<unit>>` token per unit, the unit id lower-cased
// (`<ruling-white-box>`, `<ruling-s2>`). A report missing any unit's token has
// no ruling at all, and one with them all is UPHELD when any unit is.

import { lastToken, literalTokenPattern } from "./token-scan.js";

export type AdjudicationRuling = "UPHELD" | "OVERRULED";

export const ADJUDICATION_RULINGS: readonly AdjudicationRuling[] = [
  "UPHELD",
  "OVERRULED",
];

const RULING_TOKEN_ALL = literalTokenPattern(
  "ruling",
  ADJUDICATION_RULINGS,
);

// The whole-report token and every unit's.
const ANY_RULING_TOKEN = new RegExp(
  `<(ruling(?:-[a-z0-9-]+)?)>\\s*(?:${ADJUDICATION_RULINGS.join("|")})\\s*</\\1>`,
  "g",
);

export function parseAdjudicationRuling(
  stdout: string,
): AdjudicationRuling | null {
  return lastToken(stdout, RULING_TOKEN_ALL) as AdjudicationRuling | null;
}

export const unitRulingTag = (unitId: string): string => `ruling-${unitId.toLowerCase()}`;

// Each unit's ruling, or null when any unit has none.
export function parseUnitRulings(
  stdout: string,
  unitIds: readonly string[],
): Readonly<Record<string, AdjudicationRuling>> | null {
  const rulings: Record<string, AdjudicationRuling> = {};
  for (const id of unitIds) {
    const ruling = lastToken(stdout, literalTokenPattern(unitRulingTag(id), ADJUDICATION_RULINGS));
    if (ruling === null) return null;
    rulings[id] = ruling as AdjudicationRuling;
  }
  return rulings;
}

// The ruling an adjudicator's output carries, with each unit's when `units`
// names the units ruled one by one; null when it carries none.
export function parseRulings(
  stdout: string,
  units: readonly string[] | null,
): {
  readonly ruling: AdjudicationRuling;
  readonly rulings: Readonly<Record<string, AdjudicationRuling>> | null;
} | null {
  if (units === null) {
    const ruling = parseAdjudicationRuling(stdout);
    return ruling === null ? null : { ruling, rulings: null };
  }
  const rulings = parseUnitRulings(stdout, units);
  if (rulings === null) return null;
  return { ruling: Object.values(rulings).includes("UPHELD") ? "UPHELD" : "OVERRULED", rulings };
}

export function stripAdjudicationRulingTokens(stdout: string): string {
  return stdout.replace(ANY_RULING_TOKEN, "");
}
