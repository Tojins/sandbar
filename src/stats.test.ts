import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { agg, computeStats, describeWindow, renderStatsTables } from "./stats.js";
import { readStatsInput, type StatsEvent, type StatsInput, type StatsRun } from "./stats-record.js";

let seq = 0;
const ev = (fields: Record<string, unknown>): StatsEvent =>
  ({ seq: ++seq, ts: "2026-09-07T10:00:00Z", ...fields }) as unknown as StatsEvent;

const start = (): StatsEvent => ev({
  kind: "run-start", schemaVersion: 6, driver: "sandbar test", configPath: null,
  workdir: "/w", maxParallelIssues: 1, pid: 1,
});
const admitted = (issue: number, chunk: string | null = null): StatsEvent =>
  ev({ kind: "admitted", issue, title: `Issue ${issue}`, branch: `b-${issue}`, chunk, seedRef: "origin/main" });
const terminal = (issue: number, outcome: string, fields: Record<string, unknown> = {}): StatsEvent =>
  ev({ kind: "terminal", issue, title: `Issue ${issue}`, terminal: outcome, reason: null, durationMs: 100, ...fields });
const implementer = (issue: number, attempt: number, usage?: Record<string, unknown>): StatsEvent =>
  ev({
    kind: "implementer", issue, attempt, signal: "COMPLETE", commits: 1, provider: "claude",
    model: "m", effort: null, durationMs: 10, ...(usage === undefined ? {} : { usage }),
  });

const run = (name: string, events: readonly StatsEvent[]): StatsRun =>
  ({ run: name, schemaVersion: 6, driver: "sandbar test", events: [start(), ...events], prose: new Map() });

const input = (runs: readonly StatsRun[], withProse = false): StatsInput =>
  ({ window: { last: 10 }, withProse, runs, skipped: [], ignoredKinds: {} });

describe("describeWindow (#215)", () => {
  it("names a last, since and runs window", () => {
    expect(describeWindow({ last: 3 })).toBe("last 3 runs");
    expect(describeWindow({ since: "2026-01-01" })).toBe("runs since 2026-01-01");
    expect(describeWindow({ runs: ["run-a", "run-b"] })).toBe("runs run-a, run-b");
  });
});

describe("agg (#194, #82)", () => {
  it("separates the population from what was measured", () => {
    expect(agg([4, undefined, 1, null, 3, 2])).toEqual({
      of: 6, n: 4, sum: 10, median: 2, p90: 4, max: 4,
    });
  });

  it("gives null statistics, never zero, when nothing was measured", () => {
    expect(agg([undefined, undefined])).toEqual({
      of: 2, n: 0, sum: null, median: null, p90: null, max: null,
    });
    expect(agg([])).toMatchObject({ of: 0, n: 0, sum: null });
  });
});

