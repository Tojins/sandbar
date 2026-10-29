// Replay's pure layer (#195): the case file and the session manifest, and every
// decision about them that needs no I/O. `replay-run.ts` is the adapter and
// `replay-cli.ts` the human's entry point; nothing in the daemon imports any
// of the three (replay-boundary.test.ts).
//
// A CASE is one past issue as it stood when it was admitted: the commit its
// branch was cut from (`seedSha`, and where that came from), the issue JSON
// the roles read (`issueFrom`: the snapshot the admission filed, or a
// reconstruction from today's issue with only the comments made by the
// cutoff, flagged when the body was edited after it), pointers to the
// original run and its landing, and, when that admission's writer wrote one,
// its scenario set (#240): pinned, it replaces the writer in every repeat and
// session, so all of them are judged on the same clauses. A case file frozen
// before pinning has no `scenarios`, and its cases run the writer as
// configured. `parseReplayCases` is the one validation of a case file, and
// lists every violation rather than the first.
//
// A SESSION is one `replay run`: its manifest records what was compared (the
// driver, the per-role routing, the budgets, the case file's sha256) and one
// result per (repeat, case). The plan is repeat-major, so model drift during a
// session spreads across cases instead of landing on the last one. A case not
// run — because a quota or credential stop closed the session — says why, and
// a repeat whose record never started has no `run`.
//
// A REPORT lays each case out in columns: the original run, then one per
// session in the order given. `compareReplay` reduces each column's runs —
// a session's results, each with its own run's `StatsReport` (#194), and the
// original's one record — into a `Spread` per metric, whose `of` is the
// column's runs and `n` those measured: absent never counts as 0 (#82), and a
// not-run result is a run with nothing measured. A session's outcome, gate and
// diff are its manifest's; the original's are its record's last terminal and
// gate-1 and the case's landed diff. Rounds and tokens are the issue's rollup,
// context depth its invocation rows: `first` the role's earliest
// `firstContext`, `peak` its largest `peakContext`. A case that pins a set
// adds a section with one row per scenario: per column, how many runs ended
// it pass, fail or unverified, read off each run's last `scenarioRounds` row
// for the issue; a run whose verifier never ran it judged nothing (#240).

import { type IssueComment, type IssueJson, issueJsonErrors } from "./issue-anchor.js";
import type { Terminal } from "./inner-loop.js";
import { type ScenarioSet, scenarioSetErrors } from "./scenario-parser.js";
import type { ScenarioOutcomeRecord } from "./events.js";
import {
  type Cell,
  type InvocationRow,
  type IssueRollup,
  type Outcome,
  type Role,
  type StatsReport,
  ROLES,
  agg,
  table,
} from "./stats.js";

export type DiffSize = {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
};

export type SeedFrom = "recorded" | "merge-base" | "manual";

export type CaseText =
  | { readonly issueFrom: "recorded" }
  | { readonly issueFrom: "reconstructed"; readonly editedAfterAdmission: boolean };

export type ReplayCase = CaseText & {
  readonly issue: number;
  readonly title: string;
  readonly seedSha: string;
  readonly seedFrom: SeedFrom;
  readonly issueJson: IssueJson;
  readonly original: { readonly logsDir: string; readonly run: string } | null;
  readonly landed: {
    readonly merge: string;
    readonly tip: string;
    readonly diff: DiffSize;
  } | null;
  readonly scenarios?: ScenarioSet;
};

export type ReplayCases = {
  readonly replayCases: 1;
  // `owner/name`: the tracker the issues were frozen from.
  readonly repo: string;
  readonly sourceBranch: string;
  readonly cases: readonly ReplayCase[];
};

export type ReplayResult = {
  readonly repeat: number;
  readonly run: string | null;
  readonly issue: number;
  readonly seedSha: string;
  readonly branch: string;
} & (
  | {
      readonly status: "ran";
      readonly terminal: Terminal["type"];
      readonly tip: string;
      // The last gate-1 verdict, or null when no gate-1 ran.
      readonly lastGateOk: boolean | null;
      readonly diff: DiffSize;
    }
  | { readonly status: "not-run"; readonly reason: string }
);

