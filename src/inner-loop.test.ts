import { describe, expect, it, vi } from "vitest";

const innerLoopMocks = vi.hoisted(() => ({
  buildPrompt: vi.fn(async () => "implementer prompt"),
  dirtyWorktreePaths: vi.fn(async () => [] as string[]),
  headMismatch: vi.fn(async () => null),
}));

vi.mock("./prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prompt.js")>()),
  buildPrompt: innerLoopMocks.buildPrompt,
}));

vi.mock("./git-ops.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git-ops.js")>()),
  dirtyWorktreePaths: innerLoopMocks.dirtyWorktreePaths,
  headMismatch: innerLoopMocks.headMismatch,
}));

import type { Sandbox } from "./agent-sandbox.js";
import {
  enforceReviewerSnapshot,
  priorReviewRound,
  reviewRoundLine,
  reviewerPassRouting,
  reviewerSnapshotChanged,
  runGateAndReviewer,
  runImplementer,
  runInnerLoop,
  runSandboxAndPublish,
  type ReviewerSnapshot,
} from "./inner-loop.js";
import { qualityReviewContext } from "./prompt.js";
import type { ReviewerOutcome } from "./reviewer-run.js";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("silent implementer attempt policy (#116)", () => {
  const sandboxResult = (stdout: string, silent: boolean, commits: string[] = []) => ({
    stdout,
    silent,
    commits: commits.map((sha) => ({ sha })),
    maxGapMs: 1,
    toolCalls: 0,
  });

  const runPath = (
    first: ReturnType<typeof sandboxResult>,
    nudge: ReturnType<typeof sandboxResult>,
  ) => {
    const writes: string[] = [];
    const lines: string[] = [];
    const sandbox = {
      worktreePath: "/unused",
      run: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(nudge),
      syncBranchToCache: vi.fn(),
    } as unknown as Sandbox;
    const ctx = {
      issue: { id: "116", title: "silent", branch: "sandbar/issue-116-silent" },
      sandbox,
      opts: {
        attemptLogger: {
          writeAttempt: vi.fn(async (_id, _attempt, text) => writes.push(text)),
        },
        onOrchestratorLog: (line: string) => lines.push(line),
      },
      config: {
        implementerAgent: "codex",
        implementerModelId: "model",
        maxImplAttempts: 8,
      },
      anchorOpts: {},
      base: { ref: "origin/main" },
      gateStack: {},
      worktreePath: "/unused",
      accumulated: [],
      priorReviewRounds: [],
      sandboxStatuses: [],
    } as unknown as Parameters<typeof runImplementer>[1];
    const pending = runImplementer(
      {
        kind: "run-implementer",
        attempt: 1,
        failureTrace: null,
        extraReprompt: null,
        latestReviewerProse: null,
      },
      ctx,
    );
    return { pending, sandbox, writes, lines };
  };

  it("rejects the implementer path after two silent zero-commit runs", async () => {
    const { pending, sandbox } = runPath(
      sandboxResult("", true),
      sandboxResult("", true),
    );

    await expect(pending).rejects.toThrow("no speech or commits");
    expect(sandbox.run).toHaveBeenCalledTimes(2);
  });

  it("keeps silent runs with commit evidence and logs the combined attempt", async () => {
    const { pending, writes, lines } = runPath(
      sandboxResult("", true, ["a"]),
      sandboxResult("", true, ["b"]),
    );

    await expect(pending).resolves.toMatchObject({ kind: "implementer-result" });
    expect(writes).toEqual(["", "\n"]);
    expect(lines.at(-1)).toContain("commits=2");
  });

  it("keeps a blip that speaks on the nudge and records exactly what was parsed", async () => {
    const spoken = "<promise>NEEDS-INFO</promise>\n<questions>Which API?</questions>";
    const { pending, writes, lines } = runPath(
      sandboxResult("", true),
      sandboxResult(spoken, false),
    );

    await expect(pending).resolves.toMatchObject({
      kind: "implementer-result",
      signal: { kind: "NEEDS-INFO" },
    });
    expect(writes).toEqual(["", `\n${spoken}`]);
    expect(lines.at(-1)).toContain("commits=0");
  });
});

