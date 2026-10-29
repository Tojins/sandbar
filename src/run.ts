// Sandbar orchestrator — continuous execution pool plus serialized landing.
//
// Repository ownership (#139) is the prerequisite for all of it. The local
// workdir lock still protects `.sandbar/`; after the read-only forge
// reachability probe, an independent ten-minute lease at
// `refs/sandbar/lock` protects the origin shared by every host. The event
// record starts only after both are held, so a second host's refusal remains
// stderr-only. A serialized one-minute heartbeat covers long operations;
// scheduler wakes and every remote-write adapter also renew immediately before
// control can admit, finalize or land. A replacement ref, or an expired lease
// that origin cannot renew, exits halted immediately: no drain, no landing,
// and issue clones deferred at inner-loop close remain in place.
// Cleanup owns terminal serialization too: once another caller has begun its
// drain, lease loss rejects the write barrier without appending another
// complaint or exit event. No adapter may interpret teardown as permission to
// write after cleanup has released the ref.
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
//                              inherited gating. The pull requests carrying
//                              `land`/`land-hotfix` are read first: their
//                              chunks are FROZEN (#243, `chunks.ts`). A
//                              changes-requested review on an unfrozen
//                              chunk's pull request is routed to its landed
//                              member(s) and re-queues them (#95), and the
//                              RECONCILER (#64) finishes off any chunk branch
//                              already contained in origin/<sourceBranch> —
//                              hand-merged, or landed by a run that died
//                              before it could close the members. The plan is
//                              rebuilt after either, so a member re-queued now
//                              is carried into this recompute and one closed now
//                              stops blocking its dependents.
//   Execution pool:           Each issue runs in its own sandbox under two
//                              independent consecutive-failure budgets
//                              (#129/#143/#185). maxGateRounds covers red
//                              gate-1 results and pre-gate re-prompts, and
//                              resets on green. maxReviewRounds covers only
//                              correctness rejection. Each round is the
//                              quality pass (lister, then fixer and verify
//                              within maxQualityRounds, #187), gate-1, then
//                              correctness.
//                              APPROVED → DONE; CHANGES-REQUESTED loops back
//                              to a new impl attempt carrying its prose.
//                              Reviewer harness failure spends none, leaves the
//                              convergence counters unchanged, and its second
//                              occurrence in the inner loop stops it (#41/#143).
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
//                              (#64) — at which point the next recompute starts
//                              the landing even while unrelated issues run
//                              (#168), the chunk branch is
//                              merged in the SAME source pass, its members are
//                              closed, and the branch is deleted. Even issues
//                              dispatched to it do not hold it: the label
//                              freezes the chunk (#243), and a DONE one waits
//                              in the pool until it lands or the label comes
//                              off.
//                              A chained member whose other blocker became
//                              CLOSED waits until its origin chunk contains
//                              origin/source (#174). The same landing path
//                              merges source into that existing chunk after
//                              source landings, gates it, and pushes directly;
//                              an unsalvageable composition parks the dependent.
//                              A chunk stacked on another (#243) is refreshed
//                              onto that one's tip the same way whenever it
//                              lacks it; one no member waits for is tried
//                              once per process while it fails.
//                              Since that work is never owed to a drain,
//                              every admission-closing drain leaves it for
//                              the next run.
//                              While `config.landingWindow` is closed (#244,
//                              `landing-window.ts`), each recompute keeps a
//                              chunk's `land` request out of the pass (not a
//                              `land-hotfix` one) and holds a DONE auto-lane
//                              issue in the pool until it opens. A chunk
//                              stacked on another (#243) keeps its `land`
//                              waiting until that one has landed.
//                              When origin moves under the source push and
//                              the merge result cannot follow it (#253), the
//                              pass lands nothing and does not halt: its
//                              issues are held in the pool with a notice, and
//                              the next landing pass re-merges each onto the
//                              new tip.
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
// every fact after both the workdir and origin locks are won (#132, #139). Raw
// agent, gate, merger and resolve transcripts stay beside it as files. `run()`
// hosts the file-fed UI; stdout contains its URL only. Land requests record
// their queued/deferred reason and each merge/gate-2/push transition so that
// UI status is event evidence rather than reducer inference (#168). After the record exists,
// routine recoveries are notice events in the feed, while conditions that may
// need human action are complaint events in the header too (#172); stderr is
// reserved for the internal-failure banner.
// Container-backed events retain cgroup peak-memory and OOMKilled evidence;
// merger-stack lifecycle records are emitted after teardown (#141).
//
// Each admission's inner-loop config and each issue's `terminal` event are
// built by `innerLoopConfigOf` and `terminalEventOf`, which replay (#195)
// shares, so a replayed record has the shape of a run's.
//
// The gate stack is a `StackSource` that preflight opens after its fetch
// (#186): with `gateStack: { path }`, every inner-loop gate-1 and every
// landing reads the stack from `origin/<sourceBranch>` as last fetched, so a
// landed stack change takes effect at the next gate without a restart.
//
// The locks are the record boundary (#70, #139). Refused config, missing
// GH_TOKEN, forge-unreachable-before-origin-lock and either refused lock remain
// stderr-only because no run owns both scopes yet. The winner immediately emits
// run-start, including driver identity, before preflight and image preparation.
// Every terminal path the run selects emits one structured exit, and cleanup
// appends run-end; a signal is the one ending with no exit event — cleanup.ts
// owns that exit (#35), so the record carries a complaint and `run-end
// (signal)`. Readers use run.pid plus run-end to distinguish live, crashed and
// ended runs.
//
// At capacity below `maxParallelIssues`, one cancellable wait races the next
// slot completion against `pollIntervalMs`. A poll refreshes source, issue,
// chunk and member refs; every recompute refreshes those namespaces again at
// the planning boundary so containment never reads a pre-push cache (#174).
// A failed refresh at either boundary is
// recorded as a feed-only notice and waits for the next wake instead of
// killing the daemon, unless
// `decideAfterFailedRefresh` says this daemon is a drained restart whose exit
// reads no refs at all (#146); startup preflight remains fatal. A planning
// `gh` read the forge never answered (`isForgeTransportFailure`: transport
// faults, gateway 502/503/504 and truncated bodies) takes the same
// notice-and-retry path; a forge ANSWER still halts, except GitHub's rate
// limit (`isForgeRateLimit`), which records one notice and holds planning
// until the quota resets (`forge-rate-limit.ts`). A no-op poll is silent. A stable label-actor
// exclusion is recorded on each poll because its required diagnostic
// makes that recompute reportable. Source movement from either
// a human push or this process latches an image-input refresh; the next
// healthy storage measurement performs it, while a low-space drain keeps it
// pending without starting another build.
// Each successful poll refresh and each landing pass that landed work kick the
// deploy watch (#198, `deploy-watch.ts`) unless tracker reads are held: one
// tick in flight at most, never awaited, and stopped by cleanup ahead of the
// lease release and run-end. A rate limit it meets sets planning's hold.
// With `config.databaseCopies`, every recompute also reads the nightly base
// import's outcome (#201, `db-base.ts`): each new attempt is a `db-base`
// event, and a missing or stale dump or a failed import is a complaint once
// per run. The import itself runs beside the daemon, never in it. The
// run's own copies of that base (`db-copy.ts`) come from one registry every
// inner loop shares, one copy per issue; they are swept at startup, after
// the orphan containers, and again at each quiescent sweep.
// With `config.janitor` (#205), a recompute with nothing to admit or land and
// a free slot starts the idle task due next (`dueJanitorTask`, `janitor.ts`)
// beside the pool. Its run is no pool member — never finalised, landed or
// counted by the stuck backstop — but holds one slot until it has settled:
// admission, drains and the idle event count it. A candidate it keeps out, a
// `land` on its own pull request, or any stop aborts it (`preempt-janitor`),
// and its end wakes the scheduler (`janitor-finished`). That `land` is a land
// request like a chunk's: it waits for a closed landing window, then the
// merger lands the branch and retires it, and the source moved. With no tasks
// configured, none of this reads a ledger or asks the forge anything.
// Agent and branch images are replaced as one bundle and captured by each
// admission, so a poll cannot change the images beneath in-flight work.
// An egress allowlist (#202) builds the proxy image once at startup and hands
// every sandbox, gate stack and resolve attempt the same `EgressContext`, its
// proxies logging under `<runDir>/egress/`. Preflight warns, first, when
// `databaseCopies` is configured beside open or report-mode egress.
// Every gate-1 and gate-2 call passes through one run-wide FIFO semaphore
// (#142). `maxConcurrentGates` bounds its permits; absence is unlimited, and
// queue time is evidence on the gate event rather than a scheduling decision.
// The origin lease renewal wraps that same wait and therefore precedes either
// wake's effects. A separate heartbeat uses the same serialized renewal
// operation so a long gate or forge wait cannot consume the lease between
// scheduler wakes. Free space on Podman's graphroot is measured after startup
// reconciliation but before image preparation, then at every recompute (#169).
// A low reading latches admission closed and drains; active-cycle healthy
// readings cannot reopen it. Reconciliation and the deciding remeasurement
// happen only once the pool is quiescent, so image removal cannot race a live
// gate or sandbox build. With `config.databaseCopies` the database volume is
// measured beside the graphroot, against its own floor, and feeds the same
// latch; the latch holds every low reading and the exit names each.

