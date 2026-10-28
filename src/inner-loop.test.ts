import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

const innerLoopMocks = vi.hoisted(() => ({
  ownerEgress: vi.fn(),
  podmanOptions: [] as unknown[],
  buildPrompt: vi.fn(async () => "implementer prompt"),
  buildPartitionCheckPrompt: vi.fn(async () => "partition check prompt"),
  buildUiCheckPrompt: vi.fn(async () => "ui check prompt"),
  buildQualityReviewPrompt: vi.fn(async () => "quality review prompt"),
  buildQualityFixPrompt: vi.fn(async () => "quality fix prompt"),
  buildCorrectnessPrompt: vi.fn(async () => "correctness prompt"),
  buildAdjudicatorPrompt: vi.fn(async () => "adjudicator prompt"),
  measureNetDiffChars: vi.fn(async () => 0),
  branchIsAheadOfSeed: vi.fn(async () => false),
  ensureIssueBranch: vi.fn(async () => ({
    ref: "origin/main",
    sha: "base-sha",
  })),
  prepareWorktree: vi.fn(async () => "/worktree"),
  createSandbox: vi.fn(),
  resolveSandboxImage: vi.fn(async () => "sandbox-image"),
  startStack: vi.fn(),
  branchCommitsSinceSeed: vi.fn(async () => [] as { sha: string }[]),
  branchTip: vi.fn(async () => "tip-a" as string | null),
  dirtyWorktreePaths: vi.fn(async () => [] as string[]),
  fastForwardOffBranchHead: vi.fn(),
  headMismatch: vi.fn(async () => null),
  symbolicHeadRef: vi.fn(async () => "refs/heads/sandbar/issue-126" as string | null),
  settleQualityResidue: vi.fn(),
  revParse: vi.fn(async () => "seed-sha"),
  forkPoint: vi.fn(async () => "fork-sha"),
  createScenarioWriterTask: vi.fn(),
  createDbCopySlot: vi.fn(),
  startSandboxStack: vi.fn(),
  isAncestor: vi.fn(async (_cwd: string, _ancestor: string, _descendant: string) => true),
  fetchIssueAnchor: vi.fn(async (): Promise<IssueAnchor> => ({
    text: "Issue #1: Issue",
    json: { title: "Issue", body: "", comments: [] },
    key: "key",
    cache: { kind: "miss", problem: null },
    rawChars: 15,
    tracedChars: 15,
  })),
  issueSource: vi.fn(async (_issueId: string): Promise<IssueJson> => ({ title: "Issue", body: "", comments: [] })),
}));

vi.mock("./prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prompt.js")>()),
  buildPrompt: innerLoopMocks.buildPrompt,
  buildPartitionCheckPrompt: innerLoopMocks.buildPartitionCheckPrompt,
  buildUiCheckPrompt: innerLoopMocks.buildUiCheckPrompt,
  buildQualityReviewPrompt: innerLoopMocks.buildQualityReviewPrompt,
  buildQualityFixPrompt: innerLoopMocks.buildQualityFixPrompt,
  buildCorrectnessPrompt: innerLoopMocks.buildCorrectnessPrompt,
  buildAdjudicatorPrompt: innerLoopMocks.buildAdjudicatorPrompt,
  measureNetDiffChars: innerLoopMocks.measureNetDiffChars,
  branchIsAheadOfSeed: innerLoopMocks.branchIsAheadOfSeed,
}));

vi.mock("./agent-sandbox.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./agent-sandbox.js")>();
  return {
  ...original,
  prepareWorktree: innerLoopMocks.prepareWorktree,
  createSandbox: innerLoopMocks.createSandbox,
  podman: (options: Parameters<typeof import("./agent-sandbox.js").podman>[0]) => {
    innerLoopMocks.podmanOptions.push(options);
    return original.podman(options);
  },
  };
});

vi.mock("./egress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./egress.js")>()),
  ownerEgress: innerLoopMocks.ownerEgress,
}));

vi.mock("./agent-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-tools.js")>()),
  resolveSandboxImage: innerLoopMocks.resolveSandboxImage,
}));

vi.mock("./gate-stack.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gate-stack.js")>()),
  startStack: innerLoopMocks.startStack,
}));

vi.mock("./git-ops.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git-ops.js")>()),
  branchTip: innerLoopMocks.branchTip,
  dirtyWorktreePaths: innerLoopMocks.dirtyWorktreePaths,
  fastForwardOffBranchHead: innerLoopMocks.fastForwardOffBranchHead,
  headMismatch: innerLoopMocks.headMismatch,
  symbolicHeadRef: innerLoopMocks.symbolicHeadRef,
  settleQualityResidue: innerLoopMocks.settleQualityResidue,
  branchCommitsSinceSeed: innerLoopMocks.branchCommitsSinceSeed,
  ensureIssueBranch: innerLoopMocks.ensureIssueBranch,
  revParse: innerLoopMocks.revParse,
  forkPoint: innerLoopMocks.forkPoint,
  isAncestor: innerLoopMocks.isAncestor,
}));

vi.mock("./scenario-writer-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-writer-run.js")>()),
  createScenarioWriterTask: innerLoopMocks.createScenarioWriterTask,
}));

vi.mock("./db-copy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db-copy.js")>()),
  createDbCopySlot: innerLoopMocks.createDbCopySlot,
}));

vi.mock("./sandbox-stack.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-stack.js")>()),
  startSandboxStack: innerLoopMocks.startSandboxStack,
  prepareSandboxLogDir: async () => undefined,
}));

vi.mock("./issue-anchor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./issue-anchor.js")>()),
  fetchIssueAnchor: innerLoopMocks.fetchIssueAnchor,
}));

import {
  AgentCredentialError,
  AgentError,
  AgentIdleTimeoutError,
  AgentInputTooLargeError,
  AgentQuotaError,
  createAgentSpeechAccumulator,
  parseStreamJsonLine,
  withPartialCommits,
  withPartialContainerResources,
  withPartialDurationMs,
  withPartialOutput,
  type Sandbox,
} from "./agent-sandbox.js";
import { AgentToolsImageError } from "./agent-tools.js";
import { EGRESS_AGENT_ENV, EgressProxyDiedError } from "./egress.js";
import { sandboxNetworkNameFor } from "./naming.js";
import {
  QUALITY_FIXER_MAX_INVOCATIONS,
  closedReviewRound,
  createRunProviderState,
  enforceReadOnlyAgentSnapshot,
  qualityAuthorEnv,
  readOnlyAgentSnapshotChanged,
  runVerifier,
  runGate,
  runImplementer,
  runInnerLoop,
  runPartitionCheck,
  runQualityFix,
  runQualityReview,
  runAdjudicator,
  runAnchorCondense,
  runUiCheck,
  runSandboxAndPublish,
  selectPromiseNudge,
  type QualityLedger,
  type ReadOnlyAgentSnapshot,
} from "./inner-loop.js";
import {
  createAgentInvocationSequencer,
  createTranscriptTree,
} from "./logs.js";
import type { QualityStandards } from "./standards-groups.js";
import type { HeadMismatch } from "./git-ops.js";
import {
  type CondenseAnswer,
  type IssueAnchor,
  type IssueJson,
  condenseKey,
  readCondenseCache,
  renderIssueText,
} from "./issue-anchor.js";
import type { EventInput } from "./events.js";
import type { GateResult } from "./gate.js";
import {
  type ReviewerResult,
  type ScenarioWriterOutcome,
  type ScenarioWriterStatus,
  initialState,
} from "./inner-loop-machine.js";
import { combineVerifier } from "./verifier.js";
import { parsePromise } from "./promise-parser.js";
import { loadTemplate } from "./prompts.js";
import { createGateSemaphore } from "./gate-semaphore.js";
import {
  type SandboxGateAttachments,
  resolveDatabaseCopies,
  resolveGateStack,
} from "./config.js";
import type { DbCopies, DbCopyStatus } from "./db-copy.js";
import { SandbarError } from "./errors.js";
import type { DbCopyHolder } from "./db-copy-policy.js";
import {
  containerResourcesOf,
  type ContainerResources,
} from "./container-resources.js";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// What a quality pass's lister read; the builders are mocked, so its shape is
// all that matters.
const passStandards: QualityStandards = { groups: [], preamble: "", leaveAlone: [], warnings: [] };

describe("runAnchorCondense (#217)", () => {
  const thread: IssueJson = {
    title: "Pick a store",
    body: "Persist it.",
    comments: [
      { author: { login: "a" }, createdAt: "2026-01-01T00:00:00Z", body: "Option A." },
      { author: { login: "b" }, createdAt: "2026-01-02T00:00:00Z", body: "Decision: option B." },
      { author: { login: "c" }, createdAt: "2026-01-03T00:00:00Z", body: "Thanks." },
    ],
  };
  const answer: CondenseAnswer = [
    { kind: "drop", by: 2, reason: "overruled" },
    { kind: "keep" },
    { kind: "keep" },
  ];
  const repo = { owner: "owner", name: "repo" };
  const condensedChars = renderIssueText("217", thread, { answer, repo }).length;
  const VALID = "<condense>\nC1 DROP C2 overruled\nC2 KEEP\nC3 KEEP\n</condense>";

  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "anchor-condense-"));
    innerLoopMocks.branchTip.mockReset().mockResolvedValue("tip-a");
    innerLoopMocks.dirtyWorktreePaths.mockReset().mockResolvedValue([]);
    return async () => {
      await rm(cacheDir, { recursive: true, force: true });
    };
  });

  const context = (
    run: (options: Parameters<Sandbox["run"]>[0]) => Promise<unknown>,
    anchor: Partial<IssueAnchor> = {},
    config: { readonly condenseAboveChars?: number | null } = {},
  ) => {
    const fetched: IssueAnchor = {
      text: renderIssueText("217", thread),
      json: thread,
      key: condenseKey(thread),
      cache: { kind: "miss", problem: null },
      rawChars: 40_000,
      tracedChars: 30_000,
      ...anchor,
    };
    innerLoopMocks.fetchIssueAnchor.mockResolvedValueOnce(fetched);
    const events: EventInput[] = [];
    const writes: string[] = [];
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn(run),
      preserveWorktree: vi.fn(),
      syncBranchToCache: vi.fn(),
    } as unknown as Sandbox;
    const providerState = createRunProviderState();
    const ctx = {
      issue: { id: "217", title: "condense", branch: "sandbar/issue-217" },
      sandbox,
      opts: {
        attemptLogger: { writeInvocation: vi.fn(async (filename) => writes.push(filename)) },
        onEvent: (event: EventInput) => events.push(event),
        providerState,
      },
      config: {
        layout: { anchorCacheDir: cacheDir },
        repo,
        condenserAgent: "claude",
        condenserModelId: "sonnet",
        condenseAboveChars: 20_000,
        ...config,
      },
      invocationSequence: createAgentInvocationSequencer().startCycle(),
    } as unknown as Parameters<typeof runAnchorCondense>[1];
    return { ctx, sandbox, events, writes, providerState, fetched };
  };
  const answered = (stdout: string) => async () => ({
    stdout, commits: [], durationMs: 5, silent: false, toolCalls: 1,
  });
  const sizes = { issue: 217, title: "condense", rawChars: 40_000, tracedChars: 30_000, comments: 3 };
  const cached = () => readCondenseCache(cacheDir, "217", condenseKey(thread), 3);

  it.each([
    ["below the threshold", { tracedChars: 15_000 }, {}],
    ["with the step off", {}, { condenseAboveChars: null }],
  ] as const)("makes no call %s", async (_name, anchor, config) => {
    const { ctx, sandbox, events } = context(answered(VALID), anchor, config);
    await expect(runAnchorCondense({ kind: "run-anchor-condense" }, ctx))
      .resolves.toEqual({ kind: "anchor-ready" });
    expect(sandbox.run).not.toHaveBeenCalled();
    const tracedChars = anchor.tracedChars ?? 30_000;
    expect(events).toEqual([{
      kind: "issue-anchor", ...sizes, tracedChars,
      result: "below-threshold", anchorChars: tracedChars, dropped: 0,
    }]);
  });

  it("makes no call when the cache answers this thread", async () => {
    const text = renderIssueText("217", thread, { answer, repo });
    const { ctx, sandbox, events } = context(answered(VALID), { text, cache: { kind: "hit", answer } });
    await expect(runAnchorCondense({ kind: "run-anchor-condense" }, ctx))
      .resolves.toEqual({ kind: "anchor-ready" });
    expect(sandbox.run).not.toHaveBeenCalled();
    expect(events).toEqual([{
      kind: "issue-anchor", ...sizes, result: "cache-hit", anchorChars: text.length, dropped: 1,
    }]);
  });

  it("condenses once with no completion signal and caches the answer", async () => {
    const { ctx, sandbox, events, writes } = context(answered(VALID));
    await expect(runAnchorCondense({ kind: "run-anchor-condense" }, ctx))
      .resolves.toEqual({ kind: "anchor-ready" });
    expect(sandbox.run).toHaveBeenCalledOnce();
    const invocation = vi.mocked(sandbox.run).mock.calls[0]![0];
    expect(invocation).toMatchObject({ name: "anchor-condense-217", model: "sonnet", completionSignal: [] });
    expect(invocation.prompt).toContain("comments C1…C3");
    expect(invocation.prompt).toContain("### C3 — c — 2026-01-03T00:00:00Z");
    await invocation.onInvocationEnd?.({} as never);
    expect(writes).toEqual(["anchor-condense-1.log"]);
    expect(await cached()).toEqual({ kind: "hit", answer });
    expect(events).toEqual([{
      kind: "issue-anchor", ...sizes, result: "condensed", anchorChars: condensedChars, dropped: 1,
      provider: "claude", model: "sonnet", effort: null, durationMs: 5,
      transcript: "anchor-condense-1.log", usage: { toolCalls: 1 },
    }]);
  });

  it.each([
    ["an unparseable answer", answered("C1 KEEP"), "unparseable"],
    ["a harness failure", async () => { throw new AgentError("exited 1"); }, "failed"],
    ["a size refusal", async () => { throw new AgentInputTooLargeError("too long"); }, "input-too-large"],
    ["a closed quota", async () => {
      throw new AgentQuotaError("claude", { status: "rejected", window: "five_hour" });
    }, "quota"],
    ["a refused credential", async () => { throw new AgentCredentialError("expired"); }, "credential"],
  ] as const)("goes on uncondensed after %s, caching nothing", async (_name, run, result) => {
    const { ctx, events } = context(run);
    await expect(runAnchorCondense({ kind: "run-anchor-condense" }, ctx))
      .resolves.toEqual({ kind: "anchor-ready" });
    expect(events).toEqual([expect.objectContaining({
      kind: "issue-anchor", result, anchorChars: 30_000, dropped: 0,
    })]);
    expect(await cached()).toEqual({ kind: "miss", problem: null });
  });

  it("propagates an error that is not an agent invocation's, recording nothing", async () => {
    const { ctx, events } = context(async () => { throw new TypeError("bug"); });
    await expect(runAnchorCondense({ kind: "run-anchor-condense" }, ctx))
      .rejects.toThrow("bug");
    expect(events).toEqual([]);
    expect(await cached()).toEqual({ kind: "miss", problem: null });
  });

  it("records a closed provider for the run and never calls it again", async () => {
    const { ctx, sandbox, providerState, fetched } = context(async () => {
      throw new AgentQuotaError("claude", { status: "rejected", window: "five_hour" });
    });
    await runAnchorCondense({ kind: "run-anchor-condense" }, ctx);
    expect(providerState.get("claude")).toMatchObject({ cause: "quota" });
    innerLoopMocks.fetchIssueAnchor.mockResolvedValueOnce(fetched);
    await expect(runAnchorCondense({ kind: "run-anchor-condense" }, ctx))
      .resolves.toEqual({ kind: "anchor-ready" });
    expect(sandbox.run).toHaveBeenCalledOnce();
  });

  it("parks a condenser that wrote, trusting none of its answer", async () => {
    const { ctx, sandbox, events } = context(answered(VALID));
    innerLoopMocks.branchTip.mockReset()
      .mockResolvedValueOnce("tip-a")
      .mockResolvedValueOnce("tip-b");
    await expect(runAnchorCondense({ kind: "run-anchor-condense" }, ctx)).resolves.toEqual({
      kind: "anchor-condenser-wrote",
      detail: expect.stringContaining("Anchor condenser changed git state"),
    });
    expect(sandbox.preserveWorktree).toHaveBeenCalledWith(
      expect.stringContaining("anchor condenser changed the repository"),
    );
    expect(events).toEqual([expect.objectContaining({ result: "wrote", dropped: 0 })]);
    expect(await cached()).toEqual({ kind: "miss", problem: null });
  });

  it("logs an unusable cache entry and condenses afresh", async () => {
    const { ctx, sandbox, events } = context(answered(VALID), {
      cache: { kind: "miss", problem: "anchor cache /x/217.json is not JSON" },
    });
    await runAnchorCondense({ kind: "run-anchor-condense" }, ctx);
    expect(sandbox.run).toHaveBeenCalledOnce();
    expect(events[0]).toEqual({
      kind: "notice",
      message: "issue=217 anchor cache /x/217.json is not JSON; read as a miss",
    });
  });
});

