import { describe, expect, it, vi } from "vitest";

const innerLoopMocks = vi.hoisted(() => ({
  buildPrompt: vi.fn(async () => "implementer prompt"),
  buildUiCheckPrompt: vi.fn(async () => "ui check prompt"),
  buildReviewerPrompts: vi.fn(),
  branchTip: vi.fn(async () => "tip-a" as string | null),
  dirtyWorktreePaths: vi.fn(async () => [] as string[]),
  fastForwardOffBranchHead: vi.fn(),
  headMismatch: vi.fn(async () => null),
  symbolicHeadRef: vi.fn(async () => "refs/heads/sandbar/issue-126" as string | null),
}));

vi.mock("./prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prompt.js")>()),
  buildPrompt: innerLoopMocks.buildPrompt,
  buildUiCheckPrompt: innerLoopMocks.buildUiCheckPrompt,
  buildReviewerPrompts: innerLoopMocks.buildReviewerPrompts,
}));

vi.mock("./git-ops.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git-ops.js")>()),
  branchTip: innerLoopMocks.branchTip,
  dirtyWorktreePaths: innerLoopMocks.dirtyWorktreePaths,
  fastForwardOffBranchHead: innerLoopMocks.fastForwardOffBranchHead,
  headMismatch: innerLoopMocks.headMismatch,
  symbolicHeadRef: innerLoopMocks.symbolicHeadRef,
}));

