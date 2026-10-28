// The run scorecard's record reader (#194): a window of one installation's run
// directories, as the version-normalised fact stream `stats.ts` reduces.
//
// It reads `events.jsonl` only. Invocation logs are presentation, and their
// text is never a parse contract (#80). The one exception is `--with-prose`
// (#182): it lifts the `--- speech ---` section of the log an event's
// `transcript` names into the report verbatim, and reads nothing out of it.
// The section ends at the first `--- stdout tail ---` line after it, so a
// speech that quotes that line is cut there.
//
// `events.ts` reads exactly its own schema, which is right for the UI. A stats
// window routinely spans a schema bump, so this module owns STATS_SCHEMAS: one
// pure normaliser per version it knows, into the stats-owned `StatsEvent`.
// Any other version, a run with no `events.jsonl` (the retired
// orchestrator.log trees) and a record that fails to parse are listed in
// `skipped` whole, with the reason; a run's events are never partly counted.
// A kind the run's version does not define is counted in `ignoredKinds` and
// dropped, so a feature whose event lands before its reducer arm shows there.
//
// Schema 5 (#185) differs from 6 (#187) where the reducer reads: it has no
// `quality-review`, its `adjudication` always ruled on the correctness pass,
// and its `review-round` carries no quality outcome. The normaliser names the
// pass and leaves the quality fields absent.
//
// Nothing in the daemon imports this module: the scorecard is a report (#82).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { isErrno } from "./errors.js";
import { EventRecordReadError, parseEventLines, type RunEvent } from "./events.js";

export type StatsWindow = { readonly last: number } | { readonly since: string };

export const DEFAULT_STATS_WINDOW: StatsWindow = { last: 10 };

// The window that `--last N` or `--since YYYY-MM-DD` names, the last 10 runs
// when neither is given, or why the flags name none.
export function parseStatsWindow(flags: {
  readonly last?: string | undefined;
  readonly since?: string | undefined;
}): StatsWindow | { readonly error: string } {
  const { last, since } = flags;
  if (last !== undefined && since !== undefined) return { error: "--last and --since are exclusive" };
  if (last !== undefined) {
    return /^[1-9][0-9]*$/.test(last)
      ? { last: Number(last) }
      : { error: `--last wants a positive count, not ${last}` };
  }
  if (since !== undefined) {
    return /^\d{4}-\d{2}-\d{2}$/.test(since)
      ? { since }
      : { error: `--since wants YYYY-MM-DD, not ${since}` };
  }
  return DEFAULT_STATS_WINDOW;
}

type ReviewRound = Extract<RunEvent, { kind: "review-round" }>;

// The events the reducer reads: today's union, with each field that a
// supported older schema lacks made optional.
export type StatsEvent =
  | Exclude<RunEvent, { kind: "review-round" }>
  | (Omit<ReviewRound, "quality" | "qualityRounds"> &
    Partial<Pick<ReviewRound, "quality" | "qualityRounds">>);

export type StatsRun = {
  readonly run: string;
  readonly schemaVersion: number;
  readonly driver: string;
  readonly events: readonly StatsEvent[];
  // Speech by `<issue>/<transcript>`; empty unless prose was asked for.
  readonly prose: ReadonlyMap<string, string>;
};

export type SkippedRun = {
  readonly run: string;
  readonly reason: string;
  readonly schemaVersion?: number;
};

export type StatsInput = {
  readonly window: StatsWindow;
  readonly withProse: boolean;
  readonly runs: readonly StatsRun[];
  readonly skipped: readonly SkippedRun[];
  readonly ignoredKinds: Readonly<Record<string, number>>;
};

type RawEvent = Readonly<Record<string, unknown>>;

export type NormalizedEvents = {
  readonly events: readonly StatsEvent[];
  readonly ignoredKinds: Readonly<Record<string, number>>;
};

const V6_KINDS = {
  "run-start": true, "wake-lock": true, "restart-requested": true, idle: true,
  preflight: true, sweep: true, image: true, "landing-batch": true,
  "land-request": true, recompute: true, "follow-up": true, reconcile: true,
  notice: true, complaint: true, exit: true, "run-end": true, admitted: true,
  "origin-sync": true, phase: true, setup: true, "ui-check": true,
  "partition-check": true, implementer: true, "gate-stack": true, gate: true,
  "quality-review": true, "quality-pass": true, "review-pass": true, adjudication: true,
  "resolve-attempt": true, container: true, "review-round": true, repair: true,
  "hard-error": true, terminal: true, landed: true, finalise: true, deploy: true,
} as const satisfies Record<RunEvent["kind"], true>;

const knownKinds = (
  raw: readonly RawEvent[],
  kinds: ReadonlySet<string>,
): { readonly known: readonly RawEvent[]; readonly ignoredKinds: Record<string, number> } => {
  const ignoredKinds: Record<string, number> = {};
  const known = raw.filter((event) => {
    const kind = String(event.kind);
    if (kinds.has(kind)) return true;
    ignoredKinds[kind] = (ignoredKinds[kind] ?? 0) + 1;
    return false;
  });
  return { known, ignoredKinds };
};

const V6_KIND_SET: ReadonlySet<string> = new Set(Object.keys(V6_KINDS));
const V5_KIND_SET: ReadonlySet<string> = new Set(
  Object.keys(V6_KINDS).filter((kind) => kind !== "quality-review"),
);