describe("runUiCheck (#126)", () => {
  const context = (runs: readonly string[], events: EventInput[] = []) => {
    innerLoopMocks.branchTip.mockReset().mockResolvedValue("tip-a");
    innerLoopMocks.dirtyWorktreePaths.mockReset().mockResolvedValue([]);
    innerLoopMocks.symbolicHeadRef.mockReset().mockResolvedValue(
      "refs/heads/sandbar/issue-126",
    );
    const writes: string[] = [];
    const run = async (
      stdout: string,
      maxGapMs: number,
      toolCalls: number,
      options: Parameters<Sandbox["run"]>[0],
    ) => {
      await options.onInvocationEnd?.({
        agent: options.name ?? options.agent.name,
        provider: options.agent.name,
        model: options.model ?? null,
        end: "exit",
        detail: null,
        exitCode: 0,
        durationMs: 1,
        speech: stdout,
        stdout,
        stderr: "",
      });
      return {
        stdout,
        commits: [],
        durationMs: 1,
        silent: false,
        maxGapMs,
        toolCalls,
      };
    };
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn()
        .mockImplementationOnce((options) => run(runs[0] ?? "", 3, 1, options))
        .mockImplementationOnce((options) => run(runs[1] ?? "", 4, 2, options)),
      preserveWorktree: vi.fn(),
      syncBranchToCache: vi.fn(),
    } as unknown as Sandbox;
    return {
      sandbox,
      ctx: {
        issue: { id: "126", title: "ui check", branch: "sandbar/issue-126" },
        sandbox,
        opts: {
          stackSource: { path: null },
          attemptLogger: {
            writeInvocation: vi.fn(async (filename) => writes.push(filename)),
          },
          onEvent: (event: EventInput) => events.push(event),
        },
        config: {
          layout: { anchorCacheDir: "/anchor-cache" },
          issueSource: innerLoopMocks.issueSource,
          repo: { owner: "owner", name: "repo" },
          uiCheckAgent: "codex",
          uiCheckModelId: "gpt-5.6-sol",
          uiCheckEffort: "low",
        },
        invocationSequence: createAgentInvocationSequencer().startCycle(),
      } as unknown as Parameters<typeof runUiCheck>[1],
      writes,
    };
  };

  it("returns a classification from a cold call with no completion signal", async () => {
    const events: EventInput[] = [];
    const { sandbox, ctx, writes } = context(["<ui-check>CLEAR</ui-check>"], events);
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
    expect(writes).toEqual(["ui-check-1.log"]);
    expect(events).toEqual([{
      kind: "ui-check", issue: 126, title: "ui check", invocation: 1,
      provider: "codex", model: "gpt-5.6-sol", effort: "low",
      durationMs: expect.any(Number), maxGapMs: 3, result: "CLEAR",
      transcript: "ui-check-1.log",
      usage: { toolCalls: 1 },
    }]);
  });

  it("logs complete success and failed-invocation telemetry", async () => {
    const successEvents: EventInput[] = [];
    const success = context(["<ui-check>CLEAR</ui-check>"], successEvents);
    vi.mocked(success.sandbox.run).mockReset().mockResolvedValueOnce({
      stdout: "<ui-check>CLEAR</ui-check>",
      commits: [],
      durationMs: 17,
      silent: false,
      maxGapMs: 9,
      endedBy: "result-then-silence",
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
      firstContext: 3,
      peakMemoryBytes: 344_000_000,
      oomKilled: true,
      rateLimit: {
        status: "allowed_warning",
        window: "five_hour",
        utilization: 0.9,
        resetsAt: 42,
      },
    });
    await runUiCheck({ kind: "run-ui-check" }, success.ctx);
    expect(successEvents).toEqual([{
      kind: "ui-check", issue: 126, title: "ui check", invocation: 1,
      provider: "codex", model: "gpt-5.6-sol", effort: "low",
      durationMs: 17, endedBy: "result-then-silence", maxGapMs: 9, result: "CLEAR",
      transcript: "ui-check-1.log",
      peakMemoryBytes: 344_000_000, oomKilled: true,
      usage: { inputTokens: 1, cachedInputTokens: 2, cacheWriteInputTokens: 3,
        outputTokens: 4, reasoningTokens: 5, apiMs: 6, resolvedModel: "resolved",
        models: 2, terminalReason: "end_turn", toolCalls: 7, peakContext: 8, firstContext: 3,
        quota: { status: "allowed_warning", window: "five_hour", utilization: 0.9,
          resetsAt: 42 } },
    }]);

    const failureEvents: EventInput[] = [];
    const failure = context([], failureEvents);
    const err = withPartialDurationMs(
      withPartialContainerResources(
        withPartialOutput(
          new Error("disconnected"),
          "partial",
          { inputTokens: 11, outputTokens: 12 },
          13,
          14,
          { status: "rejected", window: "weekly", utilization: 1 },
          10,
        ),
        { peakMemoryBytes: 512_000_000, oomKilled: true },
      ),
      19,
    );
    vi.mocked(failure.sandbox.run).mockReset().mockImplementationOnce(
      async (options) => {
        await options.onInvocationEnd?.({
          agent: options.name ?? options.agent.name,
          provider: options.agent.name,
          model: options.model ?? null,
          end: "exec-error",
          detail: "disconnected",
          exitCode: null,
          durationMs: 1,
          speech: "partial",
          stdout: "raw partial",
          stderr: "disconnected",
        });
        throw err;
      },
    );
    await expect(runUiCheck({ kind: "run-ui-check" }, failure.ctx)).rejects.toBe(err);
    expect(failure.writes).toEqual(["ui-check-1.log"]);
    expect(failureEvents).toEqual([{
      kind: "ui-check", issue: 126, title: "ui check", invocation: 1,
      provider: "codex", model: "gpt-5.6-sol", effort: "low",
      durationMs: 19, result: "failed", transcript: "ui-check-1.log",
      peakMemoryBytes: 512_000_000, oomKilled: true,
      usage: { inputTokens: 11, outputTokens: 12, toolCalls: 13, peakContext: 14, firstContext: 10,
        quota: { status: "rejected", window: "weekly", utilization: 1 } },
    }]);
  });

  it("offers one cold correction for a malformed answer", async () => {
    const events: EventInput[] = [];
    const { sandbox, ctx, writes } = context([
      "<ui-check>PROTOTYPE-NEEDED</ui-check>",
      "<ui-check>CLEAR</ui-check>",
    ], events);
    await expect(runUiCheck({ kind: "run-ui-check" }, ctx)).resolves.toMatchObject({
      result: { kind: "CLEAR" },
    });
    expect(sandbox.run).toHaveBeenCalledTimes(2);
    expect(sandbox.run).toHaveBeenNthCalledWith(2, expect.objectContaining({
      name: "ui-check-126-reprompt",
      prompt: expect.stringContaining("provided no `<ui-impact>` block"),
      completionSignal: [],
    }));
    expect(writes).toEqual(["ui-check-1.log", "ui-check-2.log"]);
    expect(events).toEqual([
      expect.objectContaining({ kind: "ui-check", invocation: 1,
        result: "NO-SIGNAL", maxGapMs: 3 }),
      expect.objectContaining({ kind: "ui-check", invocation: 2,
        result: "CLEAR", maxGapMs: 4 }),
    ]);
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

describe("runPartitionCheck (#158)", () => {
  const context = (stdout: string, budget = 600_000) => {
    innerLoopMocks.branchTip.mockReset().mockResolvedValue("tip-a");
    innerLoopMocks.dirtyWorktreePaths.mockReset().mockResolvedValue([]);
    innerLoopMocks.symbolicHeadRef.mockReset().mockResolvedValue(
      "refs/heads/sandbar/issue-158",
    );
    innerLoopMocks.measureNetDiffChars.mockReset().mockResolvedValue(0);
    const events: EventInput[] = [];
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn(async () => ({
        stdout,
        commits: [],
        durationMs: 7,
        silent: false,
        maxGapMs: 2,
        toolCalls: 3,
        peakContext: 11,
      })),
      preserveWorktree: vi.fn(),
      syncBranchToCache: vi.fn(),
    } as unknown as Sandbox;
    const ctx = {
      issue: { id: "158", title: "fan out", branch: "sandbar/issue-158" },
      sandbox,
      base: { ref: "origin/main", sha: "base" },
      opts: {
        stackSource: { path: null },
        attemptLogger: { writeInvocation: vi.fn() },
        onEvent: (event: EventInput) => events.push(event),
      },
      config: {
        layout: { anchorCacheDir: "/anchor-cache" },
        issueSource: innerLoopMocks.issueSource,
        repo: { owner: "owner", name: "repo" },
        implementerAgent: "codex",
        implementerModelId: "gpt-5.6-sol",
        implementerEffort: "medium",
        maxContextChars: budget,
      },
      invocationSequence: createAgentInvocationSequencer().startCycle(),
    } as unknown as Parameters<typeof runPartitionCheck>[1];
    return { ctx, sandbox, events };
  };

  it("returns the cold classifier verdict and records the measured picture", async () => {
    const { ctx, sandbox, events } = context(
      "<partition-check>PARTITION</partition-check>" +
        "<partition-reason>two independently landable deliverables</partition-reason>",
    );
    await expect(runPartitionCheck({ kind: "run-partition-check" }, ctx))
      .resolves.toEqual({
        kind: "partition-check-result",
        result: {
          kind: "PARTITION",
          reason: "two independently landable deliverables",
        },
        size: 22,
        budget: 600_000,
      });
    expect(sandbox.run).toHaveBeenCalledOnce();
    expect(events).toEqual([expect.objectContaining({
      kind: "partition-check",
      result: "PARTITION",
      usage: { toolCalls: 3, peakContext: 11, contextChars: 22 },
    })]);
  });

  it("parks before provider dispatch when the issue anchor exceeds budget", async () => {
    const { ctx, sandbox } = context("", 21);
    await expect(runPartitionCheck({ kind: "run-partition-check" }, ctx))
      .resolves.toEqual({
        kind: "context-over-budget",
        slot: "partition-check",
        size: 22,
        budget: 21,
        detail: "The issue anchor alone exceeds the configured context budget.",
      });
    expect(sandbox.run).not.toHaveBeenCalled();
  });

  it("classifies a provider size refusal as a partition terminal without retrying", async () => {
    const { ctx, sandbox, events } = context("");
    vi.mocked(sandbox.run).mockRejectedValueOnce(
      new AgentInputTooLargeError("actual_chars=1064340"),
    );
    await expect(runPartitionCheck({ kind: "run-partition-check" }, ctx))
      .rejects.toMatchObject({
        verdict: {
          type: "NEEDS-PARTITION",
          cause: "provider-refused",
          slot: "partition-check",
          detail: "actual_chars=1064340",
        },
      });
    expect(sandbox.run).toHaveBeenCalledOnce();
    expect(events).toEqual([expect.objectContaining({
      kind: "partition-check",
      result: "input-too-large",
      transcript: "partition-check-1.log",
    })]);
  });

  // #194: a completed and a failed invocation each name their log.
  it("names each invocation's log as its event's transcript", async () => {
    const { ctx, sandbox, events } = context("<partition-check>NO-SIGNAL</partition-check>");
    vi.mocked(sandbox.run).mockRejectedValueOnce(new Error("provider failed"));
    await runPartitionCheck({ kind: "run-partition-check" }, ctx).catch(() => undefined);
    const { ctx: completedCtx, events: completedEvents } = context(
      "<partition-check>CLEAR</partition-check>",
    );
    await runPartitionCheck({ kind: "run-partition-check" }, completedCtx);
    expect(completedEvents).toEqual([expect.objectContaining({
      kind: "partition-check", result: "CLEAR", transcript: "partition-check-1.log",
    })]);
    expect(events[0]).toMatchObject({
      kind: "partition-check", result: "failed", transcript: "partition-check-1.log",
    });
  });
});

describe("promise nudge selection (#191)", () => {
  const PLAIN = loadTemplate("implementer-promise-nudge");
  const RESUME = loadTemplate("implementer-promise-nudge-resume");
  const line = (obj: unknown) => JSON.stringify(obj);
  const tasksChanged = (tasks: unknown[]) =>
    line({ type: "system", subtype: "background_tasks_changed", tasks });
  const text = (t: string) =>
    line({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
  const endTurn = (result: string) =>
    line({ type: "result", subtype: "success", stop_reason: "end_turn", result });

  // Replays a recorded stream the way the sandbox does and returns what the
  // inner loop decides from: the parsed signal and the nudge it would send.
  const replay = (lines: readonly string[]) => {
    const speech = createAgentSpeechAccumulator();
    for (const l of lines) speech.ingest(parseStreamJsonLine(l));
    return {
      signal: parsePromise(speech.spoken, { commitsAccumulated: 1 }),
      nudge: selectPromiseNudge(
        speech.backgroundTasks === undefined ? {} : { backgroundTasks: speech.backgroundTasks },
      ),
    };
  };

  const WAITING =
    "The waiter will tell me when the run reports a verdict; nothing else to do on this branch until then.";

  it("gives a turn ended while background tasks are listed the resume nudge", () => {
    const { signal, nudge } = replay([
      tasksChanged([{ task_id: "suite", description: "npm test" }]),
      text("Started a waiter."),
      tasksChanged([
        { task_id: "suite", description: "npm test" },
        { task_id: "waiter", description: "wait for the suite" },
      ]),
      text(WAITING),
      endTurn(WAITING),
    ]);

    expect(signal).toMatchObject({ kind: "NO-SIGNAL", missingTag: true });
    expect(nudge).toBe(RESUME);
    expect(nudge).toContain("cut off");
    expect(nudge).not.toContain("Do not start new work.");
    // #192: running what a change impacts is fine; shrinking it is not wanted.
    expect(nudge).not.toContain("narrow");
  });

  it.each([
    ["no background_tasks_changed line", [text("Done."), endTurn("Done.")]],
    [
      "tasks that were all stopped before the turn ended",
      [tasksChanged([{ task_id: "suite" }]), tasksChanged([]), endTurn("Done.")],
    ],
  ])("keeps the plain nudge for %s", (_name, lines) => {
    const { signal, nudge } = replay(lines);

    expect(signal).toMatchObject({ kind: "NO-SIGNAL", missingTag: true });
    expect(nudge).toBe(PLAIN);
    expect(nudge).toContain("Do not start new work.");
  });
});

describe("silent implementer attempt policy (#116)", () => {
  const sandboxResult = (
    stdout: string,
    silent: boolean,
    commits: string[] = [],
    resources: ContainerResources = {},
  ) => ({
    stdout,
    silent,
    commits: commits.map((sha) => ({ sha })),
    durationMs: 1,
    maxGapMs: 1,
    toolCalls: 0,
    ...resources,
  });
  type ScriptedImplementerRun = ReturnType<typeof sandboxResult> | {
    readonly error: Error;
    readonly resources: ContainerResources;
    readonly durationMs: number;
  };

  const runPath = (
    first: ScriptedImplementerRun,
    nudge: ScriptedImplementerRun,
    promptExtensions?: Parameters<typeof runImplementer>[1]["config"]["promptExtensions"],
    mismatch: HeadMismatch | null = null,
    latestReviewerFeedback: Parameters<
      typeof runImplementer
    >[0]["latestReviewerFeedback"] = null,
    quality: QualityLedger = { sinceImplementer: [], overrules: [], openRound: null, standards: null },
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
    const lines: EventInput[] = [];
    const record = async (
      result: ScriptedImplementerRun,
      options: Parameters<Sandbox["run"]>[0],
    ) => {
      const failed = "error" in result;
      const resources = failed ? result.resources : containerResourcesOf(result);
      const stdout = failed ? "" : result.stdout;
      await options.onInvocationEnd?.({
        agent: options.name ?? options.agent.name,
        provider: options.agent.name,
        model: options.model ?? null,
        end: failed ? "exec-error" : "exit",
        detail: failed ? result.error.message : null,
        exitCode: failed ? null : 0,
        durationMs: result.durationMs,
        speech: stdout,
        stdout,
        stderr: "",
        ...resources,
      });
      if (failed) {
        throw withPartialDurationMs(
          withPartialContainerResources(result.error, resources),
          result.durationMs,
        );
      }
      return result;
    };
    const sandbox = {
      worktreePath: "/unused",
      run: vi.fn()
        .mockImplementationOnce((options) => record(first, options))
        .mockImplementationOnce((options) => record(nudge, options)),
      syncBranchToCache: vi.fn(),
    } as unknown as Sandbox;
    const ctx = {
      issue: { id: "116", title: "silent", branch: "sandbar/issue-116-silent" },
      sandbox,
      opts: {
        stackSource: { path: null },
        attemptLogger: {
          writeInvocation: vi.fn(async (_filename, record) => writes.push(record.speech)),
        },
        onEvent: (event: EventInput) => lines.push(event),
      },
      config: {
        implementerAgent: "codex",
        implementerModelId: "model",
        promptExtensions,
      },
      anchorOpts: {},
      base: { ref: "origin/main" },
      gateStack: {},
      sandboxGateAttachments: { env: {}, mounts: [] },
      worktreePath: "/unused",
      accumulated: [],
      priorReviewRounds: [],
      quality,
      sandboxStatuses: [],
      invocationSequence: createAgentInvocationSequencer().startCycle(),
      dbCopy: { kind: "none" },
    } as unknown as Parameters<typeof runImplementer>[1];
    const pending = runImplementer(
      {
        kind: "run-implementer",
        attempt: 1,
        failureTrace: null,
        extraReprompt: null,
        latestReviewerFeedback,
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
    expect(writes).toEqual(["", ""]);
    expect(lines.at(-1)).toMatchObject({ kind: "implementer", commits: 2 });
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
    expect(writes).toEqual(["", spoken]);
    expect(lines.at(-1)).toMatchObject({ kind: "implementer", commits: 0 });
  });

  it("keeps the largest peak and any OOM across a promise nudge", async () => {
    const { pending, lines } = runPath(
      sandboxResult("no signal", false, [], {
        peakMemoryBytes: 1024,
        oomKilled: false,
      }),
      sandboxResult("<promise>COMPLETE</promise>", false, [], {
        peakMemoryBytes: 2048,
        oomKilled: true,
      }),
    );

    await expect(pending).resolves.toMatchObject({ kind: "implementer-result" });
    expect(lines.at(-1)).toMatchObject({
      kind: "implementer",
      peakMemoryBytes: 2048,
      oomKilled: true,
    });
  });

  it("records an OOM-killed first invocation before propagating its failure", async () => {
    const { pending, lines } = runPath(
      {
        error: new Error("agent exited 137"),
        resources: { peakMemoryBytes: 4096, oomKilled: true },
        durationMs: 7,
      },
      sandboxResult("unused", false),
    );

    await expect(pending).rejects.toThrow("agent exited 137");
    expect(lines.at(-1)).toMatchObject({
      kind: "implementer", signal: "FAILED",
      durationMs: 7,
      peakMemoryBytes: 4096, oomKilled: true,
    });
    // Nothing counted the failed run's commits (#188): absent, not 0.
    expect(lines.at(-1)).not.toHaveProperty("commits");
  });

  it("adds a failed nudge's counted commits to the first run's (#188)", async () => {
    const { pending, lines } = runPath(
      sandboxResult("no signal", false, ["a"]),
      {
        error: withPartialCommits(new Error("nudge exited 137"), [{ sha: "b" }]) as Error,
        resources: {},
        durationMs: 9,
      },
    );

    await expect(pending).rejects.toThrow("nudge exited 137");
    expect(lines.at(-1)).toMatchObject({
      kind: "implementer", signal: "FAILED", commits: 2,
    });
  });

  // #194: the attempt's first-command depth is its first run's, and a nudge
  // supplies it only when the first run measured none.
  it.each([
    ["the nudge when the first run reports none", undefined, 7, 7],
    ["the first run when both report one", 4, 7, 4],
  ])("takes the first-command depth from %s", async (_name, first, nudge, expected) => {
    const { pending, lines } = runPath(
      { ...sandboxResult("no signal", false), ...(first === undefined ? {} : { firstContext: first }) },
      { ...sandboxResult("<promise>COMPLETE</promise>", false), firstContext: nudge },
    );
    await expect(pending).resolves.toMatchObject({ kind: "implementer-result" });
    expect(lines.at(-1)).toMatchObject({
      kind: "implementer",
      usage: { firstContext: expected },
    });
  });

  it("keeps the first run's first-command depth when the nudge fails", async () => {
    const { pending, lines } = runPath(
      { ...sandboxResult("no signal", false, ["a"]), firstContext: 4 },
      { error: new Error("nudge exited 1"), resources: {}, durationMs: 9 },
    );
    await expect(pending).rejects.toThrow("nudge exited 1");
    expect(lines.at(-1)).toMatchObject({
      kind: "implementer", signal: "FAILED", usage: { firstContext: 4 },
    });
  });

  it("merges prior evidence into an OOM-killed nudge failure event", async () => {
    const { pending, lines } = runPath(
      sandboxResult("no signal", false, ["a"], {
        peakMemoryBytes: 1024,
        oomKilled: false,
      }),
      {
        error: new Error("nudge exited 137"),
        resources: { peakMemoryBytes: 8192, oomKilled: true },
        durationMs: 9,
      },
    );

    await expect(pending).rejects.toThrow("nudge exited 137");
    expect(lines.at(-1)).toMatchObject({
      kind: "implementer", signal: "FAILED",
      durationMs: 10,
      peakMemoryBytes: 8192, oomKilled: true,
    });
    // Nothing counted the nudge's commits (#188), so the attempt's total is
    // unknown: absent, not the first run's 1 (#82).
    expect(lines.at(-1)).not.toHaveProperty("commits");
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

  it("forwards the retained correctness rejection to the implementer prompt", async () => {
    innerLoopMocks.buildPrompt.mockClear();
    const { pending } = runPath(
      sandboxResult("done", false),
      sandboxResult("unused", false),
      undefined,
      null,
      "Handle the null branch.",
    );
    await pending;
    expect(innerLoopMocks.buildPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ latestReviewerFeedback: "Handle the null branch." }),
      expect.anything(),
    );
  });

  // #185: each follow-up names what the fixer committed since the previous
  // attempt — and only that, so the list is consumed by the attempt it names.
  it("hands the fixer's commits since the last attempt to the prompt once", async () => {
    innerLoopMocks.buildPrompt.mockClear();
    const quality: QualityLedger = {
      sinceImplementer: ["q1", "q2"],
      overrules: [],
      openRound: null,
      standards: null,
    };
    const { pending } = runPath(
      sandboxResult("done", false),
      sandboxResult("unused", false),
      undefined,
      null,
      null,
      quality,
    );
    await pending;
    expect(innerLoopMocks.buildPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ qualityCommits: ["q1", "q2"] }),
      expect.anything(),
    );
    expect(quality.sinceImplementer).toEqual([]);
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
    expect(lines).toContainEqual(expect.objectContaining({
      kind: "repair", action: "fast-forward", detail: "from=base456 to=head123",
    }));
    expect(lines.at(-1)).toMatchObject({ kind: "implementer", commits: 1 });
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

  it("sends the resume nudge after a run that ended on background tasks (#191)", async () => {
    const { pending, sandbox } = runPath(
      { ...sandboxResult("Waiting for the suite.", false, ["a"]), backgroundTasks: 2 },
      sandboxResult("<promise>COMPLETE</promise>", false, ["b"]),
    );

    await expect(pending).resolves.toMatchObject({ signal: { kind: "COMPLETE" } });
    expect(vi.mocked(sandbox.run).mock.calls[1]?.[0].prompt)
      .toBe(loadTemplate("implementer-promise-nudge-resume"));
  });

  it("sends the plain nudge after a run with no background tasks listed (#191)", async () => {
    const { pending, sandbox } = runPath(
      { ...sandboxResult("Done.", false, ["a"]), backgroundTasks: 0 },
      sandboxResult("<promise>COMPLETE</promise>", false),
    );

    await expect(pending).resolves.toMatchObject({ signal: { kind: "COMPLETE" } });
    expect(vi.mocked(sandbox.run).mock.calls[1]?.[0].prompt)
      .toBe(loadTemplate("implementer-promise-nudge"));
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
  const ctxWith = () => ({
    issue: { id: "91", title: "extensions", branch: "sandbar/issue-91" },
    sandbox: { worktreePath: "/worktree" },
    worktreePath: "/worktree",
    opts: { stackSource: { path: null } },
    config: {
      issueSource: innerLoopMocks.issueSource,
      repo: { owner: "owner", name: "repo" },
      layout: { repoDir: "/repo" },
      sourceBranch: "main",
      claudeMdPath: "CLAUDE.md",
      promptExtensions: {
        implementer: { text: "implementer only" },
        reviewer: { text: "correctness only" },
        reviewerQuality: { text: "quality only" },
        merger: { text: "merger only" },
      },
    },
    base: { ref: "origin/main" },
    accumulated: [{ sha: "abc123" }],
    priorReviewRounds: [],
    quality: { sinceImplementer: [], overrules: [], openRound: null, standards: passStandards },
  });

  // The lister reads its own extension (#204: as standards text, with the
  // built-in group first); the fixer reuses what it read.
  it("hands the quality lister only its own extension", async () => {
    const stop = new Error("stop after prompt construction");
    innerLoopMocks.buildQualityReviewPrompt.mockRejectedValueOnce(stop);
    await expect(runQualityReview(
      { kind: "run-quality-list", attempt: 1, scope: { kind: "full" } },
      ctxWith() as unknown as Parameters<typeof runQualityReview>[1],
    )).rejects.toBe(stop);
    expect(innerLoopMocks.buildQualityReviewPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        standards: expect.objectContaining({
          groups: [
            expect.objectContaining({ id: "sandbar" }),
            expect.objectContaining({ id: "project", body: "quality only" }),
          ],
        }),
      }),
    );
  });

  it("hands the quality fixer the standards its lister read", async () => {
    const stop = new Error("stop after prompt construction");
    innerLoopMocks.buildQualityFixPrompt.mockRejectedValueOnce(stop);
    await expect(runQualityFix(
      { kind: "run-quality-fix", attempt: 1, fixRound: 1, report: "r", ruling: null },
      ctxWith() as unknown as Parameters<typeof runQualityFix>[1],
    )).rejects.toBe(stop);
    expect(innerLoopMocks.buildQualityFixPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ standards: passStandards }),
    );
  });

  it("hands the verifier's white-box review only the reviewer extension", async () => {
    const stop = new Error("stop after prompt construction");
    innerLoopMocks.branchTip.mockReset().mockResolvedValue("abc123");
    innerLoopMocks.buildCorrectnessPrompt.mockRejectedValueOnce(stop);
    await expect(runVerifier(
      { kind: "run-verifier", attempt: 1 },
      ctxWith() as unknown as Parameters<typeof runVerifier>[1],
    )).rejects.toBe(stop);
    expect(innerLoopMocks.buildCorrectnessPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        promptExtension: { text: "correctness only" },
        priorRounds: [],
        scope: { kind: "full" },
      }),
    );
  });
});

describe("runVerifier (#121, #180, #185)", () => {
  const scripted = (
    outputs: {
      output: string;
      error: Error | null;
      durationMs: number;
      resources: ContainerResources;
    }[],
  ) => {
    innerLoopMocks.buildCorrectnessPrompt.mockResolvedValue("correctness prompt");
    innerLoopMocks.measureNetDiffChars.mockResolvedValue(0);
    innerLoopMocks.branchTip.mockReset().mockResolvedValue("head123");
    innerLoopMocks.dirtyWorktreePaths.mockReset().mockResolvedValue([]);
    innerLoopMocks.symbolicHeadRef.mockReset().mockResolvedValue(
      "refs/heads/sandbar/issue-91",
    );
    const filenames: string[] = [];
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn(async (options: Parameters<Sandbox["run"]>[0]) => {
        const result = outputs.shift()!;
        await options.onInvocationEnd?.({
          agent: options.name ?? options.agent.name,
          provider: options.agent.name,
          model: options.model ?? null,
          end: result.error === null ? "exit" : "exec-error",
          detail: result.error?.message ?? null,
          exitCode: result.error === null ? 0 : null,
          durationMs: result.durationMs,
          speech: result.output,
          stdout: result.output,
          stderr: result.error?.message ?? "",
          ...result.resources,
        });
        if (result.error !== null) {
          throw withPartialDurationMs(
            withPartialContainerResources(result.error, result.resources),
            result.durationMs,
          );
        }
        return {
          stdout: result.output,
          commits: [],
          durationMs: result.durationMs,
          silent: false,
          maxGapMs: 1,
          endedBy: "result-then-silence",
          toolCalls: 0,
          ...result.resources,
        };
      }),
      preserveWorktree: vi.fn(),
      syncBranchToCache: vi.fn(),
    } as unknown as Sandbox;
    const ctx = {
      issue: { id: "91", title: "records", branch: "sandbar/issue-91" },
      sandbox,
      worktreePath: "/worktree",
      opts: {
        stackSource: { path: null },
        attemptLogger: {
          writeInvocation: vi.fn(async (filename) => filenames.push(filename)),
        },
        onEvent: vi.fn(),
      },
      config: {
        issueSource: innerLoopMocks.issueSource,
        repo: { owner: "owner", name: "repo" },
        layout: { repoDir: "/repo" },
        sourceBranch: "main",
        claudeMdPath: "CLAUDE.md",
        reviewerQualityAgent: "codex",
        reviewerQualityModelId: "quality-model",
        reviewerAgent: "codex",
        reviewerModelId: "correctness-model",
        maxContextChars: 600_000,
      },
      base: { ref: "origin/main" },
      accumulated: [{ sha: "head123" }],
      priorReviewRounds: [] as unknown[],
      specGaps: [] as unknown[],
      invocationSequence: createAgentInvocationSequencer().startCycle(),
    };
    return {
      ctx,
      sandbox,
      filenames,
      run: () => runVerifier(
        { kind: "run-verifier", attempt: 2 },
        ctx as unknown as Parameters<typeof runVerifier>[1],
      ),
    };
  };

  // #194: each invocation's event names the log it was written to.
  it("names each invocation's log as its event's transcript", async () => {
    const { ctx, filenames, run } = scripted([
      { output: "", error: new Error("review provider failed"), durationMs: 11, resources: {} },
      { output: "<verdict>APPROVED</verdict>", error: null, durationMs: 33, resources: {} },
    ]);
    await run();
    const transcripts = vi.mocked(ctx.opts.onEvent).mock.calls
      .map(([event]) => event)
      .filter((event) => event.kind === "review-pass")
      .map((event) => event.transcript);
    expect(transcripts).toEqual(filenames);
    expect(filenames).toHaveLength(2);
  });

  it("records failed and retried invocations separately and keeps the verdict", async () => {
    const { ctx, filenames, sandbox, run } = scripted([
      {
        output: "", error: new Error("review provider failed"),
        durationMs: 11,
        resources: { peakMemoryBytes: 1000, oomKilled: true },
      },
      {
        output: "<verdict>APPROVED</verdict>", error: null,
        durationMs: 33,
        resources: { peakMemoryBytes: 3000, oomKilled: false },
      },
    ]);
    await expect(run()).resolves.toEqual({
      kind: "verifier-result",
      head: "head123",
      outcome: { kind: "approved" },
    });
    expect(filenames).toEqual([
      "attempt-2-reviewer-1.log",
      "attempt-2-reviewer-2.log",
    ]);
    const invocation = vi.mocked(sandbox.run).mock.calls[0]![0];
    expect(invocation.model).toBe("correctness-model");
    expect(invocation.completionSignal).toEqual([]);
    expect(invocation.env).toBeUndefined();
    expect(ctx.opts.onEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "review-pass", round: 2, invocation: 1, result: "failed",
      durationMs: 11, peakMemoryBytes: 1000, oomKilled: true,
    }));
    expect(ctx.opts.onEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "notice",
      message: expect.stringContaining("no-review — retrying"),
    }));
    expect(ctx.opts.onEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "review-pass", invocation: 2, result: "completed", durationMs: 33,
      endedBy: "result-then-silence",
    }));
    // A failed invocation measured no end, so it reports none (#189).
    const failedPass = vi.mocked(ctx.opts.onEvent).mock.calls
      .map(([event]) => event)
      .find((event) => event.kind === "review-pass" && event.result === "failed");
    expect(failedPass).not.toHaveProperty("endedBy");
    expect(ctx.priorReviewRounds).toEqual([{
      round: 2,
      head: "head123",
      correctness: { verdict: "APPROVED", prose: "<verdict>APPROVED</verdict>", specGap: null },
    }]);
  });

  it("accumulates a declared spec gap beside the history", async () => {
    const { ctx, run } = scripted([{
      output: "<spec-gap>Which currency? Assumed EUR.</spec-gap>\n<verdict>APPROVED</verdict>",
      error: null,
      durationMs: 1,
      resources: {},
    }]);
    await run();
    expect(ctx.specGaps).toEqual([{ round: 2, text: "Which currency? Assumed EUR." }]);
  });

  it("returns a harness failure without recording history", async () => {
    const { ctx, run } = scripted([
      { output: "", error: null, durationMs: 1, resources: {} },
      { output: "no token", error: null, durationMs: 1, resources: {} },
    ]);
    const result = await run();
    expect(result).toMatchObject({
      kind: "verifier-result",
      outcome: { kind: "harness-failed", detail: expect.stringMatching(/^correctness: /) },
    });
    expect(ctx.priorReviewRounds).toEqual([]);
  });

  it("parks an oversized completed branch before dispatching the reviewer", async () => {
    const { sandbox, run } = scripted([]);
    innerLoopMocks.measureNetDiffChars.mockResolvedValueOnce(600_000);
    await expect(run()).resolves.toEqual({
      kind: "context-over-budget",
      slot: "review-correctness",
      size: 600_000 + "correctness prompt".length,
      budget: 600_000,
      detail: "The completed branch exceeds the configured context budget before review.",
    });
    expect(sandbox.run).not.toHaveBeenCalled();
  });

  // From round 2 the white-box reads the change since the last reviewed head
  // HEAD still contains (#180).
  it("anchors a later round at the last reviewed head that HEAD contains", async () => {
    const { ctx, run } = scripted([{
      output: "<verdict>APPROVED</verdict>", error: null, durationMs: 1, resources: {},
    }]);
    const reviewed = (round: number, head: string) => ({
      round,
      head,
      correctness: { verdict: "CHANGES-REQUESTED", prose: "x", specGap: null },
    });
    ctx.priorReviewRounds.push(reviewed(1, "first"), reviewed(2, "second"), reviewed(3, "rewritten"));
    innerLoopMocks.isAncestor.mockReset().mockImplementation(
      async (_cwd, ancestor) => ancestor !== "rewritten",
    );
    await run();
    expect(innerLoopMocks.isAncestor).toHaveBeenCalledWith("/worktree", "second", "head123");
    expect(innerLoopMocks.buildCorrectnessPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: { kind: "since", sha: "second" } }),
    );
  });

  it("returns a detected reviewer write as the round's result", async () => {
    const { sandbox, run } = scripted([{
      output: "<verdict>APPROVED</verdict>", error: null, durationMs: 1, resources: {},
    }]);
    innerLoopMocks.branchTip
      .mockResolvedValueOnce("head123")
      .mockResolvedValueOnce("head123")
      .mockResolvedValueOnce("moved");
    const result = await run();
    expect(result).toMatchObject({
      kind: "verifier-result",
      outcome: { kind: "wrote", cause: "reviewer-wrote" },
    });
    expect(sandbox.preserveWorktree).toHaveBeenCalled();
  });

  it("lets a dead egress proxy propagate instead of failing the reviewer (#202)", async () => {
    const died = new EgressProxyDiedError("egress proxy p died (gone)");
    const { sandbox, run } = scripted([
      { output: "", error: died, durationMs: 1, resources: {} },
    ]);
    await expect(run()).rejects.toBe(died);
    expect(sandbox.run).toHaveBeenCalledOnce();
  });
});

