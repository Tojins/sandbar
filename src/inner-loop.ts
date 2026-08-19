// Inner-loop runner — I/O glue around the pure state machine.
//
// Per issue:
//   1. Prepare the issue worktree, then set up an agent sandbox + the gate
//      stack in parallel. The worktree comes FIRST (not in the parallel pair,
//      #20): stack mounts bind-mount fixture files from it, and mount sources
//      are read at container start — only the expensive container bringups
//      overlap.
//   2. Drive the state machine (inner-loop-machine.ts) to a verdict by
//      executing the action it emits and feeding the result back as an event.
//   3. Translate the verdict to a Terminal.
//   4. If the verdict is HARD-ERROR, the outer loop here asks
//      decideAfterTerminal whether to dispose the sandbox and restart from
//      attempt 1 with a fresh one (up to HARD_ERROR_MAX_RETRIES times).
//
// Reviewer is strictly advisory and never commits — there is no gate-2 and
// no revert-after-reviewer logic. All branching decisions live in the state
// machine. This file only does I/O.

import * as agentSandbox from "./agent-sandbox.js";
import { podman } from "./agent-sandbox.js";
import type { Sandbox, SandboxHooks } from "./agent-sandbox.js";

import type { ResolvedGateStack } from "./config.js";
import type { BranchImages } from "./ensure-images.js";
import { SandbarError } from "./errors.js";
import { summarizeGateFailure } from "./gate.js";
import { ContainerBringupError, type Stack, startStack } from "./gate-stack.js";
import {
  type HeadMismatch,
  dirtyWorktreePaths,
  ensureIssueBranch,
  headMismatch,
} from "./git-ops.js";
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
import { type RunScope, scopedResourcePrefix } from "./naming.js";
import { parsePromise } from "./promise-parser.js";
import {
  type ProjectAnchorOptions,
  buildPrompt,
  buildReviewerPrompt,
} from "./prompt.js";
import { parseVerdict } from "./verdict-parser.js";

export const FAILURE_TAIL_LINES = 200;

export type IssueRef = {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
};

export type Terminal =
  | { readonly type: "DONE"; readonly commits: readonly { sha: string }[] }
  | {
      readonly type: "NEEDS-INFO";
      readonly questions: string;
      // #27 — where the agent's commits went, when it asked from off the branch.
      readonly strandedHead: HeadMismatch | null;
    }
  | {
      // #21. `commits` is normally empty (the assessment happens before any
      // code is written) but is carried because a late escalation is accepted:
      // finalize pushes the branch only when the agent already committed.
      readonly type: "NEEDS-UI-PROTOTYPE";
      readonly uiImpact: string;
      readonly commits: readonly { sha: string }[];
      // #27. Note this is NOT redundant with an empty `commits`: commits are
      // counted on the branch, so an off-branch escalation reports none and
      // finalize would delete the branch and post nothing about the work.
      readonly strandedHead: HeadMismatch | null;
    }
  | {
      readonly type: "NEEDS-HUMAN";
      readonly cause:
        | "gate-red"
        | "reviewer-blocked"
        | "uncommittable-worktree"
        | "off-branch-head";
      readonly failureTrace: string;
      readonly latestReviewerProse: string | null;
      readonly strandedHead: HeadMismatch | null;
    }
  | {
      readonly type: "NEEDS-HUMAN-REVIEW";
      readonly latestReviewerProse: string;
      readonly commits: readonly { sha: string }[];
    }
  | {
      readonly type: "HARD-ERROR";
      readonly reason: string;
      readonly commits: readonly { sha: string }[];
    };

export type InnerLoopConfig = {
  // The host repo. Everything rooted here — the issue branch this loop seeds,
  // the managed worktree it prepares, the anchor layers' `git log`/`gh issue
  // view` — must agree with the `config.cwd` finalize, preflight and the merger
  // use, and inheriting `process.cwd()` made that agreement a coincidence of
  // how the host was launched (#34).
  readonly cwd: string;
  readonly sourceBranch: string;
  readonly workDir: string;
  readonly envFilePath: string;
  readonly implementerModelId: string;
  readonly reviewerModelId: string;
  readonly maxImplAttempts: number;
  readonly maxReviewRounds: number;
  readonly sandboxImage: string;
  // This run's podman resource scope (#28) — see naming.ts. Both the agent
  // sandbox container and the gate stack are named under it.
  readonly scope: RunScope;
  readonly gateStack: ResolvedGateStack;
  readonly claudeMdPath: string;
  readonly contextMdPath?: string;
  readonly adrDir?: string;
  readonly codingStandardsPath?: string;
};

