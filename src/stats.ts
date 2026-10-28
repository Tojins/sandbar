// The run scorecard (#194): one pure reduction of a window of run records
// (`stats-record.ts`) into a `StatsReport`, and its rendering as tables.
//
// `StatsReport` is the JSON contract the measuring issues read instead of
// writing record readers of their own (#180, #182, #183, #195). It is a report
// and nothing else: no daemon module imports this one, and no number here
// feeds a decision (#82).
//
// The unit is an issue cycle: from `admitted` to `terminal` within one run. A
// cycle with no terminal (a restart, a crash, the run's end) is `interrupted`.
// `outcomes` counts cycles, and puts each cycle's tokens under its outcome.
// An issue's rollup sums its cycles that reached a terminal inside the window,
// so an interrupted cycle's tokens are never credited to a later DONE; its
// outcome is its last cycle's, interrupted included. `perDoneIssue` reads the
// rollups whose outcome is DONE. A cycle's lane is derived, not recorded: a
// review-gated issue is admitted into a chunk (`chunks.ts`), an auto one with
// none. Events for an issue outside any of its cycles in that run (landing
// work for an issue admitted in an earlier run) are invocation rows only.
//
// Definitions. An attempt is one `implementer` event: a HARD-ERROR retry
// renumbers attempts from 1 inside the same cycle, so distinct attempt numbers
// would undercount. Gate rounds count `gate-1` events, quality rounds
// `quality-pass` (fixer) events, and review rounds the `review-pass` events
// that completed. A pass's rejection rate is over the runs that reached a
// verdict: gate-1 over its gates, the quality lister and verify over their
// APPROVED or CHANGES-REQUESTED verdicts, correctness over `review-round`s that
// were APPROVED or CHANGES-REQUESTED. A completed review invocation's row
// carries the correctness verdict of the next `review-round` in its cycle, so a
// rejecting round is found without prose; attempt numbers repeat after a
// HARD-ERROR retry, so they cannot pair a round with its invocations.
//
// Absent is structural (#82): every aggregate is `Agg`, whose `of` is the
// population and `n` the measured part of it, and an aggregate of nothing
// measured has null statistics, never 0. Quantiles are nearest-rank. A token
// sum is null where no invocation in it reported that bucket. The rows for
// scenarios (#180, #203), quality rule groups (#204), DB copies (#201),
// deploys (#198), anchors (#197) and the janitor (#205) are empty until those
// issues emit their events; each adds its own reducer arm here.
//
// `gates` and `terminals` list every gate run and every terminal in the
// window, in record order, for a reader that keys on their typed fields
// rather than on the rollups (reflect, #182).

import type { StatsEvent, StatsInput, StatsWindow } from "./stats-record.js";
import { proseKey } from "./stats-record.js";
import type { UsageFields } from "./events.js";
import type { Lane } from "./lanes.js";

export type Agg = {
  readonly of: number;
  readonly n: number;
  readonly sum: number | null;
  readonly median: number | null;
  readonly p90: number | null;
  readonly max: number | null;
};

export type TokenSum = {
  readonly input: number | null;
  readonly cached: number | null;
  readonly cacheWrite: number | null;
  readonly output: number | null;
  readonly reasoning: number | null;
};

const ROLE_KEYS = {
  "partition-check": true, "ui-check": true, implementer: true,
  "quality-list": true, "quality-fix": true, "quality-verify": true, review: true,
  "adjudicator:quality": true, "adjudicator:correctness": true,
  "adjudicator:scenarios": true, "scenario-writer": true, "scenario-runner": true,
  condenser: true, resolve: true,
} as const;
export type Role = keyof typeof ROLE_KEYS;
const ROLES = Object.keys(ROLE_KEYS) as readonly Role[];

type TerminalKind = Extract<StatsEvent, { kind: "terminal" }>["terminal"];
export type Outcome = TerminalKind | "interrupted";
const OUTCOME_KEYS = {
  DONE: true, "NEEDS-INFO": true, "NEEDS-UI-PROTOTYPE": true, "NEEDS-PARTITION": true,
  "NEEDS-HUMAN": true, "NEEDS-HUMAN-REVIEW": true, "HARD-ERROR": true, QUOTA: true,
  CREDENTIAL: true, REJECTED: true, interrupted: true,
} as const satisfies Record<Outcome, true>;
const OUTCOMES = Object.keys(OUTCOME_KEYS) as readonly Outcome[];