describe("runQualityReview (#187)", () => {
  const reviewer = (
    outputs: readonly (string | Error)[],
    ledger: QualityLedger = { sinceImplementer: [], overrules: [], openRound: null, standards: passStandards },
  ) => {
    innerLoopMocks.buildQualityReviewPrompt.mockReset().mockResolvedValue("quality review prompt");
    innerLoopMocks.measureNetDiffChars.mockReset().mockResolvedValue(0);
    innerLoopMocks.branchTip.mockReset().mockResolvedValue("review-head");
    innerLoopMocks.dirtyWorktreePaths.mockReset().mockResolvedValue([]);
    innerLoopMocks.symbolicHeadRef.mockReset().mockResolvedValue("refs/heads/sandbar/issue-187");
    const filenames: string[] = [];
    const events: EventInput[] = [];
    const queue = [...outputs];
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn(async (options: Parameters<Sandbox["run"]>[0]) => {
        await options.onInvocationEnd?.({
          agent: options.name ?? options.agent.name,
          provider: options.agent.name,
          model: options.model ?? null,
          end: "exit",
          detail: null,
          exitCode: 0,
          durationMs: 4,
          speech: "",
          stdout: "",
          stderr: "",
        });
        const next = queue.shift()!;
        if (next instanceof Error) throw withPartialDurationMs(next, 4);
        return {
          stdout: next,
          commits: [],
          durationMs: 4,
          silent: false,
          maxGapMs: 1,
          toolCalls: 2,
        };
      }),
      preserveWorktree: vi.fn(),
      syncBranchToCache: vi.fn(),
    } as unknown as Sandbox;
    const ctx = {
      issue: { id: "187", title: "quality", branch: "sandbar/issue-187" },
      sandbox,
      worktreePath: "/worktree",
      opts: {
        stackSource: { path: null },
        attemptLogger: {
          writeInvocation: vi.fn(async (filename) => filenames.push(filename)),
        },
        onEvent: (event: EventInput) => events.push(event),
      },
      config: {
        issueSource: innerLoopMocks.issueSource,
        repo: { owner: "owner", name: "repo" },
        layout: { repoDir: "/repo" },
        sourceBranch: "main",
        claudeMdPath: "CLAUDE.md",
        reviewerQualityAgent: "codex",
        reviewerQualityModelId: "quality-model",
        reviewerQualityEffort: "high",
        maxContextChars: 600_000,
        promptExtensions: { reviewerQuality: { text: "quality only" } },
      },
      base: { ref: "origin/main" },
      quality: ledger,
      invocationSequence: createAgentInvocationSequencer().startCycle(),
    };
    const run = (action: Parameters<typeof runQualityReview>[0]) => runQualityReview(action, ctx as unknown as Parameters<typeof runQualityReview>[1]);
    return { ctx, sandbox, events, filenames, run };
  };
  const listAction = {
    kind: "run-quality-list",
    attempt: 3,
    scope: { kind: "full" },
  } as const;
  const verifyAction = {
    kind: "run-quality-verify",
    attempt: 3,
    fixRound: 2,
    anchor: "fix-start",
    report: "### Tests\nsrc/a.ts:3",
  } as const;

  it("opens the round and lists cold, read-only, on the quality routing", async () => {
    const overrule = { round: 1, head: "h0", report: "r", ruling: "fine" };
    const { ctx, sandbox, events, filenames, run } = reviewer(
      ["### Tests\nsrc/a.ts:3\n<verdict>CHANGES-REQUESTED</verdict>"],
      { sinceImplementer: [], overrules: [overrule], openRound: null, standards: null },
    );
    await expect(run(listAction)).resolves.toEqual({
      kind: "quality-review-result",
      mode: "list",
      head: "review-head",
      review: {
        kind: "reviewer-result",
        verdict: "CHANGES-REQUESTED",
        prose: "### Tests\nsrc/a.ts:3\n<verdict>CHANGES-REQUESTED</verdict>",
      },
    });
    expect(ctx.quality.openRound).toMatchObject({ attempt: 3, quality: null });
    expect(ctx.quality.standards?.groups.map((group) => group.body)).toContain("quality only");
    expect(innerLoopMocks.buildQualityReviewPrompt).toHaveBeenCalledWith(expect.objectContaining({
      standards: ctx.quality.standards,
      mode: { kind: "list", scope: { kind: "full" }, overrules: [overrule] },
    }));
    const invocation = vi.mocked(sandbox.run).mock.calls[0]![0];
    expect(invocation).toMatchObject({
      name: "quality-list-187-attempt-3",
      model: "quality-model",
      completionSignal: [],
    });
    expect(invocation.env).toBeUndefined();
    expect(filenames).toEqual(["attempt-3-quality-list-1.log"]);
    expect(events).toEqual([expect.objectContaining({
      kind: "quality-review",
      attempt: 3,
      round: 3,
      invocation: 1,
      mode: "list",
      scope: "full",
      provider: "codex",
      model: "quality-model",
      effort: "high",
      result: "completed",
      verdict: "CHANGES-REQUESTED",
      prose: "### Tests\nsrc/a.ts:3\n<verdict>CHANGES-REQUESTED</verdict>",
      usage: { toolCalls: 2, contextChars: "quality review prompt".length },
    })]);
  });

  it("names a scoped lister's anchor in its record", async () => {
    const { events, run } = reviewer(["<verdict>APPROVED</verdict>"]);
    await run({ ...listAction, scope: { kind: "since", sha: "approved-head" } });
    expect(events).toEqual([expect.objectContaining({ scope: "since:approved-head" })]);
  });

  it("verifies by the standards its lister read, never re-reading the source tip", async () => {
    const sentinel: QualityStandards = { groups: [], preamble: "sentinel", leaveAlone: [], warnings: [] };
    const { ctx, run } = reviewer(
      ["<verdict>APPROVED</verdict>"],
      { sinceImplementer: [], overrules: [], openRound: null, standards: sentinel },
    );
    await run(verifyAction);
    expect(ctx.quality.standards).toBe(sentinel);
    expect(innerLoopMocks.buildQualityReviewPrompt).toHaveBeenCalledWith(expect.objectContaining({
      standards: sentinel,
    }));
  });

  it("rejects a verify that runs before any lister read the standards", async () => {
    const { run } = reviewer(
      ["<verdict>APPROVED</verdict>"],
      { sinceImplementer: [], overrules: [], openRound: null, standards: null },
    );
    await expect(run(verifyAction)).rejects.toThrow(/before any lister read the standards/);
  });

  it("verifies the fixer's step from its anchor without opening a round", async () => {
    const { ctx, events, filenames, sandbox, run } = reviewer(["<verdict>APPROVED</verdict>"]);
    await expect(run(verifyAction)).resolves.toMatchObject({
      kind: "quality-review-result",
      mode: "verify",
      review: { kind: "reviewer-result", verdict: "APPROVED" },
    });
    expect(ctx.quality.openRound).toBeNull();
    expect(innerLoopMocks.buildQualityReviewPrompt).toHaveBeenCalledWith(expect.objectContaining({
      standards: passStandards,
      mode: { kind: "verify", anchor: "fix-start", report: "### Tests\nsrc/a.ts:3" },
    }));
    expect(vi.mocked(sandbox.run).mock.calls[0]![0].name).toBe("quality-verify-187-attempt-3-fix-2");
    expect(filenames).toEqual(["attempt-3-quality-verify-2-1.log"]);
    expect(events).toEqual([expect.objectContaining({
      mode: "verify", scope: "since:fix-start", verdict: "APPROVED",
    })]);
  });

  it("retries a review with no verdict once, then reports the quality pass's harness failure", async () => {
    const { events, run } = reviewer(["no token", new AgentError("codex exited 1")]);
    await expect(run(listAction)).resolves.toMatchObject({
      review: { kind: "reviewer-harness-failed", detail: expect.stringMatching(/^quality: /) },
    });
    expect(events.filter((event) => event.kind === "quality-review")).toEqual([
      expect.objectContaining({ invocation: 1, result: "completed", verdict: null, prose: "no token" }),
      expect.objectContaining({ invocation: 2, result: "failed", verdict: null }),
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "notice",
      message: expect.stringContaining("quality list invocation=1/2 no-review — retrying"),
    }));
  });

  it("returns a write as the review's result and keeps the clone", async () => {
    const { sandbox, run } = reviewer(["<verdict>APPROVED</verdict>"]);
    innerLoopMocks.branchTip
      .mockResolvedValueOnce("review-head")
      .mockResolvedValueOnce("review-head")
      .mockResolvedValueOnce("moved");
    await expect(run(verifyAction)).resolves.toMatchObject({
      review: { kind: "reviewer-wrote", detail: expect.stringContaining("Quality reviewer changed git state") },
    });
    expect(sandbox.preserveWorktree).toHaveBeenCalledWith(
      expect.stringContaining("quality reviewer changed the repository"),
    );
  });

  it("classifies a provider size refusal as a partition terminal", async () => {
    const { run } = reviewer([new AgentInputTooLargeError("input_too_large")]);
    await expect(run(listAction)).rejects.toMatchObject({
      verdict: { type: "NEEDS-PARTITION", cause: "provider-refused", slot: "review-quality" },
    });
  });

  it("parks an oversized branch before the review runs", async () => {
    const { sandbox, run } = reviewer([]);
    innerLoopMocks.measureNetDiffChars.mockResolvedValueOnce(600_000);
    await expect(run(verifyAction)).resolves.toEqual({
      kind: "context-over-budget",
      slot: "review-quality",
      size: 600_000 + "quality review prompt".length,
      budget: 600_000,
      detail: "The completed branch exceeds the configured context budget before the quality verify.",
    });
    expect(sandbox.run).not.toHaveBeenCalled();
  });
});

