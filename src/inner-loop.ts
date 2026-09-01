// Inner-loop runner — I/O glue around the pure state machine
// (inner-loop-machine.ts). All branching decisions live in the SM; this file
// executes its actions, feeds results back as events, and translates the
// verdict to a Terminal. On HARD-ERROR, decideAfterTerminal may dispose the
// sandbox and restart from attempt 1 with a fresh one (up to
// HARD_ERROR_MAX_RETRIES times).
//
// Setup ordering is load-bearing: the issue worktree comes FIRST, then agent
// sandbox + gate stack in parallel (#20 — mount sources are read at container
// start; #46 — the files a `rebuildOn` entry hashes must be on disk before
// `createSandbox`). Containers marked `inSandbox` (#44) come up INSIDE the
// sandbox entry via `beforeSandboxReady`: they attach to the agent
// container's netns, so it must exist first, and they must be up before a
// consumer's `onSandboxReady` hook runs.
//
// Two deliberate exceptions to "all branching lives in the SM" stay within
// one action each. The promise nudge in runImplementer gives an implementer
// that ends with no `<promise>` tag at all one `--continue` follow-up before
// the NO-SIGNAL reaches the SM
// — the SM never sees the nudge, only the re-parsed result. The full argument
// is at the call site. A review round is likewise a correctness pass followed,
// only when approved, by a checklist pass resumed on its separately configured
// model; the SM receives one aggregate reviewer result and spends one round.
//
// What a FAILED reviewer run means is reviewer-run.ts's policy (#41); this
// file only adapts `sandbox.run`'s throw into the shape that policy
// classifies, which is why the try/catch below returns a value instead of
// substituting prose.

import { join } from "node:path";

import {
  type AgentProviderName,
  buildAgentProvider,
} from "./agent-providers.js";
import * as agentSandbox from "./agent-sandbox.js";
import { agentPartialOutput, podman } from "./agent-sandbox.js";
import type { Sandbox, SandboxHooks } from "./agent-sandbox.js";

