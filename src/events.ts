// The single structured record for a sandbar run (#132).
//
// Every fact after the workdir lock is won is appended to `events.jsonl` as a
// typed event. Submissions are chained, and `seq` advances only after a durable
// append, so file order is event order even when issue tasks finish concurrently
// and one failed append cannot poison later writes or leave a sequence gap.
// Finalization follows the same durability boundary: concurrent callers share
// one run-end append, and a failed append leaves finalization retryable.
// `ts` is wall-clock display data only; no decision reads it. Raw subprocess
// transcripts remain separate files through `logs.ts`. Landing requests carry
// their UI status and reason explicitly: the reducer does not reconstruct a
// queue or guess a merger step from neighbouring events (#168). A `landed`
// duration is one merge unit; `landing-batch` carries the distinct whole-phase duration.
// `notice` records routine recovery and other evidence that needs no human
// action; it appears in the event feed but never in the run header. `complaint`
// is reserved for a condition a human may need to act on (#172).
// Container-backed duration boundaries may also carry `peakMemoryBytes`
// (cgroup-v2 `memory.peak`, or Podman's sampled usage only as a fallback) and
// `oomKilled` (an increase in cgroup-v2 `memory.events` `oom_kill` over a
// reused execution span, OR-ed with Podman's State.OOMKilled; a whole-container
// teardown reports any non-zero count). Both are measurements only. An
// unavailable fact is omitted rather than encoded as zero (#141). So is a
// failed implementer run's `commits` when they could not be counted (#188).
// Schema 6 (#187): the quality pass is a read-only lister, a fixer and a
// read-only verify. Each lister or verify invocation is a `quality-review`
// event carrying its mode, scope, verdict and prose; the fixer's
// `quality-pass` event keeps #185's shape (its commits and the residue the
// host discarded); `adjudication` names the pass it ruled on; `review-round`
// adds how the quality pass ended and the quality rounds it spent, so whether
// an issue's findings were not found or not fixed reads off the record.
// `review-pass` stays correctness-only.
// A complaint may carry a typed subject when its prose is the sole UI surface
// for that entity. CLOSED issue-branch complaints use this to suppress the
// generic cached-ref-to-Waiting inference without parsing their message (#179).
// An agent-role event of a completed invocation carries `endedBy`: `exit`, or
// `result-then-silence` when a successful Claude result was followed by a
// whole completion grace of silence (#189). A report only; absent on failure.
// `admitted` records what a replay needs to rerun the issue faithfully (#195):
// `seedSha`, the commit `seedRef` named at admission, and `issueSnapshot`,
// the filename of the issue JSON filed in the issue's log directory. Both are
// optional, without a schema bump, because records written before them lack
// them.
// The run scorecard (#194, `stats.ts`) reads four more facts off the record.
// `usage.firstContext` is the context depth at the invocation's first
// command, beside `peakContext`. `transcript` names the invocation log an
// agent-role event came from, relative to the issue's log directory; an event
// that folds several invocations names the one that decided it. A `terminal`
// carries the machine's typed `cause` and its `specGaps` count, so parked
// issues group without parsing `reason`. A `resolve-attempt` carries its
// provider, model and usage.
//
// `issue-anchor` records the anchor step that opens every loop (#217): the
// anchor's size before sandbar's traces are dropped (`rawChars`), after
// (`tracedChars`) and as the roles receive it (`anchorChars`), how many
// comments it had and dropped, and whether the thread was below the
// threshold, already cached, condensed, or fell back uncondensed. Only a
// condenser call carries the agent fields. The sizes are reports, never
// decision inputs (#82).
//
// Additive changes do not bump EVENT_SCHEMA_VERSION (#194). Additive means a
// new kind, a new optional field or a new union member; a field that earlier
// records lack is optional. A bump is reserved for removing a field or
// changing an existing field's meaning, because each bump strands every
// earlier run for the UI.
//
// `gate-stack` records which gate stack an issue's gate-1 runs (#186): the
// accepted source-tip blob (null for an inline stack), how the branch's own
// stack file classified, and for an env-only edit the containers whose env the
// branch set. Emitted at setup and whenever the spec in effect changes; a
// report only (#82). NEEDS-STACK-CHANGE is the terminal a stack edit beyond
// env parks with.
//
// `deploy` (#198, `deploy-watch.ts`) is one verdict on a run of the
// consumer's deploy workflow — green, red or unverified — with the issues
// whose merges it shipped and, for a red, the bug issue it was filed as;
// `filed` says this process filed it. An unverified landing that no run
// covered within the deadline has null `runId` and `attempt`, and `sha` is
// its merge commit. A new kind, so no bump.
//
// `egress-refused` and `egress` (#202) record a network owner's egress
// proxy: its `stack` is the agent sandbox (siblings included), a gate stack
// or the merger's resolve container. `egress-refused` is the first sighting of
// one refused destination per proxy — `enforced` is false in report mode,
// where it was let through — and `egress` the proxy's teardown summary, its
// counts per destination being reports only (#82). New kinds, so no bump.
//
// `db-base` (#201, `db-base.ts`) is one attempt of the nightly base import,
// recorded once per run when the daemon first reads it from
// `import-status.json`: imported with the base's size, or failed with a
// reason code, never a server message. A stale dump or a failed import is
// also a complaint; the feed shows neither event. A new kind, so no bump.
//
// `scenario-writer` (#203) is one invocation of the cold role that writes an
// admission's hidden scenarios, with the standard agent fields; `durationMs`
// is absent only on a size refusal measured before any run. Its `result` says
// how the invocation ended: `completed` (with `scenarios`, the set's size and
// 0 for NONE, on the one that decided it; without, on a run whose answer
// earned the format nudge), `failed` (a harness failure, or an answer still
// malformed after the nudge), `wrote`, `input-too-large`, `quota`,
// `credential`, or `aborted` when the admission ended before the join. No
// event carries scenario text; the set is `scenarios-<k>.json` beside the
// invocation logs. The `scenarios` phase is the join that waits for it. A
// new kind, so no bump.
//
// `db-copy` (#201, `db-copy.ts`) is one change to an issue's database copy:
// `created` for a holder with its hook's outcome, `dropped` with the
// volume's used bytes, or `failed` with a reason code. The feed does not
// show it. A new kind, so no bump.
//
// `quality-review.group` (#204) names the rule group a lister read; the
// quality pass runs one lister per group. A new optional field, so no bump.
//
// An idle janitor run (#205) goes through the inner loop under a task name,
// not an issue: the kinds it emits carry `EventSubject`, whose `janitor`
// member names the task where an issue's `issue` would be. It emits no
// `admitted`, `origin-sync` or pre-attempt check event. A new union
// member, so no bump.
// Its runner (`janitor.ts`) brackets that loop: `janitor-start` once the
// task's rolling branch has a base and the run its scope, with the day's
// run count; `janitor-run` when it has ended, with its outcome, the commits
// a `committed` run pushed and its pull request. A run that failed before
// it started has an empty scope and no `janitor-start`. A held task is a
// `notice`. New kinds, so no bump; a recompute the run's end woke is
// trigger `janitor-finished`.
// `janitor-land` (#205) is a janitor branch's `land` request settled:
// `landed` by the merger, `parked` with the skip reason, or `reconciled`
// once found already on the source branch. Gate-2 and resolve-attempt events
// of its landing name the task (`EventSubject`). A new kind and union
// member, so no bump.
//
// `scenario-runner` (#180, #238) is one invocation of the verifier's
// scenario runner, beside the white-box review's `review-pass` in the same
// sandbox, so the `peakMemoryBytes` on either is the container's peak while
// both ran. `result` is `completed` (with `outcomes` on the invocation that
// decided; without, on a run whose answer earned the format nudge),
// `failed` (a harness failure, or no valid report after the nudge),
// `wrote`, `input-too-large` (a prompt over budget, then with no agent
// fields, or a provider's refusal), `quota` or `credential`. `outcomes`
// hold every scenario the round selected, pre-pass ones included, by id,
// outcome and reason code; no event carries scenario or runner text.
// `evidenceBytes` is what the round archived. A round whose scenarios the
// pre-pass settled is one event with `invocation: 0` and no agent fields.
// `review-round.scenarios` counts the round's scenarios, and `rejectingPass`
// may be `scenarios`; when both passes rejected it is `correctness` and
// `rejectingPasses` names both. `correctness` stays the white-box verdict.
// A new kind and new optional fields, so no bump.
//
// `adjudication.pass` is `scenarios` for a verifier report of scenario units
// alone (#239), and `correctness` for one with a white-box unit. Whenever a
// scenario unit was ruled, `rulings` holds every unit's ruling by unit id,
// and `ruling` is UPHELD when any of them is. A re-verify, which follows
// when every unit was overruled but the white-box review produced nothing,
// closes the round it re-verifies with a second `review-round`. A new value
// and a new optional field, so no bump.
//
// `standalone-step` (#247, standalone-steps.ts) is one early run of a gate
// step marked `standalone`, beside the quality listers (`mode: list`) or
// beside a verify (`mode: verify`, with its `fixRound`), in a copy of the
// step's container at `head`. `result` is `passed`, `failed`, `timed-out` or
// `unavailable`; `exitCode` is null unless the step exited, and `detail`,
// why it was unavailable, null otherwise. `log` names the fan-out's one log
// file. Only a failed run was a finding; none was a verdict. A new kind, so
// no bump.
//
// A reader accepts exactly EVENT_SCHEMA_VERSION. There is deliberately no
// migration layer for the retired orchestrator.log/plans.jsonl pair or for an
// older event schema: old driver runs are unreadable by this UI, visibly and
// immediately, rather than being guessed into a state they never recorded.
// `parseEventLines` is the version-blind half of that read; the scorecard's
// per-version normalisers (`stats-record.ts`) start from it.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ChunkBlockReason } from "./chunks.js";
import type { DbBaseEvent, DbCopyEvent } from "./db-copy-policy.js";
import type { DeployEvent } from "./deploy-watch.js";
import type { ExitTag } from "./exit-conditions.js";
import type { FinalizeAction, FinalizeInput } from "./finalize.js";
import type { IssueBranchOriginSync, QualityResidue } from "./git-ops.js";
import type { QualityOutcome, Verdict } from "./inner-loop-machine.js";
import type { JanitorOutcome } from "./janitor-plan.js";
import type { RestartDueReason } from "./scheduler.js";
import type { StackClassification } from "./stack-change.js";
import type { StandaloneStepOutcome } from "./standalone-steps.js";
import type { AgentRunEndedBy } from "./agent-sandbox.js";
import type { ContainerResources } from "./container-resources.js";
import type { EgressCounts, EgressMode, EgressRefusal } from "./egress-policy.js";
import type { ScenarioRoundOutcome, ScenarioTally, UnverifiedReason } from "./verifier.js";
import {
  createTranscriptTree,
  type TranscriptTree,
} from "./logs.js";

