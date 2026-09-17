// Adjudicator ruling-token parser (#167).
//
// The adjudicator resolves one rejected review report against the immutable
// head it judged. Its free-form reasoning remains in the invocation record;
// only the literal final ruling enters orchestration. As with every other
// agent signal, token-scan.ts owns last-well-formed-token-wins semantics so a
// quoted or malformed tag cannot become a ruling.

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

export function parseAdjudicationRuling(
  stdout: string,
): AdjudicationRuling | null {
  return lastToken(stdout, RULING_TOKEN_ALL) as AdjudicationRuling | null;
}

export function stripAdjudicationRulingTokens(stdout: string): string {
  return stdout.replace(RULING_TOKEN_ALL, "");
}
