import { describe, expect, it, vi } from "vitest";

import type { Terminal } from "./inner-loop.js";
import {
  maxRecomputesFor,
  terminalReason,
  verifyFinalizedTrackerState,
} from "./run.js";

describe("maxRecomputesFor (#87)", () => {
  it("keeps a minimum for small budgets and scales for every allowed silent-noop retry", () => {
    expect(maxRecomputesFor(1)).toBe(100);
    expect(maxRecomputesFor(50)).toBe(610);
    expect(maxRecomputesFor(51)).toBe(622);
  });
});

describe("terminal event reasons (#132)", () => {
  const terminals: readonly [Terminal, string | null][] = [
    [{ type: "DONE", commits: [] }, null],
    [
      { type: "NEEDS-INFO", questions: "question", strandedHead: null },
      "question",
    ],
    [
      {
        type: "NEEDS-UI-PROTOTYPE",
        uiImpact: "impact",
        commits: [],
        strandedHead: null,
      },
      "impact",
    ],
    [
      {
        type: "NEEDS-HUMAN",
        cause: "gate-red",
        failureTrace: "trace",
        latestReviewerProse: null,
        qualityBudgetExhausted: 4,
        strandedHead: null,
      },
      "gate-red: trace",
    ],
    [
      {
        type: "NEEDS-HUMAN-REVIEW",
        cause: "correctness-budget-exhausted",
        roundsUsed: 4,
        latestReviewerProse: "review",
        commits: [],
      },
      "correctness-budget-exhausted: review",
    ],
    [{ type: "QUOTA", provider: "codex", window: "five_hour" }, "codex five_hour"],
    [{ type: "HARD-ERROR", reason: "bringup failed\nstack", commits: [] }, "bringup failed\nstack"],
  ];

  it.each(terminals)("keeps structured terminal detail", (terminal, reason) => {
    expect(terminalReason(terminal)).toBe(reason);
  });
});

describe("tracker finalization read-back (#87)", () => {
  const result = {
    input: {
      kind: "needs-info" as const,
      issue: { id: "87", title: "pool", branch: "sandbar/issue-87-pool" },
      questions: "which state?",
      strandedHead: null,
    },
    action: { kind: "pushed" as const },
  };

  it("accepts the intended not-ready state", async () => {
    await expect(verifyFinalizedTrackerState([result], async () => ["needs-info"]))
      .resolves.toBeUndefined();
  });

  it("halts loudly when the queue label remains", async () => {
    await expect(verifyFinalizedTrackerState(
      [result],
      async () => ["ready-for-agent", "needs-info"],
    )).rejects.toThrow(/Tracker read-back mismatch for issue #87.*not-ready.*ready-for-agent/);
  });

  it("does not read back finalizations that intentionally keep the issue ready", async () => {
    const issueLabels = vi.fn(async () => ["ready-for-agent"]);
    await verifyFinalizedTrackerState([
      {
        input: {
          kind: "quota", issue: result.input.issue, provider: "codex",
          window: "five_hour", specGaps: [],
        },
        action: { kind: "pushed" },
      },
      {
        input: {
          kind: "hard-error", issue: result.input.issue, hasCommits: false,
          specGaps: [],
        },
        action: { kind: "deleted-local" },
      },
      {
        input: result.input,
        action: { kind: "skipped-closed" },
      },
    ], issueLabels);
    expect(issueLabels).not.toHaveBeenCalled();
  });
});
