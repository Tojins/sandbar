// Sandbar orchestrator — continuous execution pool plus serialized landing.
//
//   Recompute:                 Deterministic resolver picks the unblocked
//                              `ready-for-agent` issues after checking the
//                              latest label actor against required configured
//                              developers or this run's token login (#136;
//                              `"anyone"` disables the check). The token login
//                              is resolved once during preflight. Exclusions
//                              are recorded once per issue per recompute and
//                              shown in the plan, then admitted work is picked
//                              by parsing each body's `## Blocked by` section
//                              and routed by
//                              LANE (#57), holding back the review-gated ones
//                              that have nowhere to land at all (#61: the ones
//                              `chunks.ts` could give no chunk) and saying on
//                              the issue where an `auto-land` label lost to
//                              inherited gating. A changes-requested review on
//                              a chunk's pull request is routed to its landed
//                              member(s) and re-queues them (#95), and the
//                              RECONCILER (#64) finishes off any chunk branch
//                              already contained in origin/<sourceBranch> —
//                              hand-merged, or landed by a run that died
//                              before it could close the members. The plan is
//                              rebuilt after either, so a member re-queued now
//                              is carried into this recompute and one closed now
//                              stops blocking its dependents.
//   Execution pool:           Each issue runs in its own sandbox under two
//                              independent consecutive-failure budgets (#129).
//                              maxQualityRounds covers quality rejection, red
//                              gates and pre-gate re-prompts, and resets when a
//                              quality approval reaches a completed verdict.
//                              maxReviewRounds covers only correctness
//                              rejection. APPROVED → DONE;
//                              CHANGES-REQUESTED loops back to a new impl
//                              attempt carrying the rejecting pass's prose.
//                              Reviewer harness failure spends neither budget,
//                              leaves both counters unchanged, and keeps its
//                              two-consecutive stop rule (#41).
//   Serialized landing:       Procedural merger lands queued DONE branches into
//                              the source branch and pushes once — directly,
//                              or (config.mergeMode = verified, #22) only after
//                              the forge's checks pass on the merge result.
//                              A review-gated issue lands on its CHUNK's
//                              branch instead (#60), which is pushed as it
//                              goes and carries a DRAFT pull request opened or
//                              updated per landing (#62); nothing of it reaches
//                              the source branch until a human has reviewed
//                              the chunk and put `land` on that pull request
//                              (#64) — at which point the chunk branch is
//                              merged in the SAME source pass, its members are
//                              closed, and the branch is deleted.
//   Finalise:                  Per-issue branch lifecycle — push/delete the
//                              local branch, post a bot-prefixed comment,
//                              flip labels. Runs in TWO passes (#30): 4a
//                              finalises the agent terminals BEFORE the merge
//                              (they don't depend on it, and a merge phase that
//                              throws something other than MergerError must not
//                              discard a full inner loop's worth of
//                              questions, traces and reviewer prose), 4b
//                              finalises the merger's own outcomes after.
//
// One event record at <cwd>/<workDir>/logs/run-<UTC-ISO>/events.jsonl captures
// every fact after the workdir lock is won (#132). Raw agent, gate, merger and
// resolve transcripts stay beside it as files. `run()` hosts the file-fed UI;
// stdout contains its URL only. After the record exists, operator complaints
// are events; stderr is reserved for the internal-failure banner.
//
// The lock is the record boundary (#70). Refused config, missing GH_TOKEN and
// a lost lock remain stderr-only because no run owns the workdir yet (or, for a
// lost lock, another run owns it). The winner immediately emits run-start,
// including driver identity, before preflight and image preparation. Every
// terminal path the run selects emits one structured exit, and cleanup appends
// run-end; a signal is the one ending with no exit event — cleanup.ts owns
// that exit (#35), so the record carries a complaint and `run-end (signal)`.
// Readers use run.pid plus run-end to distinguish live, crashed and ended runs.
//
// At capacity below `maxParallelIssues`, one cancellable wait races the next
// slot completion against `pollIntervalMs`. A poll refreshes source, issue,
// chunk and member refs before running the ordinary plan. A failed refresh is
// reported and waits for the next wake instead of killing the daemon; startup
// preflight remains fatal. A no-op poll is silent; work, source movement, and
// changed config-staleness evidence are recorded. A stable label-actor
// exclusion is also recorded on each poll because its required diagnostic
// makes that recompute reportable. Source movement from either
// a human push or this process refreshes the image inputs.
// Agent and branch images are replaced as one bundle and captured by each
// admission, so a poll cannot change the images beneath in-flight work.
// Every gate-1 and gate-2 call passes through one run-wide FIFO semaphore
// (#142). `maxConcurrentGates` bounds its permits; absence is unlimited, and
// queue time is evidence on the gate event rather than a scheduling decision.

import { realpathSync } from "node:fs";
import { dirname } from "node:path";

import { type ResolvedConfig, type RunConfig, resolveConfig } from "./config.js";
import { AgentCredentialError, AgentQuotaError } from "./agent-sandbox.js";
import {
  type SweepResult,
  cleanupOrphanContainers,
  findUnattributableResources,
} from "./containers.js";
import { installCleanupTraps, onCleanup, runCleanup, setCleanupReporter } from "./cleanup.js";
import {
  routeChunkReviewFollowUps,
  realAdapter as realChunkFollowUpAdapter,
} from "./chunk-follow-up.js";
import {
  formatDriverIdentity,
  readDriverIdentity,
} from "./driver-identity.js";
import {
  type AgentImages,
  createAgentImages,
} from "./agent-tools.js";
import { type CodexAuthMount, prepareCodexAuth } from "./codex-auth.js";
import {
  type BranchImages,
  type ImageBuildRecord,
  checkWorktreeImageUids,
  createBranchImages,
  ensureImages,
  formatImageRecord,
  pulledImagesOf,
  removeBranchImages,
  sweepBranchImages,
  worktreeMountingTagsOf,
} from "./ensure-images.js";
import { makeEnvReader } from "./env.js";
import { startTimer } from "./timing.js";
import { SandbarError, faultDetail } from "./errors.js";
import { startEventRecord, type EventInput, type RecomputeTrigger } from "./events.js";
import {
  type TerminalExit,
  MAX_CONSECUTIVE_NO_PROGRESS_WITHOUT_LANDING,
  haltedExit,
  credentialExit,
  quotaExit,
  stuckExit,
} from "./exit-conditions.js";
import { type RunProviderState, createRunProviderState, recordProviderClosure } from "./inner-loop.js";
import {
  type FinalizeInput,
  type FinalizeResult,
  finalizationIntendsNotReady,
  finalizeAll,
  realAdapter as realFinalizeAdapter,
} from "./finalize.js";
import {
  mergeFinalizeInputs,
  terminalFinalizeInputs,
} from "./finalize-inputs.js";
import {
  realVerifyAdapter,
  verifiedLandingOptionsFrom,
} from "./forge-verify.js";
import { startKeepawake } from "./keepawake.js";
import { runInnerLoop, type Terminal } from "./inner-loop.js";
import { requiredAgentProviders } from "./agent-providers.js";
import { LockHeldError, acquireLock, lockPathsFor } from "./lock.js";
import { runScope } from "./naming.js";
import {
  MergerError,
  type MergerOutcome,
  type MergerSummary,
  issueNumberOf,
  realAdapter,
  runMergerWithAdapter,
} from "./merger.js";
import {
  type MergerWorktree,
  createMergerWorktree,
} from "./merger-worktree.js";
import { type Stack, startStack } from "./gate-stack.js";
import { createGateSemaphore } from "./gate-semaphore.js";
import {
  CHUNK_LANDED_UNNAMED_BANNER,
  CHUNK_RESIDUE_KEPT_BANNER,
  CHUNK_RESIDUE_RETIRED_BANNER,
  LAND_LABEL,
  chunkResidue,
  selectLandRequests,
} from "./chunk-land.js";
import {
  fetchLandRequestPullRequests,
  reconcileLandedChunks,
} from "./chunk-reconcile.js";
import { postLaneOverrideNotices } from "./lanes.js";
import {
  type PlanResolution,
  type PlannedIssue,
  type ReadyLabelPolicy,
  buildPlan,
  readIssueBranchRefs,
} from "./plan-resolver.js";
import {
  ContinuousPool,
  decideSchedulerAction,
  type SchedulerExit,
  type SettledIssue,
} from "./scheduler.js";
import {
  absoluteMountSources,
  fetchOriginRefs,
  PreflightError,
  readConfigStaleness,
  runPreflight,
  staleConfigWarning,
} from "./preflight.js";
import { buildProjectAnchor } from "./prompt.js";
import {
  ensureRepoCache,
  ensureSourceWorktree,
  repoLayout,
} from "./repo-cache.js";
import { startUiServer, UiPortInUseError } from "./ui-server.js";


// The merge phase's stack id. Distinct from every issue id (which are numeric),
// so its pod, network and containers can never collide with an issue's.
const MERGER_STACK_ID = "merger";


// A leaked resource is recoverable — the next namesake `startStack` force-removes
// a namesake before creating one — so a failed sweep is not fatal. It is also
// not silent: it leaks a pod, its invisible infra container and its network, and
// the operator is the only one who can tell whether that matters.
//
// Takes the log writer rather than reaching for one, because it is called from
// three places and every one of them is now inside the record (#70): a sweep
// failure is an outcome, so it exists in the log whether or not anyone was
// watching the terminal.
async function reportSweepFailures(
  result: SweepResult,
  emit: (event: EventInput) => Promise<unknown>,
  scope: "startup" | "quiescent",
): Promise<void> {
  if (result.failures.length === 0) return;
  await emit({ kind: "sweep", scope, removed: result.removed, failures: result.failures });
}

// Everything a run needs that is not configuration (#69). `run(config)` is
// still the contract — this is a second, optional argument, because a config
// file's own PATH is not one of its fields: the config is a program that
// neither knows nor should know where it was imported from, and a `configPath`
// key inside it would be a second source of truth for something the loader
// already holds. The bin passes what it resolved; a programmatic host that has
// no file passes nothing and the identity line says so.
export type RunOptions = {
  readonly configPath?: string;
};

// Terminal precedence in one testable place (#109, #134). The fallback is lazy
// so a provider closure cannot be displaced by a lower-priority run-state exit.
export function selectTerminalExit(args: {
  readonly mergerProviderError: AgentQuotaError | AgentCredentialError | null;
  readonly haltReasons: readonly string[];
  readonly terminals: readonly Terminal[];
  readonly otherwise: () => TerminalExit | null;
}): TerminalExit | null {
  if (args.mergerProviderError instanceof AgentCredentialError) {
    return credentialExit(args.mergerProviderError);
  }
  const credential = args.terminals.find((terminal) => terminal.type === "CREDENTIAL");
  if (credential?.type === "CREDENTIAL") return credentialExit(credential);
  if (args.mergerProviderError instanceof AgentQuotaError) {
    return quotaExit({
      provider: args.mergerProviderError.provider,
      window: args.mergerProviderError.measurement.window,
      ...(args.mergerProviderError.measurement.resetsAt === undefined
        ? {}
        : { resetsAt: args.mergerProviderError.measurement.resetsAt }),
    });
  }
  if (args.haltReasons.length > 0) return haltedExit(args.haltReasons);
  const quota = args.terminals.find((terminal) => terminal.type === "QUOTA");
  return quota?.type === "QUOTA" ? quotaExit(quota) : args.otherwise();
}

