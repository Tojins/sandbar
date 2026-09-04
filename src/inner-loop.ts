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
// substituting prose. The implementer prompt also receives the configured
// coding-standards path here; prompt.ts probes it in the issue worktree so a
// branch can introduce the standards it is expected to follow (#78).
// Successful review rounds accumulate here beside the commits they judged and
// are handed to both cold reviewer prompts on later rounds (#88). Harness
// failures add no entry, and a fresh HARD-ERROR cycle resets the history.
// That history also switches the follow-up from its one whole-branch listing
// to a review anchored at the newest earlier follow-up head; the round record
// exposes that list/verify mode without storing another piece of state (#107).
// Each implementer invocation publishes its private clone's issue ref to the
// host cache on success (#98). After an invocation failure the same publish is
// recovery-only: its failure is logged and may not replace the provider error.
// Reviewer invocations instead snapshot the tip and status; any mutation parks
// the issue and preserves the clone rather than running another reviewer.
// A catch may only classify one named expected condition checked explicitly,
// clean up on failure while preserving the original error, or report a failed
// best-effort teardown whose result is unrelated to the issue verdict (#83).

import { join } from "node:path";

import {
  type AgentProviderName,
  buildAgentProvider,
} from "./agent-providers.js";
import * as agentSandbox from "./agent-sandbox.js";
import { agentPartialOutput, agentPartialUsage, podman } from "./agent-sandbox.js";
import type { Sandbox, SandboxHooks } from "./agent-sandbox.js";
import { formatUsageFields, sumAgentUsage } from "./agent-usage.js";
import type { AgentUsage } from "./agent-usage.js";

import type { ChunkTarget } from "./chunks.js";
import type { ResolvedGateStack } from "./config.js";
import {
  type AgentImages,
  type BranchImages,
  resolveSandboxImage,
} from "./ensure-images.js";
import { SandbarError } from "./errors.js";
import { formatGateFields, summarizeGateFailure } from "./gate.js";
import { ContainerBringupError, type Stack, startStack } from "./gate-stack.js";
import {
  type HeadMismatch,
  type IssueBranchBase,
  branchTip,
  describeIssueBranchOriginSync,
  dirtyWorktreePaths,
  ensureIssueBranch,
  headMismatch,
  symbolicHeadRef,
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
import { PROMISE_COMPLETION_SIGNALS, parsePromise } from "./promise-parser.js";
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
  type CompletedReviewerOutcome,
  type FinishedReviewRoundDecision,
  type ReviewerOutcome,
  type ReviewerPass,
} from "./reviewer-run.js";
import type { RepoLayout } from "./repo-cache.js";
import type { RepoRef } from "./repo-ref.js";
import { durationField, startTimer } from "./timing.js";
import {
  type ProjectAnchorOptions,
  type PriorReviewRound,
  buildPrompt,
  buildReviewerPrompts,
  followupReviewContext,
} from "./prompt.js";

export const FAILURE_TAIL_LINES = 200;

// The runner-owned projection from pass outcomes to prompt history (#88).
// A harness failure produced no review, so the whole round contributes no
// entry; a correctness rejection has no follow-up pass by construction.
// Completed outcomes only: a detected reviewer write (#98) aborts the round
// before any history could be recorded, so an abort is not a case this
// projection answers for — the parameter type says so rather than the body
// treating "not harness-failed" as "reviewed".
export function priorReviewRound(
  reviewRound: number,
  head: string,
  correctness: CompletedReviewerOutcome,
  followup: CompletedReviewerOutcome | undefined,
): PriorReviewRound | null {
  if (correctness.kind === "harness-failed") return null;
  if (correctness.verdict.verdict === "CHANGES-REQUESTED") {
    return { round: reviewRound, head, correctness: correctness.verdict };
  }
  if (followup?.kind !== "reviewed") return null;
  return {
    round: reviewRound,
    head,
    correctness: correctness.verdict,
    followup: followup.verdict,
  };
}

