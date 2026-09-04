import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  sandboxRun: vi.fn(),
  createSandbox: vi.fn(),
}));

vi.mock("./git-ops.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./git-ops.js")>(),
  dirtyWorktreePaths: vi.fn(async () => []),
  headMismatch: vi.fn(async () => null),
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
  };
});

vi.mock("./gate-stack.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./gate-stack.js")>(),
  startStack: vi.fn(async () => ({
    runGate: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock("./sandbox-stack.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sandbox-stack.js")>(),
  prepareSandboxLogDir: vi.fn(async () => "/tmp/issue-109-logs"),
  sandboxContainers: vi.fn(() => []),
  startSandboxStack: vi.fn(async () => ({ statuses: [], stop: vi.fn() })),
}));

vi.mock("./ensure-images.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ensure-images.js")>(),
  resolveSandboxImage: vi.fn(async () => "test-agent-image"),
}));

vi.mock("./prompt.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./prompt.js")>(),
  buildPrompt: vi.fn(async () => "implement"),
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

const config = (implementerAgent: "claude" | "codex"): InnerLoopConfig => ({
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
  reviewerModelId: "model",
  reviewerQualityModelId: "model",
  implementerAgent,
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
    seams.createSandbox.mockReset().mockImplementation(async () => ({
      run: seams.sandboxRun,
      syncBranchToCache: vi.fn(async () => undefined),
      close: vi.fn(),
      containerName: "sandbox",
    }));
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
    });
    expect(seams.createSandbox).toHaveBeenCalledOnce();
    expect(seams.sandboxRun).toHaveBeenCalledOnce();

    await expect(runInnerLoop(issue("110"), {
      config: config("claude"), hooks: {}, copyToWorktree: [], quotaState: state,
    })).resolves.toEqual({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
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
});
