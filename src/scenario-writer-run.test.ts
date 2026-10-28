// The scenario writer's task (#203) against a fake seed snapshot sandbox: its
// format nudge, its failure classes, its write detection, its abort and the
// one file it writes.
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSeedSnapshotSandbox: vi.fn(),
  buildScenarioWriterPrompt: vi.fn(async () => "scenario writer prompt"),
}));

vi.mock("./agent-sandbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-sandbox.js")>()),
  createSeedSnapshotSandbox: mocks.createSeedSnapshotSandbox,
}));

vi.mock("./prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prompt.js")>()),
  buildScenarioWriterPrompt: mocks.buildScenarioWriterPrompt,
}));

import { AgentError, AgentQuotaError, type RunOptions } from "./agent-sandbox.js";
import type { EventInput } from "./events.js";
import { SandbarError } from "./errors.js";
import { ContainerBringupError } from "./gate-stack.js";
import { createRunProviderState } from "./inner-loop.js";
import { createAgentInvocationSequencer, createTranscriptTree } from "./logs.js";
import { createScenarioWriterTask, type ScenarioWriterDeps } from "./scenario-writer-run.js";

const SCENARIO = [
  "### S1: Totals survive payment",
  "needs: ui",
  "area: app/Invoices",
  "Given a paid invoice",
  "When the user opens it",
  "Then the total is unchanged",
].join("\n");
const WRITTEN = `<scenario-writer>WRITTEN</scenario-writer>\n<scenarios>\n${SCENARIO}\n</scenarios>`;

const ran = (stdout: string) => ({
  stdout,
  durationMs: 7,
  silent: false,
  maxGapMs: 2,
  toolCalls: 3,
  endedBy: "exit" as const,
});

type RunStep = (options: RunOptions) => Promise<ReturnType<typeof ran>>;

const fakeSandbox = (steps: readonly RunStep[], changed: () => Promise<string | null> = async () => null) => {
  const queue = [...steps];
  return {
    worktreePath: "/work/snapshots/issue-203-seed",
    containerName: "w-snapshot",
    run: vi.fn(async (options: RunOptions) => {
      const next = queue.shift();
      if (next === undefined) throw new Error("unexpected run");
      return next(options);
    }),
    changed: vi.fn(changed),
    close: vi.fn(async (_o?: { readonly preserve?: string }) => undefined),
  };
};

const input = { imageName: "sandbox-image", seedRef: "origin/main", seedSha: "fork-sha" };

const harness = (overrides: Partial<ScenarioWriterDeps["config"]> = {}) => {
  const events: EventInput[] = [];
  const writeScenarios = vi.fn(async () => "/logs/issue-203/scenarios-1.json");
  const writeInvocation = vi.fn(async () => undefined);
  const providerState = createRunProviderState();
  const deps = {
    issue: { id: "203", title: "Scenario writer" },
    config: {
      layout: { repoDir: "/repo", snapshotsDir: "/work/snapshots", anchorCacheDir: "/cache" },
      issueSource: async () => ({ title: "t", body: "" }),
      repo: { owner: "o", name: "r" },
      env: {},
      scope: "w12345678",
      maxContextChars: 600_000,
      promptExtensions: {},
      scenarioWriterAgent: "claude",
      scenarioWriterModelId: "opus",
      scenarioWriterEffort: "high",
      ...overrides,
    },
    attemptLogger: {
      startInvocationCycle: createAgentInvocationSequencer().startCycle,
      writeInvocation,
      writeGate: vi.fn(),
      writeIssueSnapshot: vi.fn(),
      writeScenarios,
    },
    onEvent: (event: EventInput) => {
      events.push(event);
    },
    providerState,
  } as unknown as ScenarioWriterDeps;
  return { deps, events, writeScenarios, writeInvocation, providerState };
};

const writerEvents = (events: readonly EventInput[]) =>
  events.filter((event) => event.kind === "scenario-writer");

beforeEach(() => {
  mocks.createSeedSnapshotSandbox.mockReset();
  mocks.buildScenarioWriterPrompt.mockReset().mockResolvedValue("scenario writer prompt");
});

