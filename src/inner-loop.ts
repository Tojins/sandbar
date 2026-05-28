// Inner-loop runner.
//
// Per issue: ralph-style attempts loop bounded by config.maxImplAttempts,
// single sandbox reused across attempts so commits accumulate on the issue
// branch. After each attempt the orchestrator parses the agent's promise
// token and either gate-checks (COMPLETE), terminates (NEEDS-INFO), or
// re-prompts (any no-signal). On gate-1 green the reviewer runs in the same
// sandbox, then gate-2 always runs. Budget exhaustion → NEEDS-HUMAN. Sandbox
// crash or gate-2 red without reviewer commits → HARD-ERROR with one
// fresh-sandbox retry, then surface.

import * as sandcastle from "@ai-hero/sandcastle";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import type { Sandbox, SandboxHooks } from "@ai-hero/sandcastle";

import { onCleanup } from "./cleanup.js";
import type { GateCommand } from "./config.js";
import { lastNLines, runGate } from "./gate.js";
import { commitsSince, ensureIssueBranch, getHeadSha, resetHard } from "./git-ops.js";
import type { AttemptLogger } from "./logs.js";
import { type Sidecar, startPgSidecar } from "./pg-sidecar.js";
import { parsePromise } from "./promise-parser.js";
import { buildPrompt, buildReviewerPrompt } from "./prompt.js";

export const HARD_ERROR_MAX_RETRIES = 2;
export const FAILURE_TAIL_LINES = 200;

export type IssueRef = {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
};

export type Terminal =
  | { readonly type: "DONE"; readonly commits: readonly { sha: string }[] }
  | { readonly type: "NEEDS-INFO"; readonly questions: string }
  | { readonly type: "NEEDS-HUMAN"; readonly failureTrace: string }
  | {
      readonly type: "HARD-ERROR";
      readonly reason: string;
      readonly commits: readonly { sha: string }[];
    };

export type InnerLoopConfig = {
  readonly sourceBranch: string;
  readonly modelId: string;
  readonly maxImplAttempts: number;
  readonly gateImage: string;
  readonly gateCommands: GateCommand;
  readonly claudeMdPath: string;
  readonly contextMdPath?: string;
  readonly adrDir?: string;
  readonly codingStandardsPath: string;
};

export type InnerLoopOptions = {
  readonly config: InnerLoopConfig;
  readonly hooks: SandboxHooks;
  readonly copyToWorktree: readonly string[];
  readonly attemptLogger?: AttemptLogger;
  readonly onOrchestratorLog?: (line: string) => Promise<void> | void;
};

export type Gate2Decision = "DONE" | "REVERT-THEN-DONE" | "HARD-ERROR";

// Pure decision: gate-2 result and the reviewer's commit count fully determine
// what the inner-loop does next. Tested in isolation; the I/O around it (sha
// recording, reset, retry) is glued in attemptIssueOnce.
export function decideAfterGate2(
  gate2Ok: boolean,
  reviewerCommitCount: number,
): Gate2Decision {
  if (gate2Ok) return "DONE";
  if (reviewerCommitCount > 0) return "REVERT-THEN-DONE";
  return "HARD-ERROR";
}

class HardError extends Error {}

export async function runInnerLoop(
  issue: IssueRef,
  opts: InnerLoopOptions,
): Promise<Terminal> {
  let outcome = await attemptIssueOnce(issue, opts);
  for (let retry = 1; retry <= HARD_ERROR_MAX_RETRIES; retry++) {
    if (outcome.type !== "HARD-ERROR") return outcome;
    console.error(
      `  ${issue.id}: HARD-ERROR (${outcome.reason}) — retry ${retry}/${HARD_ERROR_MAX_RETRIES} with a fresh sandbox.`,
    );
    outcome = await attemptIssueOnce(issue, opts);
  }
  return outcome;
}

