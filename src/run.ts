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
//                              flip labels.
//
// A per-run log tree at <cwd>/<workDir>/logs/run-<UTC-ISO>/ captures decisions
// and agent output: orchestrator.log at the run root, plan.json + merger.log
// + issue-<id>/attempt-<m>.log per cycle.
//
// Outer-loop termination is governed by exit-conditions.ts: plan-empty →
// success, repeated-plan-with-zero-DONEs or two consecutive zero-DONE cycles
// → stuck, issuesAttempted hits maxTotalIssues → budget. MAX_ITERATIONS is a
// defensive ceiling — the conditions above terminate first.

import { join } from "node:path";

import { type RunConfig, resolveConfig } from "./config.js";
import { cleanupOrphanContainers } from "./containers.js";
import { installCleanupTraps, onCleanup, runCleanup } from "./cleanup.js";
import { ensureImages } from "./ensure-images.js";
import { makeEnvReader } from "./env.js";
import { SandbarError } from "./errors.js";
import {
  EXIT_CODE_BUDGET,
  SILENT_NOOP_RETRY_LIMIT,
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
  realVerifyAdapter,
  verifiedLandingOptionsFrom,
} from "./forge-verify.js";
import { startKeepawake, stopKeepawake } from "./keepawake.js";
import { runInnerLoop, type Terminal } from "./inner-loop.js";
import { LockHeldError, acquireLock, lockPathsFor } from "./lock.js";
import { startRunLogger } from "./logs.js";
import {
  MergerError,
  type MergerSummary,
  type SkipReason,
  issueNumberOf,
  realAdapter,
  runMergerWithAdapter,
} from "./merger.js";
import {
  type MergerWorktree,
  createMergerWorktree,
} from "./merger-worktree.js";
import { type Sidecar, startDbSidecar } from "./db-sidecar.js";
import { buildPlan } from "./plan-resolver.js";
import { PreflightError, runPreflight } from "./preflight.js";
import { buildProjectAnchor } from "./prompt.js";

// Defensive ceiling on cycles. The real terminators are in exit-conditions.ts
// (success / stuck / budget) — MAX_ITERATIONS just guarantees the loop is
// bounded if those checks ever fail to fire.
const MAX_ITERATIONS = 100;

/**
 * SkipReason → the Phase-4 handoff it earns.
 *
 * Exhaustive on purpose (the `never` assignment). A ternary chain with a
 * catch-all silently gave every future skip reason `merge-gate-red`, which
 * pushes the branch and applies `agent-stuck` — plausible for some reasons and
 * wrong for others, with nothing to catch the difference. `silent-noop` is
 * handled by the caller (it needs the per-issue retry count) and never reaches
 * here.
 */