describe("computeStats cycles (#194)", () => {
  it("counts a cycle without a terminal as interrupted and keeps its tokens there", () => {
    const report = computeStats(input([
      run("run-1", [
        admitted(1),
        implementer(1, 1, { outputTokens: 50 }),
        ev({ kind: "run-end", reason: "restart" }),
      ]),
      run("run-2", [
        admitted(1),
        implementer(1, 1, { outputTokens: 7 }),
        terminal(1, "DONE"),
      ]),
    ]));
    expect(report.outcomes.byLane.auto).toMatchObject({ interrupted: 1, DONE: 1 });
    expect(report.outcomes.tokens.interrupted.output).toBe(50);
    expect(report.outcomes.tokens.DONE.output).toBe(7);
    // The DONE rollup sums only the cycle that ended.
    expect(report.issues).toEqual([expect.objectContaining({
      issue: 1, outcome: "DONE", cycles: 2, interrupted: 1, attempts: 1,
      tokensByRole: { implementer: { input: null, cached: null, cacheWrite: null, output: 7, reasoning: null } },
    })]);
    expect(report.perDoneIssue.tokensByRole.implementer).toMatchObject({ of: 1, n: 1, sum: 7 });
  });

  it("lets a cycle's first terminal decide its outcome", () => {
    const report = computeStats(input([
      run("run-1", [admitted(1), terminal(1, "NEEDS-INFO"), terminal(1, "DONE")]),
    ]));
    expect(report.outcomes.byLane.auto).toMatchObject({ "NEEDS-INFO": 1, DONE: 0 });
    expect(report.issues[0]?.outcome).toBe("NEEDS-INFO");
  });

  it("rolls a DONE issue up across two runs, its outcome its last cycle's", () => {
    const report = computeStats(input([
      run("run-1", [admitted(2), implementer(2, 1), terminal(2, "NEEDS-INFO", { specGaps: 1 })]),
      run("run-2", [
        admitted(2),
        implementer(2, 1),
        ev({ kind: "gate", issue: 2, attempt: 1, gate: "gate-1", ok: false, durationMs: 1 }),
        implementer(2, 2),
        ev({ kind: "gate", issue: 2, attempt: 2, gate: "gate-1", ok: true, durationMs: 1 }),
        terminal(2, "DONE", { specGaps: 2 }),
      ]),
    ]));
    expect(report.issues).toEqual([expect.objectContaining({
      issue: 2, outcome: "DONE", cycles: 2, interrupted: 0, attempts: 3,
      rounds: { gate: 2, quality: 0, review: 0 }, specGaps: 3, durationMs: 200,
    })]);
    expect(report.outcomes.byLane.auto).toMatchObject({ "NEEDS-INFO": 1, DONE: 1 });
    expect(report.perDoneIssue.attempts).toMatchObject({ of: 1, n: 1, sum: 3 });
    expect(report.passes["gate-1"]).toEqual({ runs: 2, rejected: 1 });
  });

  it("counts each implementer event as an attempt, across a HARD-ERROR renumbering", () => {
    const report = computeStats(input([run("run-1", [
      admitted(3),
      implementer(3, 1),
      ev({ kind: "hard-error", issue: 3, retry: 1, max: 2, reason: "flake" }),
      implementer(3, 1),
      terminal(3, "DONE"),
    ])]));
    expect(report.issues[0]?.attempts).toBe(2);
  });

  it("derives the lane from the admitted chunk and groups parked issues by cause", () => {
    const report = computeStats(input([run("run-1", [
      admitted(4, "sandbar/chunk-4"),
      terminal(4, "NEEDS-PARTITION", { cause: "classifier" }),
      admitted(5),
      terminal(5, "NEEDS-HUMAN"),
    ])]));
    expect(report.outcomes.byLane.review["NEEDS-PARTITION"]).toBe(1);
    expect(report.outcomes.byLane.auto["NEEDS-HUMAN"]).toBe(1);
    expect(report.outcomes.byCause).toEqual({
      "NEEDS-PARTITION:classifier": 1,
      "NEEDS-HUMAN:-": 1,
    });
    expect(report.issues.map((issue) => [issue.lane, issue.cause])).toEqual([
      ["review", "classifier"], ["auto", null],
    ]);
  });

  it("keeps invocations outside any cycle out of the rollups", () => {
    const report = computeStats(input([run("run-1", [
      ev({ kind: "resolve-attempt", issue: 9, attempt: 1, container: "c", end: "exit",
        exitCode: 0, signal: null, durationMs: 5, usage: { outputTokens: 3 } }),
    ])]));
    expect(report.issues).toEqual([]);
    expect(report.invocations).toEqual([expect.objectContaining({
      issue: 9, role: "resolve", result: "exit", provider: null, tokens: expect.objectContaining({ output: 3 }),
    })]);
  });
});