export type InnerLoopOptions = {
  readonly config: InnerLoopConfig;
  readonly hooks: SandboxHooks;
  readonly copyToWorktree: readonly string[];
  // Per-branch gate images (#37). Shared across every issue in the run, because
  // its build cache is: two branches that make the same lockfile change produce
  // the same content-addressed tag and must not build it twice.
  readonly branchImages?: BranchImages;
  readonly attemptLogger?: AttemptLogger;
  readonly onOrchestratorLog?: (line: string) => Promise<void> | void;
};

type SandboxCycleOutcome = {
  readonly verdict: Verdict;
  readonly accumulatedCommits: readonly { sha: string }[];
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
  const { verdict, accumulatedCommits } = outcome;
  switch (verdict.type) {
    case "DONE":
      return { type: "DONE", commits: accumulatedCommits };
    case "NEEDS-INFO":
      return {
        type: "NEEDS-INFO",
        questions: verdict.questions,
        strandedHead: verdict.strandedHead,
      };
    case "NEEDS-UI-PROTOTYPE":
      return {
        type: "NEEDS-UI-PROTOTYPE",
        uiImpact: verdict.uiImpact,
        commits: accumulatedCommits,
        strandedHead: verdict.strandedHead,
      };
    case "NEEDS-HUMAN":
      return {
        type: "NEEDS-HUMAN",
        cause: verdict.cause,
        failureTrace: verdict.failureTrace,
        latestReviewerProse: verdict.latestReviewerProse,
        strandedHead: verdict.strandedHead,
      };
    case "NEEDS-HUMAN-REVIEW":
      return {
        type: "NEEDS-HUMAN-REVIEW",
        latestReviewerProse: verdict.latestReviewerProse,
        commits: accumulatedCommits,
      };
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
  const branchImages = opts.branchImages;
  let sandbox: Sandbox | null = null;
  let stack: Stack | null = null;
  const accumulated: { sha: string }[] = [];

  try {
    // Seed the issue branch off origin/<sourceBranch> (not the host's local)
    // so the sandbox never inherits cwd's in-progress state. Idempotent.
    await ensureIssueBranch(config.cwd, issue.branch, config.sourceBranch);

    // Worktree first (fast git ops), then container bringups in parallel: the
    // stack's mounts resolve against this worktree and must see its files on
    // disk at container start (#20).
    const worktreePath = await agentSandbox.prepareWorktree({
      branch: issue.branch,
      // Explicit, not `process.cwd()` (#34). The path this returns has to be
      // the one `worktreePathFor(config.cwd, ...)` computes for finalize and
      // preflight — they are the same directory only if both are rooted the
      // same way.
      cwd: config.cwd,
      hooks: opts.hooks,
      copyToWorktree: [...opts.copyToWorktree],
      workDir: config.workDir,
    });

    const [sandboxResult, stackResult] = await Promise.allSettled([
      agentSandbox.createSandbox({
        branch: issue.branch,
        cwd: config.cwd,
        // Named explicitly rather than left to defaultImageName(repoDir): the
        // implicit coupling between the sandbox image and the host's repo
        // DIRECTORY NAME broke silently on a rename (#24 D7).
        sandbox: podman({
          imageName: config.sandboxImage,
          namePrefix: scopedResourcePrefix(config.scope),
        }),
        hooks: opts.hooks,
        envFilePath: config.envFilePath,
        workDir: config.workDir,
        preparedWorktreePath: worktreePath,
      }),
      startStack({
        stackId: issue.id,
        scope: config.scope,
        spec: config.gateStack,
        worktreePath,
        // A thunk, not a value: the stack calls it before every gate run, and
        // the answer changes as the agent commits (#37).
        ...(branchImages ? { images: () => branchImages.resolve(worktreePath) } : {}),
      }),
    ]);
    if (sandboxResult.status === "fulfilled") sandbox = sandboxResult.value;
    if (stackResult.status === "fulfilled") stack = stackResult.value;
    if (sandbox === null || stack === null) {
      throw sandboxResult.status === "rejected"
        ? sandboxResult.reason
        : (stackResult as PromiseRejectedResult).reason;
    }

    // startStack already registered stack.stop with onCleanup before it created
    // any podman resource, so no re-registration is needed here.
    const gateStack: Stack = stack;

    const anchorOpts = {
      cwd: config.cwd,
      claudeMdPath: config.claudeMdPath,
      contextMdPath: config.contextMdPath,
      adrDir: config.adrDir,
      sourceBranch: config.sourceBranch,
    };

    let state: LoopState = initialState({
      maxAttempts: config.maxImplAttempts,
      maxReviewRounds: config.maxReviewRounds,
    });
    let action: LoopAction = initialAction(state);

    while (action.kind !== "terminate") {
      const event = await executeAction(action, {
        issue,
        sandbox,
        opts,
        config,
        anchorOpts,
        gateStack,
        worktreePath,
        accumulated,
      });
      const r = step(state, event);
      state = r.state;
      action = r.action;
    }

    return { verdict: action.verdict, accumulatedCommits: accumulated };
  } catch (err) {
    // HARD-ERROR is for INFRA failures — podman, setup, a container that would
    // not come up — which the outer layer retries with a fresh sandbox. A
    // SandbarError is sandbar's own bug (`gate-stack.ts` raises them for an
    // internal inconsistency in the port publish and for a step targeting a
    // container `resolveGateStack` already proved exists). Converting those to
    // HARD-ERROR buys two fresh-stack retries that reproduce the identical bug
    // and then stamps NEEDS-HUMAN on an innocent issue with an infra-flavoured
    // trace. Let it out to the loud top-level handler instead.
    //
    // ContainerBringupError is the deliberate exception: it EXTENDS
    // SandbarError but reports infrastructure — a container that would not
    // start, or an issue-lifecycle container found dead before a gate run —
    // which is precisely what HARD-ERROR's fresh-stack retry exists for.
    if (err instanceof SandbarError && !(err instanceof ContainerBringupError)) {
      throw err;
    }
    // Setup failure or any other unhandled exception inside the cycle.
    // Surface as HARD-ERROR so the outer loop can decide whether to retry
    // with a fresh sandbox.
    return {
      verdict: {
        type: "HARD-ERROR",
        reason: err instanceof Error ? err.message : String(err),
      },
      accumulatedCommits: accumulated,
    };
  } finally {
    // Stack first: its containers bind-mount the worktree read-write, and
    // `sandbox.close()` ends in `git worktree remove --force`. Tearing the
    // sandbox down first leaves a still-running attempt container (an app
    // server, a watcher) writing into the tree while it is being removed —
    // and a write between the last gate and `close()` flips the
    // uncommitted-changes check, so the worktree is PRESERVED instead and
    // leaks for the rest of the run. run.ts:466 already orders the merge
    // phase this way, with the same reasoning.
    if (stack) {
      try {
        await stack.stop();
      } catch (err) {
        // Never mask the verdict with a teardown failure, but never hide it
        // either — it means leaked podman resources.
        console.error(err instanceof Error ? err.message : String(err));
      }
    }
    if (sandbox) {
      try {
        await sandbox.close();
      } catch {
        // ignore
      }
    }
  }
}

type ExecuteActionCtx = {
  readonly issue: IssueRef;
  readonly sandbox: Sandbox;
  readonly opts: InnerLoopOptions;
  readonly config: InnerLoopConfig;
  readonly anchorOpts: ProjectAnchorOptions;
  readonly gateStack: Stack;
  // The issue worktree. Same tree the sandbox edits, the stack mounts and the
  // clean-assert reads — one tree, which is the whole point of D1.
  readonly worktreePath: string;
  readonly accumulated: { sha: string }[];
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
    case "run-reviewer":
      return runReviewer(action, ctx);
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
      ...(action.latestReviewerProse !== null
        ? { latestReviewerProse: action.latestReviewerProse }
        : {}),
    },
    anchorOpts,
  );

  const run = await sandbox.run({
    name: `implementer-${issue.id}-attempt-${action.attempt}`,
    maxIterations: 1,
    agent: agentSandbox.claudeCode(config.implementerModelId),
    prompt,
  });
  if (opts.attemptLogger) {
    await opts.attemptLogger.writeAttempt(issue.id, action.attempt, run.stdout);
  }
  accumulated.push(...run.commits);

  const signal = parsePromise(run.stdout, {
    commitsAccumulated: accumulated.length,
  });
  // Read here, not in the gate: a COMPLETE claim over a dirty tree should never
  // cost a stack bringup, and the state machine wants the paths to re-prompt
  // with (#24 D1). Read on every signal so the SM stays the only place that
  // decides what dirt means.
  //
  // The branch position (#27) is read at the same point and for the same
  // reason, and it is NOT implied by the clean tree: an agent that committed on
  // a detached HEAD leaves the tree spotless while `refs/heads/<branch>` — the
  // only thing the merger ever reads — has not moved. Read together, both on
  // every signal, so the SM stays the only place that decides what either means.
  const [dirtyPaths, offBranch] = await Promise.all([
    dirtyWorktreePaths(ctx.worktreePath),
    headMismatch(ctx.worktreePath, issue.branch),
  ]);
  return { kind: "implementer-result", signal, dirtyPaths, offBranch };
}

