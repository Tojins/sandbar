import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestSummary } from "./chunk-land.js";
import type { WakeLockStatus } from "./keepawake.js";

const seams = vi.hoisted(() => ({
  innerLoop: vi.fn(),
  merger: vi.fn(),
  plan: vi.fn(),
  finalize: vi.fn(async () => []),
  issueLabels: vi.fn(async () => [] as string[]),
  mergerStackStop: vi.fn(async () => undefined),
  mergerWorktreeRemove: vi.fn(async () => undefined),
  landRequestPullRequests: vi.fn(async () => [] as PullRequestSummary[]),
  emit: vi.fn(),
  events: [] as Array<Record<string, unknown>>,
  wakeStatusReports: [] as Array<{
    line: string;
    status: WakeLockStatus;
  }>,
  cleanupCallbacks: [] as Array<() => unknown>,
  wakeLocks: [] as Array<{
    stop: ReturnType<typeof vi.fn>;
    onStatus: ReturnType<typeof vi.fn>;
  }>,
  prepareCodexAuth: vi.fn(async () => ({
    action: "seeded" as const,
    mount: {
      hostPath: "/tmp/sandbar-run-quota-test/codex-auth.json",
      sandboxPath: "/home/agent/.codex/auth.json",
    },
  })),
}));

vi.mock("./codex-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./codex-auth.js")>(),
  prepareCodexAuth: seams.prepareCodexAuth,
}));

vi.mock("./driver-identity.js", () => ({
  readDriverIdentity: vi.fn(async () => ({ kind: "unknown" })),
  formatDriverIdentity: vi.fn(() => "driver: test"),
}));
vi.mock("./cleanup.js", () => ({
  installCleanupTraps: vi.fn(),
  onCleanup: vi.fn((callback: () => unknown) => {
    seams.cleanupCallbacks.push(callback);
  }),
  setCleanupReporter: vi.fn(() => vi.fn()),
  runCleanup: vi.fn(async () => {
    while (seams.cleanupCallbacks.length > 0) {
      await seams.cleanupCallbacks.pop()?.();
    }
  }),
}));
vi.mock("./keepawake.js", () => ({
  startKeepawake: vi.fn(() => {
    const lock = {
      stop: vi.fn(),
      onStatus: vi.fn((sink: (line: string, status: WakeLockStatus) => void) => {
      for (const report of seams.wakeStatusReports) sink(report.line, report.status);
      }),
      status: vi.fn(() => null),
    };
    seams.wakeLocks.push(lock);
    return lock;
  }),
}));
vi.mock("./lock.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lock.js")>(),
  lockPathsFor: vi.fn(() => ({ workDir: "/tmp", lockDir: "/tmp/lock", pidPath: "/tmp/pid" })),
  acquireLock: vi.fn(async () => vi.fn()),
}));
vi.mock("./events.js", () => ({
  startEventRecord: vi.fn(async () => ({
    runDir: "/tmp/run-quota-test",
    finalize: vi.fn(),
    emit: seams.emit,
    issue: vi.fn(async (id: string) => ({
      dir: `/tmp/run-quota-test/issue-${id}`,
      writeAttempt: vi.fn(), writeAttemptReviewer: vi.fn(),
    })),
    landing: vi.fn(() => ({
      dir: "/tmp/run-quota-test/landing-1", appendMerger: vi.fn(),
      writeMergerGate: vi.fn(), writeResolveAttempt: vi.fn(),
    })),
  })),
}));
vi.mock("./ui-server.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ui-server.js")>(),
  startUiServer: vi.fn(async () => ({ url: "http://127.0.0.1:7331/", close: vi.fn() })),
}));
vi.mock("./repo-cache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./repo-cache.js")>(),
  ensureRepoCache: vi.fn(), ensureSourceWorktree: vi.fn(async () => "/tmp/source"),
}));
vi.mock("./preflight.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./preflight.js")>(),
  runPreflight: vi.fn(async () => ({
    configPath: null, sourceBranch: "main", hostCwd: "/repo",
    behind: 0, touchingConfig: 0,
  })), absoluteMountSources: vi.fn(() => []),
  fetchOriginRefs: vi.fn(async () => ({ sourceChanged: false, failures: [] })),
  readConfigStaleness: vi.fn(async () => ({
    configPath: null, sourceBranch: "main", hostCwd: "/repo",
    behind: 0, touchingConfig: 0,
  })),
}));
vi.mock("./containers.js", () => ({
  cleanupOrphanContainers: vi.fn(async () => ({ removed: [], failures: [] })),
  findUnattributableResources: vi.fn(async () => ({ names: [], removalCommands: [] })),
}));
vi.mock("./ensure-images.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ensure-images.js")>(),
  ensureImages: vi.fn(async () => new Map()),
  createBranchImages: vi.fn(() => ({ resolve: vi.fn(async () => new Map()), builtTags: () => [] })),
  checkWorktreeImageUids: vi.fn(), sweepBranchImages: vi.fn(async () => ({ removed: [], failures: [] })),
  removeBranchImages: vi.fn(async () => []), pulledImagesOf: vi.fn(() => []),
  worktreeMountingTagsOf: vi.fn(() => new Set()), formatImageRecord: vi.fn(() => "image"),
}));
vi.mock("./agent-tools.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./agent-tools.js")>(),
  createAgentImages: vi.fn(async () => ({
    declaredTag: "image", augment: vi.fn(async () => "image"), builtTags: () => [],
  })),
}));
vi.mock("./plan-resolver.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./plan-resolver.js")>(), buildPlan: seams.plan,
  readIssueBranchRefs: vi.fn(async () => []),
}));
vi.mock("./chunk-follow-up.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./chunk-follow-up.js")>(),
  realAdapter: vi.fn(() => ({})), routeChunkReviewFollowUps: vi.fn(async () => []),
}));
vi.mock("./chunk-reconcile.js", () => ({
  fetchLandRequestPullRequests: seams.landRequestPullRequests,
  reconcileLandedChunks: vi.fn(async () => ({ reconciled: [], failures: [] })),
}));
vi.mock("./lanes.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lanes.js")>(),
  postLaneOverrideNotices: vi.fn(async () => []),
}));
vi.mock("./inner-loop.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./inner-loop.js")>(), runInnerLoop: seams.innerLoop,
}));
vi.mock("./finalize.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./finalize.js")>(),
  realAdapter: vi.fn(() => ({ issueLabels: seams.issueLabels })), finalizeAll: seams.finalize,
}));
vi.mock("./merger-worktree.js", () => ({
  createMergerWorktree: vi.fn(async () => ({
    path: "/tmp/merger", remove: seams.mergerWorktreeRemove,
  })),
}));
vi.mock("./gate-stack.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./gate-stack.js")>(),
  startStack: vi.fn(async () => ({ runGate: vi.fn(), stop: seams.mergerStackStop })),
}));
vi.mock("./prompt.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./prompt.js")>(), buildProjectAnchor: vi.fn(async () => "anchor"),
}));
vi.mock("./merger.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./merger.js")>(),
  realAdapter: vi.fn(() => ({})), runMergerWithAdapter: seams.merger,
}));

