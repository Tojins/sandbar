// Sandbar orchestrator — four-phase loop.
//
//   Phase 1 (Plan):            Deterministic resolver picks the unblocked
//                              `ready-for-agent` issues by parsing each body's
//                              `## Blocked by` section.
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
// → stuck, issuesAttempted hits maxTotalIssues → budget. MAX_ITERATIONS is a
// defensive ceiling — the conditions above terminate first.

import { realpathSync } from "node:fs";
import { join } from "node:path";

import { type ResolvedConfig, type RunConfig, resolveConfig } from "./config.js";
import {
  type SweepResult,
  cleanupOrphanContainers,
  findUnattributableResources,
} from "./containers.js";
import { installCleanupTraps, onCleanup, runCleanup } from "./cleanup.js";
import { checkWorktreeImageUids, ensureImages } from "./ensure-images.js";
import { makeEnvReader } from "./env.js";
import { SandbarError } from "./errors.js";
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
import { buildPlan } from "./plan-resolver.js";
import { PreflightError, runPreflight } from "./preflight.js";
import { buildProjectAnchor } from "./prompt.js";

// Defensive ceiling on cycles. The real terminators are in exit-conditions.ts
// (success / stuck / budget) — MAX_ITERATIONS just guarantees the loop is
// bounded if those checks ever fail to fire.
const MAX_ITERATIONS = 100;

// The merge phase's stack id. Distinct from every issue id (which are numeric),
// so its pod, network and containers can never collide with an issue's.
const MERGER_STACK_ID = "merger";

