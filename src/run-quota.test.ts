import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  innerLoop: vi.fn(),
  merger: vi.fn(),
  plan: vi.fn(),
  logLines: [] as string[],
}));

vi.mock("./driver-identity.js", () => ({
  readDriverIdentity: vi.fn(async () => ({ kind: "unknown" })),
  formatDriverIdentity: vi.fn(() => "driver: test"),
}));
vi.mock("./cleanup.js", () => ({
  installCleanupTraps: vi.fn(), onCleanup: vi.fn(), runCleanup: vi.fn(async () => undefined),
}));
vi.mock("./keepawake.js", () => ({
  startKeepawake: vi.fn(() => ({ stop: vi.fn(), onStatus: vi.fn() })),
}));
vi.mock("./lock.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lock.js")>(),
  lockPathsFor: vi.fn(() => ({ workDir: "/tmp", lockDir: "/tmp/lock", pidPath: "/tmp/pid" })),
  acquireLock: vi.fn(async () => vi.fn()),
}));
vi.mock("./logs.js", () => ({
  startRunLogger: vi.fn(async () => ({
    runDir: "/tmp/run-quota-test",
    appendOrchestrator: vi.fn(async (line: string) => { seams.logLines.push(line); }),
    finalize: vi.fn(),
    writePlan: vi.fn(),
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
vi.mock("./repo-cache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./repo-cache.js")>(),
  ensureRepoCache: vi.fn(), ensureSourceWorktree: vi.fn(async () => "/tmp/source"),
}));
vi.mock("./preflight.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./preflight.js")>(),
  runPreflight: vi.fn(), absoluteMountSources: vi.fn(() => []),
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
}));
vi.mock("./chunk-follow-up.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./chunk-follow-up.js")>(),
  realAdapter: vi.fn(() => ({})), routeChunkReviewFollowUps: vi.fn(async () => []),
}));
vi.mock("./chunk-reconcile.js", () => ({
  fetchLandRequestPullRequests: vi.fn(async () => []),
  reconcileLandedChunks: vi.fn(async () => ({ reconciled: [], failures: [] })),
}));
vi.mock("./lanes.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lanes.js")>(), postLaneOverrideNotices: vi.fn(),
}));
vi.mock("./inner-loop.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./inner-loop.js")>(), runInnerLoop: seams.innerLoop,
}));
vi.mock("./finalize.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./finalize.js")>(),
  realAdapter: vi.fn(() => ({})), finalizeAll: vi.fn(async () => []),
}));
vi.mock("./merger-worktree.js", () => ({
  createMergerWorktree: vi.fn(async () => ({ path: "/tmp/merger", remove: vi.fn() })),
}));
vi.mock("./gate-stack.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./gate-stack.js")>(),
  startStack: vi.fn(async () => ({ runGate: vi.fn(), stop: vi.fn() })),
}));
vi.mock("./prompt.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./prompt.js")>(), buildProjectAnchor: vi.fn(async () => "anchor"),
}));
vi.mock("./merger.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./merger.js")>(),
  realAdapter: vi.fn(() => ({})), runMergerWithAdapter: seams.merger,
}));

import type { RunConfig } from "./config.js";
import { AgentQuotaError } from "./agent-sandbox.js";
import { MergerError } from "./merger.js";
import { ensureImages } from "./ensure-images.js";
import { createAgentImages } from "./agent-tools.js";
import { run } from "./run.js";

