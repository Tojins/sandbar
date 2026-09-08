import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventInput } from "./events.js";

const seams = vi.hoisted(() => ({
  sandboxRun: vi.fn(),
  createSandbox: vi.fn(),
  dirtyWorktreePaths: vi.fn(async () => [] as string[]),
  ensureIssueBranch: vi.fn(async () => ({
    ref: "origin/main",
    sha: "base-sha",
  })),
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
  ensureIssueBranch: seams.ensureIssueBranch,
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
  startStack: vi.fn(async (opts) => ({
    runGate: vi.fn(async () => ({
      ok: true, stdout: "", stderr: "", exitCode: 0, failedStep: null,
      durationMs: 1, steps: [], containerLogs: "",
    })),
    stop: vi.fn(async () => opts.onContainerTeardown?.({
      name: "gate-db", container: "gate-db-1", lifecycle: "issue",
      durationMs: 10, peakMemoryBytes: 1000, oomKilled: false,
    })),
  })),
}));

vi.mock("./sandbox-stack.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sandbox-stack.js")>(),
  prepareSandboxLogDir: vi.fn(async () => "/tmp/issue-109-logs"),
  sandboxContainers: vi.fn(() => []),
  startSandboxStack: vi.fn(async (opts) => ({
    statuses: [],
    stop: vi.fn(async () => opts.onContainerTeardown?.({
      name: "sandbox-db", container: "sandbox-db-1", lifecycle: "attempt",
      durationMs: 20, peakMemoryBytes: 2000, oomKilled: true,
    })),
  })),
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

import { AgentCredentialError, AgentQuotaError } from "./agent-sandbox.js";
import {
  createRunProviderState,
  runInnerLoop as runInnerLoopActual,
  type InnerLoopConfig,
  type InnerLoopOptions,
} from "./inner-loop.js";
import { createAgentInvocationSequencer } from "./logs.js";
import type { PlannedIssue } from "./plan-resolver.js";
import { sandboxContainers } from "./sandbox-stack.js";

const issue = (id: string): PlannedIssue => ({
  id,
  title: `Issue ${id}`,
  branch: `sandbar/issue-${id}-quota-test`,
  chunk: null,
});

