// The verifier (#180, #206) — pure. It holds the slot after a green gate-1
// that the correctness pass held: same `maxReviewRounds` budget, same
// harness-failure rule (#41), same adjudicator path (#167).
//
// Today the verifier is the white-box reviewer alone: the correctness review
// on the `reviewer*` routing, read-only and cold. #180's scenario runner joins
// it beside this one; until then `combineVerifier` only ever sees a runner that
// did not run, so every outcome is the white-box review's.
//
// A rejection is a list of tagged UNITS, concatenated verbatim and never merged
// by a model, because a merging call could silently drop a finding. Each unit
// carries two renderings: `text`, which the implementer and the adjudicator
// read, and `publicText`, which is all that may reach GitHub. For a
// `[white-box]` unit the two are the same; the split exists so finalise cannot
// publish scenario text or evidence by construction once scenario units exist.
//
// From its second round on, the white-box review is patch-scoped: it reads
// only the change since the last head an earlier round reviewed, provided that
// head is still an ancestor of HEAD. Earlier conclusions about unchanged hunks
// stand, and #88's history carries them.

import type { ReviewerResult, ReviewScope } from "./inner-loop-machine.js";
import type { PriorReviewRound } from "./prompt.js";
import { stripVerdictTokens } from "./verdict-parser.js";

export type VerifierUnit = {
  readonly id: "white-box";
  readonly text: string;
  readonly publicText: string;
};

export type VerifierOutcome =
  | { readonly kind: "wrote"; readonly cause: "reviewer-wrote"; readonly detail: string }
  | { readonly kind: "harness-failed"; readonly detail: string }
  | { readonly kind: "approved" }
  | { readonly kind: "rejected"; readonly units: readonly VerifierUnit[] };

// Fold the round's results into one outcome. A write gives `wrote`, a
// CHANGES-REQUESTED `rejected`, a white-box review that produced nothing
// `harness-failed` (unreviewed code never reads as DONE), anything else
// `approved`.
export function combineVerifier(whiteBox: ReviewerResult): VerifierOutcome {
  switch (whiteBox.kind) {
    case "reviewer-wrote":
      return { kind: "wrote", cause: "reviewer-wrote", detail: whiteBox.detail };
    case "reviewer-harness-failed":
      return { kind: "harness-failed", detail: whiteBox.detail };
    case "reviewer-result": {
      if (whiteBox.verdict === "APPROVED") return { kind: "approved" };
      const text = `[white-box]\n${stripVerdictTokens(whiteBox.prose).trim()}`;
      return { kind: "rejected", units: [{ id: "white-box", text, publicText: text }] };
    }
  }
}

// The units in one rendering, in order, separated by a blank line.
export function renderUnits(
  units: readonly VerifierUnit[],
  form: "text" | "publicText",
): string {
  return units.map((unit) => unit[form]).join("\n\n");
}

// What the white-box review reads this round: the whole branch, or the change
// since the LAST earlier round whose head HEAD still contains. A head the
// branch no longer contains (a rewritten history) cannot anchor a range.
export function reviewScope(
  prior: readonly PriorReviewRound[],
  isAncestor: (sha: string) => boolean,
): ReviewScope {
  const anchor = [...prior].reverse().find((round) => isAncestor(round.head));
  return anchor === undefined ? { kind: "full" } : { kind: "since", sha: anchor.head };
}
