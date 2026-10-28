// The verifier's scenario runner (#238) against a fake issue sandbox: its
// report, the format nudge that resumes its own session, its failure classes,
// its write detection, and the evidence workspace on a real directory.
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  branchTip: vi.fn(async () => "head" as string | null),
  dirtyWorktreePaths: vi.fn(async () => [] as string[]),
  symbolicHeadRef: vi.fn(async () => "refs/heads/sandbar/issue-238" as string | null),
}));

vi.mock("./git-ops.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git-ops.js")>()),
  branchTip: mocks.branchTip,
  dirtyWorktreePaths: mocks.dirtyWorktreePaths,
  symbolicHeadRef: mocks.symbolicHeadRef,
}));

import {
  AgentCredentialError,
  AgentError,
  AgentInputTooLargeError,
  AgentQuotaError,
  type RunOptions,
} from "./agent-sandbox.js";
import { EgressProxyDiedError } from "./egress.js";
import type { EventInput } from "./events.js";
import { agentFailureResult, createRunProviderState } from "./inner-loop.js";
import { createAgentInvocationSequencer } from "./logs.js";
import type { Scenario } from "./scenario-parser.js";
import {
  type ScenarioRunnerDeps,
  archiveRun,
  clearRunDir,
  prepareVerifierWorkspace,
  restageFindings,
  runAppHook,
  runScenarioRunner,
  settleWithoutRunner,
} from "./verifier-run.js";

const scenario = (n: number): Scenario => ({
  id: `S${n}`,
  title: `title ${n}`,
  needs: ["ui"],
  area: ["src"],
  given: ["g"],
  when: ["w"],
  then: ["t"],
});

const ran = (stdout: string, sessionId: string | null = "session-1") => ({
  stdout,
  commits: [],
  durationMs: 7,
  silent: false,
  maxGapMs: 2,
  toolCalls: 3,
  endedBy: "exit" as const,
  ...(sessionId === null ? {} : { sessionId }),
});

const report = (block: string) =>
  `<scenario-runner>REPORTED</scenario-runner>\n<scenario-results>\n${block}\n</scenario-results>`;

type RunStep = (options: RunOptions) => Promise<ReturnType<typeof ran>>;

const harness = async (steps: readonly RunStep[], maxContextChars = 600_000) => {
  const workspace = await mkdtemp(join(tmpdir(), "sandbar-verifier-"));
  await mkdir(join(workspace, "run"));
  const queue = [...steps];
  const events: EventInput[] = [];
  const sandbox = {
    worktreePath: "/worktree",
    run: vi.fn(async (options: RunOptions) => {
      const next = queue.shift();
      if (next === undefined) throw new Error("unexpected run");
      return next(options);
    }),
    preserveWorktree: vi.fn(),
    syncBranchToCache: vi.fn(async () => undefined),
  };
  const deps = {
    issue: { id: "238", title: "Runner", branch: "sandbar/issue-238" },
    subject: { issue: 238, title: "Runner" },
    sandbox,
    config: {
      scenarioRunnerAgent: "claude",
      scenarioRunnerModelId: "opus",
      scenarioRunnerEffort: "high",
      maxContextChars,
    },
    invocationSequence: createAgentInvocationSequencer().startCycle(),
    attemptLogger: { writeInvocation: vi.fn(async () => undefined) },
    onEvent: (event: EventInput) => {
      events.push(event);
    },
    providerState: createRunProviderState(),
  } as unknown as ScenarioRunnerDeps;
  const run = (prepass = [] as const) => runScenarioRunner(deps, {
    attempt: 2,
    scenarios: [scenario(1), scenario(2)],
    prepass,
    workspace,
    prompt: "runner prompt",
  });
  const runnerEvents = () => events.filter((event) => event.kind === "scenario-runner");
  return { workspace, sandbox, deps, events, run, runnerEvents };
};

const routing = { provider: "claude", model: "opus", effort: "high" };

beforeEach(() => {
  mocks.branchTip.mockReset().mockResolvedValue("head");
  mocks.dirtyWorktreePaths.mockReset().mockResolvedValue([]);
  mocks.symbolicHeadRef.mockReset().mockResolvedValue("refs/heads/sandbar/issue-238");
});

