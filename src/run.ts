// Sandbar orchestrator — four-phase loop.
//
//   Phase 1 (Plan):            Deterministic resolver picks the unblocked
//                              `ready-for-agent` issues by parsing each body's
//                              `## Blocked by` section — and routes each by
//                              LANE (#57), holding back the review-gated ones
//                              that have nowhere to land yet (#60: everything
//                              but a chunk's root) and saying on the issue
//                              where an `auto-land` label lost to inherited
//                              gating. Then the RECONCILER (#64) finishes off
//                              any chunk branch already contained in
//                              origin/<sourceBranch> — hand-merged, or landed
//                              by a run that died before it could close the
//                              members — and the plan is rebuilt when it did,
//                              because closing a member unblocks its
//                              dependents and the plan-empty exit is one line
//                              below.
//   Phase 2 (Inner-loop ralph): Each issue runs in its own sandbox up to
//                              config.maxImplAttempts times; on gate-1 green
//                              the (strictly-advisory) reviewer runs in the
//                              same sandbox and consumes one of
//                              config.maxReviewRounds. APPROVED → DONE;
//                              CHANGES-REQUESTED loops back to a new impl
//                              attempt carrying the reviewer's prose.
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
// Outer-loop termination is governed by exit-conditions.ts: plan-empty →
// success, repeated-plan-with-zero-DONEs or two consecutive zero-DONE cycles
// → stuck, issuesAttempted hits maxTotalIssues → budget — and, with
// config.relaunchAfterLanding, any cycle that landed merges → exit
// EXIT_CODE_RELAUNCH so a looping launcher can pull, rebuild and relaunch
// (#65). MAX_ITERATIONS is a defensive ceiling — the conditions above
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
  EXIT_CODE_BUDGET,
  applyCycle,
  newRunState,
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
import { LAND_LABEL, selectLandRequests } from "./chunk-land.js";
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
function reportSweepFailures(result: SweepResult): void {
  if (result.failures.length === 0) return;
  console.warn(
    `Could not remove ${result.failures.length} orphaned sandbar resource(s). ` +
      "They will be retried next cycle; clear them by hand if they persist:\n" +
      result.failures.join("\n"),
  );
}