// Images the gate stack references that sandbar does NOT build. Preflight
// refuses when one is missing rather than pulling it (#24 D7) — a run must not
// do silent network work at startup, and a `podman pull` behind the lock turns
// a config error into a slow one.
function pulledImagesOf(config: ResolvedConfig): readonly string[] {
  const built = new Set(config.images.map((i) => i.tag));
  const referenced = new Set(config.gateStack.containers.map((c) => c.image));
  return [...referenced].filter((i) => !built.has(i));
}

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
  const env = makeEnvReader(config.envFilePath);

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
        `See the .env.example for the required token type and scopes,\n` +
        `then set GH_TOKEN in ${config.envFilePath}.`,
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
  const lockPaths = lockPathsFor(join(config.cwd, config.workDir));
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
  try {
    await runPreflight({
      cwd: config.cwd,
      workDir: config.workDir,
      envFilePath: config.envFilePath,
      sourceBranch: config.sourceBranch,
      pulledImages: pulledImagesOf(config),
    });
  } catch (err) {
    if (err instanceof PreflightError) {
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
  // the path it locks (`realpath: true` is its default). Hash the raw string
  // and the agreement is a coincidence of how the host spelled `config.cwd`,
  // which `resolveConfig` passes through untouched:
  //   - Two repos both configured `cwd: "."` hash the same `.sandbar` and share
  //     one scope while correctly holding two locks — #28, verbatim, with this
  //     module's own comments asserting it cannot happen.
  //   - One workdir reached through a symlink is one lock but two scopes, so a
  //     crashed run's debris lands in a scope no later run computes and no
  //     report names (it IS scoped, just not ours) — invisible and unreapable.
  // acquireLock has already mkdirSync'd the directory, so this cannot ENOENT.
  const scope = runScope(realpathSync(lockPaths.workDir));

  const orphans = await cleanupOrphanContainers(scope);
  if (orphans.removed.length > 0) {
    console.log(
      `Removed ${orphans.removed.length} orphaned sandbar resource(s) from prior runs.`,
    );
  }
  reportSweepFailures(orphans);

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
  await ensureImages(config.images);

  // After the builds, because the images have to exist to be probed and a
  // freshly-built one is the likeliest to be wrong. Before any stack starts,
  // because the alternative is an unexplained EACCES twenty minutes into a gate
  // (#24 D3).
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
    baseDir: join(config.cwd, config.workDir, "logs"),
  });
  console.log(`Run log tree: ${runLogger.runDir}`);
  let cleanupReason = "normal-exit";
  onCleanup(() => runLogger.finalize(cleanupReason));

  const runState = newRunState({ maxTotalIssues: config.maxTotalIssues });
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
      cwd: config.cwd,
      workDir: config.workDir,
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

  const repo = { owner: config.ghOwner, name: config.ghRepo };

  const innerLoopCfg = {
    sourceBranch: config.sourceBranch,
    workDir: config.workDir,
    envFilePath: config.envFilePath,
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
      const issues: { id: string; title: string; branch: string }[] = [
        ...(await buildPlan(repo, mergedThisRun)),
      ].slice(0, budget);
      const fingerprint = planFingerprint(issues.map((i) => i.id));
      await cycleLogger.writePlan(issues);
      await runLogger.appendOrchestrator(
        `plan: ${issues.length} unblocked issue(s) — ${issues.map((i) => `#${i.id}`).join(", ") || "none"}`,
      );
  
      if (issues.length === 0) {
        console.log("No unblocked issues to work on. Exiting.");
        await runLogger.appendOrchestrator(`exit: success — plan empty`);
        cleanupReason = "success";
        break;
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
      if (completedIssues.length > 0) {
        // The merger runs in a dedicated worktree detached at
        // origin/<sourceBranch>, NOT config.cwd — so the operator's uncommitted
        // edits in their primary checkout can never be swept into a merge
        // commit (issue #10). Worktree BEFORE stack: the stack's mounts
        // bind-mount fixture files from it (#20). createMergerWorktree and
        // startStack each register their own teardown with onCleanup; we
        // also tear both down in the finally below. One stack serves gate-2 for
        // every branch in the cycle — its issue-lifecycle containers start once.
        let mergerWorktree: MergerWorktree | null = null;
        let mergerStack: Stack | null = null;
        try {
          mergerWorktree = await createMergerWorktree({
            cwd: config.cwd,
            workDir: config.workDir,
            sourceBranch: config.sourceBranch,
          });
          mergerStack = await startStack({
            stackId: MERGER_STACK_ID,
            scope,
            spec: config.gateStack,
            worktreePath: mergerWorktree.path,
          });
          const stackForGate2 = mergerStack;
          const adapter = realAdapter({
            cwd: mergerWorktree.path,
            sourceBranch: config.sourceBranch,
            botName: config.botName,
            botEmail: config.botEmail,
            coauthorTrailer: config.coauthorTrailer,
            modelId: config.mergerModelId,
            sandboxImage: config.sandboxImage,
            env,
            runStackGate: () => stackForGate2.runGate(),
          });

          const projectAnchor = await buildProjectAnchor({
            claudeMdPath: config.claudeMdPath,
            contextMdPath: config.contextMdPath,
            adrDir: config.adrDir,
            sourceBranch: config.sourceBranch,
          });
          // Verified merge mode (#22): the forge gates the landing. Wired here
          // rather than inside the merger so the merger stays adapter-driven —
          // its type demands the verify adapter exactly when the mode is on.
          const verified =
            config.mergeMode.kind === "verified"
              ? {
                  adapter: realVerifyAdapter({
                    cwd: mergerWorktree.path,
                    sourceBranch: config.sourceBranch,
                    repo: { owner: config.ghOwner, name: config.ghRepo },
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
            },
          );
          console.log(
            `\nMerger: ${mergerSummary.merged.length} merged, ${mergerSummary.skipped.length} skipped, pushed=${mergerSummary.pushed}.`,
          );
          for (const m of mergerSummary.merged) {
            console.log(`  ✓ #${issueNumberOf(m)} ${m.title}`);
          }
          for (const s of mergerSummary.skipped) {
            console.log(
              `  ⊘ #${issueNumberOf(s.issue)} ${s.issue.title} (${s.reason})`,
            );
          }
          await runLogger.appendOrchestrator(
            `merger: merged=${mergerSummary.merged.length} skipped=${mergerSummary.skipped.length} pushed=${mergerSummary.pushed}`,
          );
        } catch (err) {
          if (err instanceof MergerError) {
            console.error(`Merger halted: ${err.message}`);
            halt = true;
            cleanupReason = "merger-halted";
            await runLogger.appendOrchestrator(`merger halted: ${err.message}`);
            // The halt stops the OUTER loop; it must not strand issues the
            // merger already commented on and stripped `ready-for-agent` from.
            // Those need their handoff label applied before we stop, or they
            // sit on no queue at all — invisible to the planner and to a human
            // filtering on `agent-stuck`. Nothing here lands code: `merged` is
            // always empty on this path.
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
        for (const m of mergerOutcome.merged) {
          mergedThisRun.add(issueNumberOf(m));
        }
        await runFinalize("merge outcomes", inputs);
      }
  
      // Post-push close failures (issue #14): the merges are durable on origin
      // and Phase 4b above already dropped `ready-for-agent` for every merged
      // issue, so the planner won't re-pick them — but they're still OPEN on the
      // tracker. Surface them as an operator-actionable list and halt loud,
      // AFTER finalise so the merged work is fully reconciled locally.
      if (mergerSummary && mergerSummary.unclosed.length > 0 && !halt) {
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
        halt = true;
        cleanupReason = "merger-close-failed";
      }

      if (halt) {
        exitCode = 1;
        break;
      }
  
      const decision = applyCycle(runState, {
        planFingerprint: fingerprint,
        planSize: issues.length,
        doneCount: completedIssues.length,
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
    // other error is an unexpected bug, so we include the stack.
    const banner = "═".repeat(72);
    const detail =
      err instanceof SandbarError
        ? err.message
        : err instanceof Error
          ? (err.stack ?? err.message)
          : String(err);
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
