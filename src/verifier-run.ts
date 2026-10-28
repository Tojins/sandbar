// The verifier's scenario runner (#180, #238) — I/O around one cold,
// read-only role per verifier round, and the workspace its evidence lives in.
// What the round's results mean is verifier.ts's; `runVerifier`
// (inner-loop.ts) runs this beside the white-box review and joins both.
//
// The runner runs in the ISSUE SANDBOX, beside the white-box review, against
// the app, the siblings and the database copy that sandbox already has. It is
// handed the project anchor, the scenarios it is to run and what the sandbox
// offers this round, never the issue or the diff. One invocation, then at
// most one format nudge carrying the parser's correction, which resumes the
// runner's own session by id: `--continue` would pick the white-box review's
// if it ended later. The two outputs are parsed together, the second time
// `finalize`d. Every scenario the runner was given is still reported: a
// prompt over `maxContextChars` (`input-too-large`, no run), a provider's
// size refusal, a harness failure (`runner-failed`) or no valid report after
// the nudge (`not-reported`) makes them all UNVERIFIED, and the round goes on
// on the white-box review. A quota or credential closure is recorded and
// rethrown, as is a dead egress proxy: they stop the issue's other roles too.
// A change to the worktree's HEAD, branch tip or status after an invocation
// is a write: recorded `wrote`, and its detail names the transcript rather
// than quoting it, so it is safe to publish. Each invocation is one
// `scenario-runner` event and one `attempt-<n>-scenario-runner-<k>.log`; a
// round whose scenarios the pre-pass settled is one event with invocation 0.
//
// THE WORKSPACE. `<logs>/issue-<id>/verifier-workspace` is created empty with
// the sandbox and mounted read-write at `/sandbar/verifier`. Before a round
// runs scenarios the host empties `run/`, where the `beforeScenarioRun` hook's
// output and the runner's evidence go. After the round it moves `run/` to the
// round's directory in the run's issue log tree and restages `findings/` with
// copies of the FAILING scenarios' directories only, again before any
// adjudicator: passing evidence never returns to the sandbox, so the passing
// scenarios stay a holdout from the implementer. The agent runs as the host
// user (keep-id), so the host can move and remove what it wrote. A failure to
// archive or restage propagates: a half-staged holdout must not be handed on.

import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { buildAgentProvider } from "./agent-providers.js";
import {
  AgentCredentialError,
  AgentInputTooLargeError,
  AgentQuotaError,
  type Sandbox,
  type SandboxHook,
  agentPartialContainerResources,
  agentPartialDurationMs,
  agentPartialUsage,
} from "./agent-sandbox.js";
import { usageFields } from "./agent-usage.js";
import { containerResourcesOf } from "./container-resources.js";
import { EgressProxyDiedError } from "./egress.js";
import type { EventInput, EventSubject, ScenarioOutcomeRecord } from "./events.js";
import {
  type InnerLoopConfig,
  type InnerLoopOptions,
  type IssueRef,
  agentFailureResult,
  enforceReadOnlyAgentSnapshot,
  runWithProviderState,
  snapshotReadOnlyAgent,
} from "./inner-loop.js";
import type { AgentInvocationSequence } from "./logs.js";
import type { Scenario } from "./scenario-parser.js";
import { parseScenarioRunner } from "./scenario-runner-parser.js";
import { startTimer } from "./timing.js";
import {
  APP_HOOK_LOG,
  type RunnerResult,
  type ScenarioRoundOutcome,
  type UnverifiedReason,
  withheldTranscript,
} from "./verifier.js";

export type ScenarioRunnerDeps = {
  readonly issue: Pick<IssueRef, "id" | "title" | "branch">;
  readonly subject: EventSubject;
  readonly sandbox: Pick<Sandbox, "run" | "worktreePath" | "preserveWorktree" | "syncBranchToCache">;
  readonly config: Pick<
    InnerLoopConfig,
    "scenarioRunnerAgent" | "scenarioRunnerModelId" | "scenarioRunnerEffort" | "maxContextChars"
  >;
  readonly invocationSequence: AgentInvocationSequence;
} & Pick<InnerLoopOptions, "attemptLogger" | "onEvent" | "providerState">;

type Fields = Pick<
  Extract<EventInput, { kind: "scenario-runner" }>,
  | "provider" | "model" | "effort" | "durationMs" | "endedBy" | "transcript" | "maxGapMs"
  | "usage" | "outcomes" | "evidenceBytes"
