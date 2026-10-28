// The scenario writer's background task (#203) — I/O around one cold,
// read-only role per admission.
//
// `runInnerLoop` creates the task when `config.scenarioWriter` is on and owns
// it across the admission's sandbox cycles; the state machine decides when it
// starts and where it is joined (inner-loop-machine.ts). `start` returns at
// once and is idempotent. `settled` is the join. `status` is what the machine
// is told at each cycle's start: a write, or a failure sandbar did not expect,
// stays `running` so that the join hears it.
//
// The writer runs in its OWN container over a read-only, ref-less snapshot of
// the seed commit (`createSeedSnapshotSandbox`), never in the issue sandbox,
// and it is handed the issue anchor, its contract and its prompt extension,
// nothing of the implementer's branch. Its answer is speech (#113): the parser
// validates it, and only this module writes the set, as `scenarios-<k>.json`
// in the issue's log directory, which no sandbox mounts. No event, prompt or
// park detail carries scenario text.
//
// One invocation, then at most one same-session format nudge carrying the
// parser's correction, parsed over both outputs. A harness failure (an agent
// error or timeout, a closed provider, a size refusal, a writer that could
// not come up), a prompt over `maxContextChars`, or an answer still malformed
// after the nudge settles `failed`: no scenarios, recorded, and nothing else
// changes. A closed provider is still recorded in the run's provider state,
// and the issue's own roles meet it themselves. A change to the snapshot's
// HEAD or status after any invocation settles `wrote`, and the snapshot is
// kept. `abort` ends a writer the admission no longer needs: it closes the
// container, which kills the run, and the invocation is recorded `aborted`.
// Every invocation is one `scenario-writer` event and one
// `scenario-writer-<n>.log`, numbered across the run's admissions.

import { buildAgentProvider } from "./agent-providers.js";
import {
  AgentCredentialError,
  AgentError,
  AgentIdleTimeoutError,
  AgentInputTooLargeError,
  AgentQuotaError,
  type SeedSnapshotSandbox,
  agentPartialContainerResources,
  agentPartialDurationMs,
  agentPartialUsage,
  createSeedSnapshotSandbox,
  podman,
} from "./agent-sandbox.js";
import { usageFields } from "./agent-usage.js";
import { containerResourcesOf } from "./container-resources.js";
import { SandbarError } from "./errors.js";
import type { EventInput, ScenarioWriterResult } from "./events.js";
import { ContainerBringupError } from "./gate-stack.js";
import {
  type InnerLoopConfig,
  type InnerLoopOptions,
  type IssueRef,
  agentFailureResult,
  agentSandboxNotice,
  issueAnchorOptionsOf,
  runWithProviderState,
} from "./inner-loop.js";
import type { ScenarioWriterOutcome, ScenarioWriterStatus } from "./inner-loop-machine.js";
import { scopedResourcePrefix } from "./naming.js";
import { buildScenarioWriterPrompt } from "./prompt.js";
import { type ScenarioSet, parseScenarioWriter } from "./scenario-parser.js";
import { startTimer } from "./timing.js";

export type ScenarioWriterInput = {
  // The cycle's resolved sandbox image, which carries the agent CLIs.
  readonly imageName: string;
  readonly seedRef: string;
  // The fork point the snapshot is checked out at.
  readonly seedSha: string;
};

export type ScenarioWriterTask = {
  status(): ScenarioWriterStatus;
  start(input: ScenarioWriterInput): void;
  settled(): Promise<ScenarioWriterOutcome>;
  abort(): Promise<void>;
};

export type ScenarioWriterDeps = {
  readonly issue: Pick<IssueRef, "id" | "title">;
  readonly config: Pick<
    InnerLoopConfig,
    | "layout"
    | "issueSource"
    | "repo"
    | "env"
    | "codexAuthMount"
    | "scope"
    | "maxContextChars"
    | "promptExtensions"
    | "scenarioWriterAgent"
    | "scenarioWriterModelId"
    | "scenarioWriterEffort"
  >;
} & Pick<InnerLoopOptions, "attemptLogger" | "onEvent" | "providerState">;

// How the task ended: an outcome, or an error sandbar did not expect, which
// the join rethrows.
type Settlement =
  | { readonly outcome: ScenarioWriterOutcome }
  | { readonly error: unknown };

// A run that ended without an answer; anything else is the host's.
const isHarnessFailure = (err: unknown): boolean =>
  err instanceof AgentError || err instanceof AgentIdleTimeoutError ||
  err instanceof AgentQuotaError || err instanceof AgentCredentialError ||
  err instanceof AgentInputTooLargeError;

