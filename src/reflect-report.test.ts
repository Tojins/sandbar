import { describe, expect, it } from "vitest";

import type { Mining } from "./reflect-mine.js";
import { renderReport, reportFileName, type ReportInput } from "./reflect-report.js";
import { computeStats, type StatsReport } from "./stats.js";
import type { StatsRun } from "./stats-record.js";

const statsOf = (runs: readonly string[], skipped: StatsReport["skipped"] = []): StatsReport =>
  computeStats({
    window: { last: 10 },
    withProse: true,
    runs: runs.map((run, index): StatsRun => ({
      run,
      schemaVersion: 6,
      driver: `sandbar 0.5${index}.0`,
      events: [],
      prose: new Map(),
    })),
    skipped,
    ignoredKinds: {},
  });

const mining: Mining = {
  structured: [
    {
      key: "gate:gate-1:smoke",
      issues: [7, 9],
      count: 3,
      members: [
        { run: "run-1", issue: 7, attempt: 1 },
        { run: "run-1", issue: 7, attempt: 2 },
        { run: "run-2", issue: 9, attempt: 1 },
      ],
    },
    {
      key: "park:NEEDS-INFO:-",
      issues: [8, 9],
      count: 2,
      members: [
        { run: "run-1", issue: 8 },
        { run: "run-2", issue: 9 },
      ],
    },
    {
      key: "fail:implementer:FAILED",
      issues: [7, 8],
      count: 2,
      members: [
        { run: "run-1", issue: 7, attempt: 3, transcript: "implementer-3.log" },
        { run: "run-2", issue: 8, attempt: 1, transcript: "implementer-1.log" },
      ],
    },
  ],
  buckets: [],
  outliers: [
    { issue: 8, rounds: 2, attempts: 1, specGaps: null, outcome: "NEEDS-INFO", reason: "Which | format?\nSVG or PDF" },
    { issue: 9, rounds: 11, attempts: 4, specGaps: 2, outcome: "DONE", reason: null },
  ],
};

const input = (fields: Partial<ReportInput> = {}): ReportInput => ({
  stats: statsOf(["run-1", "run-2"], [{ run: "run-0", reason: "unsupported event schema 4", schemaVersion: 4 }]),
  mining,
  candidates: [{ key: "rule:quality:R6", title: "Non-atomic orchestration.", listerIssues: 31 }],
  logsDir: "/srv/app/.sandbar/logs",
  repo: "acme/app",
  ...fields,
});

describe("renderReport (#182, #207)", () => {
  it("renders the tables with each cluster's evidence", async () => {
    await expect(renderReport(input()))
      .toMatchFileSnapshot("./__fixtures__/reflect/report-evidence.golden.md");
  });

  it("renders every table, empty, over a window with nothing in it", async () => {
    await expect(renderReport(input({
      stats: statsOf([]),
      mining: { structured: [], buckets: [], outliers: [] },
      candidates: [],
    }))).toMatchFileSnapshot("./__fixtures__/reflect/report-empty.golden.md");
  });
});

describe("reportFileName", () => {
  it("names the newest run, the run count and the content", () => {
    const stats = statsOf(["run-1", "run-2"]);
    expect(reportFileName(stats, "a")).toMatch(/^report-run-2-n2-[0-9a-f]{8}\.md$/);
    expect(reportFileName(stats, "a")).toBe(reportFileName(stats, "a"));
    expect(reportFileName(stats, "b")).not.toBe(reportFileName(stats, "a"));
    expect(reportFileName(statsOf([]), "a")).toMatch(/^report-none-n0-/);
  });
});