export type InvocationRow = {
  readonly run: string;
  readonly issue: number;
  readonly role: Role;
  readonly attempt: number | null;
  readonly round: number | null;
  readonly invocation: number | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly result: string;
  // The role's verdict token, where the record carries one.
  readonly verdict: string | null;
  // The commits the invocation made, where the record carries them.
  readonly commits: number | null;
  readonly durationMs: number;
  readonly tokens: TokenSum;
  readonly firstContext: number | null;
  readonly peakContext: number | null;
  readonly contextChars: number | null;
  readonly toolCalls: number | null;
  readonly peakMemoryBytes: number | null;
  readonly oomKilled: boolean | null;
  readonly transcript: string | null;
  // Only with --with-prose: the speech of the log `transcript` names.
  readonly prose?: string | null;
};

export type GateRow = {
  readonly run: string;
  readonly issue: number;
  readonly gate: "gate-1" | "gate-2";
  // gate-1's attempt; gate-2 runs at landing, outside any attempt.
  readonly attempt: number | null;
  readonly ok: boolean;
  // Empty when the record names no red step.
  readonly redSteps: readonly string[];
};

export type TerminalRow = {
  readonly run: string;
  readonly issue: number;
  readonly terminal: TerminalKind;
  readonly cause: string | null;
  // Only with --with-prose.
  readonly reason?: string | null;
};

export type IssueRollup = {
  readonly issue: number;
  readonly title: string;
  readonly lane: Lane;
  readonly outcome: Outcome;
  readonly cause: string | null;
  readonly cycles: number;
  readonly interrupted: number;
  readonly attempts: number;
  readonly rounds: { readonly gate: number; readonly quality: number; readonly review: number };
  readonly specGaps: number | null;
  // The roles that ran in the summed cycles.
  readonly tokensByRole: Readonly<Partial<Record<Role, TokenSum>>>;
  readonly durationMs: number | null;
  // Only with --with-prose: the last terminal's reason.
  readonly reason?: string | null;
};

type PassName = "gate-1" | "quality-list" | "quality-verify" | "correctness" | "scenarios";
type AdjudicatedPass = "quality" | "correctness" | "scenarios";
type PassCount = { readonly runs: number; readonly rejected: number };
type RulingCount = { readonly rulings: number; readonly overruled: number };

export type QualityGroupStats = {
  readonly janitor: boolean;
  readonly listers: number;
  readonly changesRequested: number;
  readonly findings: Agg;
  readonly soleGroupFixerCommits: number;
  readonly tokens: TokenSum;
};

export type StatsReport = {
  readonly statsSchema: 1;
  readonly window: StatsWindow;
  readonly runs: readonly { readonly run: string; readonly schemaVersion: number; readonly driver: string }[];
  readonly skipped: StatsInput["skipped"];
  readonly ignoredKinds: Readonly<Record<string, number>>;
  readonly outcomes: {
    readonly byLane: Readonly<Record<Lane, Readonly<Record<Outcome, number>>>>;
    // Keyed `<outcome>:<cause|->`.
    readonly byCause: Readonly<Record<string, number>>;
    readonly tokens: Readonly<Record<Outcome, TokenSum>>;
  };
  readonly issues: readonly IssueRollup[];
  readonly perDoneIssue: {
    readonly attempts: Agg;
    readonly gateRounds: Agg;
    readonly qualityRounds: Agg;
    readonly reviewRounds: Agg;
    // Total tokens per DONE issue that ran the role.
    readonly tokensByRole: Readonly<Record<Role, Agg>>;
  };
  readonly passes: Readonly<Record<PassName, PassCount>>;
  readonly adjudication: Readonly<Record<AdjudicatedPass, RulingCount>>;
  readonly context: Readonly<Record<Role, {
    readonly first: Agg;
    readonly peak: Agg;
    readonly contextChars: Agg;
    readonly toolCalls: Agg;
  }>>;
  readonly landedThenBroken: {
    readonly gate2: { readonly runs: number; readonly red: number };
    readonly deploy: {
      readonly watched: number;
      readonly green: number;
      readonly red: number;
      readonly unverified: number;
    };
  };
  readonly scenarios: {
    readonly issues: number;
    readonly perIssue: Agg;
    readonly pass: number;
    readonly fail: number;
    readonly unverified: number;
    readonly writerFailed: number;
  };
  readonly qualityGroups: Readonly<Record<string, QualityGroupStats>>;
  readonly dbCopies: {
    readonly copies: number;
    readonly peakConcurrent: number;
    readonly uniqueBytes: Agg;
    readonly volumeUsedBytesMax: number | null;
    readonly peakMemoryBytes: Agg;
  };
  readonly anchors: {
    readonly issues: number;
    readonly raw: Agg;
    readonly afterTraceDrop: Agg;
    readonly condensed: Agg;
    readonly condenser: Readonly<Record<string, number>>;
  };
  readonly janitor: {
    readonly runs: number;
    readonly byTask: Readonly<Record<string, {
      readonly runs: number;
      readonly outcomes: Readonly<Record<string, number>>;
      readonly tokens: TokenSum;
    }>>;
  };
  readonly invocations: readonly InvocationRow[];
  readonly gates: readonly GateRow[];
  readonly terminals: readonly TerminalRow[];
};

