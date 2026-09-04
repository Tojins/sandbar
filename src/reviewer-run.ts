// Reviewer policy (#19, #41, #121) — what counts as a review, how the two
// sequential passes compose into one round, and what to do when nothing does.
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
// A review ROUND first applies that policy to QUALITY — tests and standards.
// A quality rejection finishes the round immediately; an approval asks the
// runner for CORRECTNESS, and the second outcome completes the AND. This
// module returns the one event the state machine understands, keeping pass
// policy out of the I/O runner.
//
// Quality protects the EXPENSIVE correctness pass (#121). Gate-1 runs beside
// the review round (#123), whose result is discarded if the gate is red. #19
// ran correctness first so a
// correctness rejection would skip the checklist's cost; measured, correctness
// approved 11 of 11 judged rounds after #107 while costing two thirds of all
// reviewer minutes, and 7 of those approvals were discarded by the second pass
// in the same round. The pass that rejects is the one that should run first.
//
// Both passes are COLD. #19's resume (follow-up invocation 1 continuing the
// correctness session) pointed at a pass that has not run once the order
// flipped, so it is gone — which is also what lets the two passes sit on
// different vendors (#121 §2), since a session cannot cross vendor CLIs.
//
// Neither pass's prose is labelled here: both prompts name their own dimension
// headings (`### Correctness`/`### Spec`, `### Tests`/`### Standards`), which
// they must, because each pass now carries more than one dimension. Quality may
// additionally emit `### Correctness` — #19's escalation permission for a
// defect it happens to notice — so the headings are not a partition and nothing
// downstream parses them.
//
// The correctness pass may also declare one `<spec-gap>` block (#108).
// `parseVerdict` keeps it on the parsed correctness verdict; composition does
// not place it on the state-machine event because it is evidence, not a
// decision input. The I/O runner reads it directly from the completed
// correctness outcome and accumulates it beside prior-round history. A block
// emitted by quality is therefore structurally ignored.

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

// In execution order (#121).
export type ReviewerPass = "quality" | "correctness";

export type ReviewRoundDecision =
  | { readonly kind: "run-correctness" }
  | {
      readonly kind: "finished";
      readonly event: Extract<
        ReviewerResult,
        { kind: "reviewer-result" | "reviewer-harness-failed" }
      >;
      readonly quality: "APPROVED" | "CHANGES-REQUESTED" | "HARNESS-FAILED";
      readonly correctness: "APPROVED" | "CHANGES-REQUESTED" | "SKIPPED" | "HARNESS-FAILED";
    };

export type FinishedReviewRoundDecision = Extract<
  ReviewRoundDecision,
  { readonly kind: "finished" }
>;

export function decideReviewRound(quality: CompletedReviewerOutcome): ReviewRoundDecision;
export function decideReviewRound(
  quality: CompletedReviewerOutcome,
  correctness: CompletedReviewerOutcome,
): FinishedReviewRoundDecision;
export function decideReviewRound(
  quality: CompletedReviewerOutcome,
  correctness?: CompletedReviewerOutcome,
): ReviewRoundDecision {
  if (quality.kind === "harness-failed") {
    return {
      kind: "finished",
      event: { kind: "reviewer-harness-failed", detail: `quality: ${quality.detail}` },
      quality: "HARNESS-FAILED",
      correctness: "SKIPPED",
    };
  }
  const qualityVerdict = quality.verdict;
  if (qualityVerdict.verdict === "CHANGES-REQUESTED") {
    return {
      kind: "finished",
      event: {
        kind: "reviewer-result",
        verdict: "CHANGES-REQUESTED",
        prose: qualityVerdict.prose,
      },
      quality: "CHANGES-REQUESTED",
      correctness: "SKIPPED",
    };
  }
  if (correctness === undefined) return { kind: "run-correctness" };
  if (correctness.kind === "harness-failed") {
    return {
      kind: "finished",
      event: { kind: "reviewer-harness-failed", detail: `correctness: ${correctness.detail}` },
      quality: "APPROVED",
      correctness: "HARNESS-FAILED",
    };
  }
  const correctnessVerdict = correctness.verdict;
  return {
    kind: "finished",
    event: {
      kind: "reviewer-result",
      verdict: correctnessVerdict.verdict,
      prose: correctnessVerdict.prose,
    },
    quality: "APPROVED",
    correctness: correctnessVerdict.verdict,
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