describe("runScenarioRunner (#238)", () => {
  it("reports every scenario, the pre-pass's first, and records the evidence it saved", async () => {
    const h = await harness([async () => ran(report(
      "### S1: PASS\n### S2: FAIL\nObserved: empty\nEvidence: S2/rows.txt",
    ))]);
    await mkdir(join(h.workspace, "run", "S2"));
    await writeFile(join(h.workspace, "run", "S2", "rows.txt"), "0 rows\n");
    const prepass = [{ id: "S3", outcome: "unverified", reason: "no-db-copy" }] as const;
    await expect(h.run(prepass)).resolves.toEqual({
      kind: "reported",
      outcomes: [
        prepass[0],
        { id: "S1", outcome: "pass" },
        { id: "S2", outcome: "fail", observed: "empty", evidence: ["S2/rows.txt"] },
      ],
    });
    expect(h.runnerEvents()).toEqual([expect.objectContaining({
      kind: "scenario-runner", issue: 238, attempt: 2, round: 2, invocation: 1,
      ...routing, result: "completed", transcript: "attempt-2-scenario-runner-1.log",
      outcomes: [
        { id: "S3", outcome: "unverified", reason: "no-db-copy" },
        { id: "S1", outcome: "pass" },
        { id: "S2", outcome: "fail" },
      ],
      evidenceBytes: 7,
    })]);
    const options = h.sandbox.run.mock.calls[0]![0];
    expect(options.prompt).toBe("runner prompt");
    expect(options.completionSignal).toEqual([]);
    expect(options.agent.buildPrintCommand({ prompt: "p" }).command).not.toMatch(/--resume|--continue/);
  });

  it("nudges a malformed report by resuming its own session, then reads both answers", async () => {
    const h = await harness([
      async () => ran("### S1: PASS", "runner-session"),
      async () => ran(report("### S1: PASS\n### S2: UNVERIFIED\nReason: no browser")),
    ]);
    await expect(h.run()).resolves.toEqual({
      kind: "reported",
      outcomes: [
        { id: "S1", outcome: "pass" },
        { id: "S2", outcome: "unverified", reason: "runner", runnerReason: "no browser" },
      ],
    });
    const nudge = h.sandbox.run.mock.calls[1]![0];
    expect(nudge.prompt).toMatch(/End with exactly/);
    expect(nudge.name).toBe("scenario-runner-238-round-2-nudge");
    expect(nudge.agent.buildPrintCommand({ prompt: "p" }).command).toContain("--resume 'runner-session'");
    expect(h.runnerEvents().map((event) => [event.invocation, event.result, "outcomes" in event]))
      .toEqual([[1, "completed", false], [2, "completed", true]]);
  });

  it("downgrades what is still wrong after the nudge", async () => {
    const h = await harness([
      async () => ran(report("### S1: FAIL\nObserved: x\nEvidence: S1/gone.png")),
      async () => ran(report("### S1: FAIL\nObserved: x\nEvidence: S1/gone.png\n### S2: PASS")),
    ]);
    await expect(h.run()).resolves.toEqual({
      kind: "reported",
      outcomes: [
        { id: "S1", outcome: "unverified", reason: "fail-without-evidence" },
        { id: "S2", outcome: "pass" },
      ],
    });
  });

  it.each([
    ["no report after the nudge", [async () => ran("nothing"), async () => ran("still nothing")], 2],
    ["a run that named no session to resume", [async () => ran("nothing", null)], 1],
  ])("leaves every scenario unverified on %s", async (_name, steps, invocations) => {
    const h = await harness(steps as RunStep[]);
    await expect(h.run()).resolves.toEqual({
      kind: "failed",
      outcomes: [
        { id: "S1", outcome: "unverified", reason: "not-reported" },
        { id: "S2", outcome: "unverified", reason: "not-reported" },
      ],
    });
    expect(h.runnerEvents().at(-1)).toMatchObject({ invocation: invocations, result: "failed" });
  });

  it.each([
    ["a harness failure", new AgentError("idle"), "failed", "runner-failed"],
    ["a provider's size refusal", new AgentInputTooLargeError("too big"), "input-too-large", "input-too-large"],
  ] as const)("leaves every scenario unverified on %s", async (_name, error, result, reason) => {
    const h = await harness([async () => { throw error; }]);
    await expect(h.run()).resolves.toEqual({
      kind: "failed",
      outcomes: [
        { id: "S1", outcome: "unverified", reason },
        { id: "S2", outcome: "unverified", reason },
      ],
    });
    expect(h.runnerEvents()).toEqual([expect.objectContaining({ invocation: 1, ...routing, result })]);
  });

  it("runs nothing when its prompt is over budget", async () => {
    const h = await harness([], 5);
    await expect(h.run()).resolves.toMatchObject({
      kind: "failed",
      outcomes: [
        { id: "S1", outcome: "unverified", reason: "input-too-large" },
        { id: "S2", outcome: "unverified", reason: "input-too-large" },
      ],
    });
    expect(h.sandbox.run).not.toHaveBeenCalled();
    expect(h.runnerEvents()).toEqual([{
      kind: "scenario-runner", issue: 238, title: "Runner", attempt: 2, round: 2, invocation: 1,
      result: "input-too-large",
      outcomes: [
        { id: "S1", outcome: "unverified", reason: "input-too-large" },
        { id: "S2", outcome: "unverified", reason: "input-too-large" },
      ],
    }]);
  });

  it.each([
    ["a closed quota", new AgentQuotaError("claude", "5h", "rate limited")],
    ["a refused credential", new AgentCredentialError("expired")],
    ["a dead egress proxy", new EgressProxyDiedError("proxy exited")],
  ])("records and rethrows %s", async (_name, error) => {
    const h = await harness([async () => { throw error; }]);
    await expect(h.run()).rejects.toBe(error);
    expect(h.runnerEvents()).toEqual([expect.objectContaining({
      invocation: 1,
      result: agentFailureResult(error),
      usage: expect.objectContaining({ contextChars: "runner prompt".length }),
    })]);
  });

  it("parks a write, naming its transcript rather than quoting it", async () => {
    const h = await harness([async () => {
      mocks.dirtyWorktreePaths.mockResolvedValue([" M src/app.ts"]);
      return ran("SECRET scenario text");
    }]);
    const result = await h.run();
    expect(result.kind).toBe("wrote");
    if (result.kind !== "wrote") throw new Error("expected a write");
    expect(result.detail).toContain(" M src/app.ts");
    expect(result.detail).toContain("attempt-2-scenario-runner-1.log");
    expect(result.detail).not.toContain("SECRET");
    expect(h.sandbox.preserveWorktree).toHaveBeenCalledWith(
      expect.stringContaining("scenario runner changed the repository"),
    );
    expect(h.runnerEvents()).toEqual([expect.objectContaining({ invocation: 1, result: "wrote" })]);
  });
});