export function agg(values: readonly (number | null | undefined)[]): Agg {
  const measured = values
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
  const rank = (q: number): number | null =>
    measured[Math.max(0, Math.ceil(q * measured.length) - 1)] ?? null;
  return {
    of: values.length,
    n: measured.length,
    sum: measured.length === 0 ? null : measured.reduce((a, b) => a + b, 0),
    median: rank(0.5),
    p90: rank(0.9),
    max: measured.at(-1) ?? null,
  };
}

const tokensOf = (usage: UsageFields | undefined): TokenSum => ({
  input: usage?.inputTokens ?? null,
  cached: usage?.cachedInputTokens ?? null,
  cacheWrite: usage?.cacheWriteInputTokens ?? null,
  output: usage?.outputTokens ?? null,
  reasoning: usage?.reasoningTokens ?? null,
});

function sumTokens(sums: readonly TokenSum[]): TokenSum {
  const bucket = (name: keyof TokenSum): number | null =>
    agg(sums.map((sum) => sum[name])).sum;
  return {
    input: bucket("input"),
    cached: bucket("cached"),
    cacheWrite: bucket("cacheWrite"),
    output: bucket("output"),
    reasoning: bucket("reasoning"),
  };
}

// Every token the invocations read or wrote; reasoning is part of output.
const totalTokens = (sum: TokenSum): number | null =>
  agg([sum.input, sum.cached, sum.cacheWrite, sum.output]).sum;

const byRole = <T>(value: (role: Role) => T): Record<Role, T> =>
  Object.fromEntries(ROLES.map((role) => [role, value(role)])) as Record<Role, T>;

const byOutcome = <T>(value: (outcome: Outcome) => T): Record<Outcome, T> =>
  Object.fromEntries(OUTCOMES.map((outcome) => [outcome, value(outcome)])) as Record<Outcome, T>;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type Row = Mutable<InvocationRow>;

type Cycle = {
  readonly issue: number;
  readonly title: string;
  readonly lane: Lane;
  ended: Extract<StatsEvent, { kind: "terminal" }> | null;
  attempts: number;
  gateRounds: number;
  qualityRounds: number;
  reviewRounds: number;
  readonly rows: Row[];
  // Completed review invocations since the cycle's last `review-round`: the
  // round that closes next is theirs. Attempt numbers repeat inside a cycle.
  readonly unjudged: Row[];
};

const outcomeOf = (cycle: Cycle): Outcome => cycle.ended?.terminal ?? "interrupted";

type AgentEvent = Extract<StatsEvent, {
  kind: "ui-check" | "partition-check" | "implementer" | "quality-review" | "quality-pass"
    | "review-pass" | "adjudication" | "resolve-attempt";
}>;

const AGENT_KINDS: ReadonlySet<StatsEvent["kind"]> = new Set([
  "ui-check", "partition-check", "implementer", "quality-review", "quality-pass",
  "review-pass", "adjudication", "resolve-attempt",
]);

const isAgentEvent = (event: StatsEvent): event is AgentEvent => AGENT_KINDS.has(event.kind);

const roleOf = (event: AgentEvent): Role =>
  event.kind === "quality-review" ? (event.mode === "list" ? "quality-list" : "quality-verify")
    : event.kind === "quality-pass" ? "quality-fix"
    : event.kind === "review-pass" ? "review"
    : event.kind === "adjudication" ? `adjudicator:${event.pass}`
    : event.kind === "resolve-attempt" ? "resolve"
    : event.kind;