export async function run(rawConfig: RunConfig): Promise<void> {
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

  // Still ahead of the sweep and every container operation below, which is the
  // dependency that matters: those assume a working container runtime because
  // this is what hard-fails when there isn't one.
  //
  // `runCleanup` before the exit, because the lock is held by here and
  // `process.exit` runs no cleanup handler. What that actually recovers is the
  // `run.pid` SIDECAR, not the lock directory: proper-lockfile registers its
  // own exit handler and rmdirs every lock it holds even on a bare
  // `process.exit(1)`. So the leak this prevents is a small one — a sidecar
  // naming a pid that will be dead, which the next launch's takeover reads as a
  // crashed run and clears. Cheap, and it keeps every exit path in this file
  // uniform rather than one of them relying on a dependency's exit hook.

  // One `repo` for the whole run (#34). Every `gh` call sandbar makes — the
  // planner's queue, the issue anchor, the finalise writes, the merger's closes
  // and the forge-verify polls — names this rather than letting gh infer a
  // repository from whatever directory the command ran in. Preflight is where
  // it is checked against the cache's `origin`, which is the one repository
  // identity sandbar does NOT get from config.
  const repo = { owner: config.ghOwner, name: config.ghRepo };

  try {
    // The object cache, before anything reads a ref (#38). Created from
    // `config.cwd` when absent — a local clone, so hardlinked and offline —
    // and its `origin` retargeted to whatever URL that checkout carries. Under
    // the lock, because it writes into the state directory; before preflight,
    // because preflight fetches into it.
    //
    // Inside preflight's catch, and `SandbarError` alongside `PreflightError`,
    // because its failures are the same KIND of failure: `cwd` is not a repo,
    // it has no `origin`, the clone did not work. Every one is a startup
    // complaint an operator acts on, so it prints as its message alone and
    // exits — and, unlike letting it escape to the bin, it runs cleanup first,
    // which is what recovers the `run.pid` sidecar.
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
    });
  } catch (err) {
    if (err instanceof PreflightError || err instanceof SandbarError) {
      console.error(err.message);
      await runCleanup();
      process.exit(1);
    }
    throw err;
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

  const orphans = await cleanupOrphanContainers(scope);
  if (orphans.removed.length > 0) {
    console.log(
      `Removed ${orphans.removed.length} orphaned sandbar resource(s) from prior runs.`,
    );
  }
  reportSweepFailures(orphans);

  // The image half of the same sweep (#37). Per-branch gate images are removed
  // at the end of a run, but that removal is an `onCleanup` action and so does
  // not run on SIGKILL, a hard crash, or a `podman build` that outlived its
  // parent — and these are the largest things sandbar creates. Startup only:
  // within a run they are reused, and they carry this scope, so anything found
  // here belongs to a predecessor of this workdir that is provably not running.
  const staleImages = await sweepBranchImages(scope);
  if (staleImages.removed.length > 0) {
    console.log(
      `Removed ${staleImages.removed.length} per-branch gate image(s) left by a prior run.`,
    );
  }
  reportSweepFailures(staleImages);

  // Debris no run's scope claims: from a build predating #28, or the sandcastle
  // era. Reported rather than removed, because a bare-prefix match cannot tell
  // it from a concurrently-running old sandbar's LIVE resources — which is the
  // failure #28 exists to end. Nothing clears it but the operator, so this
  // repeats every startup until they run the commands.
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
  const sourceWorktree = await ensureSourceWorktree(layout, config.sourceBranch);
  const baseFingerprints = await ensureImages(config.images, sourceWorktree);

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
  await checkWorktreeImageUids(config.gateStack, process.getuid?.() ?? 0);

  startKeepawake();
  onCleanup(stopKeepawake);

  // -------------------------------------------------------------------------
  // Per-run log tree
  //
  // Created after lock acquisition so non-winners don't litter the logs/ tree.
  // Append writers are unbuffered, so the cleanup trap only needs to drop a
  // closing run-end marker — no in-memory state to flush.
  // -------------------------------------------------------------------------
  const runLogger = await startRunLogger({
    baseDir: layout.logsDir,
  });
  console.log(`Run log tree: ${runLogger.runDir}`);
  let cleanupReason = "normal-exit";
  onCleanup(() => runLogger.finalize(cleanupReason));

  const runState = newRunState({
    maxTotalIssues: config.maxTotalIssues,
    relaunchAfterLanding: config.relaunchAfterLanding,
  });
  let exitCode = 0;

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

  const innerLoopCfg = {
    layout,
    repo,
    sourceBranch: config.sourceBranch,
    env: config.env,
    implementerModelId: config.implementerModelId,
    reviewerModelId: config.reviewerModelId,
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
        reportSweepFailures(cycleOrphans);
      }
  
      const budget = remainingBudget(runState);
      if (budget === 0) {
        const reason = `issuesAttempted=${runState.issuesAttempted} >= maxTotalIssues=${runState.maxTotalIssues}`;
        console.log(`Budget exhausted: ${reason}`);
        await runLogger.appendOrchestrator(`exit: budget — ${reason}`);
        cleanupReason = "budget";
        exitCode = EXIT_CODE_BUDGET;
        break;
      }
  
      console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);
      await runLogger.appendOrchestrator(`cycle ${iteration} start`);
      const cycleLogger = runLogger.cycle(iteration);
  
      // ---------------------------------------------------------------------
      // Phase 1: Plan
      // ---------------------------------------------------------------------
      let resolution = await buildPlan(repo, {
        excluded: mergedThisRun,
        defaultLane: config.defaultLane,
      });

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
        chunks: resolution.chunks,
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
        resolution = await buildPlan(repo, {
          excluded: mergedThisRun,
          defaultLane: config.defaultLane,
        });
      }
      if (reconciliation.residue.length > 0) {
        console.error(
          `\nSandbar could not finish reconciling ${reconciliation.reconciled.length} ` +
            "landed chunk(s). Their branches were kept on origin, so the next run " +
            "retries exactly these writes — but the work is already on " +
            `\`${config.sourceBranch}\`, so the residue is tracker state a human may ` +
            "prefer to fix by hand:\n" +
            reconciliation.residue.map((r) => `  ${r}`).join("\n"),
        );
        await runLogger.appendOrchestrator(
          `reconcile residue: ${reconciliation.residue.join("; ")}`,
        );
      }

      // What a human has asked to land, read AFTER the reconciliation so a
      // chunk it just finished off is not also merged again by the merge phase
      // (its branch is gone by then, which the merger would park on, but
      // asking in this order means it never gets there).
      const landRequests = selectLandRequests(
        await fetchLandRequestPullRequests(repo, LAND_LABEL),
        resolution.chunks,
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
            "is not its chunk's root: a member chained behind another member, " +
            "or an issue whose blockers sit in two chunks at once. A chained " +
            "member is NOT waiting for a cycle — a chunk's root is the only " +
            "member sandbar can work until #61, so a chain stops there and a " +
            "human takes it from the chunk branch.",
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
        console.log("No unblocked issues to work on. Exiting.");
        await runLogger.appendOrchestrator(`exit: success — plan empty`);
        cleanupReason = "success";
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
      for (const issue of issues) {
        console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
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
          console.log(`  ${issue.id} (${issue.branch}): ${t.type}`);
          await runLogger.appendOrchestrator(
            `terminal #${issue.id} ${t.type}`,
          );
        } else {
          console.error(
            `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${s.reason}`,
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
        `\nExecution complete. ${completedIssues.length} branch(es) with DONE:`,
      );
      for (const issue of completedIssues) {
        console.log(`  ${issue.branch}`);
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
            repo,
            sourceBranch: config.sourceBranch,
            botName: config.botName,
            botEmail: config.botEmail,
            coauthorTrailer: config.coauthorTrailer,
            modelId: config.mergerModelId,
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
              `  ⇥ ${c.request.branch} → ${config.sourceBranch}, closing ` +
                `${c.closed.map((n) => `#${n}`).join(", ") || "no issue"}`,
            );
          }
          for (const c of mergerSummary.skippedChunks) {
            console.log(
              `  ⊘ ${c.request.branch} not landed (${c.reason}); \`${LAND_LABEL}\` removed`,
            );
          }
          await runLogger.appendOrchestrator(
            `merger: merged=${mergerSummary.merged.length} ` +
              `chunk-landed=${mergerSummary.chunkLanded.length} ` +
              `chunks-landed-on-source=${mergerSummary.mergedChunks.length} ` +
              `chunks-parked=${mergerSummary.skippedChunks.length} ` +
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
        await runFinalize("merge outcomes", inputs);
      }

      // Two reports about DURABLE work with tracker state left wrong, and both
      // are printed before either stops the run. Neither may gate on the other
      // having stayed quiet: they share a cause — a `gh` that is having a bad
      // minute — so a cycle that hits one hits the other more often than a
      // cycle picked at random does, and the report that lost would be the
      // operator's only notice that some issue is closed-in-name-only.
      const haltReasons: string[] = [];

      // #64 — a landed chunk whose wrap-up could not finish. Unlike a parked
      // chunk (already fully reported on its own pull request), the chunk is on
      // the source branch and some member is still open or some branch is still
      // there. The next run's reconciler retries it — the branch is kept
      // precisely so it can — but a run that carried on silently would keep
      // landing work past a repair nobody had been told about.
      const chunkResidue = (mergerSummary?.mergedChunks ?? []).flatMap(
        (c) => c.residue,
      );
      if (chunkResidue.length > 0) {
        console.error(
          `\nSandbar landed ${mergerSummary?.mergedChunks.length} chunk(s) on ` +
            `${config.sourceBranch} but could not finish reconciling them:\n` +
            chunkResidue.map((r) => `  ${r}`).join("\n") +
            "\nThe work is durable. The next run reconciles what is left; fix it " +
            "by hand if it is urgent.",
        );
        await runLogger.appendOrchestrator(
          `merger: chunk wrap-up residue: ${chunkResidue.join("; ")}`,
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

      if (haltReasons.length > 0) {
        // Both, when both fired: this label is the run log's one handle on why
        // the run stopped, and naming only the first would hide the other from
        // exactly the archaeology it exists for. Guarded on `halt` so a merger
        // that threw keeps `merger-halted` — a case neither report can reach
        // anyway, since a throw leaves no `mergerSummary` to read.
        if (!halt) cleanupReason = haltReasons.join("+");
        halt = true;
      }

      if (halt) {
        exitCode = 1;
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
        // a merged issue does, so the `dist/` driving this process is just as
        // stale afterwards — which is the whole of what #65 relaunches for.
        landedMerges:
          mergerSummary && mergerSummary.pushed
            ? mergerSummary.merged.length + mergerSummary.mergedChunks.length
            : 0,
      });
      if (decision.kind === "exit") {
        console.log(`Exit (${decision.tag}): ${decision.reason}`);
        await runLogger.appendOrchestrator(
          `exit: ${decision.tag} — ${decision.reason}`,
        );
        cleanupReason = decision.tag;
        exitCode = decision.exitCode;
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
    cleanupReason = "sandbar-internal-error";
    await runLogger.appendOrchestrator(`HALTED — internal failure: ${detail}`);
    await runCleanup();
    process.exit(1);
  }

  // Reached only on a normal terminal (plan-empty / stuck / budget). The
  // decision that ended the loop already printed its own "Exit (…)" line for
  // the non-zero cases, so a success banner is right only at exit 0.
  if (exitCode === 0) console.log("\nAll done.");

  await runCleanup();
  if (exitCode !== 0) process.exit(exitCode);
}