describe("createScenarioWriterTask (#203)", () => {
  it("is pending until started, starts once, and settles a written set", async () => {
    const sandbox = fakeSandbox([async () => ran(WRITTEN)]);
    mocks.createSeedSnapshotSandbox.mockResolvedValue(sandbox);
    const { deps, events, writeScenarios } = harness();
    const task = createScenarioWriterTask(deps);
    expect(task.status()).toEqual({ kind: "pending" });
    task.start(input);
    task.start(input);
    expect(task.status()).toEqual({ kind: "running" });

    const outcome = await task.settled();
    expect(outcome).toMatchObject({
      kind: "written",
      set: {
        version: 1,
        issue: 203,
        seed: { ref: "origin/main", sha: "fork-sha" },
        writer: { provider: "claude", model: "opus", effort: "high" },
        scenarios: [{ id: "S1", needs: ["ui"], area: ["app/Invoices"] }],
      },
    });
    expect(task.status()).toEqual({ kind: "settled", outcome });
    expect(mocks.createSeedSnapshotSandbox).toHaveBeenCalledTimes(1);
    expect(mocks.createSeedSnapshotSandbox).toHaveBeenCalledWith(expect.objectContaining({
      issueId: "203",
      seedSha: "fork-sha",
      extraMounts: [],
    }));
    expect(mocks.buildScenarioWriterPrompt).toHaveBeenCalledWith(
      "203",
      { issueSource: deps.config.issueSource, repo: deps.config.repo, anchorCacheDir: "/cache" },
      sandbox.worktreePath,
      undefined,
    );
    expect(writeScenarios).toHaveBeenCalledTimes(1);
    expect(writeScenarios).toHaveBeenCalledWith(
      outcome.kind === "written" ? outcome.set : null,
    );
    expect(writerEvents(events)).toEqual([{
      kind: "scenario-writer",
      issue: 203,
      title: "Scenario writer",
      invocation: 1,
      provider: "claude",
      model: "opus",
      effort: "high",
      result: "completed",
      scenarios: 1,
      durationMs: 7,
      endedBy: "exit",
      maxGapMs: 2,
      transcript: "scenario-writer-1.log",
      usage: { toolCalls: 3 },
    }]);
    expect(sandbox.close).toHaveBeenCalledWith({});
    // Already settled: aborting changes and records nothing.
    await task.abort();
    expect(writerEvents(events)).toHaveLength(1);
  });

  it("refuses a join before the start", async () => {
    const { deps } = harness();
    await expect(createScenarioWriterTask(deps).settled()).rejects.toThrow(/before it started/);
  });

  it("records NONE as completed with zero scenarios and writes no file", async () => {
    mocks.createSeedSnapshotSandbox.mockResolvedValue(fakeSandbox([async () => ran(
      "<scenario-writer>NONE</scenario-writer>\n<scenario-none-reason>Docs only.</scenario-none-reason>",
    )]));
    const { deps, events, writeScenarios } = harness();
    const task = createScenarioWriterTask(deps);
    task.start(input);
    await expect(task.settled()).resolves.toEqual({ kind: "none", reason: "Docs only." });
    expect(writeScenarios).not.toHaveBeenCalled();
    expect(writerEvents(events)).toMatchObject([{ result: "completed", scenarios: 0 }]);
  });

  it("nudges once in the same session with the parser's correction, then settles failed", async () => {
    const sandbox = fakeSandbox([async () => ran("Here are my thoughts."), async () => ran("Still thinking.")]);
    mocks.createSeedSnapshotSandbox.mockResolvedValue(sandbox);
    const { deps, events } = harness();
    const task = createScenarioWriterTask(deps);
    task.start(input);
    const outcome = await task.settled();
    expect(outcome).toMatchObject({ kind: "failed", detail: expect.stringContaining("after the format nudge") });
    expect(sandbox.run).toHaveBeenCalledTimes(2);
    const nudge = sandbox.run.mock.calls[1]![0];
    expect(nudge.name).toBe("scenario-writer-203-nudge");
    expect(nudge.prompt).toContain("<scenario-writer>WRITTEN</scenario-writer>");
    expect(nudge.agent.buildPrintCommand({ prompt: "p" }).command).toContain("--continue");
    expect(sandbox.run.mock.calls[0]![0].agent.buildPrintCommand({ prompt: "p" }).command)
      .not.toContain("--continue");
    expect(writerEvents(events).map((event) => [event.invocation, event.result, event.transcript]))
      .toEqual([[1, "completed", "scenario-writer-1.log"], [2, "failed", "scenario-writer-2.log"]]);
    expect(writerEvents(events)[0]).not.toHaveProperty("scenarios");
    expect(task.status()).toEqual({ kind: "settled", outcome });
  });

  it("reads a nudged answer over both runs, so a bare token completes the first run's block", async () => {
    mocks.createSeedSnapshotSandbox.mockResolvedValue(fakeSandbox([
      async () => ran(`<scenarios>\n${SCENARIO}\n</scenarios>`),
      async () => ran("<scenario-writer>WRITTEN</scenario-writer>"),
    ]));
    const { deps, events } = harness();
    const task = createScenarioWriterTask(deps);
    task.start(input);
    await expect(task.settled()).resolves.toMatchObject({ kind: "written" });
    expect(writerEvents(events).map((event) => event.scenarios)).toEqual([undefined, 1]);
  });

  it("settles failed on a closed quota and records the closure for the run", async () => {
    const measurement = { status: "rejected", window: "five_hour", resetsAt: 1_700_000_000 } as const;
    mocks.createSeedSnapshotSandbox.mockResolvedValue(fakeSandbox([async () => {
      throw new AgentQuotaError("claude", measurement);
    }]));
    const { deps, events, providerState } = harness();
    const task = createScenarioWriterTask(deps);
    task.start(input);
    await expect(task.settled()).resolves.toMatchObject({ kind: "failed" });
    expect(providerState.get("claude")).toEqual({ cause: "quota", measurement });
    expect(writerEvents(events)).toMatchObject([{ invocation: 1, result: "quota", transcript: "scenario-writer-1.log" }]);
  });

  it("records a harness failure and settles failed", async () => {
    mocks.createSeedSnapshotSandbox.mockResolvedValue(fakeSandbox([async () => {
      throw new AgentError("Agent idle for 600 seconds");
    }]));
    const { deps, events } = harness();
    const task = createScenarioWriterTask(deps);
    task.start(input);
    await expect(task.settled()).resolves.toEqual({ kind: "failed", detail: "Agent idle for 600 seconds" });
    expect(writerEvents(events)).toMatchObject([{ result: "failed" }]);
  });

  it("refuses a prompt over the context budget without running", async () => {
    const sandbox = fakeSandbox([]);
    mocks.createSeedSnapshotSandbox.mockResolvedValue(sandbox);
    const { deps, events } = harness({ maxContextChars: 10 });
    const task = createScenarioWriterTask(deps);
    task.start(input);
    await expect(task.settled()).resolves.toMatchObject({ kind: "failed" });
    expect(sandbox.run).not.toHaveBeenCalled();
    expect(sandbox.close).toHaveBeenCalled();
    const [event] = writerEvents(events);
    expect(event).toMatchObject({ invocation: 1, result: "input-too-large" });
    expect(event).not.toHaveProperty("durationMs");
  });

  it("settles failed when its sandbox does not come up", async () => {
    mocks.createSeedSnapshotSandbox.mockRejectedValue(new Error("podman run failed: no space"));
    const { deps, events } = harness();
    const task = createScenarioWriterTask(deps);
    task.start(input);
    await expect(task.settled()).resolves.toEqual({
      kind: "failed",
      detail: "the writer's sandbox did not come up: podman run failed: no space",
    });
    expect(writerEvents(events)).toMatchObject([{ result: "failed" }]);
  });

  it("settles wrote when the snapshot changed, keeps the snapshot, and stays running for the join", async () => {
    const sandbox = fakeSandbox([async () => ran(WRITTEN)], async () => "HEAD moved from a to b");
    mocks.createSeedSnapshotSandbox.mockResolvedValue(sandbox);
    const { deps, events, writeScenarios } = harness();
    const task = createScenarioWriterTask(deps);
    task.start(input);
    const outcome = await task.settled();
    expect(outcome).toEqual({
      kind: "wrote",
      detail: `Scenario writer changed its seed snapshot at ${sandbox.worktreePath}:\nHEAD moved from a to b`,
    });
    expect(writeScenarios).not.toHaveBeenCalled();
    expect(sandbox.close).toHaveBeenCalledWith({ preserve: expect.stringContaining("kept for human inspection") });
    expect(task.status()).toEqual({ kind: "running" });
    expect(writerEvents(events)).toMatchObject([{ result: "wrote" }]);
  });

  it("aborts a running writer by closing its container, and records the invocation aborted", async () => {
    let killed: () => void = () => undefined;
    const sandbox = fakeSandbox([() => new Promise((_resolve, reject) => {
      killed = () => reject(new AgentError("exec ended"));
    })]);
    sandbox.close.mockImplementation(async () => killed());
    mocks.createSeedSnapshotSandbox.mockResolvedValue(sandbox);
    const { deps, events } = harness();
    const task = createScenarioWriterTask(deps);
    task.start(input);
    await vi.waitFor(() => expect(sandbox.run).toHaveBeenCalled());
    await task.abort();
    expect(sandbox.close).toHaveBeenCalled();
    expect(sandbox.changed).not.toHaveBeenCalled();
    expect(writerEvents(events)).toMatchObject([{ invocation: 1, result: "aborted" }]);
    await expect(task.settled()).resolves.toMatchObject({ kind: "failed" });
  });

  it("holds sandbar's own error for the join, which rethrows it, and closes the sandbox", async () => {
    const sandbox = fakeSandbox([async () => {
      throw new SandbarError("inconsistent");
    }]);
    mocks.createSeedSnapshotSandbox.mockResolvedValue(sandbox);
    const { deps, events } = harness();
    const task = createScenarioWriterTask(deps);
    task.start(input);
    await expect(task.settled()).rejects.toThrow("inconsistent");
    expect(task.status()).toEqual({ kind: "running" });
    expect(writerEvents(events)).toEqual([]);
    expect(sandbox.close).toHaveBeenCalledWith({});
    await expect(task.abort()).resolves.toBeUndefined();
  });

  it("passes the codex auth mount and the prompt extension through", async () => {
    mocks.createSeedSnapshotSandbox.mockResolvedValue(fakeSandbox([async () => ran(WRITTEN)]));
    const extension = { text: "x" };
    const { deps } = harness({
      codexAuthMount: { hostPath: "/host/codex", sandboxPath: "/sandbox/codex" },
      promptExtensions: { scenarioWriter: extension },
    } as Partial<ScenarioWriterDeps["config"]>);
    const task = createScenarioWriterTask(deps);
    task.start(input);
    await task.settled();
    expect(mocks.createSeedSnapshotSandbox).toHaveBeenCalledWith(expect.objectContaining({
      extraMounts: [{ hostPath: "/host/codex", sandboxPath: "/sandbox/codex" }],
    }));
    expect(mocks.buildScenarioWriterPrompt).toHaveBeenCalledWith(
      "203",
      expect.anything(),
      "/work/snapshots/issue-203-seed",
      extension,
    );
  });

  // A stored host error would be rethrown at the join of every HARD-ERROR
  // retry, turning a green issue into HARD-ERROR.
  it("settles a run's podman failure failed, recorded with its transcript, so no join rethrows it", async () => {
    const sandbox = fakeSandbox([async () => {
      throw new Error("podman exec failed: container state improper");
    }]);
    mocks.createSeedSnapshotSandbox.mockResolvedValue(sandbox);
    const { deps, events } = harness();
    const task = createScenarioWriterTask(deps);
    task.start(input);
    const outcome = { kind: "failed", detail: "podman exec failed: container state improper" };
    await expect(task.settled()).resolves.toEqual(outcome);
    expect(task.status()).toEqual({ kind: "settled", outcome });
    expect(writerEvents(events)).toMatchObject([
      { invocation: 1, result: "failed", transcript: expect.stringContaining("scenario-writer-1") },
    ]);
    expect(sandbox.close).toHaveBeenCalledWith({});
  });

  type Harness = ReturnType<typeof harness>;
  const hostDown = () => {
    throw new Error("gh: HTTP 502");
  };
  it.each<[string, number, () => ReturnType<typeof fakeSandbox>, (h: Harness) => void]>([
    ["the prompt's issue anchor", 1, () => {
      mocks.buildScenarioWriterPrompt.mockImplementation(async () => hostDown());
      return fakeSandbox([]);
    }, () => undefined],
    ["the first run's write check", 1, () => fakeSandbox([async () => ran(WRITTEN)], async () => hostDown()), () => undefined],
    ["the nudge's write check", 2, () => {
      let checks = 0;
      return fakeSandbox(
        [async () => ran("Here are my thoughts."), async () => ran(WRITTEN)],
        async () => ((checks += 1) === 2 ? hostDown() : null),
      );
    }, () => undefined],
    ["filing the set", 1, () => fakeSandbox([async () => ran(WRITTEN)]), (h) => {
      h.writeScenarios.mockImplementation(async () => hostDown());
    }],
  ])("settles failed when %s fails on the host, recorded against invocation %i", async (
    _step,
    invocation,
    sandboxOf,
    arrange,
  ) => {
    const sandbox = sandboxOf();
    mocks.createSeedSnapshotSandbox.mockResolvedValue(sandbox);
    const h = harness();
    arrange(h);
    const task = createScenarioWriterTask(h.deps);
    task.start(input);
    await expect(task.settled()).resolves.toEqual({ kind: "failed", detail: "gh: HTTP 502" });
    expect(task.status()).toMatchObject({ kind: "settled" });
    const recorded = writerEvents(h.events);
    expect(recorded.map((event) => event.invocation)).toEqual(
      Array.from({ length: invocation }, (_, k) => k + 1),
    );
    expect(recorded.at(-1)).toMatchObject({ invocation, result: "failed" });
    expect(sandbox.close).toHaveBeenCalledWith({});
  });

  it("records the invocation aborted when the abort's close breaks a host step", async () => {
    const sandbox = fakeSandbox([async () => ran(WRITTEN)]);
    const { deps, events } = harness();
    const task = createScenarioWriterTask(deps);
    sandbox.changed.mockImplementation(async () => {
      void task.abort();
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error("not a git repository");
    });
    mocks.createSeedSnapshotSandbox.mockResolvedValue(sandbox);
    task.start(input);
    await expect(task.settled()).resolves.toMatchObject({ kind: "failed", detail: expect.stringContaining("aborted") });
    expect(writerEvents(events)).toMatchObject([{ invocation: 1, result: "aborted" }]);
  });

  it("settles wrote when the run threw a harness error after changing the snapshot", async () => {
    const sandbox = fakeSandbox(
      [async () => {
        throw new AgentError("Agent idle for 600 seconds");
      }],
      async () => "HEAD moved from a to b",
    );
    mocks.createSeedSnapshotSandbox.mockResolvedValue(sandbox);
    const { deps, events } = harness();
    const task = createScenarioWriterTask(deps);
    task.start(input);
    await expect(task.settled()).resolves.toMatchObject({ kind: "wrote" });
    expect(writerEvents(events)).toMatchObject([{ result: "wrote" }]);
    expect(sandbox.close).toHaveBeenCalledWith({ preserve: expect.stringContaining("kept for human inspection") });
  });

  it("rethrows a SandbarError from the sandbox bring-up but settles a ContainerBringupError failed", async () => {
    mocks.createSeedSnapshotSandbox.mockRejectedValueOnce(new SandbarError("inconsistent"));
    const a = createScenarioWriterTask(harness().deps);
    a.start(input);
    await expect(a.settled()).rejects.toThrow("inconsistent");

    mocks.createSeedSnapshotSandbox.mockRejectedValueOnce(
      new ContainerBringupError("w-snapshot", "failed to start", "tail"),
    );
    const second = harness();
    const b = createScenarioWriterTask(second.deps);
    b.start(input);
    await expect(b.settled()).resolves.toMatchObject({
      kind: "failed",
      detail: expect.stringContaining("the writer's sandbox did not come up"),
    });
    expect(writerEvents(second.events)).toMatchObject([{ result: "failed" }]);
  });

  it("records the nudge aborted when the abort lands between the runs", async () => {
    const sandbox = fakeSandbox([async () => ran("Here are my thoughts."), async () => ran(WRITTEN)]);
    const { deps, events } = harness();
    const task = createScenarioWriterTask(deps);
    // The first run's write check is the point between the runs.
    sandbox.changed.mockImplementation(async () => {
      void task.abort();
      await new Promise((resolve) => setImmediate(resolve));
      return null;
    });
    mocks.createSeedSnapshotSandbox.mockResolvedValue(sandbox);
    task.start(input);
    await expect(task.settled()).resolves.toMatchObject({ kind: "failed" });
    expect(sandbox.run).toHaveBeenCalledTimes(1);
    expect(writerEvents(events).map((event) => [event.invocation, event.result]))
      .toEqual([[1, "completed"], [2, "aborted"]]);
  });

  it("reports a failed sandbox close as a complaint and keeps the outcome", async () => {
    const sandbox = fakeSandbox([async () => ran(WRITTEN)]);
    sandbox.close.mockRejectedValue(new Error("podman rm failed"));
    mocks.createSeedSnapshotSandbox.mockResolvedValue(sandbox);
    const { deps, events } = harness();
    const task = createScenarioWriterTask(deps);
    task.start(input);
    await expect(task.settled()).resolves.toMatchObject({ kind: "written" });
    expect(events.filter((event) => event.kind === "complaint")).toEqual([{
      kind: "complaint",
      severity: "error",
      message: "Failed to close the scenario writer's sandbox: podman rm failed",
    }]);
  });

  it("files the set once, as scenarios-1.json beside its invocation log", async () => {
    mocks.createSeedSnapshotSandbox.mockResolvedValue(fakeSandbox([async () => ran(WRITTEN)]));
    const runDir = await mkdtemp(join(tmpdir(), "scenario-writer-run-"));
    const logger = await (await createTranscriptTree(runDir)).issue("203");
    const { deps } = harness();
    const task = createScenarioWriterTask({ ...deps, attemptLogger: logger });
    task.start(input);
    const outcome = await task.settled();
    expect(await readdir(logger.dir)).toEqual(["scenarios-1.json"]);
    expect(JSON.parse(await readFile(join(logger.dir, "scenarios-1.json"), "utf8")))
      .toEqual(outcome.kind === "written" ? outcome.set : null);
  });
});
