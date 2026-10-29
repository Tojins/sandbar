// Standalone steps (#247): a gate step marked `standalone` (config.ts) also
// runs early, beside the quality pass's listers and again beside each quality
// verify, so a red the quality fixer can clear costs no implementer attempt.
// Gate-1 still runs every step, standalone ones included, and its verdict is
// the only verdict (D1, #27): an early run only ever produces findings.
//
// IN THE STEP'S OWN CONTAINER, not the issue sandbox: the sandbox image is the
// consumer's to build and need not carry a step's tooling, so a "command not
// found" there would be a false finding. The copy (`standaloneCopyOf`) is the
// resolved container as gate-1's stack in effect has it, env and mounts
// included, but held open (`sleep infinity`) with no readiness and no
// `postReadyCommands`, on `--network none`, with the worktree mounted
// read-only at its `mountWorktree` and its working directory there. The
// clone's `.git` sits behind the same tmpfs gate-1 uses (#98), which podman
// fills by copy-up: a step's `git` reads the branch's history and
// `refs/remotes/origin/*` as gate-1 does, so a base the step names resolves to
// the same commit, and nothing it writes reaches the clone. Read-only matters
// because the copy runs while the read-only listers' snapshots watch the
// worktree. No base is injected, and no egress allowlist applies: there is no
// network to allow anything on.
//
// The image is the one gate-1 runs, through the same resolver (#37): a
// `rebuildOn` variant built here is the one gate-1 then reuses, so a build
// moves earlier rather than being added. It is no gate, so it takes no
// `maxConcurrentGates` permit (#142).
//
// One copy per distinct container among the standalone steps, named under the
// run's scope (`standaloneContainerNameFor`), so the orphan sweep reaches one a
// crash left (#28). The copies run side by side; within one, every standalone
// step is exec'd in stack order and every one runs, since none reads what
// another built. Each copy is removed before it is created, registered for a
// signal's cleanup (#35) and for the loop's abort, and removed after its last
// step with `rm -f -t 0`, which also reaps a step that timed out. An abort
// while it starts execs nothing, and the copy is removed once it has started.
// A removal that fails is left to the next fan-out's pre-create removal and
// the sweep.
// Every podman call is bounded (`boundedRuntime`, #26), a step by its own
// `timeoutMs`, and every env value travels in an env file (#154).
//
// Each step run settles as `passed` (exit 0), `failed` (any other exit of the
// step), `timed-out` (its `timeoutMs` ran out) or `unavailable` (the image,
// the copy or podman failed, podman's own exit 125 included, or the output
// overflowed `RUNTIME_MAX_BUFFER`). Only `failed` is a finding: one block per
// step, from `prompts/quality-step-finding.md`, with the output's summarized,
// ANSI-stripped tail. The other outcomes are records only, never findings and
// never a budget charge. A bug in sandbar itself throws.
//
// A quality verify folds beside its rerun of every standalone step
// (`combineVerifyReview`); the listers' fold is `combineGroupReviews`
// (standards-groups.ts). Events and the log file are the runner's
// (inner-loop.ts), from `StandaloneStepRun` and `renderStandaloneLog`.

import { registerDisposable } from "./cleanup.js";
import type {
  ResolvedGateStack,
  ResolvedGateStep,
  ResolvedStackContainer,
} from "./config.js";
import {
  type ContainerResources,
  containerResourcesSince,
  readContainerResourceSnapshot,
  systemContainerResourceDeps,
} from "./container-resources.js";
import { type ImageMap, ImageBuildError } from "./ensure-images.js";
import { stripAnsi, summarizeGateFailure } from "./gate.js";
import {
  CONTAINER_RM_ARGS,
  CONTROL_TIMEOUT_MS,
  containerRunArgs,
  imageFor,
  stepExecArgs,
} from "./gate-stack.js";
import type { ReviewerResult } from "./inner-loop-machine.js";
import { type RunScope, standaloneContainerNameFor } from "./naming.js";
import { loadTemplate, render } from "./prompts.js";
import {
  boundedRuntime,
  boundedRuntimeOk,
  type BoundedRuntimeResult,
  RUNTIME_MAX_BUFFER,
  type RuntimeInvocation,
  withRuntimeEnv,
} from "./runtime.js";
import { startTimer } from "./timing.js";
import { stripVerdictTokens } from "./verdict-parser.js";