export const EVENT_SCHEMA_VERSION = 6;

export class EventRecordReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EventRecordReadError";
  }
}

export class UnsupportedEventSchemaError extends EventRecordReadError {
  constructor(path: string, version: unknown) {
    super(
      `Unsupported sandbar event schema ${String(version)} in ${path}; ` +
        `this driver reads schema ${EVENT_SCHEMA_VERSION}.`,
    );
    this.name = "UnsupportedEventSchemaError";
  }
}

export type RecomputeTrigger =
  | "launch"
  | "slot-freed"
  | "landing-finished"
  | "terminal-finalized"
  | "janitor-finished"
  | "poll";

export type EventIssue = {
  readonly issue: number;
  readonly title?: string;
};

// Whom an inner-loop event is about (#205): an issue, or an idle janitor
// task by name. Every kind the inner loop emits on a janitor run carries
// this; the kinds a janitor run never reaches keep `EventIssue`.
export type EventSubject =
  | EventIssue
  | { readonly janitor: string; readonly title?: string };

export type TitledEventIssue = {
  readonly issue: number;
  readonly title: string;
};

export type IssuePhase =
  | "anchor"
  | "partition-check"
  | "ui-check"
  | "implementer"
  | "quality"
  | "gate-1"
  | "scenarios"
  | "review"
  | "adjudication";

