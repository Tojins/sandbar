import { describe, expect, it } from "vitest";

import {
  type ReplayCase,
  type ReplayResult,
  type ReplaySession,
  type SessionRecords,
  caseCacheRefUpdates,
  commentsAtCutoff,
  compareReplay,
  lastDoneAdmission,
  parseNumstat,
  parseReplayCases,
  planReplay,
  renderReplayPlan,
  renderReplayReport,
  spread,
  stripForgeCredentials,
} from "./replay.js";
import type { ScenarioSet } from "./scenario-parser.js";
import { type StatsReport, computeStats } from "./stats.js";
import type { StatsEvent } from "./stats-record.js";

const SEED = "a".repeat(40);

const replayCase = (issue: number, extra: Partial<ReplayCase> = {}): ReplayCase => ({
  issue,
  title: `Issue ${issue}`,
  seedSha: SEED,
  seedFrom: "recorded",
  issueJson: { title: `Issue ${issue}`, body: "", comments: [] },
  issueFrom: "recorded",
  original: { logsDir: "/logs", run: "run-1" },
  landed: { merge: "b".repeat(40), tip: "c".repeat(40), diff: { files: 1, insertions: 2, deletions: 0 } },
  ...extra,
} as ReplayCase);

const pinned = (issue: number, ids = 2): ScenarioSet => ({
  version: 1,
  issue,
  seed: { ref: "origin/main", sha: SEED },
  writer: { provider: "claude", model: "m", effort: null },
  scenarios: Array.from({ length: ids }, (_, i) => ({
    id: `S${i + 1}`, title: `Clause ${i + 1}`, needs: ["cli"], area: [], given: ["g"], when: ["w"], then: ["t"],
  })),
});

const caseFile = (cases: readonly unknown[]) => ({
  replayCases: 1,
  repo: "acme/app",
  sourceBranch: "main",
  cases,
});

