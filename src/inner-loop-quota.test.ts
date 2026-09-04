import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  sandboxRun: vi.fn(),
  createSandbox: vi.fn(),
  dirtyWorktreePaths: vi.fn(async () => [] as string[]),
  preserveWorktree: vi.fn(),
  partialUsage: new WeakMap<object, {
    usage?: { inputTokens?: number };
    toolCalls?: number;
    peakContext?: number;
  }>(),
}));

vi.mock("./git-ops.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./git-ops.js")>(),
  dirtyWorktreePaths: seams.dirtyWorktreePaths,
  headMismatch: vi.fn(async () => null),
  branchTip: vi.fn(async () => "implemented-sha"),
  symbolicHeadRef: vi.fn(async () => "refs/heads/test"),
  ensureIssueBranch: vi.fn(async () => ({
    ref: "origin/main",
    sha: "base-sha",
  })),
}));

vi.mock("./agent-sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-sandbox.js")>();
  return {
    ...actual,
    prepareWorktree: vi.fn(async () => "/tmp/issue-109-worktree"),
    createSandbox: seams.createSandbox,
    agentPartialUsage: (err: unknown) =>
      typeof err === "object" && err !== null
        ? seams.partialUsage.get(err) ?? actual.agentPartialUsage(err)
        : {},
  };
});

vi.mock("./gate-stack.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./gate-stack.js")>(),
  startStack: vi.fn(async () => ({
    runGate: vi.fn(async () => ({
      ok: true, stdout: "", stderr: "", exitCode: 0, failedStep: null,
      durationMs: 1, steps: [], containerLogs: "",
    })),
    stop: vi.fn(),
  })),
}));

vi.mock("./sandbox-stack.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sandbox-stack.js")>(),
  prepareSandboxLogDir: vi.fn(async () => "/tmp/issue-109-logs"),
  sandboxContainers: vi.fn(() => []),
  startSandboxStack: vi.fn(async () => ({ statuses: [], stop: vi.fn() })),
}));

vi.mock("./agent-tools.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./agent-tools.js")>(),
  resolveSandboxImage: vi.fn(async () => "test-agent-image"),
}));

vi.mock("./prompt.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./prompt.js")>(),
  buildPrompt: vi.fn(async () => "implement"),
  buildUiCheckPrompt: vi.fn(async () => "ui check"),
  buildReviewerPrompts: vi.fn(async () => ({
    quality: "quality review",
    correctness: "correctness review",
  })),
}));

import { AgentQuotaError } from "./agent-sandbox.js";
import {
  createRunQuotaState,
  runInnerLoop,
  type InnerLoopConfig,
} from "./inner-loop.js";
import type { PlannedIssue } from "./plan-resolver.js";

const issue = (id: string): PlannedIssue => ({
  id,
  title: `Issue ${id}`,
  branch: `sandbar/issue-${id}-quota-test`,
  chunk: null,
});

const config = (
  implementerAgent: "claude" | "codex",
  uiPrototypeCheck = false,
  uiCheckAgent: "claude" | "codex" = implementerAgent,
): InnerLoopConfig => ({
  layout: {
    cwd: "/tmp",
    workDir: "/tmp/.sandbar",
    stateDir: "/tmp/.sandbar",
    repoDir: "/tmp/.sandbar/repo.git",
    worktreesDir: "/tmp/.sandbar/worktrees",
    issueClonesDir: "/tmp/.sandbar/issues",
    logsDir: "/tmp/.sandbar/logs",
  },
  repo: { owner: "o", name: "r" },
  sourceBranch: "main",
  env: {},
  implementerModelId: "model",
  uiPrototypeCheck,
  uiCheckModelId: "model",
  reviewerModelId: "model",
  reviewerQualityModelId: "model",
  implementerAgent,
  uiCheckAgent,
  reviewerAgent: "claude",
  reviewerQualityAgent: "claude",
  maxImplAttempts: 1,
  maxReviewRounds: 1,
  sandboxImage: "image",
  agentImages: {
    declaredTag: "image",
    resolve: vi.fn(async () => "image"),
    builtTags: vi.fn(() => new Set<string>()),
  },
  scope: { id: "12345678", prefix: "sandbar-w12345678" },
  gateStack: { containers: [], steps: [] },
  claudeMdPath: "CLAUDE.md",
});