describe("computeStats passes and context (#194)", () => {
  it("rates rejections over verdicts and overrules over rulings", () => {
    const review = (verdict: string | null, mode = "list") => ev({
      kind: "quality-review", issue: 1, attempt: 1, round: 1, invocation: 1, mode,
      scope: "full", provider: "codex", model: "m", effort: null, result: "completed",
      verdict, prose: "", durationMs: 1,
    });
    const round = (attempt: number, correctness: string) => ev({
      kind: "review-round", issue: 1, attempt, round: attempt, head: "h", gateOk: true,
      correctness, rejectingPass: null, gateFailures: 0, correctnessFailures: 0, durationMs: 1,
    });
    const ruling = (pass: string, value: string) => ev({
      kind: "adjudication", issue: 1, pass, attempt: 1, round: 1, head: "h", ruling: value,
      provider: "claude", model: "m", effort: null, durationMs: 1,
    });
    const report = computeStats(input([run("run-1", [
      admitted(1),
      review("CHANGES-REQUESTED"), review("APPROVED"), review(null),
      review("CHANGES-REQUESTED", "verify"),
      round(1, "CHANGES-REQUESTED"), round(2, "APPROVED"), round(3, "SKIPPED"),
      round(4, "HARNESS-FAILED"),
      ruling("correctness", "OVERRULED"), ruling("correctness", "UPHELD"), ruling("quality", "UPHELD"),
    ])]));
    expect(report.passes).toEqual({
      "gate-1": { runs: 0, rejected: 0 },
      "quality-list": { runs: 2, rejected: 1 },
      "quality-verify": { runs: 1, rejected: 1 },
      correctness: { runs: 2, rejected: 1 },
      scenarios: { runs: 0, rejected: 0 },
    });
    expect(report.adjudication).toEqual({
      quality: { rulings: 1, overruled: 0 },
      correctness: { rulings: 2, overruled: 1 },
      scenarios: { rulings: 0, overruled: 0 },
    });
  });

  it("gives a completed review invocation its round's verdict", () => {
    const pass = (invocation: number, result: string) => ev({
      kind: "review-pass", issue: 1, attempt: 1, round: 1, invocation, provider: "codex",
      model: "m", effort: null, result, durationMs: 1, transcript: `attempt-1-reviewer-${invocation}.log`,
    });
    const report = computeStats(input([run("run-1", [
      admitted(1),
      pass(1, "failed"),
      pass(2, "completed"),
      ev({ kind: "review-round", issue: 1, attempt: 1, round: 1, head: "h", gateOk: true,
        correctness: "CHANGES-REQUESTED", rejectingPass: "correctness", gateFailures: 0,
        correctnessFailures: 1, durationMs: 1 }),
    ])]));
    expect(report.invocations.map((row) => [row.transcript, row.verdict])).toEqual([
      ["attempt-1-reviewer-1.log", null],
      ["attempt-1-reviewer-2.log", "CHANGES-REQUESTED"],
    ]);
  });

  it("keeps each round's verdict on its own invocations when a HARD-ERROR retry reuses the attempt", () => {
    const pass = (invocation: number) => ev({
      kind: "review-pass", issue: 1, attempt: 1, round: 1, invocation, provider: "codex",
      model: "m", effort: null, result: "completed", durationMs: 1,
      transcript: `attempt-${invocation}-reviewer-1.log`,
    });
    const round = (correctness: string) => ev({
      kind: "review-round", issue: 1, attempt: 1, round: 1, head: "h", gateOk: true,
      correctness, rejectingPass: correctness === "CHANGES-REQUESTED" ? "correctness" : null,
      gateFailures: 0, correctnessFailures: 0, durationMs: 1,
    });
    // The retry's restarted attempt 1 runs in the same cycle: its `admitted`
    // is dropped (inner-loop.ts), and a round that reached no verdict leaves
    // its invocation unattributed rather than open to the next round.
    const report = computeStats(input([run("run-1", [
      admitted(1),
      pass(1), round("CHANGES-REQUESTED"),
      pass(2), round("HARNESS-FAILED"),
      pass(3), round("APPROVED"),
    ])]));
    expect(report.invocations.map((row) => [row.transcript, row.verdict])).toEqual([
      ["attempt-1-reviewer-1.log", "CHANGES-REQUESTED"],
      ["attempt-2-reviewer-1.log", null],
      ["attempt-3-reviewer-1.log", "APPROVED"],
    ]);
  });

  it("reports a Codex invocation's first-command depth as absent, not zero", () => {
    const report = computeStats(input([run("run-1", [
      admitted(1),
      implementer(1, 1, { peakContext: 90, firstContext: 20, toolCalls: 4 }),
      ev({ kind: "implementer", issue: 1, attempt: 2, signal: "COMPLETE", provider: "codex",
        model: "m", effort: null, durationMs: 1, usage: { peakContext: 80, toolCalls: 2 } }),
    ])]));
    expect(report.context.implementer.first).toEqual({
      of: 2, n: 1, sum: 20, median: 20, p90: 20, max: 20,
    });
    expect(report.context.implementer.peak).toMatchObject({ of: 2, n: 2, max: 90 });
    expect(report.context["quality-list"].first).toMatchObject({ of: 0, n: 0, median: null });
  });

  it("counts gate-2 reds as landed-then-broken", () => {
    const gate2 = (ok: boolean) => ev({ kind: "gate", issue: 1, gate: "gate-2", ok, durationMs: 1 });
    const report = computeStats(input([run("run-1", [gate2(false), gate2(true), gate2(true)])]));
    expect(report.landedThenBroken.gate2).toEqual({ runs: 3, red: 1 });
  });

  it("counts each deploy verdict once per run attempt or uncovered landing (#198)", () => {
    const deploy = (outcome: string, runId: number | null, attempt: number | null, sha = "s") =>
      ev({ kind: "deploy", outcome, workflow: "deploy.yml", runId, attempt, sha, issues: [1],
        bugIssue: null, filed: false });
    const report = computeStats(input([
      run("run-1", [deploy("red", 10, 1), deploy("green", 11, 1), deploy("unverified", null, null, "m1")]),
      // A restart repairing run 10's missing comment, then its green rerun.
      run("run-2", [deploy("red", 10, 1), deploy("green", 10, 2)]),
    ]));
    expect(report.landedThenBroken.deploy).toEqual({ watched: 4, green: 2, red: 1, unverified: 1 });
  });
});