export type RoleRouting = {
  readonly agent: string;
  readonly model: string;
  readonly effort: string | null;
};

export type ReplaySession = {
  readonly replaySession: 1;
  readonly label: string;
  readonly driver: string;
  readonly casesFile: string;
  readonly casesSha256: string;
  readonly repeats: number;
  readonly parallel: number;
  readonly routing: Readonly<Record<string, RoleRouting>>;
  readonly budgets: {
    readonly maxQualityRounds: number;
    readonly maxGateRounds: number;
    readonly maxReviewRounds: number;
  };
  readonly results: readonly ReplayResult[];
};

const SHA = /^[0-9a-f]{40}$/;

type Json = Readonly<Record<string, unknown>>;

const asObject = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Json
    : null;

const isCount = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isText = (value: unknown): boolean =>
  typeof value === "string" && value.length > 0;

function caseErrors(value: unknown, at: string, seen: Set<number>): readonly string[] {
  const c = asObject(value);
  if (c === null) return [`${at} is not an object`];
  const errors: string[] = [];
  const { issue } = c;
  if (typeof issue !== "number" || !Number.isInteger(issue) || issue <= 0) {
    errors.push(`${at}.issue is not a positive integer`);
  } else if (seen.has(issue)) {
    errors.push(`${at}.issue #${issue} is listed twice`);
  } else {
    seen.add(issue);
  }
  if (!isText(c.title)) errors.push(`${at}.title is not a non-empty string`);
  if (typeof c.seedSha !== "string" || !SHA.test(c.seedSha)) {
    errors.push(`${at}.seedSha is not a 40-hex sha`);
  }
  if (!["recorded", "merge-base", "manual"].includes(c.seedFrom as string)) {
    errors.push(`${at}.seedFrom is not recorded, merge-base or manual`);
  }
  errors.push(...issueJsonErrors(c.issueJson).map((error) => `${at}.issueJson ${error}`));
  if (c.issueFrom === "recorded") {
    if (c.editedAfterAdmission !== undefined) {
      errors.push(`${at}.editedAfterAdmission is set on a recorded issue`);
    }
  } else if (c.issueFrom === "reconstructed") {
    if (typeof c.editedAfterAdmission !== "boolean") {
      errors.push(`${at}.editedAfterAdmission is not a boolean`);
    }
  } else {
    errors.push(`${at}.issueFrom is not recorded or reconstructed`);
  }
  if (c.original !== null) {
    const original = asObject(c.original);
    if (original === null || !isText(original.logsDir) || !isText(original.run)) {
      errors.push(`${at}.original is neither null nor { logsDir, run }`);
    }
  }
  if (c.landed !== null) {
    const landed = asObject(c.landed);
    const diff = asObject(landed?.diff);
    if (
      landed === null ||
      typeof landed.merge !== "string" || !SHA.test(landed.merge) ||
      typeof landed.tip !== "string" || !SHA.test(landed.tip) ||
      diff === null || !isCount(diff.files) || !isCount(diff.insertions) || !isCount(diff.deletions)
    ) {
      errors.push(`${at}.landed is neither null nor { merge, tip, diff } with 40-hex shas and counts`);
    }
  }
  if (c.scenarios !== undefined && typeof issue === "number") {
    errors.push(...scenarioSetErrors(c.scenarios, issue).map((error) => `${at}.scenarios ${error}`));
  }
  return errors;
}

// The case file, or every way it is not one.
export function parseReplayCases(
  value: unknown,
): { readonly cases: ReplayCases } | { readonly errors: readonly string[] } {
  const root = asObject(value);
  if (root === null) return { errors: ["the case file is not a JSON object"] };
  const errors: string[] = [];
  if (root.replayCases !== 1) errors.push("replayCases is not 1");
  if (typeof root.repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(root.repo)) {
    errors.push("repo is not owner/name");
  }
  if (!isText(root.sourceBranch)) errors.push("sourceBranch is not a non-empty string");
  if (!Array.isArray(root.cases) || root.cases.length === 0) {
    errors.push("cases is not a non-empty array");
  } else {
    const seen = new Set<number>();
    root.cases.forEach((c: unknown, i) => errors.push(...caseErrors(c, `cases[${i}]`, seen)));
  }
  return errors.length > 0 ? { errors } : { cases: value as ReplayCases };
}