> & ReturnType<typeof agentPartialContainerResources>;

const recordOf = (outcome: ScenarioRoundOutcome): ScenarioOutcomeRecord =>
  outcome.outcome === "unverified"
    ? { id: outcome.id, outcome: outcome.outcome, reason: outcome.reason }
    : { id: outcome.id, outcome: outcome.outcome };

async function record(
  deps: ScenarioRunnerDeps,
  attempt: number,
  invocation: number,
  result: Extract<EventInput, { kind: "scenario-runner" }>["result"],
  fields: Fields,
): Promise<void> {
  await deps.onEvent({
    kind: "scenario-runner",
    ...deps.subject,
    attempt,
    round: attempt,
    invocation,
    result,
    ...fields,
  });
}

// A round whose every selected scenario the pre-pass settled, or that
// selected none: no runner, and one event when there was anything to settle.
export async function settleWithoutRunner(
  deps: ScenarioRunnerDeps,
  attempt: number,
  prepass: readonly ScenarioRoundOutcome[],
): Promise<RunnerResult> {
  if (prepass.length > 0) {
    await record(deps, attempt, 0, "completed", { outcomes: prepass.map(recordOf) });
  }
  return { kind: "not-run", prepass };
}

// One round's runner: `scenarios` is what the pre-pass left, never empty,
// `prompt` its rendered prompt, and `workspace` the workspace's host path.
export async function runScenarioRunner(
  deps: ScenarioRunnerDeps,
  input: {
    readonly attempt: number;
    readonly scenarios: readonly Scenario[];
    readonly prepass: readonly ScenarioRoundOutcome[];
    readonly workspace: string;
    readonly prompt: string;
  },
): Promise<RunnerResult> {
  const { issue, sandbox, config, attemptLogger, providerState } = deps;
  const { attempt, prepass } = input;
  const agent = config.scenarioRunnerAgent;
  const model = config.scenarioRunnerModelId;
  const effort = config.scenarioRunnerEffort;
  const routing = { provider: agent, model, effort: effort ?? null };
  const ids = input.scenarios.map((scenario) => scenario.id);
  const unverified = (reason: Exclude<UnverifiedReason, "runner">): ScenarioRoundOutcome[] => [
    ...prepass,
    ...ids.map((id) => ({ id, outcome: "unverified", reason }) as const),
  ];
  const failed = async (
    invocation: number,
    result: "failed" | "input-too-large",
    reason: Exclude<UnverifiedReason, "runner">,
    fields: Fields,
  ): Promise<RunnerResult> => {
    const outcomes = unverified(reason);
    await record(deps, attempt, invocation, result, { ...fields, outcomes: outcomes.map(recordOf) });
    return { kind: "failed", outcomes };
  };

  if (input.prompt.length > config.maxContextChars) {
    return await failed(1, "input-too-large", "input-too-large", {});
  }
  const runDir = join(input.workspace, "run");
  let stdout = "";
  let next = input.prompt;
  let session: string | undefined;
  for (let invocation = 1; invocation <= 2; invocation += 1) {
    const transcript = deps.invocationSequence.filename({
      role: "scenario-runner",
      attempt,
      invocation,
    });
    const before = await snapshotReadOnlyAgent(sandbox.worktreePath, issue.branch);
    // The detail names the transcript rather than quoting it: it reaches
    // GitHub, and the runner's speech is scenario text.
    const wrote = async (fields: Fields): Promise<RunnerResult | null> => {
      const detail = await enforceReadOnlyAgentSnapshot(
        sandbox,
        before,
        await snapshotReadOnlyAgent(sandbox.worktreePath, issue.branch),
        "Scenario runner",
        withheldTranscript(transcript),
      );
      if (detail === null) return null;
      await record(deps, attempt, invocation, "wrote", fields);
      return { kind: "wrote", detail };
    };
    const timer = startTimer();
    let run: Awaited<ReturnType<Sandbox["run"]>>;
    try {
      run = await runWithProviderState(providerState, agent, () => sandbox.run({
        name: `scenario-runner-${issue.id}-round-${attempt}${invocation === 1 ? "" : "-nudge"}`,
        model,
        agent: buildAgentProvider(agent, model, { effort, resumeSession: session }),
        prompt: next,
        completionSignal: [],
        onInvocationEnd: (invocationRecord) =>
          attemptLogger.writeInvocation(transcript, invocationRecord),
      }));
    } catch (err) {
      const partial = agentPartialUsage(err);
      const usage = usageFields(
        partial,
        partial.rateLimit ?? (err instanceof AgentQuotaError ? err.measurement : undefined),
        input.prompt.length,
      );
      const fields: Fields = {
        ...routing,
        durationMs: agentPartialDurationMs(err) ?? timer(),
        transcript,
        ...(usage === undefined ? {} : { usage }),
        ...agentPartialContainerResources(err),
      };
      const write = await wrote(fields);
      if (write !== null) return write;
      if (
        err instanceof AgentQuotaError ||
        err instanceof AgentCredentialError ||
        err instanceof EgressProxyDiedError
      ) {
        await record(deps, attempt, invocation, agentFailureResult(err), fields);
        throw err;
      }
      return err instanceof AgentInputTooLargeError
        ? await failed(invocation, "input-too-large", "input-too-large", fields)
        : await failed(invocation, "failed", "runner-failed", fields);
    }
    const usage = usageFields(run, run.rateLimit, input.prompt.length);
    const fields: Fields = {
      ...routing,
      durationMs: run.durationMs,
      endedBy: run.endedBy,
      maxGapMs: run.maxGapMs,
      transcript,
      ...(usage === undefined ? {} : { usage }),
      ...containerResourcesOf(run),
    };
    const write = await wrote(fields);
    if (write !== null) return write;
    // The nudge's reply may only finish what the first run said.
    stdout = `${stdout}\n${run.stdout}`;
    const parsed = parseScenarioRunner(
      stdout,
      ids,
      (path) => existsSync(join(runDir, path)),
      { finalize: invocation === 2 },
    );
    if (parsed.kind === "REPORTED") {
      const outcomes = [...prepass, ...parsed.outcomes];
      await record(deps, attempt, invocation, "completed", {
        ...fields,
        outcomes: outcomes.map(recordOf),
        evidenceBytes: await treeBytes(runDir),
      });
      return { kind: "reported", outcomes };
    }
    // Without the session's id there is nothing the nudge could resume.
    if (invocation === 2 || run.sessionId === undefined) {
      return await failed(invocation, "failed", "not-reported", fields);
    }
    await record(deps, attempt, invocation, "completed", fields);
    next = parsed.reprompt;
    session = run.sessionId;
  }
  throw new Error("unreachable scenario runner invocation count");
}