import { withPartialOutput, type Sandbox } from "./agent-sandbox.js";
import {
  enforceReviewerSnapshot,
  priorReviewRound,
  reviewRoundLine,
  reviewerPassRouting,
  readOnlyAgentSnapshotChanged,
  runGateAndReviewer,
  runImplementer,
  runInnerLoop,
  runReviewer,
  runUiCheck,
  runSandboxAndPublish,
  type ReadOnlyAgentSnapshot,
} from "./inner-loop.js";
import { qualityReviewContext } from "./prompt.js";
import type { ReviewerOutcome } from "./reviewer-run.js";
import type { HeadMismatch } from "./git-ops.js";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("runUiCheck (#126)", () => {
  const context = (runs: readonly string[], lines: string[] = []) => {
    innerLoopMocks.branchTip.mockReset().mockResolvedValue("tip-a");
    innerLoopMocks.dirtyWorktreePaths.mockReset().mockResolvedValue([]);
    innerLoopMocks.symbolicHeadRef.mockReset().mockResolvedValue(
      "refs/heads/sandbar/issue-126",
    );
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn()
        .mockResolvedValueOnce({
          stdout: runs[0] ?? "",
          commits: [],
          maxGapMs: 3,
          toolCalls: 1,
        })
        .mockResolvedValueOnce({
          stdout: runs[1] ?? "",
          commits: [],
          maxGapMs: 4,
          toolCalls: 2,
        }),
      preserveWorktree: vi.fn(),
      syncBranchToCache: vi.fn(),
    } as unknown as Sandbox;
    return {
      sandbox,
      ctx: {
        issue: { id: "126", title: "ui check", branch: "sandbar/issue-126" },
        sandbox,
        opts: { onOrchestratorLog: (line: string) => lines.push(line) },
        config: {
          repo: { owner: "owner", name: "repo" },
          uiCheckAgent: "codex",
          uiCheckModelId: "gpt-5.6-sol",
          uiCheckEffort: "low",
        },
      } as unknown as Parameters<typeof runUiCheck>[1],
    };
  };

  it("returns a classification from a cold call with no completion signal", async () => {
    const lines: string[] = [];
    const { sandbox, ctx } = context(["<ui-check>CLEAR</ui-check>"], lines);
    await expect(runUiCheck({ kind: "run-ui-check" }, ctx)).resolves.toEqual({
      kind: "ui-check-result",
      result: { kind: "CLEAR" },
    });
    expect(sandbox.run).toHaveBeenCalledTimes(1);
    expect(sandbox.run).toHaveBeenCalledWith(expect.objectContaining({
      name: "ui-check-126",
      prompt: "ui check prompt",
      completionSignal: [],
    }));
    const invocation = vi.mocked(sandbox.run).mock.calls[0]![0];
    expect(invocation.agent.name).toBe("codex");
    const command = invocation.agent.buildPrintCommand({ prompt: "p" }).command;
    expect(command).toContain("--model 'gpt-5.6-sol'");
    expect(command).toContain("-c 'model_reasoning_effort=low'");
    expect(lines[0]).toMatch(
      /^issue=126 ui-check provider=codex model=gpt-5\.6-sol effort=low durationMs=\d+ toolCalls=1 invocation=1 maxGapMs=3$/,
    );
  });

  it("logs complete success and failed-invocation telemetry", async () => {
    const successLines: string[] = [];
    const success = context(["<ui-check>CLEAR</ui-check>"], successLines);
    vi.mocked(success.sandbox.run).mockReset().mockResolvedValueOnce({
      stdout: "<ui-check>CLEAR</ui-check>",
      commits: [],
      silent: false,
      maxGapMs: 9,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 3,
        outputTokens: 4,
        reasoningTokens: 5,
        apiMs: 6,
        resolvedModel: "resolved",
        models: 2,
        terminalReason: "end_turn",
      },
      toolCalls: 7,
      peakContext: 8,
      rateLimit: {
        status: "allowed_warning",
        window: "five_hour",
        utilization: 0.9,
        resetsAt: 42,
      },
    });
    await runUiCheck({ kind: "run-ui-check" }, success.ctx);
    expect(successLines[0]).toMatch(
      /^issue=126 ui-check provider=codex model=gpt-5\.6-sol effort=low durationMs=\d+ tokens=in:1,cached:2,write:3,out:4,reasoning:5 toolCalls=7 peakContext=8 apiMs=6 resolvedModel=resolved models=2 terminalReason=end_turn quotaStatus=allowed_warning quotaWindow=five_hour quotaUtilization=0\.9 quotaResetsAt=42 invocation=1 maxGapMs=9$/,
    );

    const failureLines: string[] = [];
    const failure = context([], failureLines);
    const err = withPartialOutput(
      new Error("disconnected"),
      "partial",
      { inputTokens: 11, outputTokens: 12 },
      13,
      14,
      { status: "rejected", window: "weekly", utilization: 1 },
    );
    vi.mocked(failure.sandbox.run).mockReset().mockRejectedValueOnce(err);
    await expect(runUiCheck({ kind: "run-ui-check" }, failure.ctx)).rejects.toBe(err);
    expect(failureLines[0]).toMatch(
      /^issue=126 ui-check provider=codex model=gpt-5\.6-sol effort=low durationMs=\d+ tokens=in:11,out:12 toolCalls=13 peakContext=14 quotaStatus=rejected quotaWindow=weekly quotaUtilization=1 invocation=1$/,
    );
  });

  it("offers one cold correction for a malformed answer", async () => {
    const { sandbox, ctx } = context([
      "<ui-check>PROTOTYPE-NEEDED</ui-check>",
      "<ui-check>CLEAR</ui-check>",
    ]);
    await expect(runUiCheck({ kind: "run-ui-check" }, ctx)).resolves.toMatchObject({
      result: { kind: "CLEAR" },
    });
    expect(sandbox.run).toHaveBeenCalledTimes(2);
    expect(sandbox.run).toHaveBeenNthCalledWith(2, expect.objectContaining({
      name: "ui-check-126-reprompt",
      prompt: expect.stringContaining("provided no `<ui-impact>` block"),
      completionSignal: [],
    }));
  });

  it("treats a second malformed answer as a harness failure", async () => {
    const { ctx } = context(["no token", "still no token"]);
    await expect(runUiCheck({ kind: "run-ui-check" }, ctx)).rejects.toThrow(
      /no valid classification after its one re-prompt/,
    );
  });

  it.each([
    ["committed", () =>
      innerLoopMocks.branchTip
        .mockResolvedValueOnce("tip-a")
        .mockResolvedValueOnce("tip-b")],
    ["dirtied", () =>
      innerLoopMocks.dirtyWorktreePaths
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(["M src/x.ts"])],
    ["moved HEAD", () =>
      innerLoopMocks.symbolicHeadRef
        .mockResolvedValueOnce("refs/heads/sandbar/issue-126")
        .mockResolvedValueOnce(null)],
  ])("parks when the UI checker %s the repository", async (_name, mutate) => {
    const { sandbox, ctx } = context(["<ui-check>CLEAR</ui-check>"]);
    mutate();
    await expect(runUiCheck({ kind: "run-ui-check" }, ctx)).resolves.toMatchObject({
      kind: "ui-checker-wrote",
      detail: expect.stringContaining("UI checker changed git state"),
    });
    expect(sandbox.preserveWorktree).toHaveBeenCalledWith(
      expect.stringContaining("ui checker changed the repository"),
    );
    expect(sandbox.syncBranchToCache).toHaveBeenCalledOnce();
  });

  it("parks a failed invocation that changed the repository and keeps its partial transcript", async () => {
    const { sandbox, ctx } = context([]);
    innerLoopMocks.dirtyWorktreePaths
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["M src/x.ts"]);
    const err = withPartialOutput(
      new Error("disconnected"),
      "partial checker transcript",
    );
    vi.mocked(sandbox.run).mockReset().mockRejectedValueOnce(err);

    await expect(runUiCheck({ kind: "run-ui-check" }, ctx)).resolves.toMatchObject({
      kind: "ui-checker-wrote",
      detail: expect.stringContaining("partial checker transcript"),
    });
    expect(sandbox.preserveWorktree).toHaveBeenCalledWith(
      expect.stringContaining("ui checker changed the repository"),
    );
    expect(sandbox.syncBranchToCache).toHaveBeenCalledOnce();
  });
});

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
    promptExtensions?: Parameters<typeof runImplementer>[1]["config"]["promptExtensions"],
    mismatch: HeadMismatch | null = null,
  ) => {
    innerLoopMocks.headMismatch.mockReset().mockResolvedValue(mismatch);
    innerLoopMocks.fastForwardOffBranchHead.mockReset().mockImplementation(
      async (_path: string, found: HeadMismatch) => ({
        fromSha: found.branchSha,
        toSha: found.headSha,
        commits: [{ sha: found.headSha }],
      }),
    );
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
        maxQualityRounds: 4,
        promptExtensions,
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

  it("hands only the implementer extension to the implementer prompt", async () => {
    innerLoopMocks.buildPrompt.mockClear();
    const implementer = { text: "implementer only" } as const;
    const { pending } = runPath(
      sandboxResult("done", false),
      sandboxResult("unused", false),
      {
        implementer,
        reviewer: { text: "correctness only" },
        reviewerQuality: { text: "quality only" },
        merger: { text: "merger only" },
      },
    );
    await pending;
    expect(innerLoopMocks.buildPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ promptExtension: implementer }),
      expect.anything(),
    );
  });

  it("repairs an ancestor mismatch before building the event and logs the ref move", async () => {
    const mismatch: HeadMismatch = {
      branch: "sandbar/issue-116-silent",
      headRef: null,
      headSha: "head123",
      branchSha: "base456",
      branchIsAncestor: true,
    };
    const { pending, sandbox, lines } = runPath(
      // Off-branch commits are absent from the sandbox's issue-ref capture.
      // The repair range is what makes this COMPLETE valid without a retry.
      sandboxResult("<promise>COMPLETE</promise>", false),
      sandboxResult("unused", false),
      undefined,
      mismatch,
    );

    await expect(pending).resolves.toMatchObject({
      kind: "implementer-result",
      signal: { kind: "COMPLETE" },
      offBranch: null,
      fastForwarded: { fromSha: "base456", toSha: "head123" },
    });
    expect(innerLoopMocks.fastForwardOffBranchHead).toHaveBeenCalledWith(
      "/unused",
      mismatch,
    );
    expect(sandbox.syncBranchToCache).toHaveBeenCalledTimes(2);
    expect(innerLoopMocks.fastForwardOffBranchHead.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sandbox.syncBranchToCache).mock.invocationCallOrder[1]!,
    );
    expect(lines).toContain(
      "issue=116 attempt=1 off-branch-fast-forward from=base456 to=head123",
    );
    expect(lines.at(-1)).toContain("commits=1");
  });

  it("fails the attempt when publishing the repaired tip fails", async () => {
    const mismatch: HeadMismatch = {
      branch: "sandbar/issue-116-silent",
      headRef: null,
      headSha: "head123",
      branchSha: "base456",
      branchIsAncestor: true,
    };
    const { pending, sandbox, lines } = runPath(
      sandboxResult("<promise>COMPLETE</promise>", false),
      sandboxResult("unused", false),
      undefined,
      mismatch,
    );
    const publishError = new Error("cache unavailable");
    vi.mocked(sandbox.syncBranchToCache)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(publishError);

    await expect(pending).rejects.toBe(publishError);
    expect(innerLoopMocks.fastForwardOffBranchHead).toHaveBeenCalledWith(
      "/unused",
      mismatch,
    );
    expect(sandbox.syncBranchToCache).toHaveBeenCalledTimes(2);
    expect(lines).not.toContain(
      "issue=116 attempt=1 off-branch-fast-forward from=base456 to=head123",
    );
  });

  it("reparses a nudge-only COMPLETE after the repair supplies commit evidence", async () => {
    const mismatch: HeadMismatch = {
      branch: "sandbar/issue-116-silent",
      headRef: null,
      headSha: "head123",
      branchSha: "base456",
      branchIsAncestor: true,
    };
    const { pending, sandbox } = runPath(
      sandboxResult("", true),
      sandboxResult("<promise>COMPLETE</promise>", false),
      undefined,
      mismatch,
    );

    await expect(pending).resolves.toMatchObject({
      kind: "implementer-result",
      signal: { kind: "COMPLETE" },
      fastForwarded: { fromSha: "base456", toSha: "head123" },
    });
    expect(sandbox.run).toHaveBeenCalledTimes(2);
  });

  it("leaves a non-ancestor mismatch for the state machine", async () => {
    const mismatch: HeadMismatch = {
      branch: "sandbar/issue-116-silent",
      headRef: null,
      headSha: "older123",
      branchSha: "newer456",
      branchIsAncestor: false,
    };
    const { pending } = runPath(
      sandboxResult("<promise>COMPLETE</promise>", false, ["older123"]),
      sandboxResult("unused", false),
      undefined,
      mismatch,
    );

    await expect(pending).resolves.toMatchObject({
      kind: "implementer-result",
      offBranch: mismatch,
      fastForwarded: null,
    });
    expect(innerLoopMocks.fastForwardOffBranchHead).not.toHaveBeenCalled();
  });
});

