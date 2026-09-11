import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestSummary } from "./chunk-land.js";
import type { WakeLockStatus } from "./keepawake.js";

const seams = vi.hoisted(() => ({
  innerLoop: vi.fn(),
  merger: vi.fn(),
  plan: vi.fn(),
  finalize: vi.fn(async () => []),
  issueLabels: vi.fn(async () => [] as string[]),
  mergerStackRunGate: vi.fn(),
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
  cleanupOrder: [] as string[],
  trackWakeStop: false,
  cleanupDrain: null as Promise<void> | null,
  cleanupReporter: (async () => undefined) as (
    kind: string, message: string, cause?: unknown,
  ) => Promise<void> | void,
  wakeLocks: [] as Array<{
    stop: ReturnType<typeof vi.fn>;
    onStatus: ReturnType<typeof vi.fn>;
  }>,
  prepareCodexAuth: vi.fn(async () => ({
    hostPath: "/tmp/sandbar-run-quota-test/codex-auth.json",
    sandboxPath: "/home/agent/.codex/auth.json",
  })),
  originClaim: {
    sha: "lease-sha",
    lease: {
      hostname: "test-host",
      workdir: "/tmp",
      pid: 123,
      run: "test-run",
      startedAt: "2026-09-08T12:00:00.000Z",
      expires: "2099-09-08T12:10:00.000Z",
    },
  },
  originDisplaced: null as null | {
    sha: string;
    lease: {
      hostname: string; workdir: string; pid: number; run: string;
      startedAt: string; expires: string;
    };
  },
  originRenew: vi.fn(),
  originRelease: vi.fn(async () => undefined),
  recordFinalize: vi.fn(async () => undefined),
  reclaimIssueClone: vi.fn(async () => ({ kind: "removed" as const })),
}));

vi.mock("./codex-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./codex-auth.js")>(),
  prepareCodexAuth: seams.prepareCodexAuth,
}));

vi.mock("./driver-identity.js", () => ({
  readDriverIdentity: vi.fn(async () => ({ kind: "unknown" })),
  formatDriverIdentity: vi.fn(() => "driver: test"),
}));
vi.mock("./cleanup.js", () => {
  const beginCleanup = () => {
    if (seams.cleanupDrain !== null) {
      return { owner: false, done: seams.cleanupDrain };
    }
    seams.cleanupDrain = (async () => {
      while (seams.cleanupCallbacks.length > 0) {
        const action = seams.cleanupCallbacks.pop();
        if (!action) continue;
        try {
          await action();
        } catch (err) {
          await seams.cleanupReporter("cleanup-failure", "Cleanup action failed", err);
        }
      }
    })();
    return { owner: true, done: seams.cleanupDrain };
  };
  return {
  installCleanupTraps: vi.fn(),
  onCleanup: vi.fn((callback: () => unknown) => {
    seams.cleanupCallbacks.push(callback);
  }),
  registerDisposable: vi.fn((callback: () => unknown) => {
    seams.cleanupCallbacks.push(callback);
    return () => {
      const at = seams.cleanupCallbacks.indexOf(callback);
      if (at >= 0) seams.cleanupCallbacks.splice(at, 1);
    };
  }),
  setCleanupReporter: vi.fn((next: typeof seams.cleanupReporter) => {
    const previous = seams.cleanupReporter;
    seams.cleanupReporter = next;
    return () => { seams.cleanupReporter = previous; };
  }),
    beginCleanup: vi.fn(beginCleanup),
    runCleanup: vi.fn(async () => { await beginCleanup().done; }),
  };
});
vi.mock("./keepawake.js", () => ({
  startKeepawake: vi.fn(() => {
    const lock = {
      stop: vi.fn(async () => {
        if (seams.trackWakeStop) seams.cleanupOrder.push("wake-lock-stop");
      }),
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
vi.mock("./origin-lock.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./origin-lock.js")>(),
  acquireOriginLock: vi.fn(async () => ({
    displaced: seams.originDisplaced,
    lock: {
      claim: () => seams.originClaim,
      renew: seams.originRenew,
      release: seams.originRelease,
    },
  })),
}));
vi.mock("./events.js", () => ({
  runStampFromDate: vi.fn(() => "test-run"),
  startEventRecord: vi.fn(async () => ({
    runDir: "/tmp/run-quota-test",
    finalize: seams.recordFinalize,
    emit: seams.emit,
    issue: vi.fn(async (id: string) => ({
      dir: `/tmp/run-quota-test/issue-${id}`,
      writeInvocation: vi.fn(),
      writeGate: vi.fn(),
      startInvocationCycle: vi.fn(),
    })),
    landing: vi.fn(() => ({
      dir: "/tmp/run-quota-test/landing-1", appendMerger: vi.fn(),
      writeMergerGate: vi.fn(), writeResolveAttempt: vi.fn(),
    })),
  })),
}));
vi.mock("./agent-sandbox.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./agent-sandbox.js")>(),
  reclaimIssueClone: seams.reclaimIssueClone,
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
  checkForgeReachabilityForPreflight: vi.fn(async () => undefined),
  runPreflightAfterReachability: vi.fn(async () => "anyone" as const),
  absoluteMountSources: vi.fn(() => []),
  fetchOriginRefs: vi.fn(async () => ({ sourceChanged: false, failures: [] })),
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
  realAdapter: vi.fn(() => ({
    issueLabels: seams.issueLabels,
    reclaimIssueClone: seams.reclaimIssueClone,
  })),
  finalizeAll: seams.finalize,
}));
vi.mock("./merger-worktree.js", () => ({
  createMergerWorktree: vi.fn(async () => ({
    path: "/tmp/merger", remove: seams.mergerWorktreeRemove,
  })),
}));
vi.mock("./gate-stack.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./gate-stack.js")>(),
  startStack: vi.fn(async (opts) => ({
    runGate: seams.mergerStackRunGate,
    stop: vi.fn(async () => {
      await opts.onContainerTeardown?.({
        name: "merger-db", container: "merger-db-1", lifecycle: "issue",
        durationMs: 30, peakMemoryBytes: 3000, oomKilled: false,
      });
      await seams.mergerStackStop();
    }),
  })),
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
import type { InnerLoopOptions } from "./inner-loop.js";
import { MergerError, realAdapter, type RunMergerOptions } from "./merger.js";
import { realAdapter as realFinalizeAdapter } from "./finalize.js";
import { createBranchImages, ensureImages } from "./ensure-images.js";
import { createAgentImages } from "./agent-tools.js";
import { cleanupOrphanContainers } from "./containers.js";
import { UiPortInUseError, startUiServer } from "./ui-server.js";
import {
  checkForgeReachabilityForPreflight,
  fetchOriginRefs,
  runPreflightAfterReachability,
} from "./preflight.js";
import { startKeepawake } from "./keepawake.js";
import { OriginLeaseLostDuringCleanupError, run } from "./run.js";
import { OriginLockHeldError, acquireOriginLock } from "./origin-lock.js";
import { ensureRepoCache } from "./repo-cache.js";
import { startEventRecord } from "./events.js";
import { beginCleanup } from "./cleanup.js";

