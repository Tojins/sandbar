// The single structured record for a sandbar run (#132).
//
// Every fact after the workdir lock is won is appended to `events.jsonl` as a
// typed event. `seq` is allocated synchronously and writes are chained, so the
// file order is the event order even when issue tasks finish concurrently.
// `ts` is wall-clock display data only; no decision reads it. Raw subprocess
// transcripts remain separate files through `logs.ts`.
//
// A reader accepts exactly EVENT_SCHEMA_VERSION. There is deliberately no
// migration layer for the retired orchestrator.log/plans.jsonl pair or for an
// older event schema: old driver runs are unreadable by this UI, visibly and
// immediately, rather than being guessed into a state they never recorded.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExitTag } from "./exit-conditions.js";
import type { FinalizeAction, FinalizeInput } from "./finalize.js";
import {
  createTranscriptTree,
  type TranscriptTree,
} from "./logs.js";

export const EVENT_SCHEMA_VERSION = 1;

export class UnsupportedEventSchemaError extends Error {
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
  | "terminal-finalized";

export type EventIssue = {
  readonly issue: number;
  readonly title?: string;
};

export type TitledEventIssue = {
  readonly issue: number;
  readonly title: string;
};

export type IssuePhase = "ui-check" | "implementer" | "gate-1" | "review";

export type WaitingReason =
  | { readonly kind: "blocked"; readonly by: readonly number[] }
  | { readonly kind: "no-slot" }
  | { readonly kind: "held" }
  | { readonly kind: "ongoing" };

export type RecomputeWaiting = EventIssue & {
  readonly reason: WaitingReason;
};

export type RecomputeCandidate = EventIssue & {
  readonly branch: string;
  readonly chunk: string | null;
  readonly ready: boolean;
};

export type CachedIssueRef = {
  readonly issue: number;
  readonly branch: string;
  readonly tip: string;
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
  readonly quota?: {
    readonly status: "allowed" | "allowed_warning" | "rejected";
    readonly window: string;
    readonly utilization?: number;
    readonly resetsAt?: number;
  };
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
  | { readonly kind: "preflight"; readonly action: string; readonly detail: string }
  | { readonly kind: "sweep"; readonly scope: "startup" | "quiescent"; readonly removed: readonly string[]; readonly failures: readonly string[] }
  | { readonly kind: "image"; readonly action: string; readonly image: string; readonly durationMs?: number; readonly detail: string }
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
  | { readonly kind: "reconcile"; readonly action: "trace" | "landed-chunk" | "land-requested"; readonly detail: string }
  | { readonly kind: "complaint"; readonly severity: "warning" | "error"; readonly message: string }
  | { readonly kind: "exit"; readonly tag: ExitTag; readonly reason: string; readonly exitCode: number }
  | { readonly kind: "run-end"; readonly reason: string }
  | (TitledEventIssue & { readonly kind: "admitted"; readonly branch: string; readonly chunk: string | null; readonly seedRef: string })
  | (EventIssue & { readonly kind: "phase"; readonly attempt: number; readonly phases: readonly IssuePhase[] })
  | (EventIssue & { readonly kind: "setup"; readonly durationMs: number; readonly worktreeMs?: number; readonly sandboxMs?: number; readonly stackMs?: number; readonly detail?: string })
  | (EventIssue & { readonly kind: "ui-check"; readonly invocation: number; readonly provider: string; readonly model: string; readonly effort: string | null; readonly durationMs: number; readonly maxGapMs?: number; readonly result: "CLEAR" | "PROTOTYPE-NEEDED" | "NO-SIGNAL" | "wrote" | "quota" | "failed"; readonly usage?: UsageFields })
  | (EventIssue & { readonly kind: "implementer"; readonly attempt: number; readonly signal: "COMPLETE" | "NEEDS-INFO" | "NEEDS-UI-PROTOTYPE" | "NO-SIGNAL" | "QUOTA"; readonly commits: number; readonly provider: string; readonly model: string; readonly effort: string | null; readonly durationMs: number; readonly signalMs?: number; readonly maxGapMs?: number; readonly usage?: UsageFields })
  | (EventIssue & { readonly kind: "gate"; readonly attempt: number; readonly gate: "gate-1"; readonly ok: boolean; readonly durationMs: number; readonly steps?: Readonly<Record<string, number>> })
  | (EventIssue & { readonly kind: "gate"; readonly gate: "gate-2"; readonly ok: boolean; readonly durationMs: number; readonly steps?: Readonly<Record<string, number>> })
  | (EventIssue & { readonly kind: "review-pass"; readonly attempt: number; readonly round: number; readonly pass: "quality" | "correctness"; readonly invocation: number; readonly provider: string; readonly model: string; readonly effort: string | null; readonly durationMs: number; readonly maxGapMs?: number; readonly usage?: UsageFields })
  | (EventIssue & { readonly kind: "review-round"; readonly attempt: number; readonly round: number; readonly head: string; readonly qualityMode: "list" | "verify"; readonly gateOk: boolean; readonly quality: "APPROVED" | "CHANGES-REQUESTED" | "HARNESS-FAILED"; readonly correctness: "APPROVED" | "CHANGES-REQUESTED" | "SKIPPED" | "HARNESS-FAILED"; readonly rejectingPass: "quality" | "correctness" | null; readonly qualityFailures: number; readonly correctnessFailures: number; readonly durationMs: number })
  | (EventIssue & { readonly kind: "repair"; readonly attempt: number; readonly action: "fast-forward" | "re-prompt" | "promise-nudge"; readonly detail: string })
  | (EventIssue & { readonly kind: "hard-error"; readonly retry: number; readonly max: number; readonly reason: string })
  | (EventIssue & { readonly kind: "terminal"; readonly terminal: "DONE" | "NEEDS-INFO" | "NEEDS-UI-PROTOTYPE" | "NEEDS-HUMAN" | "NEEDS-HUMAN-REVIEW" | "HARD-ERROR" | "QUOTA"; readonly reason: string | null; readonly durationMs: number })
  | (EventIssue & { readonly kind: "landed"; readonly outcome: "merged" | "chunk-landed" | "skipped"; readonly branch: string; readonly target: string | null; readonly reason: string | null; readonly durationMs: number })
  | { readonly kind: "landed"; readonly outcome: "chunk-on-source" | "chunk-parked" | "chunk-deferred"; readonly branch: string; readonly target: string | null; readonly reason: string | null; readonly durationMs: number }
  | (EventIssue & { readonly kind: "finalise"; readonly finaliseKind: FinalizeInput["kind"]; readonly outcome: FinalizeAction["kind"]; readonly detail?: string });

export type RunEvent = EventInput & {
  readonly seq: number;
  readonly ts: string;
};

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
  readonly start: Omit<Extract<EventInput, { kind: "run-start" }>, "kind" | "schemaVersion">;
};

export async function startEventRecord(
  options: StartEventRecordOptions,
): Promise<EventRecord> {
  const clock = options.clock ?? (() => new Date());
  const runDir = join(options.baseDir, `run-${runStampFromDate(options.now ?? clock())}`);
  await mkdir(runDir, { recursive: true });
  const transcripts = await createTranscriptTree(runDir);
  const eventsPath = join(runDir, "events.jsonl");
  let seq = 0;
  let tail: Promise<void> = Promise.resolve();
  let finalized = false;

  const emit = async (input: EventInput): Promise<RunEvent> => {
    const event = { ...input, seq: ++seq, ts: clock().toISOString() } as RunEvent;
    tail = tail.then(() => appendFile(eventsPath, `${JSON.stringify(event)}\n`));
    await tail;
    return event;
  };

  const record: EventRecord = {
    ...transcripts,
    eventsPath,
    emit,
    async finalize(reason) {
      if (finalized) return;
      finalized = true;
      await emit({ kind: "run-end", reason });
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
  const body = await readFile(path, "utf8");
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
      throw new Error(`Invalid event JSON at line ${index + 1} of ${path}`, { cause });
    }
    if (typeof value !== "object" || value === null) {
      throw new Error(`Invalid event object at line ${index + 1} of ${path}`);
    }
    return value as RunEvent;
  });
  const first = events[0];
  if (!first || first.kind !== "run-start") {
    throw new Error(`Run record ${path} does not begin with run-start`);
  }
  if (first.schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new UnsupportedEventSchemaError(path, first.schemaVersion);
  }
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]?.seq !== i + 1) {
      throw new Error(`Non-monotonic event sequence at line ${i + 1} of ${path}`);
    }
  }
  return events;
}