async function runGate1(
  action: Extract<LoopAction, { kind: "run-gate-1" }>,
  ctx: ExecuteActionCtx,
): Promise<LoopEvent> {
  const { issue, opts, gateStack } = ctx;
  const gate1 = await gateStack.runGate();
  if (opts.onOrchestratorLog) {
    await opts.onOrchestratorLog(
      `issue=${issue.id} attempt=${action.attempt} gate-1 ok=${gate1.ok} exitCode=${gate1.exitCode} failedStep=${gate1.failedStep ?? "-"}`,
    );
  }
  return {
    kind: "gate-1-result",
    ok: gate1.ok,
    // Summarize the STEP output, then append the container logs — never the
    // other way round. The cascade collapse looks for many lines sharing one
    // signature, and a service log is full of them (see GateResult.containerLogs).
    failureTrace: gate1.ok
      ? ""
      : summarizeGateFailure(`${gate1.stdout}\n${gate1.stderr}`, FAILURE_TAIL_LINES) +
        gate1.containerLogs,
  };
}

async function runReviewer(
  action: Extract<LoopAction, { kind: "run-reviewer" }>,
  ctx: ExecuteActionCtx,
): Promise<LoopEvent> {
  const { issue, sandbox, opts, config } = ctx;

  const reviewerPrompt = await buildReviewerPrompt({
    issue,
    cwd: config.cwd,
    worktreePath: sandbox.worktreePath,
    sourceBranch: config.sourceBranch,
    codingStandardsPath: config.codingStandardsPath,
    claudeMdPath: config.claudeMdPath,
    contextMdPath: config.contextMdPath,
  });

  let reviewerStdout = "";
  try {
    const reviewerRun = await sandbox.run({
      name: `reviewer-${issue.id}-round-${action.reviewRound}`,
      maxIterations: 1,
      agent: agentSandbox.claudeCode(config.reviewerModelId),
      prompt: reviewerPrompt,
    });
    reviewerStdout = reviewerRun.stdout;
  } catch (err) {
    // A reviewer that crashes mid-run defaults to CHANGES-REQUESTED via the
    // verdict parser (empty stdout = no verdict token). Surface the error
    // text as prose so the next implementer attempt sees something useful.
    reviewerStdout =
      `reviewer run errored: ${err instanceof Error ? err.message : String(err)}\n`;
    console.error(
      `  ${issue.id}: reviewer run errored — defaulting to CHANGES-REQUESTED. (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (opts.attemptLogger) {
    await opts.attemptLogger.writeAttemptReviewer(
      issue.id,
      action.attempt,
      reviewerStdout,
    );
  }

  const { verdict, prose } = parseVerdict(reviewerStdout);
  if (opts.onOrchestratorLog) {
    await opts.onOrchestratorLog(
      `issue=${issue.id} attempt=${action.attempt} reviewer round=${action.reviewRound} verdict=${verdict}`,
    );
  }
  return { kind: "reviewer-result", verdict, prose };
}