const config: RunConfig = {
  ghOwner: "o", ghRepo: "r", developers: "anyone", cwd: "/tmp", workDir: "sandbar-run-quota-test",
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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
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
    seams.mergerStackRunGate.mockReset();
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
    seams.originRenew.mockReset();
    seams.originRenew.mockResolvedValue({ kind: "renewed", claim: seams.originClaim });
    seams.originRelease.mockReset();
    seams.originDisplaced = null;
    seams.originRelease.mockImplementation(async () => {
      seams.cleanupOrder.push("origin-release");
    });
    seams.recordFinalize.mockReset();
    seams.recordFinalize.mockImplementation(async () => {
      seams.cleanupOrder.push("record-finalize");
    });
    seams.reclaimIssueClone.mockReset();
    seams.reclaimIssueClone.mockResolvedValue({ kind: "removed" });
    seams.cleanupOrder.length = 0;
    seams.trackWakeStop = false;
    seams.cleanupDrain = null;
    seams.cleanupReporter = async () => undefined;
    seams.wakeStatusReports.length = 0;
    vi.mocked(fetchOriginRefs).mockReset();
    vi.mocked(fetchOriginRefs).mockRejectedValue(new Error("stop after idle poll"));
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
    expect(seams.originRelease).toHaveBeenCalledOnce();
  });

  it("releases the origin lease when the UI port is already in use", async () => {
    vi.mocked(startUiServer).mockRejectedValueOnce(
      new UiPortInUseError(config.uiPort, "127.0.0.1", new Error("EADDRINUSE")),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run(config)).rejects.toThrow("EXIT:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(eventsOf("exit")).toContainEqual(expect.objectContaining({
      tag: "halted", exitCode: 1,
    }));
    expect(seams.originRelease).toHaveBeenCalledOnce();
  });

  it("acquires the origin lease after reachability and before ref-writing preflight", async () => {
    seams.plan.mockResolvedValue(resolution([]));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, pollIntervalMs: 1 })).rejects.toThrow("EXIT:1");
    expect(vi.mocked(ensureRepoCache).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(checkForgeReachabilityForPreflight).mock.invocationCallOrder[0]!);
    expect(vi.mocked(checkForgeReachabilityForPreflight).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(acquireOriginLock).mock.invocationCallOrder[0]!);
    expect(vi.mocked(acquireOriginLock).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(runPreflightAfterReachability).mock.invocationCallOrder[0]!);
  });

  it.each([
    ["origin-lock-acquired", null],
    ["origin-lock-taken-over", {
      ...seams.originClaim,
      sha: "expired-holder",
      lease: { ...seams.originClaim.lease, hostname: "old-host" },
    }],
  ] as const)("records %s with holder evidence", async (action, displaced) => {
    seams.originDisplaced = displaced;
    seams.plan.mockResolvedValue(resolution([]));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, pollIntervalMs: 1 })).rejects.toThrow("EXIT:1");
    expect(eventsOf("preflight")).toContainEqual(expect.objectContaining({
      action,
      detail: expect.stringContaining(displaced === null ? "lease-sha" : "old-host"),
    }));
  });

  it.each(["record creation", "first lease event"])(
    "releases the origin lease when %s fails",
    async (failurePoint) => {
      const failure = new Error(`${failurePoint} failed`);
      if (failurePoint === "record creation") {
        vi.mocked(startEventRecord).mockRejectedValueOnce(failure);
      } else {
        seams.emit.mockRejectedValueOnce(failure);
      }

      await expect(run(config)).rejects.toBe(failure);
      expect(seams.originRelease).toHaveBeenCalledOnce();
    },
  );

  it("keeps an origin-lock refusal stderr-only with no event record", async () => {
    vi.mocked(acquireOriginLock).mockRejectedValueOnce(
      new OriginLockHeldError({
        ...seams.originClaim,
        lease: { ...seams.originClaim.lease, hostname: "holder-host" },
      }),
    );
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run(config)).rejects.toThrow("EXIT:1");
    expect(startEventRecord).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("holder-host"));
    expect(seams.originRelease).not.toHaveBeenCalled();
  });

  it("cleans up and propagates an unexpected origin-lock programming failure", async () => {
    const bug = new Error("origin adapter invariant broke");
    vi.mocked(acquireOriginLock).mockRejectedValueOnce(bug);

    await expect(run(config)).rejects.toBe(bug);
    expect(startEventRecord).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("origin adapter invariant broke"),
    );
    expect(seams.originRelease).not.toHaveBeenCalled();
  });

  it("releases origin before the wake lock and event record", async () => {
    seams.plan.mockResolvedValue(resolution([]));
    seams.trackWakeStop = true;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({
      ...config,
      pollIntervalMs: 1,
      keepAwakeWhileIdle: true,
    })).rejects.toThrow("EXIT:1");
    expect(seams.cleanupOrder).toEqual([
      "origin-release", "wake-lock-stop", "record-finalize",
    ]);
  });

  it("threads the serialized lease barrier into finalization and landing adapters", async () => {
    seams.plan.mockResolvedValue(resolution([issue("139")]));
    seams.innerLoop.mockResolvedValue({ type: "DONE", commits: [{ sha: "work" }] });
    seams.merger.mockResolvedValue(summary([issue("139")]));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 1, pollIntervalMs: 1 }))
      .rejects.toThrow("EXIT:1");
    expect(vi.mocked(realFinalizeAdapter)).toHaveBeenCalledWith(
      expect.objectContaining({ beforeOriginWrite: expect.any(Function) }),
    );
    expect(vi.mocked(realAdapter)).toHaveBeenCalledWith(
      expect.objectContaining({ beforeOriginWrite: expect.any(Function) }),
    );
  });

  it("renews by heartbeat while post-acquisition preflight is still running", async () => {
    vi.useFakeTimers();
    try {
      const slowPreflight = deferred<Awaited<ReturnType<typeof runPreflightAfterReachability>>>();
      vi.mocked(runPreflightAfterReachability).mockReturnValueOnce(slowPreflight.promise);
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`EXIT:${code}`);
      }) as never);
      const result = run(config).catch((error: unknown) => error);
      await flushMicrotasksUntil(
        () => vi.mocked(runPreflightAfterReachability).mock.calls.length === 1,
        "post-acquisition preflight to start",
      );

      expect(seams.originRenew).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(seams.originRenew).toHaveBeenCalledOnce();

      slowPreflight.reject(new Error("stop slow preflight"));
      expect(await result).toEqual(expect.objectContaining({ message: "EXIT:1" }));
      expect(seams.originRelease).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for an in-flight heartbeat renewal before terminal cleanup releases origin", async () => {
    vi.useFakeTimers();
    try {
      const slowPreflight = deferred<Awaited<ReturnType<typeof runPreflightAfterReachability>>>();
      const renewal = deferred<Awaited<ReturnType<typeof seams.originRenew>>>();
      vi.mocked(runPreflightAfterReachability).mockReturnValueOnce(slowPreflight.promise);
      seams.originRenew.mockReturnValueOnce(renewal.promise);
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`EXIT:${code}`);
      }) as never);
      const result = run(config).catch((error: unknown) => error);
      await flushMicrotasksUntil(
        () => vi.mocked(runPreflightAfterReachability).mock.calls.length === 1,
        "post-acquisition preflight to start",
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(seams.originRenew).toHaveBeenCalledOnce();

      slowPreflight.reject(new Error("stop during renewal"));
      await flushMicrotasksUntil(
        () => eventsOf("exit").length === 1,
        "terminal cleanup to start",
      );
      expect(seams.originRelease).not.toHaveBeenCalled();
      expect(seams.recordFinalize).not.toHaveBeenCalled();

      renewal.resolve({ kind: "renewed", claim: seams.originClaim });
      expect(await result).toEqual(expect.objectContaining({ message: "EXIT:1" }));
      expect(seams.cleanupOrder).toEqual(["origin-release", "record-finalize"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets terminal cleanup own the exit when its in-flight renewal reports loss", async () => {
    vi.useFakeTimers();
    try {
      const slowPreflight = deferred<Awaited<ReturnType<typeof runPreflightAfterReachability>>>();
      const renewal = deferred<Awaited<ReturnType<typeof seams.originRenew>>>();
      vi.mocked(runPreflightAfterReachability).mockReturnValueOnce(slowPreflight.promise);
      seams.originRenew.mockReturnValueOnce(renewal.promise);
      const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`EXIT:${code}`);
      }) as never);
      const result = run(config).catch((error: unknown) => error);
      await flushMicrotasksUntil(
        () => vi.mocked(runPreflightAfterReachability).mock.calls.length === 1,
        "post-acquisition preflight to start",
      );
      await vi.advanceTimersByTimeAsync(60_000);
      slowPreflight.reject(new Error("stop during lost renewal"));
      await flushMicrotasksUntil(
        () => eventsOf("exit").length === 1,
        "terminal cleanup to start",
      );

      renewal.resolve({
        kind: "lost",
        holder: null,
        reason: "expired-unrenewable",
        detail: "origin could not be asked during cleanup",
      });
      expect(await result).toEqual(expect.objectContaining({ message: "EXIT:1" }));
      expect(exit).toHaveBeenCalledOnce();
      expect(eventsOf("exit")).toHaveLength(1);
      expect(eventsOf("complaint").filter((event) =>
        String(event["message"]).includes("origin could not be asked during cleanup"),
      )).toEqual([]);
      expect(seams.originRelease.mock.invocationCallOrder[0])
        .toBeLessThan(exit.mock.invocationCallOrder[0]!);
      expect(seams.recordFinalize.mock.invocationCallOrder[0])
        .toBeLessThan(exit.mock.invocationCallOrder[0]!);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a remote-write barrier after terminal cleanup released the lease", async () => {
    seams.plan
      .mockResolvedValueOnce(resolution([issue("139")]))
      .mockResolvedValue(resolution([]));
    seams.innerLoop.mockResolvedValue({
      type: "NEEDS-INFO", questions: "question", commits: [], specGaps: [],
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, pollIntervalMs: 1 })).rejects.toThrow("EXIT:1");
    const adapterArgs = vi.mocked(realFinalizeAdapter).mock.calls.at(-1)?.[0];
    expect(adapterArgs).toBeDefined();
    const exitsBefore = eventsOf("exit").length;
    const complaintsBefore = eventsOf("complaint").length;
    seams.originRenew.mockResolvedValueOnce({
      kind: "lost",
      holder: null,
      reason: "replaced",
      detail: "the released lease is no longer active",
    });

    await expect(adapterArgs!.beforeOriginWrite())
      .rejects.toBeInstanceOf(OriginLeaseLostDuringCleanupError);
    expect(eventsOf("exit")).toHaveLength(exitsBefore);
    expect(eventsOf("complaint")).toHaveLength(complaintsBefore);
  });

  it("propagates merger-wrapped lease loss to the existing cleanup owner", async () => {
    const done = issue("139");
    const loss = new OriginLeaseLostDuringCleanupError(
      "origin lease was lost during terminal cleanup",
    );
    const priorExit = {
      kind: "exit",
      tag: "halted",
      reason: "another terminal already owns cleanup",
      exitCode: 1,
    };
    seams.plan.mockResolvedValue(resolution([done]));
    seams.innerLoop.mockResolvedValue({ type: "DONE", commits: [{ sha: "work" }] });
    seams.merger.mockImplementation(async () => {
      await seams.emit(priorExit);
      expect(beginCleanup().owner).toBe(true);
      throw new MergerError("remote write barrier rejected", undefined, { cause: loss });
    });

    await expect(run({ ...config, maxParallelIssues: 1 })).rejects.toBe(loss);
    expect(eventsOf("exit")).toEqual([priorExit]);
    expect(eventsOf("complaint").filter((event) =>
      String(event["message"]).includes("Merger halted") ||
      String(event["message"]).includes("internal failure"),
    )).toEqual([]);
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("SANDBAR HALTED — internal failure"),
    );
  });

  it("records a release failure before run-end and continues cleanup", async () => {
    seams.plan.mockResolvedValue(resolution([]));
    seams.originRelease.mockImplementationOnce(async () => {
      seams.cleanupOrder.push("origin-release");
      throw new Error("lease delete failed");
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, pollIntervalMs: 1 })).rejects.toThrow("EXIT:1");
    expect(eventsOf("complaint")).toContainEqual(expect.objectContaining({
      severity: "error",
      message: expect.stringContaining("lease delete failed"),
    }));
    expect(seams.cleanupOrder).toEqual([
      "origin-release", "record-finalize",
    ]);
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

  it.each([
    {
      name: "a replacement holder",
      loss: {
        kind: "lost" as const,
        holder: {
          ...seams.originClaim,
          sha: "replacement-sha",
          lease: { ...seams.originClaim.lease, hostname: "other-host" },
        },
        reason: "replaced" as const,
        detail: "current holder is other-host",
      },
    },
    {
      name: "an expired lease while origin is unreachable",
      loss: {
        kind: "lost" as const,
        holder: null,
        reason: "expired-unrenewable" as const,
        detail: "origin could not be asked",
      },
    },
  ])("halts at a freed-slot wake and lands nothing after $name", async ({ loss }) => {
    seams.plan.mockResolvedValue(resolution([issue("139")]));
    seams.innerLoop.mockResolvedValue({ type: "DONE", commits: [{ sha: "work" }] });
    seams.originRenew
      .mockResolvedValueOnce({ kind: "renewed", claim: seams.originClaim })
      .mockResolvedValueOnce({ kind: "renewed", claim: seams.originClaim })
      .mockResolvedValueOnce(loss);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 1 })).rejects.toThrow("EXIT:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(seams.merger).not.toHaveBeenCalled();
    expect(seams.finalize).not.toHaveBeenCalled();
    expect(seams.innerLoop).toHaveBeenCalledWith(
      expect.objectContaining({ id: "139" }),
      expect.any(Object),
    );
    expect(seams.innerLoop.mock.calls[0]?.[1]).not.toHaveProperty(
      "deferIssueCloneReclaim",
    );
    expect(eventsOf("complaint")).toContainEqual(expect.objectContaining({
      severity: "error",
      message: expect.stringContaining(loss.detail),
    }));
    expect(eventsOf("exit")).toContainEqual(expect.objectContaining({
      tag: "halted", exitCode: 1,
    }));
    expect(seams.reclaimIssueClone).not.toHaveBeenCalled();
    expect(seams.originRelease).toHaveBeenCalledOnce();
  });

  it("halts at the admission barrier before admitting an issue", async () => {
    seams.plan.mockResolvedValue(resolution([issue("139")]));
    seams.originRenew
      .mockResolvedValueOnce({ kind: "renewed", claim: seams.originClaim })
      .mockResolvedValueOnce({
        kind: "lost",
        holder: null,
        reason: "expired-unrenewable",
        detail: "origin could not be asked at admission",
      });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 1 })).rejects.toThrow("EXIT:1");
    expect(seams.originRenew).toHaveBeenCalledTimes(2);
    expect(seams.innerLoop).not.toHaveBeenCalled();
    expect(eventsOf("complaint")).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("at admission"),
    }));
  });

  it("halts at the finalization barrier before reclaiming a settled clone", async () => {
    seams.plan.mockResolvedValue(resolution([issue("139")]));
    seams.innerLoop.mockResolvedValue({
      type: "NEEDS-INFO", questions: "question", commits: [], specGaps: [],
    });
    seams.originRenew
      .mockResolvedValueOnce({ kind: "renewed", claim: seams.originClaim })
      .mockResolvedValueOnce({ kind: "renewed", claim: seams.originClaim })
      .mockResolvedValueOnce({ kind: "renewed", claim: seams.originClaim })
      .mockResolvedValueOnce({
        kind: "lost",
        holder: null,
        reason: "expired-unrenewable",
        detail: "origin could not be asked before reclamation",
      });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 1 })).rejects.toThrow("EXIT:1");
    expect(seams.innerLoop).toHaveBeenCalledOnce();
    expect(seams.originRenew).toHaveBeenCalledTimes(4);
    expect(seams.finalize).not.toHaveBeenCalled();
    expect(seams.reclaimIssueClone).not.toHaveBeenCalled();
    expect(eventsOf("complaint")).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("before reclamation"),
    }));
  });

  it("reports why a rejected issue clone could not be reclaimed", async () => {
    seams.plan.mockResolvedValue(resolution([issue("139")]));
    seams.innerLoop.mockRejectedValue(new Error("sandbox failed"));
    seams.reclaimIssueClone.mockResolvedValueOnce({
      kind: "preserved",
      reason: "the worktree has uncommitted changes",
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 1, pollIntervalMs: 1 }))
      .rejects.toThrow("EXIT:1");
    expect(eventsOf("complaint")).toContainEqual({
      kind: "complaint",
      severity: "error",
      message: expect.stringMatching(
        /Issue clone preserved at .*sandbar-issue-139-test: the worktree has uncommitted changes/,
      ),
    });
  });

  it.each(["fulfilled", "rejected"] as const)(
    "reclaims a %s issue clone only after a successful wake renewal",
    async (settlement) => {
      seams.plan.mockResolvedValue(resolution([issue("139")]));
      if (settlement === "fulfilled") {
        seams.innerLoop.mockResolvedValue({
          type: "NEEDS-INFO", questions: "question", commits: [], specGaps: [],
        });
        seams.finalize.mockImplementation(async (inputs, adapter) => {
          for (const input of inputs) {
            await adapter.reclaimIssueClone(input.issue.branch);
          }
          return [];
        });
      } else {
        seams.innerLoop.mockRejectedValue(new Error("sandbox failed"));
      }
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`EXIT:${code}`);
      }) as never);

      await expect(run({ ...config, maxParallelIssues: 1, pollIntervalMs: 1 }))
        .rejects.toThrow("EXIT:1");
      expect(seams.originRenew.mock.calls.length).toBeGreaterThanOrEqual(3);
      if (settlement === "fulfilled") {
        expect(seams.reclaimIssueClone).toHaveBeenCalledWith(
          "sandbar/issue-139-test",
        );
      } else {
        expect(seams.reclaimIssueClone).toHaveBeenCalledWith(
          expect.any(String),
          expect.stringContaining("sandbar-issue-139-test"),
          "sandbar/issue-139-test",
        );
      }
      expect(seams.originRenew.mock.invocationCallOrder[2])
        .toBeLessThan(seams.reclaimIssueClone.mock.invocationCallOrder[0]!);
    },
  );

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
        () => vi.getTimerCount() === 2,
        "the initial idle poll timer",
      );
      await vi.advanceTimersByTimeAsync(pollIntervalMs);
      await flushMicrotasksUntil(
        () => eventsOf("complaint").some((event) => event.message === failureLine),
        "the failed poll refresh to be reported",
      );
      expect(fetchOriginRefs).toHaveBeenCalledOnce();

      await flushMicrotasksUntil(
        () => vi.getTimerCount() === 2,
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
    const codexHome = "/var/lib/sandbar-codex";
    const configuredJson = JSON.stringify({ last_refresh: "2026-09-08T08:00:57Z" });
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
    seams.prepareCodexAuth.mockResolvedValueOnce({
      hostPath: "/tmp/sandbar-run-quota-test/codex-auth.json",
      sandboxPath: `${codexHome}/auth.json`,
    });
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
      ...config,
      implementerAgent: "codex",
      implementerModelId: "gpt-5.6-sol",
      env: { ...config.env, CODEX_AUTH_JSON: configuredJson, CODEX_HOME: codexHome },
      maxParallelIssues: 2,
      pollIntervalMs: 1,
      keepAwakeWhileIdle: true,
    }))
      .rejects.toThrow("EXIT:4");
    expect(ensureImages).toHaveBeenCalledTimes(2);
    expect(createAgentImages).toHaveBeenCalledTimes(2);
    for (const [options] of vi.mocked(createAgentImages).mock.calls) {
      expect(options).toEqual(expect.objectContaining({ codexHome }));
    }
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

  it("drives issue quota through run(), exits 4, and lands completed work first", async () => {
    const done = issue("1");
    const quota = issue("109");
    seams.plan.mockResolvedValue(resolution([done, quota]));
    seams.innerLoop.mockImplementation(async (i: ReturnType<typeof issue>) => i.id === "1"
      ? { type: "DONE", commits: [{ sha: "abc" }] }
      : { type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42 });
    seams.merger.mockImplementation(async (...args: unknown[]) => {
      const options = args[4] as {
        onResolveAttempt: (key: string, record: Record<string, unknown>) => Promise<string>;
        observations: {
          onGate: (key: string, gate: Record<string, unknown>) => Promise<void>;
        };
      };
      await options.onResolveAttempt("1", {
        issueId: "1", attempt: 1, container: "resolve-1", end: "exit",
        exitCode: 137, signal: null, durationMs: 40, stdout: "", stderr: "",
        mode: "still-conflicted", peakMemoryBytes: 4000, oomKilled: true,
      });
      await options.observations.onGate("1", {
        ok: false, durationMs: 50, stdout: "", stderr: "", exitCode: 137,
        failedStep: "test", containerLogs: "",
        steps: [{
          name: "test", ok: false, durationMs: 49,
          peakMemoryBytes: 5000, oomKilled: true,
        }],
      });
      return summary([done]);
    });
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
    expect(eventsOf("resolve-attempt")).toContainEqual(expect.objectContaining({
      issue: 1, peakMemoryBytes: 4000, oomKilled: true,
    }));
    expect(eventsOf("gate")).toContainEqual(expect.objectContaining({
      gate: "gate-2",
      steps: {
        test: expect.objectContaining({
          durationMs: 49, peakMemoryBytes: 5000, oomKilled: true,
        }),
      },
    }));
    expect(eventsOf("container")).toContainEqual(expect.objectContaining({
      stack: "gate", name: "merger-db", peakMemoryBytes: 3000,
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

  it("forwards CODEX_HOME and threads one shared auth mount without the JSON env value", async () => {
    const done = issue("1");
    const refused = issue("134");
    const configuredJson = JSON.stringify({ last_refresh: "2026-09-08T08:00:57Z" });
    const codexHome = "/var/lib/sandbar-codex";
    seams.prepareCodexAuth.mockResolvedValueOnce({
      hostPath: "/tmp/sandbar-run-quota-test/codex-auth.json",
      sandboxPath: `${codexHome}/auth.json`,
    });
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
      env: { ...config.env, CODEX_AUTH_JSON: configuredJson, CODEX_HOME: codexHome },
    })).rejects.toThrow("EXIT:4");

    expect(seams.prepareCodexAuth).toHaveBeenCalledWith({
      stateDir: "/tmp/sandbar-run-quota-test",
      configuredJson,
      codexHome,
    });
    expect(vi.mocked(createAgentImages)).toHaveBeenCalledWith(
      expect.objectContaining({ codexHome }),
    );
    expect(seams.innerLoop.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      config: expect.objectContaining({
        codexAuthMount: {
          hostPath: "/tmp/sandbar-run-quota-test/codex-auth.json",
          sandboxPath: `${codexHome}/auth.json`,
        },
        env: { GH_TOKEN: "token", CODEX_HOME: codexHome },
      }),
    }));
    expect(vi.mocked(realAdapter)).toHaveBeenCalledWith(expect.objectContaining({
      codexAuthMount: {
        hostPath: "/tmp/sandbar-run-quota-test/codex-auth.json",
        sandboxPath: `${codexHome}/auth.json`,
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
      options: { providerState: { closeQuota(provider: "claude", measurement: object): void } },
    ) => {
      if (candidate.id === "1") {
        options.providerState.closeQuota("claude", {
          status: "rejected", window: "five_hour", resetsAt: 42,
        });
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

  it("logs each label-actor exclusion once per recorded recompute", async () => {
    const admitted = issue("1");
    const outsider = issue("9");
    seams.plan.mockResolvedValue({
      ...resolution([admitted]),
      candidates: [admitted, outsider].map((candidate) => ({
        ...candidate,
        ready: candidate.id === admitted.id,
      })),
      waiting: [{
        issue: 9,
        title: outsider.title,
        reason: { kind: "label-actor", actor: "mallory" },
      }],
    });
    seams.innerLoop.mockResolvedValue({
      type: "QUOTA",
      provider: "claude",
      window: "five_hour",
      resetsAt: 42,
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run(config)).rejects.toThrow("EXIT:4");
    const recomputes = eventsOf("recompute").filter((event) =>
      (event.waiting as Array<{ issue: number }>).some((entry) => entry.issue === 9));
    const exclusions = eventsOf("complaint").filter((event) =>
      String(event.message).includes("Issue #9 (Issue 9) excluded") &&
      String(event.message).includes("@mallory"));
    expect(exclusions).toHaveLength(recomputes.length);
  });

  it("records a stable label-actor exclusion on every poll recompute", async () => {
    const outsider = issue("9");
    const excluded = {
      ...resolution([]),
      candidates: [{ ...outsider, ready: false }],
      waiting: [{
        issue: 9,
        title: outsider.title,
        reason: { kind: "label-actor" as const, actor: "mallory" },
      }],
    };
    const arrived = issue("10");
    seams.plan
      .mockResolvedValueOnce(excluded)
      .mockResolvedValueOnce(excluded)
      .mockResolvedValue(resolution([arrived]));
    vi.mocked(fetchOriginRefs).mockResolvedValue({ sourceChanged: false, failures: [] });
    seams.innerLoop.mockResolvedValue({
      type: "QUOTA",
      provider: "claude",
      window: "five_hour",
      resetsAt: 42,
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, pollIntervalMs: 1 })).rejects.toThrow("EXIT:4");
    expect(eventsOf("complaint").filter((event) =>
      String(event.message).includes("Issue #9 (Issue 9) excluded")))
      .toHaveLength(2);
    expect(eventsOf("recompute").slice(0, 3).map((event) => event.trigger))
      .toEqual(["launch", "poll", "poll"]);
    expect(startKeepawake).toHaveBeenCalledTimes(2);
    expect(seams.wakeLocks[0]?.stop).toHaveBeenCalledOnce();
    expect(seams.wakeLocks[1]?.stop).toHaveBeenCalledOnce();
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
      options: { providerState: { closeQuota(provider: "claude", measurement: object): void } },
    ) => {
      options.providerState.closeQuota("claude", {
        status: "rejected", window: "five_hour", resetsAt: 42,
      });
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
    const credential = new AgentCredentialError(detail);
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

  it("shares the configured gate bound between an inner loop and the merger", async () => {
    const done = issue("1");
    const gating = issue("2");
    const releaseGate1 = deferred<void>();
    const gate1Started = deferred<void>();
    const starts: string[] = [];
    const gateResult = {
      ok: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
      failedStep: null,
      durationMs: 7,
      steps: [],
      containerLogs: "",
    };
    seams.plan.mockResolvedValue(resolution([done, gating]));
    seams.innerLoop.mockImplementation(async (
      candidate: ReturnType<typeof issue>,
      options: InnerLoopOptions,
    ) => {
      if (candidate.id === done.id) {
        return { type: "DONE", commits: [{ sha: "abc" }], specGaps: [] };
      }
      await options.gateSemaphore.run(async () => {
        starts.push("gate-1");
        gate1Started.resolve();
        await releaseGate1.promise;
      });
      return {
        type: "QUOTA", provider: "claude", window: "five_hour", resetsAt: 42,
        specGaps: [],
      };
    });
    seams.mergerStackRunGate.mockImplementation(async () => {
      starts.push("gate-2");
      return gateResult;
    });
    seams.merger.mockImplementation(async (batch: ReturnType<typeof issue>[]) => {
      await gate1Started.promise;
      const adapterDeps = vi.mocked(realAdapter).mock.calls[0]?.[0];
      if (adapterDeps === undefined) throw new Error("merger adapter was not created");
      const gate2 = adapterDeps.runStackGate();
      await Promise.resolve();
      expect(starts).toEqual(["gate-1"]);
      releaseGate1.resolve();
      await expect(gate2).resolves.toEqual({ value: gateResult, queuedMs: expect.any(Number) });
      expect(starts).toEqual(["gate-1", "gate-2"]);
      return summary(batch);
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 2, maxConcurrentGates: 1 }))
      .rejects.toThrow("EXIT:4");
    expect(exit).toHaveBeenCalledWith(4);
    expect(seams.merger).toHaveBeenCalledOnce();
  });

  it("records queued gate-2 time and omits it for immediate admission", async () => {
    const done = issue("1");
    seams.plan
      .mockResolvedValueOnce(resolution([done]))
      .mockResolvedValue(resolution([]));
    seams.innerLoop.mockResolvedValue({
      type: "DONE", commits: [{ sha: "abc" }], specGaps: [],
    });
    seams.merger.mockImplementation(async (
      batch: ReturnType<typeof issue>[],
      _adapter: unknown,
      _log: unknown,
      _gateLog: unknown,
      options: RunMergerOptions,
    ) => {
      await options.observations.onGate("1", {
        ok: true, durationMs: 7, queuedMs: 31, steps: [],
      });
      await options.observations.onGate("1", {
        ok: true, durationMs: 8, steps: [],
      });
      return summary(batch);
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, pollIntervalMs: 1 })).rejects.toThrow("EXIT:1");
    expect(eventsOf("gate")).toEqual([
      {
        kind: "gate", gate: "gate-2", issue: 1, title: "Issue 1",
        ok: true, durationMs: 7, queuedMs: 31, steps: {},
      },
      {
        kind: "gate", gate: "gate-2", issue: 1, title: "Issue 1",
        ok: true, durationMs: 8, steps: {},
      },
    ]);
    expect(eventsOf("gate")[1]).not.toHaveProperty("queuedMs");
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
      options: { providerState: { closeQuota(provider: "claude", measurement: object): void } },
    ) => {
      options.providerState.closeQuota("claude", {
        status: "rejected", window: "seven_day", resetsAt: 84,
      });
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

  it("exits credential from shared provider state when the closing issue returned no terminal", async () => {
    const detail = "Your access token could not be refreshed. Please log out and sign in again.";
    seams.plan.mockResolvedValue(resolution([issue("134")]));
    seams.innerLoop.mockImplementation(async (
      _candidate: ReturnType<typeof issue>,
      options: { providerState: { closeCredential(detail: string): void } },
    ) => {
      options.providerState.closeCredential(detail);
      throw new Error("sandbox died after the provider closed");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({
      ...config,
      maxParallelIssues: 1,
      implementerAgent: "codex",
      implementerModelId: "gpt-5.6-sol",
      env: { ...config.env, OPENAI_API_KEY: "openai" },
    })).rejects.toThrow("EXIT:4");
    expect(exit).toHaveBeenCalledWith(4);
    expect(seams.innerLoop).toHaveBeenCalledOnce();
    expect(eventsOf("exit")).toContainEqual(expect.objectContaining({
      tag: "credential",
      reason: `codex refused its credential: ${detail} Log in again on the host and restart.`,
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
