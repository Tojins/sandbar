// Pre-attempt issue partition classifier token parser (#158).
//
// Before implementation, the classifier decides whether the whole issue
// plausibly exceeds the context budget and names deliverables that each land
// alone; the gate itself lives in the prompt template.
// Its token is deliberately distinct from both the UI classifier and the
// implementer's promise. PARTITION requires the explanation finalise will hand
// to the human.

import { lastToken, literalTokenPattern, temperedBlockPattern } from "./token-scan.js";

export type PartitionCheckResult =
  | { readonly kind: "CLEAR" }
  | { readonly kind: "PARTITION"; readonly reason: string };

export type PartitionCheckParseResult = PartitionCheckResult |
  { readonly kind: "NO-SIGNAL"; readonly reprompt: string };

const TOKEN = literalTokenPattern("partition-check", ["CLEAR", "PARTITION"]);

export function parsePartitionCheck(stdout: string): PartitionCheckParseResult {
  const token = lastToken(stdout, TOKEN);
  if (token === null) {
    return {
      kind: "NO-SIGNAL",
      reprompt: "End with exactly `<partition-check>CLEAR</partition-check>` or " +
        "`<partition-check>PARTITION</partition-check>` followed by a " +
        "`<partition-reason>` block.",
    };
  }
  if (token === "CLEAR") return { kind: "CLEAR" };
  const reason = lastToken(stdout, temperedBlockPattern("partition-reason")) ?? "";
  return reason
    ? { kind: "PARTITION", reason }
    : {
        kind: "NO-SIGNAL",
        reprompt: "A PARTITION verdict requires a `<partition-reason>` block naming " +
          "the independently landable deliverables.",
      };
}