import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import {
  type JanitorTask,
  type ResolvedConfig,
  type RunConfig,
  egressStartupWarning,
  resolveConfig,
} from "./config.js";
import {
  AgentCredentialError,
  AgentQuotaError,
  reclaimIssueClone,
} from "./agent-sandbox.js";
import {
  type SweepResult,
  cleanupOrphanContainers,
  findUnattributableResources,
} from "./containers.js";
import {
  beginCleanup,
  installCleanupTraps,
  onCleanup,
  registerDisposable,
  runCleanup,
  setCleanupReporter,
} from "./cleanup.js";
import {
  routeChunkReviewFollowUps,
  realAdapter as realChunkFollowUpAdapter,
} from "./chunk-follow-up.js";
import {
  type ChunkSettleMemory,
  UNSETTLED,
  rememberPollGraph,
  settledGraphFor,
} from "./chunks.js";
import {
  formatDriverIdentity,
  readDriverIdentity,
} from "./driver-identity.js";
import {
  agentToolsImageTags,
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
  worktreeMountingTagsOf,
} from "./ensure-images.js";
import { reconcileImages } from "./image-lifecycle.js";
import {
  type EgressContext,
  type OwnerEgress,
  currentEgressImageTag,
  egressReport,
  ensureEgressImage,
  ownerEgress,
} from "./egress.js";
import { makeEnvReader } from "./env.js";
import { startTimer } from "./timing.js";
import {
  type DbVolumeSpace,
  type GraphRootSpace,
  dbVolumeSpace,
  dbVolumeSpaceIsLow,
  formatLowDbVolumeSpace,
  formatLowGraphRootSpace,
  graphRootSpace,
  graphRootSpaceIsLow,
  podmanGraphRoot,
} from "./disk-space.js";
import { createDbBaseWatch } from "./db-base.js";
import { createDbCopies, sweepDbCopies } from "./db-copy.js";
import { createDeployWatcher, realDeployWatchAdapter } from "./deploy-watch.js";
import {
  SandbarError,
  faultDetail,
  isForgeRateLimit,
  isForgeTransportFailure,
} from "./errors.js";
import { fetchRateLimitResumeAt } from "./forge-rate-limit.js";
import {
  runStampFromDate,
  startEventRecord,
  type EventInput,
  type EventSubject,
  type RecomputeTrigger,
} from "./events.js";
import {
  type TerminalExit,
  MAX_CONSECUTIVE_NO_PROGRESS_WITHOUT_LANDING,
  haltedExit,
  credentialExit,
  quotaExit,
  restartExit,
  storageExit,
  stuckExit,
} from "./exit-conditions.js";
import {
  clearRestartRequest,
  readRestartRequest,
  restartRequestPath,
} from "./restart-request.js";
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
import {
  type InnerLoopConfig,
  type IssueRef,
  type Terminal,
  runInnerLoop,
} from "./inner-loop.js";
import { type IssueSource, ghIssueSource } from "./issue-anchor.js";
import { requiredAgentProviders } from "./agent-providers.js";
import { LockHeldError, acquireLock, lockPathsFor } from "./lock.js";
import {
  OriginLeaseLostDuringCleanupError,
  OriginLockHeldError,
  ORIGIN_LOCK_RENEW_INTERVAL_MS,
  acquireOriginLock,
  formatOriginLockHolder,
  type OriginLockHandle,
  type OriginLockRenewal,
} from "./origin-lock.js";
import { type RunScope, janitorTaskFromStackId, runScope } from "./naming.js";
import { type JanitorRunDeps, dueJanitorTask, realJanitorForge, runJanitor, settleJanitorRun } from "./janitor.js";
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
import { createGateSemaphore } from "./gate-semaphore.js";
import { containerResourcesOf } from "./container-resources.js";
import { usageFields } from "./agent-usage.js";
import {
  CHUNK_ISSUE_BRANCHES_KEPT_BANNER,
  CHUNK_LANDED_UNNAMED_BANNER,
  CHUNK_RESIDUE_KEPT_BANNER,
  CHUNK_LAND_WINDOW_PR_COMMENT,
  CHUNK_RESIDUE_RETIRED_BANNER,
  type ChunkLandTarget,
  JANITOR_RESIDUE_BANNER,
  type JanitorLandTarget,
  type JanitorWrapup,
  chunkForgeWrites,
  chunkResidue,
  describeChunkBranchDrift,
  refuseLandRequest,
  selectLandRequests,
} from "./chunk-land.js";
import {
  fetchLandRequestPullRequests,
  reconcileLandedChunks,
} from "./chunk-reconcile.js";
import { landingClosedUntil, waitsForLandingWindow } from "./landing-window.js";
import { postLaneOverrideNotices } from "./lanes.js";
import {
  type BuildPlanOptions,
  type PlanResolution,
  type PlannedIssue,
  type ReadyLabelPolicy,
  buildPlan,
  readIssueBranchRefs,
} from "./plan-resolver.js";
import {
  ContinuousPool,
  chunkRefreshRequestsAreRunnable,
  decideAfterFailedRefresh,
  decideSchedulerAction,
  restartDueReason,
  type RestartDueReason,
  type SchedulerExit,
  type SettledIssue,
} from "./scheduler.js";
import {
  checkForgeReachabilityForPreflight,
  checkStackOnHost,
  fetchOriginRefs,
  fetchPlanningRefs,
  PreflightError,
  runPreflightAfterReachability,
} from "./preflight.js";
import { buildProjectAnchor } from "./prompt.js";
import { repoSlug } from "./repo-ref.js";
import {
  type RepoLayout,
  ensureRepoCache,
  ensureSourceWorktree,
  repoLayout,
  worktreePathFor,
} from "./repo-cache.js";
import { renderStackDifferences, stackChangeOf } from "./stack-change.js";
import {
  type BoundStack,
  type StackSource,
  bindStack,
  openStackSource,
} from "./stack-source.js";
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

export type OriginLockWakeDecision =
  | { readonly kind: "continue"; readonly notice: string | null }
  | { readonly kind: "halt"; readonly complaint: string; readonly exit: TerminalExit };

// The scheduler-side half of the origin lease contract (#139), pure so both
// loss shapes are pinned without running a daemon. A halt has no "drain" or
// "land" continuation by construction; the caller records it and exits.
export function decideOriginLockWake(
  renewal: OriginLockRenewal,
): OriginLockWakeDecision {
  if (renewal.kind === "renewed") return { kind: "continue", notice: null };
  if (renewal.kind === "retained") {
    return {
      kind: "continue",
      notice: `Origin lease renewal failed while our lease remains valid ` +
        `until ${renewal.claim.lease.expires}: ${renewal.reason}`,
    };
  }
  return {
    kind: "halt",
    complaint: `Origin lease lost; ${renewal.detail}. Stopping admissions, ` +
      "landing nothing, and preserving every issue clone.",
    exit: haltedExit(["origin-lock-lost"]),
  };
}

export function terminalReason(terminal: Terminal): string | null {
  switch (terminal.type) {
    case "DONE": return null;
    case "NEEDS-INFO": return terminal.questions;
    case "NEEDS-UI-PROTOTYPE": return terminal.uiImpact;
    case "NEEDS-PARTITION":
      return `${terminal.cause} ${terminal.slot} ${terminal.size}/${terminal.budget}: ${terminal.detail}`;
    case "NEEDS-HUMAN": return `${terminal.cause}: ${terminal.failureTrace}`;
    case "NEEDS-HUMAN-REVIEW": return `${terminal.cause}: ${terminal.latestReviewerProse}`;
    case "NEEDS-STACK-CHANGE":
      return `${terminal.stackChange.path} changed beyond env (gate-1 ` +
        `${terminal.gate.ok ? "green" : "red"} on the source tip's stack):\n` +
        renderStackDifferences(terminal.stackChange.differences);
    case "HARD-ERROR": return terminal.reason;
    case "QUOTA": return `${terminal.provider} ${terminal.window}`;
    case "CREDENTIAL": return `${terminal.provider}: ${terminal.detail}`;
  }
}

// How one issue's inner loop ended: its terminal, or the loop rejected.
export type IssueEnding =
  | Terminal
  | { readonly type: "REJECTED"; readonly reason: string };

// A rejected loop's ending: the error's message is its reason.
export const rejectedEnding = (err: unknown): IssueEnding => ({
  type: "REJECTED",
  reason: err instanceof Error ? err.message : String(err),
});

// The `terminal` event of one issue: its prose reason, and the machine's typed
// cause and spec-gap count beside it (#194). `run()` and replay (#195) both
// record it through here, so the two record shapes cannot drift.
export function terminalEventOf(
  issue: Pick<IssueRef, "id" | "title">,
  ending: IssueEnding,
  durationMs: number,
): Extract<EventInput, { kind: "terminal" }> {
  const subject = { kind: "terminal", issue: Number(issue.id), title: issue.title } as const;
  if (ending.type === "REJECTED") {
    return { ...subject, terminal: "REJECTED", reason: ending.reason, durationMs };
  }
  return {
    ...subject,
    terminal: ending.type,
    reason: terminalReason(ending),
    ...("cause" in ending ? { cause: ending.cause } : {}),
    specGaps: ending.specGaps.length,
    durationMs,
  };
}

// What every sandbox is handed of `config.env`. CODEX_AUTH_JSON is a driver
// input now, not a process credential: the shared credential file is the only
// copy containers need (#134). Replay strips the forge's keys from this (#195).
export const sandboxEnvOf = (config: ResolvedConfig): Record<string, string> =>
  Object.fromEntries(Object.entries(config.env).filter(([key]) => key !== "CODEX_AUTH_JSON"));

// The inner loop's configuration for one admission (#195): `run()` and replay
// build it from the same resolved config, and differ only in what they pass
// here — replay's layout is a case cache and its issue source the case file.
export function innerLoopConfigOf(
  config: ResolvedConfig,
  parts: {
    readonly layout: RepoLayout;
    readonly issueSource: IssueSource;
    readonly scope: RunScope;
    readonly env: Record<string, string>;
    readonly codexAuthMount: CodexAuthMount | undefined;
    readonly agentImages: AgentImages;
    readonly egress: EgressContext | null;
  },
): InnerLoopConfig {
  const { codexAuthMount, ...rest } = parts;
  return {
    ...rest,
    repo: { owner: config.ghOwner, name: config.ghRepo },
    sourceBranch: config.sourceBranch,
    implementerModelId: config.implementerModelId,
    uiPrototypeCheck: config.uiPrototypeCheck,
    partitionCheck: config.partitionCheck,
    maxContextChars: config.maxContextChars,
    uiCheckModelId: config.uiCheckModelId,
    condenserModelId: config.condenserModelId,
    reviewerModelId: config.reviewerModelId,
    reviewerQualityModelId: config.reviewerQualityModelId,
    adjudicatorModelId: config.adjudicatorModelId,
    implementerAgent: config.implementerAgent,
    uiCheckAgent: config.uiCheckAgent,
    condenserAgent: config.condenserAgent,
    condenseAboveChars: config.condenseAboveChars,
    scenarioWriter: config.scenarioWriter,
    scenarioWriterAgent: config.scenarioWriterAgent,
    scenarioWriterModelId: config.scenarioWriterModelId,
    scenarioRunnerAgent: config.scenarioRunnerAgent,
    scenarioRunnerModelId: config.scenarioRunnerModelId,
    reviewerAgent: config.reviewerAgent,
    reviewerQualityAgent: config.reviewerQualityAgent,
    adjudicatorAgent: config.adjudicatorAgent,
    implementerEffort: config.implementerEffort,
    uiCheckEffort: config.uiCheckEffort,
    condenserEffort: config.condenserEffort,
    scenarioWriterEffort: config.scenarioWriterEffort,
    scenarioRunnerEffort: config.scenarioRunnerEffort,
    reviewerEffort: config.reviewerEffort,
    reviewerQualityEffort: config.reviewerQualityEffort,
    adjudicatorEffort: config.adjudicatorEffort,
    maxQualityRounds: config.maxQualityRounds,
    maxGateRounds: config.maxGateRounds,
    maxReviewRounds: config.maxReviewRounds,
    sandboxImage: config.sandboxImage,
    ...(codexAuthMount === undefined ? {} : { codexAuthMount }),
    claudeMdPath: config.claudeMdPath,
    contextMdPath: config.contextMdPath,
    adrDir: config.adrDir,
    promptExtensions: config.promptExtensions,
    botName: config.botName,
    botEmail: config.botEmail,
  };
}

// The `egress` option of a gate stack or the resolve adapter (#202): theirs to
// start a proxy with, its records going to the run record. Nothing with open
// egress.
export function egressOf(
  context: EgressContext | null,
  emit: Parameters<typeof egressReport>[0],
  stack: "gate" | "resolve",
): { readonly egress?: OwnerEgress } {
  return context === null ? {} : { egress: ownerEgress(context, egressReport(emit, { stack })) };
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
  state: {
    readonly pool: ContinuousPool<PlannedIssue, Terminal>;
    readonly providerExit: TerminalExit | null;
    readonly restartDetail: string | null;
    readonly storage: LowStorage | null;
  },
): TerminalExit {
  switch (reason) {
    case "restart": {
      if (state.restartDetail === null) {
        throw new Error("scheduler selected a restart with no request observed");
      }
      return restartExit(state.restartDetail);
    }
    case "provider-closed": {
      if (!state.providerExit) {
        throw new Error("scheduler selected provider closure without an exit");
      }
      return state.providerExit;
    }
    case "storage-low": {
      if (state.storage === null) {
        throw new Error("scheduler selected a storage exit without a measurement");
      }
      return lowStorageExit(state.storage);
    }
    case "stuck": return stuckExit(state.pool.noProgressSinceLanding);
  }
}

// Every filesystem below its floor, each named: the graphroot, and with
// `config.databaseCopies` the database volume (#201). Never empty.
type LowStorage = readonly string[];