const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err);

export function createScenarioWriterTask(deps: ScenarioWriterDeps): ScenarioWriterTask {
  const { issue, config, attemptLogger, onEvent, providerState } = deps;
  const agent = config.scenarioWriterAgent;
  const model = config.scenarioWriterModelId;
  const effort = config.scenarioWriterEffort;
  // Its own sequence: the task outlives the cycle that started it.
  const sequence = attemptLogger.startInvocationCycle();
  let task:
    | { readonly kind: "pending" }
    | { readonly kind: "running"; readonly done: Promise<Settlement> }
    | { readonly kind: "settled"; readonly settlement: Settlement } = { kind: "pending" };
  let aborted = false;
  let sandbox: SeedSnapshotSandbox | null = null;

  type Fields = Pick<
    Extract<EventInput, { kind: "scenario-writer" }>,
    "durationMs" | "endedBy" | "transcript" | "maxGapMs" | "scenarios" | "usage"
  > & ReturnType<typeof agentPartialContainerResources>;
  const record = (invocation: number, result: ScenarioWriterResult, fields: Fields) =>
    onEvent({
      kind: "scenario-writer",
      issue: Number(issue.id),
      title: issue.title,
      invocation,
      provider: agent,
      model,
      effort: effort ?? null,
      result,
      ...fields,
    });
  const failed = (detail: string): ScenarioWriterOutcome => ({ kind: "failed", detail });

  // An invocation that threw: aborted, a harness failure, or the host's.
  const ranAndThrew = async (
    invocation: number,
    transcript: string,
    err: unknown,
    elapsedMs: number,
  ): Promise<ScenarioWriterOutcome> => {
    const partial = agentPartialUsage(err);
    const usage = usageFields(
      partial,
      partial.rateLimit ?? (err instanceof AgentQuotaError ? err.measurement : undefined),
    );
    const fields: Fields = {
      durationMs: agentPartialDurationMs(err) ?? elapsedMs,
      transcript,
      ...(usage === undefined ? {} : { usage }),
      ...agentPartialContainerResources(err),
    };
    // Closing the container is how an abort ends the run.
    if (aborted) {
      await record(invocation, "aborted", fields);
      return failed("aborted: the admission ended before the join");
    }
    if (!isHarnessFailure(err)) throw err;
    const wrote = await snapshotWrote(invocation, fields);
    if (wrote !== null) return wrote;
    await record(invocation, agentFailureResult(err), fields);
    return failed(errorText(err));
  };

  // A run may not have changed the snapshot, whatever else it did.
  let preserve: string | undefined;
  const snapshotWrote = async (
    invocation: number,
    fields: Fields,
  ): Promise<ScenarioWriterOutcome | null> => {
    const open = requireSandbox();
    const changed = await open.changed();
    if (changed === null) return null;
    preserve = "the scenario writer changed its read-only seed snapshot; kept for human inspection";
    await record(invocation, "wrote", fields);
    return {
      kind: "wrote",
      detail: `Scenario writer changed its seed snapshot at ${open.worktreePath}:\n${changed}`,
    };
  };

  const requireSandbox = (): SeedSnapshotSandbox => {
    if (sandbox === null) throw new Error("scenario writer ran without its sandbox");
    return sandbox;
  };

  async function converse(input: ScenarioWriterInput): Promise<ScenarioWriterOutcome> {
    const open = requireSandbox();
    const prompt = await buildScenarioWriterPrompt(
      issue.id,
      issueAnchorOptionsOf(config),
      open.worktreePath,
      config.promptExtensions?.scenarioWriter,
    );
    if (prompt.length > config.maxContextChars) {
      await record(1, "input-too-large", {});
      return failed(
        `the prompt is ${prompt.length} chars, over the ${config.maxContextChars}-char context budget`,
      );
    }
    let stdout = "";
    let next = prompt;
    for (let invocation = 1; invocation <= 2; invocation += 1) {
      const transcript = sequence.filename({ role: "scenario-writer", invocation });
      if (aborted) {
        await record(invocation, "aborted", {});
        return failed("aborted: the admission ended before the join");
      }
      const timer = startTimer();
      let run: Awaited<ReturnType<SeedSnapshotSandbox["run"]>>;
      try {
        run = await runWithProviderState(providerState, agent, () => open.run({
          name: `scenario-writer-${issue.id}${invocation === 1 ? "" : "-nudge"}`,
          model,
          agent: buildAgentProvider(agent, model, { continueSession: invocation === 2, effort }),
          prompt: next,
          completionSignal: [],
          onInvocationEnd: (invocationRecord) =>
            attemptLogger.writeInvocation(transcript, invocationRecord),
        }));
      } catch (err) {
        return ranAndThrew(invocation, transcript, err, timer());
      }
      const usage = usageFields(run, run.rateLimit);
      const fields: Fields = {
        durationMs: run.durationMs,
        endedBy: run.endedBy,
        maxGapMs: run.maxGapMs,
        transcript,
        ...(usage === undefined ? {} : { usage }),
        ...containerResourcesOf(run),
      };
      const wrote = await snapshotWrote(invocation, fields);
      if (wrote !== null) return wrote;
      // The nudge's reply may only finish what the first run said.
      stdout = `${stdout}\n${run.stdout}`;
      const parsed = parseScenarioWriter(stdout);
      if (parsed.kind === "WRITTEN") {
        const set: ScenarioSet = {
          version: 1,
          issue: Number(issue.id),
          seed: { ref: input.seedRef, sha: input.seedSha },
          writer: { provider: agent, model, effort: effort ?? null },
          scenarios: parsed.scenarios,
        };
        await attemptLogger.writeScenarios(set);
        await record(invocation, "completed", { ...fields, scenarios: set.scenarios.length });
        return { kind: "written", set };
      }
      if (parsed.kind === "NONE") {
        await record(invocation, "completed", { ...fields, scenarios: 0 });
        return { kind: "none", reason: parsed.reason };
      }
      if (invocation === 2) {
        await record(invocation, "failed", fields);
        return failed(`no valid answer after the format nudge:\n${parsed.reprompt}`);
      }
      await record(invocation, "completed", fields);
      next = parsed.reprompt;
    }
    throw new Error("unreachable scenario writer invocation count");
  }

  async function write(input: ScenarioWriterInput): Promise<ScenarioWriterOutcome> {
    try {
      sandbox = await createSeedSnapshotSandbox({
        layout: config.layout,
        issueId: issue.id,
        seedSha: input.seedSha,
        sandbox: podman({
          imageName: input.imageName,
          namePrefix: scopedResourcePrefix(config.scope),
        }),
        env: config.env,
        extraMounts: config.codexAuthMount === undefined ? [] : [{
          hostPath: config.codexAuthMount.hostPath,
          sandboxPath: config.codexAuthMount.sandboxPath,
        }],
        onNotice: (severity, message) => onEvent(agentSandboxNotice(severity, message)),
      });
    } catch (err) {
      // A writer that cannot come up — podman, the snapshot's git — is its
      // harness failing. Sandbar's own inconsistencies still propagate.
      if (err instanceof SandbarError && !(err instanceof ContainerBringupError)) throw err;
      await record(1, "failed", {});
      return failed(`the writer's sandbox did not come up: ${errorText(err)}`);
    }
    try {
      return await converse(input);
    } finally {
      await closeSandbox(preserve === undefined ? {} : { preserve });
    }
  }

  // A teardown whose failure says nothing about the scenarios: a leaked
  // container is reported, and the outcome stands (#83).
  async function closeSandbox(o: { readonly preserve?: string }): Promise<void> {
    try {
      await sandbox?.close(o);
    } catch (err) {
      await onEvent({
        kind: "complaint",
        severity: "error",
        message: `Failed to close the scenario writer's sandbox: ${errorText(err)}`,
      });
    }
  }

  return {
    status() {
      if (task.kind === "pending") return { kind: "pending" };
      if (task.kind === "running") return { kind: "running" };
      const { settlement } = task;
      return "outcome" in settlement && settlement.outcome.kind !== "wrote"
        ? { kind: "settled", outcome: settlement.outcome }
        : { kind: "running" };
    },
    start(input) {
      if (task.kind !== "pending") return;
      // Never rejects: an unexpected error waits for the join to rethrow it.
      const done = write(input).then(
        (outcome): Settlement => ({ outcome }),
        (error: unknown): Settlement => ({ error }),
      ).then((settlement) => {
        task = { kind: "settled", settlement };
        return settlement;
      });
      task = { kind: "running", done };
    },
    async settled() {
      if (task.kind === "pending") throw new Error("scenario writer awaited before it started");
      const settlement = task.kind === "running" ? await task.done : task.settlement;
      if ("error" in settlement) throw settlement.error;
      return settlement.outcome;
    },
    async abort() {
      if (task.kind !== "running") return;
      const { done } = task;
      aborted = true;
      await closeSandbox({});
      const settlement = await done;
      if ("error" in settlement) throw settlement.error;
    },
  };
}