export type ScenarioWriterResult =
  | "completed"
  | "failed"
  | "wrote"
  | "input-too-large"
  | "quota"
  | "credential"
  | "aborted";

export type ScenarioRunnerResult =
  | "completed"
  | "failed"
  | "wrote"
  | "input-too-large"
  | "quota"
  | "credential";

// One scenario's outcome as the record keeps it: codes, never text.
export type ScenarioOutcomeRecord = {
  readonly id: string;
  readonly outcome: ScenarioRoundOutcome["outcome"];
  readonly reason?: UnverifiedReason;
};

export type RejectingPass = "correctness" | "scenarios";

// One verifier unit's ruling (#239), by unit id: `white-box` or `S<n>`.
export type UnitRuling = { readonly unit: string; readonly ruling: "UPHELD" | "OVERRULED" };

export type HeldReason = ChunkBlockReason | "drifted-branches";

export type WaitingReason =
  | { readonly kind: "blocked"; readonly by: readonly number[] }
  | {
      readonly kind: "chunk-refresh";
      readonly branch: string;
      readonly by: readonly number[];
    }
  | { readonly kind: "no-slot" }
  // `why` is the chunk-derivation reason, or `drifted-branches` when several
  // origin chunk branches name the issue's root. Optional: records written
  // before it existed carry none.
  | { readonly kind: "held"; readonly why?: HeldReason }
  | { readonly kind: "ongoing" }
  | { readonly kind: "label-actor"; readonly actor: string | null };

