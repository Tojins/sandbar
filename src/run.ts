// Sandbar orchestrator — four-phase loop.
//
//   Phase 1 (Plan):            Deterministic resolver picks the unblocked
//                              `ready-for-agent` issues by parsing each body's
//                              `## Blocked by` section — and routes each by
//                              LANE (#57), holding back the review-gated ones
//                              that have nowhere to land at all (#61: the ones
//                              `chunks.ts` could give no chunk) and saying on
//                              the issue where an `auto-land` label lost to
//                              inherited gating. A changes-requested review on
//                              a chunk's pull request is filed as a follow-up
//                              issue in that chunk first (#63), and the
//                              RECONCILER (#64) finishes off any chunk branch
//                              already contained in origin/<sourceBranch> —
//                              hand-merged, or landed by a run that died
//                              before it could close the members. The plan is
//                              rebuilt after either, so a follow-up filed now
//                              is queued now and a member closed now stops
//                              blocking its dependents.
//   Phase 2 (Inner-loop ralph): Each issue runs in its own sandbox up to
//                              config.maxImplAttempts times; on gate-1 green
//                              the (strictly-advisory) reviewer runs in the
//                              same sandbox and consumes one of
//                              config.maxReviewRounds. APPROVED → DONE;
//                              CHANGES-REQUESTED loops back to a new impl
//                              attempt carrying the reviewer's prose. The two
//                              budgets are not independent (#71): a round is
//                              only ever spent alongside an attempt, so the
//                              budget an issue gets is at most
//                              min(maxImplAttempts, maxReviewRounds), and it is
//                              exactly that on the green-gate loop where every
//                              attempt ends in a verdict. An attempt that ends
//                              without one — a red gate, a re-prompt, or a
//                              reviewer harness failure (#41) — spends no
//                              round. The defaults are equal, 8 and 8, so both
//                              exhaust on the same attempt and the issue parks
//                              as NEEDS-HUMAN-REVIEW — the terminal that hands
//                              the human the latest review.
//   Phase 3 (Merge):           Procedural merger lands DONE branches into
//                              the source branch and pushes once — directly,
//                              or (config.mergeMode = verified, #22) only after
//                              the forge's checks pass on the merge result.
//                              A review-gated issue lands on its CHUNK's
//                              branch instead (#60), which is pushed as it
//                              goes and carries a DRAFT pull request opened or
//                              updated per cycle (#62); nothing of it reaches
//                              the source branch until a human has reviewed
//                              the chunk and put `land` on that pull request
//                              (#64) — at which point the chunk branch is
//                              merged in the SAME source pass, its members are
//                              closed, and the branch is deleted.
//   Phase 4 (Finalise):        Per-issue branch lifecycle — push/delete the
//                              local branch, post a bot-prefixed comment,
//                              flip labels. Runs in TWO passes (#30): 4a
//                              finalises the agent terminals BEFORE the merge
//                              (they don't depend on it, and a merge phase that
//                              throws something other than MergerError must not
//                              discard a full attempt budget's worth of
//                              questions, traces and reviewer prose), 4b
//                              finalises the merger's own outcomes after.
//
// A per-run log tree at <cwd>/<workDir>/logs/run-<UTC-ISO>/ captures decisions
// and agent output: orchestrator.log at the run root, plan.json + merger.log
// + issue-<id>/attempt-<m>.log per cycle.
//
// IT EXISTS FROM THE MOMENT THE LOCK IS WON (#70), which is fifteen steps
// earlier than it used to. Everything before `startRunLogger` is unrecorded by
// construction, and that used to include preflight, the three startup sweeps,
// the image builds and the uid check — so the single most operator-actionable
// thing sandbar produces, a preflight refusal, was the one class of stop that
// left nothing to read afterwards. Every one of those now writes its complaint
// into the tree before it dies (`stopAtStartup`), the sweeps, the builds and
// the uid check included: those three escaped `run()` uncaught altogether, so
// they skipped cleanup as well as the record.
//
// THE BOUNDARY IS THE LOCK, and three exits sit outside it deliberately. Two
// are pre-lock by construction: writing a log tree before the lock is won means
// writing one while a second launch may be racing us for the same workdir, and
// neither of these two needs the tree to be actionable.
//   - `resolveConfig` refusing the config, which since #66 includes a
//     `requiresSandbar` minimum this driver is below. It names both versions,
//     and the operator is standing at the config file it names.
//   - GH_TOKEN missing. Its message is self-contained: declare the key.
// The third is post-lock and leaves no record on purpose:
//   - Losing the lock. The answer to "what happened" is the OTHER run's log,
//     and one empty directory per turned-away launch is noise in the one tree
//     an operator greps.
//
// And the run STOPS IN ONE SHAPE. `Exit (<tag>): <reason>` on stdout, once, on
// every terminal path — plan-empty, relaunch, stuck, budget, halted, and the
// defensive iteration ceiling. There used to be five terminal shapes in four
// spellings, one of which (the halt) printed nothing on stdout at all and one
// of which (plan-empty) printed a success banner. `exit-conditions.ts` owns
// the tags, the reasons and the line; `announceExit` below is the single site
// that emits it, to BOTH streams — the log so `exit: <tag>` is greppable
// however far the run got, stdout so a human reading a terminal gets the same
// answer. It is reached by the startup stops as well as by the cycle loop, and
// a terminal path that does not call it prints nothing, which is the failure
// this issue is named after. Nothing else in this file may format that line: a
// `console.log` per call site is the same hand-pairing `logs.ts`'s invariant
// exists to end, reproduced for the one line it is about — and this is the one
// claim in the file no test can make, since nothing calls `run()`.
//
// Ahead of all of it, on stdout and then again as orchestrator.log's first
// line, is the DRIVER IDENTITY (#69) — the version, the tree `dist/` was built
// from, the config file's path, and whether either tree is dirty. It is printed
// before the lock, before preflight and before the config is even resolved,
// because those can each end the run and the answer to "what produced this
// verdict, or this complaint" has to be above them. `driver-identity.ts` owns
// what it can and cannot claim.
//
// Outer-loop termination is governed by exit-conditions.ts: plan-empty →
// success, repeated-plan-with-zero-DONEs or two consecutive zero-DONE cycles
// → stuck, issuesAttempted hits maxTotalIssues → budget — and, with
// config.relaunchAfterLanding, any cycle that landed merges → exit
// EXIT_CODE_RELAUNCH so a looping launcher can start the next cycle from
// re-resolved inputs (#65). Which inputs those are narrowed with #66 and is
// `exit-conditions.ts`'s to state: the driver is a pinned release and does not
// move at all, images ARE re-resolved from origin/<sourceBranch>, and the
// config file is re-imported from the operator's checkout, which nothing
// refreshes. MAX_ITERATIONS is a defensive ceiling — the conditions above
// terminate first.