describe("computeStats anchors (#217)", () => {
  const anchor = (issue: number, result: string, chars: readonly [number, number, number], call = {}) =>
    ev({
      kind: "issue-anchor", issue, title: `Issue ${issue}`, result,
      rawChars: chars[0], tracedChars: chars[1], anchorChars: chars[2], comments: 4,
      dropped: chars[1] === chars[2] ? 0 : 2, ...call,
    });

  it("sizes each anchor step and counts only a condenser call as an invocation", () => {
    const report = computeStats(input([run("run-1", [
      admitted(1),
      anchor(1, "condensed", [40_000, 30_000, 12_000], {
        provider: "claude", model: "sonnet", effort: null, durationMs: 9,
        transcript: "anchor-condense-1.log", usage: { outputTokens: 5 },
      }),
      admitted(2),
      anchor(2, "below-threshold", [6_000, 5_000, 5_000]),
      anchor(1, "cache-hit", [40_000, 30_000, 12_000]),
    ])]));
    expect(report.anchors).toEqual({
      issues: 2,
      raw: agg([40_000, 6_000, 40_000]),
      afterTraceDrop: agg([30_000, 5_000, 30_000]),
      condensed: agg([12_000, 5_000, 12_000]),
      condenser: { condensed: 1, "below-threshold": 1, "cache-hit": 1 },
    });
    expect(report.invocations).toEqual([expect.objectContaining({
      issue: 1, role: "condenser", provider: "claude", model: "sonnet", effort: null,
      result: "condensed", durationMs: 9, transcript: "anchor-condense-1.log",
      tokens: { input: null, cached: null, cacheWrite: null, output: 5, reasoning: null },
    })]);
  });
});

