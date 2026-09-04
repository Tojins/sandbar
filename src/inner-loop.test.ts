import { describe, expect, it, vi } from "vitest";

import type { Sandbox } from "./agent-sandbox.js";
import {
  enforceReviewerSnapshot,
  reviewerSnapshotChanged,
  runSandboxAndPublish,
  type ReviewerSnapshot,
} from "./inner-loop.js";

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
