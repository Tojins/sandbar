// Inner-loop runner — I/O glue around the pure state machine.
//
// Per issue:
//   1. Setup a sandcastle sandbox + Postgres sidecar.
//   2. Drive the state machine (inner-loop-machine.ts) to a verdict by
//      executing the action it emits and feeding the result back as an event.
//   3. Translate the verdict to a Terminal (attaching commit lists and, for
//      REVERT-THEN-DONE, resetting the worktree to the pre-reviewer SHA).
//   4. If the verdict is HARD-ERROR, the outer loop here asks
//      decideAfterTerminal whether to dispose the sandbox and restart from
//      attempt 1 with a fresh one (up to HARD_ERROR_MAX_RETRIES times).
//
// All branching decisions live in the state machine. This file only does I/O.

import * as sandcastle from "@ai-hero/sandcastle";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import type { Sandbox, SandboxHooks } from "@ai-hero/sandcastle";

import { onCleanup } from "./cleanup.js";
import type { GateCommand } from "./config.js";
import { lastNLines, runGate } from "./gate.js";
import { commitsSince, ensureIssueBranch, getHeadSha, resetHard } from "./git-ops.js";
import {
  HARD_ERROR_MAX_RETRIES,
  type LoopAction,
  type LoopEvent,
  type LoopState,
  type Verdict,
  decideAfterTerminal,
  initialAction,
  initialState,
  step,
} from "./inner-loop-machine.js";
import type { AttemptLogger } from "./logs.js";
import { type Sidecar, startPgSidecar } from "./pg-sidecar.js";
import { parsePromise } from "./promise-parser.js";
import { buildPrompt, buildReviewerPrompt } from "./prompt.js";

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

type SandboxCycleOutcome = {
  readonly verdict: Verdict;
  readonly accumulatedCommits: readonly { sha: string }[];
  readonly reviewerCommits: readonly { sha: string }[];
};

export async function runInnerLoop(
  issue: IssueRef,
  opts: InnerLoopOptions,
): Promise<Terminal> {
  let retriesUsed = 0;
  for (;;) {
    const outcome = await runSandboxCycle(issue, opts);
    const decision = decideAfterTerminal(outcome.verdict, retriesUsed);
    if (decision.kind === "surface") return toTerminal(outcome);
    retriesUsed = decision.nextRetriesUsed;
    const reason = outcome.verdict.type === "HARD-ERROR" ? outcome.verdict.reason : "";
    console.error(
      `  ${issue.id}: HARD-ERROR (${reason}) — retry ${retriesUsed}/${HARD_ERROR_MAX_RETRIES} with a fresh sandbox.`,
    );
  }
}

function toTerminal(outcome: SandboxCycleOutcome): Terminal {
  const { verdict, accumulatedCommits, reviewerCommits } = outcome;
  switch (verdict.type) {
    case "DONE":
      return { type: "DONE", commits: [...accumulatedCommits, ...reviewerCommits] };
    case "REVERT-THEN-DONE":
      // The reset to pre-reviewer SHA already happened in runSandboxCycle as
      // part of action execution; here we only need to publish the implementer's
      // accumulated commits.
      return { type: "DONE", commits: accumulatedCommits };
    case "NEEDS-INFO":
      return { type: "NEEDS-INFO", questions: verdict.questions };
    case "NEEDS-HUMAN":
      return { type: "NEEDS-HUMAN", failureTrace: verdict.failureTrace };
    case "HARD-ERROR":
      return {
        type: "HARD-ERROR",
        reason: verdict.reason,
        commits: accumulatedCommits,
      };
  }
}

