// Reviewer verdict-token parser.
//
// The reviewer signals its decision with `<verdict>APPROVED</verdict>` or
// `<verdict>CHANGES-REQUESTED</verdict>`. The reviewer is strictly advisory —
// it never commits — so the verdict is the only signal that travels back to
// the inner loop alongside its free-form prose.
//
// Convergence relies on each pass having a sharp bar. The correctness prompt
// requires a located, concrete defect and otherwise APPROVES; the follow-up
// receives sandbar's built-in prompts/coding-standards.md plus any project
// standards file that extends it. That keeps either verdict deterministic, so
// we never block on the reviewer being indecisive: a missing or malformed
// token defaults to CHANGES-REQUESTED
// (the safer choice — implementer gets another pass instead of shipping
// unreviewed work). Last token wins if the reviewer emits more than one.

export type Verdict = "APPROVED" | "CHANGES-REQUESTED";

export type ParsedVerdict = {
  readonly verdict: Verdict;
  readonly prose: string;
};

// Non-global, so it is safe to share across calls: a `g` regex object carries
// `lastIndex` and answers differently on alternate `test`s of the same input.
// `matchAll` requires a global one, so parseVerdict uses the derived copy.
const VERDICT_TOKEN = /<verdict>([\s\S]*?)<\/verdict>/;
const VERDICT_TOKEN_ALL = new RegExp(VERDICT_TOKEN, "g");

// Whether the reviewer got as far as emitting a token at all — NOT what it
// said. Used by the reviewer-run policy (#41) to decide whether a run that
// FAILED still reached a decision: a run killed after it emitted a verdict has
// judged the code, so it is a verdict and not a harness fault, while a run that
// died before emitting one has said nothing about the branch whatever prose it
// left behind. Deliberately not a check on the token's VALUE — a malformed
// token is still a decision the reviewer reached, and parseVerdict's
// default-to-CHANGES-REQUESTED is the right handling for it.
export function containsVerdictToken(stdout: string): boolean {
  return VERDICT_TOKEN.test(stdout);
}

export function parseVerdict(stdout: string): ParsedVerdict {
  const prose = stdout;
  const matches = [...stdout.matchAll(VERDICT_TOKEN_ALL)];
  if (matches.length === 0) {
    return { verdict: "CHANGES-REQUESTED", prose };
  }
  const last = matches[matches.length - 1]!;
  const token = (last[1] ?? "").trim();
  if (token === "APPROVED") return { verdict: "APPROVED", prose };
  return { verdict: "CHANGES-REQUESTED", prose };
}