function invocationRow(
  run: string,
  event: AgentEvent,
  prose: ReadonlyMap<string, string> | null,
): Row {
  const transcript = event.kind === "resolve-attempt" ? null : event.transcript ?? null;
  return {
    run,
    issue: event.issue,
    role: roleOf(event),
    attempt: "attempt" in event ? event.attempt : null,
    round: "round" in event ? event.round : null,
    invocation: "invocation" in event ? event.invocation : null,
    provider: event.provider ?? null,
    model: event.model ?? null,
    effort: event.kind === "resolve-attempt" ? null : event.effort,
    result: event.kind === "implementer" ? event.signal
      : event.kind === "adjudication" ? event.ruling
      : event.kind === "resolve-attempt" ? event.end
      : event.result,
    // A review invocation's verdict is its round's, set when the round closes.
    verdict: event.kind === "quality-review" ? event.verdict
      : event.kind === "adjudication" ? event.ruling
      : null,
    commits: event.kind === "quality-pass" ? ("commits" in event ? event.commits.length : null)
      : event.kind === "implementer" ? event.commits ?? null
      : null,
    durationMs: event.durationMs,
    tokens: tokensOf(event.usage),
    firstContext: event.usage?.firstContext ?? null,
    peakContext: event.usage?.peakContext ?? null,
    contextChars: event.usage?.contextChars ?? null,
    toolCalls: event.usage?.toolCalls ?? null,
    peakMemoryBytes: event.peakMemoryBytes ?? null,
    oomKilled: event.oomKilled ?? null,
    transcript,
    ...(prose === null
      ? {}
      : { prose: transcript === null ? null : prose.get(proseKey(event.issue, transcript)) ?? null }),
  };
}

const VERDICTS: ReadonlySet<string> = new Set(["APPROVED", "CHANGES-REQUESTED"]);

const count = (tally: Mutable<PassCount>, rejected: boolean): void => {
  tally.runs += 1;
  if (rejected) tally.rejected += 1;
};