export type RecomputeWaiting = TitledEventIssue & {
  readonly reason: WaitingReason;
};

export type RecomputeCandidate = TitledEventIssue & {
  readonly branch: string;
  readonly chunk: string | null;
  readonly ready: boolean;
};

export type CachedIssueRef = {
  readonly issue: number;
  readonly branch: string;
  readonly tip: string;
};

export type ComplaintSubject = {
  readonly kind: "closed-issue-branch";
  readonly issue: number;
  readonly branch: string;
};

export type UsageFields = {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly apiMs?: number;
  readonly resolvedModel?: string;
  readonly models?: number;
  readonly terminalReason?: string;
  readonly toolCalls?: number;
  readonly peakContext?: number;
  readonly firstContext?: number;
  readonly contextChars?: number;
  readonly quota?: {
    readonly status: "allowed" | "allowed_warning" | "rejected";
    readonly window: string;
    readonly utilization?: number;
    readonly resetsAt?: number;
  };
};

// How the anchor step ended (#217). The last five fell back to the uncondensed
// thread; `wrote` parked the issue.
export type IssueAnchorResult =
  | "below-threshold"
  | "cache-hit"
  | "condensed"
  | "unparseable"
  | "failed"
  | "quota"
  | "credential"
  | "input-too-large"
  | "wrote";

// The machine's typed reason for a parking terminal (`Verdict`), recorded
// beside its prose `reason`.
export type TerminalCause = Extract<Verdict, { readonly cause: string }>["cause"];

export type GateStepEvent = ContainerResources & {
  readonly ok: boolean;
  readonly durationMs: number;
};

// What one quality fixer invocation did (#185, #187). Its text is ignored, so
// its record is its commits and the residue the host settled after it exited
// (git-ops.ts, `settleQualityResidue`). A provider closure or size refusal
// ends the pass before that settlement, so those results carry neither.
export type QualityPassEvent =
  | {
      readonly result: "completed" | "failed";
      readonly commits: readonly string[];
      readonly discarded: QualityResidue;
    }
  | { readonly result: "input-too-large" | "quota" | "credential" };

// One quality lister or verify invocation (#187). `scope` is what it was told
// to read: the whole branch, or the lines since a sha (the last approved
// quality head for a lister, the head before the fixer for a verify).
// `group` is a lister's rule group id (#204), absent on a verify and on
// records from before the fan-out.
// `verdict` is null when the invocation produced none; `prose` is its output.
export type QualityReviewEvent = {
  readonly mode: "list" | "verify";
  readonly group?: string;
  readonly scope: "full" | `since:${string}`;
  readonly result: "completed" | "failed" | "input-too-large" | "quota" | "credential";
  readonly verdict: "APPROVED" | "CHANGES-REQUESTED" | null;
  readonly prose: string;
};

// One early run of a standalone step (#247), beside the listers or a verify.
export type StandaloneStepEvent = ContainerResources & {
  readonly attempt: number;
  readonly round: number;
  readonly step: string;
  readonly container: string;
  readonly image: string;
  readonly head: string;
  readonly result: StandaloneStepOutcome["result"];
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly detail: string | null;
  readonly log: string;
} & ({ readonly mode: "list" } | { readonly mode: "verify"; readonly fixRound: number });

// Which network owner an egress proxy served (#202). A gate stack's subject
// is absent for the merger's gate-2 stack, as a resolve container's is.
export type EgressSubject = {
  readonly stack: "sandbox" | "gate" | "resolve";
} & Partial<EventSubject>;

export type EgressSummaryEvent = ContainerResources & {
  readonly mode: EgressMode;
  readonly allowed: EgressCounts;
  readonly refused: EgressCounts;
  readonly upstreamErrors: EgressCounts;
  readonly durationMs: number;
};