describe("role prompt-extension wiring (#91)", () => {
  it("hands the two reviewer extensions independently to the prompt builder", async () => {
    const reviewer = { text: "correctness only" } as const;
    const reviewerQuality = { text: "quality only" } as const;
    const stop = new Error("stop after prompt construction");
    innerLoopMocks.buildReviewerPrompts.mockRejectedValueOnce(stop);
    const ctx = {
      issue: { id: "91", title: "extensions", branch: "sandbar/issue-91" },
      sandbox: { worktreePath: "/worktree" },
      opts: {},
      config: {
        repo: "owner/repo",
        layout: { repoDir: "/repo" },
        sourceBranch: "main",
        claudeMdPath: "CLAUDE.md",
        promptExtensions: {
          implementer: { text: "implementer only" },
          reviewer,
          reviewerQuality,
          merger: { text: "merger only" },
        },
      },
      base: { ref: "origin/main" },
      accumulated: [{ sha: "abc123" }],
      priorReviewRounds: [],
    } as unknown as Parameters<typeof runReviewer>[1];

    await expect(runReviewer({
      kind: "run-gate-and-reviewer",
      attempt: 1,
      reviewRound: 1,
    }, ctx)).rejects.toBe(stop);
    expect(innerLoopMocks.buildReviewerPrompts).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewerPromptExtension: reviewer,
        reviewerQualityPromptExtension: reviewerQuality,
      }),
    );
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
    specGap: null,
  };
  const context = (lines: string[] = []) =>
    ({
      issue: { id: "123" },
      opts: { onOrchestratorLog: (line: string) => lines.push(line) },
      priorReviewRounds: [],
      specGaps: [],
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
    expect(ctx.specGaps).toEqual([]);
  });

  it("accumulates every correctness gap independently of the concurrent gate", async () => {
    const ctx = context();
    const reviewer = {
      ...approved,
      specGap: "Which clock applies? Use the request clock.",
    };
    await runGateAndReviewer(action, ctx, {
      gate: vi.fn(async () => ({ ok: true, failureTrace: "" })),
      reviewer: vi.fn(async () => reviewer),
    });
    expect(ctx.specGaps).toEqual([
      { round: 1, text: "Which clock applies? Use the request clock." },
    ]);
    await runGateAndReviewer({ ...action, reviewRound: 2 }, ctx, {
      gate: vi.fn(async () => ({ ok: true, failureTrace: "" })),
      reviewer: vi.fn(async () => approved),
    });
    expect(ctx.specGaps).toEqual([
      { round: 1, text: "Which clock applies? Use the request clock." },
    ]);

    const redCtx = context();
    await runGateAndReviewer(action, redCtx, {
      gate: vi.fn(async () => ({ ok: false, failureTrace: "red" })),
      reviewer: vi.fn(async () => reviewer),
    });
    expect(redCtx.specGaps).toEqual([
      { round: 1, text: "Which clock applies? Use the request clock." },
    ]);
  });

  it("does not accumulate an empty correctness gap", async () => {
    const ctx = context();
    await runGateAndReviewer(action, ctx, {
      gate: vi.fn(async () => ({ ok: true, failureTrace: "" })),
      reviewer: vi.fn(async () => ({ ...approved, specGap: "" })),
    });
    expect(ctx.specGaps).toEqual([]);
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
        specGaps: [],
      },
      {
        verdict: { type: "HARD-ERROR" as const, reason: "socket refused" },
        accumulatedCommits: [],
        specGaps: [],
      },
      {
        verdict: { type: "DONE" as const, commits: [] },
        accumulatedCommits: [],
        specGaps: [],
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
      ).resolves.toEqual({ type: "DONE", commits: [], specGaps: [] });
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
      specGaps: [],
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
      specGaps: [],
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
      quality: { agent: "codex", modelId: "gpt-5.6-sol", effort: undefined },
      correctness: { agent: "claude", modelId: "opus", effort: undefined },
    });
  });

  // The effort rides the same table (#130), so it cannot be handed to the
  // other pass any more than the model can — and unset stays undefined rather
  // than inheriting the sibling's or a default.
  it("puts each pass's effort beside its own model, absent when unset", () => {
    expect(
      reviewerPassRouting({ ...config, reviewerQualityEffort: "high" }),
    ).toEqual({
      quality: { agent: "codex", modelId: "gpt-5.6-sol", effort: "high" },
      correctness: { agent: "claude", modelId: "opus", effort: undefined },
    });
    expect(
      reviewerPassRouting({ ...config, reviewerEffort: "max" }).correctness.effort,
    ).toBe("max");
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
        "(budgets not consumed)",
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
        "(budgets not consumed)",
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
  over: Partial<ReadOnlyAgentSnapshot> = {},
): ReadOnlyAgentSnapshot => ({
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
    expect(readOnlyAgentSnapshotChanged(snapshot(), after)).toBe(changed);
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
