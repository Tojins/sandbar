// Reviewer policy (#19, #41, #121, #185) — what counts as a review, and what to
// do when nothing does.
//
// A reviewer INVOCATION yields a verdict or it yields nothing, and this module
// is the only place that decides which:
//   - Completed or failed with a `<verdict>` token → a verdict; a failed run
//     carrying the token reached a decision and then died on the way out.
//   - Anything else → nothing. An unknown outcome must never read as APPROVED,
//     but a fail-safe is not a licence to invent evidence: feeding a zero-byte
//     run through the parser charges the issue review rounds for a harness
//     fault.
// "Nothing" is retried once before it is believed (flake vs fault; the retry
// costs no budget), and the transcript of every invocation is kept whole.
// Repository mutation aborts the invocation loop as a typed value, so no
// second reviewer runs against state the first reviewer altered (#98).
//
// Only the correctness pass reviews (#185). The quality pass became a fixer
// that commits and emits no verdict, so there is no round to compose: the one
// cold correctness outcome maps directly to the state machine's event. It runs
// only on a green gate-1 at the head the fixer left, and stays COLD — nothing
// resumes a session — which is what lets it sit on a different vendor from the
// fixer (#121 §2).
//
// The correctness pass may also declare one `<spec-gap>` block (#108).
// `parseVerdict` keeps it on the parsed verdict; the mapping does not place it
// on the state-machine event because it is evidence, not a decision input. The
// I/O runner reads it directly from the completed outcome and accumulates it
// beside prior-round history.

import type { ReviewerResult } from "./inner-loop-machine.js";
import { type ParsedVerdict, parseVerdict } from "./verdict-parser.js";

// One retry. A second flake in a row is not a flake, and each invocation can
// cost a full idle timeout (10 minutes) with the run's lock held.
export const REVIEWER_MAX_INVOCATIONS = 2;

// How much of a failed invocation's partial output to quote in the detail. The
// detail becomes a NEEDS-HUMAN failure trace inside a GitHub comment, so it is
// bounded; the transcript keeps everything.
export const REVIEWER_DETAIL_TAIL_CHARS = 2000;

// One invocation's raw review result. Ordinary sandbox failures are adapted
// into this shape, which keeps classification pure and table-testable without
// an error-shaped fixture. A detected reviewer write is the sole rejection: it
// is repository mutation, not a review outcome, and must bypass the retry.
export type ReviewerRun = {
  // Everything the agent emitted — its stdout when the run completed, its
  // partial output when it failed (`agentPartialOutput`).
  readonly output: string;
  // The harness error's message, or null when the run completed.
  readonly error: string | null;
};

export type ReviewerInvocation =
  | { readonly kind: "run"; readonly run: ReviewerRun }
  | {
      readonly kind: "aborted";
      readonly event: Extract<ReviewerResult, { kind: "reviewer-wrote" }>;
      readonly transcript: string;
    };

export type ReviewerOutcome =
  | {
      readonly kind: "reviewed";
      // Parsed once from the reviewing invocation alone, never the transcript.
      // A previous invocation's harness error is not reviewer prose.
      readonly verdict: ParsedVerdict;
      readonly transcript: string;
      readonly invocations: number;
    }
  | {
      readonly kind: "harness-failed";
      // Why each invocation yielded no review, for the run log and the
      // human handoff. Not for the implementer prompt — see the module header.
      readonly detail: string;
      readonly transcript: string;
      readonly invocations: number;
    }
  | Extract<ReviewerInvocation, { readonly kind: "aborted" }>;

export type CompletedReviewerOutcome = Exclude<
  ReviewerOutcome,
  { readonly kind: "aborted" }
>;

// The state machine's event for one completed correctness outcome. The detail
// keeps its `correctness:` prefix so the human handoff names the pass even
// though it is the only one that reviews.
export function reviewerResult(outcome: CompletedReviewerOutcome): Extract<
  ReviewerResult,
  { kind: "reviewer-result" | "reviewer-harness-failed" }
> {
  if (outcome.kind === "harness-failed") {
    return {
      kind: "reviewer-harness-failed",
      detail: `correctness: ${outcome.detail}`,
    };
  }
  return {
    kind: "reviewer-result",
    verdict: outcome.verdict.verdict,
    prose: outcome.verdict.prose,
  };
}

function tail(s: string, max: number): string {
  return s.length <= max ? s : `…(${s.length - max} earlier chars elided)\n${s.slice(-max)}`;
}

// Why this invocation produced no review, phrased so the difference that
// matters — did any byte come back? — survives into the log and the handoff.
function noReviewDetail(run: ReviewerRun): string {
  if (run.error === null) {
    if (run.output.trim() === "") {
      return "the run completed and emitted no output at all";
    }
    return (
      "the run completed but emitted no verdict token\n" +
      `output:\n${tail(run.output, REVIEWER_DETAIL_TAIL_CHARS)}`
    );
  }
  if (run.output.trim() === "") {
    return `the run failed and emitted no output at all: ${run.error}`;
  }
  return (
    `the run failed before reaching a verdict: ${run.error}\n` +
    `partial output:\n${tail(run.output, REVIEWER_DETAIL_TAIL_CHARS)}`
  );
}

function transcriptEntry(n: number, run: ReviewerRun): string {
  const header = `=== reviewer invocation ${n} ===\n`;
  const body = run.output === "" ? "(no output)\n" : run.output.endsWith("\n") ? run.output : `${run.output}\n`;
  return run.error === null
    ? `${header}${body}`
    : `${header}${body}reviewer run errored: ${run.error}\n`;
}

export type ReviewerRunOptions = {
  readonly maxInvocations?: number;
  // Called when an invocation yielded no review and another will be tried, so
  // the run log records the retry rather than leaving a doubled round number
  // unexplained.
  readonly onRetry?: (invocation: number, detail: string) => Promise<void> | void;
};

// Invoke the reviewer until one invocation yields a verdict, or the invocation
// budget runs out. `invoke` is given the 1-based invocation number. It returns
// a `ReviewerInvocation`: `run` for completed and ordinary failed invocations,
// `aborted` for a detected reviewer write. A normal run is classified here; an
// aborted value returns immediately and deliberately bypasses the retry loop.
export async function runReviewerInvocations(
  invoke: (invocation: number) => Promise<ReviewerInvocation>,
  opts: ReviewerRunOptions = {},
): Promise<ReviewerOutcome> {
  const max = opts.maxInvocations ?? REVIEWER_MAX_INVOCATIONS;
  const transcript: string[] = [];
  const details: string[] = [];

  for (let n = 1; n <= max; n++) {
    const invocation = await invoke(n);
    if (invocation.kind === "aborted") return invocation;
    const { run } = invocation;
    transcript.push(transcriptEntry(n, run));
    const verdict = parseVerdict(run.output);
    if (verdict !== null) {
      return {
        kind: "reviewed",
        verdict,
        transcript: transcript.join("\n"),
        invocations: n,
      };
    }
    const detail = noReviewDetail(run);
    details.push(`invocation ${n}/${max}: ${detail}`);
    if (n < max) await opts.onRetry?.(n, detail);
  }

  return {
    kind: "harness-failed",
    detail: details.join("\n\n"),
    transcript: transcript.join("\n"),
    invocations: max,
  };
}