export function normalizeV6(raw: readonly RawEvent[]): NormalizedEvents {
  const { known, ignoredKinds } = knownKinds(raw, V6_KIND_SET);
  return { events: known as readonly StatsEvent[], ignoredKinds };
}

type V5Adjudication = Omit<Extract<StatsEvent, { kind: "adjudication" }>, "pass">;
type V5Event =
  | Exclude<StatsEvent, { kind: "adjudication" | "quality-review" }>
  | V5Adjudication;

export function normalizeV5(raw: readonly RawEvent[]): NormalizedEvents {
  const { known, ignoredKinds } = knownKinds(raw, V5_KIND_SET);
  return {
    events: (known as readonly V5Event[]).map((event): StatsEvent =>
      event.kind === "adjudication" ? { ...event, pass: "correctness" } : event
    ),
    ignoredKinds,
  };
}

const STATS_SCHEMAS: Readonly<Record<number, (raw: readonly RawEvent[]) => NormalizedEvents>> = {
  5: normalizeV5,
  6: normalizeV6,
};

// The run directories a window covers, oldest first. A run directory is named
// `run-<stamp>` (`events.ts`), and the stamp sorts as the time it encodes.
export function selectRuns(
  dirNames: readonly string[],
  window: StatsWindow,
): readonly string[] {
  const runs = dirNames.filter((name) => name.startsWith("run-")).sort();
  return "last" in window
    ? runs.slice(Math.max(0, runs.length - window.last))
    : runs.filter((name) => name.slice("run-".length) >= window.since);
}

export async function readStatsInput(
  logsDir: string,
  window: StatsWindow,
  options: { readonly withProse: boolean },
): Promise<StatsInput> {
  const read = await Promise.all(
    selectRuns(await runDirectoryNames(logsDir), window)
      .map((run) => readStatsRun(join(logsDir, run), run, options.withProse)),
  );
  const ignoredKinds: Record<string, number> = {};
  const runs: StatsRun[] = [];
  const skipped: SkippedRun[] = [];
  for (const result of read) {
    if (result.kind === "skipped") {
      skipped.push(result.skipped);
      continue;
    }
    runs.push(result.run);
    for (const [kind, count] of Object.entries(result.ignoredKinds)) {
      ignoredKinds[kind] = (ignoredKinds[kind] ?? 0) + count;
    }
  }
  return { window, withProse: options.withProse, runs, skipped, ignoredKinds };
}

// A logs directory that does not exist yet holds no runs.
async function runDirectoryNames(logsDir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(logsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (err) {
    if (isErrno(err, "ENOENT")) return [];
    throw err;
  }
}

type ReadRun =
  | { readonly kind: "read"; readonly run: StatsRun; readonly ignoredKinds: Readonly<Record<string, number>> }
  | { readonly kind: "skipped"; readonly skipped: SkippedRun };

async function readStatsRun(dir: string, run: string, withProse: boolean): Promise<ReadRun> {
  const path = join(dir, "events.jsonl");
  let parsed: ReturnType<typeof parseEventLines>;
  try {
    parsed = parseEventLines(await readFile(path, "utf8"), path);
  } catch (err) {
    const reason = isErrno(err, "ENOENT")
      ? "no events.jsonl"
      : err instanceof EventRecordReadError ? err.message : null;
    if (reason === null) throw err;
    return { kind: "skipped", skipped: { run, reason } };
  }
  const { schemaVersion } = parsed;
  const normalize = typeof schemaVersion === "number" ? STATS_SCHEMAS[schemaVersion] : undefined;
  if (typeof schemaVersion !== "number" || normalize === undefined) {
    return {
      kind: "skipped",
      skipped: {
        run,
        reason: `unsupported event schema ${String(schemaVersion)}`,
        ...(typeof schemaVersion === "number" ? { schemaVersion } : {}),
      },
    };
  }
  const { events, ignoredKinds } = normalize(parsed.events);
  // `parseEventLines` guarantees the first event is run-start, and the normalisers keep it.
  const start = events[0] as Extract<StatsEvent, { kind: "run-start" }>;
  return {
    kind: "read",
    run: {
      run,
      schemaVersion,
      driver: start.driver,
      events,
      prose: withProse ? await readProse(dir, events) : new Map(),
    },
    ignoredKinds,
  };
}

export const proseKey = (issue: number, transcript: string): string => `${issue}/${transcript}`;

async function readProse(
  dir: string,
  events: readonly StatsEvent[],
): Promise<ReadonlyMap<string, string>> {
  const keys = new Map<string, string>();
  for (const event of events) {
    if (!("transcript" in event) || event.transcript === undefined) continue;
    keys.set(proseKey(event.issue, event.transcript), join(dir, `issue-${event.issue}`, event.transcript));
  }
  const read = await Promise.all([...keys].map(async ([key, path]) => {
    const speech = await readSpeech(path);
    return speech === null ? [] : [[key, speech] as const];
  }));
  return new Map(read.flat());
}

// The `--- speech ---` section `logs.ts` writes, or null when the log is gone.
async function readSpeech(path: string): Promise<string | null> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
  return speechSection(body);
}

export function speechSection(body: string): string | null {
  const open = "\n--- speech ---\n";
  const close = "\n--- stdout tail ---\n";
  const start = body.indexOf(open);
  if (start === -1) return null;
  const end = body.indexOf(close, start + open.length);
  return end === -1 ? null : body.slice(start + open.length, end);
}