describe("runQualityFix (#185, #187)", () => {
  type Outcome =
    | { readonly kind: "exit"; readonly stdout?: string }
    | { readonly kind: "error"; readonly error: Error };
  const fixer = (
    outcomes: Outcome | readonly Outcome[],
    ledger: QualityLedger = { sinceImplementer: [], overrules: [], openRound: null, standards: passStandards },
  ) => {
    const queue = Array.isArray(outcomes) ? [...outcomes] : null;
    innerLoopMocks.buildQualityFixPrompt.mockReset().mockResolvedValue("quality fix prompt");
    innerLoopMocks.measureNetDiffChars.mockReset().mockResolvedValue(0);
    innerLoopMocks.branchTip.mockReset()
      .mockResolvedValueOnce("impl-head")
      .mockResolvedValueOnce("impl-head")
      .mockResolvedValue("fixer-head");
    innerLoopMocks.settleQualityResidue.mockReset().mockResolvedValue({
      commits: [{ sha: "q1" }, { sha: "q2" }],
      residue: { dirtyPaths: [" M scratch.ts"], strandedHead: null, rewoundTip: null },
    });
    const filenames: string[] = [];
    const events: EventInput[] = [];
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn(async (options: Parameters<Sandbox["run"]>[0]) => {
        await options.onInvocationEnd?.({
          agent: options.name ?? options.agent.name,
          provider: options.agent.name,
          model: options.model ?? null,
          end: "exit",
          detail: null,
          exitCode: 0,
          durationMs: 7,
          speech: "",
          stdout: "",
          stderr: "",
        });
        const outcome = queue === null ? outcomes as Outcome : queue.shift()!;
        if (outcome.kind === "error") {
          throw withPartialDurationMs(
            withPartialContainerResources(outcome.error, { peakMemoryBytes: 9 }),
            7,
          );
        }
        return {
          stdout: outcome.stdout ?? "fixed things",
          commits: [],
          durationMs: 7,
          silent: false,
          maxGapMs: 2,
          toolCalls: 3,
          peakMemoryBytes: 5,
        };
      }),
      syncBranchToCache: vi.fn(),
    } as unknown as Sandbox;
    const ctx = {
      issue: { id: "185", title: "fixer", branch: "sandbar/issue-185" },
      sandbox,
      worktreePath: "/worktree",
      opts: {
        stackSource: { path: null },
        attemptLogger: {
          writeInvocation: vi.fn(async (filename) => filenames.push(filename)),
        },
        onEvent: (event: EventInput) => events.push(event),
      },
      config: {
        issueSource: innerLoopMocks.issueSource,
        repo: { owner: "owner", name: "repo" },
        layout: { repoDir: "/repo" },
        sourceBranch: "main",
        claudeMdPath: "CLAUDE.md",
        reviewerQualityAgent: "codex",
        reviewerQualityModelId: "quality-model",
        reviewerQualityEffort: "high",
        reviewerAgent: "claude",
        reviewerModelId: "opus",
        maxContextChars: 600_000,
        botName: "sandbar-bot",
        botEmail: "bot@example.test",
      },
      base: { ref: "origin/main" },
      accumulated: [{ sha: "impl-head" }] as { sha: string }[],
      quality: ledger,
      invocationSequence: createAgentInvocationSequencer().startCycle(),
    };
    return {
      ctx,
      sandbox,
      events,
      filenames,
      run: (ruling: string | null = null) => runQualityFix(
        { kind: "run-quality-fix", attempt: 3, fixRound: 2, report: "the report", ruling },
        ctx as unknown as Parameters<typeof runQualityFix>[1],
      ),
    };
  };

  it("rejects a fixer that runs before any lister read the standards", async () => {
    const { run } = fixer(
      { kind: "exit" },
      { sinceImplementer: [], overrules: [], openRound: null, standards: null },
    );
    await expect(run()).rejects.toThrow(/before any lister read the standards/);
  });

  it("runs a cold fixer on its own routing under the quality author", async () => {
    const { sandbox, filenames, run } = fixer({ kind: "exit" });
    await run("upheld because");
    const invocation = vi.mocked(sandbox.run).mock.calls[0]![0];
    expect(invocation).toMatchObject({
      name: "quality-fix-185-attempt-3-fix-2",
      model: "quality-model",
      prompt: "quality fix prompt",
      completionSignal: [],
      env: {
        GIT_AUTHOR_NAME: "sandbar-bot (quality)",
        GIT_AUTHOR_EMAIL: "bot@example.test",
      },
    });
    expect(invocation.agent.name).toBe("codex");
    expect(invocation.agent.buildPrintCommand({ prompt: "p" }).command)
      .toContain("-c 'model_reasoning_effort=high'");
    expect(filenames).toEqual(["attempt-3-quality-fix-2-1.log"]);
    expect(innerLoopMocks.buildQualityFixPrompt).toHaveBeenCalledWith(expect.objectContaining({
      report: "the report",
      ruling: "upheld because",
    }));
  });

  // #194: the event names the fixer's log and carries the first command's depth.
  it("names its log and its first command's depth on the quality-pass event", async () => {
    const { sandbox, events, run } = fixer({ kind: "exit" });
    vi.mocked(sandbox.run).mockImplementationOnce(async () => ({
      stdout: "fixed", commits: [], durationMs: 7, silent: false, maxGapMs: 2,
      toolCalls: 3, firstContext: 21, peakContext: 40,
    })) as never;
    await run();
    expect(events).toEqual([expect.objectContaining({
      kind: "quality-pass",
      transcript: "attempt-3-quality-fix-2-1.log",
      usage: expect.objectContaining({ firstContext: 21, peakContext: 40 }),
    })]);
  });

  it("keeps a failed fixer's partial first-command depth", async () => {
    const { events, run } = fixer({
      kind: "error",
      error: withPartialOutput(
        new AgentError("codex exited with code 1"), "", undefined, 2, 30, undefined, 12,
      ),
    });
    await run();
    expect(events.filter((event) => event.kind === "quality-pass")[0]).toMatchObject({
      result: "failed",
      transcript: "attempt-3-quality-fix-2-1.log",
      usage: { firstContext: 12 },
    });
  });

  it("settles what it left from the head it was handed, publishes, and reports its commits", async () => {
    const { ctx, sandbox, events, run } = fixer({ kind: "exit" });
    await expect(run()).resolves.toEqual({
      kind: "quality-fix-result",
      startHead: "impl-head",
      head: "fixer-head",
      commits: 2,
      exited: "completed",
    });
    expect(innerLoopMocks.settleQualityResidue).toHaveBeenCalledWith(
      "/worktree",
      "sandbar/issue-185",
      "impl-head",
    );
    expect(sandbox.syncBranchToCache).toHaveBeenCalledTimes(1);
    expect(ctx.accumulated).toEqual([{ sha: "impl-head" }, { sha: "q1" }, { sha: "q2" }]);
    expect(ctx.quality.sinceImplementer).toEqual(["q1", "q2"]);
    expect(events).toEqual([expect.objectContaining({
      kind: "quality-pass",
      issue: 185,
      attempt: 3,
      round: 3,
      provider: "codex",
      model: "quality-model",
      effort: "high",
      result: "completed",
      commits: ["q1", "q2"],
      discarded: { dirtyPaths: [" M scratch.ts"], strandedHead: null, rewoundTip: null },
      durationMs: 7,
      maxGapMs: 2,
      peakMemoryBytes: 5,
      usage: { toolCalls: 3, contextChars: "quality fix prompt".length },
    })]);
  });

  // A crash is not a refusal: the invocation has still ended, what it
  // committed is settled and kept, and it gets one cold retry.
  it.each([
    ["a failed exit", new AgentError("codex exited with code 1")],
    ["an idle timeout", new AgentIdleTimeoutError("Agent idle for 600 seconds", 600_000)],
  ])("settles %s and retries it once", async (_name, error) => {
    const { sandbox, events, filenames, run } = fixer({ kind: "error", error });
    await expect(run()).resolves.toEqual({
      kind: "quality-fix-result",
      startHead: "impl-head",
      head: "fixer-head",
      commits: 4,
      exited: "failed",
    });
    expect(sandbox.run).toHaveBeenCalledTimes(QUALITY_FIXER_MAX_INVOCATIONS);
    expect(vi.mocked(sandbox.run).mock.calls[1]![0].name)
      .toBe("quality-fix-185-attempt-3-fix-2-invocation-2");
    expect(filenames).toEqual(["attempt-3-quality-fix-2-1.log", "attempt-3-quality-fix-2-2.log"]);
    expect(innerLoopMocks.settleQualityResidue.mock.calls.map(([, , from]) => from))
      .toEqual(["impl-head", "fixer-head"]);
    expect(sandbox.syncBranchToCache).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.kind === "quality-pass")).toEqual([
      expect.objectContaining({ result: "failed", commits: ["q1", "q2"], peakMemoryBytes: 9 }),
      expect.objectContaining({ result: "failed", commits: ["q1", "q2"] }),
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "notice",
      message: expect.stringContaining("quality fixer invocation=1/2 failed — retrying"),
    }));
  });

  it("stops retrying once an invocation exits normally", async () => {
    const { sandbox, run } = fixer([
      { kind: "error", error: new AgentError("codex exited with code 1") },
      { kind: "exit" },
    ]);
    await expect(run()).resolves.toMatchObject({ exited: "completed", commits: 4 });
    expect(sandbox.run).toHaveBeenCalledTimes(2);
  });

  it("closes the provider on quota without settling or retrying", async () => {
    const quota = new AgentQuotaError("codex", {
      status: "rejected",
      window: "five_hour",
      resetsAt: 1,
    });
    const { sandbox, events, run } = fixer({ kind: "error", error: quota });
    await expect(run()).rejects.toBe(quota);
    expect(sandbox.run).toHaveBeenCalledTimes(1);
    expect(innerLoopMocks.settleQualityResidue).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({ kind: "quality-pass", result: "quota" })]);
    expect(events[0]).not.toHaveProperty("commits");
  });

  it("classifies a provider size refusal as a partition terminal", async () => {
    const { run } = fixer({ kind: "error", error: new AgentInputTooLargeError("input_too_large") });
    await expect(run()).rejects.toMatchObject({
      verdict: { type: "NEEDS-PARTITION", cause: "provider-refused", slot: "review-quality" },
    });
  });

  it("propagates an infrastructure failure untouched", async () => {
    const infra = new Error("podman exec failed: no such container");
    const { events, run } = fixer({ kind: "error", error: infra });
    await expect(run()).rejects.toBe(infra);
    expect(innerLoopMocks.settleQualityResidue).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("parks an oversized branch before the fixer runs", async () => {
    const { sandbox, run } = fixer({ kind: "exit" });
    innerLoopMocks.measureNetDiffChars.mockResolvedValueOnce(600_000);
    await expect(run()).resolves.toMatchObject({
      kind: "context-over-budget",
      slot: "review-quality",
      budget: 600_000,
    });
    expect(sandbox.run).not.toHaveBeenCalled();
  });

  it("spells the author from the bot identity", () => {
    expect(qualityAuthorEnv({ botName: "bot", botEmail: "b@x" })).toEqual({
      GIT_AUTHOR_NAME: "bot (quality)",
      GIT_AUTHOR_EMAIL: "b@x",
    });
  });
});

describe("closedReviewRound (#132, #185)", () => {
  const gate = (ok: boolean) => ({
    kind: "gate-result" as const,
    head: "h",
    gate: { ok, failureTrace: ok ? "" : "x", failedStep: ok ? null : "test" },
    stackChange: null,
  });
  const correctness = (reviewer: ReviewerResult) =>
    ({ kind: "verifier-result" as const, head: "h", outcome: combineVerifier(reviewer) });

  it.each([
    ["a green gate, which leaves the round open", gate(true), null],
    ["a red gate", gate(false), { head: "h", gateOk: false, correctness: "SKIPPED" }],
    [
      "an approval",
      correctness({ kind: "reviewer-result", verdict: "APPROVED", prose: "" }),
      { head: "h", gateOk: true, correctness: "APPROVED" },
    ],
    [
      "a rejection",
      correctness({ kind: "reviewer-result", verdict: "CHANGES-REQUESTED", prose: "" }),
      { head: "h", gateOk: true, correctness: "CHANGES-REQUESTED" },
    ],
    [
      "a harness failure",
      correctness({ kind: "reviewer-harness-failed", detail: "" }),
      { head: "h", gateOk: true, correctness: "HARNESS-FAILED" },
    ],
    [
      "a reviewer write, which parks instead",
      correctness({ kind: "reviewer-wrote", detail: "" }),
      null,
    ],
    [
      "a quality review",
      {
        kind: "quality-review-result" as const,
        mode: "list" as const,
        head: "h",
        review: { kind: "reviewer-result" as const, verdict: "APPROVED" as const, prose: "" },
      },
      null,
    ],
    [
      "a fixer result",
      { kind: "quality-fix-result" as const, startHead: "h", head: "h", commits: 1, exited: "completed" as const },
      null,
    ],
  ] as const)("closes on %s", (_name, event, expected) => {
    expect(closedReviewRound(event)).toEqual(expected);
  });
});