async function runSandboxCycle(
  issue: IssueRef,
  opts: InnerLoopOptions,
): Promise<SandboxCycleOutcome> {
  const { config } = opts;
  let sandbox: Sandbox | null = null;
  let sidecar: Sidecar | null = null;
  const accumulated: { sha: string }[] = [];
  let reviewerCommits: readonly { sha: string }[] = [];

  try {
    // Seed the issue branch off origin/<sourceBranch> (not the host's local)
    // so sandcastle never inherits cwd's in-progress state. Idempotent.
    await ensureIssueBranch(issue.branch, config.sourceBranch);

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

    const gateOpts: SidecarGateOpts = {
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

    let preReviewerSha: string | null = null;
    let state: LoopState = initialState(config.maxImplAttempts);
    let action: LoopAction = initialAction(state);

    while (action.kind !== "terminate") {
      const event = await executeAction(action, {
        issue,
        sandbox,
        opts,
        config,
        anchorOpts,
        gateOpts,
        accumulated,
        onReviewerComplete: (sha, commits) => {
          preReviewerSha = sha;
          reviewerCommits = commits;
        },
      });
      const r = step(state, event);
      state = r.state;
      action = r.action;
    }

    const verdict = action.verdict;
    if (verdict.type === "REVERT-THEN-DONE") {
      if (preReviewerSha === null) {
        throw new Error(
          "REVERT-THEN-DONE verdict but no pre-reviewer SHA was captured",
        );
      }
      await resetHard(sandbox.worktreePath, preReviewerSha);
      console.log(
        `  ${issue.id}: gate-2 red after reviewer made ${reviewerCommits.length} commit(s); reset to pre-reviewer SHA, accepting implementer's work.`,
      );
    }

    return { verdict, accumulatedCommits: accumulated, reviewerCommits };
  } catch (err) {
    // Setup failure or any other unhandled exception inside the cycle.
    // Surface as HARD-ERROR so the outer loop can decide whether to retry
    // with a fresh sandbox.
    return {
      verdict: {
        type: "HARD-ERROR",
        reason: err instanceof Error ? err.message : String(err),
      },
      accumulatedCommits: accumulated,
      reviewerCommits,
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

type ExecuteActionCtx = {
  readonly issue: IssueRef;
  readonly sandbox: Sandbox;
  readonly opts: InnerLoopOptions;
  readonly config: InnerLoopConfig;
  readonly anchorOpts: {
    readonly claudeMdPath: string;
    readonly contextMdPath?: string;
    readonly adrDir?: string;
    readonly codingStandardsPath: string;
    readonly sourceBranch: string;
  };
  readonly gateOpts: SidecarGateOpts;
  readonly accumulated: { sha: string }[];
  readonly onReviewerComplete: (
    preReviewerSha: string,
    commits: readonly { sha: string }[],
  ) => void;
};

async function executeAction(
  action: LoopAction,
  ctx: ExecuteActionCtx,
): Promise<LoopEvent> {
  switch (action.kind) {
    case "run-implementer":
      return runImplementer(action, ctx);
    case "run-gate-1":
      return runGate1(action, ctx);
    case "run-reviewer-and-gate-2":
      return runReviewerAndGate2(action, ctx);
    case "terminate":
      throw new Error("executeAction called with terminate; runner should exit instead");
  }
}

async function runImplementer(
  action: Extract<LoopAction, { kind: "run-implementer" }>,
  ctx: ExecuteActionCtx,
): Promise<LoopEvent> {
  const { issue, sandbox, opts, config, anchorOpts, accumulated } = ctx;
  const prompt = await buildPrompt(
    {
      issue,
      attempt: action.attempt,
      maxAttempts: config.maxImplAttempts,
      worktreePath: sandbox.worktreePath,
      lastFailureTrace: action.failureTrace,
      sourceBranch: config.sourceBranch,
      ...(action.extraReprompt !== null ? { extraReprompt: action.extraReprompt } : {}),
    },
    anchorOpts,
  );

  const run = await sandbox.run({
    name: `implementer-${issue.id}-attempt-${action.attempt}`,
    maxIterations: 1,
    agent: sandcastle.claudeCode(config.modelId),
    prompt,
  });
  if (opts.attemptLogger) {
    await opts.attemptLogger.writeAttempt(issue.id, action.attempt, run.stdout);
  }
  accumulated.push(...run.commits);

  const signal = parsePromise(run.stdout, {
    commitsAccumulated: accumulated.length,
  });
  return { kind: "implementer-result", signal };
}

async function runGate1(
  action: Extract<LoopAction, { kind: "run-gate-1" }>,
  ctx: ExecuteActionCtx,
): Promise<LoopEvent> {
  const { issue, sandbox, opts, gateOpts } = ctx;
  const gate1 = await runGate({ worktreePath: sandbox.worktreePath, ...gateOpts });
  if (opts.onOrchestratorLog) {
    await opts.onOrchestratorLog(
      `issue=${issue.id} attempt=${action.attempt} gate-1 ok=${gate1.ok} exitCode=${gate1.exitCode} failedStep=${gate1.failedStep ?? "-"}`,
    );
  }
  return {
    kind: "gate-1-result",
    ok: gate1.ok,
    failureTrace: gate1.ok
      ? ""
      : lastNLines(`${gate1.stdout}\n${gate1.stderr}`, FAILURE_TAIL_LINES),
  };
}

async function runReviewerAndGate2(
  action: Extract<LoopAction, { kind: "run-reviewer-and-gate-2" }>,
  ctx: ExecuteActionCtx,
): Promise<LoopEvent> {
  const { issue, sandbox, opts, config, gateOpts, onReviewerComplete } = ctx;
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
        action.attempt,
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
        action.attempt,
        `reviewer run errored: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const reviewerCommits = await commitsSince(sandbox.worktreePath, preReviewerSha);
  onReviewerComplete(preReviewerSha, reviewerCommits);

  const gate2 = await runGate({ worktreePath: sandbox.worktreePath, ...gateOpts });
  if (opts.onOrchestratorLog) {
    await opts.onOrchestratorLog(
      `issue=${issue.id} attempt=${action.attempt} gate-2 ok=${gate2.ok} exitCode=${gate2.exitCode} reviewerCommits=${reviewerCommits.length}`,
    );
  }

  return {
    kind: "gate-2-result",
    ok: gate2.ok,
    reviewerCommitCount: reviewerCommits.length,
    failureTrace: gate2.ok
      ? ""
      : lastNLines(`${gate2.stdout}\n${gate2.stderr}`, FAILURE_TAIL_LINES),
    failedStep: gate2.failedStep,
  };
}