import type { ChunkTarget } from "./chunks.js";
import type { ResolvedGateStack } from "./config.js";
import { type BranchImages, resolveSandboxImage } from "./ensure-images.js";
import { SandbarError } from "./errors.js";
import { summarizeGateFailure } from "./gate.js";
import { ContainerBringupError, type Stack, startStack } from "./gate-stack.js";
import {
  type HeadMismatch,
  type IssueBranchBase,
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
import { loadTemplate } from "./prompts.js";
import {
  type SandboxContainerStatus,
  type SandboxStack,
  SANDBOX_LOG_MOUNT,
  prepareSandboxLogDir,
  sandboxContainers,
  startSandboxStack,
} from "./sandbox-stack.js";
import {
  REVIEWER_MAX_INVOCATIONS,
  continueReviewerSession,
  decideReviewRound,
  runReviewerInvocations,
} from "./reviewer-run.js";
import type { RepoLayout } from "./repo-cache.js";
import type { RepoRef } from "./repo-ref.js";
import {
  type ProjectAnchorOptions,
  buildPrompt,
  buildReviewerPrompts,
} from "./prompt.js";

export const FAILURE_TAIL_LINES = 200;

// The promise nudge (see runImplementer). Loaded at import time like every
// other template; no placeholders.
const PROMISE_NUDGE_TPL = loadTemplate("implementer-promise-nudge");

export type IssueRef = {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
  // The chunk this issue belongs to, as the planner derived it (#60). Null (or
  // absent) ⇒ the auto lane. Phase 2 reads it for one thing and one thing only:
  // where the issue branch is SEEDED from (#61). A member chained behind an
  // already-landed one is cut from the chunk's tip rather than from
  // `origin/<sourceBranch>`, because that is where its blocker's commits are.
  // Optional for the same reason merger.ts's `IssueRef` makes it optional — the
  // shape is built by hand in places that have nothing to do with landing — and
  // the one caller whose answer matters (the plan) always sets it.
  readonly chunk?: ChunkTarget | null;
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
        | "off-branch-head"
        | "reviewer-harness-failed";
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
  // Every directory this loop touches, as one object (#38). The issue branch it
  // seeds, the managed worktree it prepares and the anchor layers' `git log` /
  // `gh issue view` all name `layout.repoDir` — the bare cache — and must agree
  // with what finalize, preflight and the merger use. Inheriting `process.cwd()`
  // made that agreement a coincidence of how the host was launched (#34);
  // splitting `cwd` into a repo and a set of paths is what stops it becoming a
  // coincidence of which of two directories a call site happened to mean.
  readonly layout: RepoLayout;
  // The tracker the issue anchor quotes, named rather than inferred from a
  // directory's git remotes (#34). Distinct from `layout` on purpose: the
  // cache's `origin` is copied from the operator's checkout and is not the
  // configured repository until preflight has confirmed it is.
  readonly repo: RepoRef;
  readonly sourceBranch: string;
  // The declared credential record (`config.env`), forwarded to each sandbox.
  readonly env: Record<string, string>;
  readonly implementerModelId: string;
  readonly reviewerModelId: string;
  readonly reviewerFollowupModelId: string;
  // Which CLI each role runs (#72). Paired with the model id above rather than
  // folded into it: the two are independent choices, and every provider takes
  // whatever id it is handed. `agent-providers.ts` owns the set and the
  // credential each member needs.
  readonly implementerAgent: AgentProviderName;
  readonly reviewerAgent: AgentProviderName;
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
  // Where each sandbox sibling's followed log is written on the host (#44 D4),
  // one subdirectory per issue. The run's cycle log directory, so the files are
  // an offline artefact beside the attempt transcripts rather than a second
  // tree nobody remembers to look in. Absent, the sandbox stack still runs and
  // the logs go under the state directory's `logs/`.
  readonly sandboxLogBaseDir?: string;
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
  let sandboxStack: SandboxStack | null = null;
  let stack: Stack | null = null;
  let sandboxStatuses: readonly SandboxContainerStatus[] = [];
  const accumulated: { sha: string }[] = [];

  try {
    // Seed the issue branch off origin — never the host's local refs, so the
    // sandbox cannot inherit cwd's in-progress state. Idempotent. Off
    // `origin/<sourceBranch>` for an ordinary issue, off the CHUNK TIP for a
    // member chained behind one that has already landed (#61); which of the two
    // is git-ops.ts's decision, made from `issue.chunk` and what origin
    // actually carries.
    //
    // The return value is the whole reason this is one call and not two: it is
    // the ref the branch was really cut from, and every range the prompts below
    // render is anchored at it. Re-deriving `origin/<sourceBranch>` in the
    // prompt layer would hand a chunk member its ancestors' entire chunk as
    // "the work done so far" (#40's failure, re-entered from the other side).
    const base: IssueBranchBase = await ensureIssueBranch(
      config.layout.repoDir,
      issue.branch,
      config.sourceBranch,
      issue.chunk ?? null,
    );
    // Logged for a chunk member either way. The second line is now true by
    // construction rather than by assumption — `ensureIssueBranch` gives the
    // source branch to a chunk member only when that member IS the root, and
    // throws otherwise — so what the log records is which of the two seeds a
    // member got, not a guess about why.
    if (issue.chunk && opts.onOrchestratorLog) {
      await opts.onOrchestratorLog(
        base.chunkBranch
          ? `issue=${issue.id} seeded from chunk tip ${base.ref} (${base.chunkBranch})`
          : `issue=${issue.id} roots chunk ${issue.chunk.branch} and seeded from ` +
            `${base.ref} — origin carries no such chunk branch yet, which is where ` +
            "the merge phase will create it",
      );
    }

    // Worktree first (fast git ops), then container bringups in parallel: the
    // stack's mounts resolve against this worktree and must see its files on
    // disk at container start (#20).
    const worktreePath = await agentSandbox.prepareWorktree({
      branch: issue.branch,
      // Explicit, not `process.cwd()` (#34), and one object rather than two
      // paths that could disagree (#38). What this returns has to be exactly
      // what `worktreePathFor(layout.worktreesDir, …)` computes for finalize and
      // preflight, in a worktree registered in exactly the repo they run their
      // git in.
      layout: config.layout,
      hooks: opts.hooks,
      copyToWorktree: [...opts.copyToWorktree],
    });

    // The sandbox's siblings (#44). Everything about them is derived from the
    // `inSandbox` subset, which is empty for every consumer that declares none
    // — and then the log mount is absent, no sibling is created and the prompt
    // slot renders to nothing.
    const sbxContainers = sandboxContainers(config.gateStack);
    const sandboxLogDir = join(
      opts.sandboxLogBaseDir ?? config.layout.logsDir,
      `issue-${issue.id}`,
      "sandbox-logs",
    );
    // Before the sandbox container, not after: the directory is a bind-mount
    // SOURCE and podman reads it at container start, so a missing one is a
    // bringup failure rather than an empty mount.
    if (sbxContainers.length > 0) await prepareSandboxLogDir(sandboxLogDir);
    const holder: { stack: SandboxStack | null } = { stack: null };

    const [sandboxResult, stackResult] = await Promise.allSettled([
      (async () => {
        // The sandbox's own image is a function of the branch too (#46), and
        // the worktree above is what makes that answerable here: it is on disk
        // before this line, which is all the fingerprint needs. Resolved once
        // per sandbox — the attempts accumulate in this container, so there is
        // no later point that could re-resolve without discarding them — and
        // falling back to the declared tag if the build fails, because this is
        // the container the fix would be written in. See resolveSandboxImage.
        const imageName = await resolveSandboxImage({
          declaredTag: config.sandboxImage,
          worktreePath,
          branchImages,
          // What a failed build costs the operator turns on this, so it is
          // answered from the spec rather than assumed: only a gate container
          // running the same tag makes the failure show up a second time, as a
          // red against the branch.
          gateRunsSameImage: config.gateStack.containers.some(
            (c) => c.image === config.sandboxImage,
          ),
          onFallback: async (detail) => {
            const line = `issue=${issue.id} sandbox-image fallback — ${detail}`;
            console.error(`  ${line}`);
            if (opts.onOrchestratorLog) await opts.onOrchestratorLog(line);
          },
        });
        return agentSandbox.createSandbox({
          branch: issue.branch,
          layout: config.layout,
          // Named explicitly rather than left to defaultImageName(repoDir): the
          // implicit coupling between the sandbox image and the host's repo
          // DIRECTORY NAME broke silently on a rename (#24 D7). The tag itself
          // is the one resolved above, not `config.sandboxImage` (#46).
          sandbox: podman({
            imageName,
            namePrefix: scopedResourcePrefix(config.scope),
          }),
          hooks: opts.hooks,
          env: config.env,
          preparedWorktreePath: worktreePath,
          ...(sbxContainers.length > 0
            ? {
                extraMounts: [
                  {
                    hostPath: sandboxLogDir,
                    sandboxPath: SANDBOX_LOG_MOUNT,
                    readonly: true,
                  },
                ],
                // The siblings attach to the agent container, so they cannot be
                // started before it — but they must be up before the
                // `onSandboxReady` hooks, which is exactly where a consumer runs
                // the migration that wants the database (#44 D6). Inside
                // `createSandbox` rather than after it, so the container is torn
                // down if an `issue`-lifecycle sibling refuses to start, and so
                // this bringup still overlaps the gate stack's.
                //
                // A holder rather than a closed-over `let`: an assignment inside
                // a callback is invisible to TypeScript's narrowing, so the
                // binding would read as `null` forever at every later use.
                beforeSandboxReady: async (containerName: string) => {
                  holder.stack = await startSandboxStack({
                    issueId: issue.id,
                    scope: config.scope,
                    spec: config.gateStack,
                    worktreePath,
                    anchorContainerName: containerName,
                    logDir: sandboxLogDir,
                  });
                },
              }
            : {}),
        });
      })(),
      startStack({
        stackId: issue.id,
        scope: config.scope,
        spec: config.gateStack,
        worktreePath,
        // A thunk, not a value: the stack calls it before every gate run, and
        // the answer changes as the agent commits (#37). It hands back the
        // tags it runs, so the sandbox's entry is not resolved here (#46).
        ...(branchImages
          ? { images: (only: ReadonlySet<string>) => branchImages.resolve(worktreePath, only) }
          : {}),
      }),
    ]);
    // Read out BEFORE the throw below, not after it. The callback runs inside
    // `createSandbox`, so a failure anywhere after it — a sandbox-ready hook, a
    // later sibling — rejects that promise with a stack already created, and
    // reading the holder only on the success path would leave those containers
    // to `createSandbox`'s own `--depend` teardown alone and their log
    // followers running with nothing left to follow.
    //
    // What the stack itself throwing means: an `issue`-lifecycle sibling that
    // would not start is infrastructure → HARD-ERROR → a fresh sandbox, the
    // same treatment the gate stack's failure gets. A failed `attempt` one
    // never throws at all — the sandbox comes up degraded and the agent is told
    // in its prompt (D3).
    sandboxStack = holder.stack;
    sandboxStatuses = sandboxStack?.statuses ?? [];

    if (sandboxResult.status === "fulfilled") sandbox = sandboxResult.value;
    if (stackResult.status === "fulfilled") stack = stackResult.value;
    if (sandbox === null || stack === null) {
      throw sandboxResult.status === "rejected"
        ? sandboxResult.reason
        : (stackResult as PromiseRejectedResult).reason;
    }

    // startStack already registered stack.stop with the cleanup registry before
    // it created any podman resource, so no re-registration is needed here.
    const gateStack: Stack = stack;

    // No probe tree here on purpose (#34): `buildPrompt` derives it from
    // `inputs.worktreePath`, so this site cannot hand the anchor the wrong
    // tree. It used to, and nothing could see it — every candidate is a
    // string, so the mistake type-checks and the prompt-layer tests, which
    // pass their own tree, stay green.
    const anchorOpts = {
      repo: config.repo,
      repoDir: config.layout.repoDir,
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
        base,
        gateStack,
        worktreePath,
        accumulated,
        sandboxStatuses,
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
    // Then the sandbox's own siblings, and BEFORE `sandbox.close()` (#44). They
    // are attached to the agent container's network namespace, and podman
    // refuses to remove a container others depend on — so the reverse order
    // does not merely leak the siblings, it fails to remove the anchor too.
    // (`close()` passes `--depend` as a backstop for the paths this ordering
    // cannot cover, but the ordering is what makes the ordinary path clean.)
    // They also write into the worktree, so the same argument that puts the
    // gate stack ahead of the worktree removal applies to them.
    if (sandboxStack) {
      try {
        await sandboxStack.stop();
      } catch (err) {
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
  // What `ensureIssueBranch` seeded the branch from, threaded to both prompt
  // builders so the implementer's diff and the reviewer's changeset are the
  // same range (#61).
  readonly base: IssueBranchBase;
  readonly gateStack: Stack;
  // The issue worktree. Same tree the sandbox edits, the stack mounts and the
  // clean-assert reads — one tree, which is the whole point of D1.
  readonly worktreePath: string;
  readonly accumulated: { sha: string }[];
  // What came up beside the agent, for the implementer's prompt slot (#44 D8).
  // Empty when the consumer declares no `inSandbox` container.
  readonly sandboxStatuses: readonly SandboxContainerStatus[];
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
      base: ctx.base,
      ...(action.extraReprompt !== null ? { extraReprompt: action.extraReprompt } : {}),
      ...(action.latestReviewerProse !== null
        ? { latestReviewerProse: action.latestReviewerProse }
        : {}),
      sandboxStack: ctx.sandboxStatuses,
    },
    anchorOpts,
  );

  const run = await sandbox.run({
    name: `implementer-${issue.id}-attempt-${action.attempt}`,
    maxIterations: 1,
    agent: buildAgentProvider(config.implementerAgent, config.implementerModelId),
    prompt,
  });
  if (opts.attemptLogger) {
    await opts.attemptLogger.writeAttempt(issue.id, action.attempt, run.stdout);
  }
  accumulated.push(...run.commits);

  let signal = parsePromise(run.stdout, {
    commitsAccumulated: accumulated.length,
  });

  // The promise nudge: output with NO tag at all gets one same-conversation
  // follow-up before it is allowed to cost an attempt. The observed failure is
  // a finished agent forgetting the tag at the end of a long session, and the
  // full-attempt answer to that is disproportionate — a fresh conversation
  // that has to re-orient from the diff, ~minutes and an attempt slot for a
  // two-second omission. `--continue` asks the SAME agent, so the tag stays
  // the agent's own claim: nothing here infers COMPLETE from a clean tree,
  // and a premature claim is gated exactly like any other (the orchestrator
  // gates between attempts; agents never decide "green").
  //
  // Guarded on `missingTag`, not on NO-SIGNAL: a tag that failed its parse
  // guard (COMPLETE with zero commits, an escalation missing its block) means
  // the agent remembered the contract and got the substance wrong — the
  // guard's specific re-prompt on a fresh attempt is the right correction, and
  // a nudge would invite it to restate the same broken claim.
  //
  // One nudge, inline, never a loop. The reply is parsed over the COMBINED
  // output so a bare `NEEDS-INFO` answer pairs with a `<questions>` block from
  // the original message (last-wins semantics already handle concatenation),
  // and the parse guards keep their authority over the result — a nudged
  // zero-commit COMPLETE still downgrades. If the nudge run itself throws,
  // that propagates like any other sandbox failure (HARD-ERROR, fresh
  // sandbox): a container that cannot run a one-line follow-up cannot run the
  // next attempt either, and swallowing it would hide the infra fault.
  if (signal.kind === "NO-SIGNAL" && signal.missingTag) {
    const nudge = await sandbox.run({
      name: `implementer-${issue.id}-attempt-${action.attempt}-nudge`,
      maxIterations: 1,
      agent: buildAgentProvider(config.implementerAgent, config.implementerModelId, {
        continueSession: true,
      }),
      prompt: PROMISE_NUDGE_TPL,
      // Any of the three tags ends the wait, not just COMPLETE.
      completionSignal: "</promise>",
    });
    accumulated.push(...nudge.commits);
    const combined = `${run.stdout}\n${nudge.stdout}`;
    signal = parsePromise(combined, {
      commitsAccumulated: accumulated.length,
    });
    if (opts.attemptLogger) {
      await opts.attemptLogger.writeAttempt(
        issue.id,
        action.attempt,
        `${run.stdout}\n\n--- promise nudge ---\n\n${nudge.stdout}`,
      );
    }
    if (opts.onOrchestratorLog) {
      await opts.onOrchestratorLog(
        `issue=${issue.id} attempt=${action.attempt} promise-nudge signal=${signal.kind}`,
      );
    }
  }
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

  const reviewerPromptInputs = {
    issue,
    repo: config.repo,
    repoDir: config.layout.repoDir,
    worktreePath: sandbox.worktreePath,
    sourceBranch: config.sourceBranch,
    base: ctx.base,
    codingStandardsPath: config.codingStandardsPath,
    claudeMdPath: config.claudeMdPath,
    contextMdPath: config.contextMdPath,
  };
  const reviewerPrompts = await buildReviewerPrompts(reviewerPromptInputs);
  const runPass = async (
    pass: "correctness" | "followup",
    prompt: string,
    modelId: string,
  ) => runReviewerInvocations(
    async (invocation) => {
      // The retry is a fresh agent run in the SAME sandbox. The sandbox is not
      // what failed — in the observed case the implementer was working in it
      // concurrently — and rebuilding it would restart the whole issue from
      // attempt 1 through the HARD-ERROR path, discarding a green gate to
      // re-run a reviewer.
      try {
        const reviewerRun = await sandbox.run({
          name:
            `reviewer-${issue.id}-round-${action.reviewRound}-${pass}` +
            (invocation > 1 ? `-invocation-${invocation}` : ""),
          maxIterations: 1,
          agent: buildAgentProvider(config.reviewerAgent, modelId, {
            // Only the first follow-up invocation resumes correctness. Any
            // rerun is cold: a crashed follow-up may itself now be "last".
            continueSession: continueReviewerSession(pass, invocation),
          }),
          prompt,
        });
        return { output: reviewerRun.stdout, error: null };
      } catch (err) {
        // The bytes the agent had emitted before it failed ride out on the
        // error (#41, agent-sandbox F9). Without them a reviewer that emitted
        // a verdict and then died is indistinguishable from one that emitted
        // nothing, and only the second is a harness fault.
        return {
          output: agentPartialOutput(err),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    {
      onRetry: async (invocation, detail) => {
        const line =
          `issue=${issue.id} attempt=${action.attempt} reviewer round=${action.reviewRound} ` +
          `pass=${pass} invocation=${invocation}/${REVIEWER_MAX_INVOCATIONS} no-review — ` +
          `${pass === "followup" ? "retrying cold" : "retrying"} (${detail.split("\n")[0]})`;
        console.error(`  ${line}`);
        if (opts.onOrchestratorLog) await opts.onOrchestratorLog(line);
      },
    },
  );

  const correctness = await runPass(
    "correctness",
    reviewerPrompts.correctness,
    config.reviewerModelId,
  );

  const transcripts = [`=== correctness pass ===\n${correctness.transcript}`];
  // Every invocation's output, not just the reviewing one: the observed failure
  // left a 73-byte log for a 15-minute run, and this file is the only offline
  // artefact of what the reviewer did or did not say.
  const writeTranscript = async (): Promise<void> => {
    if (opts.attemptLogger) {
      await opts.attemptLogger.writeAttemptReviewer(
        issue.id,
        action.attempt,
        transcripts.join("\n\n"),
      );
    }
  };

  const logHarnessFailure = async (
    pass: "correctness" | "followup",
    outcome: Extract<Awaited<ReturnType<typeof runPass>>, { kind: "harness-failed" }>,
    decision: Extract<ReturnType<typeof decideReviewRound>, { kind: "finished" }>,
  ): Promise<void> => {
    await writeTranscript();
    const line =
      `issue=${issue.id} attempt=${action.attempt} reviewer round=${action.reviewRound} ` +
      `pass=${pass} harness-failed invocations=${outcome.invocations} ` +
      `correctness=${decision.correctness} followup=${decision.followup} (round not consumed)`;
    console.error(`  ${line}`);
    if (opts.onOrchestratorLog) await opts.onOrchestratorLog(line);
  };

  const afterCorrectness = decideReviewRound(correctness);
  if (afterCorrectness.kind === "finished") {
    if (correctness.kind === "harness-failed") {
      await logHarnessFailure("correctness", correctness, afterCorrectness);
      return afterCorrectness.event;
    }
    await writeTranscript();
    if (opts.onOrchestratorLog) {
      await opts.onOrchestratorLog(
        `issue=${issue.id} attempt=${action.attempt} reviewer round=${action.reviewRound} ` +
          `correctness=${afterCorrectness.correctness} followup=${afterCorrectness.followup}`,
      );
    }
    return afterCorrectness.event;
  }

  const followup = await runPass(
    "followup",
    reviewerPrompts.followup,
    config.reviewerFollowupModelId,
  );
  transcripts.push(`=== follow-up pass ===\n${followup.transcript}`);

  const decision = decideReviewRound(correctness, followup);
  if (followup.kind === "harness-failed") {
    await logHarnessFailure("followup", followup, decision);
    return decision.event;
  }
  await writeTranscript();
  if (opts.onOrchestratorLog) {
    await opts.onOrchestratorLog(
      `issue=${issue.id} attempt=${action.attempt} reviewer round=${action.reviewRound} ` +
        `correctness=${decision.correctness} followup=${decision.followup}`,
    );
  }
  return decision.event;
}
