// Cycle outcome → Phase-4 finalise inputs.
//
// Two builders, deliberately separate, because their inputs become available at
// different points in the cycle and #30 is exactly about not conflating them:
//
//   - terminalFinalizeInputs — one input per Phase-2 terminal that is not DONE.
//     Depends only on the inner loop, so run.ts finalises these BEFORE the
//     merge phase. A merge phase that dies (podman failing to bring up the
//     merger stack is the live example) then costs only the merge, instead of
//     discarding NEEDS-INFO questions, NEEDS-HUMAN traces and reviewer prose
//     that a full attempt budget already paid for.
//   - mergeFinalizeInputs — one input per merged/skipped issue. Only exists
//     once the merger has produced a summary, so it runs after.
//
// Both are pure: run.ts owns the side-effects and the run-state writes. The
// silent-noop retry counter is the one piece of carried state, so it is passed
// in as a read-only map and the bumped entries come back out rather than being
// mutated in place — the caller decides when they become durable.

import type { FinalizeInput } from "./finalize.js";
import type { Terminal } from "./inner-loop.js";
import type { IssueRef, MergerSummary, SkipReason } from "./merger.js";

import { SILENT_NOOP_RETRY_LIMIT } from "./exit-conditions.js";

export type IssueOutcome = {
  readonly issue: IssueRef;
  readonly terminal: Terminal;
};

/**
 * SkipReason → the Phase-4 handoff it earns.
 *
 * Exhaustive on purpose (the `never` assignment). A ternary chain with a
 * catch-all silently gave every future skip reason `merge-gate-red`, which
 * pushes the branch and applies `agent-stuck` — plausible for some reasons and
 * wrong for others, with nothing to catch the difference. `silent-noop` is
 * handled by mergeFinalizeInputs itself (it needs the per-issue retry count)
 * and never reaches here.
 */
export function finalizeKindForSkip(
  reason: Exclude<SkipReason, "silent-noop">,
): "merge-conflict" | "forge-unverified" | "merge-gate-red" {
  switch (reason) {
    case "conflict":
      return "merge-conflict";
    case "forge-unverified":
      return "forge-unverified";
    case "gate-red":
    case "install-failed":
      return "merge-gate-red";
    default: {
      const never: never = reason;
      throw new Error(`Unhandled merger skip reason: ${String(never)}`);
    }
  }
}

/**
 * Phase-4 inputs for the cycle's non-DONE terminals.
 *
 * Exhaustive over Terminal: a new terminal type that nobody maps here would
 * silently skip finalise — no comment, no label flip — and the issue would keep
 * `ready-for-agent` and be re-picked forever. The `never` assignment makes that
 * a compile error instead. DONE is the one deliberate no-op: the merger decides
 * what a DONE branch earns, and mergeFinalizeInputs carries it.
 */
export function terminalFinalizeInputs(
  outcomes: readonly IssueOutcome[],
): readonly FinalizeInput[] {
  const inputs: FinalizeInput[] = [];
  for (const o of outcomes) {
    const t = o.terminal;
    switch (t.type) {
      case "DONE":
        break;
      case "NEEDS-INFO":
        inputs.push({
          kind: "needs-info",
          issue: o.issue,
          questions: t.questions,
          strandedHead: t.strandedHead,
        });
        break;
      case "NEEDS-UI-PROTOTYPE":
        inputs.push({
          kind: "needs-ui-prototype",
          issue: o.issue,
          uiImpact: t.uiImpact,
          hasCommits: t.commits.length > 0,
          strandedHead: t.strandedHead,
        });
        break;
      case "NEEDS-HUMAN":
        inputs.push({
          kind: "needs-human",
          issue: o.issue,
          cause: t.cause,
          failureTrace: t.failureTrace,
          latestReviewerProse: t.latestReviewerProse,
          strandedHead: t.strandedHead,
        });
        break;
      case "NEEDS-HUMAN-REVIEW":
        inputs.push({
          kind: t.cause === "reviewer-wrote" ? "reviewer-wrote" : "review-budget-exhausted",
          issue: o.issue,
          latestReviewerProse: t.latestReviewerProse,
        });
        break;
      case "HARD-ERROR":
        inputs.push({
          kind: "hard-error",
          issue: o.issue,
          hasCommits: t.commits.length > 0,
          strandedHead: t.strandedHead,
        });
        break;
      default: {
        const unhandled: never = t;
        throw new Error(
          `unhandled terminal in finalise: ${JSON.stringify(unhandled)}`,
        );
      }
    }
  }
  return inputs;
}

export type MergeFinalizeInputs = {
  readonly inputs: readonly FinalizeInput[];
  // Issue ids whose silent-noop retry count moved, with their new value. The
  // caller writes these back into the run state; nothing here mutates.
  readonly bumpedSilentNoop: ReadonlyMap<string, number>;
};

/**
 * Phase-4 inputs for what the merger did with the cycle's DONE branches.
 *
 * `summary` is either the merger's own result or, after a MergerError halt, the
 * partial tracker state it had already applied — the shapes are identical and
 * the halt path's `merged` is empty by construction. `chunkLanded` (#60) is
 * NOT empty on that path and must not be: those commits are on origin's chunk
 * branch whether the cycle went on to halt or not, and the label flip they earn
 * is what stops the next cycle re-planning work that is already landed.
 */
export function mergeFinalizeInputs(
  summary: MergerSummary,
  silentNoopAttempts: ReadonlyMap<string, number>,
): MergeFinalizeInputs {
  const inputs: FinalizeInput[] = [];
  const bumpedSilentNoop = new Map<string, number>();
  for (const m of summary.merged) {
    inputs.push({ kind: "merged", issue: m });
  }
  for (const s of summary.skipped) {
    if (s.reason === "silent-noop") {
      const attempts = (silentNoopAttempts.get(s.issue.id) ?? 0) + 1;
      bumpedSilentNoop.set(s.issue.id, attempts);
      inputs.push(
        attempts < SILENT_NOOP_RETRY_LIMIT
          ? { kind: "fresh-attempt", issue: s.issue }
          : { kind: "silent-noop-exhausted", issue: s.issue, attempts },
      );
      continue;
    }
    inputs.push({ kind: finalizeKindForSkip(s.reason), issue: s.issue });
  }
  // #60, and LAST. The display-label edit is best-effort since #93, but the
  // required issue comment can still throw. `finalizeAll` is fail-fast, so a
  // chunk-landed input must not abandon an ordinary handoff after the merger
  // has already stripped that issue's queue label (#8, #33).
  for (const c of summary.chunkLanded) {
    inputs.push({
      kind: "chunk-landed",
      issue: c.issue,
      chunkBranch: c.chunkBranch,
    });
  }
  return { inputs, bumpedSilentNoop };
}
