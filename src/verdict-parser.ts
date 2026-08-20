// Reviewer verdict-token parser.
//
// The reviewer signals its decision with `<verdict>APPROVED</verdict>` or
// `<verdict>CHANGES-REQUESTED</verdict>`. The reviewer is strictly advisory —
// it never commits — so the verdict is the only signal that travels back to
// the inner loop alongside its free-form prose.
//
// Convergence relies on the bar being sharp — i.e. on the coding standards
// (sandbar's built-in prompts/coding-standards.md, plus any project standards
// file that extends them) being precise enough to produce a deterministic
// verdict, so we never block on the reviewer being
// indecisive: a missing or malformed token defaults to CHANGES-REQUESTED
// (the safer choice — implementer gets another pass instead of shipping
// unreviewed work). Last token wins if the reviewer emits more than one.

export type Verdict = "APPROVED" | "CHANGES-REQUESTED";

export type ParsedVerdict = {
  readonly verdict: Verdict;
  readonly prose: string;
};

const VERDICT_TOKEN = /<verdict>([\s\S]*?)<\/verdict>/g;

// Whether the reviewer got as far as emitting a token at all — NOT what it
// said. Used by the reviewer-run policy (#41) to decide whether a run that
// FAILED still reached a decision: a run killed after it emitted a verdict has
// judged the code, so it is a verdict and not a harness fault, while a run that
// died before emitting one has said nothing about the branch whatever prose it
// left behind. Deliberately not a check on the token's VALUE — a malformed
// token is still a decision the reviewer reached, and parseVerdict's
// default-to-CHANGES-REQUESTED is the right handling for it.
export function containsVerdictToken(stdout: string): boolean {
  // A fresh lastIndex per call: the literal is `g`, so a shared regex object
  // would answer differently on alternate calls with the same input.
  return new RegExp(VERDICT_TOKEN.source).test(stdout);
}

export function parseVerdict(stdout: string): ParsedVerdict {
  const prose = stdout;
  const matches = [...stdout.matchAll(VERDICT_TOKEN)];
  if (matches.length === 0) {
    return { verdict: "CHANGES-REQUESTED", prose };
  }
  const last = matches[matches.length - 1]!;
  const token = (last[1] ?? "").trim();
  if (token === "APPROVED") return { verdict: "APPROVED", prose };
  return { verdict: "CHANGES-REQUESTED", prose };
}