export function terminalReason(terminal: Terminal): string | null {
  switch (terminal.type) {
    case "DONE": return null;
    case "NEEDS-INFO": return terminal.questions;
    case "NEEDS-UI-PROTOTYPE": return terminal.uiImpact;
    case "NEEDS-HUMAN": return `${terminal.cause}: ${terminal.failureTrace}`;
    case "NEEDS-HUMAN-REVIEW": return `${terminal.cause}: ${terminal.latestReviewerProse}`;
    case "HARD-ERROR": return terminal.reason;
    case "QUOTA": return `${terminal.provider} ${terminal.window}`;
    case "CREDENTIAL": return `${terminal.provider}: ${terminal.detail}`;
  }
}

export async function verifyFinalizedTrackerState(
  results: readonly FinalizeResult[],
  issueLabels: (issueNum: number) => Promise<readonly string[]>,
): Promise<void> {
  for (const result of results) {
    if (!finalizationIntendsNotReady(result)) continue;
    const issueNum = issueNumberOf(result.input.issue);
    const observed = await issueLabels(issueNum);
    if (observed.includes("ready-for-agent")) {
      throw new SandbarError(
        `Tracker read-back mismatch for issue #${issueNum}: sandbar wrote ` +
          `not-ready but observed labels [${observed.join(", ")}].`,
      );
    }
  }
}

// The exit for a provider the run's shared state closed, when no matching
// terminal and no merger error built one. That happens when the issue that
// closed the provider never returned a terminal at all — its inner loop
// rejected after the close — so the scheduler is right that the run must
// stop, and the recorded closure is the only description left.
export function closedProviderExit(
  config: Parameters<typeof requiredAgentProviders>[0],
  providerState: RunProviderState,
): TerminalExit | null {
  const providers = requiredAgentProviders(config);
  for (const provider of providers) {
    const closed = providerState.get(provider);
    if (closed?.cause === "credential") {
      return credentialExit({ provider: "codex", detail: closed.detail });
    }
  }
  for (const provider of providers) {
    const closed = providerState.get(provider);
    if (closed?.cause !== "quota") continue;
    return quotaExit({
      provider,
      window: closed.measurement.window,
      ...(closed.measurement.resetsAt === undefined
        ? {}
        : { resetsAt: closed.measurement.resetsAt }),
    });
  }
  return null;
}

function schedulerExit(
  reason: SchedulerExit,
  pool: ContinuousPool<PlannedIssue, Terminal>,
  providerExit: TerminalExit | null,
): TerminalExit {
  switch (reason) {
    case "provider-closed": {
      if (!providerExit) throw new Error("scheduler selected provider closure without an exit");
      return providerExit;
    }
    case "stuck": return stuckExit(pool.noProgressSinceLanding);
  }
}

type RunActivity = {
  readonly isIdle: () => boolean;
  readonly enterBusy: () => void;
  readonly enterIdle: () => void;
  readonly stop: () => void;
};

// One owner for the daemon's activity state and wake-lock lifetime (#133).
// Callers report state transitions; they never pair a flag mutation with a
// separate lock operation. A replacement holder is observed before it can
// report a status, and `stop` always targets the holder current at cleanup.
function createRunActivity(args: {
  readonly initialLock: ReturnType<typeof startKeepawake>;
  readonly keepAwakeWhileIdle: boolean;
  readonly startLock: () => ReturnType<typeof startKeepawake>;
  readonly observeLock: (lock: ReturnType<typeof startKeepawake>) => void;
}): RunActivity {
  let lock: ReturnType<typeof startKeepawake> | null = args.initialLock;
  let idle = false;
  args.observeLock(lock);
  return {
    isIdle: () => idle,
    enterBusy: () => {
      if (lock === null) {
        lock = args.startLock();
        args.observeLock(lock);
      }
      idle = false;
    },
    enterIdle: () => {
      if (idle) return;
      idle = true;
      if (!args.keepAwakeWhileIdle && lock !== null) {
        lock.stop();
        lock = null;
      }
    },
    stop: () => {
      lock?.stop();
      lock = null;
    },
  };
}

type RunImages = {
  readonly agentImages: AgentImages;
  readonly branchImages: BranchImages;
};