describe("a runner that wrote and then died (#238)", () => {
  it("parks rather than leaving its scenarios unverified", async () => {
    const h = await harness([async () => {
      mocks.dirtyWorktreePaths.mockResolvedValue([" M src/app.ts"]);
      throw new AgentError("idle");
    }]);
    await expect(h.run()).resolves.toMatchObject({ kind: "wrote" });
    expect(h.runnerEvents()).toEqual([expect.objectContaining({ invocation: 1, result: "wrote" })]);
  });
});

describe("settleWithoutRunner (#238)", () => {
  it("records a round the pre-pass settled as invocation 0, and nothing for an empty one", async () => {
    const h = await harness([]);
    const prepass = [{ id: "S1", outcome: "unverified", reason: "app-hook-failed" }] as const;
    await expect(settleWithoutRunner(h.deps, 2, prepass)).resolves.toEqual({ kind: "not-run", prepass });
    await expect(settleWithoutRunner(h.deps, 3, [])).resolves.toEqual({ kind: "not-run", prepass: [] });
    expect(h.runnerEvents()).toEqual([{
      kind: "scenario-runner", issue: 238, title: "Runner", attempt: 2, round: 2, invocation: 0,
      result: "completed", outcomes: [{ id: "S1", outcome: "unverified", reason: "app-hook-failed" }],
    }]);
  });
});

describe("the verifier workspace (#238)", () => {
  const tree = async (dir: string): Promise<string[]> =>
    (await readdir(dir, { recursive: true })).map(String).sort();

  it("archives a round and hands back only the failing scenarios' evidence", async () => {
    const base = await mkdtemp(join(tmpdir(), "sandbar-workspace-"));
    const workspace = join(base, "verifier-workspace");
    const roundDir = join(base, "logs", "verifier", "round-2");
    await prepareVerifierWorkspace(workspace);
    await mkdir(join(workspace, "findings", "S9"), { recursive: true });
    await clearRunDir(workspace);
    for (const id of ["S1", "S2"]) {
      await mkdir(join(workspace, "run", id));
      await writeFile(join(workspace, "run", id, "shot.png"), id);
    }
    await archiveRun(workspace, roundDir);
    await restageFindings(workspace, roundDir, ["S2"]);
    expect(await tree(workspace)).toEqual(["findings", join("findings", "S2"), join("findings", "S2", "shot.png")]);
    expect(await tree(roundDir)).toEqual(["S1", join("S1", "shot.png"), "S2", join("S2", "shot.png")]);
    // A later round's restage starts again from that round's archive.
    await restageFindings(workspace, roundDir, []);
    expect(await tree(workspace)).toEqual(["findings"]);
  });

  it("empties a workspace a previous sandbox left", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sandbar-workspace-"));
    await mkdir(join(workspace, "findings", "S1"), { recursive: true });
    await prepareVerifierWorkspace(workspace);
    expect(await readdir(workspace)).toEqual([]);
  });

  it("files the beforeScenarioRun hook's output in run/", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sandbar-workspace-"));
    await clearRunDir(workspace);
    const sandbox = { runHooks: vi.fn(async () => ({ ok: false, output: "build failed\n" })) };
    await expect(runAppHook(sandbox, [], workspace)).resolves.toBe("none");
    expect(sandbox.runHooks).not.toHaveBeenCalled();
    await expect(runAppHook(sandbox, [{ command: "prepare.sh scenario-run" }], workspace))
      .resolves.toBe("failed");
    expect(await readFile(join(workspace, "run", "before-scenario-run.log"), "utf8"))
      .toBe("[sandbar] beforeScenarioRun\nbuild failed\n\n");
  });
});