const runInnerLoop = (
  plannedIssue: PlannedIssue,
  opts: Omit<InnerLoopOptions, "attemptLogger">,
) => {
  const invocationSequencer = createAgentInvocationSequencer();
  return runInnerLoopActual(plannedIssue, {
    ...opts,
    attemptLogger: {
      writeInvocation: vi.fn(),
      startInvocationCycle: () => invocationSequencer.startCycle(),
    },
  });
};

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
  maxQualityRounds: 1,
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
    seams.ensureIssueBranch.mockReset().mockResolvedValue({
      ref: "origin/main",
      sha: "base-sha",
    });
    seams.dirtyWorktreePaths.mockReset().mockResolvedValue([]);
    seams.preserveWorktree.mockReset();
    seams.createSandbox.mockReset().mockImplementation(async (opts) => {
      await opts.beforeSandboxReady?.("sandbox");
      return {
        run: seams.sandboxRun,
        syncBranchToCache: vi.fn(async () => undefined),
        preserveWorktree: seams.preserveWorktree,
        close: vi.fn(),
        containerName: "sandbox",
        branch: "test",
        worktreePath: "/tmp/issue-109-worktree",
      };
    });
  });

  it("keeps credential as the provider's highest-priority closure cause", () => {
    const state = createRunProviderState();
    state.closeQuota("codex", { status: "rejected", window: "five_hour" });
    state.closeCredential("refresh refused");
    state.closeQuota("codex", { status: "rejected", window: "seven_day" });
    expect(state.get("codex")).toEqual({
      cause: "credential",
      detail: "refresh refused",
    });
  });

  it("records branch abandonment as origin synchronization, not a fast-forward repair", async () => {
    const events: EventInput[] = [];
    seams.ensureIssueBranch.mockResolvedValueOnce({
      ref: "origin/main",
      sha: "base-sha",
      originSync: { kind: "abandoned", tip: "abcdef123456" },
    });
    seams.sandboxRun.mockResolvedValueOnce({
      stdout: "<promise>NEEDS-INFO</promise><questions>Which environment?</questions>",
      headBefore: "base-sha",
      headAfter: "base-sha",
      signalMs: 1,
      maxGapMs: 1,
      toolCalls: 0,
      peakContext: 1,
      commits: [],
    });

    await expect(runInnerLoop(issue("132"), {
      config: config("claude"), hooks: {}, copyToWorktree: [],
      onEvent: (event) => events.push(event),
    })).resolves.toMatchObject({ type: "NEEDS-INFO" });

    expect(events.filter((event) => event.kind === "origin-sync")).toEqual([{
      kind: "origin-sync",
      issue: 132,
      title: "Issue 132",
      outcome: "abandoned",
      detail: expect.stringContaining("abandoned"),
    }]);
    expect(events.filter((event) =>
      event.kind === "repair" && event.action === "fast-forward")).toEqual([]);
  });

  it("logs the larger peak context across an implementer and its promise nudge", async () => {
    const events: EventInput[] = [];
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
      onEvent: (event) => events.push(event),
    })).resolves.toMatchObject({ type: "NEEDS-INFO" });

    expect(events.filter((event) => event.kind === "implementer")).toEqual([{
      kind: "implementer", issue: 124, title: "Issue 124", attempt: 1,
      signal: "NEEDS-INFO", commits: 0, provider: "claude", model: "model",
      effort: null, durationMs: expect.any(Number), signalMs: 1, maxGapMs: 1,
      usage: { toolCalls: 3, peakContext: 41 },
    }]);
  });

  it("attributes gate and sandbox sibling teardown evidence to the issue", async () => {
    const events: EventInput[] = [];
    vi.mocked(sandboxContainers).mockReturnValueOnce([{} as never]);
    seams.sandboxRun.mockResolvedValueOnce({
      stdout: "<promise>NEEDS-INFO</promise><questions>Which?</questions>",
      headBefore: "base-sha",
      headAfter: "base-sha",
      signalMs: 1,
      maxGapMs: 1,
      toolCalls: 0,
      commits: [],
    });

    await expect(runInnerLoop(issue("141"), {
      config: config("claude"), hooks: {}, copyToWorktree: [],
      onEvent: (event) => events.push(event),
    })).resolves.toMatchObject({ type: "NEEDS-INFO" });

    expect(events.filter((event) => event.kind === "container")).toEqual([
      expect.objectContaining({
        kind: "container", stack: "gate", issue: 141, title: "Issue 141",
        name: "gate-db", peakMemoryBytes: 1000, oomKilled: false,
      }),
      expect.objectContaining({
        kind: "container", stack: "sandbox", issue: 141, title: "Issue 141",
        name: "sandbox-db", peakMemoryBytes: 2000, oomKilled: true,
      }),
    ]);
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
        onEvent: () => undefined,
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
    const events: EventInput[] = [];
    const state = createRunProviderState();
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
      providerState: state, onEvent: (event) => events.push(event),
    })).resolves.toEqual({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
      specGaps: [],
    });
    expect(seams.createSandbox).toHaveBeenCalledOnce();
    expect(seams.sandboxRun).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.kind === "ui-check")).toEqual([{
      kind: "ui-check", issue: 127, title: "Issue 127", invocation: 1,
      provider: "claude", model: "model", effort: null,
      durationMs: expect.any(Number), result: "quota", usage: { quota: measurement },
    }]);

    await expect(runInnerLoop(issue("128"), {
      config: config("codex", true, "claude"), hooks: {}, copyToWorktree: [],
      providerState: state, onEvent: () => undefined,
    })).resolves.toMatchObject({ type: "QUOTA", provider: "claude" });
    expect(seams.createSandbox).toHaveBeenCalledTimes(2);
    expect(seams.sandboxRun).toHaveBeenCalledOnce();
  });

  it("closes a refused UI-check credential after one invocation", async () => {
    const events: EventInput[] = [];
    const state = createRunProviderState();
    const detail = "Your access token could not be refreshed. Please log out and sign in again.";
    const codexAuthMount = {
      hostPath: "/tmp/run/codex-auth.json",
      sandboxPath: "/home/agent/.codex/auth.json",
    };
    seams.sandboxRun.mockRejectedValueOnce(new AgentCredentialError(detail));

    await expect(runInnerLoop(issue("134"), {
      config: { ...config("claude", true, "codex"), codexAuthMount },
      hooks: {}, copyToWorktree: [], providerState: state,
      onEvent: (event) => events.push(event),
    })).resolves.toEqual({
      type: "CREDENTIAL", provider: "codex", detail, specGaps: [],
    });

    expect(seams.sandboxRun).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.kind === "ui-check")).toEqual([{
      kind: "ui-check", issue: 134, title: "Issue 134", invocation: 1,
      provider: "codex", model: "model", effort: null,
      durationMs: expect.any(Number), result: "credential",
    }]);
    expect(state.get("codex")).toEqual({ cause: "credential", detail });
  });

  it("logs peak context for successful and failed reviewer invocations", async () => {
    const events: EventInput[] = [];
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
      onEvent: (event) => events.push(event),
    })).resolves.toMatchObject({ type: "DONE" });

    const passes = events.filter((event) => event.kind === "review-pass");
    expect(passes).toEqual([
      {
        kind: "review-pass", issue: 125, title: "Issue 125", attempt: 1, round: 1,
        pass: "quality", invocation: 1, provider: "claude", model: "model",
        effort: null, result: "failed", durationMs: expect.any(Number),
        usage: { inputTokens: 7, toolCalls: 2, peakContext: 52 },
      },
      {
        kind: "review-pass", issue: 125, title: "Issue 125", attempt: 1, round: 1,
        pass: "quality", invocation: 2, provider: "claude", model: "model",
        effort: null, result: "completed", durationMs: expect.any(Number), maxGapMs: 2,
        usage: { toolCalls: 3, peakContext: 61 },
      },
      {
        kind: "review-pass", issue: 125, title: "Issue 125", attempt: 1, round: 1,
        pass: "correctness", invocation: 1, provider: "claude", model: "model",
        effort: null, result: "completed", durationMs: expect.any(Number), maxGapMs: 2,
        usage: { toolCalls: 4, peakContext: 73 },
      },
    ]);
    expect(events.filter((event) => event.kind === "phase")).toEqual([
      { kind: "phase", issue: 125, title: "Issue 125", attempt: 1, phases: ["implementer"] },
      { kind: "phase", issue: 125, title: "Issue 125", attempt: 1, phases: ["gate-1", "review"] },
      { kind: "phase", issue: 125, title: "Issue 125", attempt: 1, phases: [] },
    ]);
    expect(events.filter((event) => event.kind === "review-round")).toEqual([{
      kind: "review-round", issue: 125, title: "Issue 125", attempt: 1, round: 1,
      head: "implemented-sha", qualityMode: "list", gateOk: true,
      quality: "APPROVED", correctness: "APPROVED", rejectingPass: null,
      qualityFailures: 0, correctnessFailures: 0, durationMs: expect.any(Number),
    }]);
  });

  it("surfaces quota without a fresh-sandbox retry and closes only that provider", async () => {
    const events: EventInput[] = [];
    const state = createRunProviderState();
    const measurement = {
      status: "rejected" as const,
      window: "five_hour",
      resetsAt: 42,
    };
    seams.sandboxRun.mockRejectedValueOnce(new AgentQuotaError("claude", measurement));

    await expect(runInnerLoop(issue("109"), {
      config: config("claude"), hooks: {}, copyToWorktree: [], providerState: state,
      onEvent: (event) => events.push(event),
    })).resolves.toEqual({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
      specGaps: [],
    });
    expect(seams.createSandbox).toHaveBeenCalledOnce();
    expect(seams.sandboxRun).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.kind === "implementer")).toEqual([{
      kind: "implementer", issue: 109, title: "Issue 109", attempt: 1,
      signal: "QUOTA", commits: 0, provider: "claude", model: "model",
      effort: null, durationMs: expect.any(Number), usage: { quota: measurement },
    }]);

    await expect(runInnerLoop(issue("110"), {
      config: config("claude"), hooks: {}, copyToWorktree: [], providerState: state,
      onEvent: () => undefined,
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
      config: config("codex"), hooks: {}, copyToWorktree: [], providerState: state,
      onEvent: () => undefined,
    })).resolves.toMatchObject({ type: "NEEDS-INFO" });
    expect(seams.sandboxRun).toHaveBeenCalledTimes(2);
  });

  it("surfaces a permanent credential refusal once and blocks later provider calls", async () => {
    const events: EventInput[] = [];
    const state = createRunProviderState();
    const detail = "Your access token could not be refreshed. Please log out and sign in again.";
    const codexAuthMount = {
      hostPath: "/tmp/run/codex-auth.json",
      sandboxPath: "/home/agent/.codex/auth.json",
    };
    seams.sandboxRun.mockRejectedValueOnce(new AgentCredentialError(detail));

    await expect(runInnerLoop(issue("134"), {
      config: { ...config("codex"), codexAuthMount },
      hooks: {}, copyToWorktree: [], providerState: state,
      onEvent: (event) => events.push(event),
    })).resolves.toEqual({
      type: "CREDENTIAL", provider: "codex", detail, specGaps: [],
    });
    expect(seams.createSandbox).toHaveBeenCalledOnce();
    expect(seams.createSandbox).toHaveBeenCalledWith(expect.objectContaining({
      extraMounts: [codexAuthMount],
    }));
    expect(seams.sandboxRun).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.kind === "implementer")).toEqual([{
      kind: "implementer", issue: 134, title: "Issue 134", attempt: 1,
      signal: "CREDENTIAL", commits: 0, provider: "codex", model: "model",
      effort: null, durationMs: expect.any(Number),
    }]);

    await expect(runInnerLoop(issue("135"), {
      config: { ...config("codex"), codexAuthMount },
      hooks: {}, copyToWorktree: [], providerState: state,
      onEvent: () => undefined,
    })).resolves.toEqual({
      type: "CREDENTIAL", provider: "codex", detail, specGaps: [],
    });
    expect(seams.sandboxRun).toHaveBeenCalledOnce();
  });

  it("surfaces reviewer quota after one invocation without the reviewer retry", async () => {
    const events: EventInput[] = [];
    const state = createRunProviderState();
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
      config: config("codex"), hooks: {}, copyToWorktree: [], providerState: state,
      onEvent: (event) => events.push(event),
    })).resolves.toEqual({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
      specGaps: [],
    });
    expect(seams.sandboxRun).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.kind === "review-pass")).toEqual([{
      kind: "review-pass", issue: 112, title: "Issue 112", attempt: 1, round: 1,
      pass: "quality", invocation: 1, provider: "claude", model: "model",
      effort: null, result: "quota", durationMs: expect.any(Number),
      usage: { quota: measurement },
    }]);

    await expect(runInnerLoop(issue("113"), {
      config: config("claude"), hooks: {}, copyToWorktree: [], providerState: state,
      onEvent: () => undefined,
    })).resolves.toEqual({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
      specGaps: [],
    });
    expect(seams.sandboxRun).toHaveBeenCalledTimes(2);
  });

  it("closes a refused reviewer credential without a harness retry", async () => {
    const events: EventInput[] = [];
    const state = createRunProviderState();
    const detail = "Your access token could not be refreshed. Please log out and sign in again.";
    const codexAuthMount = {
      hostPath: "/tmp/run/codex-auth.json",
      sandboxPath: "/home/agent/.codex/auth.json",
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
      .mockRejectedValueOnce(new AgentCredentialError(detail));

    await expect(runInnerLoop(issue("136"), {
      config: {
        ...config("claude"),
        reviewerQualityAgent: "codex",
        codexAuthMount,
      },
      hooks: {}, copyToWorktree: [], providerState: state,
      onEvent: (event) => events.push(event),
    })).resolves.toEqual({
      type: "CREDENTIAL", provider: "codex", detail, specGaps: [],
    });

    expect(seams.sandboxRun).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.kind === "review-pass")).toEqual([{
      kind: "review-pass", issue: 136, title: "Issue 136", attempt: 1, round: 1,
      pass: "quality", invocation: 1, provider: "codex", model: "model",
      effort: null, result: "credential", durationMs: expect.any(Number),
    }]);
    expect(state.get("codex")).toEqual({ cause: "credential", detail });
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
      providerState: createRunProviderState(), onEvent: () => undefined,
    })).resolves.toMatchObject({ type: "NEEDS-HUMAN-REVIEW" });
    expect(seams.preserveWorktree).toHaveBeenCalledOnce();
    expect(seams.sandboxRun).toHaveBeenCalledTimes(2);
  });
});