describe("parseReplayCases (#195)", () => {
  it("accepts a well-formed case file", () => {
    const file = caseFile([
      replayCase(1),
      replayCase(2, { issueFrom: "reconstructed", editedAfterAdmission: true, original: null, landed: null }),
      replayCase(3, { scenarios: pinned(3) }),
    ]);
    expect(parseReplayCases(file)).toEqual({ cases: file });
  });

  it("names a pinned set that is no set, or another issue's", () => {
    expect(parseReplayCases(caseFile([
      replayCase(1, { scenarios: { ...pinned(1), version: 2 } as unknown as ScenarioSet }),
      replayCase(2, { scenarios: pinned(9) }),
    ]))).toEqual({
      errors: [
        "cases[0].scenarios version is not 1",
        "cases[1].scenarios were written for another issue",
      ],
    });
  });

  it("lists every violation, not the first", () => {
    expect(parseReplayCases({
      replayCases: 2,
      repo: "app",
      sourceBranch: "",
      cases: [
        replayCase(1, { seedSha: "abc" }),
        replayCase(1, { issueFrom: "reconstructed" } as Partial<ReplayCase>),
        { ...replayCase(0), seedFrom: "guess", issueJson: [], editedAfterAdmission: false, original: { run: "" } },
        replayCase(3, { landed: { merge: SEED, tip: "nope", diff: { files: -1, insertions: 0, deletions: 0 } } }),
        "seven",
      ],
    })).toEqual({
      errors: [
        "replayCases is not 1",
        "repo is not owner/name",
        "sourceBranch is not a non-empty string",
        "cases[0].seedSha is not a 40-hex sha",
        "cases[1].issue #1 is listed twice",
        "cases[1].editedAfterAdmission is not a boolean",
        "cases[2].issue is not a positive integer",
        "cases[2].seedFrom is not recorded, merge-base or manual",
        "cases[2].issueJson is not an object",
        "cases[2].editedAfterAdmission is set on a recorded issue",
        "cases[2].original is neither null nor { logsDir, run }",
        "cases[3].landed is neither null nor { merge, tip, diff } with 40-hex shas and counts",
        "cases[4] is not an object",
      ],
    });
  });

  const LANDED = "cases[0].landed is neither null nor { merge, tip, diff } with 40-hex shas and counts";
  const goodLanded = { merge: "b".repeat(40), tip: "c".repeat(40), diff: { files: 1, insertions: 2, deletions: 0 } };
  it.each<[string, Record<string, unknown>, string]>([
    ["a non-object original", { original: "run-1" }, "cases[0].original is neither null nor { logsDir, run }"],
    ["an original without a run", { original: { logsDir: "/logs" } }, "cases[0].original is neither null nor { logsDir, run }"],
    ["an original without logsDir", { original: { run: "run-1" } }, "cases[0].original is neither null nor { logsDir, run }"],
    ["a non-object landed", { landed: "merged" }, LANDED],
    ["a landed merge that is no sha", { landed: { ...goodLanded, merge: "nope" } }, LANDED],
    ["a landed tip that is no sha", { landed: { ...goodLanded, tip: 7 } }, LANDED],
    ["a landed with no diff", { landed: { merge: goodLanded.merge, tip: goodLanded.tip } }, LANDED],
    ["a negative diff count", { landed: { ...goodLanded, diff: { ...goodLanded.diff, files: -1 } } }, LANDED],
    ["a fractional diff count", { landed: { ...goodLanded, diff: { ...goodLanded.diff, insertions: 1.5 } } }, LANDED],
    ["a string diff count", { landed: { ...goodLanded, diff: { ...goodLanded.diff, deletions: "0" } } }, LANDED],
    [
      "editedAfterAdmission on a recorded issue",
      { editedAfterAdmission: false },
      "cases[0].editedAfterAdmission is set on a recorded issue",
    ],
    ["an issueJson with no object", { issueJson: "text" }, "cases[0].issueJson is not an object"],
    ["an issueJson title that is no string", { issueJson: { title: 7 } }, "cases[0].issueJson title is not a string"],
    ["an issueJson body that is no string", { issueJson: { body: null } }, "cases[0].issueJson body is not a string"],
    ["issueJson comments that are no array", { issueJson: { comments: {} } }, "cases[0].issueJson comments is not an array"],
    [
      "an issueJson comment that is no object",
      { issueJson: { comments: ["late"] } },
      "cases[0].issueJson comments[0] is not an object",
    ],
    [
      "an issueJson comment time that is no string",
      { issueJson: { comments: [{ createdAt: 5 }] } },
      "cases[0].issueJson comments[0].createdAt is not a string",
    ],
    [
      "an issueJson comment author login that is no string",
      { issueJson: { comments: [{ author: { login: 5 } }] } },
      "cases[0].issueJson comments[0].author.login is not a string",
    ],
  ])("names %s", (_, extra, error) => {
    expect(parseReplayCases(caseFile([{ ...replayCase(1), ...extra }]))).toEqual({ errors: [error] });
  });

  it.each([
    [null, "the case file is not a JSON object"],
    [[], "the case file is not a JSON object"],
    [caseFile([]), "cases is not a non-empty array"],
  ])("refuses %j", (value, error) => {
    expect(parseReplayCases(value)).toEqual({ errors: [error] });
  });
});

describe("planReplay (#195)", () => {
  const cases = [replayCase(1), replayCase(2)];
  const order = (repeats: number) =>
    planReplay(cases, repeats).map((repeat) => repeat.map((run) => `${run.repeat}:${run.case.issue}`));

  it("runs every case once for k = 1", () => {
    expect(order(1)).toEqual([["1:1", "1:2"]]);
  });

  it("runs repeat-major for k = 3", () => {
    expect(order(3)).toEqual([["1:1", "1:2"], ["2:1", "2:2"], ["3:1", "3:2"]]);
  });
});

describe("stripForgeCredentials (#195)", () => {
  it("removes every forge credential and keeps the rest", () => {
    expect(stripForgeCredentials({
      GH_TOKEN: "t",
      GITHUB_TOKEN: "t",
      GH_ENTERPRISE_TOKEN: "t",
      SSH_AUTH_SOCK: "/agent.sock",
      CLAUDE_CODE_OAUTH_TOKEN: "c",
      GH_HOST: "github.com",
    })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "c", GH_HOST: "github.com" });
  });
});

describe("caseCacheRefUpdates (#195)", () => {
  it("deletes heads, tags and remotes and writes the one seed ref", () => {
    expect(caseCacheRefUpdates(
      [
        "refs/heads/main",
        "refs/remotes/origin/main",
        "refs/remotes/origin/sandbar/issue-9-later",
        "refs/sandbar/lock",
        "refs/tags/v1",
      ],
      "main",
      SEED,
    )).toEqual([
      "delete refs/heads/main",
      "delete refs/remotes/origin/sandbar/issue-9-later",
      "delete refs/sandbar/lock",
      "delete refs/tags/v1",
      `update refs/remotes/origin/main ${SEED}`,
    ]);
  });
});