async function attemptIssueOnce(
  issue: IssueRef,
  opts: InnerLoopOptions,
): Promise<Terminal> {
  const { config } = opts;
  let sandbox: Sandbox | null = null;
  let sidecar: Sidecar | null = null;
  const accumulated: { sha: string }[] = [];
  let lastFailureTrace = "";
  let extraReprompt: string | undefined = undefined;

  try {
    // Seed the issue branch off origin/<sourceBranch> (not the host's local)
    // so sandcastle never inherits cwd's in-progress state. Idempotent:
    // existing branches with accumulated commits are left alone. Preflight
    // has already fetched origin.
    await ensureIssueBranch(issue.branch, config.sourceBranch);

    // allSettled (not all) so we can tear down a side that resolved when the
    // other rejected.
    const [sandboxResult, sidecarResult] = await Promise.allSettled([
      sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: podman(),
        hooks: opts.hooks,
        copyToWorktree: [...opts.copyToWorktree],
      }),
      startPgSidecar({ issueId: issue.id }),
    ]);
    if (sandboxResult.status === "fulfilled") sandbox = sandboxResult.value;
    if (sidecarResult.status === "fulfilled") sidecar = sidecarResult.value;
    if (sandbox === null || sidecar === null) {
      throw sandboxResult.status === "rejected"
        ? sandboxResult.reason
        : (sidecarResult as PromiseRejectedResult).reason;
    }

    const sidecarRef = sidecar;
    onCleanup(() => sidecarRef.stop());

    const gateOpts = {
      gateImage: config.gateImage,
      gateCommands: config.gateCommands,
      networkName: sidecar.networkName,
      dbHost: sidecar.dbHost,
      dbPort: sidecar.dbPort,
      dbUser: sidecar.dbUser,
      dbPassword: sidecar.dbPassword,
      dbName: sidecar.dbName,
      dbNameTest: sidecar.dbNameTest,
    };

    const anchorOpts = {
      claudeMdPath: config.claudeMdPath,
      contextMdPath: config.contextMdPath,
      adrDir: config.adrDir,
      codingStandardsPath: config.codingStandardsPath,
      sourceBranch: config.sourceBranch,
    };

    for (let attempt = 1; attempt <= config.maxImplAttempts; attempt++) {
      const prompt = await buildPrompt(
        {
          issue,
          attempt,
          maxAttempts: config.maxImplAttempts,
          worktreePath: sandbox.worktreePath,
          lastFailureTrace,
          sourceBranch: config.sourceBranch,
          extraReprompt,
        },
        anchorOpts,
      );

      const run = await sandbox.run({
        name: `implementer-${issue.id}-attempt-${attempt}`,
        maxIterations: 1,
        agent: sandcastle.claudeCode(config.modelId),
        prompt,
      });
      if (opts.attemptLogger) {
        await opts.attemptLogger.writeAttempt(issue.id, attempt, run.stdout);
      }
      accumulated.push(...run.commits);
      extraReprompt = undefined;

      const signal = parsePromise(run.stdout, {
        commitsAccumulated: accumulated.length,
      });

      if (signal.kind === "NEEDS-INFO") {
        return { type: "NEEDS-INFO", questions: signal.questions };
      }

      if (signal.kind === "COMPLETE") {
        const gate1 = await runGate({
          worktreePath: sandbox.worktreePath,
          ...gateOpts,
        });
        if (opts.onOrchestratorLog) {
          await opts.onOrchestratorLog(
            `issue=${issue.id} attempt=${attempt} gate-1 ok=${gate1.ok} exitCode=${gate1.exitCode} failedStep=${gate1.failedStep ?? "-"}`,
          );
        }
        if (!gate1.ok) {
          lastFailureTrace = lastNLines(
            `${gate1.stdout}\n${gate1.stderr}`,
            FAILURE_TAIL_LINES,
          );
          continue;
        }

        const reviewerOutcome = await runReviewerAndGate2(
          sandbox,
          issue,
          attempt,
          accumulated,
          gateOpts,
          opts,
        );
        return reviewerOutcome;
      }

      if (signal.reprompt) extraReprompt = signal.reprompt;
    }

    return {
      type: "NEEDS-HUMAN",
      failureTrace: lastFailureTrace || "Attempt budget exhausted with no green gate.",
    };
  } catch (err) {
    if (err instanceof HardError) {
      return { type: "HARD-ERROR", reason: err.message, commits: accumulated };
    }
    return {
      type: "HARD-ERROR",
      reason: err instanceof Error ? err.message : String(err),
      commits: accumulated,
    };
  } finally {
    if (sandbox) {
      try {
        await sandbox.close();
      } catch {
        // ignore
      }
    }
    if (sidecar) {
      try {
        await sidecar.stop();
      } catch {
        // ignore
      }
    }
  }
}