import type { RunConfig } from "./config.js";
import { AgentCredentialError, AgentQuotaError } from "./agent-sandbox.js";
import { MergerError, realAdapter } from "./merger.js";
import { createBranchImages, ensureImages } from "./ensure-images.js";
import { createAgentImages } from "./agent-tools.js";
import { cleanupOrphanContainers } from "./containers.js";
import { startUiServer } from "./ui-server.js";
import { fetchOriginRefs, readConfigStaleness } from "./preflight.js";
import { startKeepawake } from "./keepawake.js";
import { run } from "./run.js";

const config: RunConfig = {
  ghOwner: "o", ghRepo: "r", cwd: "/tmp", workDir: "sandbar-run-quota-test",
  sandboxImage: "image", botName: "bot", botEmail: "bot@example.com",
  sandboxHooks: {}, env: { GH_TOKEN: "token" },
  promptExtensions: {
    implementer: { text: "implementer only" },
    reviewer: { text: "correctness only" },
    reviewerQuality: { text: "quality only" },
    merger: { path: "docs/MERGER.md" },
  },
  gateStack: {
    containers: [{ name: "app", image: "image", mountWorktree: "/work", hold: true }],
    steps: [{ name: "test", in: "app", command: ["true"] }],
  },
};
const issue = (id: string) => ({
  id, title: `Issue ${id}`, branch: `sandbar/issue-${id}-test`, chunk: null,
});
const resolution = (plan: ReturnType<typeof issue>[]) => ({
  plan,
  candidates: plan.map((candidate) => ({ ...candidate, ready: true })),
  waiting: [], overrides: [], landedChunks: [], chunkNameDrifts: [],
});
const summary = (merged: ReturnType<typeof issue>[], pushed = true) => ({
  merged, chunkLanded: [], skipped: [], pushed, unclosed: [], mergedChunks: [],
  deferredChunks: [], skippedChunks: [],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};
const eventsOf = (kind: string) => seams.events.filter((event) => event.kind === kind);

const flushMicrotasksUntil = async (
  predicate: () => boolean,
  description: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${description}`);
};

describe("run quota orchestration (#109)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    seams.innerLoop.mockReset(); seams.merger.mockReset(); seams.plan.mockReset();
    seams.finalize.mockReset(); seams.finalize.mockResolvedValue([]);
    seams.issueLabels.mockReset(); seams.issueLabels.mockResolvedValue([]);
    seams.mergerStackStop.mockReset(); seams.mergerStackStop.mockResolvedValue(undefined);
    seams.mergerWorktreeRemove.mockReset();
    seams.mergerWorktreeRemove.mockResolvedValue(undefined);
    seams.landRequestPullRequests.mockReset();
    seams.landRequestPullRequests.mockResolvedValue([]);
    seams.emit.mockReset();
    seams.emit.mockImplementation(async (event: Record<string, unknown>) => {
      seams.events.push(event);
      return event;
    });
    seams.events.length = 0;
    seams.prepareCodexAuth.mockClear();
    seams.wakeStatusReports.length = 0;
    vi.mocked(fetchOriginRefs).mockReset();
    vi.mocked(fetchOriginRefs).mockRejectedValue(new Error("stop after idle poll"));
    vi.mocked(readConfigStaleness).mockReset();
    vi.mocked(readConfigStaleness).mockResolvedValue({
      configPath: null, sourceBranch: "main", hostCwd: "/repo",
      behind: 0, touchingConfig: 0,
    });
    vi.mocked(ensureImages).mockReset();
    vi.mocked(ensureImages).mockResolvedValue(new Map());
    vi.mocked(createBranchImages).mockReset();
    vi.mocked(createBranchImages).mockReturnValue({
      resolve: vi.fn(async () => new Map()), builtTags: () => [],
    });
    vi.mocked(createAgentImages).mockReset();
    vi.mocked(createAgentImages).mockResolvedValue({
      declaredTag: "image", augment: vi.fn(async () => "image"), builtTags: () => [],
    });
    seams.cleanupCallbacks.length = 0;
    seams.wakeLocks.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("routes an unexpected UI startup failure through the internal-failure path", async () => {
    vi.mocked(startUiServer).mockRejectedValueOnce(new Error("UI asset vanished"));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, pollIntervalMs: 1 })).rejects.toThrow("EXIT:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(eventsOf("complaint")).toContainEqual(expect.objectContaining({
      severity: "error", message: expect.stringContaining("UI asset vanished"),
    }));
    expect(eventsOf("exit")).toContainEqual(expect.objectContaining({
      tag: "halted", exitCode: 1,
    }));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("SANDBAR HALTED — internal failure"),
    );
  });

  it("records wake-lock state from the structured status, not its rendered prose", async () => {
    seams.wakeStatusReports.push(
      {
        line: "wake-lock: NOT held — not WSL2",
        status: { kind: "refused", reason: "not WSL2" },
      },
      {
        line: "wake-lock: LOST — exit 1; giving up",
        status: { kind: "lost", reason: "exit 1", retaking: false },
      },
    );
    seams.plan.mockResolvedValue(resolution([]));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, pollIntervalMs: 1 })).rejects.toThrow("EXIT:1");
    expect(eventsOf("wake-lock")).toEqual([
      { kind: "wake-lock", state: "refused", detail: "wake-lock: NOT held — not WSL2" },
      { kind: "wake-lock", state: "lost", detail: "wake-lock: LOST — exit 1; giving up" },
    ]);
  });

  it("handles one failed wake-lock append immediately and submits the next status", async () => {
    seams.wakeStatusReports.push(
      { line: "wake-lock: held", status: { kind: "held" } },
      { line: "wake-lock: released", status: { kind: "released" } },
    );
    let failed = false;
    seams.emit.mockImplementation(async (event: Record<string, unknown>) => {
      if (event.kind === "wake-lock" && !failed) {
        failed = true;
        throw new Error("event filesystem unavailable");
      }
      seams.events.push(event);
      return event;
    });
    seams.plan.mockResolvedValue(resolution([]));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, pollIntervalMs: 1 })).rejects.toThrow("EXIT:1");
    expect(eventsOf("wake-lock")).toEqual([
      { kind: "wake-lock", state: "released", detail: "wake-lock: released" },
    ]);
  });

  it("keeps an empty queue alive, stays silent on a no-op poll, then admits new work", async () => {
    const arrived = issue("133");
    seams.plan
      .mockResolvedValueOnce(resolution([]))
      .mockResolvedValueOnce(resolution([]))
      .mockResolvedValue(resolution([arrived]));
    vi.mocked(fetchOriginRefs).mockResolvedValue({ sourceChanged: false, failures: [] });
    seams.innerLoop.mockResolvedValue({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, pollIntervalMs: 1 })).rejects.toThrow("EXIT:4");
    expect(exit).toHaveBeenCalledWith(4);
    expect(fetchOriginRefs).toHaveBeenCalledTimes(2);
    expect(seams.innerLoop).toHaveBeenCalledOnce();
    expect(eventsOf("recompute").slice(0, 2).map((event) => event.trigger))
      .toEqual(["launch", "poll"]);
    expect(eventsOf("recompute").filter((event) => event.trigger === "poll"))
      .toHaveLength(1);
    expect(eventsOf("idle")).toHaveLength(1);
    expect(vi.mocked(console.log).mock.calls).toEqual([["http://127.0.0.1:7331/"]]);
    expect(startKeepawake).toHaveBeenCalledTimes(2);
    expect(seams.wakeLocks[0]?.onStatus).toHaveBeenCalledOnce();
    expect(seams.wakeLocks[0]?.stop).toHaveBeenCalledOnce();
    expect(seams.wakeLocks[1]?.onStatus).toHaveBeenCalledOnce();
    expect(seams.wakeLocks[1]?.stop).toHaveBeenCalledOnce();
  });

  it("reports a failed poll refresh and retries instead of halting", async () => {
    vi.useFakeTimers();
    const pollIntervalMs = 1_000;
    const arrived = issue("135");
    seams.plan
      .mockResolvedValueOnce(resolution([]))
      .mockResolvedValue(resolution([arrived]));
    vi.mocked(fetchOriginRefs)
      .mockResolvedValueOnce({
        sourceChanged: false,
        failures: ["Fetching origin refs failed: network unavailable"],
      })
      .mockResolvedValue({ sourceChanged: false, failures: [] });
    seams.innerLoop.mockResolvedValue({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);
    const failureLine =
      `Poll refresh failed; retrying in ${pollIntervalMs}ms: ` +
      "Fetching origin refs failed: network unavailable";
    const result = run({ ...config, pollIntervalMs }).catch((error: unknown) => error);

    try {
      await flushMicrotasksUntil(
        () => vi.getTimerCount() === 1,
        "the initial idle poll timer",
      );
      await vi.advanceTimersByTimeAsync(pollIntervalMs);
      await flushMicrotasksUntil(
        () => eventsOf("complaint").some((event) => event.message === failureLine),
        "the failed poll refresh to be reported",
      );
      expect(fetchOriginRefs).toHaveBeenCalledOnce();

      await flushMicrotasksUntil(
        () => vi.getTimerCount() === 1,
        "the failed refresh to re-arm the poll timer",
      );
      await vi.advanceTimersByTimeAsync(pollIntervalMs - 1);
      expect(fetchOriginRefs).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);

      expect(await result).toEqual(expect.objectContaining({ message: "EXIT:4" }));
      expect(exit).toHaveBeenCalledWith(4);
      expect(fetchOriginRefs).toHaveBeenCalledTimes(2);
      expect(seams.plan.mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(fetchOriginRefs).mock.invocationCallOrder[0]!);
      expect(vi.mocked(fetchOriginRefs).mock.invocationCallOrder[1])
        .toBeLessThan(seams.plan.mock.invocationCallOrder[1]!);
      expect(eventsOf("recompute").slice(0, 2).map((event) => event.trigger))
        .toEqual(["launch", "poll"]);
      expect(eventsOf("recompute").filter((event) => event.trigger === "poll"))
        .toHaveLength(1);
      expect(seams.innerLoop).toHaveBeenCalledOnce();
      expect(eventsOf("complaint").filter((event) => event.message === failureLine))
        .toHaveLength(1);
      expect(vi.mocked(console.error).mock.calls.flat().join("\n"))
        .not.toContain("SANDBAR HALTED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a replacement wake lock when admitted work returns to idle", async () => {
    const arrived = issue("133");
    seams.plan
      .mockResolvedValueOnce(resolution([]))
      .mockResolvedValueOnce(resolution([arrived]))
      .mockResolvedValue(resolution([]));
    vi.mocked(fetchOriginRefs)
      .mockResolvedValueOnce({ sourceChanged: false, failures: [] })
      .mockRejectedValueOnce(new Error("stop after second idle transition"));
    seams.innerLoop.mockResolvedValue({
      type: "NEEDS-INFO", questions: "answer", strandedHead: null,
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, pollIntervalMs: 1 })).rejects.toThrow("EXIT:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(seams.innerLoop).toHaveBeenCalledOnce();
    expect(eventsOf("idle")).toHaveLength(2);
    expect(startKeepawake).toHaveBeenCalledTimes(2);
    expect(seams.wakeLocks[0]?.stop).toHaveBeenCalledOnce();
    expect(seams.wakeLocks[1]?.stop).toHaveBeenCalledOnce();
  });

  it("keeps the original wake lock while an idle daemon waits for work", async () => {
    const arrived = issue("133");
    seams.plan
      .mockResolvedValueOnce(resolution([]))
      .mockResolvedValue(resolution([arrived]));
    vi.mocked(fetchOriginRefs).mockResolvedValue({ sourceChanged: false, failures: [] });
    seams.innerLoop.mockResolvedValue({
      type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({
      ...config, pollIntervalMs: 1, keepAwakeWhileIdle: true,
    })).rejects.toThrow("EXIT:4");
    expect(exit).toHaveBeenCalledWith(4);
    expect(eventsOf("idle")).toHaveLength(1);
    expect(seams.innerLoop).toHaveBeenCalledOnce();
    expect(startKeepawake).toHaveBeenCalledOnce();
    expect(seams.wakeLocks[0]?.stop).toHaveBeenCalledOnce();
  });

  it("gives post-refresh work new images while an older admission stays immutable", async () => {
    const slow = issue("1");
    const fast = issue("2");
    const arrived = issue("134");
    const slowTerminal = deferred<{
      type: "NEEDS-INFO"; questions: string; strandedHead: null;
    }>();
    const oldAgentImages = {
      declaredTag: "agent-old", augment: vi.fn(async () => "agent-old"), builtTags: () => [],
    };
    const newAgentImages = {
      declaredTag: "agent-new", augment: vi.fn(async () => "agent-new"), builtTags: () => [],
    };
    const oldBranchImages = {
      resolve: vi.fn(async () => new Map()), builtTags: () => [],
    };
    const newBranchImages = {
      resolve: vi.fn(async () => new Map()), builtTags: () => [],
    };
    vi.mocked(createAgentImages)
      .mockResolvedValueOnce(oldAgentImages)
      .mockResolvedValue(newAgentImages);
    vi.mocked(createBranchImages)
      .mockReturnValueOnce(oldBranchImages)
      .mockReturnValue(newBranchImages);
    let polled = false;
    seams.plan.mockImplementation(async () =>
      resolution(polled ? [arrived] : [slow, fast]));
    vi.mocked(fetchOriginRefs).mockImplementation(async () => {
      polled = true;
      return { sourceChanged: true, failures: [] };
    });
    seams.innerLoop.mockImplementation(async (candidate: ReturnType<typeof issue>) => {
      if (candidate.id === slow.id) return slowTerminal.promise;
      if (candidate.id === fast.id) {
        return { type: "NEEDS-INFO", questions: "answer", strandedHead: null };
      }
      slowTerminal.resolve({ type: "NEEDS-INFO", questions: "answer", strandedHead: null });
      return { type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42 };
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({
      ...config, maxParallelIssues: 2, pollIntervalMs: 1, keepAwakeWhileIdle: true,
    }))
      .rejects.toThrow("EXIT:4");
    expect(ensureImages).toHaveBeenCalledTimes(2);
    expect(createAgentImages).toHaveBeenCalledTimes(2);
    expect(eventsOf("preflight")).toContainEqual(expect.objectContaining({
      action: "origin-refreshed",
      detail: "origin/main moved during poll; refreshing source images",
    }));
    const slowOptions = seams.innerLoop.mock.calls.find(([candidate]) =>
      candidate.id === slow.id)?.[1];
    const arrivedOptions = seams.innerLoop.mock.calls.find(([candidate]) =>
      candidate.id === arrived.id)?.[1];
    expect(slowOptions.config.agentImages).toBe(oldAgentImages);
    expect(slowOptions.branchImages).toBe(oldBranchImages);
    expect(arrivedOptions.config.agentImages).toBe(newAgentImages);
    expect(arrivedOptions.branchImages).toBe(newBranchImages);
    expect(startKeepawake).toHaveBeenCalledOnce();
    expect(seams.wakeLocks[0]?.onStatus).toHaveBeenCalledOnce();
    // The only stop is terminal cleanup: idle did not release this holder.
    expect(seams.wakeLocks[0]?.stop).toHaveBeenCalledOnce();
  });

  it("reports a changed stale-config count once, not on every poll", async () => {
    const stale = {
      configPath: "/repo/sandbar.config.mjs", sourceBranch: "main", hostCwd: "/repo",
      behind: 2, touchingConfig: 1,
    };
    seams.plan.mockResolvedValue(resolution([]));
    vi.mocked(fetchOriginRefs)
      .mockResolvedValueOnce({ sourceChanged: false, failures: [] })
      .mockResolvedValueOnce({ sourceChanged: false, failures: [] });
    vi.mocked(readConfigStaleness)
      .mockResolvedValueOnce({ ...stale, behind: 0, touchingConfig: 0 })
      .mockResolvedValue(stale);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, pollIntervalMs: 1 })).rejects.toThrow("EXIT:1");
    expect(eventsOf("complaint").filter((event) =>
      String(event.message).includes("1 of them change /repo/sandbar.config.mjs")))
      .toHaveLength(1);
    expect(eventsOf("recompute").filter((event) => event.trigger === "poll"))
      .toHaveLength(1);
  });

  it("drives issue quota through run(), exits 4, and lands completed work first", async () => {
    const done = issue("1");
    const quota = issue("109");
    seams.plan.mockResolvedValue(resolution([done, quota]));
    seams.innerLoop.mockImplementation(async (i: ReturnType<typeof issue>) => i.id === "1"
      ? { type: "DONE", commits: [{ sha: "abc" }] }
      : { type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42 });
    seams.merger.mockResolvedValue(summary([done]));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run(config)).rejects.toThrow("EXIT:4");
    expect(exit).toHaveBeenCalledWith(4);
    expect(seams.merger).toHaveBeenCalledOnce();
    expect(ensureImages).toHaveBeenCalledTimes(2);
    expect(createAgentImages).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(ensureImages).mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ captureBuild: true }));
    }
    // Every image-build seam is silenced: stdout is the UI URL only, and the
    // per-branch resolver runs per attempt and per landing (#37), not at startup.
    for (const seam of [ensureImages, createAgentImages, createBranchImages]) {
      expect(vi.mocked(seam).mock.calls.length).toBeGreaterThan(0);
      for (const call of vi.mocked(seam).mock.calls) {
        const opts = (call as unknown[]).find((arg) =>
          typeof arg === "object" && arg !== null && "log" in arg) as { log?: (line: string) => void };
        expect(opts.log).toBeTypeOf("function");
        opts.log?.("Rebuilding x");
      }
    }
    expect(vi.mocked(console.log).mock.calls).toEqual([["http://127.0.0.1:7331/"]]);
    expect(seams.innerLoop.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      config: expect.objectContaining({ promptExtensions: config.promptExtensions }),
    }));
    expect(seams.merger.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
      promptExtension: config.promptExtensions?.merger,
    }));
    expect(eventsOf("exit")).toContainEqual(expect.objectContaining({
      tag: "quota",
      reason: "claude five_hour quota window closed; resets at 1970-01-01T00:00:42.000Z",
      exitCode: 4,
    }));
  });

  it("drains other-provider work, finalizes credential handoff, and exits 4", async () => {
    const done = issue("1");
    const refused = issue("134");
    const detail = "Your access token could not be refreshed. Please log out and sign in again.";
    seams.plan.mockResolvedValue(resolution([done, refused]));
    seams.innerLoop.mockImplementation(async (i: ReturnType<typeof issue>) => i.id === "1"
      ? { type: "DONE", commits: [{ sha: "abc" }], specGaps: [] }
      : { type: "CREDENTIAL", provider: "codex", detail, specGaps: [] });
    seams.merger.mockResolvedValue(summary([done]));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run(config)).rejects.toThrow("EXIT:4");
    expect(exit).toHaveBeenCalledWith(4);
    expect(seams.merger).toHaveBeenCalledOnce();
    expect(seams.finalize).toHaveBeenCalledWith(
      [expect.objectContaining({
        kind: "credential",
        provider: "codex",
        detail,
        issue: refused,
      })],
      expect.anything(),
      expect.anything(),
    );
    expect(eventsOf("exit")).toContainEqual(expect.objectContaining({
      tag: "credential",
      reason: `codex refused its credential: ${detail} Log in again on the host and restart.`,
      exitCode: 4,
    }));
  });

  it("prepares and threads one shared auth mount while withholding the JSON env value", async () => {
    const done = issue("1");
    const refused = issue("134");
    const configuredJson = JSON.stringify({ last_refresh: "2026-09-08T08:00:57Z" });
    seams.plan.mockResolvedValue(resolution([done, refused]));
    seams.innerLoop.mockImplementation(async (candidate: ReturnType<typeof issue>) =>
      candidate.id === "1"
        ? { type: "DONE", commits: [{ sha: "abc" }], specGaps: [] }
        : {
            type: "CREDENTIAL",
            provider: "codex",
            detail: "refresh refused",
            specGaps: [],
          });
    seams.merger.mockResolvedValue(summary([done]));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({
      ...config,
      implementerAgent: "codex",
      implementerModelId: "gpt-5.6-sol",
      mergerAgent: "codex",
      mergerModelId: "gpt-5.6-sol",
      env: { ...config.env, CODEX_AUTH_JSON: configuredJson },
    })).rejects.toThrow("EXIT:4");

    expect(seams.prepareCodexAuth).toHaveBeenCalledWith({
      stateDir: "/tmp/sandbar-run-quota-test",
      configuredJson,
    });
    expect(seams.innerLoop.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      config: expect.objectContaining({
        codexAuthMount: {
          hostPath: "/tmp/sandbar-run-quota-test/codex-auth.json",
          sandboxPath: "/home/agent/.codex/auth.json",
        },
        env: { GH_TOKEN: "token" },
      }),
    }));
    expect(vi.mocked(realAdapter)).toHaveBeenCalledWith(expect.objectContaining({
      codexAuthMount: {
        hostPath: "/tmp/sandbar-run-quota-test/codex-auth.json",
        sandboxPath: "/home/agent/.codex/auth.json",
      },
    }));
  });

  it("records the duration supplied by an image build observation", async () => {
    vi.mocked(ensureImages).mockImplementationOnce(async (_images, _root, opts) => {
      await opts?.onImage?.({
        tag: "image",
        built: true,
        reason: "inputs-changed",
        durationMs: 321,
      });
      return new Map();
    });
    seams.plan.mockResolvedValue(resolution([]));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, pollIntervalMs: 1 })).rejects.toThrow("EXIT:1");
    expect(eventsOf("image")).toEqual([{
      kind: "image",
      action: "built",
      image: "image",
      durationMs: 321,
      detail: "image",
    }]);
  });

  it("stops admissions as soon as the shared provider state closes", async () => {
    const issues = [issue("1"), issue("2"), issue("3"), issue("4")];
    seams.plan.mockImplementation(async (
      _repo,
      options: { ongoing?: ReadonlySet<number>; k?: number },
    ) => resolution(issues
      .filter((candidate) => !options.ongoing?.has(Number(candidate.id)))
      .slice(0, options.k)));
    seams.innerLoop.mockImplementation(async (
      candidate: ReturnType<typeof issue>,
      options: { providerState: { close(provider: "claude", closure: object): void } },
    ) => {
      if (candidate.id === "1") {
        options.providerState.close("claude", { cause: "quota", measurement: {
          status: "rejected", window: "five_hour", resetsAt: 42,
        } });
      }
      return {
        type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
        specGaps: [],
      };
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 3 })).rejects.toThrow("EXIT:4");
    expect(exit).toHaveBeenCalledWith(4);
    expect(seams.innerLoop.mock.calls.map((call) => call[0].id)).toEqual(["1", "2", "3"]);
    expect(eventsOf("recompute")).toContainEqual(expect.objectContaining({
      admitted: [],
      waiting: [{ issue: 4, title: "Issue 4", reason: { kind: "no-slot" } }],
    }));
  });

  it("keeps planner waiting rows when the scheduler also declines a planned issue", async () => {
    const eligible = [issue("1"), issue("2"), issue("3"), issue("4")];
    const blocked = issue("5");
    seams.plan.mockImplementation(async (
      _repo,
      options: { ongoing?: ReadonlySet<number>; k?: number },
    ) => {
      const available = eligible.filter(
        (candidate) => !options.ongoing?.has(Number(candidate.id)),
      );
      const plan = available.slice(0, options.k);
      return {
        ...resolution(plan),
        candidates: [...eligible, blocked].map((candidate) => ({
          ...candidate,
          ready: true,
        })),
        waiting: [
          ...available.slice(options.k).map((candidate) => ({
            issue: Number(candidate.id),
            title: candidate.title,
            reason: { kind: "no-slot" as const },
          })),
          {
            issue: 5,
            title: blocked.title,
            reason: { kind: "blocked" as const, by: [99] },
          },
        ],
      };
    });
    seams.innerLoop.mockImplementation(async (
      _candidate: ReturnType<typeof issue>,
      options: { providerState: { close(provider: "claude", closure: object): void } },
    ) => {
      options.providerState.close("claude", { cause: "quota", measurement: {
        status: "rejected", window: "five_hour", resetsAt: 42,
      } });
      return {
        type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
        specGaps: [],
      };
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 3 })).rejects.toThrow("EXIT:4");
    const closedRecompute = eventsOf("recompute").find(
      (event) => Array.isArray(event.admitted) && event.admitted.length === 0,
    );
    expect(closedRecompute?.waiting).toEqual([
      { issue: 4, title: "Issue 4", reason: { kind: "no-slot" } },
      { issue: 5, title: "Issue 5", reason: { kind: "blocked", by: [99] } },
    ]);
  });

  it("logs finalized outcomes before a tracker read-back mismatch halts", async () => {
    const target = issue("87");
    seams.plan.mockResolvedValue(resolution([target]));
    seams.innerLoop.mockResolvedValue({
      type: "NEEDS-INFO", questions: "answer", strandedHead: null,
    });
    seams.finalize.mockResolvedValue([{
      input: {
        kind: "needs-info", issue: target, questions: "answer", strandedHead: null,
      },
      action: { kind: "pushed" },
    }]);
    seams.issueLabels.mockResolvedValue(["ready-for-agent", "needs-info"]);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 1 })).rejects.toThrow("EXIT:1");
    expect(eventsOf("finalise")).toContainEqual(expect.objectContaining({
      issue: 87, finaliseKind: "needs-info", outcome: "pushed", detail: "pushed branch",
    }));
    expect(eventsOf("complaint").some((event) =>
      String(event.message).includes("Tracker read-back mismatch"))).toBe(true);
  });

  it("starts a successor in the same daemon after a landing", async () => {
    const done = issue("1");
    const successor = issue("2");
    seams.plan
      .mockResolvedValueOnce(resolution([done]))
      .mockResolvedValueOnce(resolution([]))
      .mockResolvedValue(resolution([successor]));
    seams.innerLoop.mockImplementation(async (candidate: ReturnType<typeof issue>) =>
      candidate.id === "1"
        ? { type: "DONE", commits: [{ sha: "abc" }] }
        : { type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42 });
    seams.merger.mockResolvedValue(summary([done]));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run(config)).rejects.toThrow("EXIT:4");
    expect(exit).toHaveBeenCalledWith(4);
    expect(seams.innerLoop.mock.calls.map((call) => call[0].id)).toEqual(["1", "2"]);
  });

  it("captures a merger quota from run() and exits 4 instead of halted", async () => {
    const done = issue("1");
    seams.plan.mockResolvedValue(resolution([done]));
    seams.innerLoop.mockResolvedValue({ type: "DONE", commits: [{ sha: "abc" }] });
    const quota = new AgentQuotaError("codex", {
      status: "rejected", window: "seven_day", resetsAt: 84,
    });
    seams.merger.mockRejectedValue(new MergerError("resolve failed", undefined, { cause: quota }));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run(config)).rejects.toThrow("EXIT:4");
    expect(exit).toHaveBeenCalledWith(4);
    expect(eventsOf("exit")).toContainEqual(expect.objectContaining({
      tag: "quota",
      reason: "codex seven_day quota window closed; resets at 1970-01-01T00:01:24.000Z",
    }));
    expect(eventsOf("exit").some((event) => event.tag === "halted")).toBe(false);
  });

  it("captures a merger credential refusal and exits 4 instead of halted", async () => {
    const done = issue("1");
    const detail = "Your access token could not be refreshed. Please log out and sign in again.";
    seams.plan.mockResolvedValue(resolution([done]));
    seams.innerLoop.mockResolvedValue({ type: "DONE", commits: [{ sha: "abc" }] });
    const credential = new AgentCredentialError("codex", detail);
    seams.merger.mockRejectedValue(
      new MergerError("resolve failed", undefined, { cause: credential }),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run(config)).rejects.toThrow("EXIT:4");
    expect(exit).toHaveBeenCalledWith(4);
    expect(eventsOf("exit")).toContainEqual(expect.objectContaining({
      tag: "credential",
      reason: `codex refused its credential: ${detail} Log in again on the host and restart.`,
    }));
    expect(eventsOf("exit").some((event) => event.tag === "halted")).toBe(false);
  });

  it("records durable outcomes from a merger halt's partial summary", async () => {
    const done = issue("1");
    const partial = {
      ...summary([]),
      skipped: [{ issue: done, reason: "gate-2 stayed red" }],
    };
    seams.plan.mockResolvedValue(resolution([done]));
    seams.innerLoop.mockResolvedValue({ type: "DONE", commits: [{ sha: "abc" }] });
    seams.merger.mockImplementation(async (
      _issues,
      _adapter,
      _log,
      _gateLog,
      options: { observations: { onOutcome: (outcome: object) => Promise<void> } },
    ) => {
      await options.observations.onOutcome({
        kind: "skipped",
        issue: done,
        reason: "gate-2 stayed red",
        durationMs: 17,
      });
      throw new MergerError("merge halted", partial);
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run(config)).rejects.toThrow("EXIT:1");
    expect(eventsOf("landed")).toContainEqual(expect.objectContaining({
      issue: 1,
      outcome: "skipped",
      reason: "gate-2 stayed red",
      durationMs: 17,
    }));
  });

  it("records exactly one duration-bearing event for a completed landing batch", async () => {
    const done = issue("1");
    seams.plan
      .mockResolvedValueOnce(resolution([done]))
      .mockResolvedValue(resolution([]));
    seams.innerLoop.mockResolvedValue({
      type: "DONE",
      commits: [{ sha: "abc" }],
    });
    seams.merger.mockResolvedValue(summary([done]));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, pollIntervalMs: 1 })).rejects.toThrow("EXIT:1");
    expect(seams.merger).toHaveBeenCalledOnce();
    expect(eventsOf("landing-batch")).toEqual([{
      kind: "landing-batch",
      n: 1,
      durationMs: expect.any(Number),
    }]);
  });

  it("records a rejected issue task as its terminal outcome", async () => {
    const target = issue("12");
    seams.plan
      .mockResolvedValueOnce(resolution([target]))
      .mockResolvedValue(resolution([]));
    seams.innerLoop.mockRejectedValue(new Error("sandbox disappeared"));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 1, pollIntervalMs: 1 }))
      .rejects.toThrow("EXIT:1");
    expect(eventsOf("terminal")).toContainEqual(expect.objectContaining({
      issue: 12,
      title: "Issue 12",
      terminal: "REJECTED",
      reason: "sandbox disappeared",
      durationMs: expect.any(Number),
    }));
  });

  it("refills a freed slot before landing while a sibling remains active", async () => {
    const issues = [issue("1"), issue("2"), issue("3"), issue("4"), issue("5")];
    const slow = deferred<{ type: "DONE"; commits: { sha: string }[] }>();
    seams.plan.mockImplementation(async (_repo, options: { excluded?: Set<number> }) =>
      resolution(issues.filter((candidate) => !options.excluded?.has(Number(candidate.id)))));
    seams.innerLoop.mockImplementation((candidate: ReturnType<typeof issue>) =>
      candidate.id === "1"
        ? slow.promise
        : Promise.resolve({ type: "DONE", commits: [{ sha: candidate.id }] }));
    seams.merger.mockImplementation(async (batch: ReturnType<typeof issue>[]) => {
      if (seams.merger.mock.calls.length === 1) {
        // Startup is the only safe sweep so far: issue #1 still owns live
        // resources under the run scope during this landing.
        expect(cleanupOrphanContainers).toHaveBeenCalledTimes(1);
        expect(seams.innerLoop.mock.calls.map((call) => call[0].id)).toEqual(["1", "2", "3"]);
        slow.resolve({ type: "DONE", commits: [{ sha: "1" }] });
      }
      return summary(batch);
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 2, pollIntervalMs: 1 }))
      .rejects.toThrow("EXIT:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(seams.merger.mock.calls[0]?.[0].map((candidate: ReturnType<typeof issue>) => candidate.id))
      .toEqual(["2"]);
    expect(seams.merger.mock.calls[1]?.[0].map((candidate: ReturnType<typeof issue>) => candidate.id))
      .toEqual(["1", "3"]);
    // One event carries both the full resolver answer and the narrower
    // admission made with the single free slot.
    const refill = eventsOf("recompute").find((event) => event.trigger === "slot-freed");
    expect((refill?.candidates as Array<{ issue: number }>).map((candidate) => candidate.issue))
      .toEqual([3, 4, 5]);
    expect(refill?.admitted).toEqual([{ issue: 3, title: "Issue 3" }]);
  });

  it("continues after a rejected member and admits its successor", async () => {
    const issues = [issue("1"), issue("2")];
    seams.plan.mockImplementation(async (_repo, options: { excluded?: Set<number> }) =>
      resolution(issues.filter((candidate) => !options.excluded?.has(Number(candidate.id)))));
    seams.innerLoop.mockImplementation((candidate: ReturnType<typeof issue>) =>
      candidate.id === "1"
        ? Promise.reject(new Error("member rejected"))
        : Promise.resolve({
            type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
          }));

    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);
    await expect(run({ ...config, maxParallelIssues: 1, pollIntervalMs: 1 }))
      .rejects.toThrow("EXIT:4");
    expect(exit).toHaveBeenCalledWith(4);
    expect(seams.innerLoop.mock.calls.map((call) => call[0].id)).toEqual(["1", "2"]);
    expect(vi.mocked(console.log).mock.calls).toEqual([["http://127.0.0.1:7331/"]]);
  });

  it("drains and finalizes siblings before announcing a landing halt", async () => {
    const first = issue("1");
    const sibling = issue("2");
    const slow = deferred<{
      type: "NEEDS-INFO"; questions: string; strandedHead: null;
    }>();
    seams.plan.mockResolvedValue(resolution([first, sibling]));
    seams.innerLoop.mockImplementation((candidate: ReturnType<typeof issue>) =>
      candidate.id === "1"
        ? Promise.resolve({ type: "DONE", commits: [{ sha: "1" }] })
        : slow.promise);
    seams.merger.mockImplementation(async () => {
      slow.resolve({ type: "NEEDS-INFO", questions: "answer", strandedHead: null });
      throw new Error("landing failed");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 2 })).rejects.toThrow("EXIT:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(seams.finalize.mock.calls.some(([inputs]) =>
      inputs.some((input: { kind: string; issue: { id: string } }) =>
        input.kind === "needs-info" && input.issue.id === "2")))
      .toBe(true);
    const finaliseIndex = seams.events.findIndex((event) =>
      event.kind === "finalise" && event.issue === 2);
    const exitIndex = seams.events.findIndex((event) =>
      event.kind === "exit" && event.tag === "halted");
    expect(finaliseIndex).toBeLessThan(exitIndex);
    expect(eventsOf("complaint").some((event) =>
      String(event.message).includes("landing failed"))).toBe(true);
    expect(eventsOf("complaint").some((event) =>
      String(event.message).includes("merger halted unexpectedly"))).toBe(false);
  });

  it("exits stuck after the global terminal-without-landing backstop", async () => {
    const issues = Array.from({ length: 20 }, (_, index) => issue(String(index + 1)));
    seams.plan.mockImplementation(async (_repo, options: { excluded?: Set<number> }) =>
      resolution(issues.filter((candidate) => !options.excluded?.has(Number(candidate.id)))));
    seams.innerLoop.mockResolvedValue({
      type: "NEEDS-INFO", questions: "answer", strandedHead: null,
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 3 })).rejects.toThrow("EXIT:2");
    expect(exit).toHaveBeenCalledWith(2);
    // Six terminals trip the backstop. At most the already-admitted sibling
    // batch drains; the remaining eleven candidates never start.
    expect(seams.innerLoop).toHaveBeenCalledTimes(9);
    expect(seams.merger).not.toHaveBeenCalled();
  });

  it("retries a still-ready HARD-ERROR once per poll until the stuck exit", async () => {
    const target = issue("1");
    seams.plan.mockResolvedValue(resolution([target]));
    seams.innerLoop.mockResolvedValue({
      type: "HARD-ERROR", reason: "infra flake", commits: [],
    });
    vi.mocked(fetchOriginRefs).mockResolvedValue({ sourceChanged: false, failures: [] });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 1, pollIntervalMs: 1 }))
      .rejects.toThrow("EXIT:2");
    expect(exit).toHaveBeenCalledWith(2);
    expect(seams.innerLoop).toHaveBeenCalledTimes(6);
    expect(fetchOriginRefs).toHaveBeenCalledTimes(5);
  });

  it("requests enough planner candidates to fill a wider configured pool", async () => {
    const issues = Array.from({ length: 6 }, (_, index) => issue(String(index + 1)));
    let firstRecompute = true;
    seams.plan.mockImplementation(async (_repo, options: { k?: number }) => {
      if (firstRecompute) {
        expect(options.k).toBe(6);
        firstRecompute = false;
      }
      return resolution(issues);
    });
    seams.innerLoop.mockResolvedValue({
      type: "NEEDS-INFO", questions: "answer", strandedHead: null,
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 6 })).rejects.toThrow("EXIT:2");
    expect(exit).toHaveBeenCalledWith(2);
    expect(seams.innerLoop).toHaveBeenCalledTimes(6);
  });

  it("reacquires a slot for silent-noop without spending another start", async () => {
    const target = issue("87");
    seams.plan.mockResolvedValue(resolution([target]));
    seams.innerLoop.mockResolvedValue({ type: "DONE", commits: [{ sha: "abc" }] });
    seams.merger
      .mockResolvedValueOnce({
        ...summary([]),
        skipped: [{ issue: target, reason: "silent-noop" }],
      })
      .mockResolvedValueOnce(summary([target]));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 1, pollIntervalMs: 1 }))
      .rejects.toThrow("EXIT:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(seams.innerLoop).toHaveBeenCalledTimes(2);
    expect(seams.innerLoop.mock.calls.map((call) => call[0].id)).toEqual(["87", "87"]);
    expect(seams.merger).toHaveBeenCalledTimes(2);
    const freshAttemptCall = seams.finalize.mock.calls.findIndex(
      ([inputs]) => inputs.some((input: { kind: string }) => input.kind === "fresh-attempt"),
    );
    expect(freshAttemptCall).toBeGreaterThanOrEqual(0);
    expect(seams.finalize.mock.calls[freshAttemptCall]?.[0]).toEqual([
      { kind: "fresh-attempt", issue: target, specGaps: [] },
    ]);
    expect(seams.finalize.mock.invocationCallOrder[freshAttemptCall])
      .toBeLessThan(seams.innerLoop.mock.invocationCallOrder[1]!);
  });

  it("drains and lands in-flight work before returning to idle polling", async () => {
    const first = issue("1");
    const second = issue("2");
    const slow = deferred<{ type: "DONE"; commits: { sha: string }[] }>();
    seams.plan.mockResolvedValue(resolution([first, second]));
    seams.innerLoop.mockImplementation((candidate: ReturnType<typeof issue>) =>
      candidate.id === "1"
        ? Promise.resolve({ type: "DONE", commits: [{ sha: "1" }] })
        : slow.promise);
    seams.merger.mockImplementation(async (batch: ReturnType<typeof issue>[]) => {
      if (seams.merger.mock.calls.length === 1) {
        slow.resolve({ type: "DONE", commits: [{ sha: "2" }] });
      }
      return summary(batch);
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 2, pollIntervalMs: 1 }))
      .rejects.toThrow("EXIT:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(seams.innerLoop).toHaveBeenCalledTimes(2);
    expect(seams.merger.mock.calls.flatMap((call) => call[0]).map((item) => item.id).sort())
      .toEqual(["1", "2"]);
  });
  it("counts a chunk-branch landing as a landing, so a review-lane host never trips the backstop", async () => {
    const issues = Array.from({ length: 8 }, (_, index) => issue(String(index + 1)));
    const landed = new Set<string>();
    seams.plan.mockImplementation(async (_repo, options: { excluded?: Set<number> }) =>
      resolution(issues.filter((candidate) =>
        !landed.has(candidate.id) && !options.excluded?.has(Number(candidate.id)))));
    seams.innerLoop.mockImplementation(async (candidate: ReturnType<typeof issue>) =>
      ({ type: "DONE", commits: [{ sha: candidate.id }] }));
    // Every DONE lands on its chunk branch; nothing ever reaches the source
    // branch, which is the whole of a review-lane host's steady state.
    seams.merger.mockImplementation(async (batch: ReturnType<typeof issue>[]) => {
      for (const member of batch) landed.add(member.id);
      return {
        ...summary([]),
        chunkLanded: batch.map((member) => ({ issue: member, chunkBranch: "sandbar/chunk-1-x" })),
      };
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 3, pollIntervalMs: 1 }))
      .rejects.toThrow("EXIT:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(seams.innerLoop).toHaveBeenCalledTimes(8);
    expect(eventsOf("exit").some((event) => event.tag === "stuck")).toBe(false);
    expect(eventsOf("idle").length).toBeGreaterThan(0);
    // A chunk landing does not move the source branch, so images are built
    // once, at startup, and never rebuilt.
    expect(ensureImages).toHaveBeenCalledTimes(1);
  });

  it("waits for a poll before retrying an unchanged deferred landing request", async () => {
    const target = {
      root: 42,
      branch: "sandbar/chunk-42-test",
      title: "Chunk 42",
      members: [{ number: 42, title: "Issue 42" }],
      closeOrder: [{ number: 42, title: "Issue 42" }],
      rework: [{ number: 42, title: "Issue 42" }],
      pullRequest: 9,
    };
    seams.plan.mockResolvedValue({
      ...resolution([]),
      landedChunks: [target],
    });
    seams.landRequestPullRequests.mockResolvedValue([{
      number: 9,
      headRefName: target.branch,
      title: target.title,
    }]);
    seams.merger.mockResolvedValue({
      ...summary([]),
      deferredChunks: [{ target, landedNow: target.rework }],
    });
    vi.mocked(fetchOriginRefs)
      .mockResolvedValueOnce({ sourceChanged: false, failures: [] })
      .mockRejectedValueOnce(new Error("stop after deferred-request retry"));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 1, pollIntervalMs: 1 }))
      .rejects.toThrow("EXIT:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(fetchOriginRefs).toHaveBeenCalledTimes(2);
    expect(seams.merger).toHaveBeenCalledTimes(2);
    expect(seams.innerLoop).not.toHaveBeenCalled();
    expect(eventsOf("exit").some((event) => event.tag === "stuck")).toBe(false);
    expect(eventsOf("idle").length).toBeGreaterThan(0);
  });

  it("exits quota from the shared provider state when the closing issue returned no terminal", async () => {
    seams.plan.mockResolvedValue(resolution([issue("1")]));
    seams.innerLoop.mockImplementation(async (
      _candidate: ReturnType<typeof issue>,
      options: { providerState: { close(provider: "claude", closure: object): void } },
    ) => {
      options.providerState.close("claude", { cause: "quota", measurement: {
        status: "rejected", window: "seven_day", resetsAt: 84,
      } });
      throw new Error("sandbox died after the provider closed");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 1 })).rejects.toThrow("EXIT:4");
    expect(exit).toHaveBeenCalledWith(4);
    expect(seams.innerLoop).toHaveBeenCalledOnce();
    expect(eventsOf("exit")).toContainEqual(expect.objectContaining({
      tag: "quota",
      reason: "claude seven_day quota window closed; resets at 1970-01-01T00:01:24.000Z",
    }));
    expect(eventsOf("exit").some((event) => event.tag === "halted")).toBe(false);
  });

  it("reports a failing drain beside the landing failure and still halts on the original", async () => {
    const first = issue("1");
    const sibling = issue("2");
    const slow = deferred<{
      type: "NEEDS-INFO"; questions: string; strandedHead: null;
    }>();
    seams.plan.mockResolvedValue(resolution([first, sibling]));
    seams.innerLoop.mockImplementation((candidate: ReturnType<typeof issue>) =>
      candidate.id === "1"
        ? Promise.resolve({ type: "DONE", commits: [{ sha: "1" }] })
        : slow.promise);
    seams.merger.mockImplementation(async () => {
      slow.resolve({ type: "NEEDS-INFO", questions: "answer", strandedHead: null });
      throw new Error("landing failed");
    });
    seams.finalize.mockImplementation(async (inputs: { kind: string }[]) => {
      if (inputs.some((input) => input.kind === "needs-info")) {
        throw new Error("finalize failed");
      }
      return [];
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 2 })).rejects.toThrow("EXIT:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(eventsOf("complaint")).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("finalize failed"),
    }));
    expect(eventsOf("complaint").some((event) =>
      String(event.message).includes("landing failed"))).toBe(true);
    expect(eventsOf("exit")).toContainEqual(expect.objectContaining({ tag: "halted" }));
  });

  it.each([
    ["merger stack", () => seams.mergerStackStop],
    ["merger worktree", () => seams.mergerWorktreeRemove],
  ] as const)(
    "reports failing %s teardown beside a landing failure and preserves the landing failure",
    async (_resource, cleanup) => {
      seams.plan.mockResolvedValue(resolution([issue("1")]));
      seams.innerLoop.mockResolvedValue({
        type: "DONE", commits: [{ sha: "1" }],
      });
      seams.merger.mockRejectedValue(new Error("landing failed"));
      cleanup().mockRejectedValue(new Error("teardown failed"));
      const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`EXIT:${code}`);
      }) as never);

      await expect(run({ ...config, maxParallelIssues: 1 })).rejects.toThrow("EXIT:1");
      expect(exit).toHaveBeenCalledWith(1);
      expect(seams.mergerStackStop).toHaveBeenCalledOnce();
      expect(seams.mergerWorktreeRemove).toHaveBeenCalledOnce();
      expect(eventsOf("complaint").some((event) =>
        String(event.message).includes("Landing resource cleanup also failed") &&
        String(event.message).includes("teardown failed"))).toBe(true);
      expect(eventsOf("complaint").some((event) =>
        String(event.message).includes("landing failed"))).toBe(true);
      expect(eventsOf("exit")).toContainEqual(expect.objectContaining({ tag: "halted" }));
    },
  );

  it("reports later teardown failures after a successful landing and halts on the first", async () => {
    seams.plan.mockResolvedValue(resolution([issue("1")]));
    seams.innerLoop.mockResolvedValue({
      type: "DONE", commits: [{ sha: "1" }],
    });
    seams.merger.mockResolvedValue(summary([issue("1")]));
    seams.mergerStackStop.mockRejectedValue(new Error("stack teardown failed"));
    seams.mergerWorktreeRemove.mockRejectedValue(new Error("worktree teardown failed"));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 1 })).rejects.toThrow("EXIT:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(seams.mergerStackStop).toHaveBeenCalledOnce();
    expect(seams.mergerWorktreeRemove).toHaveBeenCalledOnce();
    expect(eventsOf("complaint").some((event) =>
      String(event.message).includes("Landing resource cleanup also failed") &&
      String(event.message).includes("worktree teardown failed"))).toBe(true);
    expect(eventsOf("complaint").some((event) =>
      String(event.message).includes("stack teardown failed"))).toBe(true);
    expect(eventsOf("exit")).toContainEqual(expect.objectContaining({ tag: "halted" }));
  });
});