// One spelling for the reviewer-round record consumed by operators and later
// evidence tooling (#88). Keep the reviewed HEAD in both completed and
// harness-failed records so every recorded judgment is anchored to a commit.
export function reviewRoundLine(args: {
  readonly issueId: string;
  readonly attempt: number;
  readonly reviewRound: number;
  readonly head: string;
  readonly failed: {
    readonly pass: ReviewerPass;
    readonly invocations: number;
  } | null;
  readonly correctness: FinishedReviewRoundDecision["correctness"];
  readonly followup: FinishedReviewRoundDecision["followup"];
  readonly followupMode?: "list" | "verify";
  readonly durationField: string;
}): string {
  return (
    `issue=${args.issueId} attempt=${args.attempt} reviewer round=${args.reviewRound} head=${args.head} ` +
    (args.failed
      ? `pass=${args.failed.pass} harness-failed invocations=${args.failed.invocations} `
      : "") +
    `correctness=${args.correctness} followup=${args.followup}` +
    (args.followupMode ? ` mode=${args.followupMode}` : "") + " " +
    args.durationField +
    (args.failed ? " (round not consumed)" : "")
  );
}

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
      readonly cause?: "reviewer-wrote";
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
  readonly agentImages: AgentImages;
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
    if (decision.kind === "surface") {
      return toTerminal(outcome);
    }
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
        ...(verdict.cause === undefined ? {} : { cause: verdict.cause }),
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
  const priorReviewRounds: PriorReviewRound[] = [];
  let preparedWorktreePath: string | null = null;

  // Everything from here to a standing sandbox + gate stack is SETUP (#82), and
  // until it was measured it was the largest block of a cycle with nothing
  // inside it: six minutes and forty-one seconds between `plan:` and the first
  // `gate-1` line, covering the branch seed, the worktree (with the host's
  // `onWorktreeReady` hook), two container bringups, the implementer and the
  // gate, reported as one gap. Six of #77's ideas bet on the setup half of that
  // blob against an ESTIMATE of "under 2 min"; this is the number they need.
  const setupTimer = startTimer();
  let worktreeMs = 0;

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
    // What origin's copy of the branch had to say (#112): a fast-forward, a
    // resume from origin, unpushed work kept, or an origin that could not be
    // asked. An outcome, so it is in the log (#70); nothing for the common
    // in-sync and fresh-seed cases.
    const originLine =
      base.originSync === undefined
        ? null
        : describeIssueBranchOriginSync(issue.branch, base.originSync);
    if (originLine !== null && opts.onOrchestratorLog) {
      await opts.onOrchestratorLog(`issue=${issue.id} ${originLine}`);
    }
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
    const worktreeTimer = startTimer();
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
    preparedWorktreePath = worktreePath;
    worktreeMs = worktreeTimer();

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

    // Two timers, not one: the sandbox and the gate stack come up in PARALLEL,
    // so a single number for the pair would say how long the slower one took
    // and nothing about which it was — which is exactly the question §3.C's
    // warm-pool ideas turn on.
    let sandboxMs: number | null = null;
    let stackMs: number | null = null;
    // `.finally` rather than a `try`/`finally` around each arm's body: an
    // `async` function's `finally` runs at the RETURN, before the implicit
    // await of the promise it returns, so wrapping `return createSandbox(…)`
    // that way would stop the clock the moment the call was made. On the
    // promise it stops when the promise settles, which is what "how long did
    // the bringup take" means.
    const stamp = <T,>(pr: Promise<T>, set: (ms: number) => void): Promise<T> => {
      const t = startTimer();
      return pr.finally(() => set(t()));
    };
    const [sandboxResult, stackResult] = await Promise.allSettled([
      stamp((async () => {
        // The sandbox's own image is a function of the branch too (#46), and
        // the worktree above is what makes that answerable here: it is on disk
        // before this line, which is all the fingerprint needs. Resolved once
        // per sandbox — the attempts accumulate in this container, so there is
        // no later point that could re-resolve without discarding them — and
        // falling back to the declared tag if the build fails, because this is
        // the container the fix would be written in. See resolveSandboxImage.
        const imageName = await resolveSandboxImage({
          declaredTag: config.sandboxImage,
          agentImages: config.agentImages,
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
      })(), (ms) => {
        sandboxMs = ms;
      }),
      stamp(startStack({
        stackId: issue.id,
        scope: config.scope,
        spec: config.gateStack,
        worktreePath,
        hideWorktreeGit: true,
        // A thunk, not a value: the stack calls it before every gate run, and
        // the answer changes as the agent commits (#37). It hands back the
        // tags it runs, so the sandbox's entry is not resolved here (#46).
        ...(branchImages
          ? { images: (only: ReadonlySet<string>) => branchImages.resolve(worktreePath, only) }
          : {}),
      }), (ms) => {
        stackMs = ms;
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

    if (opts.onOrchestratorLog) {
      await opts.onOrchestratorLog(
        `issue=${issue.id} setup ${durationField(setupTimer())} ` +
          `worktreeMs=${worktreeMs}` +
          (sandboxMs === null ? "" : ` sandboxMs=${sandboxMs}`) +
          (stackMs === null ? "" : ` stackMs=${stackMs}`),
      );
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
        priorReviewRounds,
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
    // with a fresh sandbox. Whatever the attempt left in the clone — commits
    // the publish never reached, a HEAD off the branch — is not this
    // terminal's to classify: `sandbox.close()` below reclaims the clone
    // through `reclaimIssueClone`, which publishes before it deletes and keeps
    // the clone when it cannot (#98).
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
      } catch (err) {
        console.error("Failed to close agent sandbox:", err);
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
  // Successful review rounds in this sandbox cycle (#88), beside the commits
  // whose heads they judged. A fresh HARD-ERROR cycle recreates both arrays.
  readonly priorReviewRounds: PriorReviewRound[];
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
      codingStandardsPath: config.codingStandardsPath,
      ...(action.extraReprompt !== null ? { extraReprompt: action.extraReprompt } : {}),
      ...(action.latestReviewerProse !== null
        ? { latestReviewerProse: action.latestReviewerProse }
        : {}),
      sandboxStack: ctx.sandboxStatuses,
    },
    anchorOpts,
  );

  // Covers the nudge below too, when one runs: the whole cost of the attempt's
  // agent leg, which is what every #77 idea trading implementer minutes for
  // reviewer rounds is spending (#82).
  const implementerTimer = startTimer();
  const runAgent = (options: Parameters<Sandbox["run"]>[0]) =>
    runSandboxAndPublish(sandbox, options, issue.id);
  const run = await runAgent({
    name: `implementer-${issue.id}-attempt-${action.attempt}`,
    agent: buildAgentProvider(config.implementerAgent, config.implementerModelId),
    prompt,
    completionSignal: PROMISE_COMPLETION_SIGNALS,
  });
  if (opts.attemptLogger) {
    await opts.attemptLogger.writeAttempt(issue.id, action.attempt, run.stdout);
  }
  accumulated.push(...run.commits);

  let signal = parsePromise(run.stdout, {
    commitsAccumulated: accumulated.length,
  });
  let attemptUsage = run.usage;
  let attemptToolCalls = run.toolCalls;

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
    const nudgeTimer = startTimer();
    const nudge = await runAgent({
      name: `implementer-${issue.id}-attempt-${action.attempt}-nudge`,
      agent: buildAgentProvider(config.implementerAgent, config.implementerModelId, {
        continueSession: true,
      }),
      prompt: PROMISE_NUDGE_TPL,
      // Any of the three tags ends the wait, not just COMPLETE.
      completionSignal: PROMISE_COMPLETION_SIGNALS,
    });
    accumulated.push(...nudge.commits);
    attemptUsage = sumAgentUsage(attemptUsage, nudge.usage);
    attemptToolCalls += nudge.toolCalls;
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
        `issue=${issue.id} attempt=${action.attempt} promise-nudge signal=${signal.kind} ` +
          `${durationField(nudgeTimer())}` +
          ` maxGapMs=${nudge.maxGapMs}`,
      );
    }
  }
  // Stopped BEFORE the two git reads below: they are the state machine's
  // inputs, not the agent's cost, and folding them in would inflate every
  // implementer number by work the agent never did.
  const implementerMs = implementerTimer();

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
  if (opts.onOrchestratorLog) {
    await opts.onOrchestratorLog(
      `issue=${issue.id} attempt=${action.attempt} implementer ` +
        `signal=${signal.kind} commits=${run.commits.length} ` +
        `provider=${config.implementerAgent} model=${config.implementerModelId} ` +
        `${durationField(implementerMs)}` +
        formatUsageFields(attemptUsage, attemptToolCalls) +
        // Absent when parsed speech carried none of the three promise tokens —
        // for example, an idle kill or a plain process exit. Omitted rather
        // than zeroed (#82).
        (run.signalMs === undefined ? "" : ` signalMs=${run.signalMs}`) +
        ` maxGapMs=${run.maxGapMs}`,
    );
  }
  return { kind: "implementer-result", signal, dirtyPaths, offBranch };
}

export async function runSandboxAndPublish(
  sandbox: Sandbox,
  options: Parameters<Sandbox["run"]>[0],
  issueId: string,
): ReturnType<Sandbox["run"]> {
  let result: Awaited<ReturnType<Sandbox["run"]>>;
  try {
    result = await sandbox.run(options);
  } catch (agentError) {
    // A failed invocation may still have committed. Try to publish it, but a
    // second failure must not replace the agent/provider error that selects
    // and explains the HARD-ERROR path (#41, #67, #98). The commits are not
    // lost either way: close() retries the publish before it removes the
    // clone, and keeps the clone if that fails too.
    try {
      await sandbox.syncBranchToCache();
    } catch (publishError) {
      console.error(
        `Could not publish issue=${issueId} after implementer failure (continuing with original error):`,
        publishError,
      );
    }
    throw agentError;
  }
  // A publish that fails is infrastructure, not an answer: the merge phase
  // reads the cache's copy of the branch, so continuing past it would gate and
  // review one tree and merge another. HARD-ERROR retries in a fresh sandbox,
  // whose reuse path publishes again from the clone reclaim kept.
  await sandbox.syncBranchToCache();
  return result;
}

async function runGate1(
  action: Extract<LoopAction, { kind: "run-gate-1" }>,
  ctx: ExecuteActionCtx,
): Promise<LoopEvent> {
  const { issue, opts, gateStack } = ctx;
  const gate1 = await gateStack.runGate();
  if (opts.onOrchestratorLog) {
    // `formatGateFields` renders the three fields this line already carried, in
    // the same order, then the timings (#82) — so the prefix is byte-identical
    // and the new fields are appended.
    await opts.onOrchestratorLog(
      `issue=${issue.id} attempt=${action.attempt} gate-1 ${formatGateFields(gate1)}`,
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

export type ReviewerSnapshot = {
  readonly tip: string | null;
  readonly dirtyPaths: readonly string[];
  readonly headRef: string | null;
};

export function reviewerSnapshotChanged(
  before: ReviewerSnapshot,
  after: ReviewerSnapshot,
): boolean {
  return (
    before.tip !== after.tip ||
    JSON.stringify(before.dirtyPaths) !== JSON.stringify(after.dirtyPaths) ||
    before.headRef !== after.headRef
  );
}

export async function enforceReviewerSnapshot(
  sandbox: Pick<Sandbox, "preserveWorktree" | "syncBranchToCache">,
  before: ReviewerSnapshot,
  after: ReviewerSnapshot,
  transcript: string,
): Promise<Extract<LoopEvent, { kind: "reviewer-wrote" }> | null> {
  if (!reviewerSnapshotChanged(before, after)) return null;
  sandbox.preserveWorktree("the reviewer changed the repository; kept for human inspection");
  // Deleting the issue ref is itself a reviewer write. There is then no ref
  // to publish, but the preserved clone still contains the evidence.
  if (after.tip !== null) await sandbox.syncBranchToCache();
  const renderedTranscript = transcript.trim() || "(reviewer emitted no output)";
  return {
    kind: "reviewer-wrote",
    detail:
      `Reviewer changed git state. Branch tip before: ${before.tip}; ` +
      `after: ${after.tip}. HEAD before: ${before.headRef}; ` +
      `after: ${after.headRef}. Status after:\n` +
      (after.dirtyPaths.length > 0
        ? after.dirtyPaths.join("\n")
        : "(clean worktree)") +
      `\n\nReviewer transcript:\n${renderedTranscript}`,
  };
}

const passTranscript = (pass: ReviewerPass, transcript: string): string =>
  `=== ${pass === "followup" ? "follow-up" : pass} pass ===\n${transcript}`;

async function runReviewer(
  action: Extract<LoopAction, { kind: "run-reviewer" }>,
  ctx: ExecuteActionCtx,
): Promise<LoopEvent> {
  const { issue, sandbox, opts, config } = ctx;
  const head = ctx.accumulated.at(-1)?.sha;
  if (!head) {
    throw new SandbarError(
      `cannot review issue #${issue.id} round ${action.reviewRound}: no accumulated HEAD`,
    );
  }
  const snapshot = async (): Promise<ReviewerSnapshot> => {
    const [tip, dirtyPaths, headRef] = await Promise.all([
      branchTip(sandbox.worktreePath, issue.branch),
      dirtyWorktreePaths(sandbox.worktreePath),
      symbolicHeadRef(sandbox.worktreePath),
    ]);
    return { tip, dirtyPaths, headRef };
  };
  const detectWrite = async (
    before: ReviewerSnapshot,
    transcript: string,
  ): Promise<Extract<LoopEvent, { kind: "reviewer-wrote" }> | null> => {
    const after = await snapshot();
    return enforceReviewerSnapshot(sandbox, before, after, transcript);
  };

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
    priorRounds: ctx.priorReviewRounds,
  };
  // The whole round — both passes and every retried invocation inside them.
  // This is the unit every #77 §3.A idea removes, and at 10.2 minutes measured
  // end to end it is ~60% of an issue.
  const roundTimer = startTimer();
  const followupMode = followupReviewContext(ctx.priorReviewRounds).mode;
  const reviewerPrompts = await buildReviewerPrompts(reviewerPromptInputs);
  const runPass = async (
    pass: ReviewerPass,
    prompt: string,
    modelId: string,
  ): Promise<ReviewerOutcome> => runReviewerInvocations(
    async (invocation) => {
      const beforeInvocation = await snapshot();
      // The retry is a fresh agent run in the SAME sandbox. The sandbox is not
      // what failed — in the observed case the implementer was working in it
      // concurrently — and rebuilding it would restart the whole issue from
      // attempt 1 through the HARD-ERROR path, discarding a green gate to
      // re-run a reviewer.
      // One line per INVOCATION, not per round (#82): a round is up to two
      // sequential calls on two different models under one provider (#19), and
      // §3.B's pass-order, parallel-pass and per-round-model ideas all need the
      // two sets of minutes apart. `model=` and `provider=` are on the line for
      // the same reason — the number is meaningless without knowing which model
      // spent it, and both are per-call config a stats reader cannot recover.
      const passTimer = startTimer();
      // `signalMs` has no reviewer meaning: the reviewer names no completion
      // signal (#83), so the grace phase it measures is unreachable here.
      const logPass = async (
        maxGapMs: number | undefined,
        usage: AgentUsage | undefined,
        toolCalls: number | undefined,
      ): Promise<void> => {
        if (!opts.onOrchestratorLog) return;
        await opts.onOrchestratorLog(
          `issue=${issue.id} attempt=${action.attempt} reviewer ` +
            `round=${action.reviewRound} pass=${pass} invocation=${invocation} ` +
            `provider=${config.reviewerAgent} model=${modelId} ` +
            `${durationField(passTimer())}` +
            formatUsageFields(usage, toolCalls) +
            (maxGapMs === undefined ? "" : ` maxGapMs=${maxGapMs}`),
        );
      };
      try {
        const reviewerRun = await sandbox.run({
          name:
            `reviewer-${issue.id}-round-${action.reviewRound}-${pass}` +
            (invocation > 1 ? `-invocation-${invocation}` : ""),
          agent: buildAgentProvider(config.reviewerAgent, modelId, {
            // Only the first follow-up invocation resumes correctness. Any
            // rerun is cold: a crashed follow-up may itself now be "last".
            continueSession: continueReviewerSession(pass, invocation),
          }),
          prompt,
          // A reviewer owns no completion signal. Process exit is the honest
          // end of its single artefact; inherited role contracts are banned.
          completionSignal: [],
        });
        await logPass(
          reviewerRun.maxGapMs,
          reviewerRun.usage,
          reviewerRun.toolCalls,
        );
        const event = await detectWrite(beforeInvocation, reviewerRun.stdout);
        return event === null
          ? { kind: "run", run: { output: reviewerRun.stdout, error: null } }
          : { kind: "aborted", event, transcript: reviewerRun.stdout };
      } catch (err) {
        // A failed invocation is timed too: an invocation that burned the ten
        // minutes and died is the expensive case, and one that fell over in a
        // second is a different fault entirely.
        const partial = agentPartialUsage(err);
        await logPass(undefined, partial.usage, partial.toolCalls);
        const transcript = agentPartialOutput(err);
        const event = await detectWrite(beforeInvocation, transcript);
        if (event !== null) return { kind: "aborted", event, transcript };
        // The bytes the agent had emitted before it failed ride out on the
        // error (#41, agent-sandbox F9). Without them a reviewer that emitted
        // a verdict and then died is indistinguishable from one that emitted
        // nothing, and only the second is a harness fault.
        return {
          kind: "run",
          run: {
            output: transcript,
            error: err instanceof Error ? err.message : String(err),
          },
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

  const preserveReviewerWrite = async (
    aborted: Extract<ReviewerOutcome, { kind: "aborted" }>,
    pass: ReviewerPass,
    completedTranscripts: readonly string[],
  ): Promise<Extract<LoopEvent, { kind: "reviewer-wrote" }>> => {
    if (opts.attemptLogger) {
      await opts.attemptLogger.writeAttemptReviewer(
        issue.id,
        action.attempt,
        [
          ...completedTranscripts,
          passTranscript(pass, aborted.transcript),
        ].join("\n\n"),
      );
    }
    return aborted.event;
  };

  const correctness = await runPass(
    "correctness",
    reviewerPrompts.correctness,
    config.reviewerModelId,
  );
  if (correctness.kind === "aborted") {
    return preserveReviewerWrite(correctness, "correctness", []);
  }

  const transcripts = [passTranscript("correctness", correctness.transcript)];
  // Every invocation's output, not just the reviewing one: the observed failure
  // left a 73-byte log for a 15-minute run, and this file is the only offline
  // artefact of what the reviewer did or did not say.
  const afterCorrectness = decideReviewRound(correctness);
  let decision: FinishedReviewRoundDecision;
  // Completed only: the abort arm below returns, so nothing past it holds a
  // reviewer-write outcome, and `decideReviewRound`/`priorReviewRound` are
  // both spelled for completed outcomes.
  let followup: CompletedReviewerOutcome | undefined;
  let failed: { readonly pass: ReviewerPass; readonly invocations: number } | null =
    correctness.kind === "harness-failed"
      ? { pass: "correctness", invocations: correctness.invocations }
      : null;

  if (afterCorrectness.kind === "run-followup") {
    const followupOutcome = await runPass(
      "followup",
      reviewerPrompts.followup,
      config.reviewerFollowupModelId,
    );
    if (followupOutcome.kind === "aborted") {
      return preserveReviewerWrite(followupOutcome, "followup", transcripts);
    }
    followup = followupOutcome;
    transcripts.push(passTranscript("followup", followup.transcript));
    if (followup.kind === "harness-failed") {
      failed = { pass: "followup", invocations: followup.invocations };
    }
    decision = decideReviewRound(correctness, followup);
  } else {
    decision = afterCorrectness;
  }

  const historyEntry = priorReviewRound(
    action.reviewRound,
    head,
    correctness,
    followup,
  );
  if (historyEntry) ctx.priorReviewRounds.push(historyEntry);

  if (opts.attemptLogger) {
    await opts.attemptLogger.writeAttemptReviewer(
      issue.id,
      action.attempt,
      transcripts.join("\n\n"),
    );
  }
  const line = reviewRoundLine({
    issueId: issue.id,
    attempt: action.attempt,
    reviewRound: action.reviewRound,
    head,
    failed,
    correctness: decision.correctness,
    followup: decision.followup,
    followupMode: followup === undefined ? undefined : followupMode,
    durationField: durationField(roundTimer()),
  });
  if (failed) console.error(`  ${line}`);
  if (opts.onOrchestratorLog) {
    await opts.onOrchestratorLog(line);
  }
  return decision.event;
}