const config: RunConfig = {
  ghOwner: "o", ghRepo: "r", cwd: "/tmp", workDir: "sandbar-run-quota-test",
  sandboxImage: "image", botName: "bot", botEmail: "bot@example.com",
  sandboxHooks: {}, env: { GH_TOKEN: "token" },
  gateStack: {
    containers: [{ name: "app", image: "image", mountWorktree: "/work", hold: true }],
    steps: [{ name: "test", in: "app", command: ["true"] }],
  },
};
const issue = (id: string) => ({
  id, title: `Issue ${id}`, branch: `sandbar/issue-${id}-test`, chunk: null,
});
const resolution = (plan: ReturnType<typeof issue>[]) => ({
  plan, heldForReview: [], overrides: [], landedChunks: [], chunkNameDrifts: [],
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

describe("run quota orchestration (#109)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    seams.innerLoop.mockReset(); seams.merger.mockReset(); seams.plan.mockReset();
    seams.logLines.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("drives issue quota through run(), exits 4, and outranks landed-work relaunch", async () => {
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
    expect(seams.logLines).toContain(
      "exit: quota — claude five_hour quota window closed; resets at 1970-01-01T00:00:42.000Z",
    );
  });

  it("relaunches only at post-landing quiescence before starting successors", async () => {
    const done = issue("1");
    const successor = issue("2");
    seams.plan
      .mockResolvedValueOnce(resolution([done]))
      .mockResolvedValueOnce(resolution([]))
      .mockResolvedValueOnce(resolution([successor]));
    seams.innerLoop.mockResolvedValue({ type: "DONE", commits: [{ sha: "abc" }] });
    seams.merger.mockResolvedValue(summary([done]));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run(config)).rejects.toThrow("EXIT:75");
    expect(exit).toHaveBeenCalledWith(75);
    expect(seams.innerLoop).toHaveBeenCalledOnce();
    expect(seams.innerLoop.mock.calls[0]?.[0].id).toBe("1");
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
    expect(seams.logLines).toContain(
      "exit: quota — codex seven_day quota window closed; resets at 1970-01-01T00:01:24.000Z",
    );
    expect(seams.logLines.some((line) => line.startsWith("exit: halted"))).toBe(false);
  });

  it("refills a freed slot before landing while a sibling remains active", async () => {
    const issues = [issue("1"), issue("2"), issue("3")];
    const slow = deferred<{ type: "DONE"; commits: { sha: string }[] }>();
    seams.plan.mockImplementation(async (_repo, options: { excluded?: Set<number> }) =>
      resolution(issues.filter((candidate) => !options.excluded?.has(Number(candidate.id)))));
    seams.innerLoop.mockImplementation((candidate: ReturnType<typeof issue>) =>
      candidate.id === "1"
        ? slow.promise
        : Promise.resolve({ type: "DONE", commits: [{ sha: candidate.id }] }));
    seams.merger.mockImplementation(async (batch: ReturnType<typeof issue>[]) => {
      if (seams.merger.mock.calls.length === 1) {
        expect(seams.innerLoop.mock.calls.map((call) => call[0].id)).toEqual(["1", "2", "3"]);
        slow.resolve({ type: "DONE", commits: [{ sha: "1" }] });
      }
      return summary(batch);
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(run({ ...config, maxParallelIssues: 2 })).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
    expect(seams.merger.mock.calls[0]?.[0].map((candidate: ReturnType<typeof issue>) => candidate.id))
      .toEqual(["2"]);
    expect(seams.merger.mock.calls[1]?.[0].map((candidate: ReturnType<typeof issue>) => candidate.id))
      .toEqual(["1", "3"]);
  });

  it("continues after a rejected member and admits its successor", async () => {
    const issues = [issue("1"), issue("2")];
    seams.plan.mockImplementation(async (_repo, options: { excluded?: Set<number> }) =>
      resolution(issues.filter((candidate) => !options.excluded?.has(Number(candidate.id)))));
    seams.innerLoop.mockImplementation((candidate: ReturnType<typeof issue>) =>
      candidate.id === "1"
        ? Promise.reject(new Error("member rejected"))
        : Promise.resolve({ type: "NEEDS-INFO", questions: "answer", strandedHead: null }));

    await expect(run({ ...config, maxParallelIssues: 1 })).resolves.toBeUndefined();
    expect(seams.innerLoop.mock.calls.map((call) => call[0].id)).toEqual(["1", "2"]);
  });

  it("exits stuck after the global terminal-without-landing backstop", async () => {
    const issues = Array.from({ length: 6 }, (_, index) => issue(String(index + 1)));
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
    expect(seams.innerLoop).toHaveBeenCalledTimes(6);
    expect(seams.merger).not.toHaveBeenCalled();
  });
});