type SidecarGateOpts = {
  readonly gateImage: string;
  readonly gateCommands: GateCommand;
  readonly networkName: string;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly dbUser: string;
  readonly dbPassword: string;
  readonly dbName: string;
  readonly dbNameTest: string;
};

async function runReviewerAndGate2(
  sandbox: Sandbox,
  issue: IssueRef,
  attempt: number,
  accumulated: { sha: string }[],
  gateOpts: SidecarGateOpts,
  opts: InnerLoopOptions,
): Promise<Terminal> {
  const { config } = opts;
  const preReviewerSha = await getHeadSha(sandbox.worktreePath);

  const reviewerPrompt = await buildReviewerPrompt({
    issue,
    worktreePath: sandbox.worktreePath,
    sourceBranch: config.sourceBranch,
    codingStandardsPath: config.codingStandardsPath,
    claudeMdPath: config.claudeMdPath,
    contextMdPath: config.contextMdPath,
  });

  try {
    const reviewerRun = await sandbox.run({
      name: `reviewer-${issue.id}`,
      maxIterations: 1,
      agent: sandcastle.claudeCode(config.modelId),
      prompt: reviewerPrompt,
    });
    if (opts.attemptLogger) {
      await opts.attemptLogger.writeAttemptReviewer(
        issue.id,
        attempt,
        reviewerRun.stdout,
      );
    }
  } catch (err) {
    console.error(
      `  ${issue.id}: reviewer run errored — gate-2 will decide. (${err instanceof Error ? err.message : String(err)})`,
    );
    if (opts.attemptLogger) {
      await opts.attemptLogger.writeAttemptReviewer(
        issue.id,
        attempt,
        `reviewer run errored: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const reviewerCommits = await commitsSince(sandbox.worktreePath, preReviewerSha);
  const gate2 = await runGate({
    worktreePath: sandbox.worktreePath,
    ...gateOpts,
  });
  if (opts.onOrchestratorLog) {
    await opts.onOrchestratorLog(
      `issue=${issue.id} attempt=${attempt} gate-2 ok=${gate2.ok} exitCode=${gate2.exitCode} reviewerCommits=${reviewerCommits.length}`,
    );
  }

  const decision = decideAfterGate2(gate2.ok, reviewerCommits.length);

  if (decision === "DONE") {
    return {
      type: "DONE",
      commits: [...accumulated, ...reviewerCommits],
    };
  }

  if (decision === "REVERT-THEN-DONE") {
    await resetHard(sandbox.worktreePath, preReviewerSha);
    console.log(
      `  ${issue.id}: gate-2 red after reviewer made ${reviewerCommits.length} commit(s); reset to pre-reviewer SHA, accepting implementer's work.`,
    );
    return { type: "DONE", commits: accumulated };
  }

  // HARD-ERROR — gate-1 was green moments ago; gate-2 red with no reviewer
  // edits is treated as infra flake. Throw to engage the one-retry path.
  const trace = lastNLines(
    `${gate2.stdout}\n${gate2.stderr}`,
    FAILURE_TAIL_LINES,
  );
  throw new HardError(
    `gate-2 red with no reviewer commits (failed step: ${gate2.failedStep ?? "unknown"})\n${trace}`,
  );
}