export type LandRequestStatus =
  | {
      readonly kind: "landing";
      readonly step: "merge" | "gate-2" | "push";
      readonly reason: string;
    }
  | { readonly kind: "queued" | "deferred"; readonly reason: string };

export type LandRequestEvent = {
  readonly pullRequest: number;
  readonly branch: string;
  readonly title: string;
  readonly members: readonly number[];
  readonly status: LandRequestStatus;
};

export type ChunkLandingEvent = {
  readonly pullRequest: number;
  readonly title: string;
  readonly members: readonly number[];
};

export type EventInput =
  | {
      readonly kind: "run-start";
      readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
      readonly driver: string;
      readonly configPath: string | null;
      readonly workdir: string;
      readonly maxParallelIssues: number;
      readonly pid: number;
    }
  | { readonly kind: "wake-lock"; readonly state: "held" | "refused" | "lost" | "released"; readonly detail: string }
  | {
      readonly kind: "restart-requested";
      readonly detail: string;
      readonly urgent?: true;
      // Exactly one of these on a current record: a request first seen while
      // the pool is busy is deferred, and a second event says when and why it
      // became due (`restartDueReason`, scheduler.ts). Records written before
      // the deferral carry neither and were always draining.
      readonly deferredUntil?: string;
      readonly due?: RestartDueReason;
    }
  | { readonly kind: "idle"; readonly pollIntervalMs: number }
  | { readonly kind: "preflight"; readonly action: string; readonly detail: string }
  | { readonly kind: "sweep"; readonly scope: "startup" | "quiescent"; readonly removed: readonly string[]; readonly failures: readonly string[] }
  | { readonly kind: "image"; readonly action: "built" | "reused"; readonly image: string; readonly durationMs: number; readonly detail: string }
  | { readonly kind: "landing-batch"; readonly n: number; readonly durationMs: number }
  | ({ readonly kind: "land-request" } & LandRequestEvent)
  | {
      readonly kind: "recompute";
      readonly n: number;
      readonly trigger: RecomputeTrigger;
      readonly admitted: readonly TitledEventIssue[];
      readonly active: readonly TitledEventIssue[];
      readonly waiting: readonly RecomputeWaiting[];
      readonly landRequests: readonly string[];
      readonly deferredChunks: readonly string[];
      readonly candidates: readonly RecomputeCandidate[];
      readonly refs: readonly CachedIssueRef[];
    }
  | { readonly kind: "follow-up"; readonly action: "route" | "re-queued" | "lane-override"; readonly detail: string; readonly issue?: number; readonly title?: string }
  | { readonly kind: "reconcile"; readonly action: "trace" | "landed-chunk" | "land-requested" | "chunk-refreshed" | "chunk-refresh-failed"; readonly detail: string }
  | { readonly kind: "notice"; readonly message: string }
  | DeployEvent
  | {
      readonly kind: "janitor-start";
      readonly task: string;
      readonly branch: string;
      // The sha the run's commits are measured from.
      readonly base: string;
      readonly fresh: boolean;
      readonly scope: readonly string[];
      readonly runsToday: number;
      readonly runsPerDay: number;
    }
  | {
      readonly kind: "janitor-run";
      readonly task: string;
      readonly branch: string;
      readonly outcome: JanitorOutcome;
      readonly cause?: string;
      readonly commits?: number;
      readonly pullRequest?: number;
      readonly scope: readonly string[];
      readonly durationMs: number;
    }
  | {
      readonly kind: "janitor-land";
      readonly task: string;
      readonly branch: string;
      // 0 when the branch had no pull request to act on.
      readonly pullRequest: number;
      readonly outcome: "landed" | "parked" | "reconciled";
      // Why a `parked` one did not land.
      readonly reason?: string;
      readonly durationMs: number;
    }
  | DbBaseEvent
  | DbCopyEvent
  | {
      readonly kind: "complaint";
      readonly severity: "warning" | "error";
      readonly message: string;
      // Present only when the complaint is also the canonical UI surface for
      // an entity that must not be inferred into another section (#179).
      readonly subject?: ComplaintSubject;
    }
  | { readonly kind: "exit"; readonly tag: ExitTag; readonly reason: string; readonly exitCode: number }
  | { readonly kind: "run-end"; readonly reason: string }
  | (TitledEventIssue & { readonly kind: "admitted"; readonly branch: string; readonly chunk: string | null; readonly seedRef: string; readonly seedSha?: string; readonly issueSnapshot?: string })
  | (EventIssue & { readonly kind: "origin-sync"; readonly outcome: IssueBranchOriginSync["kind"]; readonly detail: string })
  | (EventSubject & { readonly kind: "phase"; readonly attempt: number; readonly phases: readonly IssuePhase[] })
  | (EventSubject & { readonly kind: "setup"; readonly durationMs: number; readonly worktreeMs?: number; readonly sandboxMs?: number; readonly stackMs?: number; readonly detail?: string })
  | (EventIssue & ContainerResources & { readonly kind: "issue-anchor"; readonly result: IssueAnchorResult; readonly rawChars: number; readonly tracedChars: number; readonly anchorChars: number; readonly comments: number; readonly dropped: number; readonly provider?: string; readonly model?: string; readonly effort?: string | null; readonly durationMs?: number; readonly endedBy?: AgentRunEndedBy; readonly transcript?: string; readonly usage?: UsageFields })
  | (EventIssue & ContainerResources & { readonly kind: "ui-check"; readonly invocation: number; readonly provider: string; readonly model: string; readonly effort: string | null; readonly durationMs: number; readonly endedBy?: AgentRunEndedBy; readonly transcript?: string; readonly maxGapMs?: number; readonly result: "CLEAR" | "PROTOTYPE-NEEDED" | "NO-SIGNAL" | "wrote" | "input-too-large" | "quota" | "credential" | "failed"; readonly usage?: UsageFields })
  | (EventIssue & ContainerResources & { readonly kind: "scenario-writer"; readonly invocation: number; readonly provider: string; readonly model: string; readonly effort: string | null; readonly durationMs?: number; readonly endedBy?: AgentRunEndedBy; readonly transcript?: string; readonly maxGapMs?: number; readonly result: ScenarioWriterResult; readonly scenarios?: number; readonly usage?: UsageFields })
  | (EventSubject & ContainerResources & { readonly kind: "scenario-runner"; readonly attempt: number; readonly round: number; readonly invocation: number; readonly provider?: string; readonly model?: string; readonly effort?: string | null; readonly durationMs?: number; readonly endedBy?: AgentRunEndedBy; readonly transcript?: string; readonly maxGapMs?: number; readonly result: ScenarioRunnerResult; readonly outcomes?: readonly ScenarioOutcomeRecord[]; readonly evidenceBytes?: number; readonly usage?: UsageFields })
  | (EventIssue & ContainerResources & { readonly kind: "partition-check"; readonly invocation: number; readonly provider: string; readonly model: string; readonly effort: string | null; readonly durationMs: number; readonly endedBy?: AgentRunEndedBy; readonly transcript?: string; readonly result: "CLEAR" | "PARTITION" | "NO-SIGNAL" | "wrote" | "input-too-large" | "quota" | "credential" | "failed"; readonly usage?: UsageFields })
  | (EventSubject & ContainerResources & { readonly kind: "implementer"; readonly attempt: number; readonly signal: "COMPLETE" | "NEEDS-INFO" | "NEEDS-UI-PROTOTYPE" | "NO-SIGNAL" | "QUOTA" | "CREDENTIAL" | "FAILED"; readonly commits?: number; readonly provider: string; readonly model: string; readonly effort: string | null; readonly durationMs: number; readonly endedBy?: AgentRunEndedBy; readonly transcript?: string; readonly signalMs?: number; readonly maxGapMs?: number; readonly usage?: UsageFields })
  | (EventSubject & { readonly kind: "gate-stack"; readonly gate: "gate-1"; readonly tipBlob: string | null; readonly classification: StackClassification["kind"]; readonly containers?: readonly string[] })
  | (EventSubject & { readonly kind: "gate"; readonly attempt: number; readonly gate: "gate-1"; readonly ok: boolean; readonly durationMs: number; readonly queuedMs?: number; readonly steps?: Readonly<Record<string, GateStepEvent>> })
  | (EventSubject & { readonly kind: "gate"; readonly gate: "gate-2"; readonly ok: boolean; readonly durationMs: number; readonly queuedMs?: number; readonly steps?: Readonly<Record<string, GateStepEvent>> })
  | (EventSubject & ContainerResources & QualityReviewEvent & { readonly kind: "quality-review"; readonly attempt: number; readonly round: number; readonly invocation: number; readonly provider: string; readonly model: string; readonly effort: string | null; readonly durationMs: number; readonly endedBy?: AgentRunEndedBy; readonly transcript?: string; readonly maxGapMs?: number; readonly usage?: UsageFields })
  | (EventSubject & StandaloneStepEvent & { readonly kind: "standalone-step" })
  | (EventSubject & ContainerResources & QualityPassEvent & { readonly kind: "quality-pass"; readonly attempt: number; readonly round: number; readonly provider: string; readonly model: string; readonly effort: string | null; readonly durationMs: number; readonly endedBy?: AgentRunEndedBy; readonly transcript?: string; readonly maxGapMs?: number; readonly usage?: UsageFields })
  | (EventSubject & ContainerResources & { readonly kind: "review-pass"; readonly attempt: number; readonly round: number; readonly invocation: number; readonly provider: string; readonly model: string; readonly effort: string | null; readonly result: "completed" | "failed" | "input-too-large" | "quota" | "credential"; readonly durationMs: number; readonly endedBy?: AgentRunEndedBy; readonly transcript?: string; readonly maxGapMs?: number; readonly usage?: UsageFields })
  | (EventSubject & ContainerResources & { readonly kind: "adjudication"; readonly pass: "quality" | "correctness" | "scenarios"; readonly attempt: number; readonly round: number; readonly head: string; readonly ruling: "UPHELD" | "OVERRULED"; readonly rulings?: readonly UnitRuling[]; readonly provider: string; readonly model: string; readonly effort: string | null; readonly durationMs: number; readonly endedBy?: AgentRunEndedBy; readonly transcript?: string; readonly maxGapMs?: number; readonly usage?: UsageFields })
  | (EventSubject & ContainerResources & { readonly kind: "resolve-attempt"; readonly attempt: number; readonly container: string; readonly end: "exit" | "timeout" | "signal" | "spawn-error"; readonly exitCode: number | null; readonly signal: string | null; readonly durationMs: number; readonly provider?: string; readonly model?: string; readonly usage?: UsageFields })
  | (EgressSubject & EgressRefusal & { readonly kind: "egress-refused" })
  | (EgressSubject & EgressSummaryEvent & { readonly kind: "egress" })
  | (ContainerResources & { readonly kind: "container"; readonly stack: "gate" | "sandbox"; readonly name: string; readonly container: string; readonly lifecycle: "issue" | "attempt"; readonly durationMs: number } & Partial<EventSubject>)
  | (EventSubject & { readonly kind: "review-round"; readonly attempt: number; readonly round: number; readonly head: string; readonly quality: QualityOutcome["verdict"]; readonly qualityRounds: number; readonly gateOk: boolean; readonly correctness: "APPROVED" | "CHANGES-REQUESTED" | "SKIPPED" | "HARNESS-FAILED"; readonly rejectingPass: RejectingPass | null; readonly rejectingPasses?: readonly RejectingPass[]; readonly scenarios?: ScenarioTally; readonly gateFailures: number; readonly correctnessFailures: number; readonly durationMs: number })
  | (EventSubject & { readonly kind: "repair"; readonly attempt: number; readonly action: "fast-forward" | "re-prompt" | "promise-nudge"; readonly detail: string })
  | (EventSubject & { readonly kind: "hard-error"; readonly retry: number; readonly max: number; readonly reason: string })
  | (EventIssue & { readonly kind: "terminal"; readonly terminal: "DONE" | "NEEDS-INFO" | "NEEDS-UI-PROTOTYPE" | "NEEDS-PARTITION" | "NEEDS-HUMAN" | "NEEDS-HUMAN-REVIEW" | "NEEDS-STACK-CHANGE" | "HARD-ERROR" | "QUOTA" | "CREDENTIAL" | "REJECTED"; readonly reason: string | null; readonly cause?: TerminalCause; readonly specGaps?: number; readonly durationMs: number })
  | (EventIssue & { readonly kind: "landed"; readonly outcome: "merged" | "chunk-landed" | "skipped"; readonly branch: string; readonly target: string | null; readonly reason: string | null; readonly durationMs: number })
  | ({ readonly kind: "landed"; readonly outcome: "chunk-on-source"; readonly branch: string; readonly target: string; readonly reason: null; readonly durationMs: number } & ChunkLandingEvent)
  | ({ readonly kind: "landed"; readonly outcome: "chunk-parked" | "chunk-deferred"; readonly branch: string; readonly target: null; readonly reason: string; readonly durationMs: number } & ChunkLandingEvent)
  | (EventIssue & { readonly kind: "finalise"; readonly finaliseKind: FinalizeInput["kind"]; readonly outcome: FinalizeAction["kind"]; readonly detail?: string });

