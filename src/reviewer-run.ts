// Reviewer invocation policy (#41) — what counts as a review, and what to do
// when nothing does.
//
// The reviewer is advisory, so its failure mode looks harmless and is not: a
// run that emitted ZERO BYTES was fed through the verdict parser, came out as
// CHANGES-REQUESTED (no token → the safe default), spent one of
// `maxReviewRounds`, and handed the next implementer attempt a harness error
// message as its entire feedback. Three separate charges to the issue for
// something that happened to the harness. The fail-safe direction was right —
// an unknown outcome must never read as APPROVED — but a fail-safe is not a
// licence to invent evidence.
//
// So: a reviewer INVOCATION yields a verdict or it yields nothing, and this
// module is the only place that decides which.
//
//   - Completed with output → a verdict. Whatever it printed, it looked and
//     spoke; a missing token is the verdict parser's business, and its
//     default-to-CHANGES-REQUESTED is a statement about the code (#40 already
//     refuses to run a reviewer over an empty changeset, so there is nothing to
//     review only if this loop is confused about what the branch holds).
//   - Failed, but the partial output holds a `<verdict>` token → a verdict.
//     The run reached a decision and then died on the way out; discarding that
//     would be the mirror-image fabrication — reporting "the reviewer never
//     ran" about a reviewer that did. This is why `agentPartialOutput` exists:
//     without the bytes, every failure is indistinguishable from silence.
//   - Anything else → nothing. A failure with no decision in it, or a run that
//     completed and printed nothing at all.
//
// "Nothing" is retried once before it is believed, because that is the cheapest
// way to tell a flake from a fault and the retry costs no budget of any kind.
// The transcript of every invocation is kept whole — the observed case left a
// 73-byte log for a 15-minute run, and a partial review that failed on the way
// out is the one artefact a human has.
//
// What the caller does with a `harness-failed` outcome is the state machine's
// business, not this module's: see inner-loop-machine.ts, which spends no
// review round on it and never lets the detail below reach an implementer as
// reviewer prose.

import { containsVerdictToken } from "./verdict-parser.js";

// One retry. A second flake in a row is not a flake, and each invocation can
// cost a full idle timeout (10 minutes) with the run's lock held.
export const REVIEWER_MAX_INVOCATIONS = 2;

// How much of a failed invocation's partial output to quote in the detail. The
// detail becomes a NEEDS-HUMAN failure trace inside a GitHub comment, so it is
// bounded; the transcript keeps everything.
export const REVIEWER_DETAIL_TAIL_CHARS = 2000;

// One invocation's raw result. Never a rejection: the caller adapts its
// sandbox's throw into this shape, which is what keeps the classification below
// pure and table-testable without an error-shaped fixture.
export type ReviewerRun = {
  // Everything the agent emitted — its stdout when the run completed, its
  // partial output when it failed (`agentPartialOutput`).
  readonly output: string;
  // The harness error's message, or null when the run completed.
  readonly error: string | null;
};

export type ReviewerOutcome =
  | {
      readonly kind: "reviewed";
      // What to hand the verdict parser: the reviewing invocation's output
      // alone, never the transcript. A previous invocation's harness error is
      // not prose the reviewer wrote, and this string is quoted to the
      // implementer and to humans as if it were.
      readonly stdout: string;
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
    };

function tail(s: string, max: number): string {
  return s.length <= max ? s : `…(${s.length - max} earlier chars elided)\n${s.slice(-max)}`;
}

// Why this invocation produced no review, phrased so the difference that
// matters — did any byte come back? — survives into the log and the handoff.
function noReviewDetail(run: ReviewerRun): string {
  if (run.error === null) {
    return "the run completed and emitted no output at all";
  }
  if (run.output.trim() === "") {
    return `the run failed and emitted no output at all: ${run.error}`;
  }
  return (
    `the run failed before reaching a verdict: ${run.error}\n` +
    `partial output:\n${tail(run.output, REVIEWER_DETAIL_TAIL_CHARS)}`
  );
}

// Pure: does this invocation carry a verdict about the code?
export function isReview(run: ReviewerRun): boolean {
  if (run.error === null) return run.output.trim() !== "";
  return containsVerdictToken(run.output);
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
// budget runs out. `invoke` is given the 1-based invocation number and must not
// reject — see ReviewerRun.
export async function runReviewerInvocations(
  invoke: (invocation: number) => Promise<ReviewerRun>,
  opts: ReviewerRunOptions = {},
): Promise<ReviewerOutcome> {
  const max = opts.maxInvocations ?? REVIEWER_MAX_INVOCATIONS;
  const transcript: string[] = [];
  const details: string[] = [];

  for (let n = 1; n <= max; n++) {
    const run = await invoke(n);
    transcript.push(transcriptEntry(n, run));
    if (isReview(run)) {
      return {
        kind: "reviewed",
        stdout: run.output,
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