describe("commentsAtCutoff (#195)", () => {
  it("keeps comments made by the cutoff, inclusive, and drops undated ones", () => {
    const issue = {
      title: "t",
      body: "b",
      comments: [
        { body: "before", createdAt: "2026-10-28T12:00:00Z" },
        { body: "at", createdAt: "2026-10-28T12:00:01Z" },
        { body: "after", createdAt: "2026-10-28T12:00:01.001Z" },
        { body: "undated" },
      ],
    };
    expect(commentsAtCutoff(issue, "2026-10-28T12:00:01.000Z").comments?.map((c) => c.body))
      .toEqual(["before", "at"]);
  });
});

describe("lastDoneAdmission (#195)", () => {
  const admitted = (ts: string, extra: object = {}) =>
    ({ kind: "admitted", issue: 7, title: "Seven", ts, ...extra });
  const terminal = (outcome: string) => ({ kind: "terminal", issue: 7, terminal: outcome });

  it("is the admission behind the last DONE, with its replay fields", () => {
    expect(lastDoneAdmission("run-x", [
      admitted("t1", { seedSha: "old" }),
      terminal("DONE"),
      { kind: "admitted", issue: 8, title: "Eight", ts: "t2" },
      admitted("t3", { seedSha: SEED, issueSnapshot: "issue-snapshot-2.json" }),
      terminal("DONE"),
      admitted("t4"),
      terminal("NEEDS-HUMAN"),
    ], 7)).toEqual({
      run: "run-x",
      ts: "t3",
      title: "Seven",
      seedSha: SEED,
      issueSnapshot: "issue-snapshot-2.json",
      scenarios: null,
    });
  });

  it("is null without a DONE, and reads an older record's missing fields as null", () => {
    expect(lastDoneAdmission("run-x", [admitted("t1"), terminal("HARD-ERROR")], 7)).toBeNull();
    expect(lastDoneAdmission("run-x", [admitted("t1"), terminal("DONE")], 7))
      .toMatchObject({ seedSha: null, issueSnapshot: null, scenarios: null });
  });

  // #240: only a written set is filed, numbered per issue across the run.
  it("names the set its own admission's writer filed", () => {
    const writer = (issue: number, scenarios?: number) =>
      ({ kind: "scenario-writer", issue, result: "completed", ...(scenarios === undefined ? {} : { scenarios }) });
    const events = [
      admitted("t1"),
      writer(7, 3),
      terminal("NEEDS-INFO"),
      { kind: "admitted", issue: 8, title: "Eight", ts: "t2" },
      writer(8, 2),
      admitted("t3"),
      writer(7),
      writer(7, 0),
      terminal("DONE"),
      admitted("t4"),
      writer(7, 4),
      terminal("DONE"),
    ];
    expect(lastDoneAdmission("run-x", events, 7)).toMatchObject({ ts: "t4", scenarios: "scenarios-2.json" });
    expect(lastDoneAdmission("run-x", events.slice(0, 9), 7)).toMatchObject({ ts: "t3", scenarios: null });
  });
});

