import { describe, expect, it, vi } from "vitest";

import type { Sandbox } from "./agent-sandbox.js";
import {
  createRunQuotaState,
  enforceReviewerSnapshot,
  priorReviewRound,
  reviewRoundLine,
  reviewerPassRouting,
  reviewerSnapshotChanged,
  quotaVerdict,
  runSandboxAndPublish,
  runWithQuotaState,
  type ReviewerSnapshot,
} from "./inner-loop.js";
import { AgentQuotaError } from "./agent-sandbox.js";
import { qualityReviewContext } from "./prompt.js";
import { runReviewerInvocations, type ReviewerOutcome } from "./reviewer-run.js";

const reviewed = (
  verdict: "APPROVED" | "CHANGES-REQUESTED",
  prose: string,
): ReviewerOutcome => ({
  kind: "reviewed",
  verdict: { verdict, prose },
  transcript: prose,
  invocations: 1,
});

const harnessFailed: ReviewerOutcome = {
  kind: "harness-failed",
  detail: "no verdict",
  transcript: "",
  invocations: 2,
};

describe("run-scoped quota closure (#109)", () => {
  it("records the first quota and bypasses retries and later same-provider invocations", async () => {
    const state = createRunQuotaState();
    const measurement = {
      status: "rejected" as const, window: "five_hour", resetsAt: 42,
    };
    const claudeInvocation = vi.fn().mockRejectedValue(
      new AgentQuotaError("claude", measurement),
    );
    const first = await runReviewerInvocations(
      () => runWithQuotaState(state, "claude", claudeInvocation),
      { onRetry: vi.fn() },
    ).then(() => null, (err: unknown) => err);
    expect(first).toBeInstanceOf(AgentQuotaError);
    expect(quotaVerdict(first as AgentQuotaError)).toEqual({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
    });
    await expect(
      runWithQuotaState(state, "claude", claudeInvocation),
    ).rejects.toMatchObject({ provider: "claude", measurement });
    expect(claudeInvocation).toHaveBeenCalledTimes(1);

    const codexInvocation = vi.fn().mockResolvedValue("answer");
    await expect(runWithQuotaState(state, "codex", codexInvocation)).resolves.toBe("answer");
    expect(codexInvocation).toHaveBeenCalledOnce();
  });
});

describe("priorReviewRound (#88, #121)", () => {
  const qualityApproved = reviewed("APPROVED", "<verdict>APPROVED</verdict>");
  const qualityRejected = reviewed(
    "CHANGES-REQUESTED",
    "### Tests\n\nMissing coverage.\n<verdict>CHANGES-REQUESTED</verdict>",
  );
  const correctnessRejected = reviewed(
    "CHANGES-REQUESTED",
    "### Correctness\n\nNull input crashes.\n<verdict>CHANGES-REQUESTED</verdict>",
  );

  it.each([
    {
      name: "quality harness failure",
      quality: harnessFailed,
      correctness: undefined,
      expected: null,
    },
    {
      name: "quality rejection",
      quality: qualityRejected,
      correctness: undefined,
      expected: {
        round: 2,
        head: "abc1234",
        quality: qualityRejected.verdict,
      },
    },
    {
      name: "correctness harness failure",
      quality: qualityApproved,
      correctness: harnessFailed,
      expected: null,
    },
    {
      name: "reviewed correctness",
      quality: qualityApproved,
      correctness: correctnessRejected,
      expected: {
        round: 2,
        head: "abc1234",
        quality: qualityApproved.verdict,
        correctness: correctnessRejected.verdict,
      },
    },
  ])("records $name correctly", ({ quality, correctness, expected }) => {
    expect(priorReviewRound(2, "abc1234", quality, correctness)).toEqual(expected);
  });

  // A round whose correctness pass harness-failed contributes no entry at all,
  // so it cannot move the quality anchor forward (#107).
  it("keeps the listing anchor after a correctness harness failure", () => {
    const listing = priorReviewRound(
      1,
      "listing-head",
      qualityApproved,
      correctnessRejected,
    );
    const failed = priorReviewRound(
      2,
      "failed-head",
      qualityApproved,
      harnessFailed,
    );
    const history = [listing, failed].filter(
      (round): round is NonNullable<typeof round> => round !== null,
    );

    expect(qualityReviewContext(history)).toEqual({
      mode: "verify",
      anchor: "listing-head",
    });
  });
});

// The pairing the whole issue is about: the cheap pass gates, the expensive one
// decides. Swapping the two model ids type-checks and leaves every other test
// green, so this is the assertion that says which pass runs where.
describe("reviewerPassRouting (#121)", () => {
  const config = {
    reviewerAgent: "claude",
    reviewerModelId: "opus",
    reviewerQualityAgent: "codex",
    reviewerQualityModelId: "gpt-5.6-sol",
  } as const;

  it("puts each pass on its own CLI and model", () => {
    expect(reviewerPassRouting(config)).toEqual({
      quality: { agent: "codex", modelId: "gpt-5.6-sol" },
      correctness: { agent: "claude", modelId: "opus" },
    });
  });

  // The default routing, where resolution has already copied `reviewerAgent`
  // into the quality field: one vendor, two model ids.
  it("keeps the two passes apart when both run the same CLI", () => {
    expect(
      reviewerPassRouting({
        ...config,
        reviewerQualityAgent: "claude",
        reviewerQualityModelId: "claude-sonnet-4-6",
      }),
    ).toEqual({
      quality: { agent: "claude", modelId: "claude-sonnet-4-6" },
      correctness: { agent: "claude", modelId: "opus" },
    });
  });
});