describe("runInnerLoop run-scoped quota closure (#109)", () => {
  beforeEach(() => {
    seams.sandboxRun.mockReset();
    seams.dirtyWorktreePaths.mockReset().mockResolvedValue([]);
    seams.preserveWorktree.mockReset();
    seams.createSandbox.mockReset().mockImplementation(async () => ({
      run: seams.sandboxRun,
      syncBranchToCache: vi.fn(async () => undefined),
      preserveWorktree: seams.preserveWorktree,
      close: vi.fn(),
      containerName: "sandbox",
      branch: "test",
      worktreePath: "/tmp/issue-109-worktree",
    }));
  });

  it("logs the larger peak context across an implementer and its promise nudge", async () => {
    const lines: string[] = [];
    seams.sandboxRun
      .mockResolvedValueOnce({
        stdout: "I need one detail.",
        headBefore: "base-sha",
        headAfter: "base-sha",
        signalMs: 1,
        maxGapMs: 1,
        toolCalls: 2,
        peakContext: 18,
        commits: [],
      })
      .mockResolvedValueOnce({
        stdout: "<promise>NEEDS-INFO</promise><questions>Which?</questions>",
        headBefore: "base-sha",
        headAfter: "base-sha",
        signalMs: 1,
        maxGapMs: 1,
        toolCalls: 1,
        peakContext: 41,
        commits: [],
      });

    await expect(runInnerLoop(issue("124"), {
      config: config("claude"), hooks: {}, copyToWorktree: [],
      onOrchestratorLog: (line) => lines.push(line),
    })).resolves.toMatchObject({ type: "NEEDS-INFO" });

    expect(lines.find((line) => line.includes(" implementer signal="))).toContain(
      "toolCalls=3 peakContext=41",
    );
  });

  it("runs the enabled UI check before attempt 1 and again after a fresh HARD-ERROR cycle", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    seams.sandboxRun
      .mockResolvedValueOnce({
        stdout: "no token",
        commits: [],
        silent: false,
        maxGapMs: 1,
        toolCalls: 0,
      })
      .mockResolvedValueOnce({
        stdout: "still no token",
        commits: [],
        silent: false,
        maxGapMs: 1,
        toolCalls: 0,
      })
      .mockResolvedValueOnce({
        stdout: "<ui-check>CLEAR</ui-check>",
        commits: [],
        silent: false,
        maxGapMs: 1,
        toolCalls: 0,
      })
      .mockResolvedValueOnce({
        stdout: "<promise>NEEDS-INFO</promise><questions>Which?</questions>",
        headBefore: "base-sha",
        headAfter: "base-sha",
        signalMs: 1,
        commits: [],
        silent: false,
        maxGapMs: 1,
        toolCalls: 0,
      });

    try {
      await expect(runInnerLoop(issue("126"), {
        config: config("codex", true), hooks: {}, copyToWorktree: [],
      })).resolves.toMatchObject({ type: "NEEDS-INFO" });
    } finally {
      stderr.mockRestore();
    }

    expect(seams.createSandbox).toHaveBeenCalledTimes(2);
    expect(seams.sandboxRun.mock.calls.map(([options]) => options.name)).toEqual([
      "ui-check-126",
      "ui-check-126-reprompt",
      "ui-check-126",
      "implementer-126-attempt-1",
    ]);
  });

  it("closes UI-check quota, surfaces QUOTA, and never invokes a closed provider", async () => {
    const state = createRunQuotaState();
    const measurement = {
      status: "rejected" as const,
      window: "five_hour",
      resetsAt: 42,
    };
    seams.sandboxRun.mockRejectedValueOnce(
      new AgentQuotaError("claude", measurement),
    );

    await expect(runInnerLoop(issue("127"), {
      config: config("codex", true, "claude"), hooks: {}, copyToWorktree: [],
      quotaState: state,
    })).resolves.toEqual({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
      specGaps: [],
    });
    expect(seams.createSandbox).toHaveBeenCalledOnce();
    expect(seams.sandboxRun).toHaveBeenCalledOnce();

    await expect(runInnerLoop(issue("128"), {
      config: config("codex", true, "claude"), hooks: {}, copyToWorktree: [],
      quotaState: state,
    })).resolves.toMatchObject({ type: "QUOTA", provider: "claude" });
    expect(seams.createSandbox).toHaveBeenCalledTimes(2);
    expect(seams.sandboxRun).toHaveBeenCalledOnce();
  });

  it("logs peak context for successful and failed reviewer invocations", async () => {
    const lines: string[] = [];
    const reviewerFailure = new Error("reviewer disconnected");
    seams.partialUsage.set(reviewerFailure, {
      usage: { inputTokens: 7 }, toolCalls: 2, peakContext: 52,
    });
    seams.sandboxRun
      .mockResolvedValueOnce({
        stdout: "<promise>COMPLETE</promise>",
        headBefore: "base-sha",
        headAfter: "implemented-sha",
        signalMs: 1,
        maxGapMs: 1,
        toolCalls: 1,
        peakContext: 23,
        commits: [{ sha: "implemented-sha" }],
      })
      .mockRejectedValueOnce(reviewerFailure)
      .mockResolvedValueOnce({
        stdout: "<verdict>APPROVED</verdict>",
        maxGapMs: 2,
        toolCalls: 3,
        peakContext: 61,
        commits: [],
      })
      .mockResolvedValueOnce({
        stdout: "<verdict>APPROVED</verdict>",
        maxGapMs: 2,
        toolCalls: 4,
        peakContext: 73,
        commits: [],
      });

    await expect(runInnerLoop(issue("125"), {
      config: config("codex"), hooks: {}, copyToWorktree: [],
      onOrchestratorLog: (line) => lines.push(line),
    })).resolves.toMatchObject({ type: "DONE" });

    expect(lines.find((line) => line.includes("pass=quality invocation=1 "))).toContain(
      "tokens=in:7 toolCalls=2 peakContext=52",
    );
    expect(lines.find((line) => line.includes("pass=quality invocation=2 "))).toContain(
      "toolCalls=3 peakContext=61",
    );
    expect(lines.find((line) => line.includes("pass=correctness invocation=1 "))).toContain(
      "toolCalls=4 peakContext=73",
    );
  });

  it("surfaces quota without a fresh-sandbox retry and closes only that provider", async () => {
    const state = createRunQuotaState();
    const measurement = {
      status: "rejected" as const,
      window: "five_hour",
      resetsAt: 42,
    };
    seams.sandboxRun.mockRejectedValueOnce(new AgentQuotaError("claude", measurement));

    await expect(runInnerLoop(issue("109"), {
      config: config("claude"), hooks: {}, copyToWorktree: [], quotaState: state,
    })).resolves.toEqual({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
      specGaps: [],
    });
    expect(seams.createSandbox).toHaveBeenCalledOnce();
    expect(seams.sandboxRun).toHaveBeenCalledOnce();

    await expect(runInnerLoop(issue("110"), {
      config: config("claude"), hooks: {}, copyToWorktree: [], quotaState: state,
    })).resolves.toEqual({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
      specGaps: [],
    });
    expect(seams.sandboxRun).toHaveBeenCalledOnce();

    seams.sandboxRun.mockResolvedValueOnce({
      stdout: "<promise>NEEDS-INFO</promise><questions>Which?</questions>",
      headBefore: "a",
      headAfter: "a",
      signalMs: 1,
      maxGapMs: 1,
      toolCalls: 0,
      commits: [],
    });
    await expect(runInnerLoop(issue("111"), {
      config: config("codex"), hooks: {}, copyToWorktree: [], quotaState: state,
    })).resolves.toMatchObject({ type: "NEEDS-INFO" });
    expect(seams.sandboxRun).toHaveBeenCalledTimes(2);
  });

  it("surfaces reviewer quota after one invocation without the reviewer retry", async () => {
    const state = createRunQuotaState();
    const measurement = {
      status: "rejected" as const,
      window: "five_hour",
      resetsAt: 42,
    };
    seams.sandboxRun
      .mockResolvedValueOnce({
        stdout: "<promise>COMPLETE</promise>",
        headBefore: "base-sha",
        headAfter: "implemented-sha",
        signalMs: 1,
        maxGapMs: 1,
        toolCalls: 0,
        commits: [{ sha: "implemented-sha" }],
      })
      .mockRejectedValueOnce(new AgentQuotaError("claude", measurement));

    await expect(runInnerLoop(issue("112"), {
      config: config("codex"), hooks: {}, copyToWorktree: [], quotaState: state,
    })).resolves.toEqual({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
      specGaps: [],
    });
    expect(seams.sandboxRun).toHaveBeenCalledTimes(2);

    await expect(runInnerLoop(issue("113"), {
      config: config("claude"), hooks: {}, copyToWorktree: [], quotaState: state,
    })).resolves.toEqual({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
      specGaps: [],
    });
    expect(seams.sandboxRun).toHaveBeenCalledTimes(2);
  });

  it("preserves reviewer writes even when that invocation closes quota", async () => {
    const measurement = {
      status: "rejected" as const,
      window: "five_hour",
      resetsAt: 42,
    };
    seams.sandboxRun
      .mockResolvedValueOnce({
        stdout: "<promise>COMPLETE</promise>",
        headBefore: "base-sha",
        headAfter: "implemented-sha",
        signalMs: 1,
        maxGapMs: 1,
        toolCalls: 0,
        commits: [{ sha: "implemented-sha" }],
      })
      .mockRejectedValueOnce(new AgentQuotaError("claude", measurement));
    seams.dirtyWorktreePaths.mockResolvedValueOnce([]).mockResolvedValueOnce(["review.txt"]);

    await expect(runInnerLoop(issue("114"), {
      config: config("codex"), hooks: {}, copyToWorktree: [],
      quotaState: createRunQuotaState(),
    })).resolves.toMatchObject({ type: "NEEDS-HUMAN-REVIEW" });
    expect(seams.preserveWorktree).toHaveBeenCalledOnce();
    expect(seams.sandboxRun).toHaveBeenCalledTimes(2);
  });
});