describe("parseNumstat (#195)", () => {
  it("counts files and lines, a binary file as no lines", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\n-\t-\timg.png\n10\t0\tsrc/b.ts\n"))
      .toEqual({ files: 3, insertions: 13, deletions: 1 });
    expect(parseNumstat("")).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});

describe("renderReplayPlan (#195)", () => {
  it("states the spend, the routing and the shared quota", () => {
    expect(renderReplayPlan({
      label: "baseline",
      cases: 12,
      repeats: 3,
      parallel: 2,
      routing: {
        implementer: { agent: "claude", model: "opus", effort: "high" },
        adjudicator: { agent: "codex", model: "gpt-5.6", effort: null },
      },
    })).toBe([
      "replay baseline: 12 cases × 3 = 36 runs, 2 at a time",
      "  implementer  claude opus (effort high)",
      "  adjudicator  codex gpt-5.6",
      "Every run spends real tokens from the same model quota as any sandbar daemon on this account.",
    ].join("\n"));
  });
});

// A one-run report from the events after its run-start.
let seq = 0;
const ev = (fields: Record<string, unknown>): StatsEvent =>
  ({ seq: ++seq, ts: "2026-10-01T10:00:00Z", ...fields }) as unknown as StatsEvent;
const statsOf = (run: string, events: readonly Record<string, unknown>[]): StatsReport => computeStats({
  window: { runs: [run] },
  withProse: false,
  runs: [{
    run,
    schemaVersion: 6,
    driver: "sandbar test",
    events: [
      ev({ kind: "run-start", schemaVersion: 6, driver: "sandbar test", configPath: null, workdir: "/w", maxParallelIssues: 1, pid: 1 }),
      ...events.map(ev),
    ],
    prose: new Map(),
  }],
  skipped: [],
  ignoredKinds: {},
});
const admittedEvent = (issue: number) =>
  ({ kind: "admitted", issue, title: `Issue ${issue}`, branch: `b-${issue}`, chunk: null, seedRef: "origin/main" });
const implementerEvent = (issue: number, attempt: number, usage: Record<string, unknown> | null) => ({
  kind: "implementer", issue, attempt, signal: "COMPLETE", commits: 1, provider: "claude", model: "m",
  effort: null, durationMs: 1, ...(usage === null ? {} : { usage }),
});
const gateEvent = (issue: number, attempt: number, ok: boolean) =>
  ({ kind: "gate", issue, attempt, gate: "gate-1", ok, durationMs: 1 });
const terminalEvent = (issue: number, outcome: string) =>
  ({ kind: "terminal", issue, title: `Issue ${issue}`, terminal: outcome, reason: null, durationMs: 1 });

// An issue's cycle of `attempts` implementer attempts, each with its usage.
const cycleOf = (issue: number, usages: readonly (Record<string, unknown> | null)[], outcome = "DONE") => [
  admittedEvent(issue),
  ...usages.map((usage, i) => implementerEvent(issue, i + 1, usage)),
  gateEvent(issue, usages.length, true),
  terminalEvent(issue, outcome),
];

const usage = (input: number, first: number, peak: number) =>
  ({ inputTokens: input, cachedInputTokens: 10, outputTokens: 5, firstContext: first, peakContext: peak });

const ran = (repeat: number, issue: number, extra: Partial<ReplayResult> = {}): ReplayResult => ({
  repeat,
  run: `run-r${repeat}`,
  issue,
  seedSha: SEED,
  branch: `b-${issue}`,
  status: "ran",
  terminal: "DONE",
  tip: "d".repeat(40),
  lastGateOk: true,
  diff: { files: repeat, insertions: 10 * repeat, deletions: 0 },
  ...extra,
} as ReplayResult);

const sessionOf = (label: string, results: readonly ReplayResult[]): ReplaySession => ({
  replaySession: 1,
  label,
  driver: `sandbar ${label}`,
  casesFile: "/cases.json",
  casesSha256: "f".repeat(64),
  repeats: Math.max(...results.map((result) => result.repeat)),
  parallel: 1,
  routing: { implementer: { agent: "claude", model: label, effort: null } },
  budgets: { maxQualityRounds: 2, maxGateRounds: 3, maxReviewRounds: 2 },
  results,
});

const records = (session: ReplaySession, runs: Record<string, StatsReport>): SessionRecords =>
  ({ session, runs: new Map(Object.entries(runs)) });

describe("spread (#195, #82)", () => {
  it("is min, median and max of the measured values, over every run", () => {
    expect(spread([3, null, 1, 2])).toEqual({ of: 4, n: 3, min: 1, median: 2, max: 3 });
    expect(spread([null])).toEqual({ of: 1, n: 0, min: null, median: null, max: null });
    expect(spread([])).toEqual({ of: 0, n: 0, min: null, median: null, max: null });
  });
});

describe("compareReplay (#195)", () => {
  const original = statsOf("run-orig", [
    admittedEvent(1),
    implementerEvent(1, 1, usage(100, 1000, 3000)),
    gateEvent(1, 1, false),
    implementerEvent(1, 2, usage(50, 2000, 4000)),
    gateEvent(1, 2, true),
    terminalEvent(1, "DONE"),
  ]);

  it("columns the original first, then each session in the order given", () => {
    const report = compareReplay({
      cases: [replayCase(1)],
      originals: new Map([[1, original]]),
      sessions: [
        records(sessionOf("base", [ran(1, 1)]), { "run-r1": statsOf("run-r1", cycleOf(1, [usage(1, 1, 1)])) }),
        records(sessionOf("cand", [ran(1, 1)]), { "run-r1": statsOf("run-r1", cycleOf(1, [usage(1, 1, 1)])) }),
      ],
    });
    expect(report.replayReport).toBe(1);
    expect(report.sessions.map((session) => session.label)).toEqual(["base", "cand"]);
    expect(report.sessions[0]).not.toHaveProperty("results");
    expect(report.cases.map((c) => [c.issue, c.title, c.columns.map((col) => col.label)]))
      .toEqual([[1, "Issue 1", ["original", "base", "cand"]]]);
  });

  it("reads the original's outcome and last gate-1 from its record and its diff from the landing", () => {
    const [col] = compareReplay({ cases: [replayCase(1)], originals: new Map([[1, original]]), sessions: [] })
      .cases[0]!.columns;
    expect(col).toEqual({
      label: "original",
      runs: 1,
      outcomes: { DONE: 1 },
      attempts: { of: 1, n: 1, min: 2, median: 2, max: 2 },
      rounds: {
        gate: { of: 1, n: 1, min: 2, median: 2, max: 2 },
        quality: { of: 1, n: 1, min: 0, median: 0, max: 0 },
        review: { of: 1, n: 1, min: 0, median: 0, max: 0 },
      },
      roles: {
        implementer: {
          input: { of: 1, n: 1, min: 150, median: 150, max: 150 },
          cached: { of: 1, n: 1, min: 20, median: 20, max: 20 },
          output: { of: 1, n: 1, min: 10, median: 10, max: 10 },
          firstContext: { of: 1, n: 1, min: 1000, median: 1000, max: 1000 },
          peakContext: { of: 1, n: 1, min: 4000, median: 4000, max: 4000 },
        },
      },
      gate: { green: 1, red: 0, unknown: 0 },
      diff: {
        files: { of: 1, n: 1, min: 1, median: 1, max: 1 },
        insertions: { of: 1, n: 1, min: 2, median: 2, max: 2 },
        deletions: { of: 1, n: 1, min: 0, median: 0, max: 0 },
      },
    });
  });

  it("spreads a session's k repeats, each read from its own run", () => {
    const session = sessionOf("base", [ran(1, 1), ran(2, 1, { terminal: "NEEDS-HUMAN", lastGateOk: false }), ran(3, 1)]);
    const [, col] = compareReplay({
      cases: [replayCase(1)],
      originals: new Map(),
      sessions: [records(session, {
        "run-r1": statsOf("run-r1", cycleOf(1, [usage(10, 100, 100)])),
        "run-r2": statsOf("run-r2", cycleOf(1, [usage(10, 300, 300), usage(10, 900, 900)], "NEEDS-HUMAN")),
        "run-r3": statsOf("run-r3", cycleOf(1, [usage(10, 200, 200), usage(10, 50, 250), usage(10, 1, 1)])),
      })],
    }).cases[0]!.columns;
    expect(col!.runs).toBe(3);
    expect(col!.outcomes).toEqual({ DONE: 2, "NEEDS-HUMAN": 1 });
    expect(col!.attempts).toEqual({ of: 3, n: 3, min: 1, median: 2, max: 3 });
    expect(col!.roles.implementer?.input).toEqual({ of: 3, n: 3, min: 10, median: 20, max: 30 });
    expect(col!.roles.implementer?.firstContext).toEqual({ of: 3, n: 3, min: 100, median: 200, max: 300 });
    expect(col!.roles.implementer?.peakContext).toEqual({ of: 3, n: 3, min: 100, median: 250, max: 900 });
    expect(col!.gate).toEqual({ green: 2, red: 1, unknown: 0 });
    expect(col!.diff.files).toEqual({ of: 3, n: 3, min: 1, median: 2, max: 3 });
  });

  it("counts an unmeasured value in of but not n, and a not-run result as a run with nothing measured", () => {
    const session = sessionOf("base", [
      ran(1, 1),
      ran(2, 1, { lastGateOk: null }),
      { repeat: 3, run: null, issue: 1, seedSha: SEED, branch: "b-1", status: "not-run", reason: "QUOTA: out" },
    ]);
    const [, col] = compareReplay({
      cases: [replayCase(1)],
      originals: new Map(),
      sessions: [records(session, {
        "run-r1": statsOf("run-r1", cycleOf(1, [usage(10, 100, 100)])),
        "run-r2": statsOf("run-r2", cycleOf(1, [null])),
      })],
    }).cases[0]!.columns;
    expect(col!.runs).toBe(3);
    expect(col!.outcomes).toEqual({ DONE: 2, "not-run": 1 });
    expect(col!.attempts).toEqual({ of: 3, n: 2, min: 1, median: 1, max: 1 });
    expect(col!.roles.implementer?.input).toEqual({ of: 3, n: 1, min: 10, median: 10, max: 10 });
    expect(col!.gate).toEqual({ green: 1, red: 0, unknown: 2 });
    expect(col!.diff.files).toEqual({ of: 3, n: 2, min: 1, median: 1, max: 2 });
  });

  it("leaves outcome and record metrics absent where a run's record has no cycle of the issue", () => {
    const [orig, col] = compareReplay({
      cases: [replayCase(1)],
      originals: new Map([[1, statsOf("run-orig", [])]]),
      sessions: [records(sessionOf("base", [ran(1, 1)]), { "run-r1": statsOf("run-r1", []) })],
    }).cases[0]!.columns;
    expect([orig!.outcomes, orig!.attempts, orig!.roles, orig!.gate]).toEqual([
      {}, { of: 1, n: 0, min: null, median: null, max: null }, {}, { green: 0, red: 0, unknown: 1 },
    ]);
    expect([col!.outcomes, col!.attempts.n, col!.gate.green, col!.diff.files.n]).toEqual([{ DONE: 1 }, 0, 1, 1]);
  });

  it("gives a case with no original run an original column of no runs", () => {
    const [orig] = compareReplay({
      cases: [replayCase(1, { original: null, landed: null })],
      originals: new Map(),
      sessions: [],
    }).cases[0]!.columns;
    expect(orig).toEqual({
      label: "original",
      runs: 0,
      outcomes: {},
      attempts: spread([]),
      rounds: { gate: spread([]), quality: spread([]), review: spread([]) },
      roles: {},
      gate: { green: 0, red: 0, unknown: 0 },
      diff: { files: spread([]), insertions: spread([]), deletions: spread([]) },
    });
  });
});

describe("renderReplayReport (#195)", () => {
  it("tables the sessions, their routing and each case side by side", () => {
    const base = sessionOf("base", [
      ran(1, 1),
      ran(1, 2, { terminal: "NEEDS-HUMAN", lastGateOk: false }),
      ran(2, 1),
      { repeat: 2, run: "run-r2", issue: 2, seedSha: SEED, branch: "b-2", status: "not-run", reason: "QUOTA: out" },
    ]);
    const report = compareReplay({
      cases: [replayCase(1), replayCase(2, { original: null, landed: null })],
      originals: new Map([[1, statsOf("run-orig", cycleOf(1, [usage(100, 1000, 3000)]))]]),
      sessions: [records(base, {
        "run-r1": statsOf("run-r1", [...cycleOf(1, [usage(10, 100, 200)]), ...cycleOf(2, [null], "NEEDS-HUMAN")]),
        "run-r2": statsOf("run-r2", cycleOf(1, [usage(30, 300, 400), usage(10, 500, 900)])),
      })],
    });
    expect(renderReplayReport(report)).toBe([
      "# Replay: original / base",
      "",
      "## Sessions",
      "session  driver        repeats  parallel  quality  gate  review  cases sha256",
      "base     sandbar base  2        1         2        3     2       ffffffffffff",
      "",
      "## Routing",
      "role         base",
      "implementer  claude base",
      "",
      "## #1 Issue 1",
      "metric                    original  base",
      "runs                      1         2",
      "outcomes                  DONE 1    DONE 2",
      "attempts                  1         1 [1..2]",
      "gate rounds               1         1",
      "quality rounds            0         0",
      "review rounds             0         0",
      "gate-1 on head            green 1   green 2",
      "diff files                1         1 [1..2]",
      "diff insertions           2         10 [10..20]",
      "diff deletions            0         0",
      "implementer input         100       10 [10..40]",
      "implementer cached        10        10 [10..20]",
      "implementer output        5         5 [5..10]",
      "implementer firstContext  1000      100 [100..300]",
      "implementer peakContext   3000      200 [200..900]",
      "",
      "## #2 Issue 2",
      "metric                    original  base",
      "runs                      0         2",
      "outcomes                  -         NEEDS-HUMAN 1, not-run 1",
      "attempts                  -         1 (1/2)",
      "gate rounds               -         1 (1/2)",
      "quality rounds            -         0 (1/2)",
      "review rounds             -         0 (1/2)",
      "gate-1 on head            -         red 1, unknown 1",
      "diff files                -         1 (1/2)",
      "diff insertions           -         10 (1/2)",
      "diff deletions            -         0 (1/2)",
      "implementer input         -         -",
      "implementer cached        -         -",
      "implementer output        -         -",
      "implementer firstContext  -         -",
      "implementer peakContext   -         -",
      "",
    ].join("\n"));
  });
});