describe("computeStats prose (#182)", () => {
  it("carries speech and the terminal reason only with --with-prose", () => {
    const events = [
      admitted(1),
      ev({ kind: "ui-check", issue: 1, invocation: 1, provider: "claude", model: "m",
        effort: null, durationMs: 1, result: "CLEAR", transcript: "ui-check-1.log" }),
      terminal(1, "NEEDS-INFO", { reason: "Which format?" }),
    ];
    const withProse: StatsRun = {
      ...run("run-1", events),
      prose: new Map([["1/ui-check-1.log", "<ui-check>CLEAR</ui-check>"]]),
    };
    const report = computeStats(input([withProse], true));
    expect(report.invocations[0]?.prose).toBe("<ui-check>CLEAR</ui-check>");
    expect(report.issues[0]?.reason).toBe("Which format?");

    const bare = computeStats(input([run("run-1", events)]));
    expect(bare.invocations[0]).not.toHaveProperty("prose");
    expect(bare.issues[0]).not.toHaveProperty("reason");
  });

  it("lists every gate with its red steps and every terminal with its cause", () => {
    const step = (ok: boolean) => ({ ok, durationMs: 1 });
    const report = computeStats(input([run("run-1", [
      admitted(1),
      ev({ kind: "gate", issue: 1, attempt: 1, gate: "gate-1", ok: false, durationMs: 1,
        steps: { build: step(true), smoke: step(false) } }),
      terminal(1, "NEEDS-HUMAN", { cause: "gate-red" }),
      ev({ kind: "gate", issue: 1, gate: "gate-2", ok: false, durationMs: 1 }),
    ])]));
    expect(report.gates).toEqual([
      { run: "run-1", issue: 1, gate: "gate-1", attempt: 1, ok: false, redSteps: ["smoke"] },
      { run: "run-1", issue: 1, gate: "gate-2", attempt: null, ok: false, redSteps: [] },
    ]);
    expect(report.terminals).toEqual([
      { run: "run-1", issue: 1, terminal: "NEEDS-HUMAN", cause: "gate-red" },
    ]);
  });

  it("carries the commits an implementer or quality fixer made, the fixer's by sha", () => {
    const fixer = (fields: Record<string, unknown>) => ev({
      kind: "quality-pass", issue: 1, attempt: 1, round: 1, provider: "codex", model: "m",
      effort: null, durationMs: 1, ...fields,
    });
    const report = computeStats(input([run("run-1", [
      admitted(1),
      implementer(1, 1),
      fixer({ result: "completed", commits: ["a", "b"], discarded: {} }),
      fixer({ result: "quota" }),
    ])]));
    expect(report.invocations.map((row) => [row.role, row.commits, row.shas])).toEqual([
      ["implementer", 1, null], ["quality-fix", 2, ["a", "b"]], ["quality-fix", null, null],
    ]);
  });
});

describe("the scorecard over schema-5 records (#194)", () => {
  const logs = fileURLToPath(new URL("./__fixtures__/stats/logs", import.meta.url));

  it("reduces two runs to the committed report", async () => {
    const report = computeStats(await readStatsInput(logs, { last: 10 }, { withProse: false }));
    await expect(`${JSON.stringify(report, null, 2)}\n`)
      .toMatchFileSnapshot("./__fixtures__/stats/report.golden.json");
  });

  it("renders the committed tables, absent values as -", async () => {
    const report = computeStats(await readStatsInput(logs, { last: 10 }, { withProse: false }));
    await expect(renderStatsTables(report))
      .toMatchFileSnapshot("./__fixtures__/stats/report.golden.txt");
  });
});
