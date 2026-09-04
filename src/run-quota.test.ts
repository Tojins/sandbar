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
    cycle: vi.fn(() => ({
      cycleDir: "/tmp/run-quota-test/cycle-1",
      writePlan: vi.fn(), appendMerger: vi.fn(), writeMergerGate: vi.fn(),
      writeAttempt: vi.fn(), writeResolveAttempt: vi.fn(),
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
  createAgentImages: vi.fn(async () => ({
    declaredTag: "image", augment: vi.fn(async () => "image"), builtTags: () => [],
  })),
  createBranchImages: vi.fn(() => ({ resolve: vi.fn(async () => new Map()), builtTags: () => [] })),
  checkWorktreeImageUids: vi.fn(), sweepBranchImages: vi.fn(async () => ({ removed: [], failures: [] })),
  removeBranchImages: vi.fn(async () => []), pulledImagesOf: vi.fn(() => []),
  worktreeMountingTagsOf: vi.fn(() => new Set()), formatImageRecord: vi.fn(() => "image"),
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
import { run } from "./run.js";

const config: RunConfig = {
  ghOwner: "o", ghRepo: "r", cwd: "/tmp", workDir: "sandbar-run-quota-test",
  sandboxImage: "image", botName: "bot", botEmail: "bot@example.com",
  sandboxHooks: {}, env: { GH_TOKEN: "token" }, relaunchAfterLanding: true,
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

describe("run quota orchestration (#109)", () => {
  beforeEach(() => {
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
    expect(seams.logLines).toContain(
      "exit: quota — claude five_hour quota window closed; resets at 1970-01-01T00:00:42.000Z",
    );
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
});
