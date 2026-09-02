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
// standards file that extends it. That keeps either verdict deterministic.
// Missing tokens are absence, not a fabricated verdict. The reviewer harness
// filters those runs by parsing once. Last token wins when several are emitted.
// A catch may only classify one named expected condition checked explicitly,
// or clean up on failure: log the secondary failure with its cause, then
// rethrow the original (#83).

export type Verdict = "APPROVED" | "CHANGES-REQUESTED";

export type ParsedVerdict = {
  readonly verdict: Verdict;
  readonly prose: string;
};

const VERDICT_TOKEN_ALL = /<verdict>([\s\S]*?)<\/verdict>/g;

export function parseVerdict(stdout: string): ParsedVerdict | null {
  const prose = stdout;
  const matches = [...stdout.matchAll(VERDICT_TOKEN_ALL)];
  if (matches.length === 0) {
    return null;
  }
  const last = matches[matches.length - 1]!;
  const token = (last[1] ?? "").trim();
  if (token === "APPROVED") return { verdict: "APPROVED", prose };
  return { verdict: "CHANGES-REQUESTED", prose };
}
