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

export function parseVerdict(stdout: string): ParsedVerdict {
  const prose = stdout;
  const matches = [...stdout.matchAll(/<verdict>([\s\S]*?)<\/verdict>/g)];
  if (matches.length === 0) {
    return { verdict: "CHANGES-REQUESTED", prose };
  }
  const last = matches[matches.length - 1]!;
  const token = (last[1] ?? "").trim();
  if (token === "APPROVED") return { verdict: "APPROVED", prose };
  return { verdict: "CHANGES-REQUESTED", prose };
}