export type StandaloneStepOutcome =
  | { readonly result: "passed" | "failed"; readonly exitCode: number; readonly detail: null }
  | { readonly result: "timed-out"; readonly exitCode: null; readonly detail: null }
  | { readonly result: "unavailable"; readonly exitCode: null; readonly detail: string };

export type StandaloneStepRun = StandaloneStepOutcome & ContainerResources & {
  readonly step: ResolvedGateStep;
  // The image the copy ran, or would have.
  readonly image: string;
  readonly durationMs: number;
  // stdout, then stderr, ANSI-stripped.
  readonly output: string;
};

export const STEP_FINDING_TAIL_LINES = 80;

const STEP_FINDING_TPL = loadTemplate("quality-step-finding");

// Podman's exit status for a failure of podman itself, as opposed to the
// command it ran (126 and 127 are the command's, as gate-1 reads them too).
const PODMAN_ERROR_EXIT = 125;

export function standaloneCopyOf(c: ResolvedStackContainer): ResolvedStackContainer {
  return { ...c, hold: true, readiness: null, postReadyCommands: [] };
}

// `container` carries the image the copy runs.
export function standaloneCopyArgs(opts: {
  readonly containerName: string;
  readonly container: ResolvedStackContainer;
  readonly worktreePath: string;
}): RuntimeInvocation {
  return containerRunArgs({
    containerName: opts.containerName,
    attach: { kind: "none" },
    container: standaloneCopyOf(opts.container),
    worktreePath: opts.worktreePath,
    hideWorktreeGit: true,
    readOnlyWorktree: true,
  });
}

// What one bounded `podman exec` of a step came to.
export function settleStepRun(
  r: BoundedRuntimeResult,
): StandaloneStepOutcome & { readonly output: string } {
  const output = stripAnsi([r.stdout, r.stderr].filter((s) => s !== "").join("\n"));
  if (r.timedOut) return { result: "timed-out", exitCode: null, detail: null, output };
  if (r.maxBufferExceeded) {
    return {
      result: "unavailable",
      exitCode: null,
      detail: `the step printed more than ${RUNTIME_MAX_BUFFER} bytes and was killed`,
      output,
    };
  }
  if (r.exitCode === null || r.exitCode === PODMAN_ERROR_EXIT) {
    return { result: "unavailable", exitCode: null, detail: `podman exec failed: ${r.errorMessage}`, output };
  }
  return { result: r.exitCode === 0 ? "passed" : "failed", exitCode: r.exitCode, detail: null, output };
}

// One finding block per failed step, in stack order.
export function stepFindings(runs: readonly StandaloneStepRun[]): readonly string[] {
  return runs.flatMap((run) => run.result === "failed"
    ? [render(STEP_FINDING_TPL, {
        name: run.step.name,
        command: run.step.command.join(" "),
        exitCode: String(run.exitCode),
        tailLines: String(STEP_FINDING_TAIL_LINES),
        output: summarizeGateFailure(run.output, STEP_FINDING_TAIL_LINES).trim() || "(no output)",
      })]
    : []);
}

const outcomeText = (run: StandaloneStepRun): string => {
  switch (run.result) {
    case "passed": return "passed";
    case "failed": return `failed exit ${run.exitCode}`;
    case "timed-out": return `timed out after ${run.step.timeoutMs}ms`;
    case "unavailable": return `unavailable: ${run.detail}`;
  }
};

// A fan-out's log file: one banner per step, then its output.
export function renderStandaloneLog(runs: readonly StandaloneStepRun[]): string {
  return runs
    .map((run) => `== ${run.step.name} (${run.step.in}) · ${outcomeText(run)}\n${run.output}`)
    .join("\n");
}

// A quality verify beside its rerun (#247). A write is a write, and a verify
// that produced no review leaves the pass with none whatever the rerun said:
// a step-only report would otherwise drop the open model findings. Otherwise
// the verify's open items and the rerun's findings make it CHANGES-REQUESTED,
// and approves only with neither.
export function combineVerifyReview(
  review: ReviewerResult,
  findings: readonly string[],
): ReviewerResult {
  if (findings.length === 0 || review.kind !== "reviewer-result") return review;
  const open = review.verdict === "CHANGES-REQUESTED" ? [stripVerdictTokens(review.prose).trim()] : [];
  return { kind: "reviewer-result", verdict: "CHANGES-REQUESTED", prose: [...open, ...findings].join("\n\n") };
}