export type RunEvent = EventInput & {
  readonly seq: number;
  readonly ts: string;
};

// Every recorded event but those naming a janitor task (#205).
export type IssueRunEvent = Exclude<RunEvent, { readonly janitor: string }>;

export type EventRecord = TranscriptTree & {
  readonly eventsPath: string;
  emit(event: EventInput): Promise<RunEvent>;
  finalize(reason: string): Promise<void>;
};

export function runStampFromDate(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export type StartEventRecordOptions = {
  readonly baseDir: string;
  readonly now?: Date;
  readonly clock?: () => Date;
  readonly append?: (path: string, data: string) => Promise<void>;
  readonly start: Omit<Extract<EventInput, { kind: "run-start" }>, "kind" | "schemaVersion">;
};

export async function startEventRecord(
  options: StartEventRecordOptions,
): Promise<EventRecord> {
  const clock = options.clock ?? (() => new Date());
  const append = options.append ?? appendFile;
  const runDir = join(options.baseDir, `run-${runStampFromDate(options.now ?? clock())}`);
  await mkdir(runDir, { recursive: true });
  const transcripts = await createTranscriptTree(runDir);
  const eventsPath = join(runDir, "events.jsonl");
  let seq = 0;
  let tail: Promise<void> = Promise.resolve();
  let finalized = false;
  let finalizing: Promise<void> | null = null;

  const emit = async (input: EventInput): Promise<RunEvent> => {
    const write = tail.then(async () => {
      const event = { ...input, seq: seq + 1, ts: clock().toISOString() } as RunEvent;
      await append(eventsPath, `${JSON.stringify(event)}\n`);
      seq += 1;
      return event;
    });
    // `tail` is only the serialization latch. The caller still receives this
    // emission's rejection through `write`, while the recovered latch permits
    // a later append to retry after a transient filesystem failure.
    tail = write.then(() => undefined, () => undefined);
    return await write;
  };

  const record: EventRecord = {
    ...transcripts,
    eventsPath,
    emit,
    async finalize(reason) {
      if (finalized) return;
      if (finalizing !== null) return await finalizing;
      finalizing = emit({ kind: "run-end", reason }).then(
        () => {
          finalized = true;
        },
        (err: unknown) => {
          finalizing = null;
          throw err;
        },
      );
      await finalizing;
    },
  };
  await emit({
    kind: "run-start",
    schemaVersion: EVENT_SCHEMA_VERSION,
    ...options.start,
  });
  return record;
}

export async function readEventsFile(path: string): Promise<readonly RunEvent[]> {
  const { schemaVersion, events } = parseEventLines(await readFile(path, "utf8"), path);
  if (schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new UnsupportedEventSchemaError(path, schemaVersion);
  }
  return events as readonly RunEvent[];
}

// One record's committed lines as objects, with the line, run-start and
// sequence checks every reader shares. Which schema `schemaVersion` names,
// and so what the objects are, is the caller's to judge.
export function parseEventLines(
  body: string,
  path: string,
): {
  readonly schemaVersion: unknown;
  readonly events: readonly Readonly<Record<string, unknown>>[];
} {
  // A live reader may overlap the append syscall. Only newline-terminated
  // records are committed; an unterminated tail is either that instant or the
  // last interrupted write of a crashed run, and the prior events remain the
  // truthful state in both cases.
  const committed = body.endsWith("\n")
    ? body
    : body.slice(0, body.lastIndexOf("\n") + 1);
  const lines = committed.split("\n").filter((line) => line.length > 0);
  const events = lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      throw new EventRecordReadError(
        `Invalid event JSON at line ${index + 1} of ${path}`,
        { cause },
      );
    }
    if (typeof value !== "object" || value === null) {
      throw new EventRecordReadError(`Invalid event object at line ${index + 1} of ${path}`);
    }
    return value as Readonly<Record<string, unknown>>;
  });
  const first = events[0];
  if (!first || first.kind !== "run-start") {
    throw new EventRecordReadError(`Run record ${path} does not begin with run-start`);
  }
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]?.seq !== i + 1) {
      throw new EventRecordReadError(
        `Non-monotonic event sequence at line ${i + 1} of ${path}`,
      );
    }
  }
  return { schemaVersion: first.schemaVersion, events };
}