export function computeStats(input: StatsInput): StatsReport {
  const cycles: Cycle[] = [];
  const invocations: Row[] = [];
  const gates: GateRow[] = [];
  const terminals: TerminalRow[] = [];
  const passes: Record<PassName, Mutable<PassCount>> = {
    "gate-1": { runs: 0, rejected: 0 },
    "quality-list": { runs: 0, rejected: 0 },
    "quality-verify": { runs: 0, rejected: 0 },
    correctness: { runs: 0, rejected: 0 },
    scenarios: { runs: 0, rejected: 0 },
  };
  const adjudication: Record<AdjudicatedPass, Mutable<RulingCount>> = {
    quality: { rulings: 0, overruled: 0 },
    correctness: { rulings: 0, overruled: 0 },
    scenarios: { rulings: 0, overruled: 0 },
  };
  const gate2 = { runs: 0, red: 0 };

  for (const { run, events, prose } of input.runs) {
    // Each issue's latest cycle in this run; it keeps the events that follow
    // its terminal, such as landing's resolve attempts.
    const latest = new Map<number, Cycle>();
    for (const event of events) {
      if (event.kind === "admitted") {
        const cycle: Cycle = {
          issue: event.issue,
          title: event.title,
          lane: event.chunk === null ? "auto" : "review",
          ended: null,
          attempts: 0,
          gateRounds: 0,
          qualityRounds: 0,
          reviewRounds: 0,
          rows: [],
          unjudged: [],
        };
        cycles.push(cycle);
        latest.set(event.issue, cycle);
        continue;
      }
      const cycle = "issue" in event && event.issue !== undefined
        ? latest.get(event.issue)
        : undefined;
      if (isAgentEvent(event)) {
        const row = invocationRow(run, event, input.withProse ? prose : null);
        invocations.push(row);
        cycle?.rows.push(row);
        if (row.role === "review" && row.result === "completed") cycle?.unjudged.push(row);
      }
      switch (event.kind) {
        case "terminal":
          terminals.push({
            run,
            issue: event.issue,
            terminal: event.terminal,
            cause: event.cause ?? null,
            ...(input.withProse ? { reason: event.reason } : {}),
          });
          if (cycle !== undefined && cycle.ended === null) cycle.ended = event;
          break;
        case "implementer":
          if (cycle !== undefined) cycle.attempts += 1;
          break;
        case "gate":
          gates.push({
            run,
            issue: event.issue,
            gate: event.gate,
            attempt: "attempt" in event ? event.attempt : null,
            ok: event.ok,
            redSteps: Object.entries(event.steps ?? {})
              .filter(([, step]) => !step.ok)
              .map(([name]) => name),
          });
          if (event.gate === "gate-1") {
            count(passes["gate-1"], !event.ok);
            if (cycle !== undefined) cycle.gateRounds += 1;
          } else {
            gate2.runs += 1;
            if (!event.ok) gate2.red += 1;
          }
          break;
        case "quality-review":
          if (event.verdict !== null) {
            count(
              passes[event.mode === "list" ? "quality-list" : "quality-verify"],
              event.verdict === "CHANGES-REQUESTED",
            );
          }
          break;
        case "quality-pass":
          if (cycle !== undefined) cycle.qualityRounds += 1;
          break;
        case "review-pass":
          if (cycle !== undefined && event.result === "completed") cycle.reviewRounds += 1;
          break;
        case "review-round": {
          const judged = cycle?.unjudged.splice(0) ?? [];
          if (!VERDICTS.has(event.correctness)) break;
          count(passes.correctness, event.correctness === "CHANGES-REQUESTED");
          for (const row of judged) row.verdict = event.correctness;
          break;
        }
        case "adjudication":
          adjudication[event.pass].rulings += 1;
          if (event.ruling === "OVERRULED") adjudication[event.pass].overruled += 1;
          break;
      }
    }
  }

  const issues = rollups(cycles, input.withProse);
  const done = issues.filter((issue) => issue.outcome === "DONE");
  return {
    statsSchema: 1,
    window: input.window,
    runs: input.runs.map(({ run, schemaVersion, driver }) => ({ run, schemaVersion, driver })),
    skipped: input.skipped,
    ignoredKinds: input.ignoredKinds,
    outcomes: {
      byLane: {
        auto: byOutcome((outcome) => cycles
          .filter((cycle) => cycle.lane === "auto" && outcomeOf(cycle) === outcome).length),
        review: byOutcome((outcome) => cycles
          .filter((cycle) => cycle.lane === "review" && outcomeOf(cycle) === outcome).length),
      },
      byCause: tally(cycles.map((cycle) => `${outcomeOf(cycle)}:${cycle.ended?.cause ?? "-"}`)),
      tokens: byOutcome((outcome) => sumTokens(cycles
        .filter((cycle) => outcomeOf(cycle) === outcome)
        .flatMap((cycle) => cycle.rows.map((row) => row.tokens)))),
    },
    issues,
    perDoneIssue: {
      attempts: agg(done.map((issue) => issue.attempts)),
      gateRounds: agg(done.map((issue) => issue.rounds.gate)),
      qualityRounds: agg(done.map((issue) => issue.rounds.quality)),
      reviewRounds: agg(done.map((issue) => issue.rounds.review)),
      tokensByRole: byRole((role) => agg(done.flatMap((issue) => {
        const tokens = issue.tokensByRole[role];
        return tokens === undefined ? [] : [totalTokens(tokens)];
      }))),
    },
    passes,
    adjudication,
    context: byRole((role) => {
      const ofRole = invocations.filter((row) => row.role === role);
      return {
        first: agg(ofRole.map((row) => row.firstContext)),
        peak: agg(ofRole.map((row) => row.peakContext)),
        contextChars: agg(ofRole.map((row) => row.contextChars)),
        toolCalls: agg(ofRole.map((row) => row.toolCalls)),
      };
    }),
    landedThenBroken: {
      gate2,
      deploy: { watched: 0, green: 0, red: 0, unverified: 0 },
    },
    scenarios: { issues: 0, perIssue: agg([]), pass: 0, fail: 0, unverified: 0, writerFailed: 0 },
    qualityGroups: {},
    dbCopies: {
      copies: 0,
      peakConcurrent: 0,
      uniqueBytes: agg([]),
      volumeUsedBytesMax: null,
      peakMemoryBytes: agg([]),
    },
    anchors: { issues: 0, raw: agg([]), afterTraceDrop: agg([]), condensed: agg([]), condenser: {} },
    janitor: { runs: 0, byTask: {} },
    invocations,
    gates,
    terminals,
  };
}