describe("runGateAndReviewer (#123)", () => {
  const action = {
    kind: "run-gate-and-reviewer" as const,
    attempt: 2,
    reviewRound: 1,
  };
  const historyEntry = {
    round: 1,
    head: "abc1234",
    quality: { verdict: "APPROVED" as const, prose: "lgtm" },
  };
  const approved = {
    event: {
      kind: "reviewer-result" as const,
      verdict: "APPROVED" as const,
      prose: "lgtm",
    },
    historyEntry,
  };
  const context = (lines: string[] = []) =>
    ({
      issue: { id: "123" },
      opts: { onOrchestratorLog: (line: string) => lines.push(line) },
      priorReviewRounds: [],
    }) as unknown as Parameters<typeof runGateAndReviewer>[1];

  it("starts both jobs immediately, awaits both, and records green-gate history", async () => {
    const gate = deferred<{ readonly ok: boolean; readonly failureTrace: string }>();
    const reviewer = deferred<typeof approved>();
    const started: string[] = [];
    const ctx = context();
    const result = runGateAndReviewer(action, ctx, {
      gate: vi.fn(() => {
        started.push("gate");
        return gate.promise;
      }),
      reviewer: vi.fn(() => {
        started.push("reviewer");
        return reviewer.promise;
      }),
    });

    expect(started).toEqual(["gate", "reviewer"]);
    gate.resolve({ ok: true, failureTrace: "" });
    let finished = false;
    void result.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    reviewer.resolve(approved);

    await expect(result).resolves.toEqual({
      kind: "gate-and-reviewer-result",
      gate: { ok: true, failureTrace: "" },
      reviewer: approved.event,
    });
    expect(ctx.priorReviewRounds).toEqual([historyEntry]);
  });

  it("awaits a reviewer beside a red gate, discards its history, and logs the discard", async () => {
    const reviewer = deferred<typeof approved>();
    const lines: string[] = [];
    const ctx = context(lines);
    const result = runGateAndReviewer(action, ctx, {
      gate: vi.fn(async () => ({ ok: false, failureTrace: "tests failed" })),
      reviewer: vi.fn(() => reviewer.promise),
    });
    let finished = false;
    void result.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    reviewer.resolve(approved);

    await expect(result).resolves.toEqual({
      kind: "gate-and-reviewer-result",
      gate: { ok: false, failureTrace: "tests failed" },
      reviewer: approved.event,
    });
    expect(ctx.priorReviewRounds).toEqual([]);
    expect(lines).toEqual([
      "issue=123 attempt=2 gate-1 red — discarded concurrent reviewer result",
    ]);
  });
});

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

describe("runInnerLoop HARD-ERROR logging (#115)", () => {
  it("writes each recovering retry identically to stderr and the durable log", async () => {
    const outcomes = [
      {
        verdict: { type: "HARD-ERROR" as const, reason: "bringup failed\nstack" },
        accumulatedCommits: [],
      },
      {
        verdict: { type: "HARD-ERROR" as const, reason: "socket refused" },
        accumulatedCommits: [],
      },
      {
        verdict: { type: "DONE" as const, commits: [] },
        accumulatedCommits: [],
      },
    ];
    const runCycle = vi.fn(async () => outcomes.shift()!);
    const orchestratorLines: string[] = [];
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        runInnerLoop(
          { id: "115", title: "logging", branch: "sandbar/issue-115-logging" },
          {
            onOrchestratorLog: (line) => orchestratorLines.push(line),
          } as unknown as Parameters<typeof runInnerLoop>[1],
          runCycle,
        ),
      ).resolves.toEqual({ type: "DONE", commits: [] });
      expect(orchestratorLines).toEqual([
        "  115: HARD-ERROR (bringup failed) — retry 1/2 with a fresh sandbox.",
        "  115: HARD-ERROR (socket refused) — retry 2/2 with a fresh sandbox.",
      ]);
      expect(stderr.mock.calls.map(([line]) => line)).toEqual(orchestratorLines);
    } finally {
      stderr.mockRestore();
    }
  });

  it("surfaces the full reason after the retries are exhausted", async () => {
    const runCycle = vi.fn(async () => ({
      verdict: {
        type: "HARD-ERROR" as const,
        reason: "bringup failed\nfull stack",
      },
      accumulatedCommits: [],
    }));

    await expect(
      runInnerLoop(
        { id: "115", title: "logging", branch: "sandbar/issue-115-logging" },
        {} as Parameters<typeof runInnerLoop>[1],
        runCycle,
      ),
    ).resolves.toEqual({
      type: "HARD-ERROR",
      reason: "bringup failed\nfull stack",
      commits: [],
    });
    expect(runCycle).toHaveBeenCalledTimes(3);
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