export async function run(
  rawConfig: RunConfig,
  options: RunOptions = {},
): Promise<void> {
  // Before `resolveConfig`, and before the GH_TOKEN check, the lock and
  // preflight — every one of which can end the run with a complaint, and every
  // one of which is a complaint FROM this driver. It needs nothing from the
  // config but the path the bin already resolved, it cannot throw, and it costs
  // a handful of local git calls (#69).
  const driverIdentity = formatDriverIdentity(
    await readDriverIdentity({ configPath: options.configPath ?? null }),
  );

  const config = resolveConfig(rawConfig);
  const env = makeEnvReader(config.env);
  const agentProviders = requiredAgentProviders(config);
  // Every directory the run uses, derived once (#38). `config.cwd` is the
  // operator's checkout and is READ, never operated on; everything sandbar
  // owns hangs off `<cwd>/<workDir>` and is disposable.
  const layout = repoLayout(config.cwd, config.workDir);

  // -------------------------------------------------------------------------
  // Pre-flight: required env vars
  //
  // Sandboxes only see keys declared in the env file (with process.env as
  // fallback for empty values). If GH_TOKEN is missing, every `gh` call
  // inside a sandbox would fail mid-run. Fail fast with an operator-friendly
  // message.
  // -------------------------------------------------------------------------
  if (!env("GH_TOKEN")) {
    console.error(
      `Pre-flight failed: GH_TOKEN is not set.\n` +
        `Sandboxes need a fine-grained PAT to talk to the issue tracker.\n` +
        "Declare it in your sandbar config's `env` — either with the value, or " +
        'as `GH_TOKEN: ""` to inherit it from this process\'s environment.',
    );
    process.exit(1);
  }

  installCleanupTraps();

  // THE WAKE LOCK IS TAKEN FIRST (#117), before the single-instance lock and
  // therefore before preflight and the image builds — which is where the
  // minutes are. A wake lock is a request to the HOST, not a claim on the
  // workdir, so a launch that goes on to lose the lock has taken nothing it
  // has to give back, and nothing here needs the lock to be won first.
  //
  // Its RELEASE is registered further down, beside the event record's, and the
  // ordering there is the actual fix — see that site. Between here and there
  // sit two `process.exit` calls that run no cleanup at all (`GH_TOKEN`, and
  // losing the lock), and neither leaks: the lock's lifetime is the stdin pipe,
  // so a process that dies without releasing releases anyway.
  const initialWakeLock = startKeepawake();

  // The lock comes BEFORE preflight (#32). Preflight is not read-only: it
  // fetches, and it `git branch -D`s every `sandbar/issue-*` branch it finds
  // merged. That delete was the one operation in the whole startup path that
  // mutates the repo, and it was the one operation the single-instance lock did
  // not cover — two launches racing on the same workdir, precisely what the
  // lock exists to stop, both reached it and the loser was only turned away
  // afterwards.
  //
  // Ordering it this way costs nothing. `acquireLock` is `retries: 0`, so a
  // held lock fails immediately — there is no "lock wait" for a config error to
  // avoid by running first. All it changes is which of two true complaints a
  // second launch hears first, and "another sandbar is running" is the
  // actionable one.
  const lockPaths = lockPathsFor(layout.stateDir);
  let release: (() => Promise<void>) | null = null;
  let lastConfigStalenessCount = 0;
  try {
    release = await acquireLock(lockPaths);
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  onCleanup(async () => {
    if (release) await release();
  });

  // -------------------------------------------------------------------------
  // Per-run event record and UI
  //
  // THE FIRST THING THE WINNER DOES (#70). It used to be created fifteen steps
  // further down, after preflight, both sweeps and the image builds — so every
  // refusal above it existed only on a terminal, and the single most
  // operator-actionable thing sandbar produces, a preflight refusal, was the
  // one class of stop that left nothing to read afterwards. A run of
  // 2026-08-31 stopped somewhere in that window and could not be diagnosed at
  // all: there was no run directory on disk to diagnose it from.
  //
  // The invariant that placement was protecting is untouched: non-winners
  // don't litter the `logs/` tree. A loser exits AT `acquireLock`, which is
  // the line above this one. And it costs nothing to move — `repoLayout` is
  // pure path arithmetic, so `layout.logsDir` has been known since well before
  // the lock, and starting the record is one `mkdir -p` plus one append.
  //
  // Append writers are unbuffered, so the cleanup trap only needs to drop a
  // closing run-end marker — no in-memory state to flush.
  //
  // Which exits stay outside the record, and why, is the header's to say: it is
  // one enumeration and it belongs in one place, where it can be counted.
  // -------------------------------------------------------------------------
  const runRecord = await startEventRecord({
    baseDir: layout.logsDir,
    start: {
      driver: driverIdentity,
      configPath: options.configPath ?? null,
      workdir: layout.stateDir,
      maxParallelIssues: config.maxParallelIssues,
      pid: process.pid,
    },
  });
  let cleanupReason = "normal-exit";
  const recordInternalFailure = async (detail: string): Promise<TerminalExit> => {
    const banner = "═".repeat(72);
    console.error(
      `\n${banner}\nSANDBAR HALTED — internal failure\n${banner}\n${detail}\n${banner}`,
    );
    await runRecord.emit({ kind: "complaint", severity: "error", message: detail });
    const exit = haltedExit(["sandbar-internal-error"]);
    cleanupReason = exit.tag;
    await runRecord.emit({
      kind: "exit",
      tag: exit.tag,
      reason: exit.reason,
      exitCode: exit.exitCode,
    });
    return exit;
  };
  const resetCleanupReporter = setCleanupReporter(async (kind, message, cause) => {
    const detail = cause === undefined ? message : `${message}: ${faultDetail(cause)}`;
    if (kind === "internal-failure") {
      await recordInternalFailure(detail);
      return;
    }
    if (kind === "signal") cleanupReason = "signal";
    await runRecord.emit({
      kind: "complaint",
      severity: kind === "signal" ? "warning" : "error",
      message: detail,
    });
  });
  onCleanup(resetCleanupReporter);
  onCleanup(() => runRecord.finalize(cleanupReason));

  const stopInternalFailure = async (err: unknown): Promise<never> => {
    const exit = await recordInternalFailure(faultDetail(err));
    await runCleanup();
    process.exit(exit.exitCode);
  };

  let ui;
  try {
    ui = await startUiServer({
      logsDir: layout.logsDir,
      port: config.uiPort,
      liveRunDir: runRecord.runDir,
      onFailure: async (err) => {
        await runRecord.emit({
          kind: "complaint",
          severity: "error",
          message: `UI: ${faultDetail(err)}`,
        });
      },
    });
  } catch (err) {
    if (!(err instanceof UiPortInUseError)) return await stopInternalFailure(err);
    const detail = faultDetail(err);
    await runRecord.emit({ kind: "complaint", severity: "error", message: detail });
    const exit = haltedExit(["ui-start-failed"]);
    cleanupReason = exit.tag;
    await runRecord.emit({ kind: "exit", tag: exit.tag, reason: exit.reason, exitCode: exit.exitCode });
    await runCleanup();
    process.exit(exit.exitCode);
  }
  onCleanup(() => ui.close());
  // The run's one terminal rendering. Everything else is read from the page.
  console.log(ui.url);

  // THE WAKE LOCK IS RELEASED HERE, and #35's LIFO drain is the whole of #117's
  // ordering: registered immediately after `finalize`, it drains immediately
  // BEFORE it — so every teardown registered later (the image removal below,
  // and every lazy `registerDisposable` a cycle adds) has already run while the
  // host was still forbidden to sleep, and `run-end` is still the last event.
  //
  // It used to be registered at step fifteen, after the image builds, which put
  // it ahead of every teardown, ahead of the lock release and ahead of the
  // `run-end` marker. On 2026-09-03 that cost a run 50 minutes: `exit:
  // relaunch` was printed at 16:33:29.043, the host entered `System Idle` sleep
  // at 16:33:29.049, and `run-end` did not land until 17:23:42 — two seconds
  // after a human touched the keyboard. The run was not over when its exit line
  // was printed, and the lock was.
  //
  // At quiescence the current holder is stopped unless
  // `keepAwakeWhileIdle=true`; a poll that finds work takes a new one. Cleanup
  // stops whichever holder is current.
  //
  // Awaiting the submitted writes is not decoration. Every non-zero exit
  // leaves the drain for `process.exit`, which grants no event-loop turn.
  const statusWrites: Promise<void>[] = [];

  // Whether the host can sleep under this run is an outcome. Wake-lock
  // transitions are bounded and belong in the event record, not stdout.
  //
  // EventRecord already serializes concurrent submissions. Keep each promise
  // only so cleanup can await it, and attach its rejection handler immediately:
  // a delayed handler would let Node's unhandledRejection trap stop a healthy
  // run before cleanup. A failed observation is best-effort at this callback
  // boundary; EventRecord's recovered latch lets the next status append.
  const watchWakeLock = (lock: ReturnType<typeof startKeepawake>): void => lock.onStatus((line, status) => {
    statusWrites.push(
      runRecord.emit({ kind: "wake-lock", state: status.kind, detail: line })
        .then(() => undefined, () => undefined),
    );
  });
  const activity = createRunActivity({
    initialLock: initialWakeLock,
    keepAwakeWhileIdle: config.keepAwakeWhileIdle,
    startLock: startKeepawake,
    observeLock: watchWakeLock,
  });
  onCleanup(async () => {
    activity.stop();
    await Promise.all(statusWrites);
  });

  // The one site that emits an exit (#70/#132), shared by startup refusals and
  // scheduler terminals. It also owns cleanupReason, so run-end agrees with it.
  //
  // It RETURNS the exit rather than assigning `terminalExit` itself, which
  // would be shorter and is wrong: TypeScript does not track assignments made
  // inside a closure, so the `terminalExit` this function ends on would narrow
  // to `null` and the exit CODE taken off it would be unreachable as far as
  // the checker is concerned.
  const announceExit = async (exit: TerminalExit): Promise<TerminalExit> => {
    cleanupReason = exit.tag;
    await runRecord.emit({
      kind: "exit",
      tag: exit.tag,
      reason: exit.reason,
      exitCode: exit.exitCode,
    });
    return exit;
  };

  // Every stop between here and the first cycle goes through this, so none of
  // them can be the silent one again (#70). It records the complaint verbatim,
  // emits the same halted exit event every other terminal path uses, and runs
  // cleanup — which is what recovers the `run.pid` sidecar, since
  // `process.exit` runs no handler.
  //
  // An unexpected error takes the same route rather than escaping to the bin.
  // `faultDetail` retains its stack in the complaint event, so the record has
  // the same diagnostic detail the old stderr-only path carried.
  //
  // `runCleanup` before the exit, because the lock is held by here and
  // `process.exit` runs no cleanup handler. What that actually recovers is the
  // `run.pid` SIDECAR, not the lock directory: proper-lockfile registers its
  // own exit handler and rmdirs every lock it holds even on a bare
  // `process.exit(1)`. So the leak this prevents is a small one — a sidecar
  // naming a pid that will be dead, which the next launch's takeover reads as a
  // crashed run and clears. Cheap, and it keeps every exit path in this file
  // uniform rather than one of them relying on a dependency's exit hook.
  const stopAtStartup = async (
    cause: string,
    err: unknown,
  ): Promise<never> => {
    // `faultDetail` already renders a SandbarError as its bare message and
    // anything else as a stack — errors.ts owns that rule. The one case it does
    // not know about is
    // PreflightError, which extends Error rather than SandbarError and whose
    // message IS the operator-actionable report.
    const detail =
      err instanceof PreflightError ? err.message : faultDetail(err);
    await runRecord.emit({ kind: "complaint", severity: "error", message: detail });
    const exit = await announceExit(haltedExit([cause]));
    await runCleanup();
    process.exit(exit.exitCode);
  };

  // One `repo` for the whole run (#34). Every `gh` call sandbar makes — the
  // planner's queue, the issue anchor, the finalise writes, the merger's closes
  // and the forge-verify polls — names this rather than letting gh infer a
  // repository from whatever directory the command ran in. Preflight is where
  // it is checked against the cache's `origin`, which is the one repository
  // identity sandbar does NOT get from config.
  const repo = { owner: config.ghOwner, name: config.ghRepo };
  let codexAuthMount: CodexAuthMount | undefined;
  let readyLabelPolicy: ReadyLabelPolicy;

  // Preflight is still ahead of the sweep and every container operation below,
  // which is the dependency that matters: those assume a working container
  // runtime because this is what hard-fails when there isn't one.
  try {
    await runRecord.emit({
      kind: "preflight",
      action: "started",
      detail: "Preflight started",
    });
    // The object cache, before anything reads a ref (#38). Created from
    // `config.cwd` when absent — a local clone, so hardlinked and offline —
    // and its `origin` retargeted to whatever URL that checkout carries. Under
    // the lock, because it writes into the state directory; before preflight,
    // because preflight fetches into it.
    //
    // Inside preflight's catch because its failures are the same KIND of
    // failure: `cwd` is not a repo, it has no `origin`, the clone did not
    // work. Every one is a startup complaint an operator acts on, so it is
    // stored as its message alone — a `SandbarError` by `faultDetail`'s own
    // rule, a `PreflightError` by `stopAtStartup`'s one exception to it — and exits,
    // and, unlike letting it escape to the bin, it runs cleanup first, which is
    // what recovers the `run.pid` sidecar.
    await ensureRepoCache(layout, (line) => runRecord.emit({
      kind: "preflight",
      action: "cache-created",
      detail: line,
    }).then(() => undefined));
    const initialConfigStaleness = await runPreflight({
      layout,
      env,
      sourceBranch: config.sourceBranch,
      repo,
      developers: config.developers,
      pulledImages: pulledImagesOf(config),
      // The gate stack is the whole of sandbar's consumer-supplied host-path
      // surface (#51), and a source podman cannot resolve is host state that
      // would otherwise redden the gate against the branch.
      mountSources: absoluteMountSources(config.gateStack.containers),
      // For the one warning that is about the config FILE rather than its
      // contents: nothing refreshes the checkout it was imported from (#66).
      configPath: options.configPath ?? null,
      // Every CLI the three roles route to (#72, #74). A
      // missing key for one of them is a refusal here, where it costs a
      // startup, rather than an in-container death an attempt at a time.
      agentProviders,
      onEvent: (event) => runRecord.emit(event).then(() => undefined),
    });
    const configuredCodexAuth = agentProviders.includes("codex")
      ? env("CODEX_AUTH_JSON")
      : undefined;
    if (configuredCodexAuth !== undefined) {
      const configuredCodexHome = env("CODEX_HOME");
      codexAuthMount = await prepareCodexAuth({
        stateDir: layout.stateDir,
        configuredJson: configuredCodexAuth,
        ...(configuredCodexHome === undefined ? {} : { codexHome: configuredCodexHome }),
      });
    }
    lastConfigStalenessCount = initialConfigStaleness.configStaleness.touchingConfig;
    readyLabelPolicy = initialConfigStaleness.readyLabelPolicy;
  } catch (err) {
    return await stopAtStartup("preflight-failed", err);
  }

  // Derived from the CANONICAL path the lock is held on, so lock and
  // scope agree: one lock ⇔ one namespace of podman names (#28). Everything
  // this run creates lives under it, and the sweep below reaches nothing else
  // — a concurrent run against another workdir is invisible to us and we to it.
  //
  // `realpathSync`, not the raw string, and not `resolve` either. The two have
  // to partition the host IDENTICALLY, and proper-lockfile resolves symlinks on
  // the path it locks (`realpath: true` is its default). `resolveConfig` now
  // makes `config.cwd` absolute (#34), which retires the first of the two ways
  // this went wrong and leaves the second exactly where it was:
  //   - Two repos both configured `cwd: "."` used to hash the same `.sandbar`
  //     and share one scope while correctly holding two locks — #28, verbatim,
  //     with this module's own comments asserting it cannot happen. `resolve`
  //     closes that, and it closes it in config.ts rather than here, because a
  //     relative cwd is wrong for reasons that have nothing to do with scoping.
  //   - One workdir reached through a symlink is STILL one lock but two scopes
  //     under `resolve` alone, so a crashed run's debris lands in a scope no
  //     later run computes and no report names (it IS scoped, just not ours) —
  //     invisible and unreapable. Only `realpathSync` closes that one.
  // acquireLock has already mkdirSync'd the directory, so this cannot ENOENT.
  const scope = runScope(realpathSync(lockPaths.workDir));

  // ALL THREE SWEEPS IN ONE `try`, because all three THROW on a failed LIST
  // and none of them used to sit inside anything (#70). The throw is right at
  // the other end — `containers.ts` and `ensure-images.ts` both argue that a
  // failed list is a blind sweep, which cannot know what it missed, so stopping
  // beats asserting "no debris" on no evidence — but the stop it produced
  // escaped `run()` to the bin, which is the exact shape this issue exists to
  // end: no `stopped (…)` line, no `Exit (…)`, no cleanup, and nothing on disk
  // in a window this run had already won the lock for. Preflight passed moments
  // earlier, so what reaches here is a socket that dropped or a systemd session
  // that went away between two podman calls — host state an operator can act
  // on, and now host state they can still read afterwards.
  //
  // One `try` and one cause for the three: they are one step (take stock of
  // what a previous run left behind), they fail for one reason, and the
  // complaint recorded beside the cause names which podman call it was.
  try {
    const orphans = await cleanupOrphanContainers(scope);
    if (orphans.removed.length > 0) {
      await runRecord.emit({ kind: "sweep", scope: "startup", removed: orphans.removed, failures: [] });
    }
    await reportSweepFailures(orphans, (event) => runRecord.emit(event), "startup");

    // The image half of the same sweep (#37). Per-branch gate images are
    // removed at the end of a run, but that removal is an `onCleanup` action
    // and so does not run on SIGKILL, a hard crash, or a `podman build` that
    // outlived its parent — and these are the largest things sandbar creates.
    // Startup only: within a run they are reused, and they carry this scope, so
    // anything found here belongs to a predecessor of this workdir that is
    // provably not running.
    const staleImages = await sweepBranchImages(scope);
    if (staleImages.removed.length > 0) {
      await runRecord.emit({ kind: "sweep", scope: "startup", removed: staleImages.removed, failures: [] });
    }
    await reportSweepFailures(staleImages, (event) => runRecord.emit(event), "startup");

    // Debris no run's scope claims: from a build predating #28, or the
    // sandcastle era. Reported rather than removed, because a bare-prefix match
    // cannot tell it from a concurrently-running old sandbar's LIVE resources —
    // which is the failure #28 exists to end. Nothing clears it but the
    // operator, so this repeats every startup until they run the commands.
    const unattributable = await findUnattributableResources();
    if (unattributable.names.length > 0) {
      await runRecord.emit({
        kind: "complaint",
        severity: "warning",
        message: `${unattributable.names.length} podman resource(s) carry a sandbar name from ` +
          "before this version's per-run scoping and cannot be attributed to any " +
          "run, so sandbar will not remove them. If no other sandbar is running, " +
          "clear them with:\n" +
          unattributable.removalCommands.map((c) => `  ${c}`).join("\n"),
      });
    }
  } catch (err) {
    return await stopAtStartup("startup-sweep-failed", err);
  }

  // Build the sandbar image in the runtime if missing. No-op when it already
  // exists, so warm runs pay only one `image exists` call. After lock
  // acquisition so concurrent launches against THIS workdir can't race the
  // build — note that is all the lock buys here. Image tags are the one podman
  // resource class the run scope does not partition (they are host-supplied
  // names, and `config.images` maps tag → Containerfile), so two workdirs
  // sharing a `sandboxImage` tag on one host will race the build and then
  // silently share whichever image won. On a shared host, give each workdir its
  // own tag.
  //
  // The build context is a COMMIT, not a directory someone was standing in
  // (#38 item 4). `ensureImages` runs before any issue worktree exists, so its
  // context used to be `config.cwd` — whatever the operator had checked out,
  // uncommitted edits included. `worktrees/source` is detached at
  // `origin/<sourceBranch>` and reset to it here, after preflight's fetch, so
  // the fingerprint recorded on each image is a true claim about a named tree.
  // #37's validation moves with it: `rebuildOn`'s must-exist check and
  // `checkWorktreeImageUids` both resolve against this root.
  // Wrapped because these two used to escape `run()` uncaught, exactly as the
  // sweeps above did: the SandbarError went to the bin, which printed it and
  // exited without running cleanup and without the event record hearing about
  // it (#70). An unbuildable declared image and a bad uid are ordinary
  // host-configuration faults, and they are now recorded like every other
  // refusal.
  // The three build entry points' record seam (#82). Rebuilding an image
  // changes what every container in the run executes, which is an outcome —
  // and it used to be announced by `console.log` alone. `run()` now records the
  // image event and captures build output; `sandbar gate` retains CLI progress.
  // All THREE seams are silenced — the per-branch one too, since
  // `branchImages.resolve` runs per attempt and per landing for the whole run
  // and a `Rebuilding …` line from it would interleave with the UI URL.
  const recordImage = (r: ImageBuildRecord): Promise<void> =>
    runRecord.emit({
      kind: "image",
      action: r.built ? "built" : "reused",
      image: r.tag,
      durationMs: r.durationMs,
      detail: formatImageRecord(r),
    }).then(() => undefined);

  let initialSourceWorktree: string;
  let initialBaseFingerprints: ReadonlyMap<string, string>;
  let initialAgentImages: AgentImages;
  try {
    initialSourceWorktree = await ensureSourceWorktree(layout, config.sourceBranch);
    initialBaseFingerprints = await ensureImages(config.images, initialSourceWorktree, {
      onImage: recordImage,
      log: () => undefined,
      captureBuild: true,
    });
    initialAgentImages = await createAgentImages({
      declaredBaseTag: config.sandboxImage,
      providers: agentProviders,
      ...(codexAuthMount === undefined
        ? {}
        : { codexHome: dirname(codexAuthMount.sandboxPath) }),
      scope,
      onImage: recordImage,
      log: () => undefined,
    });
  } catch (err) {
    return await stopAtStartup("image-build-failed", err);
  }

  // Per-branch gate images (#37). One instance for the whole run — every issue
  // and the merger share it, because the per-branch tag is content-addressed
  // and two branches that make the same dependency change must produce one
  // build rather than two.
  //
  // Registered for cleanup HERE, before the first stack exists, so LIFO order
  // puts the image removal after every container that could still be running
  // one of them.
  const makeBranchImages = (fingerprints: ReadonlyMap<string, string>): BranchImages =>
    createBranchImages({
      images: config.images,
      scope,
      baseFingerprints: fingerprints,
      onImage: recordImage,
      log: () => undefined,
      worktreeMountingTags: worktreeMountingTagsOf(config.gateStack),
      hostUid: process.getuid?.() ?? 0,
    });
  const initialBranchImages = makeBranchImages(initialBaseFingerprints);
  let currentImages: RunImages = {
    agentImages: initialAgentImages,
    branchImages: initialBranchImages,
  };
  const branchImageRuns = [initialBranchImages];
  const agentImageRuns = [initialAgentImages];
  onCleanup(async () => {
    // Augmented images are FROM-children of branch variants. Remove leaves
    // first so podman can then remove their parents.
    const tags = [
      ...agentImageRuns.flatMap((images) => [...images.builtTags()]),
      ...branchImageRuns.flatMap((images) => [...images.builtTags()]),
    ];
    if (tags.length === 0) return;
    const failures = await removeBranchImages(tags);
    if (failures.length > 0) {
      await runRecord.emit({
        kind: "complaint",
        severity: "warning",
        message: `Could not remove ${failures.length} per-branch gate image(s) built ` +
          "for this run. They cost disk and nothing else — the tags are " +
          "content-addressed and scoped, so a leftover is reused rather than " +
          `mistaken for something current:\n${failures.join("\n")}`,
      });
      // Cleanup is LIFO, so this outcome is recorded before run-end.
    }
  });

  // After the builds, because the images have to exist to be probed and a
  // freshly-built one is the likeliest to be wrong. Before any stack starts,
  // because the alternative is an unexplained EACCES twenty minutes into a gate
  // (#24 D3).
  //
  // The declared images. A per-branch variant is not covered here — it does not
  // exist yet — but it is not exempt: `createBranchImages` re-probes one it has
  // just built, and reports a bad uid as a gate red, because the recipe that
  // changed the uid came from the branch.
  try {
    await checkWorktreeImageUids(config.gateStack, process.getuid?.() ?? 0);
  } catch (err) {
    return await stopAtStartup("image-uid-check-failed", err);
  }

  const silentNoopAttemptsByIssue = new Map<string, number>();
  const providerState = createRunProviderState();
  // CODEX_AUTH_JSON is a driver input now, not a process credential. The
  // shared file above is the only copy containers need (#134).
  const sandboxEnv = Object.fromEntries(
    Object.entries(config.env).filter(([key]) => key !== "CODEX_AUTH_JSON"),
  );
  // The one stop this run ends on (#70). Every break out of the loop below
  // assigns it what `announceExit` has already emitted, and the process exit
  // code comes off it at the bottom of the function — so "did this stop
  // normally?" is answered by one event in one place, on every path, instead of
  // by four spellings of which one printed nothing at all. It also retires a
  // second `exitCode` variable that had to be kept in step with the tag by
  // hand.
  let terminalExit: TerminalExit | null = null;

  // One finalization pass. Called before a landing for agent terminals and
  // after it for the merger's own outcomes (#30). The
  // `label` is only there so the two finalise event groups are distinguishable.
  //
  // A required side-effect that fails (push/comment/label/close) throws
  // SandbarError out of finalizeAll — caught by the loud top-level handler,
  // never swallowed here.
  const runFinalize = async (
    label: string,
    inputs: readonly FinalizeInput[],
  ): Promise<void> => {
    if (inputs.length === 0) return;
    const finalizeAdapter = realFinalizeAdapter({
      layout,
      repo,
      sourceBranch: config.sourceBranch,
      onNotice: (message) => runRecord.emit({
        kind: "complaint", severity: "warning", message,
      }).then(() => undefined),
    });
    const finalizeResults = await finalizeAll(
      inputs,
      finalizeAdapter,
      config.labels,
    );
    for (const r of finalizeResults) {
      const issue = r.input.issue;
      const tag = (() => {
        switch (r.action.kind) {
          case "deleted-local":
            return "deleted local branch";
          case "delete-failed":
            return `delete failed (${r.action.error})`;
          case "pushed":
            return "pushed branch";
          case "parked-local":
            return "parked; branch preserved locally";
          case "kept-branch":
            return r.action.reason;
          case "skipped-closed":
            return "skipped (issue already closed)";
          case "noop":
            return "no action";
          default: {
            const exhaustive: never = r.action;
            return exhaustive;
          }
        }
      })();
      await runRecord.emit({
        kind: "finalise",
        issue: issueNumberOf(issue),
        title: issue.title,
        finaliseKind: r.input.kind,
        outcome: r.action.kind,
        detail: tag,
      });
    }
    // finalizeAll has already performed durable tracker and branch effects.
    // Record every one before a read-back mismatch halts the run, so the halt
    // adds its complaint to the outcome record instead of erasing that record.
    await verifyFinalizedTrackerState(
      finalizeResults,
      (issueNum) => finalizeAdapter.issueLabels(issueNum),
    );
  };

  // Issue numbers merged+closed earlier in THIS run. The listing endpoint the
  // planner uses lags label/close writes, so without this an issue
  // merged in a prior iteration can resurface as a candidate, get re-planned,
  // and get stamped agent-stuck on a closed-COMPLETED issue (#16). Fed to
  // buildPlan as a hard exclusion alongside its live-state CLOSED check.
  const mergedThisRun = new Set<number>();

  // One adapter for the whole run, like `repo` itself: the chunk-review scan
  // (#95) reads and writes the same repository at every recompute.
  const followUpAdapter = realChunkFollowUpAdapter({
    repo,
    repoDir: layout.repoDir,
    sourceBranch: config.sourceBranch,
  });

  // One admission queue for every gate pod in this run (#142), independent of
  // issue execution slots and shared with the serialized landing path below.
  const gateSemaphore = createGateSemaphore(config.maxConcurrentGates);

  const innerLoopCfg = {
    layout,
    repo,
    sourceBranch: config.sourceBranch,
    env: sandboxEnv,
    implementerModelId: config.implementerModelId,
    uiPrototypeCheck: config.uiPrototypeCheck,
    uiCheckModelId: config.uiCheckModelId,
    reviewerModelId: config.reviewerModelId,
    reviewerQualityModelId: config.reviewerQualityModelId,
    implementerAgent: config.implementerAgent,
    uiCheckAgent: config.uiCheckAgent,
    reviewerAgent: config.reviewerAgent,
    reviewerQualityAgent: config.reviewerQualityAgent,
    implementerEffort: config.implementerEffort,
    uiCheckEffort: config.uiCheckEffort,
    reviewerEffort: config.reviewerEffort,
    reviewerQualityEffort: config.reviewerQualityEffort,
    maxQualityRounds: config.maxQualityRounds,
    maxReviewRounds: config.maxReviewRounds,
    sandboxImage: config.sandboxImage,
    ...(codexAuthMount === undefined ? {} : { codexAuthMount }),
    scope,
    gateStack: config.gateStack,
    claudeMdPath: config.claudeMdPath,
    contextMdPath: config.contextMdPath,
    adrDir: config.adrDir,
    promptExtensions: config.promptExtensions,
  };

  type IssueOutcome = { issue: PlannedIssue; terminal: Terminal };
  type ExecutionEvent = SettledIssue<PlannedIssue, Terminal>;
  const pool = new ContinuousPool<PlannedIssue, Terminal>(
    config.maxParallelIssues,
    (issue) => issue.id,
  );
  let providerExitPending: TerminalExit | null = null;
  let nextPlanTrigger: RecomputeTrigger = "launch";
  let deferredChunksForRecompute: string[] = [];
  let landingNumber = 0;
  let iteration = 0;
  let lastPlanDiagnostics: string | null = null;
  const deferredLandBranches = new Set<string>();

  const emitRecompute = async (
    iteration: number,
    trigger: RecomputeTrigger,
    resolution: PlanResolution,
    admittedIssues: readonly PlannedIssue[],
    landRequests: readonly { readonly branch: string }[],
  ): Promise<void> => {
    const active = new Map(
      [...pool.ongoingIssues(), ...admittedIssues].map((issue) => [
        Number(issue.id),
        { issue: Number(issue.id), title: issue.title },
      ] as const),
    );
    const admitted = new Set(admittedIssues.map((issue) => Number(issue.id)));
    const waiting = new Map(
      resolution.waiting.map((entry) => [entry.issue, entry] as const),
    );
    // `resolution.waiting` is relative to the planner's K-sized selection,
    // while this event promises the scheduler's actual admission. A drain,
    // queued retry, or exhausted start budget can leave a planned issue
    // unadmitted; keep it visible rather than dropping it between those two
    // layers. Planned issues are otherwise eligible, so `no-slot` is the one
    // vocabulary reason that applies at this scheduler boundary.
    for (const issue of resolution.plan) {
      const issueNumber = Number(issue.id);
      if (admitted.has(issueNumber)) continue;
      waiting.set(issueNumber, {
        issue: issueNumber,
        title: issue.title,
        reason: { kind: "no-slot" },
      });
    }
    await runRecord.emit({
      kind: "recompute",
      n: iteration,
      trigger,
      admitted: admittedIssues.map((issue) => ({
        issue: Number(issue.id), title: issue.title,
      })),
      active: [...active.values()],
      waiting: [...waiting.values()].sort((a, b) => a.issue - b.issue),
      landRequests: landRequests.map((request) => request.branch),
      deferredChunks: deferredChunksForRecompute,
      candidates: resolution.candidates.map((issue) => ({
        issue: Number(issue.id),
        title: issue.title,
        branch: issue.branch,
        chunk: issue.chunk?.branch ?? null,
        ready: issue.ready,
      })),
      refs: await readIssueBranchRefs(layout.repoDir),
    });
    for (const excluded of resolution.waiting) {
      if (excluded.reason.kind !== "label-actor") continue;
      const actor = excluded.reason.actor === null
        ? "an unknown actor (no usable application was present in the fetched timeline window)"
        : `@${excluded.reason.actor}`;
      await runRecord.emit({
        kind: "complaint",
        severity: "warning",
        message: `Issue #${excluded.issue} (${excluded.title}) excluded from the queue: ` +
          `the most recent recorded \`ready-for-agent\` application was by ${actor}.`,
      });
    }
    deferredChunksForRecompute = [];
  };

  // Consume freed-slot results through the same finalization path whether the
  // landing path is healthy or already halted. DONE has no terminal handoff;
  // when `finishDone` is true its branch is simply left for the next run rather
  // than sent through the failed landing path again.
  const finalizeSettled = async (
    settled: readonly ExecutionEvent[],
    finishDone = false,
  ): Promise<IssueOutcome[]> => {
    const outcomes: IssueOutcome[] = [];
    for (const event of settled) {
      if (event.status === "fulfilled") {
        outcomes.push({ issue: event.issue, terminal: event.value });
      } else {
        pool.finishRejected(event.issue);
      }
    }
    await runFinalize("agent terminals", terminalFinalizeInputs(outcomes));
    for (const outcome of outcomes) {
      if (finishDone || outcome.terminal.type !== "DONE") {
        pool.finishTerminal(outcome.issue);
      }
    }
    return outcomes;
  };

  const drainAfterLandingHalt = async (): Promise<void> => {
    while (
      pool.activeCount > 0 ||
      pool.hasCompleted ||
      pool.hasPendingTerminals
    ) {
      if (!pool.hasPendingTerminals) await pool.waitForFreedSlot();
      const drained = pool.takeLandingBatch();
      if (drained.length > 0) await finalizeSettled(drained, true);
    }
  };

  const cleanupLandingResources = async (
    cleanups: readonly (() => Promise<void>)[],
    landingFailure: unknown | null,
  ): Promise<void> => {
    const cleanupFailures: unknown[] = [];
    for (const cleanup of cleanups) {
      // allSettled classifies cleanup failure as data without adding another
      // catch-and-continue site; the loop remains sequential because the stack
      // must stop before its bind-mounted worktree is removed.
      const [result] = await Promise.allSettled([
        Promise.resolve().then(cleanup),
      ]);
      if (result?.status === "rejected") cleanupFailures.push(result.reason);
    }
    if (cleanupFailures.length === 0) return;
    const primaryFailure = landingFailure ?? cleanupFailures[0];
    const secondaryFailures = landingFailure === null
      ? cleanupFailures.slice(1)
      : cleanupFailures;
    for (const cleanupErr of secondaryFailures) {
      const detail = faultDetail(cleanupErr);
      await runRecord.emit({
        kind: "complaint",
        severity: "error",
        message: "Landing resource cleanup also failed: " + detail,
      });
    }
    if (landingFailure === null) throw primaryFailure;
  };

  const recordLandingOutcome = async (outcome: MergerOutcome): Promise<void> => {
    switch (outcome.kind) {
      case "merged":
        await runRecord.emit({
          kind: "landed",
          outcome: "merged",
          issue: issueNumberOf(outcome.issue),
          title: outcome.issue.title,
          branch: outcome.issue.branch,
          target: config.sourceBranch,
          reason: null,
          durationMs: outcome.durationMs,
        });
        return;
      case "chunk-landed":
        await runRecord.emit({
          kind: "landed",
          outcome: "chunk-landed",
          issue: issueNumberOf(outcome.landing.issue),
          title: outcome.landing.issue.title,
          branch: outcome.landing.issue.branch,
          target: outcome.landing.chunkBranch,
          reason: null,
          durationMs: outcome.durationMs,
        });
        return;
      case "skipped":
        await runRecord.emit({
          kind: "landed",
          outcome: "skipped",
          issue: issueNumberOf(outcome.issue),
          title: outcome.issue.title,
          branch: outcome.issue.branch,
          target: null,
          reason: outcome.reason,
          durationMs: outcome.durationMs,
        });
        return;
      case "chunk-on-source":
        await runRecord.emit({
          kind: "landed",
          outcome: "chunk-on-source",
          branch: outcome.target.branch,
          target: config.sourceBranch,
          reason: null,
          durationMs: outcome.durationMs,
        });
        return;
      case "chunk-parked":
        await runRecord.emit({
          kind: "landed",
          outcome: "chunk-parked",
          branch: outcome.skipped.target.branch,
          target: null,
          reason: outcome.skipped.reason,
          durationMs: outcome.durationMs,
        });
        return;
      case "chunk-deferred":
        await runRecord.emit({
          kind: "landed",
          outcome: "chunk-deferred",
          branch: outcome.deferred.target.branch,
          target: null,
          reason: `member work in flight (${outcome.deferred.landedNow
            .map((member) => `#${member.number}`).join(", ")})`,
          durationMs: outcome.durationMs,
        });
        return;
    }
  };

  const refreshSourceImages = async (): Promise<void> => {
    activity.enterBusy();
    const nextSourceWorktree = await ensureSourceWorktree(layout, config.sourceBranch);
    const nextBaseFingerprints = await ensureImages(config.images, nextSourceWorktree, {
      onImage: recordImage,
      log: () => undefined,
      captureBuild: true,
    });
    const nextAgentImages = await createAgentImages({
      declaredBaseTag: config.sandboxImage,
      providers: agentProviders,
      ...(codexAuthMount === undefined
        ? {}
        : { codexHome: dirname(codexAuthMount.sandboxPath) }),
      scope,
      onImage: recordImage,
      log: () => undefined,
    });
    const nextBranchImages = makeBranchImages(nextBaseFingerprints);
    currentImages = {
      agentImages: nextAgentImages,
      branchImages: nextBranchImages,
    };
    agentImageRuns.push(nextAgentImages);
    branchImageRuns.push(nextBranchImages);
  };

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  try {
    for (;;) {
      iteration += 1;
      const planTrigger: RecomputeTrigger = nextPlanTrigger;
      let sourceChangedOnPoll = false;
      if (planTrigger === "poll") {
        const refresh = await fetchOriginRefs(layout.repoDir, config.sourceBranch);
        if (refresh.failures.length > 0) {
          const message =
            `Poll refresh failed; retrying in ${config.pollIntervalMs}ms: ` +
            refresh.failures.join("; ");
          await runRecord.emit({ kind: "complaint", severity: "warning", message });
          nextPlanTrigger = await pool.waitForWake(config.pollIntervalMs);
          continue;
        }
        // A terminal is eligible again only after the poll has refreshed the
        // refs that planning and branch sync consume. A failed refresh is not
        // a poll boundary and must not spend that guard.
        pool.beginPoll();
        sourceChangedOnPoll = refresh.sourceChanged;
        if (sourceChangedOnPoll) {
          const line = `origin/${config.sourceBranch} moved during poll; refreshing source images`;
          await runRecord.emit({ kind: "preflight", action: "origin-refreshed", detail: line });
          await refreshSourceImages();
        }
      }
      // -----------------------------------------------------------------------
      // Between-recompute orphan sweep. Phase 2/3/4 already tear down their own
      // resources in finally blocks, and startStack registers its teardown
      // BEFORE creating any podman resource — but a signal in the window where
      // the pod exists and the process is already unwinding can still leave a
      // pod, its invisible infra container or a network behind, which would
      // then collide with a later stack create. Cheap insurance.
      // -----------------------------------------------------------------------
      // A slot-free recompute commonly has sibling stacks still running under
      // this same scope. The sweep cannot distinguish those live resources
      // from debris, so its licence exists only when the pool is quiescent.
      if (iteration > 1 && pool.isQuiescent) {
        const cycleOrphans = await cleanupOrphanContainers(scope);
        if (cycleOrphans.removed.length > 0) {
          await runRecord.emit({ kind: "sweep", scope: "quiescent", removed: cycleOrphans.removed, failures: [] });
        }
        await reportSweepFailures(cycleOrphans, (event) => runRecord.emit(event), "quiescent");
      }

      const configStaleness = await readConfigStaleness({
        layout,
        sourceBranch: config.sourceBranch,
        configPath: options.configPath ?? null,
      });
      const configStalenessChanged =
        configStaleness.touchingConfig !== lastConfigStalenessCount;
      if (configStalenessChanged) {
        const configWarning = staleConfigWarning(configStaleness);
        const line = configWarning ??
          `Config staleness cleared: ${configStaleness.configPath ?? "programmatic config"} ` +
          `is no longer behind a change from origin/${config.sourceBranch}.`;
        await runRecord.emit({ kind: "complaint", severity: "warning", message: line });
      }
      lastConfigStalenessCount = configStaleness.touchingConfig;

      // ---------------------------------------------------------------------
      // Phase 1: Plan
      // ---------------------------------------------------------------------
      const planOptions = {
        excluded: new Set([
          ...mergedThisRun,
          ...[...pool.startedIds()].map(Number),
        ]),
        defaultLane: config.defaultLane,
        readyLabelPolicy,
        k: Math.max(0, config.maxParallelIssues - pool.activeCount),
        repoDir: layout.repoDir,
        ongoing: new Set([...pool.startedIds()].map(Number)),
      };
      let resolution = await buildPlan(repo, planOptions);

      // The chunk-review scan (#95). Every chunk with work on origin is asked
      // whether a human has requested changes on its pull request, and each
      // review that has not already been handled is routed to and re-queues
      // the landed member(s) it concerns. Inert until a chunk's first landing:
      // `landedChunks` is empty, and the scan makes no call at all.
      //
      // RE-PLANNED when it re-queues anything. The existing issues are handed
      // back rather than re-listed: the listing `gh issue list` serves lags a
      // label flip by seconds (#96), so it may not carry the re-queue this
      // cycle made.
      const followUps = await routeChunkReviewFollowUps({
        chunks: resolution.landedChunks,
        adapter: followUpAdapter,
        log: (line) => runRecord.emit({ kind: "follow-up", action: "route", detail: line }).then(() => undefined),
      });
      if (followUps.length > 0) {
        const filed = followUps.map((f) => `#${f.number}`).join(", ");
        await runRecord.emit({
          kind: "follow-up",
          action: "re-queued",
          detail: `Re-queued ${followUps.length} chunk member(s): ${filed}`,
        });
        resolution = await buildPlan(repo, {
          ...planOptions,
          extraCandidates: followUps,
        });
      }

      // ---------------------------------------------------------------------
      // Reconcile chunks that reached the source branch without us (#64)
      //
      // Between the plan and everything downstream of it, because it is the
      // one step whose whole job is to make the tracker agree with git before
      // anything reads either. It needs the derivation the plan just built
      // (only that graph knows which issues are on a chunk branch), and what
      // it does — closing members, dropping `needs-review` — changes the answer to
      // every question the plan asked, so the plan is REBUILT when it acted.
      //
      // Rebuilt immediately rather than left stale for the next recompute: closing a member
      // unblocks its dependents. Without the re-plan a chunk somebody merged by
      // hand would reconcile and then leave newly unblocked issues waiting for
      // the next poll instead of admitting them in this recompute.
      // The re-plan reads the same authoritative GraphQL batch, which is
      // strongly consistent about the closes just made even while the candidate
      // listing lags.
      const reconciliation = await reconcileLandedChunks({
        repoDir: layout.repoDir,
        repo,
        sourceBranch: config.sourceBranch,
        chunks: resolution.landedChunks,
        log: (line) => runRecord.emit({ kind: "reconcile", action: "trace", detail: line }).then(() => undefined),
      });
      if (reconciliation.reconciled.length > 0) {
        for (const r of reconciliation.reconciled) {
          await runRecord.emit({
            kind: "reconcile",
            action: "landed-chunk",
            detail: `${r.target.branch} already on ${config.sourceBranch}; closed ${r.closed.length} issue(s)`,
          });
        }
        // Same exclusion the merger's own closes get (#16): the listing
        // endpoint the planner uses lags a close by seconds, so an
        // issue closed one line ago can still come back as a candidate.
        for (const n of reconciliation.closedIssues) mergedThisRun.add(n);
        // Carrying `followUps` again: a member re-queued a block above carries
        // a label flip younger than anything the listing can see, so a re-plan
        // without it would drop the work this cycle just queued.
        // `planOptions.excluded` is
        // `mergedThisRun` itself, so the numbers just added are already in it.
        resolution = await buildPlan(repo, {
          ...planOptions,
          extraCandidates: followUps,
        });
      }
      // What the reconciler left behind, in the three shapes it comes in
      // (#64). Split rather than reported as one list, and each report counting
      // its own chunks: three chunks reconciling with one stray label is one
      // chunk with bookkeeping left over, and calling it three sends a human
      // looking for leftovers that are not there. The claim differs too — a
      // KEPT branch really is retried at the next recompute, while a retired chunk's
      // leftovers are reached through a branch that no longer exists, so
      // promising a retry for those is promising nothing.
      //
      // Neither halts. See `chunk-reconcile.ts`'s header: this pass IS the
      // retry the merge phase halts to defer to, and it runs again at the top
      // of every recompute, so stopping the run in front of it would spend the
      // whole run on a repair that repairs itself.
      const reconcileResidue = chunkResidue(reconciliation.reconciled);
      // The twin of the merge phase's own report, one phase down and for the
      // same reason: a branch already on the source branch that no chunk
      // claims is deleted having closed nothing, and the only trace of it left
      // afterwards is this line. Ordinary when a human closed the members out
      // by hand; the one thing it can also be is a member whose merge commit the
      // derivation lost, which is a repair nothing else will ever offer.
      if (reconcileResidue.unnamed.length > 0) {
        await runRecord.emit({ kind: "complaint", severity: "warning", message:
          CHUNK_LANDED_UNNAMED_BANNER({
            chunks: reconcileResidue.unnamed,
            sourceBranch: config.sourceBranch,
            provenance: "reconciled",
          }) });
      }
      if (reconcileResidue.untidy.length > 0) {
        await runRecord.emit({ kind: "complaint", severity: "warning", message:
          CHUNK_RESIDUE_RETIRED_BANNER({
            chunks: reconcileResidue.untidy,
            sourceBranch: config.sourceBranch,
            provenance: "reconciled",
          }) });
      }
      if (reconcileResidue.kept.length > 0) {
        await runRecord.emit({ kind: "complaint", severity: "error", message:
          CHUNK_RESIDUE_KEPT_BANNER({
            chunks: reconcileResidue.kept,
            sourceBranch: config.sourceBranch,
            provenance: "reconciled",
          }) });
      }

      // What a human has asked to land, read AFTER the reconciliation so a
      // chunk it just finished off is not also merged again by the merge phase
      // (its branch is gone by then, which the merger would park on, but
      // asking in this order means it never gets there).
      const selectedLandRequests = selectLandRequests(
        await fetchLandRequestPullRequests(repo, LAND_LABEL),
        resolution.landedChunks,
      );
      const landRequests: ReturnType<typeof selectLandRequests> = planTrigger === "landing-finished"
        ? selectedLandRequests.filter((request) => !deferredLandBranches.has(request.branch))
        : selectedLandRequests;
      if (landRequests.length > 0) {
        const named = landRequests
          .map((r) => `${r.branch} (PR #${r.pullRequest})`)
          .join(", ");
        await runRecord.emit({ kind: "reconcile", action: "land-requested", detail: named });
      }

      const laneNoticeLines: string[] = [];
      const laneNotices = await postLaneOverrideNotices(
        repo,
        resolution.overrides,
        (line) => { laneNoticeLines.push(line); },
      );
      const planDiagnostics = JSON.stringify({
        waiting: resolution.waiting,
        overrides: resolution.overrides,
        landedChunks: resolution.landedChunks,
        chunkNameDrifts: resolution.chunkNameDrifts,
        selectedLandRequests,
      });
      const planDiagnosticsChanged = lastPlanDiagnostics !== null &&
        planDiagnostics !== lastPlanDiagnostics;
      lastPlanDiagnostics = planDiagnostics;
      const chunkDriftLines = resolution.chunkNameDrifts.map((drift) => {
        const derived = drift.derived ?? "no chunk branch can be derived";
        return (
          `Origin chunk branch ${drift.existing} no longer matches the name ` +
          `derived for its root: ${derived}`
        );
      });

      const providerClosed = providerExitPending !== null || agentProviders.some(
        (provider) => providerState.get(provider) !== undefined,
      );
      // The plan record is the resolver's answer, not the narrower admission
      // this observation may make. Active slots, cooldown and scheduler state
      // can all reduce admission without changing what the planner resolved.
      const schedulerAction = decideSchedulerAction({
        active: pool.activeCount,
        ongoing: pool.ongoingCount,
        hasCompleted: pool.hasCompleted,
        hasPendingTerminals: pool.hasPendingTerminals,
        hasCandidates: pool.hasUnstarted(resolution.plan),
        hasRetries: pool.hasRetries,
        hasLandRequests: landRequests.length > 0,
        hasCapacity: pool.activeCount < config.maxParallelIssues,
        noProgressSinceLanding: pool.noProgressSinceLanding,
        noProgressBackstop: MAX_CONSECUTIVE_NO_PROGRESS_WITHOUT_LANDING,
        providerClosed,
      });
      const pollDidWork =
        sourceChangedOnPoll || configStalenessChanged || planDiagnosticsChanged ||
        followUps.length > 0 || laneNotices.length > 0 ||
        reconciliation.reconciled.length > 0 || landRequests.length > 0 ||
        schedulerAction.kind === "admit" || schedulerAction.kind === "land";
      const pollIsReportable = pollDidWork || resolution.waiting.some(
        (entry) => entry.reason.kind === "label-actor",
      );
      if (planTrigger === "poll" && pollDidWork) {
        activity.enterBusy();
      }
      if (schedulerAction.kind === "exit") {
        await emitRecompute(iteration, planTrigger, resolution, [], landRequests);
        terminalExit = await announceExit(
          schedulerExit(
            schedulerAction.reason,
            pool,
            providerExitPending ?? closedProviderExit(config, providerState),
          ),
        );
        break;
      }

      const admission = schedulerAction.kind === "admit"
        ? pool.admit(resolution.plan)
        : [];
      const executionIssues = [...admission];
      const issues = executionIssues;
      if (issues.length > 0) {
        activity.enterBusy();
      }
      if (planTrigger !== "poll" || pollIsReportable) {
        await emitRecompute(iteration, planTrigger, resolution, issues, landRequests);
        for (const line of chunkDriftLines) {
          await runRecord.emit({ kind: "complaint", severity: "warning", message: line });
        }
        for (const line of laneNoticeLines) {
          await runRecord.emit({ kind: "follow-up", action: "lane-override", detail: line });
        }
      }
      // ---------------------------------------------------------------------
      // Execute (inner-loop ralph)
      // ---------------------------------------------------------------------

      // The terminal event is written by the task that terminated (#82).
      //
      // It used to be appended by the reporting loop below, after
      // `Promise.allSettled` — so every terminal in a cohort carried the
      // cohort's SETTLE instant and appeared in PLAN order. One observed cycle
      // logged an issue that finished at 19:46 and one that finished at 19:54
      // as having both finished in the same millisecond, which destroys exactly
      // the two questions #77 §3.E turns on: which issue held the cycle, and
      // how long the others idled.
      //
      // It was also a #70 coverage hole. An issue reaching DONE at 19:46 had
      // its outcome written at 19:54; a Ctrl-C or a sibling's throw in between
      // and the record of that outcome never existed at all — for work sitting
      // committed on a branch. The catch rethrows so the pool still observes
      // and finalizes a rejected task.
      const admissionImages = currentImages;
      const admissionConfig = {
        ...innerLoopCfg,
        agentImages: admissionImages.agentImages,
      };
      for (const issue of executionIssues) {
        const issueLogger = await runRecord.issue(issue.id);
        const task: Promise<Terminal> = (async () => {
          const issueTimer = startTimer();
          try {
            const terminal = await runInnerLoop(issue, {
              config: admissionConfig,
              hooks: config.sandboxHooks,
              copyToWorktree: config.copyToWorktree,
              branchImages: admissionImages.branchImages,
              // Sandbox-sibling logs land beside this issue's attempt
              // transcripts (#44 D4), so the offline artefact of what the
              // agent's stack was doing sits next to the transcript of what the
              // agent did.
              sandboxLogBaseDir: issueLogger.dir,
              attemptLogger: issueLogger,
              gateSemaphore,
              onEvent: (event) => runRecord.emit(event).then(() => undefined),
              providerState,
            });
            const durationMs = issueTimer();
            await runRecord.emit({
              kind: "terminal",
              issue: Number(issue.id),
              title: issue.title,
              terminal: terminal.type,
              reason: terminalReason(terminal),
              durationMs,
            });
            return terminal;
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            await runRecord.emit({
              kind: "terminal",
              issue: Number(issue.id),
              title: issue.title,
              terminal: "REJECTED",
              reason,
              durationMs: issueTimer(),
            });
            throw err;
          }
        })();
        pool.start(issue, task);
      }

      // A recompute with no new candidate can still have running work. Wait
      // only for the next freed slot; siblings remain live and the next full
      // plan is built immediately around them.
      let settled: ExecutionEvent[];
      if (
        schedulerAction.kind === "land" ||
        (schedulerAction.kind === "admit" && schedulerAction.next === "land")
      ) {
        activity.enterBusy();
        settled = [...pool.takeLandingBatch()];
      } else {
        if (pool.activeCount === 0 && !activity.isIdle()) {
          await runRecord.emit({ kind: "idle", pollIntervalMs: config.pollIntervalMs });
          activity.enterIdle();
        }
        const wake = await pool.waitForWake(config.pollIntervalMs);
        nextPlanTrigger = wake;
        continue;
      }
      const landingLogger = runRecord.landing(++landingNumber);

      // The batch's terminals are finalised BEFORE the landing is attempted
      // (#30). These are the issues the merger will never see — NEEDS-INFO
      // questions, NEEDS-HUMAN handoffs, reviewer prose, branch pushes — and
      // running them after it meant any non-MergerError throw from the
      // landing (a ContainerBringupError from the merger stack is the live
      // example) escaped to the top-level handler before a single one was
      // written, so an issue kept `ready-for-agent` and burned through its
      // inner-loop budgets again next run. The mirror-image risk is strictly
      // smaller: a
      // required side-effect failing here stops the run before the landing,
      // and a DONE branch that misses its landing keeps its commits and its
      // label, so preflight classifies it `resumable` (#13). The prose an
      // agent produced once and nobody stored has no such fallback.
      const outcomes = await finalizeSettled(settled);

      const completedIssues = outcomes
        .filter((o) => o.terminal.type === "DONE")
        .map((o) => o.issue);


      // ---------------------------------------------------------------------
      // Phase 3: Merge (procedural, in an isolated worktree off origin)
      // ---------------------------------------------------------------------
      let mergerSummary: MergerSummary | null = null;
      // Tracker state the merger had already applied when it threw (see
      // MergerError.partial). Finalised even though the run is stopping.
      let haltPartial: MergerSummary | undefined;
      let halt = false;
      let mergerProviderError: AgentQuotaError | AgentCredentialError | null = null;
      let unexpectedLandingFailure: { readonly error: unknown } | null = null;
      // Why the run is stopping, in the short names the run log already uses.
      // Declared up here rather than beside the reports that fill it because
      // the merge phase's own halt is one of them, and the `Exit (halted): …`
      // line has to be able to name it (#70).
      const haltReasons: string[] = [];
      // Also for a land request alone (#64): a reviewed chunk merging onto the
      // source branch needs the same worktree, the same gate-2 stack and the
      // same resolve loop a DONE branch does, and a cycle can have one without
      // the other.
      if (completedIssues.length > 0 || landRequests.length > 0) {
        const landingImages = currentImages;
        // The merger runs in a dedicated worktree detached at
        // origin/<sourceBranch>, NOT a checkout anyone stands in — so the
        // operator's uncommitted edits can never be swept into a merge commit
        // (issue #10; since #38 the worktree hangs off the bare cache, which
        // makes the same guarantee structural rather than procedural).
        // Worktree BEFORE stack: the stack's mounts bind-mount fixture files
        // from it (#20). createMergerWorktree and
        // startStack each register their own teardown as a disposable (#55); we
        // also tear both down in the finally below. One stack serves gate-2 for
        // every branch in the landing batch — its issue-lifecycle containers start once.
        let mergerWorktree: MergerWorktree | null = null;
        let mergerStack: Stack | null = null;
        try {
          mergerWorktree = await createMergerWorktree({
            layout,
            sourceBranch: config.sourceBranch,
          });
          const mergerWorktreePath = mergerWorktree.path;
          mergerStack = await startStack({
            stackId: MERGER_STACK_ID,
            scope,
            spec: config.gateStack,
            worktreePath: mergerWorktree.path,
            hideWorktreeGit: true,
            onNotice: (message) => runRecord.emit({
              kind: "complaint", severity: "warning", message,
            }).then(() => undefined),
            // gate-2 needs this as much as gate-1 does (#37): the merge result
            // is a tree neither branch had, and two branches that each touched
            // the lockfile compose into a third lockfile. Resolved per gate
            // run, so each merge in the landing is gated against its own.
            images: (only) => landingImages.branchImages.resolve(mergerWorktreePath, only),
          });
          const stackForGate2 = mergerStack;
          const adapter = realAdapter({
            cwd: mergerWorktree.path,
            cacheDir: layout.repoDir,
            scope,
            repo,
            sourceBranch: config.sourceBranch,
            botName: config.botName,
            botEmail: config.botEmail,
            coauthorTrailer: config.coauthorTrailer,
            mergerAgent: config.mergerAgent,
            mergerModelId: config.mergerModelId,
            mergerEffort: config.mergerEffort,
            sandboxImage: landingImages.agentImages.declaredTag,
            env,
            ...(codexAuthMount === undefined ? {} : { codexAuthMount }),
            runStackGate: () => gateSemaphore.run(() => stackForGate2.runGate()),
          });

          // The only site that supplies the probe tree by hand — the two
          // prompt builders derive theirs (#34). The resolve agent reads this
          // worktree, so it is the right tree; be precise about WHEN, though,
          // because the anchor is one string built once for the whole cycle
          // and this runs before any merge. At probe time the worktree is
          // detached at `origin/<sourceBranch>`, so a doc added by a branch in
          // THIS cycle is still not visible to it. What this buys over the
          // run-start source worktree is only that it moves with origin
          // between cycles; the within-cycle case is a known residual, and
          // closing it would mean rebuilding the anchor per resolve attempt.
          const projectAnchor = await buildProjectAnchor(
            {
              repo,
              repoDir: layout.repoDir,
              claudeMdPath: config.claudeMdPath,
              contextMdPath: config.contextMdPath,
              adrDir: config.adrDir,
              sourceBranch: config.sourceBranch,
            },
            mergerWorktree.path,
          );
          // Verified merge mode (#22): the forge gates the landing. Wired here
          // rather than inside the merger so the merger stays adapter-driven —
          // its type demands the verify adapter exactly when the mode is on.
          const verified =
            config.mergeMode.kind === "verified"
              ? {
                  adapter: realVerifyAdapter({
                    cwd: mergerWorktree.path,
                    sourceBranch: config.sourceBranch,
                    repo,
                    onNotice: (message) => runRecord.emit({
                      kind: "complaint", severity: "warning", message,
                    }).then(() => undefined),
                  }),
                  options: verifiedLandingOptionsFrom(
                    config.mergeMode,
                    config.sourceBranch,
                  ),
                }
              : undefined;

          // The whole merge phase — #77 §1's "merge phase, 3 branches" row,
          // which was hand-arithmetic off two adjacent timestamps (#82). This
          // timer becomes one landing-batch event; each landed event receives
          // its own merge-unit duration from the merger observation boundary.
          const mergePhaseTimer = startTimer();
          mergerSummary = await runMergerWithAdapter(
            completedIssues,
            adapter,
            (line) => landingLogger.appendMerger(line),
            (issueId, gate) => landingLogger.writeMergerGate(issueId, gate),
            {
              ongoingIssues: pool.ongoingIssues(),
              projectAnchor,
              promptExtension: config.promptExtensions.merger,
              // #67: every resolve attempt's stdout and stderr, beside the
              // gate artefact it was prompted from. The writer answers with
              // the path, which is what the abandon comment points at.
              onResolveAttempt: (key, record) =>
                landingLogger.writeResolveAttempt(key, record),
              observations: {
                onGate: (key, gate) => {
                  const issueId = key.startsWith("chunk-") ? key.slice("chunk-".length) : key;
                  const planned = completedIssues.find((issue) => issue.id === issueId);
                  return runRecord.emit({
                    kind: "gate",
                    gate: "gate-2",
                    issue: Number(issueId),
                    ...(planned ? { title: planned.title } : {}),
                    ok: gate.ok,
                    durationMs: gate.durationMs,
                    ...(gate.queuedMs === undefined ? {} : { queuedMs: gate.queuedMs }),
                    steps: Object.fromEntries(
                      gate.steps.map((step) => [step.name, step.durationMs]),
                    ),
                  }).then(() => undefined);
                },
                onOutcome: recordLandingOutcome,
              },
              ...(verified ? { verified } : {}),
              ...(landRequests.length > 0
                ? {
                    chunkLanding: {
                      requests: landRequests,
                      sourceBranch: config.sourceBranch,
                    },
                  }
                : {}),
            },
          );
          await runRecord.emit({
            kind: "landing-batch",
            n: landingNumber,
            durationMs: mergePhaseTimer(),
          });
        } catch (err) {
          if (err instanceof MergerError) {
            if (
              err.cause instanceof AgentQuotaError ||
              err.cause instanceof AgentCredentialError
            ) {
              mergerProviderError = err.cause;
              recordProviderClosure(providerState, err.cause);
            }
            // A MergerError built by the merger's `asHalt` wraps an underlying
            // error as `cause`. When that was an unexpected bug rather than an
            // operator-actionable SandbarError, its stack is the only thing
            // that locates it — and THIS branch is the one that does not reach
            // the top-level handler below, which would have printed it. Same
            // rule as that handler: SandbarError prints as its message alone.
            const cause = err.cause;
            const trace =
              cause instanceof Error && !(cause instanceof SandbarError)
                ? `\n${cause.stack ?? cause.message}`
                : "";
            await runRecord.emit({
              kind: "complaint",
              severity: "error",
              message: `Merger halted: ${err.message}${trace}`,
            });
            halt = true;
            haltReasons.push("merger-halted");
            // `announceExit` overwrites this at the break below, so what this
            // assignment covers is only the window in between — and that window
            // is the post-merge finalise pass, which makes `gh` writes and can
            // take a while. A signal arriving in it should not leave
            // `run-end (normal-exit)` on a run whose merger has already thrown.
            cleanupReason = "merger-halted";
            // The halt stops the OUTER loop; it must not strand issues the
            // merger already commented on and stripped `ready-for-agent` from.
            // Those need their handoff label applied before we stop, or they
            // sit on no queue at all — invisible to the planner and to a human
            // filtering on `agent-stuck`. Nothing here lands code ON THE SOURCE
            // BRANCH: `merged` is always empty on this path. `chunkLanded`
            // (#60) may not be, and that is not a contradiction — those commits
            // are on origin's chunk branch and the issues receive `needs-review`
            // label whether the landing went on to halt or not.
            haltPartial = err.partial;
            if (haltPartial && haltPartial.merged.length > 0) {
              throw new Error(
                "MergerError.partial must never report merged issues: a halt " +
                  "means nothing landed.",
              );
            }
          } else {
            // Unknown failures are not merger verdicts. Carry the original
            // value across the resource cleanup below, drain sibling work,
            // then let the outer internal-failure handler report it unchanged.
            unexpectedLandingFailure = { error: err };
          }
        } finally {
          // Stack first: its containers bind-mount the worktree. Both teardown
          // attempts run even when the first fails. If landing already failed,
          // teardown is secondary: report it here and preserve that original
          // failure for the internal-failure boundary below.
          const stackToStop = mergerStack;
          const worktreeToRemove = mergerWorktree;
          const cleanups = [
            stackToStop ? () => stackToStop.stop() : null,
            worktreeToRemove ? () => worktreeToRemove.remove() : null,
          ].filter((cleanup): cleanup is () => Promise<void> => cleanup !== null);
          await cleanupLandingResources(
            cleanups,
            unexpectedLandingFailure?.error ?? null,
          );
        }
        if (unexpectedLandingFailure) {
          // Cleanup-shaped, so it follows the cleanup rule: the drain reports
          // its own failure beside the original and the ORIGINAL is what
          // escapes. A drain that threw in place of the landing failure would
          // hand the internal-failure banner the wrong fault — a finalize
          // hiccup on a sibling instead of the landing that actually broke —
          // and the log would name a cause the operator cannot act on.
          try {
            await drainAfterLandingHalt();
          } catch (drainErr) {
            const detail = faultDetail(drainErr);
            await runRecord.emit({
              kind: "complaint",
              severity: "error",
              message: "Draining in-flight work after the landing failure also failed: " + detail,
            });
            throw unexpectedLandingFailure.error;
          }
          throw unexpectedLandingFailure.error;
        }
      }

      // ---------------------------------------------------------------------
      // Phase 4b: Finalise the merge outcomes
      // ---------------------------------------------------------------------
      // On a halt, `haltPartial` carries what the merger had already applied to
      // the tracker; its `merged` is empty by construction (asserted above), so
      // this only ever produces handoff inputs.
      const mergerOutcome = halt ? haltPartial : mergerSummary;
      if (mergerOutcome) {
        deferredLandBranches.clear();
        for (const deferred of mergerOutcome.deferredChunks) {
          deferredLandBranches.add(deferred.target.branch);
        }
        const { inputs, bumpedSilentNoop } = mergeFinalizeInputs(
          mergerOutcome,
          silentNoopAttemptsByIssue,
          outcomes,
        );
        for (const [issueId, attempts] of bumpedSilentNoop) {
          silentNoopAttemptsByIssue.set(issueId, attempts);
        }
        const freshAttempts = new Set(
          inputs
            .filter((input) => input.kind === "fresh-attempt")
            .map((input) => input.issue.id),
        );
        // Merged-and-closed only. A chunk landing (#60) is deliberately NOT
        // added: `excluded` means "this run already merged it to the source
        // branch". Git membership de-queues a chunk member without tracker lag.
        for (const m of mergerOutcome.merged) {
          mergedThisRun.add(issueNumberOf(m));
        }
        // A chunk landing on the SOURCE branch (#64) is a different matter: its
        // members really were closed and their work really is on the source
        // branch, so they belong here for exactly the reason `merged` does —
        // the listing endpoint the planner uses lags a close by seconds,
        // and a re-picked closed issue is #16 verbatim. `mergedChunks` is empty
        // on the halt path by construction, since the wrap-up only ever runs
        // after the source branch has moved.
        for (const c of mergerOutcome.mergedChunks) {
          for (const n of c.closed) mergedThisRun.add(n);
        }
        // Deferred, not parked (#61 + #64 + #94): member work arrived this
        // remains ongoing or queued for rework, so the label stays on. Preserve
        // the branch for the next recompute; its event was recorded with the
        // rest of the merger outcome above, including on the halt path.
        for (const c of mergerOutcome.deferredChunks) {
          deferredChunksForRecompute.push(c.target.branch);
        }
        await runFinalize("merge outcomes", inputs);
        for (const input of inputs) {
          if (input.kind === "fresh-attempt") {
            pool.retry(input.issue as PlannedIssue);
          }
        }
        for (const issue of completedIssues) {
          if (!freshAttempts.has(issue.id)) pool.finishTerminal(issue);
        }
      }

      // Record every durable tracker mismatch before any of them stops the
      // run. None may gate on another having stayed quiet: they share a cause —
      // a `gh` that is having a bad minute — so a cycle that hits one hits the
      // others more often than a cycle picked at random does, and the complaint
      // that lost would be the operator's only notice that some issue is
      // closed-in-name-only. The exit event names every cause rather than only
      // the first.

      // #64 — a landed chunk whose wrap-up did not entirely finish, in the same
      // two shapes the reconcile-side report above uses (`chunkResidue`) and
      // with the same two claims. What differs here is that one of them ENDS
      // THE RUN.
      //
      // WHAT HALTS is a chunk still on origin: some member would not close, or
      // the branch delete itself failed. The work is on the source branch and
      // the tracker does not agree with it, the cycle's reconcile pass is
      // already behind us, and carrying on would keep landing work past a
      // repair whose next attempt is a whole cycle away.
      //
      // WHAT DOES NOT HALT is a chunk that retired cleanly and left a cosmetic
      // line behind: a `needs-review` label that would not come off a CLOSED issue
      // (the wrap-up calls that harmless itself, and the planner never reads
      // that display label), or a pull request that would not close. Neither leaves an
      // issue on no queue, and halting on one would abandon the rest of the
      // queued work over a label — while promising a next-run repair that
      // cannot happen, since the branch those lines came with is gone.
      const landedChunks = mergerSummary?.mergedChunks ?? [];
      const landedResidue = chunkResidue(landedChunks);

      // A chunk that landed while naming no member to close. Sandbar honours
      // such a request on purpose — a human labelled a branch that origin has,
      // and refusing would leave them holding a label nothing reads — and the
      // usual reason for it is benign: every member was closed by hand already.
      // But the wrap-up cannot tell that from a member whose merge commit
      // the derivation never saw, and it deletes the branch either way (see
      // `chunk-land.ts`), so nothing will ever look at this chunk again. That
      // is a warning rather than a halt: the commits are on the source branch
      // and the only repair left is one a human makes on the tracker.
      if (landedResidue.unnamed.length > 0) {
        await runRecord.emit({ kind: "complaint", severity: "warning", message:
          CHUNK_LANDED_UNNAMED_BANNER({
            chunks: landedResidue.unnamed,
            sourceBranch: config.sourceBranch,
            provenance: "sandbar",
          }) });
      }
      if (landedResidue.untidy.length > 0) {
        await runRecord.emit({ kind: "complaint", severity: "warning", message:
          CHUNK_RESIDUE_RETIRED_BANNER({
            chunks: landedResidue.untidy,
            sourceBranch: config.sourceBranch,
            provenance: "sandbar",
          }) });
      }
      if (landedResidue.kept.length > 0) {
        await runRecord.emit({ kind: "complaint", severity: "error", message:
          CHUNK_RESIDUE_KEPT_BANNER({
            chunks: landedResidue.kept,
            sourceBranch: config.sourceBranch,
            provenance: "sandbar",
          }) });
        haltReasons.push("chunk-wrapup-incomplete");
      }

      // Post-push close failures (issue #14): the merges are durable on origin
      // and Phase 4b above already dropped `ready-for-agent` for every merged
      // issue, so the planner won't re-pick them — but they're still OPEN on the
      // tracker. Surface them as an operator-actionable list and halt loud,
      // AFTER finalise so the merged work is fully reconciled locally.
      if (mergerSummary && mergerSummary.unclosed.length > 0) {
        const list = mergerSummary.unclosed
          .map((u) => `#${issueNumberOf(u.issue)} (${u.error})`)
          .join(", ");
        await runRecord.emit({
          kind: "complaint",
          severity: "error",
          message: `Merger pushed all merges but could not close ` +
            `${mergerSummary.unclosed.length} issue(s) after retries: ${list}.\n` +
            "Their merges are durable on origin and `ready-for-agent` was removed " +
            "during finalise, so the planner will NOT re-pick them — but they " +
            "remain OPEN. Close them manually to reconcile the tracker.",
        });
        haltReasons.push("merger-close-failed");
      }

      if (haltReasons.length > 0) halt = true;

      const selectedExit = selectTerminalExit({
        mergerProviderError,
        haltReasons: halt ? haltReasons : [],
        terminals: outcomes.map((outcome) => outcome.terminal),
        otherwise: () => null,
      });
      // Two counts, because they answer two questions. `sourceLandings` is
      // "did origin/<sourceBranch> move" — the image-rebuild question, since an
      // image that bakes dependencies is a function of that branch (#37).
      // `landedNow` is "did work leave the pool as durable progress", which is
      // what the backstop asks, and a DONE branch landed on
      // its chunk branch (#60) is a yes: on a review-lane host that is the
      // ONLY way work ever leaves, so a backstop counting source merges alone
      // would exit stuck after six landed issues. Chunk landings are pushed
      // as they happen, independently of `pushed`, which is the source push.
      const sourceLandings = mergerSummary && mergerSummary.pushed
        ? mergerSummary.merged.length + mergerSummary.mergedChunks.length
        : 0;
      const landedNow = sourceLandings + (mergerSummary?.chunkLanded.length ?? 0);
      pool.recordLandingOutcome(
        outcomes.length,
        landedNow,
      );
      nextPlanTrigger = landRequests.length > 0 || landedNow > 0
        ? "landing-finished"
        : "terminal-finalized";
      if (sourceLandings > 0) {
        await refreshSourceImages();
      }
      if (selectedExit?.tag === "quota" || selectedExit?.tag === "credential") {
        providerExitPending = selectedExit;
      }
      if (selectedExit?.tag === "halted") {
        // No new admission occurs between selecting this halt and leaving the
        // loop. Let every sibling reach a terminal and persist its handoff;
        // DONE branches remain queued for a later run because this landing path
        // has already proved unsafe to reuse.
        await drainAfterLandingHalt();
        terminalExit = await announceExit(selectedExit);
        break;
      }
    }

  } catch (err) {
    // A sandbar-internal failure escaped the scheduler. This shared path also
    // owns unexpected UI startup failures: only EADDRINUSE is a classified
    // startup refusal; everything else remains an internal failure.
    return await stopInternalFailure(err);
  }

  if (terminalExit === null) {
    throw new Error("scheduler loop ended without a terminal exit");
  }
  const finalExit = terminalExit;

  await runCleanup();
  if (finalExit.exitCode !== 0) process.exit(finalExit.exitCode);
}