// One rollup per issue, in the order its first cycle was admitted, summing
// the cycles that reached a terminal.
function rollups(cycles: readonly Cycle[], withProse: boolean): IssueRollup[] {
  const byIssue = new Map<number, Cycle[]>();
  for (const cycle of cycles) {
    byIssue.set(cycle.issue, [...(byIssue.get(cycle.issue) ?? []), cycle]);
  }
  return [...byIssue.values()].map((issueCycles) => {
    const last = issueCycles.at(-1)!;
    const ended = issueCycles.filter((cycle) => cycle.ended !== null);
    const rows = ended.flatMap((cycle) => cycle.rows);
    const sumOf = (field: "attempts" | "gateRounds" | "qualityRounds" | "reviewRounds"): number =>
      ended.reduce((total, cycle) => total + cycle[field], 0);
    return {
      issue: last.issue,
      title: last.title,
      lane: last.lane,
      outcome: outcomeOf(last),
      cause: last.ended?.cause ?? null,
      cycles: issueCycles.length,
      interrupted: issueCycles.length - ended.length,
      attempts: sumOf("attempts"),
      rounds: { gate: sumOf("gateRounds"), quality: sumOf("qualityRounds"), review: sumOf("reviewRounds") },
      specGaps: agg(ended.map((cycle) => cycle.ended?.specGaps)).sum,
      tokensByRole: Object.fromEntries(ROLES
        .filter((role) => rows.some((row) => row.role === role))
        .map((role) => [role, sumTokens(rows.filter((row) => row.role === role).map((row) => row.tokens))])),
      durationMs: agg(ended.map((cycle) => cycle.ended?.durationMs)).sum,
      ...(withProse ? { reason: last.ended?.reason ?? null } : {}),
    };
  });
}

const tally = (keys: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
};

type Cell = string | number | boolean | null | undefined;

// One aligned text table; an absent value renders `-`.
function table(title: string, head: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const cells = [head, ...rows.map((row) => row.map((value) => value == null ? "-" : String(value)))];
  const widths = head.map((_, column) =>
    Math.max(...cells.map((row) => row[column]?.length ?? 0)));
  const line = (row: readonly string[]): string =>
    row.map((value, column) => value.padEnd(widths[column] ?? 0)).join("  ").trimEnd();
  return [`## ${title}`, ...cells.map(line), ""].join("\n");
}

const AGG_HEAD = ["of", "n", "sum", "median", "p90", "max"] as const;
const aggCells = (value: Agg): readonly Cell[] =>
  [value.of, value.n, value.sum, value.median, value.p90, value.max];

const rate = (part: number, whole: number): string | null =>
  whole === 0 ? null : `${(100 * part / whole).toFixed(1)}%`;

const tokenCells = (sum: TokenSum): readonly Cell[] =>
  [sum.input, sum.cached, sum.cacheWrite, sum.output, sum.reasoning];

export const describeWindow = (window: StatsWindow): string =>
  "last" in window ? `last ${window.last} runs` : `runs since ${window.since}`;