describe("runAdjudicator (#167)", () => {
  const action = {
    kind: "run-adjudicator" as const,
    attempt: 2,
    pass: "correctness" as const,
    rejection: { round: 1, head: "head123", report: "false report" },
  };

  const context = (
    sandbox: Sandbox,
    events: EventInput[] = [],
  ): Parameters<typeof runAdjudicator>[1] => ({
    issue: { id: "167", title: "adjudicate", branch: "sandbar/issue-167" },
    sandbox,
    opts: {
      stackSource: { path: null },
      attemptLogger: { writeInvocation: vi.fn() },
      onEvent: async (event: EventInput) => { events.push(event); },
    },
    config: {
      issueSource: innerLoopMocks.issueSource,
      repo: { owner: "owner", name: "repo" },
      layout: { repoDir: "/repo" },
      sourceBranch: "main",
      claudeMdPath: "CLAUDE.md",
      maxContextChars: 1000,
      adjudicatorAgent: "codex",
      adjudicatorModelId: "judge-model",
    },
    base: { ref: "origin/main" },
    quality: { sinceImplementer: [], overrules: [], openRound: null, standards: null },
    invocationSequence: createAgentInvocationSequencer().startCycle(),
  } as unknown as Parameters<typeof runAdjudicator>[1]);

  const unchangedAdjudicatorSnapshot = () => {
    innerLoopMocks.branchTip.mockReset().mockResolvedValue("head123");
    innerLoopMocks.dirtyWorktreePaths.mockReset().mockResolvedValue([]);
    innerLoopMocks.symbolicHeadRef.mockReset().mockResolvedValue(
      "refs/heads/sandbar/issue-167",
    );
  };

  it("returns an overrule with its reasoning and stays read-only", async () => {
    unchangedAdjudicatorSnapshot();
    const filenames: string[] = [];
    const events: EventInput[] = [];
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn(async (options: Parameters<Sandbox["run"]>[0]) => {
        await options.onInvocationEnd?.({
          agent: options.name ?? options.agent.name,
          provider: options.agent.name,
          model: options.model ?? null,
          end: "exit",
          detail: null,
          exitCode: 0,
          durationMs: 17,
          speech: "five arguments\n<ruling>OVERRULED</ruling>",
          stdout: "five arguments\n<ruling>OVERRULED</ruling>",
          stderr: "",
        });
        return {
          stdout: "five arguments\n<ruling>OVERRULED</ruling>",
          commits: [],
          durationMs: 17,
          silent: false,
          maxGapMs: 2,
          toolCalls: 3,
        };
      }),
    } as unknown as Sandbox;
    const ctx = context(sandbox, events);
    vi.mocked(ctx.opts.attemptLogger.writeInvocation).mockImplementation(
      async (filename) => { filenames.push(filename); },
    );

    await expect(runAdjudicator(action, ctx)).resolves.toEqual({
      kind: "adjudicator-result",
      head: "head123",
      ruling: "OVERRULED",
      reasoning: "five arguments",
    });
    expect(vi.mocked(sandbox.run).mock.calls[0]![0].name).toBe("adjudicator-167-round-1");
    expect(filenames).toEqual(["attempt-2-adjudicator-1.log"]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "adjudication",
      round: 1,
      head: "head123",
      ruling: "OVERRULED",
      durationMs: expect.any(Number),
      usage: expect.objectContaining({ toolCalls: 3 }),
    }));
    expect(events.find((event) => event.kind === "adjudication")).toMatchObject({
      pass: "correctness",
      transcript: "attempt-2-adjudicator-1.log",
    });
    expect(innerLoopMocks.buildAdjudicatorPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ pass: "correctness" }),
    );
    expect(ctx.quality.overrules).toEqual([]);
  });

  // #194: the first-command depth is the first invocation's, even when that
  // one failed and a later one ruled.
  it("keeps the first invocation's first-command depth across a retry", async () => {
    unchangedAdjudicatorSnapshot();
    const events: EventInput[] = [];
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn()
        .mockRejectedValueOnce(
          withPartialOutput(new Error("adjudicator failed"), "", undefined, 1, 5, undefined, 11),
        )
        .mockResolvedValueOnce({
          stdout: "reasons\n<ruling>UPHELD</ruling>",
          commits: [],
          durationMs: 3,
          silent: false,
          maxGapMs: 1,
          toolCalls: 2,
          firstContext: 99,
        }),
    } as unknown as Sandbox;
    await runAdjudicator(action, context(sandbox, events));
    expect(events.find((event) => event.kind === "adjudication")).toMatchObject({
      ruling: "UPHELD",
      transcript: "attempt-2-adjudicator-2.log",
      usage: { firstContext: 11 },
    });
  });

  // #187: a quality ruling is named for its fixer round, and an overrule is
  // kept for later listers.
  it("keeps an overruled quality report with its ruling", async () => {
    unchangedAdjudicatorSnapshot();
    const filenames: string[] = [];
    const events: EventInput[] = [];
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn(async (options: Parameters<Sandbox["run"]>[0]) => {
        await options.onInvocationEnd?.({
          agent: options.name ?? options.agent.name,
          provider: options.agent.name,
          model: options.model ?? null,
          end: "exit",
          detail: null,
          exitCode: 0,
          durationMs: 3,
          speech: "",
          stdout: "",
          stderr: "",
        });
        return {
          stdout: "the test exists\n<ruling>OVERRULED</ruling>",
          commits: [],
          durationMs: 3,
          silent: false,
          maxGapMs: 1,
          toolCalls: 1,
        };
      }),
    } as unknown as Sandbox;
    const ctx = context(sandbox, events);
    vi.mocked(ctx.opts.attemptLogger.writeInvocation).mockImplementation(
      async (filename) => { filenames.push(filename); },
    );
    const quality = {
      ...action,
      pass: "quality" as const,
      fixRound: 2,
      rejection: { round: 2, head: "head123", report: "### Tests\nmissing" },
    };

    await expect(runAdjudicator(quality, ctx)).resolves.toMatchObject({ ruling: "OVERRULED" });
    expect(vi.mocked(sandbox.run).mock.calls[0]![0].name)
      .toBe("quality-adjudicator-167-round-2-fix-2");
    expect(filenames).toEqual(["attempt-2-quality-adjudicator-2-1.log"]);
    expect(innerLoopMocks.buildAdjudicatorPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ pass: "quality", head: "head123", report: "### Tests\nmissing" }),
    );
    expect(events).toContainEqual(expect.objectContaining({
      kind: "adjudication", pass: "quality", round: 2, ruling: "OVERRULED",
      transcript: "attempt-2-quality-adjudicator-2-1.log",
    }));
    expect(ctx.quality.overrules).toEqual([{
      round: 2, head: "head123", report: "### Tests\nmissing", ruling: "the test exists",
    }]);
  });

  it.each([
    ["completed", "tip"],
    ["completed", "status"],
    ["completed", "HEAD"],
    ["failed", "tip"],
    ["failed", "status"],
    ["failed", "HEAD"],
  ] as const)(
    "parks when a %s adjudicator invocation changes %s",
    async (outcome, changed) => {
      unchangedAdjudicatorSnapshot();
      if (changed === "tip") {
        innerLoopMocks.branchTip
          .mockReset()
          .mockResolvedValueOnce("head123")
          .mockResolvedValueOnce("moved-head");
      } else if (changed === "status") {
        innerLoopMocks.dirtyWorktreePaths
          .mockReset()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([" M changed.ts"]);
      } else {
        innerLoopMocks.symbolicHeadRef
          .mockReset()
          .mockResolvedValueOnce("refs/heads/sandbar/issue-167")
          .mockResolvedValueOnce(null);
      }
      const preserveWorktree = vi.fn();
      const syncBranchToCache = vi.fn(async () => undefined);
      const ruling = "evidence\n<ruling>OVERRULED</ruling>";
      const sandbox = {
        worktreePath: "/worktree",
        preserveWorktree,
        syncBranchToCache,
        run: vi.fn(async () => {
          if (outcome === "failed") {
            throw withPartialOutput(
              new AgentError("teardown failed"),
              ruling,
              undefined,
              0,
              undefined,
              undefined,
            );
          }
          return {
            stdout: ruling,
            commits: [],
            durationMs: 5,
            silent: false,
            maxGapMs: 1,
            toolCalls: 0,
          };
        }),
      } as unknown as Sandbox;
      const events: EventInput[] = [];

      await expect(runAdjudicator(action, context(sandbox, events))).resolves.toMatchObject({
        kind: "adjudicator-wrote",
      });
      expect(sandbox.run).toHaveBeenCalledOnce();
      expect(preserveWorktree).toHaveBeenCalledOnce();
      expect(syncBranchToCache).toHaveBeenCalledOnce();
      expect(events.some((event) => event.kind === "phase")).toBe(false);
      expect(events.some((event) => event.kind === "adjudication")).toBe(false);
    },
  );

  it.each([
    ["quota", new AgentQuotaError("codex", { status: "rejected", window: "five_hour" })],
    ["credential", new AgentCredentialError("refresh refused")],
  ] as const)("propagates an adjudicator %s refusal after enforcing read-only state", async (_kind, refusal) => {
    unchangedAdjudicatorSnapshot();
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn(async () => { throw refusal; }),
    } as unknown as Sandbox;

    await expect(runAdjudicator(action, context(sandbox))).rejects.toBe(refusal);
    expect(sandbox.run).toHaveBeenCalledOnce();
    expect(innerLoopMocks.branchTip).toHaveBeenCalledTimes(2);
  });

  it("classifies an adjudicator input refusal as a partition terminal", async () => {
    unchangedAdjudicatorSnapshot();
    const refusal = new AgentInputTooLargeError("actual_chars=1001");
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn(async () => { throw refusal; }),
    } as unknown as Sandbox;

    await expect(runAdjudicator(action, context(sandbox))).rejects.toMatchObject({
      verdict: {
        type: "NEEDS-PARTITION",
        cause: "provider-refused",
        slot: "adjudication",
        detail: "actual_chars=1001",
      },
    });
    expect(sandbox.run).toHaveBeenCalledOnce();
  });

  it("classifies an adjudication measured over budget before dispatch", async () => {
    innerLoopMocks.buildAdjudicatorPrompt.mockResolvedValueOnce("0123456789");
    innerLoopMocks.measureNetDiffChars.mockResolvedValueOnce(991);
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn(),
    } as unknown as Sandbox;

    await expect(runAdjudicator(action, context(sandbox))).rejects.toMatchObject({
      verdict: {
        type: "NEEDS-PARTITION",
        cause: "measured",
        slot: "adjudication",
        size: 1001,
        budget: 1000,
      },
    });
    expect(sandbox.run).not.toHaveBeenCalled();
  });

  it("retries a missing ruling once, then returns a harness failure", async () => {
    unchangedAdjudicatorSnapshot();
    const events: EventInput[] = [];
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn(async () => ({
        stdout: "reasoning without the required token",
        commits: [],
        durationMs: 5,
        silent: false,
        maxGapMs: 1,
        toolCalls: 0,
      })),
    } as unknown as Sandbox;

    await expect(runAdjudicator(action, context(sandbox, events))).resolves.toMatchObject({
      kind: "adjudicator-harness-failed",
      detail: expect.stringMatching(/invocation 1\/2[\s\S]*invocation 2\/2/),
    });
    expect(sandbox.run).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "notice",
      message: expect.stringContaining("no-ruling — retrying"),
    }));
    expect(events.filter((event) => event.kind === "complaint")).toHaveLength(0);
  });

  it("accepts a ruling emitted by a failed adjudicator invocation", async () => {
    unchangedAdjudicatorSnapshot();
    const events: EventInput[] = [];
    const failure = withPartialOutput(
      new AgentError("teardown failed"),
      "the report is true\n<ruling>UPHELD</ruling>",
      { inputTokens: 12 },
      2,
      34,
      undefined,
    );
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn(async () => { throw failure; }),
    } as unknown as Sandbox;

    await expect(runAdjudicator(action, context(sandbox, events))).resolves.toMatchObject({
      kind: "adjudicator-result",
      ruling: "UPHELD",
      reasoning: "the report is true",
    });
    expect(sandbox.run).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({
      kind: "adjudication",
      ruling: "UPHELD",
      usage: expect.objectContaining({ inputTokens: 12, toolCalls: 2, peakContext: 34 }),
    }));
  });
});

describe("runGate admission (#142)", () => {
  it("starts a second completed attempt only after the first gate finishes", async () => {
    let now = 0;
    const gateSemaphore = createGateSemaphore(1, () => now);
    const firstGate = deferred<GateResult>();
    const starts: string[] = [];
    const events: EventInput[] = [];
    const result: GateResult = {
      ok: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
      failedStep: null,
      durationMs: 7,
      steps: [],
      containerLogs: "",
    };
    innerLoopMocks.branchTip.mockReset().mockResolvedValue("tip-a");
    const context = (id: string, runGate: () => Promise<GateResult>) => ({
      issue: { id, title: `Issue ${id}`, branch: `sandbar/issue-${id}` },
      worktreePath: "/worktree",
      opts: {
        gateSemaphore,
        attemptLogger: { writeGate: vi.fn() },
        onEvent: (event: EventInput) => events.push(event),
        stackSource: {
          forHead: async () => ({ stack: { containers: [], steps: [] }, classification: { kind: "same" } }),
        },
      },
      gateStack: { ensure: async () => ({ runGate }) },
      reportGateStack: async () => undefined,
      quality: { sinceImplementer: [], overrules: [], openRound: { attempt: 1, timer: () => 0, quality: null } },
      invocationSequence: createAgentInvocationSequencer().startCycle(),
    }) as unknown as Parameters<typeof runGate>[1];

    const first = runGate(
      { kind: "run-gate", attempt: 1, quality: { verdict: "APPROVED", rounds: 0 } },
      context("1", async () => {
        starts.push("attempt-1");
        return await firstGate.promise;
      }),
    );
    const second = runGate(
      { kind: "run-gate", attempt: 1, quality: { verdict: "APPROVED", rounds: 0 } },
      context("2", async () => {
        starts.push("attempt-2");
        return result;
      }),
    );

    await vi.waitFor(() => expect(starts).toEqual(["attempt-1"]));
    now = 12;
    firstGate.resolve(result);
    const green = {
      kind: "gate-result",
      head: "tip-a",
      stackChange: null,
      gate: { ok: true, failureTrace: "", failedStep: null },
    };
    await expect(first).resolves.toEqual(green);
    await expect(second).resolves.toEqual(green);
    expect(starts).toEqual(["attempt-1", "attempt-2"]);
    expect(events).toEqual([
      expect.objectContaining({ kind: "gate", issue: 1, gate: "gate-1" }),
      expect.objectContaining({
        kind: "gate", issue: 2, gate: "gate-1", queuedMs: 12,
      }),
    ]);
    expect(events[0]).not.toHaveProperty("queuedMs");
  });

  it("files the gate output as the attempt's artefact before reporting it (#153)", async () => {
    const writeGate = vi.fn();
    // A sequencer that has already spent three attempts on an earlier cycle,
    // as a HARD-ERROR retry's would have: the state machine restarts its
    // attempt counter at 1, so the gate artefact is only named correctly if it
    // is allocated from the cycle rather than from `agentInvocationFilename`.
    // `writeGate` is create-only, so getting this wrong throws EEXIST out of
    // `runGate` and turns a readmission into a HARD-ERROR.
    const sequencer = createAgentInvocationSequencer();
    sequencer.startCycle().filename({ role: "implementer", attempt: 3, nudge: false });
    const gate: GateResult = {
      ok: false,
      stdout: "=== test ===\nfail",
      stderr: "boom",
      exitCode: 1,
      failedStep: "test",
      durationMs: 9,
      steps: [],
      containerLogs: "db tail",
    };
    innerLoopMocks.branchTip.mockReset().mockResolvedValue("tip-a");
    const ctx = {
      issue: { id: "153", title: "gate log", branch: "sandbar/issue-153" },
      worktreePath: "/worktree",
      opts: {
        gateSemaphore: createGateSemaphore(undefined),
        attemptLogger: { writeGate },
        onEvent: () => undefined,
        stackSource: {
          forHead: async () => ({ stack: { containers: [], steps: [] }, classification: { kind: "same" } }),
        },
      },
      gateStack: { ensure: async () => ({ runGate: async () => gate }) },
      reportGateStack: async () => undefined,
      quality: { sinceImplementer: [], overrules: [], openRound: { attempt: 2, timer: () => 0, quality: null } },
      invocationSequence: sequencer.startCycle(),
    } as unknown as Parameters<typeof runGate>[1];

    const result = await runGate({
      kind: "run-gate",
      attempt: 2,
      quality: { verdict: "CHANGES-REQUESTED", rounds: 3 },
    }, ctx);
    // How the quality pass ended is kept for the round's record.
    expect(ctx.quality.openRound?.quality).toEqual({ verdict: "CHANGES-REQUESTED", rounds: 3 });
    expect(result.gate.ok).toBe(false);
    expect(result.gate.failedStep).toBe("test");
    expect(result.gate.failureTrace).toContain("db tail");
    expect(writeGate).toHaveBeenCalledWith("attempt-5-gate.log", {
      ok: false,
      stdout: "=== test ===\nfail",
      stderr: "boom",
      failedStep: "test",
      exitCode: 1,
      containerLogs: "db tail",
    });
  });

  // #186: the stack in effect is resolved for the head being gated, so a tip
  // that moved mid-issue, or the branch's own env edit, reaches the next gate-1.
  describe("the stack in effect", () => {
    const green: GateResult = {
      ok: true, stdout: "", stderr: "", exitCode: 0, failedStep: null,
      durationMs: 1, steps: [], containerLogs: "",
    };
    const tipStack = { containers: [], steps: [] };
    const laterStack = { containers: [], steps: [{ name: "later", in: "x", command: ["true"] }] };
    const context = (forHead: ReturnType<typeof vi.fn>) => {
      const runGateOnBound = vi.fn(async () => green);
      const ensure = vi.fn(async () => ({ runGate: runGateOnBound }));
      const reportGateStack = vi.fn(async () => undefined);
      const ctx = {
        issue: { id: "186", title: "stack", branch: "sandbar/issue-186" },
        worktreePath: "/worktree",
        opts: {
          gateSemaphore: createGateSemaphore(undefined),
          attemptLogger: { writeGate: vi.fn() },
          onEvent: () => undefined,
          stackSource: { forHead },
        },
        gateStack: { ensure },
        reportGateStack,
        quality: { sinceImplementer: [], overrules: [], openRound: { attempt: 1, timer: () => 0, quality: null } },
        invocationSequence: createAgentInvocationSequencer().startCycle(),
      } as unknown as Parameters<typeof runGate>[1];
      return { ctx, ensure, runGateOnBound, reportGateStack };
    };
    const action = (attempt: number) => ({
      kind: "run-gate" as const,
      attempt,
      quality: { verdict: "APPROVED" as const, rounds: 0 },
    });

    it("resolves it for the gated head before every gate-1 and runs the stack bound to it", async () => {
      const first = { stack: tipStack, classification: { kind: "same" } };
      const later = { stack: laterStack, classification: { kind: "env-only", containers: ["x"] } };
      const forHead = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(later);
      innerLoopMocks.branchTip.mockReset().mockResolvedValueOnce("tip-a").mockResolvedValueOnce("tip-b");
      const { ctx, ensure, runGateOnBound, reportGateStack } = context(forHead);

      const result = await runGate(action(1), ctx);

      expect(forHead).toHaveBeenCalledExactlyOnceWith("/worktree", "tip-a");
      expect(reportGateStack).toHaveBeenCalledExactlyOnceWith(first);
      expect(ensure).toHaveBeenCalledExactlyOnceWith(tipStack);
      expect(runGateOnBound).toHaveBeenCalledOnce();
      expect(result.gate.ok).toBe(true);
      expect(result.stackChange).toBeNull();

      await runGate(action(2), ctx);
      expect(forHead).toHaveBeenLastCalledWith("/worktree", "tip-b");
      expect(reportGateStack).toHaveBeenLastCalledWith(later);
      expect(ensure).toHaveBeenLastCalledWith(laterStack);
    });

    it("still runs gate-1 on the tip's stack for a non-env change, and reports the change", async () => {
      const differences = [{ where: "container 'db'", what: "mounts" }];
      const forHead = vi.fn(async () => ({
        stack: tipStack,
        classification: { kind: "non-env", path: "gate/stack.json", differences },
      }));
      innerLoopMocks.branchTip.mockReset().mockResolvedValue("tip-a");
      const { ctx, ensure, runGateOnBound } = context(forHead);

      const result = await runGate(action(1), ctx);

      expect(ensure).toHaveBeenCalledExactlyOnceWith(tipStack);
      expect(runGateOnBound).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        gate: { ok: true },
        stackChange: { path: "gate/stack.json", differences },
      });
    });
  });
});