export type StandaloneStepsOptions = {
  readonly scope: RunScope;
  // The issue id, or a janitor task's resource key (#205).
  readonly stackId: string;
  // The stack gate-1 would run at this head.
  readonly stack: ResolvedGateStack;
  readonly worktreePath: string;
  // Gate-1's image resolver (#37); null when nothing is built per branch.
  readonly images: ((only: ReadonlySet<string>) => Promise<ImageMap>) | null;
  readonly signal: AbortSignal | undefined;
};

// Every standalone step of the stack, in stack order; none without one.
export async function runStandaloneSteps(
  opts: StandaloneStepsOptions,
): Promise<readonly StandaloneStepRun[]> {
  const steps = opts.stack.steps.filter((step) => step.standalone);
  const containers = [...new Set(steps.map((step) => step.in))].map((name) => {
    const container = opts.stack.containers.find((c) => c.name === name);
    // resolveGateStack proved this at config time; a miss here is a bug.
    if (container === undefined) {
      throw new Error(`standalone steps: no container '${name}' in the stack`);
    }
    return container;
  });
  const runs = (await Promise.all(containers.map((container) =>
    runInCopy(opts, container, steps.filter((step) => step.in === container.name))))).flat();
  return runs.sort((a, b) => steps.indexOf(a.step) - steps.indexOf(b.step));
}

async function runInCopy(
  opts: StandaloneStepsOptions,
  container: ResolvedStackContainer,
  steps: readonly ResolvedGateStep[],
): Promise<StandaloneStepRun[]> {
  const unavailable = (image: string, detail: string): StandaloneStepRun[] =>
    steps.map((step) => ({ step, image, result: "unavailable", exitCode: null, detail, durationMs: 0, output: "" }));
  let image: string;
  try {
    image = opts.images === null
      ? container.image
      : imageFor(container, await opts.images(new Set([container.image])));
  } catch (err) {
    if (!(err instanceof ImageBuildError)) throw err;
    return unavailable(container.image, `image '${err.tag}' could not be built from this worktree`);
  }

  const containerName = standaloneContainerNameFor(opts.scope, opts.stackId, container.name);
  const rm = () => boundedRuntime(CONTAINER_RM_ARGS(containerName), CONTROL_TIMEOUT_MS);
  // A removal made while the copy starts may run before it exists, so only
  // one made once it has started stands for every later one.
  let live = false;
  let removal: Promise<unknown> | null = null;
  const remove = async (): Promise<void> => {
    await (live ? (removal ??= rm()) : rm());
  };
  const onAbort = (): void => {
    void remove();
  };
  await rm();
  const withdraw = registerDisposable(remove);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const started = await withRuntimeEnv(
      standaloneCopyArgs({ containerName, container: { ...container, image }, worktreePath: opts.worktreePath }),
      (argv) => boundedRuntime(argv, CONTROL_TIMEOUT_MS),
    );
    if (!boundedRuntimeOk(started)) {
      return unavailable(image, `the copy did not start: ${
        started.timedOut ? `no answer within ${CONTROL_TIMEOUT_MS}ms` : started.errorMessage
      }`);
    }
    live = true;
    if (opts.signal?.aborted === true) return unavailable(image, "the run was aborted");
    const runs: StandaloneStepRun[] = [];
    for (const step of steps) runs.push({ step, image, ...(await execStep(containerName, step)) });
    return runs;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    withdraw();
    await remove();
  }
}

async function execStep(
  containerName: string,
  step: ResolvedGateStep,
): Promise<StandaloneStepOutcome & ContainerResources & { readonly durationMs: number; readonly output: string }> {
  const deps = systemContainerResourceDeps();
  const start = await readContainerResourceSnapshot(containerName, deps);
  const timer = startTimer();
  const r = await withRuntimeEnv(
    stepExecArgs(containerName, step.command),
    (argv) => boundedRuntime(argv, step.timeoutMs),
  );
  const durationMs = timer();
  const end = await readContainerResourceSnapshot(containerName, deps);
  return { ...settleStepRun(r), durationMs, ...containerResourcesSince(end, start) };
}