// Runs `beforeScenarioRun` with its output in `run/`; "none" without one.
export async function runAppHook(
  sandbox: Pick<Sandbox, "runHooks">,
  hooks: ReadonlyArray<SandboxHook>,
  workspace: string,
): Promise<"ok" | "failed" | "none"> {
  if (hooks.length === 0) return "none";
  const ran = await sandbox.runHooks(hooks);
  await writeFile(
    join(workspace, "run", APP_HOOK_LOG),
    `[sandbar] beforeScenarioRun\n${ran.output}\n`,
    "utf8",
  );
  return ran.ok ? "ok" : "failed";
}

// Empty, as the sandbox's bind-mount source must exist before it starts.
export async function prepareVerifierWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
}

// An empty `run/` for the round about to run scenarios.
export async function clearRunDir(workspace: string): Promise<void> {
  const runDir = join(workspace, "run");
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir);
}

// Moves the round's `run/` to `roundDir`, which must not exist yet.
export async function archiveRun(workspace: string, roundDir: string): Promise<void> {
  await mkdir(dirname(roundDir), { recursive: true });
  await rename(join(workspace, "run"), roundDir);
}

// `findings/` holds a copy of each of `failing`'s directories from the
// archived round, and nothing else.
export async function restageFindings(
  workspace: string,
  roundDir: string,
  failing: readonly string[],
): Promise<void> {
  const findings = join(workspace, "findings");
  await rm(findings, { recursive: true, force: true });
  await mkdir(findings);
  for (const id of failing) {
    await cp(join(roundDir, id), join(findings, id), { recursive: true });
  }
}

// The bytes under `path`, links counted as themselves.
async function treeBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  const sizes = await Promise.all(
    (await readdir(path)).map((name) => treeBytes(join(path, name))),
  );
  return sizes.reduce((total, size) => total + size, 0);
}