function finalizeKindForSkip(
  reason: Exclude<SkipReason, "silent-noop">,
): "merge-conflict" | "forge-unverified" | "merge-gate-red" {
  switch (reason) {
    case "conflict":
      return "merge-conflict";
    case "forge-unverified":
      return "forge-unverified";
    case "gate-red":
    case "install-failed":
      return "merge-gate-red";
    default: {
      const never: never = reason;
      throw new Error(`Unhandled merger skip reason: ${String(never)}`);
    }
  }
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

  try {
    await runPreflight({
      cwd: config.cwd,
      workDir: config.workDir,
      envFilePath: config.envFilePath,
      sourceBranch: config.sourceBranch,
      dbImage: config.dbSidecar.image,
    });
  } catch (err) {
    if (err instanceof PreflightError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

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

  const orphans = await cleanupOrphanContainers();
  if (orphans.length > 0) {
    console.log(
      `Removed ${orphans.length} orphaned sandbar resource(s) from prior runs.`,
    );
  }

  // Build the sandbar image in the runtime if missing. No-op when it already
  // exists, so warm runs pay only one `image exists` call. After lock
  // acquisition so concurrent launches can't race the build.
  await ensureImages({
    gateImage: config.gateImage,
    containerfilePath: config.containerfilePath,
  });

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
    gateImage: config.gateImage,
    gateCommands: config.gateCommands,
    dbSidecar: config.dbSidecar,
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
      // resources in finally blocks, but a crash between sidecar create and the
      // cleanup-trap registration can leak a network or container that would
      // then collide with the next cycle's create. Cheap insurance.
      // -----------------------------------------------------------------------
      if (iteration > 1) {
        const cycleOrphans = await cleanupOrphanContainers();
        if (cycleOrphans.length > 0) {
          await runLogger.appendOrchestrator(
            `swept ${cycleOrphans.length} orphan(s) between cycles: ${cycleOrphans.join(", ")}`,
          );
        }
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
        // commit (issue #10). Worktree BEFORE sidecar: the sidecar's initMounts
        // bind-mount fixture files from it (#20). createMergerWorktree and
        // startDbSidecar each register their own teardown with onCleanup; we
        // also tear both down in the finally below.
        let mergerWorktree: MergerWorktree | null = null;
        let mergerSidecar: Sidecar | null = null;
        try {
          mergerWorktree = await createMergerWorktree({
            cwd: config.cwd,
            workDir: config.workDir,
            sourceBranch: config.sourceBranch,
          });
          mergerSidecar = await startDbSidecar({
            issueId: "merger",
            spec: config.dbSidecar,
            worktreePath: mergerWorktree.path,
          });
          const adapter = realAdapter({
            cwd: mergerWorktree.path,
            sourceBranch: config.sourceBranch,
            botName: config.botName,
            botEmail: config.botEmail,
            coauthorTrailer: config.coauthorTrailer,
            modelId: config.mergerModelId,
            gateImage: config.gateImage,
            gateCommands: config.gateCommands,
            env,
            gateOpts: {
              worktreePath: mergerWorktree.path,
              networkName: mergerSidecar.networkName,
              dbHost: mergerSidecar.dbHost,
              dbPort: mergerSidecar.dbPort,
              gateEnv: config.dbSidecar.gateEnv,
            },
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
          // Sidecar first: it bind-mounts fixture files from the worktree.
          if (mergerSidecar) await mergerSidecar.stop();
          if (mergerWorktree) await mergerWorktree.remove();
        }
      }
  
      // ---------------------------------------------------------------------
      // Phase 4: Finalise
      // ---------------------------------------------------------------------
      const finalizeInputs: FinalizeInput[] = [];
      // On a halt, `haltPartial` carries what the merger had already applied to
      // the tracker; its `merged` is empty by construction (asserted above), so
      // this only ever produces handoff inputs.
      const mergerOutcome = halt ? haltPartial : mergerSummary;
      if (mergerOutcome) {
        for (const m of mergerOutcome.merged) {
          mergedThisRun.add(issueNumberOf(m));
          finalizeInputs.push({ kind: "merged", issue: m });
        }
        for (const s of mergerOutcome.skipped) {
          if (s.reason === "silent-noop") {
            const prev = runState.silentNoopAttemptsByIssue.get(s.issue.id) ?? 0;
            const attempts = prev + 1;
            runState.silentNoopAttemptsByIssue.set(s.issue.id, attempts);
            if (attempts < SILENT_NOOP_RETRY_LIMIT) {
              finalizeInputs.push({ kind: "fresh-attempt", issue: s.issue });
            } else {
              finalizeInputs.push({
                kind: "silent-noop-exhausted",
                issue: s.issue,
                attempts,
              });
            }
            continue;
          }
          finalizeInputs.push({
            kind: finalizeKindForSkip(s.reason),
            issue: s.issue,
          });
        }
      }
      // Exhaustive over Terminal: a new terminal type that nobody maps here
      // would silently skip finalise — no comment, no label flip — and the
      // issue would keep `ready-for-agent` and be re-picked forever. The
      // `never` assignment makes that a compile error instead.
      for (const o of outcomes) {
        const t = o.terminal;
        switch (t.type) {
          case "DONE":
            // Handled by the merger above (merged / skipped).
            break;
          case "NEEDS-INFO":
            finalizeInputs.push({
              kind: "needs-info",
              issue: o.issue,
              questions: t.questions,
            });
            break;
          case "NEEDS-UI-PROTOTYPE":
            finalizeInputs.push({
              kind: "needs-ui-prototype",
              issue: o.issue,
              uiImpact: t.uiImpact,
              hasCommits: t.commits.length > 0,
            });
            break;
          case "NEEDS-HUMAN":
            finalizeInputs.push({
              kind: "needs-human",
              issue: o.issue,
              cause: t.cause,
              failureTrace: t.failureTrace,
              latestReviewerProse: t.latestReviewerProse,
            });
            break;
          case "NEEDS-HUMAN-REVIEW":
            finalizeInputs.push({
              kind: "review-budget-exhausted",
              issue: o.issue,
              latestReviewerProse: t.latestReviewerProse,
            });
            break;
          case "HARD-ERROR":
            finalizeInputs.push({
              kind: "hard-error",
              issue: o.issue,
              hasCommits: t.commits.length > 0,
            });
            break;
          default: {
            const unhandled: never = t;
            throw new Error(
              `unhandled terminal in finalise: ${JSON.stringify(unhandled)}`,
            );
          }
        }
      }
  
      if (finalizeInputs.length > 0) {
        const finalizeAdapter = realFinalizeAdapter({
          cwd: config.cwd,
          workDir: config.workDir,
          sourceBranch: config.sourceBranch,
        });
        // A required side-effect that fails (push/comment/label/close) throws
        // SandbarError out of finalizeAll — caught by the loud top-level handler
        // below, never swallowed here.
        const finalizeResults = await finalizeAll(
          finalizeInputs,
          finalizeAdapter,
          config.labels,
        );
        console.log(`\nFinalise: ${finalizeResults.length} issue(s).`);
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
      }
  
      // Post-push close failures (issue #14): the merges are durable on origin
      // and Phase 4 above already dropped `ready-for-agent` for every merged
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