function lowStorageOf(
  graphRoot: GraphRootSpace,
  dbVolume: DbVolumeSpace | null,
): LowStorage | null {
  const low = [
    ...(graphRootSpaceIsLow(graphRoot) ? [formatLowGraphRootSpace(graphRoot)] : []),
    ...(dbVolume !== null && dbVolumeSpaceIsLow(dbVolume) ? [formatLowDbVolumeSpace(dbVolume)] : []),
  ];
  return low.length === 0 ? null : low;
}

function lowStorageExit(low: LowStorage): TerminalExit {
  return storageExit(
    `${low.join("; ")} after image reconciliation; ` +
      "admissions were stopped and the pool drained",
  );
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

  // The deployment channel's request (#146), read HERE — ahead of the locks,
  // the origin lease, preflight and the image builds, which is where this
  // startup's minutes are. What this process may later clear is the request
  // this `execve` answered, and node pinned that build by realpathing its entry
  // before `run()` was called, so the answer is fixed from before the first
  // line of it. A request the converging play writes during the startup below
  // names a commit this process is NOT running and has to survive to the first
  // recompute; reading late could not tell the two apart.
  //
  // The path comes from the config file the loader resolved, because that
  // directory IS the installation: a programmatic `run(config)` has no
  // installation directory and therefore no channel, which `run-start` already
  // records as `configPath: null`. A read that fails is a pre-lock refusal like
  // the config's own, stderr-only because no record can be owned yet.
  const restartRequestFile = options.configPath === undefined
    ? null
    : restartRequestPath(options.configPath);
  const restartRequestAtStartup = restartRequestFile === null
    ? null
    : await readRestartRequest(restartRequestFile);

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

  // The workdir lock comes before every operation on local `.sandbar/` state
  // (#32). It remains distinct from #139's origin lease below: this one guards
  // the cache and event files on one host; the other guards shared repository
  // refs across hosts.
  //
  // Ordering it this way costs nothing. `acquireLock` is `retries: 0`, so a
  // held lock fails immediately — there is no "lock wait" for a config error to
  // avoid by running first. All it changes is which of two true complaints a
  // second launch hears first, and "another sandbar is running" is the
  // actionable one.
  const lockPaths = lockPathsFor(layout.stateDir);
  let release: (() => Promise<void>) | null = null;
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

  // The cache must exist before either the reachability probe can read its
  // origin URL or the origin-lock adapter can run Git in it. Creation is local,
  // under the workdir lock, and makes no remote write.
  //
  // The forge probe is deliberately the last operation before acquiring the
  // repository-wide lease (#139). Everything after it in preflight fetches,
  // cleans or reconciles repository state and therefore requires the shared
  // single-writer claim. A loser owns no event record: like a workdir-lock
  // loser it reports only to stderr, then releases local state and exits.
  const repo = { owner: config.ghOwner, name: config.ghRepo };
  const preflightBase = {
    layout,
    env,
    sourceBranch: config.sourceBranch,
    repo,
    developers: config.developers,
    images: config.images,
    agentProviders,
    deployWatch: config.deployWatch,
    databaseCopies: config.databaseCopies,
    janitor: config.janitor !== null,
  };
  const stopBeforeOriginLock = async (
    err: PreflightError | SandbarError,
  ): Promise<never> => {
    const detail = err instanceof PreflightError ? err.message : faultDetail(err);
    console.error(detail);
    await runCleanup();
    process.exit(1);
  };
  try {
    await ensureRepoCache(layout, () => undefined);
    await checkForgeReachabilityForPreflight({
      ...preflightBase,
      onEvent: (event) => {
        if (event.kind === "complaint" || event.kind === "notice") {
          console.error(event.message);
        }
      },
    });
  } catch (err) {
    if (err instanceof PreflightError || err instanceof SandbarError) {
      return await stopBeforeOriginLock(err);
    }
    await runCleanup();
    throw err;
  }

  const runStartedAt = new Date();
  let originLock: OriginLockHandle;
  let displacedOriginHolder: Awaited<ReturnType<typeof acquireOriginLock>>["displaced"];
  try {
    const acquired = await acquireOriginLock({
      repoDir: layout.repoDir,
      identity: {
        hostname: hostname(),
        workdir: realpathSync(lockPaths.workDir),
        pid: process.pid,
        run: runStampFromDate(runStartedAt),
        startedAt: runStartedAt.toISOString(),
      },
    });
    originLock = acquired.lock;
    displacedOriginHolder = acquired.displaced;
  } catch (err) {
    if (err instanceof OriginLockHeldError) {
      console.error(err.message);
      await runCleanup();
      process.exit(1);
    }
    if (err instanceof SandbarError) return await stopBeforeOriginLock(err);
    await runCleanup();
    throw err;
  }
  // Until the event record owns cleanup ordering, this disposable closes the
  // acquisition-to-record gap. Once the record exists it is replaced below by
  // an ordinary action ordered ahead of record finalization.
  const releaseOriginLock = (): Promise<void> => originLock.release();
  const unregisterEarlyOriginRelease = registerDisposable(releaseOriginLock);

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
  let runRecord: Awaited<ReturnType<typeof startEventRecord>>;
  try {
    runRecord = await startEventRecord({
      baseDir: layout.logsDir,
      now: runStartedAt,
      start: {
        driver: driverIdentity,
        configPath: options.configPath ?? null,
        workdir: layout.stateDir,
        maxParallelIssues: config.maxParallelIssues,
        pid: process.pid,
      },
    });
    await runRecord.emit({
      kind: "preflight",
      action: displacedOriginHolder === null
        ? "origin-lock-acquired"
        : "origin-lock-taken-over",
      detail: displacedOriginHolder === null
        ? `Acquired repository lease ${originLock.claim().sha}`
        : `Took over expired repository lease from ${formatOriginLockHolder(displacedOriginHolder)}`,
    });
  } catch (err) {
    await runCleanup();
    throw err;
  }
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
  // ordering. The origin-lease release is registered immediately after this
  // action, so it drains while the host is still forbidden to sleep; this
  // action then drains before `finalize`. Every teardown registered later (the
  // image removal below, and every lazy `registerDisposable` a cycle adds) has
  // already run, and `run-end` is still the last event.
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
  // LIFO: the heartbeat and later resource teardowns stop first, then release
  // is attempted while the wake lock, reporter and event record are still
  // live. The wake lock stops next; run-end remains the last event.
  onCleanup(releaseOriginLock);
  unregisterEarlyOriginRelease();

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

  let leaseLossIsCleaningUp = false;
  const observeOriginLockRenewal = async (
    renewal: OriginLockRenewal,
  ): Promise<void> => {
    const decision = decideOriginLockWake(renewal);
    if (decision.kind === "continue") {
      if (decision.notice === null) return;
      await runRecord.emit({
        kind: "notice",
        message: decision.notice,
      });
      return;
    }

    // Claim cleanup before submitting either terminal event. If a signal or
    // another terminal already owns the drain, this renewal is a rejected
    // write barrier only: that owner has already selected the run's ending.
    // `leaseLossIsCleaningUp` keeps the cleanup action from awaiting the
    // renewal promise that is currently executing this observer.
    leaseLossIsCleaningUp = true;
    const cleanup = beginCleanup();
    if (!cleanup.owner) {
      throw new OriginLeaseLostDuringCleanupError(decision.complaint);
    }
    const complaintWrite = runRecord.emit({
      kind: "complaint",
      severity: "error",
      message: decision.complaint,
    });
    // Submit both writes synchronously before yielding. `beginCleanup` may
    // already be draining resources, but EventRecord serializes these ahead of
    // its later run-end append.
    const exitWrite = announceExit(decision.exit);
    await complaintWrite;
    const exit = await exitWrite;
    await cleanup.done;
    process.exit(exit.exitCode);
  };

  // Scheduler wakes remain explicit renewal barriers, while this heartbeat
  // keeps the ten-minute lease alive during long preflight, image, gate,
  // resolve and forge-verification calls. All callers share one in-flight
  // renewal so a timer and a freed slot can never race two CAS updates.
  let renewalInFlight: Promise<void> | null = null;
  const renewOriginLease = (): Promise<void> => {
    if (renewalInFlight !== null) return renewalInFlight;
    const renewal = originLock.renew().then(observeOriginLockRenewal);
    renewalInFlight = renewal.finally(() => {
      renewalInFlight = null;
    });
    return renewalInFlight;
  };
  const originLeaseHeartbeat = setInterval(() => {
    void renewOriginLease().then(
      () => undefined,
      (err: unknown) => err instanceof OriginLeaseLostDuringCleanupError
        ? undefined
        : stopInternalFailure(err),
    );
  }, ORIGIN_LOCK_RENEW_INTERVAL_MS);
  originLeaseHeartbeat.unref();
  onCleanup(async () => {
    clearInterval(originLeaseHeartbeat);
    if (!leaseLossIsCleaningUp && renewalInFlight !== null) {
      try {
        await renewalInFlight;
      } catch (err) {
        if (!(err instanceof OriginLeaseLostDuringCleanupError)) throw err;
      }
    }
  });

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
  const exitAtStartup = async (
    message: string,
    exit: TerminalExit,
  ): Promise<never> => {
    await runRecord.emit({ kind: "complaint", severity: "error", message });
    const announced = await announceExit(exit);
    await runCleanup();
    process.exit(announced.exitCode);
  };

  const stopAtStartup = async (cause: string, err: unknown): Promise<never> => {
    // `faultDetail` already renders a SandbarError as its bare message and
    // anything else as a stack — errors.ts owns that rule. The one case it does
    // not know about is
    // PreflightError, which extends Error rather than SandbarError and whose
    // message IS the operator-actionable report.
    const detail =
      err instanceof PreflightError ? err.message : faultDetail(err);
    return await exitAtStartup(detail, haltedExit([cause]));
  };

  let codexAuthMount: CodexAuthMount | undefined;
  let readyLabelPolicy: ReadyLabelPolicy;
  let stackSource: StackSource;
  const hostUid = process.getuid?.() ?? 0;

  // Preflight is still ahead of the sweep and every container operation below,
  // which is the dependency that matters: those assume a working container
  // runtime because this is what hard-fails when there isn't one.
  try {
    await runRecord.emit({
      kind: "preflight",
      action: "started",
      detail: "Preflight started",
    });
    // Before the checks, so a run that fails preflight still says it (#202).
    const egressWarning = egressStartupWarning(config);
    if (egressWarning !== null) {
      await runRecord.emit({ kind: "complaint", severity: "warning", message: egressWarning });
    }
    ({ readyLabelPolicy, stackSource } = await runPreflightAfterReachability({
      ...preflightBase,
      onEvent: (event) => runRecord.emit(event).then(() => undefined),
      openStackSource: () => openStackSource({
        source: config.gateStack,
        repoDir: layout.repoDir,
        sourceBranch: config.sourceBranch,
        configEnv: config.env,
        images: config.images,
        sandboxImage: config.sandboxImage,
        databaseCopies: config.databaseCopies,
        hostChecks: (stack) => checkStackOnHost(stack, config.images, hostUid),
        onEvent: (event) => runRecord.emit(event).then(() => undefined),
      }),
    }));
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
  let graphRoot!: string;
  let startupLow: LowStorage | null = null;
  // The database volume, measured beside the graphroot (#201).
  const measureDbVolume = async (): Promise<DbVolumeSpace | null> =>
    config.databaseCopies === null ? null : await dbVolumeSpace(config.databaseCopies.root);
  // Every copy this run's scope left on the volume (#201); only when no
  // sandbox can hold one.
  const sweepCopies = async (sweepScope: "startup" | "quiescent"): Promise<void> => {
    if (config.databaseCopies === null) return;
    const copies = await sweepDbCopies({ cfg: config.databaseCopies, scope });
    if (copies.removed.length > 0 || copies.failures.length > 0) {
      await runRecord.emit({ kind: "sweep", scope: sweepScope, ...copies });
    }
  };
  // The run's database copies (#201), one per issue at a time; the inner
  // loop aligns each sandbox's slot of them before every action.
  const dbCopies = config.databaseCopies === null
    ? null
    : createDbCopies({ cfg: config.databaseCopies, scope });
  // The egress proxy image this driver builds (#202): live whether or not this
  // installation runs proxies, exactly as the tools pins are.
  let egressImageTag!: string;

  // THE STARTUP INVENTORY IN ONE `try`, because both reconcilers throw on a
  // failed list and graphroot discovery is part of the same Podman snapshot.
  // The throw is right at the other end — `containers.ts` and
  // `image-lifecycle.ts` both argue that a
  // failed list is a blind sweep, which cannot know what it missed, so stopping
  // beats asserting "no debris" on no evidence — but the stop it produced
  // escaped `run()` to the bin, which is the exact shape this issue exists to
  // end: no `stopped (…)` line, no `Exit (…)`, no cleanup, and nothing on disk
  // in a window this run had already won the lock for. Preflight passed moments
  // earlier, so what reaches here is a socket that dropped or a systemd session
  // that went away between two podman calls — host state an operator can act
  // on, and now host state they can still read afterwards.
  //
  // One `try` and one cause: this is one step (take stock of
  // what a previous run left behind), they fail for one reason, and the
  // complaint recorded beside the cause names which podman call it was.
  try {
    graphRoot = await podmanGraphRoot();
    const orphans = await cleanupOrphanContainers(scope);
    if (orphans.removed.length > 0) {
      await runRecord.emit({ kind: "sweep", scope: "startup", removed: orphans.removed, failures: [] });
    }
    await reportSweepFailures(orphans, (event) => runRecord.emit(event), "startup");
    await sweepCopies("startup");

    egressImageTag = await currentEgressImageTag(scope);
    const staleImages = await reconcileImages({
      scope,
      liveTags: new Set([
        ...config.images.map((image) => image.tag),
        ...agentToolsImageTags(scope, agentProviders),
        egressImageTag,
      ]),
    });
    if (staleImages.removed.length > 0) {
      await runRecord.emit({ kind: "sweep", scope: "startup", removed: staleImages.removed, failures: [] });
    }
    startupLow = lowStorageOf(await graphRootSpace(graphRoot), await measureDbVolume());

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

  if (startupLow !== null) {
    return await exitAtStartup(
      `${startupLow.join("; ")} after startup image reconciliation. ` +
        "Sandbar will not begin image preparation or admit work.",
      lowStorageExit(startupLow),
    );
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
  // What every sandbox, gate stack and resolve container gets with an egress
  // allowlist (#202): the proxy image, the policy, and the run's own log
  // directory for the proxies' decisions. Null keeps open egress.
  let egressContext: EgressContext | null = null;
  try {
    initialSourceWorktree = await ensureSourceWorktree(layout, config.sourceBranch);
    initialBaseFingerprints = await ensureImages(config.images, initialSourceWorktree, {
      scope,
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
    if (config.egress.kind === "allowlist") {
      egressContext = {
        scope,
        image: await ensureEgressImage(scope, recordImage),
        policy: config.egress.policy,
        logDir: join(runRecord.runDir, "egress"),
      };
    }
  } catch (err) {
    return await stopAtStartup("image-build-failed", err);
  }

  // Per-branch gate images (#37). One instance for the whole run — every issue
  // and the merger share it, because the per-branch tag is content-addressed
  // and two branches that make the same dependency change must produce one
  // build rather than two.
  //
  const makeBranchImages = (fingerprints: ReadonlyMap<string, string>): BranchImages =>
    createBranchImages({
      images: config.images,
      scope,
      baseFingerprints: fingerprints,
      onImage: recordImage,
      log: () => undefined,
      worktreeMountingTags: () => worktreeMountingTagsOf(stackSource.accepted().stack),
      hostUid,
    });
  const initialBranchImages = makeBranchImages(initialBaseFingerprints);
  let currentImages: RunImages = {
    agentImages: initialAgentImages,
    branchImages: initialBranchImages,
  };

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
    await checkWorktreeImageUids(stackSource.accepted().stack, hostUid);
  } catch (err) {
    return await stopAtStartup("image-uid-check-failed", err);
  }

  const silentNoopAttemptsByIssue = new Map<string, number>();
  const providerState = createRunProviderState();
  const sandboxEnv = sandboxEnvOf(config);
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
      beforeOriginWrite: renewOriginLease,
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
  // and get stamped `needs-human` on a closed-COMPLETED issue (#16). Fed to
  // buildPlan as a hard exclusion alongside its live-state CLOSED check.
  const mergedThisRun = new Set<number>();

  // One adapter for the whole run, like `repo` itself: the chunk-review scan
  // (#95) reads and writes the same repository at every recompute.
  const followUpAdapter = realChunkFollowUpAdapter({
    repo,
    repoDir: layout.repoDir,
    sourceBranch: config.sourceBranch,
    beforeOriginWrite: renewOriginLease,
  });
  const chunkRequestWrites = chunkForgeWrites({
    repo,
    gitCwd: layout.repoDir,
    errPrefix: "chunk land request",
    beforeOriginWrite: renewOriginLease,
  });

  // One admission queue for every gate pod in this run (#142), independent of
  // issue execution slots and shared with the serialized landing path below.
  const gateSemaphore = createGateSemaphore(config.maxConcurrentGates);

  type IssueOutcome = { issue: PlannedIssue; terminal: Terminal };
  type ExecutionEvent = SettledIssue<PlannedIssue, Terminal>;
  const pool = new ContinuousPool<PlannedIssue, Terminal>(
    config.maxParallelIssues,
    (issue) => issue.id,
  );
  // The idle janitor's one run in flight (#205), aborting or not. It is no
  // pool slot, yet it holds one: admission, drains and the idle event count
  // it until it has settled. A holder, because only closures assign it.
  // Cleanup aborts one still in flight (a halt leaves the loop without
  // draining it) and waits for its teardown.
  const janitor: {
    run: {
      readonly task: string;
      readonly controller: AbortController;
      readonly settled: Promise<void>;
    } | null;
  } = { run: null };
  onCleanup(async () => {
    const run = janitor.run;
    if (run === null) return;
    run.controller.abort();
    await run.settled;
  });
  const activeSlots = (): number => pool.activeCount + (janitor.run === null ? 0 : 1);
  const janitorForge = realJanitorForge({
    repo,
    repoDir: layout.repoDir,
    sourceBranch: config.sourceBranch,
    beforeOriginWrite: renewOriginLease,
  });
  // A run records its own ending (#82). One that throws is recorded by
  // `settleJanitorRun` as `failed` and the daemon carries on: `runsPerDay`
  // bounds a repeat. Its end wakes the scheduler, which owns what happens next.
  const startJanitor = (task: JanitorTask, loop: JanitorRunDeps["loop"]): void => {
    const controller = new AbortController();
    const timer = startTimer();
    const settled = settleJanitorRun({
      task: task.name,
      run: async () => runJanitor({
        task,
        layout,
        sourceBranch: config.sourceBranch,
        botName: config.botName,
        botEmail: config.botEmail,
        maxContextChars: config.maxContextChars,
        standards: config.promptExtensions.reviewerQuality,
        forge: janitorForge,
        beforeOriginWrite: renewOriginLease,
        loop,
        attemptLogger: await runRecord.janitor(task.name),
        onEvent: (event) => runRecord.emit(event).then(() => undefined),
        signal: controller.signal,
        now: () => new Date(),
      }),
      emit: (event) => runRecord.emit(event).then(() => undefined),
      durationMs: timer,
      onEnd: () => {
        janitor.run = null;
        pool.wakeExternal();
      },
    });
    janitor.run = { task: task.name, controller, settled };
  };
  let providerExitPending: TerminalExit | null = null;
  let storageLow: LowStorage | null = null;
  // Source movement creates refresh WORK, not an instruction to build at the
  // point it was observed. The next recompute measures storage first; a low
  // reading keeps this latched through the drain so recovery can perform it,
  // while an exit leaves it untouched and starts no unnecessary build.
  let pendingSourceImageRefresh: "poll" | "planning" | "landing" | null = null;
  // What the observed request carried and when this process first saw it;
  // `restartDueAs` is the drain's whole state once the deferral is over.
  let restartRequested: {
    readonly detail: string;
    readonly urgent: boolean;
    readonly observedAt: number;
  } | null = null;
  let restartDueAs: RestartDueReason | null = null;
  let nextPlanTrigger: RecomputeTrigger = "launch";
  // The previous poll's pending chunk graph (#193, `chunks.ts` "Settling"):
  // fresh chunks start only once two consecutive polls agree on it. Memory
  // only, so a restart costs one extra poll; the launch recompute is the
  // first poll.
  let chunkSettle: ChunkSettleMemory = UNSETTLED;
  let deferredChunksForRecompute: string[] = [];
  // Pull requests already told their `land` waits for the landing window
  // (#244), cleared whenever it is open so each closure tells them once.
  const toldLandingWindow = new Set<number>();
  // Stacked chunks whose refresh onto their base, wanted by no member, failed
  // in this process (#243): retried only for a member that waits, so a
  // conflict costs one resolve rather than one per recompute.
  const failedBaseRefreshes = new Set<string>();
  let landingNumber = 0;
  let iteration = 0;
  let lastPlanDiagnostics: string | null = null;
  const deferredLandReason = (
    members: readonly { readonly number: number }[],
  ): string => {
    const named = members.map((member) => `#${member.number}`);
    if (named.length === 1) {
      return `${named[0]} targets this chunk · lands once ${named[0]} lands or parks`;
    }
    return `${named.join(", ")} target this chunk · lands once they land or park`;
  };

  const landRequestEvent = (
    request: ChunkLandTarget,
    status: Extract<EventInput, { kind: "land-request" }>["status"],
  ): Extract<EventInput, { kind: "land-request" }> => ({
    kind: "land-request",
    pullRequest: request.pullRequest,
    branch: request.branch,
    title: request.title,
    members: request.members.map((member) => member.number),
    status,
  });

  const emitObservedLandRequests = async (
    observed: readonly ChunkLandTarget[],
    runnable: readonly ChunkLandTarget[],
    deferrals: ReadonlyMap<string, string>,
  ): Promise<void> => {
    const runnableIndex = new Map(
      runnable.map((request, index) => [request.branch, index] as const),
    );
    for (const request of observed) {
      const deferral = deferrals.get(request.branch);
      if (deferral !== undefined) {
        await runRecord.emit(landRequestEvent(request, { kind: "deferred", reason: deferral }));
        continue;
      }
      const index = runnableIndex.get(request.branch);
      const previous = index === undefined || index === 0
        ? undefined
        : runnable[index - 1];
      await runRecord.emit(landRequestEvent(request, {
        kind: "queued",
        reason: previous
          ? `lands after PR #${previous.pullRequest}`
          : "lands next",
      }));
    }
  };

  const waitForSchedulerWake = async (): Promise<RecomputeTrigger> => {
    const wake = await pool.waitForWake(config.pollIntervalMs);
    await renewOriginLease();
    return wake === "external" ? "janitor-finished" : wake;
  };

  // One observation per recompute. A request is latched from the first
  // reading and deferred until `restartDueReason` says it is due (scheduler.ts,
  // "WHEN A RESTART IS DUE"). While deferred the file is read again, because
  // the play may have rewritten it urgent for a later commit — a revert must
  // not wait out a deferral an earlier landing started. Urgency only ever
  // upgrades, and the deferral keeps its first observation's clock. Once due
  // the request is final: this process is leaving for whichever driver
  // `current` names by the time it restarts, so another reading would only
  // move the detail in the record. The record gets one event when the request
  // is first seen deferred and one when it becomes due.
  const observeRestartRequest = async (): Promise<void> => {
    if (restartRequestFile === null || restartDueAs !== null) return;
    const pending = await readRestartRequest(restartRequestFile);
    const previous = restartRequested;
    if (pending !== null) {
      restartRequested = {
        detail: pending.detail,
        urgent: pending.urgent || (previous?.urgent ?? false),
        observedAt: previous?.observedAt ?? Date.now(),
      };
    }
    if (restartRequested === null) return;
    const request = restartRequested;
    restartDueAs = restartDueReason({
      urgent: request.urgent,
      ageMs: Date.now() - request.observedAt,
      deferMs: config.restartDeferMs,
      active: pool.activeCount,
      ongoing: pool.ongoingCount,
      hasPendingTerminals: pool.hasPendingTerminals,
    });
    if (restartDueAs !== null) {
      await runRecord.emit({
        kind: "restart-requested",
        detail: request.detail,
        ...(request.urgent ? { urgent: true } : {}),
        due: restartDueAs,
      });
    } else if (previous === null) {
      await runRecord.emit({
        kind: "restart-requested",
        detail: request.detail,
        deferredUntil: new Date(request.observedAt + config.restartDeferMs).toISOString(),
      });
    }
  };

  // Read through a call: the latch is assigned only inside the closure above,
  // so the loop's own control flow would narrow it to its initial null.
  const requestedRestartDetail = (): string | null => restartRequested?.detail ?? null;

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
    await renewOriginLease();
    const outcomes: IssueOutcome[] = [];
    for (const event of settled) {
      if (event.status === "fulfilled") {
        outcomes.push({ issue: event.issue, terminal: event.value });
      } else {
        const path = worktreePathFor(layout.worktreesDir, event.issue.branch);
        const reclaim = await reclaimIssueClone(
          layout.repoDir,
          path,
          event.issue.branch,
        );
        if (reclaim.kind === "preserved") {
          await runRecord.emit({
            kind: "complaint",
            severity: "error",
            message: `Issue clone preserved at ${path}: ${reclaim.reason}`,
          });
        }
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

  // Draining is cleanup for a landing failure: report a sibling finalization
  // failure beside it, but never let that secondary fault replace the original
  // error at the internal-failure boundary.
  const drainPreservingLandingFailure = async (
    landingFailure: unknown,
  ): Promise<never> => {
    try {
      await drainAfterLandingHalt();
    } catch (drainErr) {
      const detail = faultDetail(drainErr);
      await runRecord.emit({
        kind: "complaint",
        severity: "error",
        message: "Draining in-flight work after the landing failure also failed: " + detail,
      });
    }
    throw landingFailure;
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

  const janitorLandEvent = (
    target: JanitorLandTarget,
    outcome: Extract<EventInput, { kind: "janitor-land" }>["outcome"],
    durationMs: number,
  ): Extract<EventInput, { kind: "janitor-land" }> => ({
    kind: "janitor-land",
    task: target.task,
    branch: target.branch,
    pullRequest: target.pullRequest,
    outcome,
    durationMs,
  });

  // Never halts: a janitor branch kept on origin is retried by the reconciler.
  const reportJanitorResidue = async (wrapups: readonly JanitorWrapup[]): Promise<void> => {
    const untidy = wrapups.filter((wrapup) => wrapup.residue.length > 0);
    if (untidy.length === 0) return;
    await runRecord.emit({
      kind: "complaint",
      severity: "warning",
      message: JANITOR_RESIDUE_BANNER({ wrapups: untidy, sourceBranch: config.sourceBranch }),
    });
  };

  // Whom a landing's gate-2 or resolve attempt is about: an issue by number, or
  // the idle task a `janitor-<task>` id names (#205). A `chunk-<root>` key has
  // no subject of its own, so it is filed under its root issue.
  const landingSubject = (id: string): EventSubject => {
    const task = janitorTaskFromStackId(id);
    if (task !== null) return { janitor: task };
    return { issue: Number(id.startsWith("chunk-") ? id.slice("chunk-".length) : id) };
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
          pullRequest: outcome.target.pullRequest,
          title: outcome.target.title,
          members: outcome.target.members.map((member) => member.number),
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
          pullRequest: outcome.skipped.target.pullRequest,
          title: outcome.skipped.target.title,
          members: outcome.skipped.target.members.map((member) => member.number),
          reason: outcome.skipped.reason,
          durationMs: outcome.durationMs,
        });
        return;
      case "chunk-deferred":
        {
          const reason = deferredLandReason(outcome.deferred.landedNow);
          await runRecord.emit(landRequestEvent(outcome.deferred.target, {
            kind: "deferred",
            reason,
          }));
          await runRecord.emit({
            kind: "landed",
            outcome: "chunk-deferred",
            branch: outcome.deferred.target.branch,
            target: null,
            pullRequest: outcome.deferred.target.pullRequest,
            title: outcome.deferred.target.title,
            members: outcome.deferred.target.members.map((member) => member.number),
            reason,
            durationMs: outcome.durationMs,
          });
          return;
        }
      case "janitor-on-source":
        await runRecord.emit(janitorLandEvent(outcome.target, "landed", outcome.durationMs));
        return;
      case "janitor-parked":
        await runRecord.emit({
          ...janitorLandEvent(outcome.target, "parked", outcome.durationMs),
          reason: outcome.reason,
        });
        return;
      case "chunk-refreshed":
        failedBaseRefreshes.delete(outcome.refresh.branch);
        await runRecord.emit({
          kind: "reconcile",
          action: "chunk-refreshed",
          detail: `${outcome.refresh.branch} now contains ` +
            `origin/${outcome.refresh.base ?? config.sourceBranch}`,
        });
        return;
      case "chunk-refresh-failed": {
        const { refresh, dependents } = outcome.failure;
        if (dependents.length === 0) failedBaseRefreshes.add(refresh.branch);
        await runRecord.emit({
          kind: "reconcile",
          action: "chunk-refresh-failed",
          detail: `${refresh.branch} could not be refreshed` + (dependents.length === 0
            ? `; retried once a member waits for it`
            : `; parking ${dependents.map((issue) => `#${issue.id}`).join(", ")}`),
        });
        return;
      }
    }
  };

  const refreshSourceImages = async (): Promise<void> => {
    activity.enterBusy();
    const nextSourceWorktree = await ensureSourceWorktree(layout, config.sourceBranch);
    const nextBaseFingerprints = await ensureImages(config.images, nextSourceWorktree, {
      scope,
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
  };

  // The request read before this startup began has been answered by this very
  // process (#146): the play asked for the built driver to be running, and it
  // is. Clearing it BEFORE the loop is what makes the restart exit
  // unrepeatable — that same request carried into the scheduler would drain
  // straight back out, and the unit turns that exit code into another start.
  // Only that content is removed, so a newer request the play wrote while this
  // startup ran stays for `observeRestartRequest`. A removal that fails stops
  // the run here rather than at the exit it would otherwise loop on — through
  // `stopAtStartup` like every other post-lock startup fault, so the record
  // still gets its complaint and exit event (#70) and cleanup still releases
  // the origin lease and the `run.pid` sidecar (#139).
  if (restartRequestFile !== null && restartRequestAtStartup !== null) {
    try {
      if (await clearRestartRequest(restartRequestFile, restartRequestAtStartup.detail)) {
        await runRecord.emit({
          kind: "preflight",
          action: "restart-request-cleared",
          detail: `Started for the deployment of ${restartRequestAtStartup.detail}`,
        });
      }
    } catch (err) {
      return await stopAtStartup("restart-request-clear-failed", err);
    }
  }

  // Until when tracker reads are held after GitHub refused one for quota
  // (`forge-rate-limit.ts`); null when they are not.
  let trackerHeldUntil: number | null = null;
  const holdTracker = async (): Promise<number> => {
    trackerHeldUntil = await fetchRateLimitResumeAt(Date.now());
    return trackerHeldUntil;
  };

  // The deploy watch (#198), when configured. Cleanup stops it first, so no
  // write follows the lease's release and no event follows run-end.
  const { deployWatch } = config;
  const deployWatcher = deployWatch === null ? null : createDeployWatcher({
    adapter: realDeployWatchAdapter({
      repo,
      repoDir: layout.repoDir,
      sourceBranch: config.sourceBranch,
      workflow: deployWatch.workflow,
      label: deployWatch.label,
      beforeOriginWrite: renewOriginLease,
    }),
    settings: deployWatch,
    emit: (event) => runRecord.emit(event),
    onRateLimited: async () => {
      const heldUntil = await holdTracker();
      await runRecord.emit({
        kind: "notice",
        message: "Deploy watch hit GitHub's rate limit; holding tracker reads until " +
          `${new Date(heldUntil).toISOString()}`,
      });
    },
  });
  if (deployWatcher !== null) onCleanup(() => deployWatcher.stop());
  const kickDeployWatch = (): void => {
    if (trackerHeldUntil === null) deployWatcher?.kick();
  };

  // The nightly base import's outcome (#201), when database copies are on.
  const dbBaseWatch = config.databaseCopies === null ? null : createDbBaseWatch({
    cfg: config.databaseCopies,
    emit: (event) => runRecord.emit(event),
  });

  const recoverFromRefRefreshFailure = async (
    boundary: "Poll refresh" | "Planning ref refresh" | "Tracker read",
    failures: readonly string[],
  ): Promise<"exit" | "retry"> => {
    // Planning and landing cannot safely use a partially refreshed namespace.
    // The drained-restart exception is the same at either fetch boundary: it
    // reads no refs, while every other state waits for a complete snapshot.
    const stalled = decideAfterFailedRefresh({
      restartDue: restartDueAs !== null,
      active: activeSlots(),
      ongoing: pool.ongoingCount,
      hasPendingTerminals: pool.hasPendingTerminals,
    });
    const next = stalled.kind === "exit"
      ? "the pending restart needs none of it, so exiting"
      : trackerHeldUntil !== null
        ? `holding tracker reads until ${new Date(trackerHeldUntil).toISOString()}`
        : `retrying in ${config.pollIntervalMs}ms`;
    const message = failures.length === 0
      ? null
      : `${boundary} failed; ${next}: ${failures.join("; ")}`;
    // No failures is a rate-limit hold already on the record: silent, unless
    // it ends the run.
    if (stalled.kind === "exit") {
      await runRecord.emit({
        kind: "complaint",
        severity: "warning",
        message: message ?? `${boundary} held; ${next}`,
      });
    } else if (message !== null) {
      await runRecord.emit({ kind: "notice", message });
    }
    if (stalled.kind === "exit") {
      terminalExit = await announceExit(
        schedulerExit(stalled.reason, {
          pool,
          providerExit: providerExitPending ?? closedProviderExit(config, providerState),
          restartDetail: requestedRestartDetail(),
          storage: storageLow,
        }),
      );
      return "exit";
    }
    nextPlanTrigger = await waitForSchedulerWake();
    return "retry";
  };

  // A planning-time tracker read whose `gh` request never reached the forge is
  // the same non-answer a failed ref refresh is, and takes the same recovery:
  // the record gets a notice and the recompute is retried at the next wake.
  // Only that class is caught (including a gateway 502/503/504 or a body cut
  // off mid-read, whose backend never answered); every other forge ANSWER (an HTTP status, a
  // GraphQL error) and every non-gh fault still halts the run as before. The
  // one exception is GitHub's rate limit: it is an answer, but about quota, not
  // the tracker, so it sets `trackerHeldUntil` and the recompute waits it out
  // (`forge-rate-limit.ts`) instead of halting into a restart that would only
  // be refused again.
  const readTracker = async <T>(
    read: () => Promise<T>,
  ): Promise<{ readonly value: T } | { readonly failure: string }> => {
    try {
      return { value: await read() };
    } catch (err) {
      if (!isForgeRateLimit(err) && !isForgeTransportFailure(err)) throw err;
      if (!isForgeRateLimit(err)) {
        return { failure: err instanceof Error ? err.message : String(err) };
      }
      await holdTracker();
      const stderr = (err as { stderr?: unknown }).stderr;
      return {
        failure: typeof stderr === "string" && stderr.trim() !== ""
          ? stderr.trim()
          : String(err),
      };
    }
  };

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  try {
    // Image preparation can be the longest part of startup. Refresh the claim
    // once more before the launch recompute so even a slow build cannot enter
    // the scheduler on its acquisition-time expiry.
    await renewOriginLease();
    for (;;) {
      iteration += 1;
      const planTrigger: RecomputeTrigger = nextPlanTrigger;
      // Ahead of the poll, so the request is on the record from the first wake
      // that can see it even when the refresh below fails and skips the rest of
      // this iteration.
      await observeRestartRequest();
      let sourceChangedOnPoll = false;
      if (planTrigger === "poll") {
        const refresh = await fetchOriginRefs(layout.repoDir, config.sourceBranch);
        if (refresh.failures.length > 0) {
          if (await recoverFromRefRefreshFailure("Poll refresh", refresh.failures) === "exit") {
            break;
          }
          continue;
        }
        // A terminal is eligible again only after the poll has refreshed the
        // refs that planning and branch sync consume. A failed refresh is not
        // a poll boundary and must not spend that guard.
        pool.beginPoll();
        kickDeployWatch();
        sourceChangedOnPoll = refresh.sourceChanged;
        // A due restart admits nothing more, so rebuilding this run's
        // images for a source that just moved is minutes the deploy waits on
        // and the restarted driver spends again with the new code. That case is
        // the COMMON one here, not an edge: the commit the play applied is a
        // commit on this same source branch. Landing keeps working without it —
        // gate-2 resolves its branch images from the merger worktree, which is
        // the merge result rather than either input.
        if (sourceChangedOnPoll && restartDueAs === null) {
          pendingSourceImageRefresh ??= "poll";
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
        await sweepCopies("quiescent");
      }
      if (pool.isQuiescent) {
        const cycleImages = await reconcileImages({
          scope,
          liveTags: new Set([
            ...config.images.map((image) => image.tag),
            ...currentImages.agentImages.liveTags(),
            ...currentImages.branchImages.builtTags(),
            egressImageTag,
          ]),
        });
        if (cycleImages.removed.length > 0) {
          await runRecord.emit({
            kind: "sweep",
            scope: "quiescent",
            removed: cycleImages.removed,
            failures: [],
          });
        }
      }

      const previousStorageLow: LowStorage | null = storageLow;
      const measuredSpace = await graphRootSpace(graphRoot);
      const measuredVolume = await measureDbVolume();
      const measuredStorageLow = lowStorageOf(measuredSpace, measuredVolume);
      // A low reading is a drain latch, not a momentary admission pause. Only
      // the quiescent boundary can reconcile safely, so only its post-reconcile
      // measurement may reopen admission. Measurements continue while work
      // drains, both for evidence and so the final boundary is not special I/O.
      storageLow = previousStorageLow !== null && !pool.isQuiescent
        ? measuredStorageLow ?? previousStorageLow
        : measuredStorageLow;
      if (storageLow !== null && previousStorageLow === null) {
        await runRecord.emit({
          kind: "complaint",
          severity: "error",
          message: `${storageLow.join("; ")}. Sandbar is stopping ` +
            "admissions and draining; once quiescent it reconciles owned images " +
            "and measures again before deciding whether to exit.",
        });
      } else if (storageLow === null && previousStorageLow !== null) {
        await runRecord.emit({
          kind: "preflight",
          action: "disk-space-recovered",
          detail: `Podman graphroot '${measuredSpace.graphRoot}' recovered to ` +
            `${measuredSpace.availableBytes} bytes free` +
            (measuredVolume === null
              ? ""
              : `, database volume '${measuredVolume.root}' to ${measuredVolume.availableBytes} bytes free`) +
            " after image reconciliation",
        });
      }
      await dbBaseWatch?.observe();
      // The poll snapshot is not a plan-time containment answer. A landing
      // pass pushes from an ephemeral merger clone, and a human may move the
      // source branch between any two wakes, so neither necessarily updates
      // this cache's remote-tracking chunk/source refs. Refresh them for this
      // recompute immediately before buildPlan reads containment (#174).
      const planningRefresh = await fetchPlanningRefs(
        layout.repoDir,
        config.sourceBranch,
      );
      if (planningRefresh.failures.length > 0) {
        if (
          await recoverFromRefRefreshFailure(
            "Planning ref refresh",
            planningRefresh.failures,
          ) === "exit"
        ) {
          break;
        }
        continue;
      }
      if (planningRefresh.sourceChanged && restartDueAs === null) {
        pendingSourceImageRefresh ??= planTrigger === "poll" ? "poll" : "planning";
      }
      if (
        storageLow === null &&
        restartDueAs === null &&
        pendingSourceImageRefresh !== null
      ) {
        if (
          pendingSourceImageRefresh === "poll" ||
          pendingSourceImageRefresh === "planning"
        ) {
          await runRecord.emit({
            kind: "preflight",
            action: "origin-refreshed",
            detail: pendingSourceImageRefresh === "poll"
              ? `origin/${config.sourceBranch} moved during poll; refreshing source images`
              : `origin/${config.sourceBranch} moved before planning; refreshing source images`,
          });
        }
        await refreshSourceImages();
        pendingSourceImageRefresh = null;
      }

      // ---------------------------------------------------------------------
      // Phase 1: Plan
      // ---------------------------------------------------------------------
      // A rate-limit hold skips planning silently (its notice was recorded when
      // it began) and takes the failed-read stall, so a drained restart still
      // exits and every other wake still lands here to look again.
      if (trackerHeldUntil !== null && Date.now() >= trackerHeldUntil) {
        trackerHeldUntil = null;
      }
      if (trackerHeldUntil !== null) {
        if (await recoverFromRefRefreshFailure("Tracker read", []) === "exit") {
          break;
        }
        continue;
      }
      const atPoll = planTrigger === "poll" || planTrigger === "launch";
      const planOptions = {
        excluded: new Set([
          ...mergedThisRun,
          ...[...pool.startedIds()].map(Number),
        ]),
        defaultLane: config.defaultLane,
        readyLabelPolicy,
        // Not less the janitor's slot: a candidate it keeps out is what pre-empts it.
        k: Math.max(0, config.maxParallelIssues - pool.activeCount),
        repoDir: layout.repoDir,
        sourceBranch: config.sourceBranch,
        ongoing: new Set([...pool.startedIds()].map(Number)),
        // Dispatched targets are chunk identity: an in-flight member makes its
        // chunk underway under the root and branch it was sent to (#193).
        inFlight: new Map(
          pool.ongoingIssues().map((issue) => [Number(issue.id), issue.chunk] as const),
        ),
        settledGraph: settledGraphFor(chunkSettle, atPoll),
      };
      // Every forge call the plan makes before the reconciler. A transport
      // failure mid-scan leaves the follow-up scan exactly where a halt and
      // restart would: its ledger is written last, so the retried recompute
      // may repeat a completed prefix but never loses a review.
      const planned = await readTracker(async () => {
        // A chunk whose pull request carries a landing label is frozen
        // (#243), so these are read before planning, and a failed read fails
        // the recompute: read as none, a frozen chunk would take new members.
        const landPullRequests = await fetchLandRequestPullRequests(repo);
        const frozenOptions: BuildPlanOptions = {
          ...planOptions,
          frozenChunks: new Set(landPullRequests.map((pr) => pr.headRefName)),
        };
        let initial = await buildPlan(repo, frozenOptions);
        // The chunk-review scan (#95). Every chunk with work on origin is asked
        // whether a human has requested changes on its pull request, and each
        // review that has not already been handled is routed to and re-queues
        // the landed member(s) it concerns. Inert until a chunk's first landing:
        // `landedChunks` is empty, and the scan makes no call at all.
        //
        // RE-PLANNED when it re-queues anything. The existing issues are handed
        // back rather than re-listed: the listing `gh issue list` serves lags a
        // label flip by seconds (#96), so it may not carry the re-queue this
        // cycle made. A frozen chunk is not asked: rework would move the head
        // its reviewer labelled, so its reviews wait until `land` comes off.
        const followUps = await routeChunkReviewFollowUps({
          chunks: initial.landedChunks.filter(
            (chunk) => !frozenOptions.frozenChunks.has(chunk.branch),
          ),
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
          initial = await buildPlan(repo, {
            ...frozenOptions,
            extraCandidates: followUps,
          });
        }
        return { resolution: initial, followUps, frozenOptions, landPullRequests };
      });
      if ("failure" in planned) {
        if (await recoverFromRefRefreshFailure("Tracker read", [planned.failure]) === "exit") {
          break;
        }
        continue;
      }
      const { followUps, frozenOptions, landPullRequests } = planned.value;
      let resolution = planned.value.resolution;

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
        beforeOriginWrite: renewOriginLease,
        log: (line) => runRecord.emit({ kind: "reconcile", action: "trace", detail: line }).then(() => undefined),
        // A completed reconciliation is irreversible: its chunk branch may
        // already be gone. Record it before the reconciler starts a sibling.
        onReconciled: (chunk) => recordLandingOutcome({
          kind: "chunk-on-source",
          target: chunk.target,
          durationMs: chunk.durationMs,
        }),
        onJanitorReconciled: (janitor) =>
          runRecord.emit(janitorLandEvent(janitor.target, "reconciled", janitor.durationMs)).then(() => undefined),
      });
      await reportJanitorResidue(reconciliation.janitors);
      if (reconciliation.reconciled.length > 0) {
        // Same exclusion the merger's own closes get (#16): the listing
        // endpoint the planner uses lags a close by seconds, so an
        // issue closed one line ago can still come back as a candidate.
        for (const n of reconciliation.closedIssues) mergedThisRun.add(n);
        // Carrying `followUps` again: a member re-queued a block above carries
        // a label flip younger than anything the listing can see, so a re-plan
        // without it would drop the work this cycle just queued.
        // `planOptions.excluded` is
        // `mergedThisRun` itself, so the numbers just added are already in it.
        // The reconciliation is already recorded, so a failed re-plan retries
        // from a recompute that finds those chunks gone.
        const replanned = await readTracker(() => buildPlan(repo, {
          ...frozenOptions,
          extraCandidates: followUps,
        }));
        if ("failure" in replanned) {
          if (await recoverFromRefRefreshFailure("Tracker read", [replanned.failure]) === "exit") {
            break;
          }
          continue;
        }
        resolution = replanned.value;
      }
      if (atPoll) {
        chunkSettle = rememberPollGraph(chunkSettle, resolution.pendingChunkGraph);
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
      const reconcileKeptIssueBranches = reconciliation.reconciled.filter(
        (chunk) => chunk.keptIssueBranches.length > 0,
      );
      if (reconcileKeptIssueBranches.length > 0) {
        await runRecord.emit({ kind: "complaint", severity: "warning", message:
          CHUNK_ISSUE_BRANCHES_KEPT_BANNER({
            chunks: reconcileKeptIssueBranches,
            sourceBranch: config.sourceBranch,
          }) });
      }
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

      // What a human has asked to land, less any branch the reconciliation just
      // finished off: it is not merged again by the merge phase (its branch is
      // gone by then, which the merger would park on).
      const reconciledBranches = new Set([
        ...reconciliation.reconciled.map((chunk) => chunk.target.branch),
        ...reconciliation.janitors.map((janitor) => janitor.target.branch),
      ]);
      const landRequestSelection = selectLandRequests(
        landPullRequests.filter((pr) => !reconciledBranches.has(pr.headRefName)),
        resolution.landedChunks,
        resolution.chunkNameDrifts,
        new Set(config.janitor?.tasks.map((task) => task.name)),
      );
      for (const refusal of landRequestSelection.refusals) {
        await runRecord.emit({
          kind: "complaint",
          severity: "warning",
          message: `Refused land request on PR #${refusal.pullRequest} for ` +
            `${refusal.existing}: ${describeChunkBranchDrift(refusal)}.`,
        });
        await refuseLandRequest(refusal, chunkRequestWrites);
      }
      const selectedLandRequests = landRequestSelection.requests;
      // A closed landing window (#244) holds every source-branch landing but a
      // `land-hotfix` one; `landing-window.ts` owns what waits and how.
      const closedUntil = landingClosedUntil(config.landingWindow, new Date());
      if (closedUntil === null) toldLandingWindow.clear();
      // Whether the closed window holds this request, telling its pull
      // request once per closure.
      const heldByLandingWindow = async (
        request: ChunkLandTarget | JanitorLandTarget,
      ): Promise<boolean> => {
        if (closedUntil === null || !waitsForLandingWindow(request)) return false;
        if (!toldLandingWindow.has(request.pullRequest)) {
          await chunkRequestWrites.commentOnPullRequest(
            request.pullRequest,
            CHUNK_LAND_WINDOW_PR_COMMENT({ sourceBranch: config.sourceBranch, closedUntil }),
          );
          toldLandingWindow.add(request.pullRequest);
        }
        return true;
      };
      const landDeferrals = new Map<string, string>();
      // Deferred requests no pass may land, not even one started for other
      // work: the merger never sees them.
      const heldOffSource = new Set<string>();
      for (const request of selectedLandRequests) {
        if (request.base !== null) {
          // Its branch carries the base's commits, which land with the base.
          landDeferrals.set(request.branch, `stacked on ${request.base} · lands once it lands`);
          heldOffSource.add(request.branch);
        } else if (request.rework.length > 0) {
          landDeferrals.set(request.branch, deferredLandReason(request.rework));
        } else if (await heldByLandingWindow(request)) {
          landDeferrals.set(request.branch, `landing window closed · lands after ${closedUntil}`);
          heldOffSource.add(request.branch);
        }
      }
      const landRequests = selectedLandRequests.filter(
        (request) => !landDeferrals.has(request.branch),
      );
      // Labelled janitor pull requests (#205) the window does not hold. A run
      // of the task in flight is pre-empted, so none grows the branch.
      const janitorLandRequests: JanitorLandTarget[] = [];
      for (const request of landRequestSelection.janitor) {
        if (!(await heldByLandingWindow(request))) janitorLandRequests.push(request);
      }
      const mergerLandRequests = selectedLandRequests.filter(
        (request) => !heldOffSource.has(request.branch),
      );
      const landRequested = landRequests.length > 0 || janitorLandRequests.length > 0;
      if (landRequested) {
        const named = [...landRequests, ...janitorLandRequests]
          .map((r) => `${r.branch} (PR #${r.pullRequest})`)
          .join(", ");
        await runRecord.emit({ kind: "reconcile", action: "land-requested", detail: named });
      }

      const laneNoticeLines: string[] = [];
      const laneNotices = await postLaneOverrideNotices(
        repo,
        resolution.overrides,
        (line) => { laneNoticeLines.push(line); },
        renewOriginLease,
      );
      const planDiagnostics = JSON.stringify({
        waiting: resolution.waiting,
        overrides: resolution.overrides,
        landedChunks: resolution.landedChunks,
        chunkNameDrifts: resolution.chunkNameDrifts,
        selectedLandRequests,
        chunkRefreshes: resolution.chunkRefreshes,
      });
      const planDiagnosticsChanged = lastPlanDiagnostics !== null &&
        planDiagnostics !== lastPlanDiagnostics;
      lastPlanDiagnostics = planDiagnostics;
      const refusedBranches = new Set(
        landRequestSelection.refusals.map((refusal) => refusal.existing),
      );
      // A refused request already emitted the issue's required complaint,
      // naming both its PR and branch. Keep the general drift diagnostic for
      // unlabelled branches without duplicating that complaint.
      const chunkDriftLines = resolution.chunkNameDrifts
        .filter((drift) => !refusedBranches.has(drift.existing))
        .map((drift) =>
          `Origin chunk branch ${drift.existing} is drifted: ` +
          describeChunkBranchDrift(drift)
        );

      // The idle janitor (#205): which configured tasks carry `land` on their
      // pull request, and the task due next when no run is in flight.
      const janitorLandLabelled = new Set(landRequestSelection.janitor.map((request) => request.task));
      const dueJanitor = config.janitor === null || janitor.run !== null
        ? null
        : await dueJanitorTask({
            tasks: config.janitor.tasks,
            layout,
            sourceBranch: config.sourceBranch,
            landLabelled: janitorLandLabelled,
            now: new Date(),
            onNotice: (message) => runRecord.emit({ kind: "notice", message }).then(() => undefined),
          });

      // What may not land yet stays in the pool: a DONE auto-lane issue while
      // the window is closed, the window's other source-branch landing, and a
      // DONE member of a frozen chunk (#243), dispatched before the label went
      // on, until the chunk lands or the label comes off.
      const { frozenChunks } = frozenOptions;
      const heldTerminals = pool.holdTerminals(
        (event) => event.status === "fulfilled" && event.value.type === "DONE" &&
          (event.issue.chunk === null
            ? closedUntil !== null
            : frozenChunks.has(event.issue.chunk.branch)),
      );
      for (const event of heldTerminals) {
        await runRecord.emit({
          kind: "notice",
          message: event.issue.chunk === null
            ? `#${event.issue.id} is done and waits for the landing window: ` +
              `nothing lands on ${config.sourceBranch} until ${closedUntil}.`
            : `#${event.issue.id} is done and waits for ${event.issue.chunk.branch}: ` +
              `its pull request carries a landing label, so nothing more goes onto ` +
              `it until it lands or the label comes off.`,
        });
      }

      const providerClosed = providerExitPending !== null || agentProviders.some(
        (provider) => providerState.get(provider) !== undefined,
      );
      // The plan record is the resolver's answer, not the narrower admission
      // this observation may make. Active slots, cooldown and scheduler state
      // can all reduce admission without changing what the planner resolved.
      const plannedRefreshes = resolution.chunkRefreshes.filter((refresh) =>
        refresh.dependents.length > 0 || !failedBaseRefreshes.has(refresh.branch)
      );
      const schedulerSnapshot = {
        active: activeSlots(),
        ongoing: pool.ongoingCount,
        hasCompleted: pool.hasCompleted,
        hasPendingTerminals: pool.hasPendingTerminals,
        hasCandidates: pool.hasUnstarted(resolution.plan),
        hasRetries: pool.hasRetries,
        hasLandRequests: landRequested,
        hasChunkRefreshRequests: plannedRefreshes.length > 0,
        hasCapacity: activeSlots() < config.maxParallelIssues,
        noProgressSinceLanding: pool.noProgressSinceLanding,
        noProgressBackstop: MAX_CONSECUTIVE_NO_PROGRESS_WITHOUT_LANDING,
        providerClosed,
        restartDue: restartDueAs !== null,
        storageLow: storageLow !== null,
        janitorRunning: janitor.run !== null && !janitor.run.controller.signal.aborted,
        janitorStartable: dueJanitor !== null,
        janitorLandRequested: janitor.run !== null && janitorLandLabelled.has(janitor.run.task),
      };
      const schedulerAction = decideSchedulerAction(schedulerSnapshot);
      const chunkRefreshes = chunkRefreshRequestsAreRunnable(schedulerSnapshot)
        ? plannedRefreshes
        : [];
      const pollDidWork =
        sourceChangedOnPoll || planDiagnosticsChanged ||
        followUps.length > 0 || laneNotices.length > 0 ||
        reconciliation.reconciled.length > 0 || reconciliation.janitors.length > 0 ||
        landRequested || landRequestSelection.refusals.length > 0 ||
        heldTerminals.length > 0 ||
        chunkRefreshes.length > 0 ||
        schedulerAction.kind === "admit" || schedulerAction.kind === "land" ||
        schedulerAction.kind === "janitor" || schedulerAction.kind === "preempt-janitor";
      const pollIsReportable = pollDidWork || resolution.waiting.some(
        (entry) => entry.reason.kind === "label-actor",
      );
      if (planTrigger === "poll" && pollDidWork) {
        activity.enterBusy();
      }
      if (schedulerAction.kind === "exit") {
        await emitRecompute(iteration, planTrigger, resolution, [], selectedLandRequests);
        await emitObservedLandRequests(selectedLandRequests, landRequests, landDeferrals);
        terminalExit = await announceExit(
          schedulerExit(schedulerAction.reason, {
            pool,
            providerExit: providerExitPending ?? closedProviderExit(config, providerState),
            restartDetail: requestedRestartDetail(),
            storage: storageLow,
          }),
        );
        break;
      }

      if (schedulerAction.kind === "admit") await renewOriginLease();
      const admission = schedulerAction.kind === "admit"
        ? pool.admit(resolution.plan, false, activeSlots() - pool.activeCount)
        : [];
      const executionIssues = [...admission];
      const issues = executionIssues;
      if (issues.length > 0) {
        activity.enterBusy();
      }
      if (planTrigger !== "poll" || pollIsReportable) {
        await emitRecompute(iteration, planTrigger, resolution, issues, selectedLandRequests);
        await emitObservedLandRequests(selectedLandRequests, landRequests, landDeferrals);
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
      const admissionConfig = innerLoopConfigOf(config, {
        layout,
        issueSource: ghIssueSource(repo),
        scope,
        env: sandboxEnv,
        codexAuthMount,
        agentImages: admissionImages.agentImages,
        egress: egressContext,
      });
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
              stackSource,
              // Sandbox-sibling logs land beside this issue's attempt
              // transcripts (#44 D4), so the offline artefact of what the
              // agent's stack was doing sits next to the transcript of what the
              // agent did.
              sandboxLogBaseDir: issueLogger.dir,
              attemptLogger: issueLogger,
              gateSemaphore,
              dbCopies,
              onEvent: (event) => runRecord.emit(event).then(() => undefined),
              providerState,
            });
            await runRecord.emit(terminalEventOf(issue, terminal, issueTimer()));
            return terminal;
          } catch (err) {
            await runRecord.emit(terminalEventOf(issue, rejectedEnding(err), issueTimer()));
            throw err;
          }
        })();
        pool.start(issue, task);
      }
      if (schedulerAction.kind === "preempt-janitor") janitor.run?.controller.abort();
      if (schedulerAction.kind === "janitor" && dueJanitor !== null) {
        activity.enterBusy();
        startJanitor(dueJanitor, {
          config: admissionConfig,
          hooks: config.sandboxHooks,
          copyToWorktree: config.copyToWorktree,
          branchImages: admissionImages.branchImages,
          stackSource,
          gateSemaphore,
          dbCopies,
          providerState,
        });
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
        if (activeSlots() === 0 && !activity.isIdle()) {
          await runRecord.emit({ kind: "idle", pollIntervalMs: config.pollIntervalMs });
          activity.enterIdle();
        }
        const wake = await waitForSchedulerWake();
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

      const landingTogetherReason = (request: ChunkLandTarget): string => {
        const companions = [
          ...completedIssues.map((issue) =>
            `#${issue.id} → ${issue.chunk ? "its chunk" : config.sourceBranch}`),
          ...landRequests
            .filter((other) => other.branch !== request.branch)
            .map((other) => `PR #${other.pullRequest}`),
        ];
        return companions.length > 0
          ? `landing together with ${companions.join(", ")}`
          : "";
      };
      for (const [index, request] of landRequests.entries()) {
        const previous = landRequests[index - 1];
        await runRecord.emit(landRequestEvent(request, index === 0
          ? { kind: "landing", step: "merge", reason: landingTogetherReason(request) }
          : { kind: "queued", reason: `lands after PR #${previous!.pullRequest}` }));
      }


      // ---------------------------------------------------------------------
      // Phase 3: Merge (procedural, in an isolated worktree off origin)
      // ---------------------------------------------------------------------
      let mergerSummary: MergerSummary | null = null;
      let sourceSettledSummary: MergerSummary | null = null;
      // Tracker state the merger had already applied when it threw (see
      // MergerError.partial). Finalised even though the run is stopping.
      let haltPartial: MergerSummary | undefined;
      let halt = false;
      let mergerProviderError: AgentQuotaError | AgentCredentialError | null = null;
      let unexpectedLandingFailure: { readonly error: unknown } | null = null;
      let postRefreshFailure: { readonly error: unknown } | null = null;
      // Why the run is stopping, in the short names the run log already uses.
      // Declared up here rather than beside the reports that fill it because
      // the merge phase's own halt is one of them, and the `Exit (halted): …`
      // line has to be able to name it (#70).
      const haltReasons: string[] = [];
      // Also for a land request alone (#64): a reviewed chunk merging onto the
      // source branch needs the same worktree, the same gate-2 stack and the
      // same resolve loop a DONE branch does, and a cycle can have one without
      // the other.
      if (completedIssues.length > 0 || landRequested || chunkRefreshes.length > 0) {
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
        // every branch in the landing batch — its issue-lifecycle containers
        // start once, and again only when a merge result's env overlay changes
        // the spec in effect (#186).
        let mergerWorktree: MergerWorktree | null = null;
        let mergerStack: BoundStack | null = null;
        try {
          mergerWorktree = await createMergerWorktree({
            layout,
            sourceBranch: config.sourceBranch,
          });
          const mergerWorktreePath = mergerWorktree.path;
          mergerStack = await bindStack({
            stackId: MERGER_STACK_ID,
            scope,
            worktreePath: mergerWorktree.path,
            hideWorktreeGit: true,
            onNotice: (message) => runRecord.emit({
              kind: "complaint", severity: "warning", message,
            }).then(() => undefined),
            onContainerTeardown: (record) => runRecord.emit({
              kind: "container",
              stack: "gate",
              ...record,
            }).then(() => undefined),
            ...egressOf(egressContext, runRecord.emit, "gate"),
            // gate-2 needs this as much as gate-1 does (#37): the merge result
            // is a tree neither branch had, and two branches that each touched
            // the lockfile compose into a third lockfile. Resolved per gate
            // run, so each merge in the landing is gated against its own.
            images: (only) => landingImages.branchImages.resolve(mergerWorktreePath, only),
          }, (await stackSource.current()).stack);
          const stackForGate2 = mergerStack;
          // What the merge result at HEAD makes of the stack file, asked
          // afresh at every gate-2 and every keep-or-revert decision: HEAD
          // moves with each merge, revert and resolve attempt in the landing.
          const headStack = () => stackSource.forHead(mergerWorktreePath, "HEAD");
          const adapter = realAdapter({
            cwd: mergerWorktree.path,
            cacheDir: layout.repoDir,
            anchorCacheDir: layout.anchorCacheDir,
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
            runStackGate: async () => {
              const stack = await stackForGate2.ensure((await headStack()).stack);
              return gateSemaphore.run(() => stack.runGate());
            },
            stackChange: async () => stackChangeOf((await headStack()).classification),
            beforeOriginWrite: renewOriginLease,
            ...egressOf(egressContext, runRecord.emit, "resolve"),
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
                    beforeOriginWrite: renewOriginLease,
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
              handoffLabel: config.labels.handoff,
              ongoingIssues: pool.ongoingIssues(),
              projectAnchor,
              repoSlug: repoSlug(repo),
              promptExtension: config.promptExtensions.merger,
              // #67: every resolve attempt's stdout and stderr, beside the
              // gate artefact it was prompted from. The writer answers with
              // the path, which is what the abandon comment points at.
              onResolveAttempt: async (key, record) => {
                const path = await landingLogger.writeResolveAttempt(key, record);
                const usage = usageFields(record, record.rateLimit);
                await runRecord.emit({
                  kind: "resolve-attempt",
                  ...landingSubject(record.issueId),
                  attempt: record.attempt,
                  container: record.container,
                  end: record.end,
                  exitCode: record.exitCode,
                  signal: record.signal,
                  durationMs: record.durationMs,
                  provider: config.mergerAgent,
                  model: config.mergerModelId,
                  ...(usage === undefined ? {} : { usage }),
                  ...containerResourcesOf(record),
                });
                return path;
              },
              observations: {
                onProgress: async (key, step) => {
                  const request = landRequests.find(
                    (candidate) => key === `chunk-${candidate.root}`,
                  );
                  if (!request) return;
                  await runRecord.emit(landRequestEvent(request, {
                    kind: "landing",
                    step,
                    reason: landingTogetherReason(request),
                  }));
                },
                onGate: (key, gate, sync) => {
                  const issueId = key.startsWith("chunk-refresh-")
                    ? key.slice("chunk-refresh-".length)
                    : key.startsWith("chunk-")
                    ? key.slice("chunk-".length)
                    : key;
                  const planned = completedIssues.find((issue) => issue.id === issueId);
                  return runRecord.emit({
                    kind: "gate",
                    gate: "gate-2",
                    ...landingSubject(issueId),
                    ...(planned ? { title: planned.title } : {}),
                    ...(sync === undefined ? {} : { sync }),
                    ok: gate.ok,
                    durationMs: gate.durationMs,
                    ...(gate.queuedMs === undefined ? {} : { queuedMs: gate.queuedMs }),
                    steps: Object.fromEntries(
                      gate.steps.map(({ name, ...step }) => [name, step]),
                    ),
                  }).then(() => undefined);
                },
                onOutcome: recordLandingOutcome,
              },
              ...(verified ? { verified } : {}),
              // Scheduling sees only runnable requests, but a pass started for
              // another reason still lets the merger observe the ones deferred
              // for rework: it re-defers them and says so on their pull
              // requests (#64, #168).
              ...(mergerLandRequests.length > 0 || janitorLandRequests.length > 0
                ? {
                    chunkLanding: {
                      requests: mergerLandRequests,
                      janitor: janitorLandRequests,
                      sourceBranch: config.sourceBranch,
                    },
                  }
                : {}),
              ...(chunkRefreshes.length > 0
                ? {
                    chunkRefresh: {
                      requests: chunkRefreshes,
                      sourceBranch: config.sourceBranch,
                    },
                    onSourceSettled: (summary: MergerSummary) => {
                      sourceSettledSummary = summary;
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
            if (err.cause instanceof OriginLeaseLostDuringCleanupError) {
              throw err.cause;
            }
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
            // filtering on `needs-human`. Nothing here lands code ON THE SOURCE
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
            if (err instanceof OriginLeaseLostDuringCleanupError) throw err;
            if (sourceSettledSummary !== null) {
              mergerSummary = sourceSettledSummary;
              if (err instanceof AgentQuotaError || err instanceof AgentCredentialError) {
                mergerProviderError = err;
                recordProviderClosure(providerState, err);
              } else {
                postRefreshFailure = { error: err };
              }
            } else {
              // Unknown failures are not merger verdicts. Carry the original
              // value across the resource cleanup below, drain sibling work,
              // then let the outer internal-failure handler report it unchanged.
              unexpectedLandingFailure = { error: err };
            }
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
            unexpectedLandingFailure?.error ?? postRefreshFailure?.error ?? null,
          );
        }
        if (unexpectedLandingFailure) {
          // Cleanup-shaped, so it follows the cleanup rule: the drain reports
          // its own failure beside the original and the ORIGINAL is what
          // escapes. A drain that threw in place of the landing failure would
          // hand the internal-failure banner the wrong fault — a finalize
          // hiccup on a sibling instead of the landing that actually broke —
          // and the log would name a cause the operator cannot act on.
          await drainPreservingLandingFailure(unexpectedLandingFailure.error);
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
        // A push race the merge result could not follow (#253) landed none of
        // them: they wait in the pool, and the next landing pass re-merges
        // each onto origin's new tip.
        const raceDeferred = new Set<string>();
        if (mergerOutcome.raceDeferral) {
          const { reason, issues } = mergerOutcome.raceDeferral;
          for (const issue of issues) {
            raceDeferred.add(issue.id);
            await runRecord.emit({
              kind: "notice",
              message: `#${issue.id} is done and waits for the next landing pass: ` +
                `${config.sourceBranch} moved during this one and ${reason}.`,
            });
          }
          pool.hold(settled.filter((event) => raceDeferred.has(event.issue.id)));
        }
        for (const issue of completedIssues) {
          if (!freshAttempts.has(issue.id) && !raceDeferred.has(issue.id)) {
            pool.finishTerminal(issue);
          }
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
      const landedKeptIssueBranches = landedChunks.filter(
        (chunk) => chunk.keptIssueBranches.length > 0,
      );
      if (landedKeptIssueBranches.length > 0) {
        await runRecord.emit({ kind: "complaint", severity: "warning", message:
          CHUNK_ISSUE_BRANCHES_KEPT_BANNER({
            chunks: landedKeptIssueBranches,
            sourceBranch: config.sourceBranch,
          }) });
      }

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
      await reportJanitorResidue(mergerSummary?.mergedJanitors ?? []);

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
        ? mergerSummary.merged.length + mergerSummary.mergedChunks.length +
          mergerSummary.mergedJanitors.length
        : 0;
      const landedNow = sourceLandings + (mergerSummary?.chunkLanded.length ?? 0);
      pool.recordLandingOutcome(
        outcomes.length,
        landedNow,
      );
      nextPlanTrigger =
        landRequested || chunkRefreshes.length > 0 || landedNow > 0
        ? "landing-finished"
        : "terminal-finalized";
      if (sourceLandings > 0) {
        pendingSourceImageRefresh ??= "landing";
      }
      if (landedNow > 0) kickDeployWatch();
      if (postRefreshFailure) {
        await drainPreservingLandingFailure(postRefreshFailure.error);
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
    // Cleanup already owns the terminal transition. The rejected barrier has
    // stopped the remote write; do not turn that expected race into another
    // complaint/exit pair in the record.
    if (err instanceof OriginLeaseLostDuringCleanupError) throw err;
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
