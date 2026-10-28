import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventInput } from "./events.js";

const seams = vi.hoisted(() => ({
  sandboxRun: vi.fn(),
  createSandbox: vi.fn(),
  prepareWorktree: vi.fn(async () => "/tmp/issue-109-worktree"),
  dirtyWorktreePaths: vi.fn(async () => [] as string[]),
  ensureIssueBranch: vi.fn(async () => ({
    ref: "origin/main",
    sha: "base-sha",
  })),
  branchCommitsSinceSeed: vi.fn(async () => [] as { sha: string }[]),
  branchIsAheadOfSeed: vi.fn(async () => false),
  measureNetDiffChars: vi.fn(async () => 0),
  preserveWorktree: vi.fn(),
  deferWorktreeReclaim: vi.fn(),
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
  settleQualityResidue: vi.fn(async () => ({
    commits: [],
    residue: { dirtyPaths: [], strandedHead: null, rewoundTip: null },
  })),
  branchCommitsSinceSeed: seams.branchCommitsSinceSeed,
  ensureIssueBranch: seams.ensureIssueBranch,
  revParse: vi.fn(async () => "seed-sha"),
}));

vi.mock("./issue-anchor.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./issue-anchor.js")>(),
  fetchIssueAnchor: vi.fn(async () => ({
    text: "Issue #1: Issue",
    json: { title: "Issue", body: "", comments: [] },
    key: "key",
    cache: { kind: "miss", problem: null },
    rawChars: 15,
    tracedChars: 15,
  })),
}));

vi.mock("./agent-sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-sandbox.js")>();
  return {
    ...actual,
    prepareWorktree: seams.prepareWorktree,
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
  buildQualityReviewPrompt: vi.fn(async () => "quality review"),
  buildQualityFixPrompt: vi.fn(async () => "quality fix"),
  buildCorrectnessPrompt: vi.fn(async () => "correctness review"),
  branchIsAheadOfSeed: seams.branchIsAheadOfSeed,
  measureNetDiffChars: seams.measureNetDiffChars,
}));

import { AgentCredentialError, AgentQuotaError } from "./agent-sandbox.js";
import {
  createRunProviderState,
  runInnerLoop as runInnerLoopActual,
  type InnerLoopConfig,
  type InnerLoopOptions,
} from "./inner-loop.js";
import { createAgentInvocationSequencer } from "./logs.js";
import { createGateSemaphore } from "./gate-semaphore.js";
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
  opts: Omit<InnerLoopOptions, "attemptLogger" | "gateSemaphore">,
) => {
  const invocationSequencer = createAgentInvocationSequencer();
  return runInnerLoopActual(plannedIssue, {
    ...opts,
    attemptLogger: {
      writeInvocation: vi.fn(),
      writeGate: vi.fn(),
      writeIssueSnapshot: vi.fn(async () => "issue-snapshot-1.json"),
      startInvocationCycle: () => invocationSequencer.startCycle(),
    },
    gateSemaphore: createGateSemaphore(undefined),
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
    anchorCacheDir: "/tmp/.sandbar/anchor-cache",
  },
  issueSource: async () => ({ title: "Issue", body: "", comments: [] }),
  repo: { owner: "o", name: "r" },
  sourceBranch: "main",
  env: {},
  implementerModelId: "model",
  uiPrototypeCheck,
  uiCheckModelId: "model",
  reviewerModelId: "model",
  reviewerQualityModelId: "model",
  implementerAgent,
  partitionCheck: false,
  condenseAboveChars: 20_000,
  maxContextChars: 600_000,
  uiCheckAgent,
  reviewerAgent: "claude",
  reviewerQualityAgent: "claude",
  maxQualityRounds: 1,
  maxGateRounds: 1,
  maxReviewRounds: 1,
  sandboxImage: "image",
  agentImages: {
    declaredTag: "image",
    resolve: vi.fn(async () => "image"),
    builtTags: vi.fn(() => new Set<string>()),
  },
  scope: { id: "12345678", prefix: "sandbar-w12345678" },
  egress: null,
  claudeMdPath: "CLAUDE.md",
  botName: "sandbar-bot",
  botEmail: "bot@example.test",
});

const emptyStack = {
  stack: { containers: [], steps: [] },
  attachments: { env: {}, mounts: [] },
};
const stackSource = {
  current: async () => emptyStack,
  accepted: () => emptyStack,
  path: null,
  forHead: async () => ({ ...emptyStack, classification: { kind: "same" }, tipBlob: null }),
};

