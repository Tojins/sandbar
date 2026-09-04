// UI-check token parser (#126).
//
// This role makes one decision before the implementation-attempt budget begins:
// either the issue is clear to implement, or it implies non-trivial visible UI
// for which no readable prototype exists. Its token is deliberately distinct
// from the implementer's promise — the checker cannot complete work and must
// not inherit a role contract it does not own.
//
// Tokens use token-scan.ts's literal, last-well-formed-token-wins rule (#113).
// The free-text impact block uses its tempered scan, so a quoted opener cannot
// swallow the real block that follows it.

import { lastToken, literalTokenPattern, temperedBlockPattern } from "./token-scan.js";

export const UI_CHECK_TOKENS = {
  PROTOTYPE_NEEDED: "PROTOTYPE-NEEDED",
  CLEAR: "CLEAR",
} as const;

export type UiCheckResult =
  | { readonly kind: "CLEAR" }
  | { readonly kind: "PROTOTYPE-NEEDED"; readonly uiImpact: string };

export type UiCheckParseResult =
  | UiCheckResult
  | { readonly kind: "NO-SIGNAL"; readonly reprompt: string };

const UI_CHECK_TOKEN_ALL = literalTokenPattern(
  "ui-check",
  Object.values(UI_CHECK_TOKENS),
);

const UI_CHECK_NO_TOKEN =
  "Your response did not contain a well-formed UI-check token. End with exactly " +
  "`<ui-check>CLEAR</ui-check>` if implementation can proceed, or " +
  "`<ui-check>PROTOTYPE-NEEDED</ui-check>` followed by a `<ui-impact>` block " +
  "if a prototype is required.";

const UI_CHECK_NO_IMPACT =
  "You declared `<ui-check>PROTOTYPE-NEEDED</ui-check>` but provided no " +
  "`<ui-impact>` block. Include what visible UI the issue would create or " +
  "alter, which design decisions implementation would invent, and what " +
  "artifact would unblock it.";

export function parseUiCheck(stdout: string): UiCheckParseResult {
  const token = lastToken(stdout, UI_CHECK_TOKEN_ALL);
  if (token === null) {
    return { kind: "NO-SIGNAL", reprompt: UI_CHECK_NO_TOKEN };
  }
  if (token === UI_CHECK_TOKENS.CLEAR) return { kind: "CLEAR" };
  if (token === UI_CHECK_TOKENS.PROTOTYPE_NEEDED) {
    const uiImpact = lastToken(stdout, temperedBlockPattern("ui-impact")) ?? "";
    if (!uiImpact) return { kind: "NO-SIGNAL", reprompt: UI_CHECK_NO_IMPACT };
    return { kind: "PROTOTYPE-NEEDED", uiImpact };
  }
  throw new Error(
    `parseUiCheck: literal scan yielded a token it does not own: "${token}"`,
  );
}