describe("runInnerLoop context terminals (#158)", () => {
  const issue = {
    id: "158",
    title: "context budget",
    branch: "sandbar/issue-158-context-budget",
  };
  const completeRun = {
    stdout: "<promise>COMPLETE</promise>",
    commits: [{ sha: "head123" }],
    durationMs: 1,
    silent: false,
    maxGapMs: 1,
    toolCalls: 0,
  };
  const approvedReview = {
    stdout: "<verdict>APPROVED</verdict>",
    commits: [],
    durationMs: 1,
    silent: false,
    maxGapMs: 1,
    toolCalls: 0,
  };

  const harness = (
    run: Sandbox["run"],
    {
      sandboxGateAttachments = { env: {}, mounts: [] },
      ...overrides
    }: Partial<Parameters<typeof runInnerLoop>[1]["config"]> & {
      readonly sandboxGateAttachments?: SandboxGateAttachments;
    } = {},
  ) => {
    const events: EventInput[] = [];
    const sandbox = {
      worktreePath: "/worktree",
      run: vi.fn(run),
      syncBranchToCache: vi.fn(async () => undefined),
      preserveWorktree: vi.fn(),
      deferWorktreeReclaim: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as Sandbox;
    const stack = {
      runGate: vi.fn(async () => ({
        ok: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
        failedStep: null,
        durationMs: 1,
        steps: [],
        containerLogs: "",
      })),
      stop: vi.fn(async () => undefined),
    };
    innerLoopMocks.createSandbox.mockResolvedValue(sandbox);
    innerLoopMocks.startStack.mockResolvedValue(stack);
    const opts = {
      config: {
        layout: {
          repoDir: "/repo",
          worktreesDir: "/worktrees",
          logsDir: "/logs",
          anchorCacheDir: "/anchor-cache",
        },
        issueSource: innerLoopMocks.issueSource,
        repo: { owner: "owner", name: "repo" },
        sourceBranch: "main",
        env: {},
        implementerModelId: "implementer-model",
        reviewerModelId: "correctness-model",
        reviewerQualityModelId: "quality-model",
        uiCheckModelId: "ui-model",
        implementerAgent: "codex",
        reviewerAgent: "codex",
        reviewerQualityAgent: "codex",
        uiCheckAgent: "codex",
        adjudicatorAgent: "codex",
        adjudicatorModelId: "correctness-model",
        uiPrototypeCheck: false,
        partitionCheck: false,
        condenseAboveChars: 20_000,
        maxContextChars: 600_000,
        maxQualityRounds: 3,
        maxGateRounds: 4,
        maxReviewRounds: 4,
        botName: "sandbar-bot",
        botEmail: "bot@example.test",
        sandboxImage: "sandbox-image",
        agentImages: {},
        scope: "w12345678",
        egress: null,
        claudeMdPath: "CLAUDE.md",
        ...overrides,
      },
      stackSource: {
        path: null,
        forHead: async () => ({
          stack: { containers: [], steps: [] },
          attachments: sandboxGateAttachments,
          classification: { kind: "same" },
          tipBlob: null,
        }),
      },
      hooks: {},
      copyToWorktree: [],
      attemptLogger: {
        startInvocationCycle: createAgentInvocationSequencer().startCycle,
        writeInvocation: vi.fn(async () => undefined),
        writeGate: vi.fn(async () => undefined),
        writeIssueSnapshot: vi.fn(async () => "issue-snapshot-1.json"),
      },
      gateSemaphore: createGateSemaphore(undefined),
      dbCopies: null,
      onEvent: (event: EventInput) => events.push(event),
    } as unknown as Parameters<typeof runInnerLoop>[1];
    return { sandbox, stack, opts, events };
  };

  beforeEach(() => {
    innerLoopMocks.ensureIssueBranch.mockReset().mockResolvedValue({
      ref: "origin/main",
      sha: "base-sha",
    });
    innerLoopMocks.prepareWorktree.mockReset().mockResolvedValue("/worktree");
    innerLoopMocks.createSandbox.mockReset();
    innerLoopMocks.resolveSandboxImage.mockReset().mockResolvedValue("sandbox-image");
    innerLoopMocks.startStack.mockReset();
    innerLoopMocks.branchIsAheadOfSeed.mockReset().mockResolvedValue(false);
    innerLoopMocks.buildPrompt.mockReset().mockResolvedValue("implementer prompt");
    innerLoopMocks.buildPartitionCheckPrompt.mockReset()
      .mockResolvedValue("partition check prompt");
    innerLoopMocks.buildUiCheckPrompt.mockReset().mockResolvedValue("ui check prompt");
    innerLoopMocks.buildQualityReviewPrompt.mockReset().mockResolvedValue("quality review prompt");
    innerLoopMocks.buildQualityFixPrompt.mockReset().mockResolvedValue("quality fix prompt");
    innerLoopMocks.buildCorrectnessPrompt.mockReset().mockResolvedValue("correctness prompt");
    innerLoopMocks.settleQualityResidue.mockReset().mockResolvedValue({
      commits: [],
      residue: { dirtyPaths: [], strandedHead: null, rewoundTip: null },
    });
    innerLoopMocks.measureNetDiffChars.mockReset().mockResolvedValue(0);
    innerLoopMocks.branchTip.mockReset().mockResolvedValue("head123");
    innerLoopMocks.dirtyWorktreePaths.mockReset().mockResolvedValue([]);
    innerLoopMocks.symbolicHeadRef.mockReset().mockResolvedValue(
      `refs/heads/${issue.branch}`,
    );
    innerLoopMocks.headMismatch.mockReset().mockResolvedValue(null);
  });

  describe("behind an egress allowlist (#202)", () => {
    const calls: string[] = [];
    const proxy = (name: string, stop: () => Promise<void> = async () => undefined) => ({
      dnsArgs: ["--dns", "10.0.0.2"],
      assertAlive: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => []),
      stop: vi.fn(async () => {
        calls.push(`stop ${name}`);
        await stop();
      }),
    });
    const wire = () => {
      const sandboxProxy = proxy("proxy");
      const sandboxStart = vi.fn(async (_owner: unknown) => sandboxProxy);
      const gateOwner = { start: vi.fn() };
      innerLoopMocks.ownerEgress
        .mockReset()
        .mockReturnValueOnce({ start: sandboxStart })
        .mockReturnValueOnce(gateOwner);
      innerLoopMocks.podmanOptions.length = 0;
      return { sandboxProxy, sandboxStart, gateOwner };
    };
    const egress = { policy: { mode: "enforce" } };

    it("starts the sandbox proxy, wires its network into the sandbox and gate stack, and stops it last", async () => {
      calls.length = 0;
      const { sandboxProxy, sandboxStart, gateOwner } = wire();
      const { sandbox, stack, opts } = harness(async (options) =>
        /^(reviewer|quality-list)-/.test(options.name ?? "") ? approvedReview : completeRun,
        { egress } as never,
      );
      stack.stop.mockImplementation(async () => { calls.push("stop stack"); });
      sandbox.close = vi.fn(async () => { calls.push("close sandbox"); });

      await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "DONE" });

      const network = sandboxNetworkNameFor("w12345678", issue.id);
      expect(sandboxStart).toHaveBeenCalledExactlyOnceWith({
        owner: `sbx-${issue.id}`,
        networkName: network,
        createNetwork: true,
      });
      expect(innerLoopMocks.podmanOptions).toEqual([
        expect.objectContaining({
          network,
          dnsArgs: sandboxProxy.dnsArgs,
          env: EGRESS_AGENT_ENV,
        }),
      ]);
      expect(innerLoopMocks.startStack).toHaveBeenCalledWith(
        expect.objectContaining({ egress: gateOwner }),
      );
      expect(calls).toEqual(["stop stack", "close sandbox", "stop proxy"]);
    });

    it("stops every sandbox proxy it started when a later setup step fails", async () => {
      calls.length = 0;
      const started: ReturnType<typeof proxy>[] = [];
      innerLoopMocks.ownerEgress.mockReset().mockImplementation(() => ({
        start: vi.fn(async () => {
          const next = proxy("proxy");
          started.push(next);
          return next;
        }),
      }));
      const { opts } = harness(async () => completeRun, { egress } as never);
      innerLoopMocks.createSandbox.mockRejectedValue(new Error("sandbox bringup failed"));

      await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({
        type: "HARD-ERROR",
        reason: "sandbox bringup failed",
      });
      expect(started.length).toBeGreaterThan(0);
      for (const p of started) expect(p.stop).toHaveBeenCalledOnce();
    });
  });

  describe("with database copies (#201)", () => {
    const dbStack = resolveGateStack({
      containers: [
        {
          name: "db",
          image: "docker.io/library/mariadb:10.11",
          inSandbox: true,
          readiness: { kind: "healthcheck", command: ["healthcheck.sh", "--connect"] },
        },
        { name: "runner", image: "localhost/runner", mountWorktree: "/w", hold: true },
      ],
      steps: [{ name: "s", in: "runner", command: ["true"] }],
    });
    const dbCopies = {
      cfg: resolveDatabaseCopies({ dump: "/d", root: "/r", container: "db", database: "app" })!,
      acquire: vi.fn(),
    } satisfies DbCopies;
    const held: DbCopyStatus = {
      kind: "held", holder: "implementer", container: "db", dumpDate: "2026-10-28", hook: "ok",
    };

    // The harness with the target sibling up beside the agent, and a fake
    // slot whose answer to the implementer is `implementerCopy`. `calls`
    // interleaves the slot's aligns with the sandbox lifecycle.
    const copiesHarness = (
      run: Sandbox["run"],
      implementerCopy: DbCopyStatus = held,
    ) => {
      const calls: string[] = [];
      const built = harness(run);
      const sandbox = built.sandbox;
      sandbox.close = vi.fn(async () => { calls.push("close sandbox"); });
      innerLoopMocks.createSandbox.mockImplementation(async (options: {
        beforeSandboxReady?: (name: string) => Promise<void>;
      }) => {
        calls.push("create sandbox");
        await options.beforeSandboxReady?.("anchor");
        return sandbox;
      });
      innerLoopMocks.startSandboxStack.mockReset().mockImplementation(async () => ({
        statuses: [],
        swapDbCopyIn: vi.fn(),
        swapDbCopyOut: vi.fn(),
        stop: vi.fn(async () => { calls.push("stop siblings"); }),
      }));
      innerLoopMocks.createDbCopySlot.mockReset().mockImplementation(() => ({
        align: vi.fn(async (desired: DbCopyHolder | null) => {
          calls.push(`align ${desired}`);
          return desired === "implementer" ? implementerCopy : { kind: "none" };
        }),
      }));
      const opts = {
        ...built.opts,
        dbCopies,
        stackSource: {
          path: null,
          forHead: async () => ({
            stack: dbStack,
            attachments: { env: {}, mounts: [] },
            classification: { kind: "same" },
            tipBlob: null,
          }),
        },
      } as unknown as Parameters<typeof runInnerLoop>[1];
      return { ...built, opts, calls };
    };

    it("holds a copy for each implementer round only, and drops it before the siblings stop", async () => {
      const { sandbox, opts, calls } = copiesHarness(async (options) => {
        const name = options.name ?? "";
        if (name === "implementer-158-attempt-1") return completeRun;
        if (name === "implementer-158-attempt-2") {
          return { ...completeRun, stdout: "<promise>NEEDS-INFO</promise><questions>stop</questions>", commits: [] };
        }
        if (name.startsWith("quality-")) return approvedReview;
        if (name.startsWith("reviewer-")) {
          return { ...approvedReview, stdout: "finding\n<verdict>CHANGES-REQUESTED</verdict>" };
        }
        throw new Error(`unexpected agent invocation ${name}`);
      });

      await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "NEEDS-INFO" });
      expect(vi.mocked(sandbox.run).mock.calls.map(([options]) => options.name)).toEqual([
        "implementer-158-attempt-1",
        "quality-list-158-attempt-1",
        "reviewer-158-round-1",
        "implementer-158-attempt-2",
      ]);
      // anchor, implementer, quality list, gate, verifier, implementer; then
      // the teardown's drop.
      expect(calls).toEqual([
        "create sandbox",
        "align null",
        "align implementer",
        "align null",
        "align null",
        "align null",
        "align implementer",
        "align null",
        "stop siblings",
        "close sandbox",
      ]);
      expect(innerLoopMocks.createDbCopySlot).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        copies: dbCopies,
        target: expect.objectContaining({ name: "db", inSandbox: true }),
        hooks: [],
        issue,
      }));
      const prompts = innerLoopMocks.buildPrompt.mock.calls as unknown as [{ dbCopy?: unknown }][];
      expect(prompts.map(([inputs]) => inputs.dbCopy)).toEqual([held, held]);
    });

    it("drops the copy before a HARD-ERROR's fresh sandbox comes up", async () => {
      let cycle = 0;
      const { opts, calls } = copiesHarness(async (options) => {
        const name = options.name ?? "";
        if (name.startsWith("implementer-") && cycle++ === 0) throw new Error("podman socket refused");
        if (name.startsWith("implementer-")) {
          return { ...completeRun, stdout: "<promise>NEEDS-INFO</promise><questions>stop</questions>", commits: [] };
        }
        throw new Error(`unexpected agent invocation ${name}`);
      });

      await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "NEEDS-INFO" });
      const fresh = calls.indexOf("create sandbox", 1);
      expect(calls.slice(0, fresh + 1)).toEqual([
        "create sandbox",
        "align null",
        "align implementer",
        "align null",
        "stop siblings",
        "close sandbox",
        "create sandbox",
      ]);
    });

    it("refuses to set up copies when the sandbox stack that runs the target is not up", async () => {
      const { opts } = copiesHarness(async () => completeRun);
      innerLoopMocks.startSandboxStack.mockReset().mockResolvedValue(null);

      await expect(runInnerLoop(issue, opts)).rejects.toThrow(new SandbarError(
        "database copies: the sandbox stack that runs the target is not up",
      ));
      expect(innerLoopMocks.createDbCopySlot).not.toHaveBeenCalled();
    });

    it("hands the configured onDbCopyReady hooks to the slot", async () => {
      const { opts } = copiesHarness(
        async () => ({ ...completeRun, stdout: "<promise>NEEDS-INFO</promise><questions>stop</questions>", commits: [] }),
      );
      const onDbCopyReady = [{ name: "migrate", command: ["true"] }] as never[];
      const withHooks = {
        ...opts,
        hooks: { sandbox: { onDbCopyReady } },
      } as unknown as Parameters<typeof runInnerLoop>[1];

      await runInnerLoop(issue, withHooks);
      expect(innerLoopMocks.createDbCopySlot).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ hooks: onDbCopyReady }),
      );
      expect(vi.mocked(innerLoopMocks.createDbCopySlot).mock.calls[0]![0].hooks).toBe(onDbCopyReady);
    });

    it("still stops the siblings and closes the sandbox when dropping the copy fails", async () => {
      const { opts, calls, events } = copiesHarness(
        async () => ({ ...completeRun, stdout: "<promise>NEEDS-INFO</promise><questions>stop</questions>", commits: [] }),
      );
      innerLoopMocks.createDbCopySlot.mockReset().mockImplementation(() => ({
        align: vi.fn(async (desired: DbCopyHolder | null) => {
          if (desired !== null) return held;
          // Only the teardown's drop is the last align(null); earlier ones succeed.
          calls.push("align null");
          if (calls.filter((c) => c === "align null").length > 1) {
            throw new Error("swap out failed");
          }
          return { kind: "none" };
        }),
      }));

      await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "NEEDS-INFO" });
      expect(events).toContainEqual({
        kind: "complaint",
        severity: "error",
        message: "Failed to drop the database copy: swap out failed",
      });
      expect(calls.slice(-2)).toEqual(["stop siblings", "close sandbox"]);
    });

    it("renders no copy slot when the copy is unavailable", async () => {
      const { opts } = copiesHarness(
        async () => ({ ...completeRun, stdout: "<promise>NEEDS-INFO</promise><questions>stop</questions>", commits: [] }),
        { kind: "unavailable", reason: "no-base" },
      );

      await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "NEEDS-INFO" });
      const prompts = innerLoopMocks.buildPrompt.mock.calls as unknown as [Record<string, unknown>][];
      expect(prompts).toHaveLength(1);
      expect(prompts[0]![0]).not.toHaveProperty("dbCopy");
    });
  });

  it("keeps routine clone-reuse reports out of complaints", async () => {
    innerLoopMocks.prepareWorktree.mockImplementationOnce(async (options) => {
      await options.onNotice?.(
        "warning",
        "Reusing worktree at /worktree — worktree has uncommitted changes",
      );
      return "/worktree";
    });
    const { opts, events } = harness(async (options) =>
      /^(reviewer|quality-list)-/.test(options.name ?? "") ? approvedReview : completeRun
    );

    await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "DONE" });
    expect(events).toContainEqual({
      kind: "notice",
      message: "Reusing worktree at /worktree — worktree has uncommitted changes",
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: "complaint",
      message: expect.stringContaining("Reusing worktree"),
    }));
  });

  // #186: a stack file's env edit applies from setup, and an edit beyond env
  // parks the issue after gate-1 has run once on the tip's stack.
  it("records the stack in effect and parks a stack change beyond env", async () => {
    const { opts, events } = harness(async (options) =>
      /^(reviewer|quality-list)-/.test(options.name ?? "") ? approvedReview : completeRun
    );
    const stack = { containers: [], steps: [] };
    const differences = [{ where: "container 'db'", what: "mounts" }];
    const forHead = vi.fn()
      .mockResolvedValueOnce({
        stack: { ...stack, steps: [{ name: "env", in: "db", command: ["true"] }] },
        attachments: { env: {}, mounts: [] },
        classification: { kind: "env-only", containers: ["db"] },
        tipBlob: "blob-1",
      })
      .mockResolvedValueOnce({
        stack,
        attachments: { env: {}, mounts: [] },
        classification: { kind: "non-env", path: "gate/stack.json", differences },
        tipBlob: "blob-1",
      });
    const withFile = {
      ...opts,
      stackSource: { path: "gate/stack.json", forHead },
    } as unknown as Parameters<typeof runInnerLoop>[1];

    await expect(runInnerLoop(issue, withFile)).resolves.toMatchObject({
      type: "NEEDS-STACK-CHANGE",
      stackChange: { path: "gate/stack.json", differences },
      gate: { ok: true },
    });
    expect(forHead).toHaveBeenNthCalledWith(1, "/worktree", `refs/heads/${issue.branch}`);
    expect(forHead).toHaveBeenNthCalledWith(2, "/worktree", "head123");
    expect(events.filter((e) => e.kind === "gate-stack")).toEqual([
      {
        kind: "gate-stack", issue: Number(issue.id), title: issue.title, gate: "gate-1",
        tipBlob: "blob-1", classification: "env-only", containers: ["db"],
      },
      {
        kind: "gate-stack", issue: Number(issue.id), title: issue.title, gate: "gate-1",
        tipBlob: "blob-1", classification: "non-env",
      },
    ]);
    expect(innerLoopMocks.buildPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ stackFile: "gate/stack.json" }),
      expect.anything(),
    );
  });

  it("keeps sandbox teardown failures as full error complaints", async () => {
    const message =
      "Issue clone preserved at /worktree: failed to publish branch (packed-refs.lock)";
    const { sandbox, opts, events } = harness(async (options) =>
      /^(reviewer|quality-list)-/.test(options.name ?? "") ? approvedReview : completeRun
    );
    innerLoopMocks.createSandbox.mockImplementationOnce(async (options) => {
      sandbox.close = vi.fn(async () => {
        await options.onNotice?.("error", message);
      });
      return sandbox;
    });

    await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "DONE" });
    expect(events).toContainEqual({
      kind: "complaint",
      severity: "error",
      message,
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: "notice",
      message,
    }));
  });

  it("keeps a sandbox-image fallback as a warning complaint", async () => {
    innerLoopMocks.resolveSandboxImage.mockImplementationOnce(async (options) => {
      await options.onFallback?.("branch image did not build; using the declared image");
      return "sandbox-image";
    });
    const { opts, events } = harness(async (options) =>
      /^(reviewer|quality-list)-/.test(options.name ?? "") ? approvedReview : completeRun
    );

    await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "DONE" });
    expect(events).toContainEqual({
      kind: "complaint",
      severity: "warning",
      message: "issue=158 sandbox-image fallback — " +
        "branch image did not build; using the declared image",
    });
  });

  it.each([
    ["ui-check", { uiPrototypeCheck: true }],
    ["implementer", {}],
    ["review-quality", {}],
    ["review-correctness", {}],
  ] as const)(
    "parks a %s provider refusal after one sandbox cycle",
    async (slot, overrides) => {
      const refused = new AgentInputTooLargeError("actual_chars=1064340");
      const prefix = {
        "ui-check": "ui-check-",
        implementer: "implementer-",
        "review-quality": "quality-",
        "review-correctness": "reviewer-",
      }[slot];
      const { sandbox, opts, events } = harness(async (options) => {
        if ((options.name ?? "").startsWith(prefix)) throw refused;
        return (options.name ?? "").startsWith("quality-list-") ? approvedReview : completeRun;
      }, overrides);

      await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({
        type: "NEEDS-PARTITION",
        cause: "provider-refused",
        slot,
        detail: "actual_chars=1064340",
      });
      expect(innerLoopMocks.createSandbox).toHaveBeenCalledTimes(1);
      expect(events).not.toContainEqual(expect.objectContaining({ kind: "hard-error" }));
      expect(vi.mocked(sandbox.run).mock.calls.filter(([options]) =>
        (options.name ?? "").startsWith(prefix),
      )).toHaveLength(1);
    },
  );

  it("parks an oversized resumed branch before any agent invocation", async () => {
    innerLoopMocks.branchIsAheadOfSeed.mockResolvedValue(true);
    innerLoopMocks.buildPrompt.mockResolvedValue("0123456789");
    innerLoopMocks.measureNetDiffChars.mockResolvedValue(91);
    const { sandbox, opts } = harness(vi.fn(), {
      partitionCheck: true,
      maxContextChars: 100,
    });

    await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({
      type: "NEEDS-PARTITION",
      cause: "measured",
      slot: "implementer",
      size: 101,
      budget: 100,
    });
    expect(sandbox.run).not.toHaveBeenCalled();
    expect(innerLoopMocks.buildPartitionCheckPrompt).not.toHaveBeenCalled();
  });

  // #185/#187: each round is the quality pass → gate-1 → correctness,
  // recorded once when it closes with how its quality pass ended, and the
  // fixer's commits reach the next implementer prompt.
  it("records each closed round and hands the fixer's commits forward", async () => {
    innerLoopMocks.settleQualityResidue
      .mockResolvedValueOnce({
        commits: [{ sha: "q1" }],
        residue: { dirtyPaths: [], strandedHead: null, rewoundTip: null },
      })
      .mockResolvedValue({
        commits: [],
        residue: { dirtyPaths: [], strandedHead: null, rewoundTip: null },
      });
    const { sandbox, stack, opts, events } = harness(async (options) => {
      const name = options.name ?? "";
      if (name === "implementer-158-attempt-1" || name === "implementer-158-attempt-2") {
        return completeRun;
      }
      if (name === "implementer-158-attempt-3") {
        return {
          ...completeRun,
          stdout: "<promise>NEEDS-INFO</promise><questions>stop</questions>",
          commits: [],
        };
      }
      if (name === "quality-list-158-attempt-1") {
        return { ...approvedReview, stdout: "### Tests\nmissing\n<verdict>CHANGES-REQUESTED</verdict>" };
      }
      if (name.startsWith("quality-fix-")) return { ...completeRun, stdout: "fixed" };
      if (name.startsWith("quality-")) return approvedReview;
      if (name === "reviewer-158-round-2") {
        return { ...approvedReview, stdout: "finding\n<verdict>CHANGES-REQUESTED</verdict>" };
      }
      throw new Error(`unexpected agent invocation ${name}`);
    });
    stack.runGate.mockResolvedValueOnce({
      ok: false,
      stdout: "the quality pass's test fails",
      stderr: "",
      exitCode: 1,
      failedStep: "test",
      durationMs: 1,
      steps: [],
      containerLogs: "",
    });

    await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({
      type: "NEEDS-INFO",
      questions: "stop",
    });
    expect(vi.mocked(sandbox.run).mock.calls.map(([options]) => options.name)).toEqual([
      "implementer-158-attempt-1",
      "quality-list-158-attempt-1",
      "quality-fix-158-attempt-1-fix-1",
      "quality-verify-158-attempt-1-fix-1",
      "implementer-158-attempt-2",
      "quality-list-158-attempt-2",
      "reviewer-158-round-2",
      "implementer-158-attempt-3",
    ]);
    const rounds = events.filter((event) => event.kind === "review-round");
    expect(rounds).toEqual([
      expect.objectContaining({
        attempt: 1, round: 1, head: "head123", quality: "APPROVED", qualityRounds: 0,
        gateOk: false, correctness: "SKIPPED",
        rejectingPass: null, gateFailures: 1, correctnessFailures: 0,
      }),
      expect.objectContaining({
        attempt: 2, round: 2, head: "head123", quality: "APPROVED", qualityRounds: 0,
        gateOk: true, correctness: "CHANGES-REQUESTED",
        rejectingPass: "correctness", gateFailures: 0, correctnessFailures: 1,
      }),
    ]);
    expect(events.filter((event) => event.kind === "quality-review").map((event) =>
      event.kind === "quality-review" ? [event.attempt, event.mode, event.scope, event.verdict] : [],
    )).toEqual([
      [1, "list", "full", "CHANGES-REQUESTED"],
      [1, "verify", "since:head123", "APPROVED"],
      [2, "list", "since:head123", "APPROVED"],
    ]);
    expect(events.filter((event) => event.kind === "quality-pass")).toEqual([
      expect.objectContaining({ attempt: 1, result: "completed", commits: ["q1"] }),
    ]);
    expect(events.filter((event) => event.kind === "phase").map((event) =>
      event.kind === "phase" ? event.phases : [],
    )).toEqual([
      ["anchor"],
      ["implementer"], ["quality"], ["quality"], ["quality"], ["gate-1"],
      ["implementer"], ["quality"], ["gate-1"], ["review"],
      ["implementer"], [],
    ]);
    expect(innerLoopMocks.buildPrompt.mock.calls.map(([inputs]) => inputs.qualityCommits)).toEqual([
      [], ["q1"], [],
    ]);
  });

  // #187: running out of quality rounds is not a stop. Gate-1 runs, and the
  // open items are the last verify's record — never the implementer's input.
  it("goes on to gate-1 with the open items recorded when the quality budget runs out", async () => {
    innerLoopMocks.settleQualityResidue.mockResolvedValue({
      commits: [{ sha: "q1" }],
      residue: { dirtyPaths: [], strandedHead: null, rewoundTip: null },
    });
    const open = "### Standards\nsrc/a.ts:1 still duplicated\n<verdict>CHANGES-REQUESTED</verdict>";
    const { sandbox, opts, events } = harness(async (options) => {
      const name = options.name ?? "";
      if (name.startsWith("implementer-")) return completeRun;
      if (name.startsWith("quality-list-") || name.startsWith("quality-verify-")) {
        return { ...approvedReview, stdout: open };
      }
      if (name.startsWith("quality-fix-")) return { ...completeRun, stdout: "fixed" };
      return approvedReview;
    }, { maxQualityRounds: 1 });

    await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "DONE" });
    expect(vi.mocked(sandbox.run).mock.calls.map(([options]) => options.name)).toEqual([
      "implementer-158-attempt-1",
      "quality-list-158-attempt-1",
      "quality-fix-158-attempt-1-fix-1",
      "quality-verify-158-attempt-1-fix-1",
      "reviewer-158-round-1",
    ]);
    expect(events.filter((event) => event.kind === "quality-review").at(-1)).toMatchObject({
      mode: "verify", verdict: "CHANGES-REQUESTED", prose: open,
    });
    expect(events.filter((event) => event.kind === "review-round")).toEqual([
      expect.objectContaining({ quality: "CHANGES-REQUESTED", qualityRounds: 1, correctness: "APPROVED" }),
    ]);
  });

  // #187: a fixer that commits nothing disputes the report; an overrule ends
  // the pass approved and is the history a later lister is shown.
  it("adjudicates a refused quality report and shows the overrule to the next lister", async () => {
    const report = "### Tests\nnothing to add\n<verdict>CHANGES-REQUESTED</verdict>";
    let listings = 0;
    const { sandbox, stack, opts, events } = harness(async (options) => {
      const name = options.name ?? "";
      if (name === "implementer-158-attempt-3") {
        return { ...completeRun, stdout: "<promise>NEEDS-INFO</promise><questions>q</questions>", commits: [] };
      }
      if (name.startsWith("implementer-")) return completeRun;
      if (name.startsWith("quality-list-")) {
        listings += 1;
        return listings === 1 ? { ...approvedReview, stdout: report } : approvedReview;
      }
      if (name.startsWith("quality-fix-")) return { ...completeRun, stdout: "nothing", commits: [] };
      if (name.startsWith("quality-adjudicator-")) {
        return { ...approvedReview, stdout: "the test exists\n<ruling>OVERRULED</ruling>" };
      }
      if (name.startsWith("reviewer-")) {
        return { ...approvedReview, stdout: "bug\n<verdict>CHANGES-REQUESTED</verdict>" };
      }
      throw new Error(`unexpected agent invocation ${name}`);
    });
    stack.runGate.mockResolvedValueOnce({
      ok: false, stdout: "red", stderr: "", exitCode: 1, failedStep: "test",
      durationMs: 1, steps: [], containerLogs: "",
    });

    await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "NEEDS-INFO" });
    expect(vi.mocked(sandbox.run).mock.calls.map(([options]) => options.name)).toEqual([
      "implementer-158-attempt-1",
      "quality-list-158-attempt-1",
      "quality-fix-158-attempt-1-fix-1",
      "quality-adjudicator-158-round-1-fix-1",
      "implementer-158-attempt-2",
      "quality-list-158-attempt-2",
      "reviewer-158-round-2",
      "implementer-158-attempt-3",
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "adjudication", pass: "quality", round: 1, head: "head123", ruling: "OVERRULED",
    }));
    expect(innerLoopMocks.buildAdjudicatorPrompt).toHaveBeenCalledWith(expect.objectContaining({
      pass: "quality", head: "head123", report,
    }));
    expect(innerLoopMocks.buildQualityReviewPrompt.mock.calls.map(([inputs]) => inputs.mode)).toEqual([
      { kind: "list", scope: { kind: "full" }, overrules: [] },
      {
        kind: "list",
        scope: { kind: "since", sha: "head123" },
        overrules: [{ round: 1, head: "head123", report, ruling: "the test exists" }],
      },
    ]);
    expect(events.filter((event) => event.kind === "review-round")[0]).toMatchObject({
      quality: "OVERRULED", qualityRounds: 0, gateOk: false,
    });
  });

  // #187: the lister is held read-only like every other reviewer.
  it("parks when the quality lister writes", async () => {
    const { opts } = harness(async (options) => {
      if ((options.name ?? "").startsWith("quality-list-")) {
        innerLoopMocks.branchTip.mockResolvedValue("moved");
        return approvedReview;
      }
      return completeRun;
    });

    await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({
      type: "NEEDS-HUMAN-REVIEW",
      cause: "quality-reviewer-wrote",
      latestReviewerProse: expect.stringContaining("Quality reviewer changed git state"),
    });
  });

  it("admits a resumed branch at budget and skips the partition classifier", async () => {
    innerLoopMocks.branchIsAheadOfSeed.mockResolvedValue(true);
    innerLoopMocks.buildPrompt.mockResolvedValue("0123456789");
    innerLoopMocks.measureNetDiffChars.mockResolvedValue(90);
    const { sandbox, opts } = harness(async () => ({
      ...completeRun,
      stdout: "<promise>NEEDS-INFO</promise><questions>Which API?</questions>",
      commits: [],
    }), {
      partitionCheck: true,
      maxContextChars: 100,
    });

    await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({
      type: "NEEDS-INFO",
      questions: "Which API?",
    });
    expect(sandbox.run).toHaveBeenCalledTimes(1);
    expect(innerLoopMocks.buildPartitionCheckPrompt).not.toHaveBeenCalled();
  });

  it("attaches gate-runner env and mounts to the implementer sandbox", async () => {
    const { opts } = harness(async () => ({
      ...completeRun,
      stdout: "<promise>NEEDS-INFO</promise><questions>done</questions>",
      commits: [],
    }), {
      sandboxGateAttachments: {
        env: {
          CONTAINER_HOST: "unix:///run/podman.sock",
          SANDBAR_REQUIRE_PODMAN_TESTS: "1",
        },
        mounts: [
          { hostPath: "fixtures", containerPath: "/fixtures", mode: "ro" },
          { hostPath: "/tmp", containerPath: "/tmp", mode: "rw" },
        ],
      },
    });

    await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({
      type: "NEEDS-INFO",
    });
    expect(innerLoopMocks.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        literalEnv: {
          CONTAINER_HOST: "unix:///run/podman.sock",
          SANDBAR_REQUIRE_PODMAN_TESTS: "1",
        },
        extraMounts: [
          {
            hostPath: "/worktree/fixtures",
            sandboxPath: "/fixtures",
            readonly: true,
          },
          { hostPath: "/tmp", sandboxPath: "/tmp", readonly: false },
        ],
      }),
    );
    expect(innerLoopMocks.buildPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxHasGateAttachments: true }),
      expect.anything(),
    );
  });

  it.each(["completed", "failed"] as const)(
    "parks when a %s partition check mutates the repository",
    async (outcome) => {
      innerLoopMocks.branchTip
        .mockResolvedValueOnce("base-sha")
        .mockResolvedValueOnce("mutated-sha");
      const failure = withPartialOutput(new Error("provider disconnected"), "partial");
      const { sandbox, opts } = harness(async () => {
        if (outcome === "failed") throw failure;
        return {
          ...approvedReview,
          stdout: "<partition-check>CLEAR</partition-check>",
        };
      }, { partitionCheck: true });

      await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({
        type: "NEEDS-HUMAN-REVIEW",
        cause: "partition-checker-wrote",
      });
      expect(sandbox.run).toHaveBeenCalledTimes(1);
      expect(sandbox.preserveWorktree).toHaveBeenCalledWith(
        expect.stringContaining("partition checker changed the repository"),
      );
      expect(sandbox.syncBranchToCache).toHaveBeenCalledTimes(1);
      expect(innerLoopMocks.buildPrompt).not.toHaveBeenCalled();
    },
  );

  it("classifies a driver-owned tools image failure as HARD-ERROR", async () => {
    const { opts, events } = harness(vi.fn());
    innerLoopMocks.resolveSandboxImage.mockRejectedValue(
      new AgentToolsImageError("tools image storage is full"),
    );

    await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({
      type: "HARD-ERROR",
      reason: "tools image storage is full",
    });
    expect(innerLoopMocks.resolveSandboxImage).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.kind === "hard-error")).toHaveLength(2);
  });

  // #188: a fresh sandbox cycle credits the work its branch already carries.
  // Real git for the branch seed, the clone and the commit evidence; the
  // agent is fake and says COMPLETE with nothing new to add.
  // #203: a fake task stands for scenario-writer-run.ts.
  describe("the scenario writer (#203)", () => {
    const fakeWriter = (outcome: Promise<ScenarioWriterOutcome>) => {
      let status: ScenarioWriterStatus = { kind: "pending" };
      return {
        status: vi.fn(() => status),
        start: vi.fn(() => {
          status = { kind: "running" };
        }),
        settled: vi.fn(() => outcome),
        abort: vi.fn(async () => undefined),
      };
    };
    const names = (sandbox: Sandbox) =>
      vi.mocked(sandbox.run).mock.calls.map(([options]) => options.name ?? "");
    const routine = async (options: Parameters<Sandbox["run"]>[0]) =>
      /^(reviewer|quality-list)-/.test(options.name ?? "") ? approvedReview : completeRun;

    beforeEach(() => {
      innerLoopMocks.createScenarioWriterTask.mockReset();
      innerLoopMocks.forkPoint.mockReset().mockResolvedValue("fork-sha");
    });

    it("dispatches attempt 1 without waiting for it, and joins it before the verifier", async () => {
      const outcome = deferred<ScenarioWriterOutcome>();
      const writer = fakeWriter(outcome.promise);
      innerLoopMocks.createScenarioWriterTask.mockReturnValue(writer);
      const { sandbox, opts, events } = harness(routine, { scenarioWriter: true });

      const done = runInnerLoop(issue, opts);
      await vi.waitFor(() => expect(writer.settled).toHaveBeenCalled());
      expect(names(sandbox)).toEqual(["implementer-158-attempt-1", "quality-list-158-attempt-1"]);
      expect(writer.start).toHaveBeenCalledWith({
        imageName: "sandbox-image",
        seedRef: "origin/main",
        seedSha: "fork-sha",
      });
      expect(innerLoopMocks.forkPoint).toHaveBeenCalledWith("/repo", "origin/main", issue.branch);
      outcome.resolve({ kind: "none", reason: "docs" });

      await expect(done).resolves.toMatchObject({ type: "DONE" });
      expect(names(sandbox).at(-1)).toBe("reviewer-158-round-1");
      expect(innerLoopMocks.createScenarioWriterTask).toHaveBeenCalledWith(expect.objectContaining({
        issue,
        config: opts.config,
      }));
      // The start has no phase of its own; the join does.
      expect(events.flatMap((event) => event.kind === "phase" ? [event.phases] : [])).toEqual([
        ["anchor"], ["implementer"], ["quality"], ["gate-1"], ["scenarios"], ["review"], [],
      ]);
    });

    it("is not started again by a fresh HARD-ERROR cycle", async () => {
      const writer = fakeWriter(Promise.resolve({ kind: "none", reason: "docs" }));
      innerLoopMocks.createScenarioWriterTask.mockReturnValue(writer);
      let attempts = 0;
      const { opts, events } = harness(async (options) => {
        if ((options.name ?? "").startsWith("implementer-") && (attempts += 1) === 1) {
          throw new Error("podman exec died");
        }
        return routine(options);
      }, { scenarioWriter: true });

      await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "DONE" });
      expect(events).toContainEqual(expect.objectContaining({ kind: "hard-error", retry: 1 }));
      expect(innerLoopMocks.createScenarioWriterTask).toHaveBeenCalledTimes(1);
      expect(writer.start).toHaveBeenCalledTimes(1);
      expect(writer.settled).toHaveBeenCalledTimes(1);
    });

    it("is aborted when the admission ends before the join", async () => {
      const writer = fakeWriter(new Promise(() => undefined));
      innerLoopMocks.createScenarioWriterTask.mockReturnValue(writer);
      const { opts } = harness(async () => ({
        ...completeRun,
        stdout: "<promise>NEEDS-INFO</promise><questions>Which API?</questions>",
        commits: [],
      }), { scenarioWriter: true });

      await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "NEEDS-INFO" });
      expect(writer.start).toHaveBeenCalledTimes(1);
      expect(writer.settled).not.toHaveBeenCalled();
      expect(writer.abort).toHaveBeenCalledTimes(1);
    });

    it("reports a writer that fails while aborting, and keeps the terminal", async () => {
      const writer = fakeWriter(new Promise(() => undefined));
      writer.abort.mockRejectedValue(new Error("EEXIST"));
      innerLoopMocks.createScenarioWriterTask.mockReturnValue(writer);
      const { opts, events } = harness(async () => ({
        ...completeRun,
        stdout: "<promise>NEEDS-INFO</promise><questions>Which API?</questions>",
        commits: [],
      }), { scenarioWriter: true });

      await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "NEEDS-INFO" });
      expect(events).toContainEqual({
        kind: "complaint",
        severity: "error",
        message: "issue=158 scenario writer failed: EEXIST",
      });
    });

    it("parks a writer that wrote, at the join", async () => {
      innerLoopMocks.createScenarioWriterTask.mockReturnValue(
        fakeWriter(Promise.resolve({ kind: "wrote", detail: "HEAD moved" })),
      );
      const { sandbox, opts } = harness(routine, { scenarioWriter: true });

      await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({
        type: "NEEDS-HUMAN-REVIEW",
        cause: "scenario-writer-wrote",
        latestReviewerProse: "HEAD moved",
      });
      expect(names(sandbox)).not.toContain("reviewer-158-round-1");
    });

    it("creates no task when it is off", async () => {
      const { opts } = harness(routine, { scenarioWriter: false });
      await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "DONE" });
      expect(innerLoopMocks.createScenarioWriterTask).not.toHaveBeenCalled();
    });
  });

  describe("a branch already ahead of its seed (#188)", () => {
    const exec = promisify(execFile);
    const git = (cwd: string, ...args: string[]) =>
      exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
    const commitIn = async (cwd: string, message: string): Promise<string> => {
      await git(cwd, "commit", "-q", "--allow-empty", "-m", message);
      return (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
    };
    let root: string;
    let origin: string;
    let cache: string;
    let worktree: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "sandbar-188-"));
      origin = join(root, "origin.git");
      cache = join(root, "cache.git");
      worktree = join(root, "worktree");
      const work = join(root, "work");
      await git(root, "init", "-q", "--bare", "-b", "main", origin);
      await git(root, "clone", "-q", origin, work);
      await commitIn(work, "init");
      await git(work, "push", "-q", "origin", "HEAD:main");
      await git(root, "init", "-q", "--bare", cache);
      await git(cache, "remote", "add", "origin", origin);
      await git(cache, "fetch", "-q", "origin");
      const gitOps = await vi.importActual<typeof import("./git-ops.js")>("./git-ops.js");
      const prompt = await vi.importActual<typeof import("./prompt.js")>("./prompt.js");
      innerLoopMocks.ensureIssueBranch.mockImplementation(gitOps.ensureIssueBranch as never);
      innerLoopMocks.revParse.mockImplementation(gitOps.revParse);
      innerLoopMocks.branchCommitsSinceSeed.mockImplementation(gitOps.branchCommitsSinceSeed);
      innerLoopMocks.branchIsAheadOfSeed.mockImplementation(prompt.branchIsAheadOfSeed);
      // The clone the sandbox works in, reused by a later cycle as it is.
      innerLoopMocks.prepareWorktree.mockImplementation(async (options) => {
        const { stdout } = await git(cache, "worktree", "list", "--porcelain");
        if (!stdout.includes(worktree)) {
          await git(cache, "worktree", "add", "-q", worktree, options.branch);
        }
        return worktree;
      });
      return async () => {
        innerLoopMocks.branchCommitsSinceSeed.mockReset().mockResolvedValue([]);
        innerLoopMocks.revParse.mockReset().mockResolvedValue("seed-sha");
        await rm(root, { recursive: true, force: true });
      };
    });

    const layout = () => ({
      layout: { repoDir: cache, worktreesDir: root, logsDir: join(root, "logs") },
    });
    const zeroCommitComplete = { ...completeRun, commits: [] };

    it("takes a HARD-ERROR retry's COMPLETE to the quality pass on the killed cycle's commits", async () => {
      let cycle = 0;
      const { sandbox, stack, opts, events } = harness(async (options) => {
        const name = options.name ?? "";
        if (/^(reviewer|quality-list)-/.test(name)) return approvedReview;
        if (name.startsWith("implementer-") && cycle === 0) {
          cycle += 1;
          // Commits, says COMPLETE, then never exits.
          const shas = [
            await commitIn(worktree, "one"),
            await commitIn(worktree, "two"),
          ];
          throw withPartialCommits(
            new AgentError("claude emitted completion signal, then produced no output for 60000ms without exiting."),
            shas.map((sha) => ({ sha })),
          );
        }
        return zeroCommitComplete;
      }, layout());

      await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "DONE" });
      expect(events.filter((event) => event.kind === "hard-error")).toHaveLength(1);
      expect(events.filter((event) => event.kind === "implementer")).toEqual([
        expect.objectContaining({ attempt: 1, signal: "FAILED", commits: 2 }),
        expect.objectContaining({ attempt: 1, signal: "COMPLETE", commits: 0 }),
      ]);
      expect(vi.mocked(sandbox.run).mock.calls.map(([options]) => options.name)).toEqual([
        "implementer-158-attempt-1",
        "implementer-158-attempt-1",
        expect.stringMatching(/^quality-list-/),
        expect.stringMatching(/^reviewer-/),
      ]);
      expect(stack.runGate).toHaveBeenCalledTimes(1);
    });

    it("takes a re-queued branch resumed from origin straight to the quality pass", async () => {
      const work = join(root, "work");
      await git(work, "checkout", "-q", "-b", issue.branch);
      await commitIn(work, "earlier admission");
      await git(work, "push", "-q", "origin", issue.branch);
      const { sandbox, stack, opts, events } = harness(async (options) =>
        /^(reviewer|quality-list)-/.test(options.name ?? "") ? approvedReview : zeroCommitComplete,
      layout());

      await expect(runInnerLoop(issue, opts)).resolves.toMatchObject({ type: "DONE" });
      // The seed's commit, not the branch's: the branch carries a later one.
      expect(events.filter((event) => event.kind === "admitted")).toEqual([
        expect.objectContaining({
          seedRef: "origin/main",
          seedSha: (await git(origin, "rev-parse", "main")).stdout.trim(),
        }),
      ]);
      expect(events).toContainEqual(expect.objectContaining({
        kind: "origin-sync",
        outcome: "resumed-from-origin",
      }));
      expect(events).not.toContainEqual(expect.objectContaining({
        kind: "repair",
        action: "re-prompt",
      }));
      expect(vi.mocked(sandbox.run).mock.calls.map(([options]) => options.name)).toEqual([
        "implementer-158-attempt-1",
        expect.stringMatching(/^quality-list-/),
        expect.stringMatching(/^reviewer-/),
      ]);
      expect(stack.runGate).toHaveBeenCalledTimes(1);
    });
  });
});