// A quality lister that approves the branch outright (#187).
const listerRun = {
  stdout: "<verdict>APPROVED</verdict>",
  durationMs: 5,
  maxGapMs: 1,
  toolCalls: 2,
  peakContext: 40,
  commits: [],
};
// A quality lister that hands the fixer a report.
const rejectingListerRun = { ...listerRun, stdout: "### Tests\nx\n<verdict>CHANGES-REQUESTED</verdict>" };

describe("runInnerLoop run-scoped quota closure (#109)", () => {
  beforeEach(() => {
    seams.sandboxRun.mockReset();
    seams.prepareWorktree.mockReset().mockResolvedValue("/tmp/issue-109-worktree");
    seams.ensureIssueBranch.mockReset().mockResolvedValue({
      ref: "origin/main",
      sha: "base-sha",
    });
    seams.branchIsAheadOfSeed.mockReset().mockResolvedValue(false);
    seams.branchCommitsSinceSeed.mockReset().mockResolvedValue([]);
    seams.measureNetDiffChars.mockReset().mockResolvedValue(0);
    seams.dirtyWorktreePaths.mockReset().mockResolvedValue([]);
    seams.preserveWorktree.mockReset();
    seams.deferWorktreeReclaim.mockReset();
    seams.createSandbox.mockReset().mockImplementation(async (opts) => {
      await opts.beforeSandboxReady?.("sandbox");
      return {
        run: seams.sandboxRun,
        syncBranchToCache: vi.fn(async () => undefined),
        preserveWorktree: seams.preserveWorktree,
        deferWorktreeReclaim: seams.deferWorktreeReclaim,
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
      config: config("claude"), hooks: {}, stackSource, copyToWorktree: [],
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
    expect(seams.deferWorktreeReclaim).toHaveBeenCalledOnce();
  });

  it("forwards mixed resolved copy entries to worktree preparation", async () => {
    const copyToWorktree = [
      ".npmrc",
      { from: "/opt/sandbar/settings.json", to: ".codex/settings.json" },
    ] as const;
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

    await expect(runInnerLoop(issue("147"), {
      config: config("claude"), hooks: {}, stackSource, copyToWorktree,
      onEvent: () => undefined,
    })).resolves.toMatchObject({ type: "NEEDS-INFO" });

    expect(seams.prepareWorktree).toHaveBeenCalledWith(expect.objectContaining({
      copyToWorktree: [...copyToWorktree],
    }));
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
      config: config("claude"), hooks: {}, stackSource, copyToWorktree: [],
      onEvent: (event) => events.push(event),
    })).resolves.toMatchObject({ type: "NEEDS-INFO" });

    expect(events.filter((event) => event.kind === "implementer")).toEqual([{
      kind: "implementer", issue: 124, title: "Issue 124", attempt: 1,
      signal: "NEEDS-INFO", commits: 0, provider: "claude", model: "model",
      effort: null, durationMs: expect.any(Number), signalMs: 1, maxGapMs: 1,
      transcript: "attempt-1.log",
      usage: { toolCalls: 3, peakContext: 41, contextChars: 9 },
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
      config: config("claude"), hooks: {}, stackSource, copyToWorktree: [],
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
        config: config("codex", true), hooks: {}, stackSource, copyToWorktree: [],
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
      config: config("codex", true, "claude"), hooks: {}, stackSource, copyToWorktree: [],
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
      transcript: "ui-check-1.log",
      durationMs: expect.any(Number), result: "quota", usage: { quota: measurement },
    }]);

    await expect(runInnerLoop(issue("128"), {
      config: config("codex", true, "claude"), hooks: {}, stackSource, copyToWorktree: [],
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
      hooks: {}, stackSource, copyToWorktree: [], providerState: state,
      onEvent: (event) => events.push(event),
    })).resolves.toEqual({
      type: "CREDENTIAL", provider: "codex", detail, specGaps: [],
    });

    expect(seams.sandboxRun).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.kind === "ui-check")).toEqual([{
      kind: "ui-check", issue: 134, title: "Issue 134", invocation: 1,
      provider: "codex", model: "model", effort: null,
      transcript: "ui-check-1.log",
      durationMs: expect.any(Number), result: "credential",
    }]);
    expect(state.get("codex")).toEqual({ cause: "credential", detail });
  });

  it("logs peak context for the quality lister and for successful and failed reviewer invocations", async () => {
    const events: EventInput[] = [];
    const reviewerFailure = new Error("reviewer disconnected");
    seams.partialUsage.set(reviewerFailure, {
      usage: { inputTokens: 7 }, toolCalls: 2, peakContext: 52, firstContext: 15,
    });
    seams.sandboxRun
      .mockResolvedValueOnce({
        stdout: "<promise>COMPLETE</promise>",
        durationMs: 11,
        headBefore: "base-sha",
        headAfter: "implemented-sha",
        signalMs: 1,
        maxGapMs: 1,
        toolCalls: 1,
        peakContext: 23,
        commits: [{ sha: "implemented-sha" }],
      })
      .mockResolvedValueOnce({ ...listerRun, firstContext: 30 })
      .mockRejectedValueOnce(reviewerFailure)
      .mockResolvedValueOnce({
        stdout: "<verdict>APPROVED</verdict>",
        durationMs: 31,
        maxGapMs: 2,
        toolCalls: 4,
        peakContext: 73,
        firstContext: 16,
        commits: [],
      });

    await expect(runInnerLoop(issue("125"), {
      config: config("codex"), hooks: {}, stackSource, copyToWorktree: [],
      onEvent: (event) => events.push(event),
    })).resolves.toMatchObject({ type: "DONE" });

    expect(events.filter((event) => event.kind === "quality-review")).toEqual([{
      kind: "quality-review", issue: 125, title: "Issue 125", attempt: 1, round: 1,
      invocation: 1, mode: "list", group: "sandbar", scope: "full",
      provider: "claude", model: "model", effort: null, result: "completed",
      verdict: "APPROVED", prose: "<verdict>APPROVED</verdict>",
      durationMs: 5, maxGapMs: 1,
      transcript: "attempt-1-quality-list-sandbar-1.log",
      usage: { toolCalls: 2, peakContext: 40, firstContext: 30, contextChars: 14 },
    }]);
    expect(events.filter((event) => event.kind === "review-pass")).toEqual([
      {
        kind: "review-pass", issue: 125, title: "Issue 125", attempt: 1, round: 1,
        invocation: 1, provider: "claude", model: "model",
        effort: null, result: "failed", durationMs: expect.any(Number),
        transcript: "attempt-1-reviewer-1.log",
        usage: { inputTokens: 7, toolCalls: 2, peakContext: 52, firstContext: 15, contextChars: 18 },
      },
      {
        kind: "review-pass", issue: 125, title: "Issue 125", attempt: 1, round: 1,
        invocation: 2, provider: "claude", model: "model",
        effort: null, result: "completed", durationMs: 31, maxGapMs: 2,
        transcript: "attempt-1-reviewer-2.log",
        usage: { toolCalls: 4, peakContext: 73, firstContext: 16, contextChars: 18 },
      },
    ]);
    expect(events.filter((event) => event.kind === "phase")).toEqual([
      { kind: "phase", issue: 125, title: "Issue 125", attempt: 1, phases: ["anchor"] },
      { kind: "phase", issue: 125, title: "Issue 125", attempt: 1, phases: ["implementer"] },
      { kind: "phase", issue: 125, title: "Issue 125", attempt: 1, phases: ["quality"] },
      { kind: "phase", issue: 125, title: "Issue 125", attempt: 1, phases: ["gate-1"] },
      { kind: "phase", issue: 125, title: "Issue 125", attempt: 1, phases: ["review"] },
      { kind: "phase", issue: 125, title: "Issue 125", attempt: 1, phases: [] },
    ]);
    expect(events.filter((event) => event.kind === "review-round")).toEqual([{
      kind: "review-round", issue: 125, title: "Issue 125", attempt: 1, round: 1,
      head: "implemented-sha", quality: "APPROVED", qualityRounds: 0,
      gateOk: true, correctness: "APPROVED",
      rejectingPass: null, gateFailures: 0, correctnessFailures: 0,
      durationMs: expect.any(Number),
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
      config: config("claude"), hooks: {}, stackSource, copyToWorktree: [], providerState: state,
      onEvent: (event) => events.push(event),
    })).resolves.toEqual({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
      specGaps: [],
    });
    expect(seams.createSandbox).toHaveBeenCalledOnce();
    expect(seams.sandboxRun).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.kind === "implementer")).toEqual([{
      kind: "implementer", issue: 109, title: "Issue 109", attempt: 1,
      signal: "QUOTA", provider: "claude", model: "model",
      effort: null, durationMs: expect.any(Number),
      transcript: "attempt-1.log",
      usage: { quota: measurement, contextChars: 9 },
    }]);

    await expect(runInnerLoop(issue("110"), {
      config: config("claude"), hooks: {}, stackSource, copyToWorktree: [], providerState: state,
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
      config: config("codex"), hooks: {}, stackSource, copyToWorktree: [], providerState: state,
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
      hooks: {}, stackSource, copyToWorktree: [], providerState: state,
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
      signal: "CREDENTIAL", provider: "codex", model: "model",
      effort: null, durationMs: expect.any(Number), usage: { contextChars: 9 },
      transcript: "attempt-1.log",
    }]);

    await expect(runInnerLoop(issue("135"), {
      config: { ...config("codex"), codexAuthMount },
      hooks: {}, stackSource, copyToWorktree: [], providerState: state,
      onEvent: () => undefined,
    })).resolves.toEqual({
      type: "CREDENTIAL", provider: "codex", detail, specGaps: [],
    });
    expect(seams.sandboxRun).toHaveBeenCalledOnce();
  });

  it.each([
    ["quality lister", "quality-review", 2, []],
    ["quality fixer", "quality-pass", 3, [rejectingListerRun]],
    ["correctness reviewer", "review-pass", 3, [listerRun]],
  ] as const)("surfaces %s quota after one invocation without a retry", async (
    _role,
    eventKind,
    runs,
    before,
  ) => {
    const events: EventInput[] = [];
    const state = createRunProviderState();
    const measurement = {
      status: "rejected" as const,
      window: "five_hour",
      resetsAt: 42,
    };
    seams.sandboxRun.mockResolvedValueOnce({
      stdout: "<promise>COMPLETE</promise>",
      headBefore: "base-sha",
      headAfter: "implemented-sha",
      signalMs: 1,
      maxGapMs: 1,
      toolCalls: 0,
      commits: [{ sha: "implemented-sha" }],
    });
    for (const run of before) seams.sandboxRun.mockResolvedValueOnce(run);
    seams.sandboxRun.mockRejectedValueOnce(new AgentQuotaError("claude", measurement));

    await expect(runInnerLoop(issue("112"), {
      config: config("codex"), hooks: {}, stackSource, copyToWorktree: [], providerState: state,
      onEvent: (event) => events.push(event),
    })).resolves.toEqual({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
      specGaps: [],
    });
    expect(seams.sandboxRun).toHaveBeenCalledTimes(runs);
    expect(events.filter((event) => event.kind === eventKind).at(-1)).toMatchObject({
      result: "quota",
      usage: { quota: measurement },
    });

    await expect(runInnerLoop(issue("113"), {
      config: config("claude"), hooks: {}, stackSource, copyToWorktree: [], providerState: state,
      onEvent: () => undefined,
    })).resolves.toEqual({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
      specGaps: [],
    });
    expect(seams.sandboxRun).toHaveBeenCalledTimes(runs);
  });

  it("closes a refused quality-pass credential without a retry", async () => {
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
      hooks: {}, stackSource, copyToWorktree: [], providerState: state,
      onEvent: (event) => events.push(event),
    })).resolves.toEqual({
      type: "CREDENTIAL", provider: "codex", detail, specGaps: [],
    });

    expect(seams.sandboxRun).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.kind === "quality-review")).toEqual([{
      kind: "quality-review", issue: 136, title: "Issue 136", attempt: 1, round: 1,
      invocation: 1, mode: "list", group: "sandbar", scope: "full",
      provider: "codex", model: "model", effort: null, result: "credential",
      verdict: null, prose: "", durationMs: expect.any(Number), usage: { contextChars: 14 },
      transcript: "attempt-1-quality-list-sandbar-1.log",
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
      .mockResolvedValueOnce(listerRun)
      .mockRejectedValueOnce(new AgentQuotaError("claude", measurement));
    // The implementer's read, the lister's two snapshots, then the reviewer's.
    seams.dirtyWorktreePaths
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["review.txt"]);

    await expect(runInnerLoop(issue("114"), {
      config: config("codex"), hooks: {}, stackSource, copyToWorktree: [],
      providerState: createRunProviderState(), onEvent: () => undefined,
    })).resolves.toMatchObject({ type: "NEEDS-HUMAN-REVIEW" });
    expect(seams.preserveWorktree).toHaveBeenCalledWith(
      expect.stringContaining("reviewer changed the repository"),
    );
    expect(seams.deferWorktreeReclaim).toHaveBeenCalledOnce();
    expect(seams.sandboxRun).toHaveBeenCalledTimes(3);
  });
});
