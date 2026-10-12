// Inner-loop runner — I/O glue around the pure state machine
// (inner-loop-machine.ts). All branching decisions live in the SM; this file
// executes its actions, feeds results back as events, and translates the
// verdict to a Terminal. On HARD-ERROR, decideAfterTerminal may dispose the
// sandbox and restart from attempt 1 with a fresh one (up to
// HARD_ERROR_MAX_RETRIES times). Every retry is a `hard-error` event; if
// retries are exhausted, run.ts records the surfaced terminal's full reason.
//
// Setup ordering is load-bearing: the issue worktree comes FIRST, then agent
// sandbox + gate stack in parallel (#20 — mount sources are read at container
// start; #46 — the files a `rebuildOn` entry hashes must be on disk before
// `createSandbox`). Containers marked `inSandbox` (#44) come up INSIDE the
// sandbox entry via `beforeSandboxReady`: they attach to the agent
// container's netns, so it must exist first, and they must be up before a
// consumer's `onSandboxReady` hook runs.
// The step-running gate containers' declared mounts and env are attached to
// the agent sandbox too (#166). Config resolution has already flattened and
// validated them; this layer only roots relative sources in the issue worktree
// and preserves gate env as literal container values.
//
// The partition and UI-prototype decisions (#158/#126) are cold agent calls in
// the existing issue sandbox and spend no convergence budget. Partition runs
// once per admission and only at the seed; UI runs once per sandbox cycle, so
// a fresh HARD-ERROR asks it again. Before the quality fixer and before the
// correctness pass, that role's complete picture (rendered prompt plus
// seed-anchored net diff) is measured against the configured useful-context
// budget; a resumed branch gets the same enforcement at admission. A provider
// size refusal maps to the same partition terminal instead of entering
// HARD-ERROR replay. Two deliberate exceptions to "all branching lives in the
// SM" stay within one action each. The promise nudge in runImplementer gives
// an implementer that ends with no `<promise>` tag at all one `--continue`
// follow-up before the NO-SIGNAL reaches the SM — the SM never sees the nudge,
// only the re-parsed result. The full argument is at the call site.
//
// After a clean, on-branch COMPLETE the round is serial (#185): the quality
// FIXER, then gate-1 on the head it left, then — only on a green gate — the
// cold correctness reviewer on its own separately configured provider and
// model (#121). The fixer runs in this same writable sandbox, routed through
// `reviewerQuality*` and committing under a `<botName> (quality)` author the
// host sets for that invocation only. It emits no token: whatever it leaves,
// `settleQualityResidue` (git-ops.ts) discards uncommitted residue, puts HEAD
// back on the branch (with #127's repair where it applies), keeps every commit
// it made and records what was discarded; a failed invocation is the same
// "process exit" and never a harness failure. The fixer's commits since the
// implementer's last attempt are handed to the next implementer prompt, and
// the head it left anchors the next pass's "changed since" focus.
// A correctness rejection whose next implementer attempt creates no commit at
// that head is routed once per head to a cold adjudicator (#167). The judge
// sees that report without implementer speech or prior-round wording, is held
// to the same read-only snapshot contract, and either leaves its charged
// rejection upheld or rewrites history to OVERRULED and refunds it.
//
// The other deliberate runner-side exception is #127's off-branch repair.
// `headMismatch` has already made the mechanical ancestry decision; when the
// issue branch is an ancestor of HEAD, runImplementer advances the ref and
// reattaches HEAD, then must publish that new tip to the cache before it builds
// the event. The state machine receives the repaired state plus note metadata,
// while unsafe mismatches still take its existing correction route. This is the
// same class of glue-owned Git write as the successful implementer publish
// below, not a branching policy decision.
//
// What a FAILED reviewer run means is reviewer-run.ts's policy (#41); this
// file only adapts `sandbox.run`'s throw into the shape that policy
// classifies, which is why the try/catch below returns a value instead of
// substituting prose. The allowed first harness failure is a feed-only notice;
// the second remains the terminal that stops the loop (#172). Each role also
// receives only its configured prompt
// extension; prompt.ts probes path extensions in the issue worktree so a
// branch can introduce the instructions it is expected to follow (#78, #91).
// Successful correctness rounds accumulate here beside the commits they judged
// and are handed to the next correctness prompt (#88). Harness failures add no
// entry, and a fresh HARD-ERROR cycle resets the history and the fixer's
// ledger. An optional `<spec-gap>` declared by the correctness pass is
// accumulated beside that history but around the state machine, preserved
// across fresh cycles, and carried on every terminal for finalise to record
// (#108).
// Each implementer invocation publishes its private clone's issue ref to the
// host cache on success (#98), as does each settled quality pass. After an
// implementer invocation failure the same publish is recovery-only: its
// failure is logged and may not replace the provider error.
// Partition-check, UI-check, reviewer and adjudicator invocations snapshot tip
// and status; any mutation parks the issue and preserves the clone rather than
// trusting that call. The quality fixer is the one cold role exempt (#185).
// Invocation filenames use one run-owned, per-issue sequence across fresh
// HARD-ERROR cycles and later admissions: the state machine's attempt and
// UI-check counters restart at both boundaries, but an earlier invocation
// record must never be overwritten (#135). The cached IssueLogger owns that
// sequence beside the directory whose names it allocates, and every gate-1
// result — green as well as red — is filed from it as that attempt's
// `attempt-<n>-gate.log` (#153).
// Sandbox close defers clone reclamation silently to run.ts's next origin-lease
// barrier; this is distinct from the human-inspection preservation channel and
// therefore cannot overwrite or manufacture an operator-facing reason (#139).
// Reusing a dirty/off-branch clone and fast-forwarding a clean one are likewise
// feed-only notices; D1/#27 remain the later authority that can refuse it.
// Each duration-bearing agent event carries that invocation's peak-memory/OOM
// evidence, gate events retain it per step, and both stacks emit each sibling's
// final teardown record after their resources are removed (#141).
// A catch may only classify one named expected condition checked explicitly,
// clean up on failure while preserving the original error, or report a failed
// best-effort teardown whose result is unrelated to the issue verdict (#83).

import { join } from "node:path";

import {
  type AgentProviderName,
  buildAgentProvider,
} from "./agent-providers.js";
import * as agentSandbox from "./agent-sandbox.js";
import {
  AgentCredentialError,
  AgentError,
  AgentIdleTimeoutError,
  AgentInputTooLargeError,
  AgentQuotaError,
  agentPartialContainerResources,
  agentPartialDurationMs,
  agentPartialOutput,
  agentPartialUsage,
  podman,
  withPartialContainerResources,
  withPartialOutput,
} from "./agent-sandbox.js";
import type { RateLimitMeasurement } from "./agent-run-end.js";
import type { AgentInvocationRecord, Sandbox, SandboxHooks } from "./agent-sandbox.js";
import { maxContextDepth, sumAgentUsage } from "./agent-usage.js";
import type { AgentUsage } from "./agent-usage.js";

import type { ChunkTarget } from "./chunks.js";
import type { CodexAuthMount } from "./codex-auth.js";
import type {
  PromptExtension,
  PromptExtensions,
  ResolvedCopyToWorktreeEntry,
  ResolvedGateStack,
  SandboxGateAttachments,
} from "./config.js";
import {
  AgentToolsImageError,
  type AgentImages,
  resolveSandboxImage,
} from "./agent-tools.js";
import type { BranchImages } from "./ensure-images.js";
import { SandbarError } from "./errors.js";
import type { EventInput, QualityPassEvent, UsageFields } from "./events.js";
import { parsePartitionCheck } from "./partition-check-parser.js";
import { summarizeGateFailure } from "./gate.js";
import type { GateSemaphore } from "./gate-semaphore.js";
import {
  ContainerBringupError,
  resolveStackMountHostPath,
  type Stack,
  startStack,
} from "./gate-stack.js";
import {
  type HeadMismatch,
  type IssueBranchBase,
  branchTip,
  describeIssueBranchOriginSync,
  dirtyWorktreePaths,
  ensureIssueBranch,
  fastForwardOffBranchHead,
  headMismatch,
  settleQualityResidue,
  symbolicHeadRef,
} from "./git-ops.js";
import {
  HARD_ERROR_MAX_RETRIES,
  type ContextSlot,
  type LoopAction,
  type LoopEvent,
  type LoopState,
  type ReviewerResult,
  type Verdict,
  decideAfterTerminal,
  initialAction,
  initialState,
  step,
  visiblePhases,
} from "./inner-loop-machine.js";
import type { AgentInvocationSequence, AttemptLogger } from "./logs.js";
import { type RunScope, scopedResourcePrefix } from "./naming.js";
import { PROMISE_COMPLETION_SIGNALS, parsePromise } from "./promise-parser.js";
import { parseUiCheck } from "./ui-check-parser.js";
import {
  parseAdjudicationRuling,
  stripAdjudicationRulingTokens,
} from "./adjudication-parser.js";
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
  reviewerResult,
  runReviewerInvocations,
} from "./reviewer-run.js";
import type { RepoLayout } from "./repo-cache.js";
import type { RepoRef } from "./repo-ref.js";
import { startTimer } from "./timing.js";
import {
  containerResourcesOf,
  mergeContainerResources,
  type ContainerResources,
} from "./container-resources.js";
import {
  type ProjectAnchorOptions,
  type PriorReviewRound,
  type ReviewerPromptInputs,
  buildPrompt,
  buildAdjudicatorPrompt,
  buildCorrectnessPrompt,
  buildPartitionCheckPrompt,
  buildQualityPrompt,
  buildUiCheckPrompt,
  contextChars,
  measureNetDiffChars,
  branchIsAheadOfSeed,
} from "./prompt.js";

export const FAILURE_TAIL_LINES = 200;

function agentSandboxNotice(
  severity: "warning" | "error",
  message: string,
): EventInput {
  return severity === "warning"
    ? { kind: "notice", message }
    : { kind: "complaint", severity, message };
}

function requireImplementerAttemptEvidence(
  run: Pick<agentSandbox.SandboxRunResult, "silent" | "commits">,
  nudge: Pick<agentSandbox.SandboxRunResult, "silent" | "commits">,
): void {
  if (run.silent && nudge.silent && run.commits.length + nudge.commits.length === 0) {
    throw new AgentError(
      "Implementer produced no speech or commits across the initial run and promise nudge.",
    );
  }
}