export function renderStatsTables(report: StatsReport): string {
  const window = describeWindow(report.window);
  const issueTotal = (issue: IssueRollup): number | null =>
    agg(Object.values(issue.tokensByRole).map(totalTokens)).sum;
  return [
    `# Sandbar scorecard: ${window}`,
    "",
    table("Runs", ["run", "schema", "driver"],
      report.runs.map((run) => [run.run, run.schemaVersion, run.driver])),
    table("Skipped runs", ["run", "schema", "reason"],
      report.skipped.map((run) => [run.run, run.schemaVersion, run.reason])),
    table("Ignored event kinds", ["kind", "events"], Object.entries(report.ignoredKinds)),
    table("Outcomes per cycle", ["outcome", "auto", "review", "input", "cached", "cacheWrite", "output", "reasoning"],
      OUTCOMES.map((outcome) => [
        outcome,
        report.outcomes.byLane.auto[outcome],
        report.outcomes.byLane.review[outcome],
        ...tokenCells(report.outcomes.tokens[outcome]),
      ])),
    table("Outcomes by cause", ["outcome:cause", "cycles"], Object.entries(report.outcomes.byCause)),
    table("Per DONE issue", ["metric", ...AGG_HEAD], [
      ["attempts", ...aggCells(report.perDoneIssue.attempts)],
      ["gate rounds", ...aggCells(report.perDoneIssue.gateRounds)],
      ["quality rounds", ...aggCells(report.perDoneIssue.qualityRounds)],
      ["review rounds", ...aggCells(report.perDoneIssue.reviewRounds)],
      ...ROLES.map((role) => [`tokens: ${role}`, ...aggCells(report.perDoneIssue.tokensByRole[role])]),
    ]),
    table("Pass rejections", ["pass", "runs", "rejected", "rate"],
      Object.entries(report.passes).map(([pass, { runs, rejected }]) =>
        [pass, runs, rejected, rate(rejected, runs)])),
    table("Adjudication", ["pass", "rulings", "overruled", "rate"],
      Object.entries(report.adjudication).map(([pass, { rulings, overruled }]) =>
        [pass, rulings, overruled, rate(overruled, rulings)])),
    table("Context depth per invocation", ["role", "metric", ...AGG_HEAD],
      ROLES.flatMap((role) => {
        const context = report.context[role];
        return [
          [role, "first", ...aggCells(context.first)],
          [role, "peak", ...aggCells(context.peak)],
          [role, "contextChars", ...aggCells(context.contextChars)],
          [role, "toolCalls", ...aggCells(context.toolCalls)],
        ];
      })),
    table("Landed then broken", ["check", "runs", "red", "green", "unverified"], [
      ["gate-2", report.landedThenBroken.gate2.runs, report.landedThenBroken.gate2.red, null, null],
      ["deploy", report.landedThenBroken.deploy.watched, report.landedThenBroken.deploy.red,
        report.landedThenBroken.deploy.green, report.landedThenBroken.deploy.unverified],
    ]),
    table("Scenarios", ["issues", "pass", "fail", "unverified", "writerFailed", ...AGG_HEAD.map((h) => `perIssue ${h}`)], [[
      report.scenarios.issues, report.scenarios.pass, report.scenarios.fail,
      report.scenarios.unverified, report.scenarios.writerFailed, ...aggCells(report.scenarios.perIssue),
    ]]),
    table("Quality rule groups", ["group", "janitor", "listers", "changesRequested", "findings n", "findings sum", "soleGroupFixerCommits"],
      Object.entries(report.qualityGroups).map(([group, stats]) => [
        group, stats.janitor, stats.listers, stats.changesRequested,
        stats.findings.n, stats.findings.sum, stats.soleGroupFixerCommits,
      ])),
    table("DB copies", ["metric", ...AGG_HEAD], [
      ["copies", report.dbCopies.copies],
      ["peak concurrent", report.dbCopies.peakConcurrent],
      ["volume used bytes max", report.dbCopies.volumeUsedBytesMax],
      ["unique bytes", ...aggCells(report.dbCopies.uniqueBytes)],
      ["peak memory bytes", ...aggCells(report.dbCopies.peakMemoryBytes)],
    ]),
    table("Issue anchors", ["chars", ...AGG_HEAD], [
      ["raw", ...aggCells(report.anchors.raw)],
      ["after trace drop", ...aggCells(report.anchors.afterTraceDrop)],
      ["condensed", ...aggCells(report.anchors.condensed)],
    ]),
    table("Janitor", ["task", "runs", "outcomes"],
      Object.entries(report.janitor.byTask).map(([task, stats]) => [
        task, stats.runs,
        Object.entries(stats.outcomes).map(([outcome, n]) => `${outcome}=${n}`).join(" "),
      ])),
    table("Issues", ["issue", "lane", "outcome", "cause", "cycles", "interrupted", "attempts",
      "gate", "quality", "review", "specGaps", "tokens", "durationMs"],
      report.issues.map((issue) => [
        issue.issue, issue.lane, issue.outcome, issue.cause, issue.cycles, issue.interrupted,
        issue.attempts, issue.rounds.gate, issue.rounds.quality, issue.rounds.review,
        issue.specGaps, issueTotal(issue), issue.durationMs,
      ])),
    table("Invocations", ["run", "issue", "role", "attempt", "round", "invocation", "provider",
      "model", "result", "verdict", "durationMs", "tokens", "firstContext", "peakContext",
      "toolCalls", "peakMemoryBytes", "oomKilled", "transcript"],
      report.invocations.map((row) => [
        row.run, row.issue, row.role, row.attempt, row.round, row.invocation, row.provider,
        row.model, row.result, row.verdict, row.durationMs, totalTokens(row.tokens),
        row.firstContext, row.peakContext, row.toolCalls, row.peakMemoryBytes,
        row.oomKilled, row.transcript,
      ])),
  ].join("\n");
}