describe("runInnerLoop HARD-ERROR logging (#115)", () => {
  it("runs the partition classifier once per admission across fresh-sandbox retries", async () => {
    const enabled: boolean[] = [];
    const runCycle = vi.fn(async (_issue, opts) => {
      enabled.push(opts.config.partitionCheck);
      if (enabled.length === 1) {
        await opts.onEvent({
          kind: "partition-check",
          issue: 158,
          title: "partition once",
          invocation: 1,
          provider: "codex",
          model: "model",
          effort: null,
          durationMs: 1,
          result: "CLEAR",
        });
        return {
          verdict: { type: "HARD-ERROR" as const, reason: "socket refused" },
          accumulatedCommits: [],
          specGaps: [],
        };
      }
      return {
        verdict: { type: "DONE" as const, commits: [] },
        accumulatedCommits: [],
        specGaps: [],
      };
    });
    await expect(runInnerLoop(
      { id: "158", title: "partition once", branch: "sandbar/issue-158" },
      {
        config: { partitionCheck: true },
        attemptLogger: {
          startInvocationCycle: () => createAgentInvocationSequencer().startCycle(),
        },
        onEvent: () => undefined,
      } as unknown as Parameters<typeof runInnerLoop>[1],
      runCycle,
    )).resolves.toMatchObject({ type: "DONE" });
    expect(enabled).toEqual([true, false]);
  });

  it("files the issue snapshot on the first admission only (#195)", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbar-issue-snapshot-"));
    try {
      const issueLogger = await (await createTranscriptTree(root)).issue("195");
      const issueJson = { title: "Replay", body: "as admitted", comments: [] };
      innerLoopMocks.issueSource.mockReset().mockResolvedValue(issueJson);
      const outcomes = [
        { verdict: { type: "HARD-ERROR" as const, reason: "socket refused" }, accumulatedCommits: [], specGaps: [] },
        { verdict: { type: "DONE" as const, commits: [] }, accumulatedCommits: [], specGaps: [] },
      ];
      const runCycle = vi.fn(async (_issue, opts) => {
        await opts.onEvent({
          kind: "admitted",
          issue: 195,
          title: "Replay",
          branch: "sandbar/issue-195-replay",
          chunk: null,
          seedRef: "origin/main",
          seedSha: "seed-sha",
        });
        return outcomes.shift()!;
      });
      const events: EventInput[] = [];

      await expect(runInnerLoop(
        { id: "195", title: "Replay", branch: "sandbar/issue-195-replay" },
        {
          config: { partitionCheck: false, issueSource: innerLoopMocks.issueSource },
          attemptLogger: issueLogger,
          onEvent: (event) => events.push(event),
        } as unknown as Parameters<typeof runInnerLoop>[1],
        runCycle,
      )).resolves.toMatchObject({ type: "DONE" });

      expect(runCycle).toHaveBeenCalledTimes(2);
      expect(innerLoopMocks.issueSource).toHaveBeenCalledExactlyOnceWith("195");
      expect(events.filter((event) => event.kind === "admitted")).toEqual([
        expect.objectContaining({ seedSha: "seed-sha", issueSnapshot: "issue-snapshot-1.json" }),
      ]);
      expect(await readdir(issueLogger.dir)).toEqual(["issue-snapshot-1.json"]);
      expect(JSON.parse(await readFile(join(issueLogger.dir, "issue-snapshot-1.json"), "utf8")))
        .toEqual(issueJson);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps every invocation record across retries and later admissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbar-invocation-cycles-"));
    try {
      const transcriptTree = await createTranscriptTree(root);
      const issueLogger = await transcriptTree.issue("135");
      let cycle = 0;
      const runCycle = vi.fn(async (
        _issue,
        opts,
        sequence,
      ) => {
        cycle += 1;
        const record = {
          agent: `cycle-${cycle}`,
          provider: "codex",
          model: "model",
          end: "exit" as const,
          detail: null,
          exitCode: cycle < 3 ? 1 : 0,
          durationMs: 1,
          speech: `speech-${cycle}`,
          stdout: `stdout-${cycle}`,
          stderr: `stderr-${cycle}`,
          controlLines: [],
          commands: [],
        };
        await opts.attemptLogger.writeInvocation(
          sequence.filename({ role: "ui-check", invocation: 1 }),
          record,
        );
        await opts.attemptLogger.writeInvocation(
          sequence.filename({ role: "implementer", attempt: 1, nudge: false }),
          record,
        );
        await opts.attemptLogger.writeInvocation(
          sequence.filename({ role: "implementer", attempt: 1, nudge: true }),
          record,
        );
        await opts.attemptLogger.writeInvocation(
          sequence.filename({ role: "quality-list", attempt: 1, invocation: 1 }),
          record,
        );
        // The gate artefact comes from the same sequence as the invocations
        // around it: every cycle calls it attempt 1, and only the sequence
        // knows this is the fourth. `writeGate` is `wx`, so a gate log that
        // stopped following it would not merely mislabel itself — it would
        // throw EEXIST out of `runGate` and turn a readmission into a
        // HARD-ERROR (#153).
        await opts.attemptLogger.writeGate(
          sequence.filename({ role: "gate", attempt: 1 }),
          {
            ok: cycle >= 3,
            stdout: `gate-stdout-${cycle}`,
            stderr: "",
            failedStep: cycle < 3 ? "test" : null,
            exitCode: cycle < 3 ? 1 : 0,
            containerLogs: "",
          },
        );
        return cycle < 3
          ? {
              verdict: { type: "HARD-ERROR" as const, reason: `failed-${cycle}` },
              accumulatedCommits: [],
              specGaps: [],
            }
          : {
              verdict: { type: "DONE" as const, commits: [] },
              accumulatedCommits: [],
              specGaps: [],
            };
      });

      await expect(runInnerLoop(
        { id: "135", title: "records", branch: "sandbar/issue-135-records" },
        {
          config: { partitionCheck: false },
          attemptLogger: issueLogger,
          onEvent: () => undefined,
        } as unknown as Parameters<
          typeof runInnerLoop
        >[1],
        runCycle,
      )).resolves.toMatchObject({ type: "DONE" });
      const readmittedLogger = await transcriptTree.issue("135");
      expect(readmittedLogger).toBe(issueLogger);
      await expect(runInnerLoop(
        { id: "135", title: "records", branch: "sandbar/issue-135-records" },
        {
          config: { partitionCheck: false },
          attemptLogger: readmittedLogger,
          onEvent: () => undefined,
        } as unknown as Parameters<
          typeof runInnerLoop
        >[1],
        runCycle,
      )).resolves.toMatchObject({ type: "DONE" });
      expect((await readdir(issueLogger.dir)).sort()).toEqual([
        "attempt-1-gate.log",
        "attempt-1-nudge.log",
        "attempt-1-quality-list-1.log",
        "attempt-1.log",
        "attempt-2-gate.log",
        "attempt-2-nudge.log",
        "attempt-2-quality-list-1.log",
        "attempt-2.log",
        "attempt-3-gate.log",
        "attempt-3-nudge.log",
        "attempt-3-quality-list-1.log",
        "attempt-3.log",
        "attempt-4-gate.log",
        "attempt-4-nudge.log",
        "attempt-4-quality-list-1.log",
        "attempt-4.log",
        "ui-check-1.log",
        "ui-check-2.log",
        "ui-check-3.log",
        "ui-check-4.log",
      ]);
      await expect(readFile(join(issueLogger.dir, "attempt-1.log"), "utf8"))
        .resolves.toContain("speech-1");
      await expect(readFile(join(issueLogger.dir, "attempt-3.log"), "utf8"))
        .resolves.toContain("speech-3");
      await expect(readFile(join(issueLogger.dir, "attempt-3-gate.log"), "utf8"))
        .resolves.toContain("gate-stdout-3");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
    const events: EventInput[] = [];

    await expect(
        runInnerLoop(
          { id: "115", title: "logging", branch: "sandbar/issue-115-logging" },
          {
            config: { partitionCheck: false },
            attemptLogger: {
              writeInvocation: vi.fn(),
              startInvocationCycle: createAgentInvocationSequencer().startCycle,
            },
            onEvent: (event) => events.push(event),
          } as unknown as Parameters<typeof runInnerLoop>[1],
          runCycle,
        ),
      ).resolves.toEqual({ type: "DONE", commits: [], specGaps: [] });
      expect(events).toEqual([
        expect.objectContaining({ kind: "hard-error", issue: 115, retry: 1, reason: "bringup failed\nstack" }),
        expect.objectContaining({ kind: "hard-error", issue: 115, retry: 2, reason: "socket refused" }),
      ]);
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
        {
          config: { partitionCheck: false },
          attemptLogger: {
            writeInvocation: vi.fn(),
            startInvocationCycle: createAgentInvocationSequencer().startCycle,
          },
          onEvent: () => undefined,
        } as unknown as Parameters<typeof runInnerLoop>[1],
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

    const detail = await enforceReadOnlyAgentSnapshot(
      sandbox,
      snapshot(),
      snapshot({ tip: null }),
      "Reviewer",
      "partial reviewer output",
    );
    expect(detail).toContain("Reviewer changed git state");
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
    const events: EventInput[] = [];

    try {
      await expect(
        runSandboxAndPublish(sandbox, {} as Parameters<Sandbox["run"]>[0], "98", (event) => events.push(event)),
      ).rejects.toBe(agentError);
      expect(sandbox.syncBranchToCache).toHaveBeenCalledOnce();
      expect(events).toEqual([expect.objectContaining({
        kind: "complaint", message: expect.stringContaining("continuing with original error"),
      })]);
    } finally {}
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