function combinePromiseNudge(
  run: Pick<agentSandbox.SandboxRunResult, "stdout" | "commits">,
  nudge: Pick<agentSandbox.SandboxRunResult, "stdout" | "commits">,
): { readonly stdout: string; readonly commitCount: number } {
  return {
    stdout: `${run.stdout}\n${nudge.stdout}`,
    commitCount: run.commits.length + nudge.commits.length,
  };
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
  | {
      readonly type: "DONE";
      readonly commits: readonly { sha: string }[];
      readonly specGaps: readonly SpecGap[];
    }
  | {
      readonly type: "NEEDS-INFO";
      readonly questions: string;
      // #27 — where the agent's commits went, when it asked from off the branch.
      readonly strandedHead: HeadMismatch | null;
      readonly specGaps: readonly SpecGap[];
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
      readonly specGaps: readonly SpecGap[];
    }
  | {
      readonly type: "NEEDS-HUMAN";
      readonly cause:
        | "gate-red"
        | "no-signal-exhausted"
        | "uncommittable-worktree"
        | "off-branch-head"
        | "reviewer-harness-failed";
      readonly failureTrace: string;
      readonly latestReviewerProse: string | null;
      readonly budgetExhausted: Extract<
        Verdict,
        { readonly type: "NEEDS-HUMAN" }
      >["budgetExhausted"];
      readonly strandedHead: HeadMismatch | null;
      readonly specGaps: readonly SpecGap[];
    }
  | {
      readonly type: "NEEDS-HUMAN-REVIEW";
      readonly latestReviewerProse: string;
      readonly cause: "correctness-budget-exhausted";
      readonly roundsUsed: number;
      readonly commits: readonly { sha: string }[];
      readonly specGaps: readonly SpecGap[];
    }
  | {
      readonly type: "NEEDS-HUMAN-REVIEW";
      readonly latestReviewerProse: string;
      readonly cause:
        | "reviewer-wrote"
        | "adjudicator-wrote"
        | "ui-checker-wrote"
        | "partition-checker-wrote";
      readonly commits: readonly { sha: string }[];
      readonly specGaps: readonly SpecGap[];
    }
  | {
      readonly type: "NEEDS-PARTITION";
      readonly cause: "classifier" | "measured" | "provider-refused";
      readonly slot: ContextSlot;
      readonly size: number;
      readonly budget: number;
      readonly detail: string;
      readonly commits: readonly { sha: string }[];
      readonly specGaps: readonly SpecGap[];
    }
  | {
      readonly type: "HARD-ERROR";
      readonly reason: string;
      readonly commits: readonly { sha: string }[];
      readonly specGaps: readonly SpecGap[];
    }
  | {
      readonly type: "QUOTA";
      readonly provider: AgentProviderName;
      readonly window: string;
      readonly resetsAt?: number;
      readonly specGaps: readonly SpecGap[];
    }
  | {
      readonly type: "CREDENTIAL";
      readonly provider: "codex";
      readonly detail: string;
      readonly specGaps: readonly SpecGap[];
    };

export type SpecGap = {
  readonly round: number;
  readonly text: string;
};

export type ProviderClosure =
  | { readonly cause: "quota"; readonly measurement: RateLimitMeasurement }
  | { readonly cause: "credential"; readonly detail: string };

export type RunProviderState = {
  get(provider: AgentProviderName): ProviderClosure | undefined;
  closeQuota(provider: AgentProviderName, measurement: RateLimitMeasurement): void;
  closeCredential(detail: string): void;
};

export const recordProviderClosure = (
  state: RunProviderState | undefined,
  err: AgentQuotaError | AgentCredentialError,
): void => {
  if (err instanceof AgentQuotaError) state?.closeQuota(err.provider, err.measurement);
  else state?.closeCredential(err.detail);
};

export const createRunProviderState = (): RunProviderState => {
  const closed = new Map<AgentProviderName, ProviderClosure>();
  const close = (provider: AgentProviderName, closure: ProviderClosure): void => {
    const existing = closed.get(provider);
    if (existing?.cause === "credential") return;
    if (existing === undefined || closure.cause === "credential") {
      closed.set(provider, closure);
    }
  };
  return {
    get: (provider) => closed.get(provider),
    closeQuota: (provider, measurement) => close(provider, { cause: "quota", measurement }),
    closeCredential: (detail) => close("codex", { cause: "credential", detail }),
  };
};

export const assertProviderOpen = (
  providerState: RunProviderState | undefined,
  provider: AgentProviderName,
): void => {
  const closed = providerState?.get(provider);
  if (closed?.cause === "quota") throw new AgentQuotaError(provider, closed.measurement);
  if (closed?.cause === "credential") throw new AgentCredentialError(closed.detail);
};

// One invocation boundary owns both halves of run-scoped closure: an already
// closed provider is never called, and the first structural quota or permanent
// credential failure is recorded before it escapes (#109, #134).
export async function runWithProviderState<T>(
  providerState: RunProviderState | undefined,
  provider: AgentProviderName,
  invoke: () => Promise<T>,
): Promise<T> {
  assertProviderOpen(providerState, provider);
  try {
    return await invoke();
  } catch (err) {
    if (err instanceof AgentQuotaError || err instanceof AgentCredentialError)
      recordProviderClosure(providerState, err);
    throw err;
  }
}

export const quotaVerdict = (err: AgentQuotaError): Verdict => ({
  type: "QUOTA",
  provider: err.provider,
  window: err.measurement.window,
  ...(err.measurement.resetsAt === undefined ? {} : { resetsAt: err.measurement.resetsAt }),
});

export const credentialVerdict = (err: AgentCredentialError): Verdict => ({
  type: "CREDENTIAL",
  provider: err.provider,
  detail: err.detail,
});

class PartitionRequiredError extends Error {
  readonly verdict: Extract<Verdict, { readonly type: "NEEDS-PARTITION" }>;
  constructor(
    slot: ContextSlot,
    size: number,
    budget: number,
    detail: string,
    cause: Extract<Verdict, { readonly type: "NEEDS-PARTITION" }>["cause"] =
      "provider-refused",
  ) {
    super(detail);
    this.verdict = {
      type: "NEEDS-PARTITION",
      cause,
      slot,
      size,
      budget,
      detail,
    };
  }
}

const providerSizeRefusal = (
  err: unknown,
  slot: ContextSlot,
  size: number,
  budget: number,
): unknown => {
  if (err instanceof AgentInputTooLargeError) {
    return new PartitionRequiredError(
      slot,
      size,
      budget,
      err.detail,
    );
  }
  return err;
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
  readonly reviewerQualityModelId: string;
  readonly adjudicatorModelId: string;
  readonly uiCheckModelId: string;
  // Which CLI each role runs (#72). Paired with the model id above rather than
  // folded into it: the two are independent choices, and every provider takes
  // whatever id it is handed. `agent-providers.ts` owns the set and the
  // credential each member needs.
  readonly implementerAgent: AgentProviderName;
  readonly reviewerAgent: AgentProviderName;
  // The quality fixer's CLI (#121, #185). Resolution defaults it to
  // `reviewerAgent`, so this is a distinct provider only where the host asked
  // for one.
  readonly reviewerQualityAgent: AgentProviderName;
  readonly adjudicatorAgent: AgentProviderName;
  // The pre-attempt UI classifier (#126), defaulted during config resolution
  // to the implementer's provider and model but routed independently here.
  readonly uiCheckAgent: AgentProviderName;
  // Reasoning effort per call (#130), the third per-call knob beside the model
  // id and the CLI. Absent is a value — the CLI's default — and stays absent
  // on the log line.
  readonly implementerEffort?: string | undefined;
  readonly reviewerEffort?: string | undefined;
  readonly reviewerQualityEffort?: string | undefined;
  readonly adjudicatorEffort?: string | undefined;
  readonly uiCheckEffort?: string | undefined;
  readonly uiPrototypeCheck: boolean;
  readonly partitionCheck: boolean;
  readonly maxContextChars: number;
  readonly maxGateRounds: number;
  readonly maxReviewRounds: number;
  readonly sandboxImage: string;
  readonly agentImages: AgentImages;
  // One run-owned writable credential file shared by every Codex holder
  // (#134). Absent for runs that use only API credentials or only Claude.
  readonly codexAuthMount?: CodexAuthMount;
  // This run's podman resource scope (#28) — see naming.ts. Both the agent
  // sandbox container and the gate stack are named under it.
  readonly scope: RunScope;
  readonly gateStack: ResolvedGateStack;
  readonly sandboxGateAttachments: SandboxGateAttachments;
  readonly claudeMdPath: string;
  readonly contextMdPath?: string;
  readonly adrDir?: string;
  readonly promptExtensions?: PromptExtensions;
  // The identity the quality fixer's commits are authored under, as
  // `<botName> (quality) <botEmail>` (#185); the committer stays the sandbox's.
  readonly botName: string;
  readonly botEmail: string;
};

export type InnerLoopOptions = {
  readonly config: InnerLoopConfig;
  readonly hooks: SandboxHooks;
  readonly copyToWorktree: readonly ResolvedCopyToWorktreeEntry[];
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
  // Every launched invocation must have a durable record before its result is
  // classified (#135). The run owns this logger and always supplies it.
  readonly attemptLogger: AttemptLogger;
  // Mandatory at this run-owned boundary: dropping it would make a terminal,
  // phase, or measurement silently disappear from the sole run record.
  readonly onEvent: (event: EventInput) => Promise<void> | void;
  readonly providerState?: RunProviderState;
  // The one run-wide admission seam shared with the merger (#142).
  readonly gateSemaphore: GateSemaphore;
};

const hasSandboxGateAttachments = (
  attachments: SandboxGateAttachments,
): boolean =>
  attachments.mounts.length > 0 || Object.keys(attachments.env).length > 0;

type SandboxCycleOutcome = {
  readonly verdict: Verdict;
  readonly accumulatedCommits: readonly { sha: string }[];
  readonly specGaps: readonly SpecGap[];
};

function eventUsage(
  usage: AgentUsage | undefined,
  toolCalls: number | undefined,
  peakContext: number | undefined,
  quota?: RateLimitMeasurement,
  measuredContextChars?: number,
): UsageFields | undefined {
  const fields: UsageFields = {
    ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage?.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage?.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
    ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage?.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(usage?.apiMs === undefined ? {} : { apiMs: usage.apiMs }),
    ...(usage?.resolvedModel === undefined ? {} : { resolvedModel: usage.resolvedModel }),
    ...(usage?.models === undefined ? {} : { models: usage.models }),
    ...(usage?.terminalReason === undefined ? {} : { terminalReason: usage.terminalReason }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(peakContext === undefined ? {} : { peakContext }),
    ...(measuredContextChars === undefined ? {} : { contextChars: measuredContextChars }),
    ...(quota === undefined ? {} : { quota }),
  };
  return Object.keys(fields).length === 0 ? undefined : fields;
}

const invocationLog = (
  logger: AttemptLogger,
  filename: string,
): { readonly onInvocationEnd: (record: AgentInvocationRecord) => Promise<void> } => ({
  onInvocationEnd: (record) => logger.writeInvocation(filename, record),
});

export async function runInnerLoop(
  issue: IssueRef,
  opts: InnerLoopOptions,
  runCycle: (
    issue: IssueRef,
    opts: InnerLoopOptions,
    invocationSequence: AgentInvocationSequence,
  ) => Promise<SandboxCycleOutcome> = runSandboxCycle,
): Promise<Terminal> {
  let retriesUsed = 0;
  const specGaps: SpecGap[] = [];
  let admitted = false;
  let partitionCheckPending = opts.config.partitionCheck;
  const cycleOptions: InnerLoopOptions = {
    ...opts,
    onEvent: async (event) => {
      if (event.kind === "admitted") {
        if (admitted) return;
        admitted = true;
      }
      if (
        event.kind === "partition-check" &&
        (event.result === "CLEAR" || event.result === "PARTITION")
      ) {
        partitionCheckPending = false;
      }
      await opts.onEvent(event);
    },
  };
  for (;;) {
    const outcome = await runCycle(
      issue,
      {
        ...cycleOptions,
        config: { ...cycleOptions.config, partitionCheck: partitionCheckPending },
      },
      opts.attemptLogger.startInvocationCycle(),
    );
    specGaps.push(...outcome.specGaps);
    const decision = decideAfterTerminal(outcome.verdict, retriesUsed);
    if (decision.kind === "surface") {
      return toTerminal({ ...outcome, specGaps });
    }
    retriesUsed = decision.nextRetriesUsed;
    const reason = outcome.verdict.type === "HARD-ERROR" ? outcome.verdict.reason : "";
    await opts.onEvent({
      kind: "hard-error",
      issue: Number(issue.id),
      title: issue.title,
      retry: retriesUsed,
      max: HARD_ERROR_MAX_RETRIES,
      reason,
    });
  }
}

function toTerminal(outcome: SandboxCycleOutcome): Terminal {
  const { verdict, accumulatedCommits, specGaps } = outcome;
  switch (verdict.type) {
    case "DONE":
      return { type: "DONE", commits: accumulatedCommits, specGaps };
    case "NEEDS-INFO":
      return {
        type: "NEEDS-INFO",
        questions: verdict.questions,
        strandedHead: verdict.strandedHead,
        specGaps,
      };
    case "NEEDS-UI-PROTOTYPE":
      return {
        type: "NEEDS-UI-PROTOTYPE",
        uiImpact: verdict.uiImpact,
        commits: accumulatedCommits,
        strandedHead: verdict.strandedHead,
        specGaps,
      };
    case "NEEDS-PARTITION":
      return {
        type: "NEEDS-PARTITION",
        cause: verdict.cause,
        slot: verdict.slot,
        size: verdict.size,
        budget: verdict.budget,
        detail: verdict.detail,
        commits: accumulatedCommits,
        specGaps,
      };
    case "NEEDS-HUMAN":
      return {
        type: "NEEDS-HUMAN",
        cause: verdict.cause,
        failureTrace: verdict.failureTrace,
        latestReviewerProse: verdict.latestReviewerProse,
        budgetExhausted: verdict.budgetExhausted,
        strandedHead: verdict.strandedHead,
        specGaps,
      };
    case "NEEDS-HUMAN-REVIEW":
      return "roundsUsed" in verdict
        ? {
            type: "NEEDS-HUMAN-REVIEW",
            cause: verdict.cause,
            roundsUsed: verdict.roundsUsed,
            latestReviewerProse: verdict.latestReviewerProse,
            commits: accumulatedCommits,
            specGaps,
          }
        : {
            type: "NEEDS-HUMAN-REVIEW",
            cause: verdict.cause,
            latestReviewerProse: verdict.latestReviewerProse,
            commits: accumulatedCommits,
            specGaps,
          };
    case "HARD-ERROR":
      return {
        type: "HARD-ERROR",
        reason: verdict.reason,
        commits: accumulatedCommits,
        specGaps,
      };
    case "QUOTA":
      return {
        type: "QUOTA",
        provider: verdict.provider,
        window: verdict.window,
        ...(verdict.resetsAt === undefined ? {} : { resetsAt: verdict.resetsAt }),
        specGaps,
      };
    case "CREDENTIAL":
      return {
        type: "CREDENTIAL",
        provider: verdict.provider,
        detail: verdict.detail,
        specGaps,
      };
  }
}

async function runSandboxCycle(
  issue: IssueRef,
  opts: InnerLoopOptions,
  invocationSequence: AgentInvocationSequence,
): Promise<SandboxCycleOutcome> {
  const { config } = opts;
  const branchImages = opts.branchImages;
  let sandbox: Sandbox | null = null;
  let sandboxStack: SandboxStack | null = null;
  let stack: Stack | null = null;
  let sandboxStatuses: readonly SandboxContainerStatus[] = [];
  const accumulated: { sha: string }[] = [];
  const priorReviewRounds: PriorReviewRound[] = [];
  const quality: QualityLedger = {
    lastHead: null,
    sinceImplementer: [],
    openRound: null,
  };
  const specGaps: SpecGap[] = [];
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
    await opts.onEvent({
      kind: "admitted",
      issue: Number(issue.id),
      title: issue.title,
      branch: issue.branch,
      chunk: issue.chunk?.branch ?? null,
      seedRef: base.ref,
    });
    // What origin's copy of the branch had to say (#112): a fast-forward, a
    // resume from origin, unpushed work kept, abandonment, or an origin that
    // could not be asked. This is its own observation rather than a `repair`:
    // several outcomes deliberately change nothing, and calling all of them a
    // fast-forward would make the sole structured record assert a false action.
    // Nothing is emitted for the common in-sync and fresh-seed cases.
    const originSync = base.originSync;
    const originLine =
      originSync === undefined
        ? null
        : describeIssueBranchOriginSync(issue.branch, originSync);
    if (originSync !== undefined && originLine !== null) {
      await opts.onEvent({
        kind: "origin-sync",
        issue: Number(issue.id),
        title: issue.title,
        outcome: originSync.kind,
        detail: originLine,
      });
    }
    // For a chunk member, `admitted` above already says which of the two
    // seeds it got: `seedRef` is the chunk tip, or the source branch when the
    // member roots a chunk origin does not carry yet (`ensureIssueBranch`
    // gives the source branch to a member only when it IS the root, and
    // throws otherwise), which is where the merge phase will create it.

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
      onNotice: (severity, message) => opts.onEvent(
        agentSandboxNotice(severity, message),
      ),
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
        // no later point that could re-resolve without discarding them. A
        // branch-recipe failure falls back because this is the container the
        // fix would be written in; a driver-owned tools-layer failure
        // propagates as infrastructure. See resolveSandboxImage.
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
            await opts.onEvent({
              kind: "complaint",
              severity: "warning",
              message: line,
            });
          },
        });
        const extraMounts: agentSandbox.Mount[] = [
          ...(config.codexAuthMount === undefined ? [] : [{
            hostPath: config.codexAuthMount.hostPath,
            sandboxPath: config.codexAuthMount.sandboxPath,
          }]),
          ...(sbxContainers.length === 0 ? [] : [{
            hostPath: sandboxLogDir,
            sandboxPath: SANDBOX_LOG_MOUNT,
            readonly: true,
          }]),
          ...config.sandboxGateAttachments.mounts.map((mount) => ({
            hostPath: resolveStackMountHostPath(worktreePath, mount),
            sandboxPath: mount.containerPath,
            readonly: mount.mode === "ro",
          })),
        ];
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
          literalEnv: config.sandboxGateAttachments.env,
          preparedWorktreePath: worktreePath,
          ...(extraMounts.length === 0 ? {} : { extraMounts }),
          onNotice: (severity, message) => opts.onEvent(
            agentSandboxNotice(severity, message),
          ),
          ...(sbxContainers.length > 0
            ? {
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
                    onNotice: (message) => opts.onEvent({
                      kind: "complaint", severity: "warning", message,
                    }),
                    onContainerTeardown: (record) => opts.onEvent({
                      kind: "container",
                      stack: "sandbox",
                      issue: Number(issue.id),
                      title: issue.title,
                      ...record,
                    }),
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
        onNotice: (message) => opts.onEvent({
          kind: "complaint", severity: "warning", message,
        }),
        onContainerTeardown: (record) => opts.onEvent({
          kind: "container",
          stack: "gate",
          issue: Number(issue.id),
          title: issue.title,
          ...record,
        }),
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

    await opts.onEvent({
      kind: "setup",
      issue: Number(issue.id),
      title: issue.title,
      durationMs: setupTimer(),
      worktreeMs,
      ...(sandboxMs === null ? {} : { sandboxMs }),
      ...(stackMs === null ? {} : { stackMs }),
    });

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

    const branchAhead = await branchIsAheadOfSeed(worktreePath, base.ref);
    if (branchAhead) {
      const admissionPrompt = await buildPrompt({
        issue,
        attempt: 1,
        worktreePath,
        lastFailureTrace: "",
        base,
        promptExtension: config.promptExtensions?.implementer,
        sandboxStack: sandboxStatuses,
        sandboxHasGateAttachments: hasSandboxGateAttachments(
          config.sandboxGateAttachments,
        ),
      }, anchorOpts);
      const size = contextChars(
        admissionPrompt,
        await measureNetDiffChars(worktreePath, base.ref),
      );
      if (size > config.maxContextChars) {
        return {
          verdict: {
            type: "NEEDS-PARTITION",
            cause: "measured",
            slot: "implementer",
            size,
            budget: config.maxContextChars,
            detail: "The resumed branch already exceeds the configured context budget.",
          },
          accumulatedCommits: accumulated,
          specGaps,
        };
      }
    }

    let state: LoopState = initialState({
      issueBranch: issue.branch,
      maxGateRounds: config.maxGateRounds,
      maxReviewRounds: config.maxReviewRounds,
      uiPrototypeCheck: config.uiPrototypeCheck,
      partitionCheck: config.partitionCheck && !branchAhead,
    });
    let action: LoopAction = initialAction(state);
    await opts.onEvent({
      kind: "phase",
      issue: Number(issue.id),
      title: issue.title,
      attempt: state.attempt,
      phases: visiblePhases(action),
    });

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
        quality,
        specGaps,
        sandboxStatuses,
        invocationSequence,
      });
      const r = step(state, event);
      state = r.state;
      action = r.action;
      // Emitted after the step so the record carries both post-round budgets
      // (#132/#143). A round is quality + gate-1 + correctness; it closes at a
      // red gate or at the correctness outcome.
      const round = closedReviewRound(event);
      if (round !== null) {
        const opened = quality.openRound;
        if (opened === null) {
          throw new Error("a review round closed without a quality pass opening it");
        }
        await opts.onEvent({
          kind: "review-round",
          issue: Number(issue.id),
          title: issue.title,
          attempt: opened.attempt,
          round: opened.attempt,
          ...round,
          rejectingPass: round.correctness === "CHANGES-REQUESTED" ? "correctness" : null,
          gateFailures: state.gateFailures,
          correctnessFailures: state.correctnessFailures,
          durationMs: opened.timer(),
        });
      }
      // The #27 re-prompt only. A rejected review is the `review-round`
      // event and a red gate the `gate` event; neither is a repair.
      if (action.kind === "run-implementer" && action.extraReprompt !== null) {
        await opts.onEvent({
          kind: "repair",
          issue: Number(issue.id),
          title: issue.title,
          attempt: action.attempt,
          action: "re-prompt",
          detail: action.extraReprompt,
        });
      }
      await opts.onEvent({
        kind: "phase",
        issue: Number(issue.id),
        title: issue.title,
        attempt: state.attempt,
        phases: visiblePhases(action),
      });
    }

    return { verdict: action.verdict, accumulatedCommits: accumulated, specGaps };
  } catch (err) {
    if (err instanceof PartitionRequiredError) {
      return {
        verdict: err.verdict,
        accumulatedCommits: accumulated,
        specGaps,
      };
    }
    if (err instanceof AgentQuotaError) {
      recordProviderClosure(opts.providerState, err);
      return {
        verdict: quotaVerdict(err),
        accumulatedCommits: accumulated,
        specGaps,
      };
    }
    if (err instanceof AgentCredentialError) {
      recordProviderClosure(opts.providerState, err);
      return {
        verdict: credentialVerdict(err),
        accumulatedCommits: accumulated,
        specGaps,
      };
    }
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
    if (
      err instanceof SandbarError &&
      !(err instanceof ContainerBringupError) &&
      !(err instanceof AgentToolsImageError)
    ) {
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
      specGaps,
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
        await opts.onEvent({
          kind: "complaint",
          severity: "error",
          message: err instanceof Error ? err.message : String(err),
        });
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
        await opts.onEvent({
          kind: "complaint",
          severity: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (sandbox) {
      try {
        sandbox.deferWorktreeReclaim();
        await sandbox.close();
      } catch (err) {
        await opts.onEvent({
          kind: "complaint",
          severity: "error",
          message: `Failed to close agent sandbox: ${err instanceof Error ? err.message : String(err)}`,
        });
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
  // whose heads they judged. Declared spec gaps (#108) travel beside that
  // history without entering LoopState; runInnerLoop preserves them across a
  // fresh HARD-ERROR cycle so every terminal can hand the run's evidence to
  // finalize.
  readonly priorReviewRounds: PriorReviewRound[];
  readonly quality: QualityLedger;
  readonly specGaps: SpecGap[];
  // What came up beside the agent, for the implementer's prompt slot (#44 D8).
  // Empty when the consumer declares no `inSandbox` container.
  readonly sandboxStatuses: readonly SandboxContainerStatus[];
  readonly invocationSequence: AgentInvocationSequence;
};

// Runner-owned facts about the quality fixer in this sandbox cycle (#185):
// prompt and record material, never state-machine input. A fresh HARD-ERROR
// cycle starts a new ledger, as it does a new review history.
export type QualityLedger = {
  // The head the fixer's previous pass left; anchors the next pass's
  // "changed since" focus. Null before the first pass.
  lastHead: string | null;
  // The fixer's commits since the implementer's last attempt, oldest first,
  // from the host-collected range. The next implementer prompt names them and
  // runImplementer clears the list.
  sinceImplementer: string[];
  // The round the latest quality pass opened: its attempt number and a timer
  // spanning fixer, gate-1 and, when it runs, correctness.
  openRound: { readonly attempt: number; readonly timer: () => number } | null;
};

// The round a gate-1 or correctness result closes, for the `review-round`
// record; null for every other event, and for a reviewer write (which parks).
export function closedReviewRound(event: LoopEvent): {
  readonly head: string;
  readonly gateOk: boolean;
  readonly correctness: "APPROVED" | "CHANGES-REQUESTED" | "SKIPPED" | "HARNESS-FAILED";
} | null {
  if (event.kind === "gate-result") {
    return event.gate.ok
      ? null
      : { head: event.head, gateOk: false, correctness: "SKIPPED" };
  }
  if (event.kind !== "correctness-result") return null;
  const { reviewer } = event;
  if (reviewer.kind === "reviewer-wrote") return null;
  return {
    head: event.head,
    gateOk: true,
    correctness: reviewer.kind === "reviewer-harness-failed"
      ? "HARNESS-FAILED"
      : reviewer.verdict,
  };
}

async function executeAction(
  action: LoopAction,
  ctx: ExecuteActionCtx,
): Promise<LoopEvent> {
  switch (action.kind) {
    case "run-partition-check":
      return runPartitionCheck(action, ctx);
    case "run-ui-check":
      return runUiCheck(action, ctx);
    case "run-implementer":
      return runImplementer(action, ctx);
    case "run-quality":
      return runQuality(action, ctx);
    case "run-gate":
      return runGate(action, ctx);
    case "run-correctness":
      return runCorrectness(action, ctx);
    case "run-adjudicator":
      return runAdjudicator(action, ctx);
    case "terminate":
      throw new Error("executeAction called with terminate; runner should exit instead");
  }
}

export async function runPartitionCheck(
  _action: Extract<LoopAction, { kind: "run-partition-check" }>,
  ctx: ExecuteActionCtx,
): Promise<Extract<LoopEvent, {
  kind: "partition-check-result" | "partition-checker-wrote" | "context-over-budget";
}>> {
  const { issue, sandbox, opts, config } = ctx;
  const basePrompt = await buildPartitionCheckPrompt(
    issue.id,
    config.repo,
    config.maxContextChars,
  );
  const size = contextChars(
    basePrompt,
    await measureNetDiffChars(sandbox.worktreePath, ctx.base.ref),
  );
  if (size > config.maxContextChars) {
    return {
      kind: "context-over-budget",
      slot: "partition-check",
      size,
      budget: config.maxContextChars,
      detail: "The issue anchor alone exceeds the configured context budget.",
    };
  }

  let prompt = basePrompt;
  for (let invocation = 1; invocation <= 2; invocation += 1) {
    const before = await snapshotReadOnlyAgent(sandbox.worktreePath, issue.branch);
    const timer = startTimer();
    const log = async (
      result: Extract<EventInput, { kind: "partition-check" }>["result"],
      durationMs: number,
      usage: AgentUsage | undefined,
      toolCalls: number | undefined,
      peakContext: number | undefined,
      resources: ContainerResources,
    ): Promise<void> => {
      const usageFields = eventUsage(
        usage,
        toolCalls,
        peakContext,
        undefined,
        size,
      );
      await opts.onEvent({
        kind: "partition-check",
        issue: Number(issue.id),
        title: issue.title,
        invocation,
        provider: config.implementerAgent,
        model: config.implementerModelId,
        effort: config.implementerEffort ?? null,
        durationMs,
        result,
        ...(usageFields === undefined ? {} : { usage: usageFields }),
        ...resources,
      });
    };

    const outcome = await runWithProviderState(
      opts.providerState,
      config.implementerAgent,
      () => sandbox.run({
        name: `partition-check-${issue.id}${invocation === 1 ? "" : "-reprompt"}`,
        model: config.implementerModelId,
        agent: buildAgentProvider(config.implementerAgent, config.implementerModelId, {
          effort: config.implementerEffort,
        }),
        prompt,
        completionSignal: [],
        ...invocationLog(opts.attemptLogger, ctx.invocationSequence.filename({
          role: "partition-check",
          invocation,
        })),
      }),
    ).then(
      (run) => ({ kind: "completed" as const, run }),
      (err: unknown) => ({ kind: "failed" as const, err }),
    );
    if (outcome.kind === "failed") {
      const { err } = outcome;
      const partial = agentPartialUsage(err);
      await log(
        err instanceof AgentInputTooLargeError
          ? "input-too-large"
          : err instanceof AgentQuotaError
            ? "quota"
            : err instanceof AgentCredentialError
              ? "credential"
              : "failed",
        agentPartialDurationMs(err) ?? timer(),
        partial.usage,
        partial.toolCalls,
        partial.peakContext,
        agentPartialContainerResources(err),
      );
      const wrote = await enforceReadOnlyAgentSnapshot(
        sandbox,
        before,
        await snapshotReadOnlyAgent(sandbox.worktreePath, issue.branch),
        "Partition checker",
        agentPartialOutput(err),
      );
      if (wrote !== null) return { kind: "partition-checker-wrote", detail: wrote };
      throw providerSizeRefusal(
        err,
        "partition-check",
        size,
        config.maxContextChars,
      );
    }
    const { run } = outcome;

    const wrote = await enforceReadOnlyAgentSnapshot(
      sandbox,
      before,
      await snapshotReadOnlyAgent(sandbox.worktreePath, issue.branch),
      "Partition checker",
      run.stdout,
    );
    if (wrote !== null) {
      await log("wrote", run.durationMs, run.usage, run.toolCalls, run.peakContext,
        containerResourcesOf(run));
      return { kind: "partition-checker-wrote", detail: wrote };
    }
    const result = parsePartitionCheck(run.stdout);
    await log(result.kind, run.durationMs, run.usage, run.toolCalls, run.peakContext,
      containerResourcesOf(run));
    if (result.kind !== "NO-SIGNAL") {
      return {
        kind: "partition-check-result",
        result,
        size,
        budget: config.maxContextChars,
      };
    }
    if (invocation === 1) {
      prompt = `${basePrompt}\n\n---\n\n# Required correction\n\n${result.reprompt}`;
      continue;
    }
    throw new AgentError(
      "Partition checker produced no valid classification after its one re-prompt.",
    );
  }
  throw new Error("unreachable partition-check invocation count");
}

export async function runUiCheck(
  _action: Extract<LoopAction, { kind: "run-ui-check" }>,
  ctx: ExecuteActionCtx,
): Promise<
  Extract<LoopEvent, { kind: "ui-check-result" | "ui-checker-wrote" }>
> {
  const { issue, sandbox, opts, config } = ctx;
  const basePrompt = await buildUiCheckPrompt(issue.id, config.repo);
  let prompt = basePrompt;

  // One correction at most. Neither invocation owns a completion signal:
  // process exit is the honest end of this role's single classification.
  for (let invocation = 1; invocation <= 2; invocation += 1) {
    const beforeInvocation = await snapshotReadOnlyAgent(
      sandbox.worktreePath,
      issue.branch,
    );
    const timer = startTimer();
    const logInvocation = async (
      result: Extract<EventInput, { kind: "ui-check" }>["result"],
      durationMs: number,
      maxGapMs: number | undefined,
      usage: AgentUsage | undefined,
      toolCalls: number | undefined,
      peakContext: number | undefined,
      rateLimit: RateLimitMeasurement | undefined,
      resources: ContainerResources,
    ): Promise<void> => {
      await opts.onEvent({
        kind: "ui-check",
        issue: Number(issue.id),
        title: issue.title,
        invocation,
        provider: config.uiCheckAgent,
        model: config.uiCheckModelId,
        effort: config.uiCheckEffort ?? null,
        durationMs,
        ...(maxGapMs === undefined ? {} : { maxGapMs }),
        result,
        ...(eventUsage(usage, toolCalls, peakContext, rateLimit) === undefined
          ? {}
          : { usage: eventUsage(usage, toolCalls, peakContext, rateLimit) }),
        ...resources,
      });
    };

    let run: Awaited<ReturnType<Sandbox["run"]>>;
    try {
      run = await runWithProviderState(opts.providerState, config.uiCheckAgent, () =>
        sandbox.run({
          name: `ui-check-${issue.id}${invocation === 1 ? "" : "-reprompt"}`,
          model: config.uiCheckModelId,
          agent: buildAgentProvider(config.uiCheckAgent, config.uiCheckModelId, {
            effort: config.uiCheckEffort,
          }),
          prompt,
          completionSignal: [],
          ...invocationLog(opts.attemptLogger, ctx.invocationSequence.filename({
            role: "ui-check", invocation,
          })),
        }),
      );
    } catch (err) {
      const partial = agentPartialUsage(err);
      const resources = agentPartialContainerResources(err);
      await logInvocation(
        err instanceof AgentInputTooLargeError
          ? "input-too-large"
          : err instanceof AgentQuotaError
          ? "quota"
          : err instanceof AgentCredentialError
            ? "credential"
            : "failed",
        agentPartialDurationMs(err) ?? timer(),
        undefined,
        partial.usage,
        partial.toolCalls,
        partial.peakContext,
        partial.rateLimit ??
          (err instanceof AgentQuotaError ? err.measurement : undefined),
        resources,
      );
      const wrote = await enforceReadOnlyAgentSnapshot(
        sandbox,
        beforeInvocation,
        await snapshotReadOnlyAgent(sandbox.worktreePath, issue.branch),
        "UI checker",
        agentPartialOutput(err),
      );
      if (wrote !== null) return { kind: "ui-checker-wrote", detail: wrote };
      throw providerSizeRefusal(
        err,
        "ui-check",
        prompt.length,
        config.maxContextChars,
      );
    }

    const wrote = await enforceReadOnlyAgentSnapshot(
      sandbox,
      beforeInvocation,
      await snapshotReadOnlyAgent(sandbox.worktreePath, issue.branch),
      "UI checker",
      run.stdout,
    );
    if (wrote !== null) {
      await logInvocation(
        "wrote",
        run.durationMs,
        run.maxGapMs,
        run.usage,
        run.toolCalls,
        run.peakContext,
        run.rateLimit,
        containerResourcesOf(run),
      );
      return { kind: "ui-checker-wrote", detail: wrote };
    }
    const result = parseUiCheck(run.stdout);
    await logInvocation(
      result.kind,
      run.durationMs,
      run.maxGapMs,
      run.usage,
      run.toolCalls,
      run.peakContext,
      run.rateLimit,
      containerResourcesOf(run),
    );
    if (result.kind !== "NO-SIGNAL") {
      return { kind: "ui-check-result", result };
    }
    if (invocation === 1) {
      prompt = `${basePrompt}\n\n---\n\n# Required correction\n\n${result.reprompt}`;
      continue;
    }
    throw new AgentError(
      "UI checker produced no valid classification after its one re-prompt.",
    );
  }
  throw new Error("unreachable UI-check invocation count");
}

// The anchors and branch range every branch-reading cold role is built from,
// with that role's own prompt extension.
const branchRoleInputs = (
  ctx: ExecuteActionCtx,
  promptExtension: PromptExtension | undefined,
): ReviewerPromptInputs => ({
  issue: ctx.issue,
  repo: ctx.config.repo,
  repoDir: ctx.config.layout.repoDir,
  worktreePath: ctx.sandbox.worktreePath,
  sourceBranch: ctx.config.sourceBranch,
  base: ctx.base,
  ...(promptExtension === undefined ? {} : { promptExtension }),
  claudeMdPath: ctx.config.claudeMdPath,
  ...(ctx.config.contextMdPath === undefined ? {} : { contextMdPath: ctx.config.contextMdPath }),
});

async function requireIssueTip(ctx: ExecuteActionCtx, when: string): Promise<string> {
  const tip = await branchTip(ctx.worktreePath, ctx.issue.branch);
  if (tip === null) {
    throw new SandbarError(`issue branch ${ctx.issue.branch} disappeared ${when}`);
  }
  return tip;
}

// The quality fixer's commit author, set for its invocation only (#185). The
// committer stays the sandbox's identity, so the pair says who wrote a change
// and that it went through this sandbox.
export const qualityAuthorEnv = (
  config: Pick<InnerLoopConfig, "botName" | "botEmail">,
): Readonly<Record<string, string>> => ({
  GIT_AUTHOR_NAME: `${config.botName} (quality)`,
  GIT_AUTHOR_EMAIL: config.botEmail,
});

// The quality pass (#185): a cold fixer in the implementer's writable sandbox.
// It is told the coding standards and conventions and commits what it fixes;
// it emits nothing the loop parses. Process exit — clean, non-zero, idle or
// completion timeout alike (`AgentError`/`AgentIdleTimeoutError`) — is the end
// of the pass, and the host then settles whatever it left. Only a provider
// closure or size refusal stops the round, with the same meaning as for every
// other role; anything else is infrastructure and propagates to HARD-ERROR.
export async function runQuality(
  action: Extract<LoopAction, { kind: "run-quality" }>,
  ctx: ExecuteActionCtx,
): Promise<Extract<LoopEvent, { kind: "quality-result" | "context-over-budget" }>> {
  const { issue, sandbox, opts, config, quality } = ctx;
  quality.openRound = { attempt: action.attempt, timer: startTimer() };
  const prompt = await buildQualityPrompt({
    ...branchRoleInputs(ctx, config.promptExtensions?.reviewerQuality),
    lastQualityHead: quality.lastHead,
  });
  const measuredContextChars = contextChars(
    prompt,
    await measureNetDiffChars(sandbox.worktreePath, ctx.base.ref),
  );
  if (measuredContextChars > config.maxContextChars) {
    return {
      kind: "context-over-budget",
      slot: "review-quality",
      size: measuredContextChars,
      budget: config.maxContextChars,
      detail: "The completed branch exceeds the configured context budget before the quality pass.",
    };
  }
  const startSha = await requireIssueTip(ctx, "before the quality pass");
  const timer = startTimer();
  type Measurements = {
    readonly durationMs: number;
    readonly maxGapMs?: number;
    readonly usage?: AgentUsage;
    readonly toolCalls?: number;
    readonly peakContext?: number;
    readonly rateLimit?: RateLimitMeasurement;
    readonly resources: ContainerResources;
  };
  const record = async (outcome: QualityPassEvent, m: Measurements): Promise<void> => {
    const usageFields = eventUsage(
      m.usage,
      m.toolCalls,
      m.peakContext,
      m.rateLimit,
      measuredContextChars,
    );
    await opts.onEvent({
      kind: "quality-pass",
      issue: Number(issue.id),
      title: issue.title,
      attempt: action.attempt,
      round: action.attempt,
      provider: config.reviewerQualityAgent,
      model: config.reviewerQualityModelId,
      effort: config.reviewerQualityEffort ?? null,
      ...outcome,
      durationMs: m.durationMs,
      ...(m.maxGapMs === undefined ? {} : { maxGapMs: m.maxGapMs }),
      ...(usageFields === undefined ? {} : { usage: usageFields }),
      ...m.resources,
    });
  };

  let exited: "completed" | "failed";
  let measurements: Measurements;
  try {
    const run = await runWithProviderState(
      opts.providerState,
      config.reviewerQualityAgent,
      () => sandbox.run({
        name: `quality-${issue.id}-attempt-${action.attempt}`,
        model: config.reviewerQualityModelId,
        agent: buildAgentProvider(config.reviewerQualityAgent, config.reviewerQualityModelId, {
          effort: config.reviewerQualityEffort,
        }),
        prompt,
        completionSignal: [],
        env: qualityAuthorEnv(config),
        ...invocationLog(opts.attemptLogger, ctx.invocationSequence.filename({
          role: "quality", attempt: action.attempt,
        })),
      }),
    );
    exited = "completed";
    measurements = {
      durationMs: run.durationMs,
      maxGapMs: run.maxGapMs,
      ...(run.usage === undefined ? {} : { usage: run.usage }),
      toolCalls: run.toolCalls,
      ...(run.peakContext === undefined ? {} : { peakContext: run.peakContext }),
      ...(run.rateLimit === undefined ? {} : { rateLimit: run.rateLimit }),
      resources: containerResourcesOf(run),
    };
  } catch (err) {
    const partial = agentPartialUsage(err);
    const rateLimit = partial.rateLimit ??
      (err instanceof AgentQuotaError ? err.measurement : undefined);
    measurements = {
      durationMs: agentPartialDurationMs(err) ?? timer(),
      ...(partial.usage === undefined ? {} : { usage: partial.usage }),
      ...(partial.toolCalls === undefined ? {} : { toolCalls: partial.toolCalls }),
      ...(partial.peakContext === undefined ? {} : { peakContext: partial.peakContext }),
      ...(rateLimit === undefined ? {} : { rateLimit }),
      resources: agentPartialContainerResources(err),
    };
    const closed = err instanceof AgentInputTooLargeError
      ? "input-too-large"
      : err instanceof AgentQuotaError
        ? "quota"
        : err instanceof AgentCredentialError
          ? "credential"
          : null;
    if (closed !== null) {
      await record({ result: closed }, measurements);
      throw providerSizeRefusal(err, "review-quality", measuredContextChars, config.maxContextChars);
    }
    if (!(err instanceof AgentError || err instanceof AgentIdleTimeoutError)) throw err;
    exited = "failed";
  }

  const settled = await settleQualityResidue(ctx.worktreePath, issue.branch, startSha);
  const commits = settled.commits.map(({ sha }) => sha);
  await record({ result: exited, commits, discarded: settled.residue }, measurements);
  // Gate-1 and the correctness pass read this clone; the merger reads the
  // cache. A publish that fails is infrastructure, exactly as for the
  // implementer (#98).
  await sandbox.syncBranchToCache();
  ctx.accumulated.push(...settled.commits);
  quality.sinceImplementer.push(...commits);
  quality.lastHead = await requireIssueTip(ctx, "after the quality pass");
  return { kind: "quality-result" };
}

export async function runImplementer(
  action: Extract<LoopAction, { kind: "run-implementer" }>,
  ctx: ExecuteActionCtx,
): Promise<LoopEvent> {
  const { issue, sandbox, opts, config, anchorOpts, accumulated } = ctx;
  // Handed to this attempt's prompt once: the next attempt is told only about
  // what the fixer committed after this one.
  const qualityCommits = ctx.quality.sinceImplementer.splice(0);
  const prompt = await buildPrompt(
    {
      issue,
      attempt: action.attempt,
      worktreePath: sandbox.worktreePath,
      lastFailureTrace: action.failureTrace,
      base: ctx.base,
      promptExtension: config.promptExtensions?.implementer,
      qualityCommits,
      ...(action.extraReprompt !== null ? { extraReprompt: action.extraReprompt } : {}),
      ...(action.latestReviewerFeedback !== null
        ? { latestReviewerFeedback: action.latestReviewerFeedback }
        : {}),
      sandboxStack: ctx.sandboxStatuses,
      sandboxHasGateAttachments: hasSandboxGateAttachments(
        config.sandboxGateAttachments,
      ),
    },
    anchorOpts,
  );
  const measuredContextChars = contextChars(
    prompt,
    await measureNetDiffChars(sandbox.worktreePath, ctx.base.ref),
  );

  // Covers the nudge below too, when one runs: the whole cost of the attempt's
  // agent leg, which is what every #77 idea trading implementer minutes for
  // reviewer rounds is spending (#82).
  const implementerTimer = startTimer();
  const runAgent = (options: Parameters<Sandbox["run"]>[0]) =>
    runSandboxAndPublish(sandbox, options, issue.id, opts.onEvent);
  const logFailure = async (
    err: unknown,
    prior?: Awaited<ReturnType<typeof runAgent>>,
  ): Promise<void> => {
    const partial = agentPartialUsage(err);
    const resources = prior === undefined
      ? agentPartialContainerResources(err)
      : mergeContainerResources(prior, agentPartialContainerResources(err));
    const toolCalls = prior?.toolCalls === undefined && partial.toolCalls === undefined
      ? undefined
      : (prior?.toolCalls ?? 0) + (partial.toolCalls ?? 0);
    const usage = eventUsage(
      prior === undefined
        ? partial.usage
        : sumAgentUsage(prior.usage, partial.usage),
      toolCalls,
      maxContextDepth(prior?.peakContext, partial.peakContext),
      partial.rateLimit ?? prior?.rateLimit ??
        (err instanceof AgentQuotaError ? err.measurement : undefined),
      measuredContextChars,
    );
    await opts.onEvent({
      kind: "implementer",
      issue: Number(issue.id),
      title: issue.title,
      attempt: action.attempt,
      signal: err instanceof AgentQuotaError
        ? "QUOTA"
        : err instanceof AgentCredentialError
          ? "CREDENTIAL"
          : "FAILED",
      commits: prior?.commits.length ?? 0,
      provider: config.implementerAgent,
      model: config.implementerModelId,
      effort: config.implementerEffort ?? null,
      durationMs: (prior?.durationMs ?? 0) +
        (agentPartialDurationMs(err) ?? (prior === undefined ? implementerTimer() : 0)),
      ...(usage === undefined ? {} : { usage }),
      ...resources,
    });
  };
  let run: Awaited<ReturnType<typeof runAgent>>;
  try {
    run = await runWithProviderState(opts.providerState, config.implementerAgent, () => runAgent({
      name: `implementer-${issue.id}-attempt-${action.attempt}`,
      model: config.implementerModelId,
      agent: buildAgentProvider(config.implementerAgent, config.implementerModelId, {
        effort: config.implementerEffort,
      }),
      prompt,
      completionSignal: PROMISE_COMPLETION_SIGNALS,
      ...invocationLog(opts.attemptLogger, ctx.invocationSequence.filename({
        role: "implementer", attempt: action.attempt, nudge: false,
      })),
    }));
  } catch (err) {
    await logFailure(err);
    throw providerSizeRefusal(
      err,
      "implementer",
      measuredContextChars,
      config.maxContextChars,
    );
  }
  accumulated.push(...run.commits);

  let signal = parsePromise(run.stdout, {
    commitsAccumulated: accumulated.length,
  });
  let attemptUsage = run.usage;
  let attemptToolCalls = run.toolCalls;
  let attemptCommits = run.commits.length;
  let attemptPeakContext = run.peakContext;
  let attemptRateLimit = run.rateLimit;
  let attemptMaxGapMs = run.maxGapMs;
  let attemptDurationMs = run.durationMs;
  let attemptResources: ContainerResources = containerResourcesOf(run);
  let attemptStdout = run.stdout;

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
    let nudge: Awaited<ReturnType<typeof runAgent>>;
    try {
      nudge = await runAgent({
        name: `implementer-${issue.id}-attempt-${action.attempt}-nudge`,
        model: config.implementerModelId,
        agent: buildAgentProvider(config.implementerAgent, config.implementerModelId, {
          continueSession: true,
          effort: config.implementerEffort,
        }),
        prompt: PROMISE_NUDGE_TPL,
        // Any of the three tags ends the wait, not just COMPLETE.
        completionSignal: PROMISE_COMPLETION_SIGNALS,
        ...invocationLog(opts.attemptLogger, ctx.invocationSequence.filename({
          role: "implementer", attempt: action.attempt, nudge: true,
        })),
      });
    } catch (err) {
      await logFailure(err, run);
      throw providerSizeRefusal(
        err,
        "implementer",
        measuredContextChars,
        config.maxContextChars,
      );
    }
    accumulated.push(...nudge.commits);
    attemptUsage = sumAgentUsage(attemptUsage, nudge.usage);
    attemptToolCalls += nudge.toolCalls;
    attemptPeakContext = maxContextDepth(attemptPeakContext, nudge.peakContext);
    attemptRateLimit = nudge.rateLimit ?? attemptRateLimit;
    attemptMaxGapMs = Math.max(attemptMaxGapMs, nudge.maxGapMs);
    attemptDurationMs += nudge.durationMs;
    attemptResources = mergeContainerResources(attemptResources, nudge);
    const combined = combinePromiseNudge(run, nudge);
    attemptStdout = combined.stdout;
    attemptCommits = combined.commitCount;
    signal = parsePromise(combined.stdout, {
      commitsAccumulated: accumulated.length,
    });
    await opts.onEvent({
      kind: "repair",
      issue: Number(issue.id),
      title: issue.title,
      attempt: action.attempt,
      action: "promise-nudge",
      detail: `signal=${signal.kind} durationMs=${nudge.durationMs} maxGapMs=${nudge.maxGapMs}`,
    });
    // The nudge was the same-session re-ask. If both calls were silent and
    // this attempt committed nothing, there is no evidence that the provider
    // ran successfully. Commits are independent evidence and deliberately keep
    // Codex's tool-call-only turn on the ordinary NO-SIGNAL path (#116).
    try {
      requireImplementerAttemptEvidence(run, nudge);
    } catch (err) {
      await logFailure(err, {
        ...nudge,
        commits: [...run.commits, ...nudge.commits],
        usage: attemptUsage,
        toolCalls: attemptToolCalls,
        peakContext: attemptPeakContext,
        rateLimit: attemptRateLimit,
        durationMs: attemptDurationMs,
        ...attemptResources,
      });
      throw withPartialContainerResources(withPartialOutput(
        err,
        combined.stdout,
        attemptUsage,
        attemptToolCalls,
        attemptPeakContext,
        nudge.rateLimit ?? run.rateLimit,
      ), attemptResources);
    }
  }
  // Stopped BEFORE the two git reads below: they are the state machine's
  // inputs, not the agent's cost, and folding them in would inflate every
  // implementer number by work the agent never did.
  const implementerMs = attemptDurationMs;

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
  const [dirtyPaths, mismatch] = await Promise.all([
    dirtyWorktreePaths(ctx.worktreePath),
    headMismatch(ctx.worktreePath, issue.branch),
  ]);
  let offBranch = mismatch;
  let fastForwarded: Extract<
    LoopEvent,
    { kind: "implementer-result" }
  >["fastForwarded"] = null;
  if (mismatch?.branchIsAncestor) {
    const repair = await fastForwardOffBranchHead(ctx.worktreePath, mismatch);
    // The agent run published before this host-side ref move. Publish the
    // repaired tip now as a required part of the repair: gate/reviewer inspect
    // this clone, while the merger reads the cache, so proceeding after a
    // failed sync could approve one tree and land another (#98/#127).
    await sandbox.syncBranchToCache();
    fastForwarded = { fromSha: repair.fromSha, toSha: repair.toSha };
    accumulated.push(...repair.commits);
    attemptCommits += repair.commits.length;
    // The ordinary commit collector could not see this range while it lived
    // only under off-branch HEAD. Re-run the same parse now that those commits
    // are evidence, so a valid COMPLETE can stand on its original attempt.
    signal = parsePromise(attemptStdout, {
      commitsAccumulated: accumulated.length,
    });
    offBranch = null;
    await opts.onEvent({
      kind: "repair",
      issue: Number(issue.id),
      title: issue.title,
      attempt: action.attempt,
      action: "fast-forward",
      detail: `from=${fastForwarded.fromSha} to=${fastForwarded.toSha}`,
    });
  }
  await opts.onEvent({
    kind: "implementer",
    issue: Number(issue.id),
    title: issue.title,
    attempt: action.attempt,
    signal: signal.kind,
    commits: attemptCommits,
    provider: config.implementerAgent,
    model: config.implementerModelId,
    effort: config.implementerEffort ?? null,
    durationMs: implementerMs,
    ...(run.signalMs === undefined ? {} : { signalMs: run.signalMs }),
    maxGapMs: attemptMaxGapMs,
    ...(eventUsage(attemptUsage, attemptToolCalls, attemptPeakContext, attemptRateLimit, measuredContextChars) === undefined
      ? {}
      : { usage: eventUsage(attemptUsage, attemptToolCalls, attemptPeakContext, attemptRateLimit, measuredContextChars) }),
    ...attemptResources,
  });
  const head = await branchTip(ctx.worktreePath, issue.branch);
  if (head === null) {
    throw new SandbarError(
      `issue branch ${issue.branch} disappeared after implementer attempt ${action.attempt}`,
    );
  }
  return {
    kind: "implementer-result",
    signal,
    dirtyPaths,
    offBranch,
    fastForwarded,
    commits: attemptCommits,
    head,
  };
}

export async function runSandboxAndPublish(
  sandbox: Sandbox,
  options: Parameters<Sandbox["run"]>[0],
  issueId: string,
  onEvent?: (event: EventInput) => Promise<void> | void,
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
      await onEvent?.({
        kind: "complaint",
        severity: "error",
        message:
          `Could not publish issue=${issueId} after implementer failure ` +
          `(continuing with original error): ${publishError instanceof Error ? publishError.message : String(publishError)}`,
      });
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

// Gate-1 on the head the quality pass left (#185). Serial, not beside the
// fixer: the gate mounts the worktree the fixer writes.
export async function runGate(
  action: Extract<LoopAction, { kind: "run-gate" }>,
  ctx: ExecuteActionCtx,
): Promise<Extract<LoopEvent, { kind: "gate-result" }>> {
  const { issue, opts, gateStack } = ctx;
  const head = await requireIssueTip(ctx, "before gate-1");
  const admitted = await opts.gateSemaphore.run(() => gateStack.runGate());
  const gate1 = admitted.value;
  // Before the verdict is classified, for #135's reason: the re-prompt is the
  // only other reader of this output, and a green gate has no re-prompt at all
  // (#153). The `gate` event keeps the timings; this file keeps the bytes.
  await opts.attemptLogger.writeGate(
    ctx.invocationSequence.filename({ role: "gate", attempt: action.attempt }),
    {
      ok: gate1.ok,
      stdout: gate1.stdout,
      stderr: gate1.stderr,
      failedStep: gate1.failedStep,
      exitCode: gate1.exitCode,
      containerLogs: gate1.containerLogs,
    },
  );
  await opts.onEvent({
    kind: "gate",
    issue: Number(issue.id),
    title: issue.title,
    attempt: action.attempt,
    gate: "gate-1",
    ok: gate1.ok,
    durationMs: gate1.durationMs,
    ...(admitted.queuedMs === undefined ? {} : { queuedMs: admitted.queuedMs }),
    steps: Object.fromEntries(gate1.steps.map(({ name, ...step }) => [name, step])),
  });
  return {
    kind: "gate-result",
    head,
    gate: {
      ok: gate1.ok,
      failedStep: gate1.failedStep,
      // Summarize the STEP output, then append the container logs — never the
      // other way round. The cascade collapse looks for many lines sharing one
      // signature, and a service log is full of them (see GateResult.containerLogs).
      failureTrace: gate1.ok
        ? ""
        : summarizeGateFailure(`${gate1.stdout}\n${gate1.stderr}`, FAILURE_TAIL_LINES) +
          gate1.containerLogs,
    },
  };
}

export type ReadOnlyAgentSnapshot = {
  readonly tip: string | null;
  readonly dirtyPaths: readonly string[];
  readonly headRef: string | null;
};

export async function snapshotReadOnlyAgent(
  worktreePath: string,
  branch: string,
): Promise<ReadOnlyAgentSnapshot> {
  const [tip, dirtyPaths, headRef] = await Promise.all([
    branchTip(worktreePath, branch),
    dirtyWorktreePaths(worktreePath),
    symbolicHeadRef(worktreePath),
  ]);
  return { tip, dirtyPaths, headRef };
}

export function readOnlyAgentSnapshotChanged(
  before: ReadOnlyAgentSnapshot,
  after: ReadOnlyAgentSnapshot,
): boolean {
  return (
    before.tip !== after.tip ||
    JSON.stringify(before.dirtyPaths) !== JSON.stringify(after.dirtyPaths) ||
    before.headRef !== after.headRef
  );
}

export async function enforceReadOnlyAgentSnapshot(
  sandbox: Pick<Sandbox, "preserveWorktree" | "syncBranchToCache">,
  before: ReadOnlyAgentSnapshot,
  after: ReadOnlyAgentSnapshot,
  role: "Reviewer" | "Adjudicator" | "UI checker" | "Partition checker",
  transcript: string,
): Promise<string | null> {
  if (!readOnlyAgentSnapshotChanged(before, after)) return null;
  sandbox.preserveWorktree(
    `the ${role.toLowerCase()} changed the repository; kept for human inspection`,
  );
  // Deleting the issue ref is itself an agent write. There is then no ref to
  // publish, but the preserved clone still contains the evidence.
  if (after.tip !== null) await sandbox.syncBranchToCache();
  const renderedTranscript =
    transcript.trim() || `(${role.toLowerCase()} emitted no output)`;
  return (
    `${role} changed git state. Branch tip before: ${before.tip}; ` +
    `after: ${after.tip}. HEAD before: ${before.headRef}; ` +
    `after: ${after.headRef}. Status after:\n` +
    (after.dirtyPaths.length > 0
      ? after.dirtyPaths.join("\n")
      : "(clean worktree)") +
    `\n\n${role} transcript:\n${renderedTranscript}`
  );
}

export async function enforceReviewerSnapshot(
  sandbox: Pick<Sandbox, "preserveWorktree" | "syncBranchToCache">,
  before: ReadOnlyAgentSnapshot,
  after: ReadOnlyAgentSnapshot,
  transcript: string,
): Promise<Extract<ReviewerResult, { kind: "reviewer-wrote" }> | null> {
  const detail = await enforceReadOnlyAgentSnapshot(
    sandbox,
    before,
    after,
    "Reviewer",
    transcript,
  );
  if (detail === null) return null;
  return {
    kind: "reviewer-wrote",
    detail,
  };
}

// The cold judge of one unchanged correctness rejection (#167). OVERRULED ends
// the issue as approved, so no history entry needs rewriting afterwards.
export async function runAdjudicator(
  action: Extract<LoopAction, { kind: "run-adjudicator" }>,
  ctx: ExecuteActionCtx,
): Promise<Extract<LoopEvent, {
  kind: "adjudicator-result" | "adjudicator-harness-failed" | "adjudicator-wrote";
}>> {
  const { issue, sandbox, opts, config } = ctx;
  const { rejection } = action;
  const prompt = await buildAdjudicatorPrompt({
    ...branchRoleInputs(ctx, undefined),
    head: rejection.head,
    report: rejection.report,
  });
  const measuredContextChars = contextChars(
    prompt,
    await measureNetDiffChars(sandbox.worktreePath, ctx.base.ref),
  );
  if (measuredContextChars > config.maxContextChars) {
    throw new PartitionRequiredError(
      "adjudication",
      measuredContextChars,
      config.maxContextChars,
      "The rejected report and branch exceed the configured context budget before adjudication.",
      "measured",
    );
  }
  const timer = startTimer();
  let usage: AgentUsage | undefined;
  let toolCalls: number | undefined;
  let peakContext: number | undefined;
  let resources: ContainerResources = {};
  const details: string[] = [];
  for (let invocation = 1; invocation <= REVIEWER_MAX_INVOCATIONS; invocation += 1) {
    const before = await snapshotReadOnlyAgent(sandbox.worktreePath, issue.branch);
    if (before.tip !== rejection.head) {
      throw new SandbarError(
        `refusing to adjudicate issue #${issue.id} round ${rejection.round}: ` +
          `rejected head ${rejection.head} moved to ${before.tip}`,
      );
    }
    const [settled] = await Promise.allSettled([
      runWithProviderState(
        opts.providerState,
        config.adjudicatorAgent,
        () => sandbox.run({
          name: `adjudicator-${issue.id}-round-${rejection.round}` +
            (invocation > 1 ? `-invocation-${invocation}` : ""),
          model: config.adjudicatorModelId,
          agent: buildAgentProvider(config.adjudicatorAgent, config.adjudicatorModelId, {
            effort: config.adjudicatorEffort,
          }),
          prompt,
          completionSignal: [],
          ...invocationLog(
            opts.attemptLogger,
            ctx.invocationSequence.filename({
              role: "adjudicator",
              attempt: action.attempt,
              invocation,
            }),
          ),
        }),
      ),
    ]);
    // Normalize an ordinary failed invocation with its partial measurements
    // and speech. Named provider failures are classified after the shared
    // read-only check, so a mutation can never hide behind another error.
    const completed = settled.status === "fulfilled" ? settled.value : null;
    const failure = settled.status === "rejected" ? settled.reason : null;
    const partial = completed === null ? agentPartialUsage(failure) : {};
    const output = completed?.stdout ?? agentPartialOutput(failure);
    const invocationUsage = completed?.usage ?? partial.usage;
    const invocationToolCalls = completed?.toolCalls ?? partial.toolCalls;
    const invocationPeakContext = completed?.peakContext ?? partial.peakContext;
    const invocationRateLimit = completed?.rateLimit ?? partial.rateLimit ??
      (failure instanceof AgentQuotaError ? failure.measurement : undefined);
    const invocationResources = completed === null
      ? agentPartialContainerResources(failure)
      : containerResourcesOf(completed);
    usage = sumAgentUsage(usage, invocationUsage);
    toolCalls = toolCalls === undefined && invocationToolCalls === undefined
      ? undefined
      : (toolCalls ?? 0) + (invocationToolCalls ?? 0);
    peakContext = maxContextDepth(peakContext, invocationPeakContext);
    resources = mergeContainerResources(resources, invocationResources);

    const after = await snapshotReadOnlyAgent(sandbox.worktreePath, issue.branch);
    const write = await enforceReadOnlyAgentSnapshot(
      sandbox,
      before,
      after,
      "Adjudicator",
      output,
    );
    if (write !== null) return { kind: "adjudicator-wrote", detail: write };

    if (failure instanceof AgentInputTooLargeError) {
      throw providerSizeRefusal(
        failure,
        "adjudication",
        measuredContextChars,
        config.maxContextChars,
      );
    }
    if (failure instanceof AgentQuotaError || failure instanceof AgentCredentialError) {
      throw failure;
    }

    const ruling = parseAdjudicationRuling(output);
    if (ruling !== null) {
      // A decision emitted before a teardown failure is still a decision,
      // matching reviewer invocation semantics (#41).
      const measuredUsage = eventUsage(
        usage,
        toolCalls,
        peakContext,
        invocationRateLimit,
        measuredContextChars,
      );
      await opts.onEvent({
        kind: "adjudication",
        issue: Number(issue.id),
        title: issue.title,
        attempt: action.attempt,
        round: rejection.round,
        head: rejection.head,
        ruling,
        provider: config.adjudicatorAgent,
        model: config.adjudicatorModelId,
        effort: config.adjudicatorEffort ?? null,
        durationMs: timer(),
        ...(completed?.maxGapMs === undefined ? {} : { maxGapMs: completed.maxGapMs }),
        ...(measuredUsage === undefined ? {} : { usage: measuredUsage }),
        ...resources,
      });
      return {
        kind: "adjudicator-result",
        head: rejection.head,
        ruling,
        reasoning: stripAdjudicationRulingTokens(output).trim(),
      };
    }

    details.push(
      failure === null
        ? `invocation ${invocation}/${REVIEWER_MAX_INVOCATIONS}: completed without a ruling token`
        : `invocation ${invocation}/${REVIEWER_MAX_INVOCATIONS}: ${
            failure instanceof Error ? failure.message : String(failure)
          }`,
    );
    if (invocation < REVIEWER_MAX_INVOCATIONS) {
      await opts.onEvent({
        kind: "notice",
        message:
          `issue=${issue.id} attempt=${action.attempt} adjudication ` +
          `invocation=${invocation}/${REVIEWER_MAX_INVOCATIONS} ` +
          "no-ruling — retrying",
      });
    }
  }
  return { kind: "adjudicator-harness-failed", detail: details.join("\n\n") };
}

// The correctness pass (#121, #185): the one reviewer, cold, read-only, run
// only on a green gate-1 at the head the quality pass left. Its picture is
// measured before it runs; reviewer-run.ts owns what its invocations mean.
export async function runCorrectness(
  action: Extract<LoopAction, { kind: "run-correctness" }>,
  ctx: ExecuteActionCtx,
): Promise<Extract<LoopEvent, { kind: "correctness-result" | "context-over-budget" }>> {
  const { issue, sandbox, opts, config } = ctx;
  const head = await requireIssueTip(ctx, "before the correctness pass");
  const prompt = await buildCorrectnessPrompt({
    ...branchRoleInputs(ctx, config.promptExtensions?.reviewer),
    priorRounds: ctx.priorReviewRounds,
  });
  const measuredContextChars = contextChars(
    prompt,
    await measureNetDiffChars(sandbox.worktreePath, ctx.base.ref),
  );
  if (measuredContextChars > config.maxContextChars) {
    return {
      kind: "context-over-budget",
      slot: "review-correctness",
      size: measuredContextChars,
      budget: config.maxContextChars,
      detail: "The completed branch exceeds the configured context budget before review.",
    };
  }
  const agent = config.reviewerAgent;
  const modelId = config.reviewerModelId;
  const effort = config.reviewerEffort;
  const snapshot = (): Promise<ReadOnlyAgentSnapshot> =>
    snapshotReadOnlyAgent(sandbox.worktreePath, issue.branch);
  const detectWrite = async (
    before: ReadOnlyAgentSnapshot,
    transcript: string,
  ): Promise<Extract<ReviewerResult, { kind: "reviewer-wrote" }> | null> =>
    enforceReviewerSnapshot(sandbox, before, await snapshot(), transcript);

  const outcome = await runReviewerInvocations(
    async (invocation) => {
      const beforeInvocation = await snapshot();
      // The retry is a fresh agent run in the SAME sandbox. The sandbox is not
      // what failed, and rebuilding it would restart the whole issue from
      // attempt 1 through the HARD-ERROR path, discarding a green gate to
      // re-run a reviewer.
      // One line per INVOCATION (#82). `model=` and `provider=` are on the
      // line because the number is meaningless without knowing which model
      // spent it, and both are per-call config a stats reader cannot recover.
      const passTimer = startTimer();
      // `signalMs` has no reviewer meaning: the reviewer names no completion
      // signal (#83), so the grace phase it measures is unreachable here.
      const logPass = async (
        result: "completed" | "failed" | "quota" | "credential" | "input-too-large",
        durationMs: number,
        maxGapMs: number | undefined,
        usage: AgentUsage | undefined,
        toolCalls: number | undefined,
        peakContext: number | undefined,
        rateLimit: RateLimitMeasurement | undefined,
        resources: ContainerResources,
      ): Promise<void> => {
        const usageFields = eventUsage(usage, toolCalls, peakContext, rateLimit, measuredContextChars);
        await opts.onEvent({
          kind: "review-pass",
          issue: Number(issue.id),
          title: issue.title,
          attempt: action.attempt,
          round: action.attempt,
          invocation,
          provider: agent,
          model: modelId,
          effort: effort ?? null,
          result,
          durationMs,
          ...(maxGapMs === undefined ? {} : { maxGapMs }),
          ...(usageFields === undefined ? {} : { usage: usageFields }),
          ...resources,
        });
      };
      try {
        const reviewerRun = await runWithProviderState(opts.providerState, agent, () => sandbox.run({
          name:
            `reviewer-${issue.id}-round-${action.attempt}` +
            (invocation > 1 ? `-invocation-${invocation}` : ""),
          model: modelId,
          // Cold, always (#121): nothing resumes a session, so the reviewer is
          // self-sufficient and may run on a different vendor from the fixer.
          agent: buildAgentProvider(agent, modelId, { effort }),
          prompt,
          // A reviewer owns no completion signal. Process exit is the honest
          // end of its single artefact; inherited role contracts are banned.
          completionSignal: [],
          ...invocationLog(
            opts.attemptLogger,
            ctx.invocationSequence.filename({
              role: "reviewer", attempt: action.attempt, invocation,
            }),
          ),
        }));
        await logPass(
          "completed",
          reviewerRun.durationMs,
          reviewerRun.maxGapMs,
          reviewerRun.usage,
          reviewerRun.toolCalls,
          reviewerRun.peakContext,
          reviewerRun.rateLimit,
          containerResourcesOf(reviewerRun),
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
        await logPass(
          err instanceof AgentInputTooLargeError
            ? "input-too-large"
            : err instanceof AgentQuotaError
            ? "quota"
            : err instanceof AgentCredentialError
              ? "credential"
              : "failed",
          agentPartialDurationMs(err) ?? passTimer(),
          undefined,
          partial.usage,
          partial.toolCalls,
          partial.peakContext,
          partial.rateLimit ??
            (err instanceof AgentQuotaError ? err.measurement : undefined),
          agentPartialContainerResources(err),
        );
        const transcript = agentPartialOutput(err);
        const event = await detectWrite(beforeInvocation, transcript);
        if (event !== null) return { kind: "aborted", event, transcript };
        if (err instanceof AgentInputTooLargeError) {
          throw providerSizeRefusal(
            err,
            "review-correctness",
            measuredContextChars,
            config.maxContextChars,
          );
        }
        if (err instanceof AgentQuotaError || err instanceof AgentCredentialError) throw err;
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
        await opts.onEvent({
          kind: "notice",
          message:
            `issue=${issue.id} attempt=${action.attempt} reviewer round=${action.attempt} ` +
            `invocation=${invocation}/${REVIEWER_MAX_INVOCATIONS} no-review — ` +
            `retrying (${detail.split("\n")[0]})`,
        });
      },
    },
  );
  if (outcome.kind === "aborted") {
    return { kind: "correctness-result", head, reviewer: outcome.event };
  }
  if (outcome.kind === "reviewed") {
    ctx.priorReviewRounds.push({
      round: action.attempt,
      head,
      correctness: outcome.verdict,
    });
    if (outcome.verdict.specGap) {
      ctx.specGaps.push({ round: action.attempt, text: outcome.verdict.specGap });
    }
  }
  return { kind: "correctness-result", head, reviewer: reviewerResult(outcome) };
}