export type PlannedRun = { readonly repeat: number; readonly case: ReplayCase };

// Every (repeat, case) pair, repeat-major and 1-based.
export function planReplay(
  cases: readonly ReplayCase[],
  repeats: number,
): readonly (readonly PlannedRun[])[] {
  return Array.from({ length: repeats }, (_, i) => cases.map((c) => ({ repeat: i + 1, case: c })));
}

// What would let a replay write to the forge (#195 decision 2). Removed from
// the replay process's environment and from every sandbox's.
export const FORGE_CREDENTIAL_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "SSH_AUTH_SOCK",
] as const;

export function stripForgeCredentials(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const forge: ReadonlySet<string> = new Set(FORGE_CREDENTIAL_KEYS);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !forge.has(key)));
}

// The `git update-ref --stdin` lines that leave a case cache holding exactly
// one ref, `origin/<sourceBranch>` at the seed (#195 decision 3).
export function caseCacheRefUpdates(
  existingRefs: readonly string[],
  sourceBranch: string,
  seedSha: string,
): readonly string[] {
  const seed = `refs/remotes/origin/${sourceBranch}`;
  return [
    ...existingRefs.filter((ref) => ref !== seed).map((ref) => `delete ${ref}`),
    `update ${seed} ${seedSha}`,
  ];
}

// The issue with only the comments made by `cutoff`. A comment whose time is
// unknown cannot be placed before it and is dropped.
export function commentsAtCutoff(issue: IssueJson, cutoff: string): IssueJson {
  const limit = Date.parse(cutoff);
  const madeBy = (comment: IssueComment): boolean =>
    comment.createdAt !== undefined && Date.parse(comment.createdAt) <= limit;
  return { ...issue, comments: (issue.comments ?? []).filter(madeBy) };
}

export type RecordedAdmission = {
  readonly run: string;
  // When it was admitted: the reconstruction's comment cutoff.
  readonly ts: string;
  readonly title: string;
  readonly seedSha: string | null;
  readonly issueSnapshot: string | null;
  // The `scenarios-<k>.json` its writer filed, when it wrote a set.
  readonly scenarios: string | null;
};

// The admission behind an issue's last DONE in one run's events, or null when
// the run has none. Records are read version-blind (`parseEventLines`), so
// every field is checked rather than trusted. The issue's k-th
// `scenario-writer` event with a non-empty set in the run is its
// `scenarios-<k>.json`: the logger numbers only written sets, per issue.
export function lastDoneAdmission(
  run: string,
  events: readonly Json[],
  issue: number,
): RecordedAdmission | null {
  let admitted: Json | null = null;
  let written = 0;
  let scenarios: string | null = null;
  let done: Json | null = null;
  let doneScenarios: string | null = null;
  for (const event of events) {
    if (event.issue !== issue) continue;
    if (event.kind === "admitted") {
      admitted = event;
      scenarios = null;
    }
    if (event.kind === "scenario-writer" && typeof event.scenarios === "number" && event.scenarios > 0) {
      written += 1;
      scenarios = `scenarios-${written}.json`;
    }
    if (event.kind === "terminal" && event.terminal === "DONE" && admitted !== null) {
      done = admitted;
      doneScenarios = scenarios;
    }
  }
  if (done === null || typeof done.ts !== "string" || typeof done.title !== "string") return null;
  return {
    run,
    ts: done.ts,
    title: done.title,
    seedSha: typeof done.seedSha === "string" ? done.seedSha : null,
    issueSnapshot: typeof done.issueSnapshot === "string" ? done.issueSnapshot : null,
    scenarios: doneScenarios,
  };
}

// `git diff --numstat` as a size; a binary file counts as a file of no lines.
export function parseNumstat(numstat: string): DiffSize {
  const rows = numstat.split("\n").filter((line) => line.trim() !== "").map((line) => line.split("\t"));
  const lines = (column: 0 | 1): number =>
    rows.reduce((sum, row) => sum + (Number.parseInt(row[column] ?? "", 10) || 0), 0);
  return { files: rows.length, insertions: lines(0), deletions: lines(1) };
}

