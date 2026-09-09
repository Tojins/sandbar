import { describe, expect, it, vi } from "vitest";

import type { Terminal } from "./inner-loop.js";
import { AgentQuotaError } from "./agent-sandbox.js";
import {
  decideOriginLockWake,
  selectTerminalExit,
  terminalReason,
  verifyFinalizedTrackerState,
} from "./run.js";
import type { OriginLockClaim } from "./origin-lock.js";

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
        budgetExhausted: { budget: "gate", roundsUsed: 4 },
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

describe("origin lease loss (#139)", () => {
  const claim: OriginLockClaim = {
    sha: "abc",
    lease: {
      hostname: "host-a",
      workdir: "/srv/app/.sandbar",
      pid: 123,
      run: "run-a",
      startedAt: "2026-09-08T12:00:00.000Z",
      expires: "2026-09-08T12:10:00.000Z",
    },
  };

  it.each([
    {
      name: "rejected renewal",
      renewal: {
        kind: "lost" as const,
        holder: { ...claim, sha: "replacement" },
        reason: "replaced" as const,
        detail: "current holder is host-b",
      },
      detail: "current holder is host-b",
    },
    {
      name: "expired lease with unreachable origin",
      renewal: {
        kind: "lost" as const,
        holder: null,
        reason: "expired-unrenewable" as const,
        detail: "origin could not be asked",
      },
      detail: "origin could not be asked",
    },
  ])("halts without a landing continuation on $name", ({ renewal, detail }) => {
    expect(decideOriginLockWake(renewal)).toEqual({
      kind: "halt",
      complaint: expect.stringContaining(detail),
      exit: expect.objectContaining({ tag: "halted", exitCode: 1 }),
    });
  });

  it("continues only while an unrenewed lease is still valid", () => {
    expect(decideOriginLockWake({
      kind: "retained",
      claim,
      reason: "network down",
    })).toEqual({
      kind: "continue",
      warning: expect.stringContaining("network down"),
    });
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
