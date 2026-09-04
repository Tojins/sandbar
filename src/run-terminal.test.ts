import { describe, expect, it, vi } from "vitest";

import type { Terminal } from "./inner-loop.js";
import {
  formatTerminalLine,
  maxRecomputesFor,
  verifyFinalizedTrackerState,
} from "./run.js";

describe("maxRecomputesFor (#87)", () => {
  it("keeps a minimum for small budgets and scales for every allowed silent-noop retry", () => {
    expect(maxRecomputesFor(1)).toBe(100);
    expect(maxRecomputesFor(50)).toBe(610);
    expect(maxRecomputesFor(51)).toBe(622);
  });
});

describe("formatTerminalLine (#115)", () => {
  const terminals: readonly [string, Terminal][] = [
    ["DONE", { type: "DONE", commits: [] }],
    [
      "NEEDS-INFO",
      { type: "NEEDS-INFO", questions: "question", strandedHead: null },
    ],
    [
      "NEEDS-UI-PROTOTYPE",
      {
        type: "NEEDS-UI-PROTOTYPE",
        uiImpact: "impact",
        commits: [],
        strandedHead: null,
      },
    ],
    [
      "NEEDS-HUMAN",
      {
        type: "NEEDS-HUMAN",
        cause: "gate-red",
        failureTrace: "trace",
        latestReviewerProse: null,
        qualityBudgetExhausted: 4,
        strandedHead: null,
      },
    ],
    [
      "NEEDS-HUMAN-REVIEW",
      {
        type: "NEEDS-HUMAN-REVIEW",
        cause: "correctness-budget-exhausted",
        roundsUsed: 4,
        latestReviewerProse: "review",
        commits: [],
      },
    ],
    ["QUOTA", { type: "QUOTA", provider: "codex", window: "five_hour" }],
  ];

  it.each(terminals)("leaves the %s terminal payload-free", (_name, terminal) => {
    expect(formatTerminalLine("115", terminal, "durationMs=42")).toBe(
      `terminal #115 ${terminal.type} durationMs=42`,
    );
  });

  it.each([
    ["single-line", "podman socket refused"],
    ["multi-line", "bringup failed\nstack frame\nlast frame"],
    ["empty", ""],
  ])("appends the %s HARD-ERROR reason verbatim", (_name, reason) => {
    expect(
      formatTerminalLine(
        "115",
        { type: "HARD-ERROR", reason, commits: [] },
        "durationMs=42",
      ),
    ).toBe(`terminal #115 HARD-ERROR durationMs=42: ${reason}`);
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