describe("reviewRoundLine (#88, #121)", () => {
  it.each([
    {
      name: "quality-only round",
      failed: null,
      quality: "CHANGES-REQUESTED" as const,
      correctness: "SKIPPED" as const,
      qualityMode: "list" as const,
      expected:
        "issue=88 attempt=5 reviewer round=4 head=abc1234 " +
        "quality=CHANGES-REQUESTED correctness=SKIPPED mode=list durationMs=123",
    },
    {
      name: "first quality listing carried to correctness",
      failed: null,
      quality: "APPROVED" as const,
      correctness: "APPROVED" as const,
      qualityMode: "list" as const,
      expected:
        "issue=88 attempt=5 reviewer round=4 head=abc1234 " +
        "quality=APPROVED correctness=APPROVED mode=list durationMs=123",
    },
    {
      name: "completed round",
      failed: null,
      quality: "APPROVED" as const,
      correctness: "CHANGES-REQUESTED" as const,
      qualityMode: "verify" as const,
      expected:
        "issue=88 attempt=5 reviewer round=4 head=abc1234 " +
        "quality=APPROVED correctness=CHANGES-REQUESTED mode=verify durationMs=123",
    },
    {
      name: "round whose gating pass harness-failed",
      failed: { pass: "quality" as const, invocations: 2 },
      quality: "HARNESS-FAILED" as const,
      correctness: "SKIPPED" as const,
      qualityMode: "list" as const,
      expected:
        "issue=88 attempt=5 reviewer round=4 head=abc1234 " +
        "pass=quality harness-failed invocations=2 " +
        "quality=HARNESS-FAILED correctness=SKIPPED mode=list durationMs=123 " +
        "(round not consumed)",
    },
    {
      name: "harness-failed round",
      failed: { pass: "correctness" as const, invocations: 2 },
      quality: "APPROVED" as const,
      correctness: "HARNESS-FAILED" as const,
      qualityMode: "verify" as const,
      expected:
        "issue=88 attempt=5 reviewer round=4 head=abc1234 " +
        "pass=correctness harness-failed invocations=2 " +
        "quality=APPROVED correctness=HARNESS-FAILED mode=verify durationMs=123 " +
        "(round not consumed)",
    },
  ])("formats a $name with its reviewed HEAD", ({ failed, quality, correctness, qualityMode, expected }) => {
    expect(
      reviewRoundLine({
        issueId: "88",
        attempt: 5,
        reviewRound: 4,
        head: "abc1234",
        failed,
        quality,
        correctness,
        qualityMode,
        durationField: "durationMs=123",
      }),
    ).toBe(expected);
  });
});

const snapshot = (
  over: Partial<ReviewerSnapshot> = {},
): ReviewerSnapshot => ({
  tip: "tip-a",
  dirtyPaths: [],
  headRef: "refs/heads/sandbar/issue-98-example",
  ...over,
});

describe("reviewer write detection", () => {
  it.each([
    ["nothing changed", snapshot(), false],
    ["branch tip changed", snapshot({ tip: "tip-b" }), true],
    ["branch ref was deleted", snapshot({ tip: null }), true],
    ["worktree became dirty", snapshot({ dirtyPaths: ["M src/x.ts"] }), true],
    ["HEAD moved", snapshot({ headRef: null }), true],
  ])("classifies %s", (_name, after, changed) => {
    expect(reviewerSnapshotChanged(snapshot(), after)).toBe(changed);
  });

  it("preserves a deleted issue ref without trying to publish it", async () => {
    const sandbox = {
      preserveWorktree: vi.fn(),
      syncBranchToCache: vi.fn(),
    };

    const event = await enforceReviewerSnapshot(
      sandbox,
      snapshot(),
      snapshot({ tip: null }),
      "partial reviewer output",
    );
    expect(event).toEqual(expect.objectContaining({
      kind: "reviewer-wrote",
      detail: expect.stringContaining("Reviewer changed git state"),
    }));
    expect(sandbox.preserveWorktree).toHaveBeenCalledWith(
      expect.stringContaining("human inspection"),
    );
    expect(sandbox.syncBranchToCache).not.toHaveBeenCalled();
  });
});

describe("runSandboxAndPublish", () => {
  it("preserves the agent failure when recovery publishing also fails", async () => {
    const agentError = new Error("agent idle timeout");
    const sandbox = {
      run: vi.fn().mockRejectedValue(agentError),
      syncBranchToCache: vi.fn().mockRejectedValue(new Error("packed-refs.lock")),
    } as unknown as Sandbox;
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        runSandboxAndPublish(sandbox, {} as Parameters<Sandbox["run"]>[0], "98"),
      ).rejects.toBe(agentError);
      expect(sandbox.syncBranchToCache).toHaveBeenCalledOnce();
      expect(reported).toHaveBeenCalledWith(
        expect.stringContaining("continuing with original error"),
        expect.any(Error),
      );
    } finally {
      reported.mockRestore();
    }
  });

  // The publish failure is the error, not the agent's success: the merge phase
  // reads the cache, so a run whose commits never reached it must not proceed
  // as if they had (#98). The commits themselves are the clone reclaim's to
  // keep, not this function's.
  it("surfaces a failed publish of a successful run as the error", async () => {
    const publishError = new Error("cache ref lock failed");
    const sandbox = {
      run: vi.fn().mockResolvedValue({ commits: [{ sha: "c1" }] }),
      syncBranchToCache: vi.fn().mockRejectedValue(publishError),
    } as unknown as Sandbox;

    await expect(
      runSandboxAndPublish(sandbox, {} as Parameters<Sandbox["run"]>[0], "98"),
    ).rejects.toBe(publishError);
    expect(sandbox.syncBranchToCache).toHaveBeenCalledOnce();
  });
});
