// Reviewer verdict-token parser.
//
// The reviewer signals its decision with `<verdict>APPROVED</verdict>` or
// `<verdict>CHANGES-REQUESTED</verdict>`. The reviewer is strictly advisory —
// it never commits — so the verdict is the only signal that travels back to
// the inner loop alongside its free-form prose.
//
// Convergence relies on each pass having a sharp bar. The correctness prompt
// requires a located, concrete defect and otherwise APPROVES; the quality pass
// receives sandbar's built-in prompts/coding-standards.md plus any project
// standards file that extends it. That keeps either verdict deterministic.
//
// A token is one of those two literal strings and nothing else (#113). A
// `<verdict>` quoted in prose without a closer, a mis-cased or empty tag, a
// tag around a paragraph — none is a token, so none can stand in for one: a
// run carrying only those is absence, exactly like a run carrying nothing,
// and the reviewer harness retries it without spending a round (#41). The
// alternative the parser used to take — read whatever sits between the
// nearest `<verdict>` and the next `</verdict>` and call anything but APPROVED
// a rejection — fabricated a CHANGES-REQUESTED from an approving review that
// quoted the token's regex, and #88 parked on it. Last well-formed token wins
// when several are emitted, so a token quoted before the real one loses to it.
// `token-scan.ts` owns the scan and the argument.

import { lastToken, literalTokenPattern } from "./token-scan.js";

export type Verdict = "APPROVED" | "CHANGES-REQUESTED";

export type ParsedVerdict = {
  readonly verdict: Verdict;
  readonly prose: string;
};

export const VERDICT_TOKENS: readonly Verdict[] = ["APPROVED", "CHANGES-REQUESTED"];

const VERDICT_TOKEN_ALL = literalTokenPattern("verdict", VERDICT_TOKENS);

export function parseVerdict(stdout: string): ParsedVerdict | null {
  const token = lastToken(stdout, VERDICT_TOKEN_ALL);
  if (token === null) return null;
  return { verdict: token as Verdict, prose: stdout };
}

// The prose with every well-formed verdict token removed — what a later
// prompt may quote as the reviewer's findings without re-emitting its
// decision. Strips exactly what `parseVerdict` recognises: a quoted opener or
// a malformed tag is prose to both, so the strip and the parse cannot
// disagree about where the findings end.
export function stripVerdictTokens(prose: string): string {
  return prose.replace(VERDICT_TOKEN_ALL, "");
}
