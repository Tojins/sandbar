import { describe, expect, it, vi } from "vitest";

import type { Terminal } from "./inner-loop.js";
import { AgentQuotaError } from "./agent-sandbox.js";
import {
  selectTerminalExit,
  terminalReason,
  verifyFinalizedTrackerState,
} from "./run.js";

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
    [{ type: "CREDENTIAL", provider: "codex", detail: "refresh refused" }, "codex: refresh refused"],
    [{ type: "HARD-ERROR", reason: "bringup failed\nstack", commits: [] }, "bringup failed\nstack"],
  ];

  it.each(terminals)("keeps structured terminal detail", (terminal, reason) => {
    expect(terminalReason(terminal)).toBe(reason);
  });
});

describe("provider terminal precedence (#134)", () => {
  it("keeps credential refusal ahead of quota and halt", () => {
    const credential: Terminal = {
      type: "CREDENTIAL",
      provider: "codex",
      detail: "refresh refused",
      specGaps: [],
    };
    expect(selectTerminalExit({
      mergerProviderError: new AgentQuotaError("claude", {
        status: "rejected",
        window: "five_hour",
      }),
      haltReasons: ["merger-halted"],
      terminals: [credential],
      otherwise: () => null,
    })).toMatchObject({ tag: "credential", exitCode: 4 });
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
        input: {
          kind: "credential", issue: result.input.issue, provider: "codex",
          detail: "refresh refused", specGaps: [],
        },
        action: { kind: "pushed" },
      },
      {
        input: result.input,
        action: { kind: "skipped-closed" },
      },
    ], issueLabels);
    expect(issueLabels).not.toHaveBeenCalled();
  });
});
