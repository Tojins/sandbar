import { describe, expect, it, vi } from "vitest";

import type { Sandbox } from "./agent-sandbox.js";
import {
  enforceReviewerSnapshot,
  priorReviewRound,
  reviewRoundLine,
  reviewerSnapshotChanged,
  runSandboxAndPublish,
  type ReviewerSnapshot,
} from "./inner-loop.js";
import { followupReviewContext } from "./prompt.js";
import type { ReviewerOutcome } from "./reviewer-run.js";

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

describe("priorReviewRound (#88)", () => {
  const correctnessApproved = reviewed("APPROVED", "<verdict>APPROVED</verdict>");
  const correctnessRejected = reviewed(
    "CHANGES-REQUESTED",
    "Null input crashes.\n<verdict>CHANGES-REQUESTED</verdict>",
  );
  const followupRejected = reviewed(
    "CHANGES-REQUESTED",
    "### Tests\n\nMissing coverage.\n<verdict>CHANGES-REQUESTED</verdict>",
  );

  it.each([
    {
      name: "correctness harness failure",
      correctness: harnessFailed,
      followup: undefined,
      expected: null,
    },
    {
      name: "correctness rejection",
      correctness: correctnessRejected,
      followup: undefined,
      expected: {
        round: 2,
        head: "abc1234",
        correctness: correctnessRejected.verdict,
      },
    },
    {
      name: "follow-up harness failure",
      correctness: correctnessApproved,
      followup: harnessFailed,
      expected: null,
    },
    {
      name: "reviewed follow-up",
      correctness: correctnessApproved,
      followup: followupRejected,
      expected: {
        round: 2,
        head: "abc1234",
        correctness: correctnessApproved.verdict,
        followup: followupRejected.verdict,
      },
    },
  ])("records $name correctly", ({ correctness, followup, expected }) => {
    expect(priorReviewRound(2, "abc1234", correctness, followup)).toEqual(expected);
  });

  it("keeps the listing anchor after a follow-up harness failure", () => {
    const listing = priorReviewRound(
      1,
      "listing-head",
      correctnessApproved,
      followupRejected,
    );
    const failed = priorReviewRound(
      2,
      "failed-head",
      correctnessApproved,
      harnessFailed,
    );
    const history = [listing, failed].filter(
      (round): round is NonNullable<typeof round> => round !== null,
    );

    expect(followupReviewContext(history)).toEqual({
      mode: "verify",
      anchor: "listing-head",
    });
  });
});

describe("reviewRoundLine (#88)", () => {
  it.each([
    {
      name: "correctness-only round",
      failed: null,
      followup: "NOT-RUN" as const,
      followupMode: undefined,
      expected:
        "issue=88 attempt=5 reviewer round=4 head=abc1234 " +
        "correctness=CHANGES-REQUESTED followup=NOT-RUN durationMs=123",
    },
    {
      name: "first follow-up listing",
      failed: null,
      followup: "APPROVED" as const,
      followupMode: "list" as const,
      expected:
        "issue=88 attempt=5 reviewer round=4 head=abc1234 " +
        "correctness=APPROVED followup=APPROVED mode=list durationMs=123",
    },
    {
      name: "completed round",
      failed: null,
      followup: "CHANGES-REQUESTED" as const,
      followupMode: "verify" as const,
      expected:
        "issue=88 attempt=5 reviewer round=4 head=abc1234 " +
        "correctness=APPROVED followup=CHANGES-REQUESTED mode=verify durationMs=123",
    },
    {
      name: "harness-failed round",
      failed: { pass: "followup" as const, invocations: 2 },
      followup: "HARNESS-FAILED" as const,
      followupMode: "verify" as const,
      expected:
        "issue=88 attempt=5 reviewer round=4 head=abc1234 " +
        "pass=followup harness-failed invocations=2 " +
        "correctness=APPROVED followup=HARNESS-FAILED mode=verify durationMs=123 " +
        "(round not consumed)",
    },
  ])("formats a $name with its reviewed HEAD", ({ failed, followup, followupMode, expected }) => {
    expect(
      reviewRoundLine({
        issueId: "88",
        attempt: 5,
        reviewRound: 4,
        head: "abc1234",
        failed,
        correctness: followup === "NOT-RUN" ? "CHANGES-REQUESTED" : "APPROVED",
        followup,
        followupMode,
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