const describeRouting = (r: RoleRouting): string =>
  `${r.agent} ${r.model}${r.effort === null ? "" : ` (effort ${r.effort})`}`;

// What `replay run` prints before it starts: the size of the spend, who each
// role runs on, and that the quota is shared.
export function renderReplayPlan(args: {
  readonly label: string;
  readonly cases: number;
  readonly repeats: number;
  readonly parallel: number;
  readonly routing: Readonly<Record<string, RoleRouting>>;
}): string {
  const width = Math.max(...Object.keys(args.routing).map((role) => role.length));
  return [
    `replay ${args.label}: ${args.cases} cases × ${args.repeats} = ` +
      `${args.cases * args.repeats} runs, ${args.parallel} at a time`,
    ...Object.entries(args.routing).map(([role, r]) =>
      `  ${role.padEnd(width)}  ${describeRouting(r)}`),
    "Every run spends real tokens from the same model quota as any sandbar daemon on this account.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

export type Spread = {
  readonly of: number;
  readonly n: number;
  readonly min: number | null;
  readonly median: number | null;
  readonly max: number | null;
};

export function spread(values: readonly (number | null)[]): Spread {
  const { of, n, median, max } = agg(values);
  const measured = values.filter((value): value is number => value !== null);
  return { of, n, min: n === 0 ? null : Math.min(...measured), median, max };
}

export type ReplayOutcome = Outcome | "not-run";

// A scenario's verdicts over a column's runs; a run that judged it nothing
// is in none of them.
export type ScenarioCounts = Readonly<Partial<Record<ScenarioOutcomeRecord["outcome"], number>>>;

export type RoleSpread = {
  readonly input: Spread;
  readonly cached: Spread;
  readonly output: Spread;
  readonly firstContext: Spread;
  readonly peakContext: Spread;
};

export type ReplayColumn = {
  // `original`, or the session's label.
  readonly label: string;
  readonly runs: number;
  // A run whose record holds no cycle of the issue has no outcome.
  readonly outcomes: Readonly<Partial<Record<ReplayOutcome, number>>>;
  readonly attempts: Spread;
  readonly rounds: { readonly gate: Spread; readonly quality: Spread; readonly review: Spread };
  // The roles that ran in any of the column's runs.
  readonly roles: Readonly<Partial<Record<Role, RoleSpread>>>;
  // The last gate-1 per run; unknown where none ran.
  readonly gate: { readonly green: number; readonly red: number; readonly unknown: number };
  readonly diff: { readonly files: Spread; readonly insertions: Spread; readonly deletions: Spread };
  // By scenario id, for each scenario the case pins.
  readonly scenarios: Readonly<Record<string, ScenarioCounts>>;
};

export type ReplayCaseReport = {
  readonly issue: number;
  readonly title: string;
  // The case's pinned scenarios; none when it pins no set.
  readonly scenarios: readonly { readonly id: string; readonly title: string }[];
  readonly columns: readonly ReplayColumn[];
};

export type ReplayReport = {
  readonly replayReport: 1;
  readonly sessions: readonly Omit<ReplaySession, "results">[];
  readonly cases: readonly ReplayCaseReport[];
};

export type SessionRecords = {
  readonly session: ReplaySession;
  // Each run's report, by the run its results name.
  readonly runs: ReadonlyMap<string, StatsReport>;
};

// One run of a case, as its column reads it.
type Sample = {
  readonly outcome: ReplayOutcome | null;
  readonly rollup: IssueRollup | null;
  readonly invocations: readonly InvocationRow[];
  readonly gateOk: boolean | null;
  readonly diff: DiffSize | null;
  // The last verifier round's scenario outcomes.
  readonly clauses: readonly ScenarioOutcomeRecord[];
};

const NOT_RUN: Sample = { outcome: "not-run", rollup: null, invocations: [], gateOk: null, diff: null, clauses: [] };

const recordOf = (report: StatsReport | undefined, issue: number): Pick<Sample, "rollup" | "invocations" | "clauses"> => ({
  rollup: report?.issues.find((rollup) => rollup.issue === issue) ?? null,
  invocations: report?.invocations.filter((row) => row.issue === issue) ?? [],
  clauses: report?.scenarioRounds.filter((row) => row.issue === issue).at(-1)?.outcomes ?? [],
});

function originalSample(c: ReplayCase, report: StatsReport | undefined): Sample {
  const record = recordOf(report, c.issue);
  return {
    ...record,
    outcome: record.rollup?.outcome ?? null,
    gateOk: report?.gates.filter((gate) => gate.issue === c.issue && gate.gate === "gate-1").at(-1)?.ok ?? null,
    diff: c.landed?.diff ?? null,
  };
}

const sessionSample = (result: ReplayResult, runs: SessionRecords["runs"]): Sample =>
  result.status === "not-run" ? NOT_RUN : {
    ...recordOf(result.run === null ? undefined : runs.get(result.run), result.issue),
    outcome: result.terminal,
    gateOk: result.lastGateOk,
    diff: result.diff,
  };

const spreadOf = (samples: readonly Sample[], value: (sample: Sample) => number | null | undefined): Spread =>
  spread(samples.map((sample) => value(sample) ?? null));

function roleSpread(samples: readonly Sample[], role: Role): RoleSpread {
  const tokens = (sample: Sample) => sample.rollup?.tokensByRole[role];
  const rows = (sample: Sample) => sample.invocations.filter((row) => row.role === role);
  return {
    input: spreadOf(samples, (sample) => tokens(sample)?.input),
    cached: spreadOf(samples, (sample) => tokens(sample)?.cached),
    output: spreadOf(samples, (sample) => tokens(sample)?.output),
    firstContext: spreadOf(samples, (sample) => rows(sample)[0]?.firstContext),
    peakContext: spreadOf(samples, (sample) => agg(rows(sample).map((row) => row.peakContext)).max),
  };
}

function tally<K extends string>(keys: readonly K[]): Partial<Record<K, number>> {
  const counts: Partial<Record<K, number>> = {};
  for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}

function column(label: string, samples: readonly Sample[], scenarioIds: readonly string[]): ReplayColumn {
  const ran = (role: Role): boolean => samples.some((sample) =>
    sample.rollup?.tokensByRole[role] !== undefined || sample.invocations.some((row) => row.role === role));
  const gates = (ok: boolean | null): number => samples.filter((sample) => sample.gateOk === ok).length;
  return {
    label,
    runs: samples.length,
    outcomes: tally(samples.flatMap(({ outcome }) => outcome === null ? [] : [outcome])),
    attempts: spreadOf(samples, (sample) => sample.rollup?.attempts),
    rounds: {
      gate: spreadOf(samples, (sample) => sample.rollup?.rounds.gate),
      quality: spreadOf(samples, (sample) => sample.rollup?.rounds.quality),
      review: spreadOf(samples, (sample) => sample.rollup?.rounds.review),
    },
    roles: Object.fromEntries(ROLES.filter(ran).map((role) => [role, roleSpread(samples, role)])),
    gate: { green: gates(true), red: gates(false), unknown: gates(null) },
    diff: {
      files: spreadOf(samples, (sample) => sample.diff?.files),
      insertions: spreadOf(samples, (sample) => sample.diff?.insertions),
      deletions: spreadOf(samples, (sample) => sample.diff?.deletions),
    },
    scenarios: Object.fromEntries(scenarioIds.map((id) => [
      id,
      tally(samples.flatMap(({ clauses }) => clauses.filter((clause) => clause.id === id).map(({ outcome }) => outcome))),
    ])),
  };
}

// Every case, with the original's column and then one per session.
export function compareReplay(args: {
  readonly cases: readonly ReplayCase[];
  // The original run's report by issue, for each case that has one.
  readonly originals: ReadonlyMap<number, StatsReport>;
  readonly sessions: readonly SessionRecords[];
}): ReplayReport {
  return {
    replayReport: 1,
    sessions: args.sessions.map(({ session: { results: _, ...session } }) => session),
    cases: args.cases.map((c) => {
      const scenarios = (c.scenarios?.scenarios ?? []).map(({ id, title }) => ({ id, title }));
      const ids = scenarios.map(({ id }) => id);
      return {
        issue: c.issue,
        title: c.title,
        scenarios,
        columns: [
          column("original", c.original === null ? [] : [originalSample(c, args.originals.get(c.issue))], ids),
          ...args.sessions.map(({ session, runs }) => column(
            session.label,
            session.results.filter((result) => result.issue === c.issue).map((result) => sessionSample(result, runs)),
            ids,
          )),
        ],
      };
    }),
  };
}

// The median, the range when the runs differ, and `n/of` when some runs went
// unmeasured.
function spreadCell(value: Spread): string | null {
  if (value.n === 0) return null;
  const range = value.min === value.max ? "" : ` [${value.min}..${value.max}]`;
  return `${value.median}${range}${value.n < value.of ? ` (${value.n}/${value.of})` : ""}`;
}

const countsCell = (counts: Readonly<Record<string, number | undefined>>): string | null =>
  Object.entries(counts).filter(([, n]) => n !== undefined && n > 0).map(([key, n]) => `${key} ${n}`).join(", ") || null;

const ROLE_METRICS = ["input", "cached", "output", "firstContext", "peakContext"] as const;

function caseTable(c: ReplayCaseReport): string {
  const { columns } = c;
  const row = (metric: string, cell: (column: ReplayColumn) => Cell): readonly Cell[] =>
    [metric, ...columns.map(cell)];
  const roles = ROLES.filter((role) => columns.some((col) => col.roles[role] !== undefined));
  return table(`#${c.issue} ${c.title}`, ["metric", ...columns.map((col) => col.label)], [
    row("runs", (col) => col.runs),
    row("outcomes", (col) => countsCell(col.outcomes)),
    row("attempts", (col) => spreadCell(col.attempts)),
    row("gate rounds", (col) => spreadCell(col.rounds.gate)),
    row("quality rounds", (col) => spreadCell(col.rounds.quality)),
    row("review rounds", (col) => spreadCell(col.rounds.review)),
    row("gate-1 on head", (col) => countsCell(col.gate)),
    row("diff files", (col) => spreadCell(col.diff.files)),
    row("diff insertions", (col) => spreadCell(col.diff.insertions)),
    row("diff deletions", (col) => spreadCell(col.diff.deletions)),
    ...roles.flatMap((role) => ROLE_METRICS.map((metric) => row(`${role} ${metric}`, (col) => {
      const spreads = col.roles[role];
      return spreads === undefined ? null : spreadCell(spreads[metric]);
    }))),
  ]);
}

// A scenario's verdicts, and `n/of` when some runs judged it nothing.
function scenarioCell(counts: ScenarioCounts, runs: number): string | null {
  const judged = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const cell = countsCell(counts);
  return cell === null ? null : `${cell}${judged < runs ? ` (${judged}/${runs})` : ""}`;
}

function scenarioTable(c: ReplayCaseReport): string {
  return table(`#${c.issue} scenarios`, ["scenario", ...c.columns.map((col) => col.label)],
    c.scenarios.map(({ id, title }) => [
      `${id} ${title}`,
      ...c.columns.map((col) => scenarioCell(col.scenarios[id] ?? {}, col.runs)),
    ]));
}

export function renderReplayReport(report: ReplayReport): string {
  const { sessions } = report;
  const roles = [...new Set(sessions.flatMap((session) => Object.keys(session.routing)))];
  return [
    `# Replay: ${["original", ...sessions.map((session) => session.label)].join(" / ")}`,
    "",
    table("Sessions", ["session", "driver", "repeats", "parallel", "quality", "gate", "review", "cases sha256"],
      sessions.map((session) => [
        session.label, session.driver, session.repeats, session.parallel,
        session.budgets.maxQualityRounds, session.budgets.maxGateRounds, session.budgets.maxReviewRounds,
        session.casesSha256.slice(0, 12),
      ])),
    table("Routing", ["role", ...sessions.map((session) => session.label)],
      roles.map((role) => [role, ...sessions.map((session) => {
        const routing = session.routing[role];
        return routing === undefined ? null : describeRouting(routing);
      })])),
    ...report.cases.flatMap((c) => c.scenarios.length === 0 ? [caseTable(c)] : [caseTable(c), scenarioTable(c)]),
  ].join("\n");
}