import { realpathSync } from "node:fs";

import { type ResolvedConfig, type RunConfig, resolveConfig } from "./config.js";
import {
  type SweepResult,
  cleanupOrphanContainers,
  findUnattributableResources,
} from "./containers.js";
import { installCleanupTraps, onCleanup, runCleanup } from "./cleanup.js";
import {
  fileChunkReviewFollowUps,
  realAdapter as realChunkFollowUpAdapter,
} from "./chunk-follow-up.js";
import {
  formatDriverIdentity,
  readDriverIdentity,
} from "./driver-identity.js";
import {
  type BranchImages,
  checkWorktreeImageUids,
  createBranchImages,
  ensureImages,
  pulledImagesOf,
  removeBranchImages,
  sweepBranchImages,
  worktreeMountingTagsOf,
} from "./ensure-images.js";
import { makeEnvReader } from "./env.js";
import { SandbarError, faultDetail } from "./errors.js";
import {
  type TerminalExit,
  applyCycle,
  budgetExit,
  formatExitLine,
  haltedExit,
  iterationCeilingExit,
  newRunState,
  planEmptyExit,
  planFingerprint,
  remainingBudget,
} from "./exit-conditions.js";
import {
  type FinalizeInput,
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
import { startKeepawake, stopKeepawake } from "./keepawake.js";
import { runInnerLoop, type Terminal } from "./inner-loop.js";
import { buildAgentProvider, requiredAgentProviders } from "./agent-providers.js";
import { LockHeldError, acquireLock, lockPathsFor } from "./lock.js";
import { runScope } from "./naming.js";
import { startRunLogger } from "./logs.js";
import {
  MergerError,
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
import { type PlannedIssue, buildPlan } from "./plan-resolver.js";
import {
  absoluteMountSources,
  PreflightError,
  runPreflight,
} from "./preflight.js";
import { buildProjectAnchor } from "./prompt.js";
import {
  ensureRepoCache,
  ensureSourceWorktree,
  repoLayout,
} from "./repo-cache.js";

// Defensive ceiling on cycles. The real terminators are in exit-conditions.ts
// (success / stuck / budget) — MAX_ITERATIONS just guarantees the loop is
// bounded if those checks ever fail to fire.
const MAX_ITERATIONS = 100;

// The merge phase's stack id. Distinct from every issue id (which are numeric),
// so its pod, network and containers can never collide with an issue's.
const MERGER_STACK_ID = "merger";

// A leaked resource is recoverable — the next cycle's `startStack` force-removes
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
  log: (line: string) => Promise<void>,
): Promise<void> {
  if (result.failures.length === 0) return;
  console.warn(
    `Could not remove ${result.failures.length} orphaned sandbar resource(s). ` +
      "They will be retried next cycle; clear them by hand if they persist:\n" +
      result.failures.join("\n"),
  );
  await log(
    `sweep: could not remove ${result.failures.length} orphaned resource(s): ` +
      result.failures.join("; "),
  );
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
  console.log(driverIdentity);

  const config = resolveConfig(rawConfig);
  const env = makeEnvReader(config.env);
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
  // Per-run log tree
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
  // the lock, and `startRunLogger` is one `mkdir -p` plus one append.
  //
  // Append writers are unbuffered, so the cleanup trap only needs to drop a
  // closing run-end marker — no in-memory state to flush.
  //
  // Which exits stay outside the record, and why, is the header's to say: it is
  // one enumeration and it belongs in one place, where it can be counted.
  // -------------------------------------------------------------------------
  const runLogger = await startRunLogger({
    baseDir: layout.logsDir,
  });
  console.log(`Run log tree: ${runLogger.runDir}`);
  // The same line the banner already printed, now in the tree it belongs to
  // (#69). It is the first line after `run-start` because every verdict below
  // it — including, since #70, the startup refusals — is a verdict this driver
  // reached.
  await runLogger.appendOrchestrator(driverIdentity);
  let cleanupReason = "normal-exit";
  onCleanup(() => runLogger.finalize(cleanupReason));

  // THE one site that emits a terminal (#70), and it is declared up here
  // because the startup stops below reach it as well as the cycle loop does:
  // an operator greps `orchestrator.log` for how the run ended without knowing
  // yet how far it got, so a run refused by preflight and a run that exhausted
  // its budget must leave the same shape of line. It also owns
  // `cleanupReason`, which makes `run-end (<tag>)` agree with it by
  // construction rather than by two assignments kept in step by hand.
  //
  // BOTH STREAMS FROM HERE, rather than a `console.log` at each call site.
  // Two streams, one invariant (logs.ts): the log carries every outcome, stdout
  // additionally renders it — here in the same words, since there is only one
  // sentence to say. Doing it in one place is what makes "exactly one
  // `Exit (…)` line, on every terminal path" structural, and structure is all
  // there is: nothing calls `run()`, so no test can catch a path that prints
  // none.
  //
  // It RETURNS the exit rather than assigning `terminalExit` itself, which
  // would be shorter and is wrong: TypeScript does not track assignments made
  // inside a closure, so the `terminalExit` this function ends on would narrow
  // to `null` and the exit CODE taken off it would be unreachable as far as
  // the checker is concerned.
  const announceExit = async (exit: TerminalExit): Promise<TerminalExit> => {
    cleanupReason = exit.tag;
    await runLogger.appendOrchestrator(`exit: ${exit.tag} — ${exit.reason}`);
    console.log(`\n${formatExitLine(exit)}`);
    return exit;
  };

  // Every stop between here and the first cycle goes through this, so none of
  // them can be the silent one again (#70). It records the complaint verbatim,
  // prints it, then hands `announceExit` the same `Exit (halted): …` every
  // other terminal path ends on, and runs cleanup — which is what recovers the
  // `run.pid` sidecar, since `process.exit` runs no handler.
  //
  // Two log lines rather than one because they answer different questions and
  // only one of them fits on a line: `stopped (<cause>)` carries the complaint
  // — a preflight refusal is paragraphs — and `exit:` carries the verdict, in
  // the shape a terminal is greppable by.
  //
  // An unexpected error takes the same route rather than escaping to the bin.
  // It still prints its stack (`faultDetail`'s rule, shared with the bin), so
  // nothing about locating a bug gets worse; what changes is that the record
  // exists either way, which is the whole point of the paragraph above.
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
    // anything else as a stack — errors.ts owns that rule and all three places
    // sandbar prints a fault share it. The one case it does not know about is
    // PreflightError, which extends Error rather than SandbarError and whose
    // message IS the operator-actionable report.
    const detail =
      err instanceof PreflightError ? err.message : faultDetail(err);
    await runLogger.appendOrchestrator(`stopped (${cause}): ${detail}`);
    console.error(detail);
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

  // Preflight is still ahead of the sweep and every container operation below,
  // which is the dependency that matters: those assume a working container
  // runtime because this is what hard-fails when there isn't one.
  try {
    // The object cache, before anything reads a ref (#38). Created from
    // `config.cwd` when absent — a local clone, so hardlinked and offline —
    // and its `origin` retargeted to whatever URL that checkout carries. Under
    // the lock, because it writes into the state directory; before preflight,
    // because preflight fetches into it.
    //
    // Inside preflight's catch because its failures are the same KIND of
    // failure: `cwd` is not a repo, it has no `origin`, the clone did not
    // work. Every one is a startup complaint an operator acts on, so it prints
    // as its message alone — a `SandbarError` by `faultDetail`'s own rule, a
    // `PreflightError` by `stopAtStartup`'s one exception to it — and exits,
    // and, unlike letting it escape to the bin, it runs cleanup first, which is
    // what recovers the `run.pid` sidecar.
    await ensureRepoCache(layout);
    await runPreflight({
      layout,
      env,
      sourceBranch: config.sourceBranch,
      repo,
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
      agentProviders: requiredAgentProviders(config),
    });
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
      console.log(
        `Removed ${orphans.removed.length} orphaned sandbar resource(s) from prior runs.`,
      );
      await runLogger.appendOrchestrator(
        `swept ${orphans.removed.length} orphan(s) from prior runs: ${orphans.removed.join(", ")}`,
      );
    }
    await reportSweepFailures(orphans, (line) =>
      runLogger.appendOrchestrator(line),
    );

    // The image half of the same sweep (#37). Per-branch gate images are
    // removed at the end of a run, but that removal is an `onCleanup` action
    // and so does not run on SIGKILL, a hard crash, or a `podman build` that
    // outlived its parent — and these are the largest things sandbar creates.
    // Startup only: within a run they are reused, and they carry this scope, so
    // anything found here belongs to a predecessor of this workdir that is
    // provably not running.
    const staleImages = await sweepBranchImages(scope);
    if (staleImages.removed.length > 0) {
      console.log(
        `Removed ${staleImages.removed.length} per-branch gate image(s) left by a prior run.`,
      );
      await runLogger.appendOrchestrator(
        `swept ${staleImages.removed.length} stale per-branch gate image(s): ${staleImages.removed.join(", ")}`,
      );
    }
    await reportSweepFailures(staleImages, (line) =>
      runLogger.appendOrchestrator(line),
    );

    // Debris no run's scope claims: from a build predating #28, or the
    // sandcastle era. Reported rather than removed, because a bare-prefix match
    // cannot tell it from a concurrently-running old sandbar's LIVE resources —
    // which is the failure #28 exists to end. Nothing clears it but the
    // operator, so this repeats every startup until they run the commands.
    const unattributable = await findUnattributableResources();
    if (unattributable.names.length > 0) {
      console.warn(
        `\n${unattributable.names.length} podman resource(s) carry a sandbar name from ` +
          "before this version's per-run scoping and cannot be attributed to any " +
          "run, so sandbar will not remove them. If no other sandbar is running, " +
          "clear them with:\n" +
          unattributable.removalCommands.map((c) => `  ${c}`).join("\n") +
          "\n",
      );
      await runLogger.appendOrchestrator(
        `unattributable podman resource(s), not removed: ${unattributable.names.join(", ")}`,
      );
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
  // exited without running cleanup and without the log tree ever hearing about
  // it (#70). An unbuildable declared image and a bad uid are ordinary
  // host-configuration faults, and they are now recorded like every other
  // refusal.
  let sourceWorktree: string;
  let baseFingerprints: ReadonlyMap<string, string>;
  try {
    sourceWorktree = await ensureSourceWorktree(layout, config.sourceBranch);
    baseFingerprints = await ensureImages(config.images, sourceWorktree);
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
  const branchImages: BranchImages = createBranchImages({
    images: config.images,
    scope,
    baseFingerprints,
    // D3, re-asked for anything the branch rebuilds. The startup check below
    // covers the declared images once; a variant is built from a Containerfile
    // the branch may have edited, so its uid is not the one that was probed.
    worktreeMountingTags: worktreeMountingTagsOf(config.gateStack),
    hostUid: process.getuid?.() ?? 0,
  });
  onCleanup(async () => {
    const tags = branchImages.builtTags();
    if (tags.length === 0) return;
    const failures = await removeBranchImages(tags);
    if (failures.length > 0) {
      console.warn(
        `Could not remove ${failures.length} per-branch gate image(s) built ` +
          "for this run. They cost disk and nothing else — the tags are " +
          "content-addressed and scoped, so a leftover is reused rather than " +
          `mistaken for something current:\n${failures.join("\n")}`,
      );
      // The twin of `reportSweepFailures`, which is what removes these tags'
      // predecessors at the NEXT startup and which takes a log writer for this
      // exact reason (#70): a failed removal is an outcome, so it exists in the
      // log whether or not anyone was watching the terminal. Leaving the
      // end-of-run half unpaired while the start-of-run half is paired is the
      // drift `logs.ts`'s invariant is written to stop — and it is the half
      // that runs while an operator has most likely stopped reading.
      //
      // Safe to write from here: `runLogger.finalize` is registered above this
      // handler and cleanup is LIFO, so the run-end marker is still to come.
      await runLogger.appendOrchestrator(
        `could not remove ${failures.length} per-branch gate image(s): ` +
          failures.join("; "),
      );
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

  startKeepawake();
  onCleanup(stopKeepawake);

  const runState = newRunState({
    maxTotalIssues: config.maxTotalIssues,
    relaunchAfterLanding: config.relaunchAfterLanding,
  });
  // The one stop this run ends on (#70). Every break out of the loop below
  // assigns it what `announceExit` has already emitted, and the process exit
  // code comes off it at the bottom of the function — so "did this stop
  // normally?" is answered by one line in one place, on every path, instead of
  // by four spellings of which one printed nothing at all. It also retires a
  // second `exitCode` variable that had to be kept in step with the tag by
  // hand.
  let terminalExit: TerminalExit | null = null;

  // One Phase-4 pass. Called twice per cycle (#30): once for the agent
  // terminals before the merge, once for the merger's own outcomes after. The
  // `label` is only there so the two are distinguishable in the console and the
  // orchestrator log.
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
    });
    const finalizeResults = await finalizeAll(
      inputs,
      finalizeAdapter,
      config.labels,
    );
    console.log(`\nFinalise (${label}): ${finalizeResults.length} issue(s).`);
    for (const r of finalizeResults) {
      const issue = r.input.issue;
      const tag =
        r.action.kind === "deleted-local"
          ? "deleted local branch"
          : r.action.kind === "delete-failed"
            ? `delete failed (${r.action.error})`
            : r.action.kind === "pushed"
              ? "pushed branch"
              : r.action.kind === "skipped-closed"
                ? "skipped (issue already closed)"
                : "no action";
      console.log(`  #${issueNumberOf(issue)} ${r.input.kind} → ${tag}`);
      await runLogger.appendOrchestrator(
        `finalise #${issueNumberOf(issue)} ${r.input.kind} → ${tag}`,
      );
    }
  };

  // Issue numbers merged+closed earlier in THIS run. The `gh` search backend
  // the planner lists through lags label/close writes, so without this an issue
  // merged in a prior iteration can resurface as a candidate, get re-planned,
  // and get stamped agent-stuck on a closed-COMPLETED issue (#16). Fed to
  // buildPlan as a hard exclusion alongside its live-state CLOSED check.
  const mergedThisRun = new Set<number>();

  // One adapter for the whole run, like `repo` itself: the chunk-review scan
  // (#63) reads and writes the same repository every cycle.
  const followUpAdapter = realChunkFollowUpAdapter({
    repo,
    sourceBranch: config.sourceBranch,
  });

  const innerLoopCfg = {
    layout,
    repo,
    sourceBranch: config.sourceBranch,
    env: config.env,
    implementerModelId: config.implementerModelId,
    reviewerModelId: config.reviewerModelId,
    implementerAgent: config.implementerAgent,
    reviewerAgent: config.reviewerAgent,
    maxImplAttempts: config.maxImplAttempts,
    maxReviewRounds: config.maxReviewRounds,
    sandboxImage: config.sandboxImage,
    scope,
    gateStack: config.gateStack,
    claudeMdPath: config.claudeMdPath,
    contextMdPath: config.contextMdPath,
    adrDir: config.adrDir,
    codingStandardsPath: config.codingStandardsPath,
  };

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  try {
    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      // -----------------------------------------------------------------------
      // Between-cycle orphan sweep. Phase 2/3/4 already tear down their own
      // resources in finally blocks, and startStack registers its teardown
      // BEFORE creating any podman resource — but a signal in the window where
      // the pod exists and the process is already unwinding can still leave a
      // pod, its invisible infra container or a network behind, which would
      // then collide with the next cycle's create. Cheap insurance.
      // -----------------------------------------------------------------------
      if (iteration > 1) {
        const cycleOrphans = await cleanupOrphanContainers(scope);
        if (cycleOrphans.removed.length > 0) {
          await runLogger.appendOrchestrator(
            `swept ${cycleOrphans.removed.length} orphan(s) between cycles: ${cycleOrphans.removed.join(", ")}`,
          );
        }
        await reportSweepFailures(cycleOrphans, (line) =>
          runLogger.appendOrchestrator(line),
        );
      }

      const budget = remainingBudget(runState);
      if (budget === 0) {
        // The same `budgetExit` applyCycle returns, rather than the second
        // hand-written copy of its reason this used to print in different
        // words at the top of a cycle (#70).
        terminalExit = await announceExit(
          budgetExit(runState.issuesAttempted, runState.maxTotalIssues),
        );
        break;
      }

      console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);
      await runLogger.appendOrchestrator(`cycle ${iteration} start`);
      const cycleLogger = runLogger.cycle(iteration);

      // ---------------------------------------------------------------------
      // Phase 1: Plan
      // ---------------------------------------------------------------------
      const planOptions = {
        excluded: mergedThisRun,
        defaultLane: config.defaultLane,
      };
      let resolution = await buildPlan(repo, planOptions);

      // The chunk-review scan (#63). Every chunk with work on origin is asked
      // whether a human has requested changes on its pull request, and each
      // review that has not already been converted becomes an issue in that
      // chunk. Inert on the default lane and until a chunk's first landing:
      // `landedChunks` is empty, and the scan makes no call at all.
      //
      // RE-PLANNED when it files anything, because the follow-up is blocked
      // only by members already carrying `in-chunk` — it is eligible in this
      // very cycle, and a cycle that filed the issue and then found the plan
      // empty would exit with a review nobody had answered. The created issues
      // are handed back in rather than re-listed: `gh issue list` is the
      // lagging search backend, and nothing in the queue is younger than these.
      const followUps = await fileChunkReviewFollowUps({
        chunks: resolution.landedChunks,
        adapter: followUpAdapter,
        log: (line) => runLogger.appendOrchestrator(line),
      });
      if (followUps.length > 0) {
        const filed = followUps.map((f) => `#${f.number}`).join(", ");
        console.log(
          `Filed ${followUps.length} chunk review follow-up issue(s): ${filed} ` +
            "— a human requested changes on a chunk's pull request, and each " +
            "review is now an issue in that chunk.",
        );
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
      // it does — closing members, dropping `in-chunk` — changes the answer to
      // every question the plan asked, so the plan is REBUILT when it acted.
      //
      // Rebuilt rather than left stale for the next cycle: closing a member
      // unblocks its dependents, and a run whose plan came out empty exits
      // `success` right below. Without the re-plan a chunk somebody merged by
      // hand would reconcile, unblock three issues, and stop the run anyway.
      // The re-plan reads the same authoritative GraphQL batch, which is
      // strongly consistent about the closes just made even while the search
      // index that lists candidates lags.
      const reconciliation = await reconcileLandedChunks({
        repoDir: layout.repoDir,
        repo,
        sourceBranch: config.sourceBranch,
        chunks: resolution.landedChunks,
        log: (line) => runLogger.appendOrchestrator(line),
      });
      if (reconciliation.reconciled.length > 0) {
        for (const r of reconciliation.reconciled) {
          console.log(
            `  ⇥ reconciled ${r.target.branch} (already on ${config.sourceBranch}): ` +
              `closed ${r.closed.length} issue(s)${r.branchDeleted ? ", branch deleted" : ", branch kept"}`,
          );
        }
        // Same exclusion the merger's own closes get (#16): the `gh` search
        // backend the planner lists through lags a close by seconds, so an
        // issue closed one line ago can still come back as a candidate.
        for (const n of reconciliation.closedIssues) mergedThisRun.add(n);
        // Carrying `followUps` again: one filed a block above is younger than
        // anything the search backend can see, so a re-plan without it would
        // drop the issue this cycle just created. `planOptions.excluded` is
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
      // KEPT branch really is retried next cycle, while a retired chunk's
      // leftovers are reached through a branch that no longer exists, so
      // promising a retry for those is promising nothing.
      //
      // Neither halts. See `chunk-reconcile.ts`'s header: this pass IS the
      // retry the merge phase halts to defer to, and it runs again at the top
      // of the next cycle, so stopping the run in front of it would spend the
      // whole run on a repair that repairs itself.
      const reconcileResidue = chunkResidue(reconciliation.reconciled);
      // The twin of the merge phase's own report, one phase down and for the
      // same reason: a branch already on the source branch that no chunk
      // claims is deleted having closed nothing, and the only trace of it left
      // afterwards is this line. Ordinary when a human closed the members out
      // by hand; the one thing it can also be is a member whose `in-chunk` the
      // derivation lost, which is a repair nothing else will ever offer.
      if (reconcileResidue.unnamed.length > 0) {
        console.warn(
          CHUNK_LANDED_UNNAMED_BANNER({
            chunks: reconcileResidue.unnamed,
            sourceBranch: config.sourceBranch,
            provenance: "reconciled",
          }),
        );
        await runLogger.appendOrchestrator(
          `reconcile: retired with no named member: ${reconcileResidue.unnamed
            .map((c) => c.target.branch)
            .join(", ")}`,
        );
      }
      if (reconcileResidue.untidy.length > 0) {
        console.warn(
          CHUNK_RESIDUE_RETIRED_BANNER({
            chunks: reconcileResidue.untidy,
            sourceBranch: config.sourceBranch,
            provenance: "reconciled",
          }),
        );
        await runLogger.appendOrchestrator(
          `reconcile: retired chunk residue: ${reconcileResidue.untidy
            .flatMap((c) => c.residue)
            .join("; ")}`,
        );
      }
      if (reconcileResidue.kept.length > 0) {
        console.error(
          CHUNK_RESIDUE_KEPT_BANNER({
            chunks: reconcileResidue.kept,
            sourceBranch: config.sourceBranch,
            provenance: "reconciled",
          }),
        );
        await runLogger.appendOrchestrator(
          `reconcile: wrap-up incomplete: ${reconcileResidue.kept
            .flatMap((c) => c.residue)
            .join("; ")}`,
        );
      }

      // What a human has asked to land, read AFTER the reconciliation so a
      // chunk it just finished off is not also merged again by the merge phase
      // (its branch is gone by then, which the merger would park on, but
      // asking in this order means it never gets there).
      const landRequests = selectLandRequests(
        await fetchLandRequestPullRequests(repo, LAND_LABEL),
        resolution.landedChunks,
      );
      if (landRequests.length > 0) {
        const named = landRequests
          .map((r) => `${r.branch} (PR #${r.pullRequest})`)
          .join(", ");
        console.log(
          `Chunks labelled \`${LAND_LABEL}\` to land on ${config.sourceBranch}: ${named}`,
        );
        await runLogger.appendOrchestrator(`plan: land requested — ${named}`);
      }

      // `PlannedIssue`, not a structural subset of it: a planned review-gated
      // issue carries the CHUNK it lands on (#60), and a narrower annotation
      // here would drop that field on the way to phase 3 without an error —
      // the merger would then land a chunk member on the source branch.
      const issues: PlannedIssue[] = [...resolution.plan].slice(0, budget);
      const fingerprint = planFingerprint(issues.map((i) => i.id));
      await cycleLogger.writePlan(issues);
      await runLogger.appendOrchestrator(
        `plan: ${issues.length} unblocked issue(s) — ${issues.map((i) => `#${i.id}`).join(", ") || "none"}`,
      );

      // Both of these run BEFORE the plan-empty exit below (#57): a queue whose
      // every ready issue is review-gated resolves to an empty plan, and that
      // is precisely the cycle where "no unblocked issues" on its own would be
      // read as "nothing left to do".
      if (resolution.heldForReview.length > 0) {
        const held = resolution.heldForReview.map((n) => `#${n}`).join(", ");
        console.log(
          `Held for review (${resolution.heldForReview.length}): ${held} — each ` +
            "is review-gated and belongs to no chunk, so there is nothing for " +
            "it to land on: its blockers sit in two different chunks at once, " +
            "it is downstream of an issue in that state, or it is inside a " +
            "`## Blocked by` cycle. None of these is waiting for a cycle of " +
            "sandbar's — they clear when the blocking chunks land, or when a " +
            "human edits the bodies.",
        );
        await runLogger.appendOrchestrator(
          `plan: held ${resolution.heldForReview.length} review-gated issue(s) — ${held}`,
        );
      }
      await postLaneOverrideNotices(repo, resolution.overrides, (line) =>
        runLogger.appendOrchestrator(line),
      );

      // A cycle with a `land` request has work even with an empty plan (#64):
      // the merge phase lands the reviewed chunk, closes its members and
      // unblocks whatever was waiting on them. Exiting `success` here would
      // strand a chunk a human explicitly asked for, on the one cycle where
      // there is nothing else to distract from it.
      if (issues.length === 0 && landRequests.length === 0) {
        // No line of its own: the `Exit (plan-empty): …` at the bottom says
        // exactly this and is the line every other terminal prints too (#70).
        terminalExit = await announceExit(planEmptyExit());
        break;
      }

      if (issues.length === 0) {
        console.log(
          `No unblocked issues to work on, but ${landRequests.length} chunk(s) are ` +
            `labelled \`${LAND_LABEL}\`. Running the merge phase for those alone.`,
        );
      }

      console.log(
        `Planning complete. ${issues.length} issue(s) to work in parallel:`,
      );
      // Number and title only. The branch name is up to ~120 characters and
      // was printed three times per issue per cycle — here, at the terminal
      // line below, and again in the DONE list — which in a 3-issue cycle is a
      // third of the content (#70). The terminal line below is the one that
      // keeps it: stdout should say a parked issue's branch once, and that is
      // the line where the branch is attached to an OUTCOME rather than to a
      // plan. Nothing else the run prints says it — the finalise line and
      // orchestrator.log both name the issue — and the parking comment does,
      // since this same issue put it there, but that is on the tracker and a
      // human reading the run's own output should not have to go and find it.
      for (const issue of issues) {
        console.log(`  #${issue.id}: ${issue.title}`);
      }

      // ---------------------------------------------------------------------
      // Phase 2: Execute (inner-loop ralph)
      // ---------------------------------------------------------------------

      const settled = await Promise.allSettled(
        issues.map(async (issue) => ({
          issue,
          terminal: await runInnerLoop(issue, {
            config: innerLoopCfg,
            hooks: config.sandboxHooks,
            copyToWorktree: config.copyToWorktree,
            branchImages,
            // Sandbox-sibling logs land beside this cycle's attempt
            // transcripts (#44 D4), so the offline artefact of what the
            // agent's stack was doing sits next to the transcript of what the
            // agent did.
            sandboxLogBaseDir: cycleLogger.cycleDir,
            attemptLogger: cycleLogger,
            onOrchestratorLog: (line) => runLogger.appendOrchestrator(line),
          }),
        })),
      );

      type IssueOutcome = { issue: typeof issues[number]; terminal: Terminal };
      const outcomes: IssueOutcome[] = [];
      for (const [i, s] of settled.entries()) {
        if (s.status === "fulfilled") {
          outcomes.push(s.value);
          const issue = s.value.issue;
          const t = s.value.terminal;
          // The one place stdout prints the branch name (#70): a parked
          // issue's branch is what a human needs to stand on, and it appears
          // nowhere else in the run's output — not in the finalise line, not in
          // orchestrator.log. The parking comment names it too, from this same
          // issue, but that is on the tracker rather than here.
          console.log(`  #${issue.id} (${issue.branch}): ${t.type}`);
          await runLogger.appendOrchestrator(
            `terminal #${issue.id} ${t.type}`,
          );
        } else {
          console.error(
            `  ✗ #${issues[i]!.id} (${issues[i]!.branch}) failed: ${s.reason}`,
          );
          await runLogger.appendOrchestrator(
            `terminal #${issues[i]!.id} REJECTED: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
          );
        }
      }

      const completedIssues = outcomes
        .filter((o) => o.terminal.type === "DONE")
        .map((o) => o.issue);

      console.log(
        `\nExecution complete. ${completedIssues.length} issue(s) DONE:`,
      );
      for (const issue of completedIssues) {
        console.log(`  #${issue.id}: ${issue.title}`);
      }

      // ---------------------------------------------------------------------
      // Phase 4a: Finalise the agent terminals — BEFORE the merge (#30)
      //
      // Nothing here depends on the merge having happened: these are the
      // issues the merger will never see. Running them after it meant any
      // throw the merge phase produced that was not a MergerError — since #24,
      // a ContainerBringupError from the merger stack is the live example —
      // escaped to the top-level handler and exited before a single one was
      // written. The cost was the whole cycle's Phase-2 output for a failure
      // that happened after all of it: NEEDS-INFO questions never posted,
      // NEEDS-HUMAN traces never posted and never parked (so the issue kept
      // `ready-for-agent` and burned another full attempt budget next run),
      // reviewer prose never posted, branches never pushed.
      //
      // The mirror-image risk is real but strictly smaller: a required
      // side-effect failing here now stops the cycle before the merge, and a
      // DONE branch that misses its merge is not merely re-planned — it keeps
      // its commits and its `ready-for-agent` label, so preflight classifies it
      // `resumable` (#13) and the next run continues from where it got to.
      // That resume is not automatic if this pass parked anything first: an
      // `agent-stuck` issue is an open issue no longer queued, so its leftover
      // local branch is preflight-`unmerged` and refuses the next run until the
      // operator clears it. That is the steady state EVERY successful parking
      // cycle already produces, and the branch is on origin by then, so it
      // costs a `git branch -D` — not the commits. The prose an agent produced
      // once and nobody stored has no such fallback.
      // ---------------------------------------------------------------------
      await runFinalize("agent terminals", terminalFinalizeInputs(outcomes));

      // ---------------------------------------------------------------------
      // Phase 3: Merge (procedural, in an isolated worktree off origin)
      // ---------------------------------------------------------------------
      let mergerSummary: MergerSummary | null = null;
      // Tracker state the merger had already applied when it threw (see
      // MergerError.partial). Finalised even though the run is stopping.
      let haltPartial: MergerSummary | undefined;
      let halt = false;
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
        // The merger runs in a dedicated worktree detached at
        // origin/<sourceBranch>, NOT a checkout anyone stands in — so the
        // operator's uncommitted edits can never be swept into a merge commit
        // (issue #10; since #38 the worktree hangs off the bare cache, which
        // makes the same guarantee structural rather than procedural).
        // Worktree BEFORE stack: the stack's mounts bind-mount fixture files
        // from it (#20). createMergerWorktree and
        // startStack each register their own teardown as a disposable (#55); we
        // also tear both down in the finally below. One stack serves gate-2 for
        // every branch in the cycle — its issue-lifecycle containers start once.
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
            // gate-2 needs this as much as gate-1 does (#37): the merge result
            // is a tree neither branch had, and two branches that each touched
            // the lockfile compose into a third lockfile. Resolved per gate
            // run, so each merge in the cycle is gated against its own.
            images: (only) => branchImages.resolve(mergerWorktreePath, only),
          });
          const stackForGate2 = mergerStack;
          const adapter = realAdapter({
            cwd: mergerWorktree.path,
            scope,
            repo,
            sourceBranch: config.sourceBranch,
            botName: config.botName,
            botEmail: config.botEmail,
            coauthorTrailer: config.coauthorTrailer,
            agentProvider: buildAgentProvider(config.mergerAgent, config.mergerModelId),
            agentProviderName: config.mergerAgent,
            sandboxImage: config.sandboxImage,
            env,
            runStackGate: () => stackForGate2.runGate(),
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
                  }),
                  options: verifiedLandingOptionsFrom(
                    config.mergeMode,
                    config.sourceBranch,
                  ),
                }
              : undefined;

          mergerSummary = await runMergerWithAdapter(
            completedIssues,
            adapter,
            (line) => cycleLogger.appendMerger(line),
            (issueId, gate) => cycleLogger.writeMergerGate(issueId, gate),
            {
              cycleIssues: issues,
              projectAnchor,
              // #67: every resolve attempt's stdout and stderr, beside the
              // gate artefact it was prompted from. The writer answers with
              // the path, which is what the abandon comment points at.
              onResolveAttempt: (key, record) =>
                cycleLogger.writeResolveAttempt(key, record),
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
          console.log(
            `\nMerger: ${mergerSummary.merged.length} merged, ` +
              `${mergerSummary.chunkLanded.length} landed on a chunk branch, ` +
              `${mergerSummary.skipped.length} skipped, pushed=${mergerSummary.pushed}.`,
          );
          for (const m of mergerSummary.merged) {
            console.log(`  ✓ #${issueNumberOf(m)} ${m.title}`);
          }
          for (const c of mergerSummary.chunkLanded) {
            console.log(
              `  ⧉ #${issueNumberOf(c.issue)} ${c.issue.title} → ${c.chunkBranch}`,
            );
          }
          for (const s of mergerSummary.skipped) {
            console.log(
              `  ⊘ #${issueNumberOf(s.issue)} ${s.issue.title} (${s.reason})`,
            );
          }
          // #64. A chunk that landed reads differently from an issue that did:
          // one line names a branch and the issues it took with it.
          for (const c of mergerSummary.mergedChunks) {
            console.log(
              `  ⇥ ${c.target.branch} → ${config.sourceBranch}, closing ` +
                `${c.closed.map((n) => `#${n}`).join(", ") || "no issue"}`,
            );
          }
          // Parked chunks are NOT printed here — see Phase 4b, which prints
          // them off `mergerOutcome` so the halt path reports them too.
          await runLogger.appendOrchestrator(
            `merger: merged=${mergerSummary.merged.length} ` +
              `chunk-landed=${mergerSummary.chunkLanded.length} ` +
              `chunks-landed-on-source=${mergerSummary.mergedChunks.length} ` +
              `chunks-parked=${mergerSummary.skippedChunks.length} ` +
              `chunks-deferred=${mergerSummary.deferredChunks.length} ` +
              `skipped=${mergerSummary.skipped.length} pushed=${mergerSummary.pushed}`,
          );
        } catch (err) {
          if (err instanceof MergerError) {
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
            console.error(`Merger halted: ${err.message}${trace}`);
            halt = true;
            haltReasons.push("merger-halted");
            // `announceExit` overwrites this at the break below, so what this
            // assignment covers is only the window in between — and that window
            // is the post-merge finalise pass, which makes `gh` writes and can
            // take a while. A signal arriving in it should not leave
            // `run-end (normal-exit)` on a run whose merger has already thrown.
            cleanupReason = "merger-halted";
            await runLogger.appendOrchestrator(
              `merger halted: ${err.message}${trace}`,
            );
            // The halt stops the OUTER loop; it must not strand issues the
            // merger already commented on and stripped `ready-for-agent` from.
            // Those need their handoff label applied before we stop, or they
            // sit on no queue at all — invisible to the planner and to a human
            // filtering on `agent-stuck`. Nothing here lands code ON THE SOURCE
            // BRANCH: `merged` is always empty on this path. `chunkLanded`
            // (#60) may not be, and that is not a contradiction — those commits
            // are on origin's chunk branch and the issues owe their `in-chunk`
            // label whether the cycle went on to halt or not.
            haltPartial = err.partial;
            if (haltPartial && haltPartial.merged.length > 0) {
              throw new Error(
                "MergerError.partial must never report merged issues: a halt " +
                  "means nothing landed.",
              );
            }
          } else {
            throw err;
          }
        } finally {
          // Stack first: its containers bind-mount the worktree.
          if (mergerStack) await mergerStack.stop();
          if (mergerWorktree) await mergerWorktree.remove();
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
          runState.silentNoopAttemptsByIssue,
        );
        for (const [issueId, attempts] of bumpedSilentNoop) {
          runState.silentNoopAttemptsByIssue.set(issueId, attempts);
        }
        // Merged-and-closed only. A chunk landing (#60) is deliberately NOT
        // added: `excluded` means "this run already merged it to the source
        // branch", and what de-queues a chunk member is its `in-chunk` label,
        // which the planner reads from the strongly-consistent facts batch and
        // from `fetchChunkMembers` — so the lag this set exists to paper over
        // cannot reach it.
        for (const m of mergerOutcome.merged) {
          mergedThisRun.add(issueNumberOf(m));
        }
        // A chunk landing on the SOURCE branch (#64) is a different matter: its
        // members really were closed and their work really is on the source
        // branch, so they belong here for exactly the reason `merged` does —
        // the search backend the planner lists through lags a close by seconds,
        // and a re-picked closed issue is #16 verbatim. `mergedChunks` is empty
        // on the halt path by construction, since the wrap-up only ever runs
        // after the source branch has moved.
        for (const c of mergerOutcome.mergedChunks) {
          for (const n of c.closed) mergedThisRun.add(n);
        }
        // A parked chunk (#64) is reported from HERE rather than beside the
        // merge summary above, and that is the whole difference `mergerOutcome`
        // makes: parking writes to the pull request — a comment, and a human's
        // `land` label taken off it — so it rides `MergerError.partial` exactly
        // as `skipped` does, and a halt one issue later must not be the reason
        // a reviewer never learns their label is gone. BOTH LINES NAME THE
        // DECISION AND NEITHER NAMES THE WRITES, for the reason that ordering
        // creates: `parkChunk` records before it makes them, so on the halt
        // path this may be the very entry whose own `gh` call threw, and it
        // skips both writes outright for a chunk with no pull request to make
        // them against. A log line claiming "`land` removed" would therefore be
        // false exactly when an operator is reading the log to find out what
        // happened — a `land` still on the PR read back six weeks later as a
        // human having re-applied it, which is the class of untrustworthy
        // record #70 exists to end. What the writes did is the pull request's
        // to say, and `chunk-land.ts`'s `emit` records the same decision from
        // the other side.
        for (const c of mergerOutcome.skippedChunks) {
          console.log(`  ⊘ ${c.target.branch} not landed (${c.reason})`);
          await runLogger.appendOrchestrator(
            `chunk parked: ${c.target.branch} not landed (${c.reason})`,
          );
        }
        // Deferred, not parked (#61 + #64): the chunk grew this cycle, so the
        // label is still on and the next cycle lands it. Printed from here for
        // the same reason — the pull request has been commented on already.
        for (const c of mergerOutcome.deferredChunks) {
          console.log(
            `  ⏸ ${c.target.branch} not landed — it grew this cycle ` +
              `(${c.landedNow.map((m) => `#${m.number}`).join(", ")}); ` +
              `\`${LAND_LABEL}\` kept for the next one`,
          );
          await runLogger.appendOrchestrator(
            `chunk deferred: ${c.target.branch} grew this cycle ` +
              `(${c.landedNow.map((m) => `#${m.number}`).join(", ")}); ` +
              `\`${LAND_LABEL}\` kept`,
          );
        }
        await runFinalize("merge outcomes", inputs);
      }

      // Reports about DURABLE work with tracker state left wrong, all printed
      // before any of them stops the run. None may gate on another having
      // stayed quiet: they share a cause — a `gh` that is having a bad minute —
      // so a cycle that hits one hits the others more often than a cycle picked
      // at random does, and the report that lost would be the operator's only
      // notice that some issue is closed-in-name-only. Both also reach the
      // `Exit (halted): …` line, which names every cause rather than the first.

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
      // line behind: an `in-chunk` label that would not come off a CLOSED issue
      // (the wrap-up calls that harmless itself, and the planner lists open
      // issues only), or a pull request that would not close. Neither leaves an
      // issue on no queue, and halting on one would abandon the rest of the
      // run's budget over a label — while promising a next-run repair that
      // cannot happen, since the branch those lines came with is gone.
      const landedChunks = mergerSummary?.mergedChunks ?? [];
      const landedResidue = chunkResidue(landedChunks);

      // A chunk that landed while naming no member to close. Sandbar honours
      // such a request on purpose — a human labelled a branch that origin has,
      // and refusing would leave them holding a label nothing reads — and the
      // usual reason for it is benign: every member was closed by hand already.
      // But the wrap-up cannot tell that from a member whose `in-chunk` label
      // the derivation never saw, and it deletes the branch either way (see
      // `chunk-land.ts`), so nothing will ever look at this chunk again. That
      // is a warning rather than a halt: the commits are on the source branch
      // and the only repair left is one a human makes on the tracker.
      if (landedResidue.unnamed.length > 0) {
        console.warn(
          CHUNK_LANDED_UNNAMED_BANNER({
            chunks: landedResidue.unnamed,
            sourceBranch: config.sourceBranch,
            provenance: "sandbar",
          }),
        );
        await runLogger.appendOrchestrator(
          `merger: landed with no named member: ${landedResidue.unnamed
            .map((c) => c.target.branch)
            .join(", ")}`,
        );
      }
      if (landedResidue.untidy.length > 0) {
        console.warn(
          CHUNK_RESIDUE_RETIRED_BANNER({
            chunks: landedResidue.untidy,
            sourceBranch: config.sourceBranch,
            provenance: "sandbar",
          }),
        );
        await runLogger.appendOrchestrator(
          `merger: retired chunk residue: ${landedResidue.untidy
            .flatMap((c) => c.residue)
            .join("; ")}`,
        );
      }
      if (landedResidue.kept.length > 0) {
        console.error(
          CHUNK_RESIDUE_KEPT_BANNER({
            chunks: landedResidue.kept,
            sourceBranch: config.sourceBranch,
            provenance: "sandbar",
          }),
        );
        await runLogger.appendOrchestrator(
          `merger: chunk wrap-up incomplete: ${landedResidue.kept
            .flatMap((c) => c.residue)
            .join("; ")}`,
        );
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
        console.error(
          `\nMerger pushed all merges but could not close ` +
            `${mergerSummary.unclosed.length} issue(s) after retries: ${list}.\n` +
            "Their merges are durable on origin and `ready-for-agent` was removed " +
            "during finalise, so the planner will NOT re-pick them — but they " +
            "remain OPEN. Close them manually to reconcile the tracker.",
        );
        await runLogger.appendOrchestrator(
          `merger: unclosed after retries: ${list}`,
        );
        haltReasons.push("merger-close-failed");
      }

      if (haltReasons.length > 0) halt = true;

      if (halt) {
        // Both causes when both fired: naming only the first would hide the
        // other from exactly the archaeology this line exists for. A merger
        // that threw is in the list too, and is alone in it — neither report
        // can reach that path, since a throw leaves no `mergerSummary` to read.
        //
        // `announceExit` overwrites `cleanupReason` with the TAG, and that is
        // the point: `run-end (halted)` is uniform with every other terminal,
        // and the causes it used to carry are on the `exit:` line above it and
        // in the report that produced each of them.
        terminalExit = await announceExit(haltedExit(haltReasons));
        break;
      }

      const decision = applyCycle(runState, {
        planFingerprint: fingerprint,
        planSize: issues.length,
        doneCount: completedIssues.length,
        // The relaunch trigger (#65). Deliberately `mergerSummary`, never
        // `haltPartial` — a halt broke out above, and a halt means nothing
        // landed. A landed-but-unclosed cycle also broke out above (exit 1):
        // relaunching past an operator-actionable tracker mess would bury it.
        // A chunk landing counts (#64): it moves the source branch exactly as
        // a merged issue does, so the inputs this process resolved at launch
        // are just as stale afterwards — which is the whole of what #65
        // relaunches for. Which inputs those still are is
        // `exit-conditions.ts`'s to say, and since #66 the driver is not
        // among them.
        landedMerges:
          mergerSummary && mergerSummary.pushed
            ? mergerSummary.merged.length + mergerSummary.mergedChunks.length
            : 0,
      });
      if (decision.kind === "exit") {
        terminalExit = await announceExit(decision);
        break;
      }
    }

  } catch (err) {
    // A sandbar-internal failure escaped a cycle (a required git/gh side-effect
    // that could not be completed, or an unexpected bug). FAIL LOUD: this is
    // the LAST thing printed — no success banner after it to push it up the
    // scrollback — then run cleanup and exit non-zero. SandbarError is an
    // expected, operator-actionable fault so we print its message alone; any
    // other error is an unexpected bug, so we include the stack — which is
    // `faultDetail`'s rule, shared with the bin and with `runGateCommand`
    // rather than restated here (#45).
    const banner = "═".repeat(72);
    const detail = faultDetail(err);
    console.error(`\n${banner}\nSANDBAR HALTED — internal failure\n${banner}\n${detail}\n${banner}`);
    await runLogger.appendOrchestrator(`HALTED — internal failure: ${detail}`);
    // The stderr box keeps its place as the last thing on THAT stream, and the
    // stdout line follows it (#70). That does not contradict the "last thing
    // printed" argument above, it restates it: the box is the detail, the line
    // is the answer to "did this stop normally?", and a reader who has only one
    // of the two streams still gets an answer.
    const exit = await announceExit(haltedExit(["sandbar-internal-error"]));
    await runCleanup();
    process.exit(exit.exitCode);
  }

  // EVERY terminal path arrives here having announced itself exactly once
  // (#70) — plan-empty and halted included, which between them used to print a
  // success banner and nothing at all. The `??` is the DEFENSIVE CEILING and
  // nothing else: falling out of the loop without a `break` means
  // MAX_ITERATIONS cycles and not one exit condition, which nothing has ever
  // reached. Its exit code is unchanged (success); what changed is that it used
  // to print "All done.", the one thing a run that ran out of iterations did
  // not do.
  const finalExit =
    terminalExit ?? (await announceExit(iterationCeilingExit(MAX_ITERATIONS)));

  await runCleanup();
  if (finalExit.exitCode !== 0) process.exit(finalExit.exitCode);
}
