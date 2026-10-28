import { describe, expect, it } from "vitest";

import type { Mining } from "./reflect-mine.js";
import {
  parseSynthesis,
  renderReport,
  reportFileName,
  type AgentsRun,
  type ReportInput,
  type SynthesisContext,
} from "./reflect-report.js";
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
  clusters: mining.structured,
  candidates: [{ key: "rule:quality:R6", title: "Non-atomic orchestration.", listerIssues: 31 }],
  outliers: mining.outliers,
  logsDir: "/srv/app/.sandbar/logs",
  repo: "acme/app",
  agents: null,
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
      clusters: [],
      candidates: [],
      outliers: [],
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

const tagged = {
  key: "tag:quality:R3",
  issues: [7, 8],
  count: 2,
  members: [
    { run: "run-1", issue: 7, transcript: "quality-1.log" },
    { run: "run-2", issue: 8, transcript: "quality-2.log" },
  ],
};

const context: SynthesisContext = {
  keys: new Set([
    ...mining.structured.map((cluster) => cluster.key), tagged.key, "rule:quality:R6", "outlier:8", "outlier:9",
  ]),
  targets: new Set(["sandbar/prompts/coding-standards.md", "consumer/CLAUDE.md"]),
};

const proposal = (fields: Record<string, string>, body = "Body."): string =>
  ["@proposal", ...Object.entries(fields).map(([name, value]) => `${name}: ${value}`), "", body].join("\n");

const edit = {
  category: "prose-edit",
  repo: "consumer",
  target: "consumer/CLAUDE.md",
  evidence: "tag:quality:R3, fail:implementer:FAILED",
  title: "Name the smoke fixture",
};

const answer = (...blocks: readonly string[]): string =>
  `I read the clusters.\n<proposals>\n${blocks.join("\n")}\n</proposals>\nDone.`;

describe("parseSynthesis (#182 Design)", () => {
  it("reads proposals with their bodies and no-action lines whose keys carry colons", () => {
    expect(parseSynthesis(answer(
      proposal(edit, "Add a line:\n\n- the fixture name"),
      proposal({
        category: "structural-check", repo: "sandbar", target: "sandbar/prompts/coding-standards.md",
        evidence: "gate:gate-1:smoke", mechanism: "gate-step", title: "Gate the smoke step",
      }),
      proposal({ category: "missing-signal", repo: "sandbar", target: "issue-writing",
        evidence: "park:NEEDS-INFO:-", event: "terminal.cause", title: "Type the cause" }),
      proposal({ category: "deletion", repo: "sandbar", target: "sandbar/prompts/coding-standards.md",
        evidence: "rule:quality:R6", title: "Drop R6" }),
      proposal({ category: "issue-writing", repo: "consumer", target: "issue-writing",
        evidence: "outlier:8, outlier:9", title: "State the format" }),
      "@no-action tag:quality:R3: preventive, and repeated in the implementer prompt",
    ), context)).toEqual({
      proposals: [
        { ...edit, evidence: ["tag:quality:R3", "fail:implementer:FAILED"], body: "Add a line:\n\n- the fixture name" },
        { category: "structural-check", repo: "sandbar", target: "sandbar/prompts/coding-standards.md",
          evidence: ["gate:gate-1:smoke"], mechanism: "gate-step", title: "Gate the smoke step", body: "Body." },
        { category: "missing-signal", repo: "sandbar", target: "issue-writing", evidence: ["park:NEEDS-INFO:-"],
          event: "terminal.cause", title: "Type the cause", body: "Body." },
        { category: "deletion", repo: "sandbar", target: "sandbar/prompts/coding-standards.md",
          evidence: ["rule:quality:R6"], title: "Drop R6", body: "Body." },
        { category: "issue-writing", repo: "consumer", target: "issue-writing", evidence: ["outlier:8", "outlier:9"],
          title: "State the format", body: "Body." },
      ],
      noAction: [{ key: "tag:quality:R3", reason: "preventive, and repeated in the implementer prompt" }],
      dropped: [],
    });
  });

  it("is an error without a proposals block", () => {
    expect(parseSynthesis("Nothing to say.", context)).toEqual({ error: expect.stringContaining("<proposals>") });
    expect(parseSynthesis("<proposals>\n@proposal", context)).toEqual({ error: expect.stringContaining("</proposals>") });
  });

  it.each([
    ["an unknown key", { evidence: "tag:quality:R9" }, "cites unknown key tag:quality:R9"],
    ["no evidence", { evidence: " , " }, "cites no evidence"],
    ["a target outside the workspace", { target: "consumer/README.md" }, "target consumer/README.md is not a path in the workspace"],
    ["a deletion without a rule key", { category: "deletion" }, "a deletion cites no rule: key"],
    ["issue writing over one outlier", { category: "issue-writing", evidence: "outlier:8, gate:gate-1:smoke" },
      "cites fewer than 2 outlier issues"],
    ["a mechanism off a structural check", { mechanism: "lint" }, "mechanism belongs to a structural-check"],
    ["a structural check without one", { category: "structural-check" }, "mechanism belongs to a structural-check"],
    ["an unknown mechanism", { category: "structural-check", mechanism: "vibes" }, "mechanism must be one of"],
    ["an event off a missing signal", { event: "x" }, "event belongs to a missing-signal"],
    ["an unknown category", { category: "replay" }, "unknown category replay"],
    ["an unknown repo", { repo: "upstream" }, "repo must be one of sandbar, consumer"],
    ["an unknown field", { owner: "me" }, "unknown field owner"],
    ["no title", { title: "" }, "missing title"],
  ])("drops a proposal with %s", (_name, fields, reason) => {
    const synthesis = parseSynthesis(answer(proposal({ ...edit, ...fields })), context);
    expect(synthesis).toMatchObject({ proposals: [], dropped: [{ reason: expect.stringContaining(reason) }] });
  });

  it.each([
    ["a duplicated field", "title: A\ntitle: B", "title is given twice"],
    ["a header line with no colon", "just words", "malformed header line: just words"],
    ["a malformed line before an unknown field", "just words\nowner: me", "malformed header line: just words"],
  ])("drops a proposal with %s, keeping the first reason", (_name, extra, reason) => {
    const text = answer(["@proposal", "category: prose-edit", "repo: consumer", "target: consumer/CLAUDE.md",
      "evidence: tag:quality:R3", extra, "", "Body."].join("\n"));
    const synthesis = parseSynthesis(text, context);
    expect(synthesis).toMatchObject({ proposals: [], dropped: [{ reason: expect.stringContaining(reason) }] });
    expect(JSON.stringify(synthesis)).not.toContain("unknown field");
  });

  it("parses only the last proposals block when the prose quotes the tag earlier", () => {
    const real = proposal(edit);
    const stray = proposal({ ...edit, title: "Stray" });
    const text = `I will emit a <proposals> block:\n<proposals>\n${stray}\n</proposals>\nRevised:\n<proposals>\n${real}\n</proposals>`;
    expect(parseSynthesis(text, context)).toMatchObject({ proposals: [{ title: "Name the smoke fixture" }] });
    expect(parseSynthesis(`quoting <proposals> in prose.\n<proposals>\n${real}\n</proposals>`, context))
      .toMatchObject({ proposals: [{ title: "Name the smoke fixture" }] });
  });

  it("drops a no-action line naming no known key, or giving no reason", () => {
    expect(parseSynthesis(answer("@no-action tag:quality:R9: no", "@no-action rule:quality:R6:"), context))
      .toEqual({ proposals: [], noAction: [], dropped: [
        { title: "@no-action tag:quality:R9: no", reason: "names no known key" },
        { title: "@no-action rule:quality:R6", reason: "gives no reason" },
      ] });
  });
});

const agentsRun = (fields: Partial<AgentsRun> = {}): AgentsRun => ({
  sourceBranch: "main",
  tip: "0123456789abcdef0123456789abcdef01234567",
  steps: [
    { step: "tagger quality 1/1", key: "a".repeat(64), usage: { inputTokens: 1200, outputTokens: 80 } },
    { step: "synthesizer", key: "b".repeat(64) },
  ],
  failures: [],
  synthesis: null,
  ...fields,
});

describe("renderReport with agents (#208)", () => {
  it("renders proposals by repo and category with their evidence, then the accounting", async () => {
    const synthesis = parseSynthesis(answer(
      proposal(edit, "Add the fixture name to the anchor."),
      proposal({ category: "issue-writing", repo: "consumer", target: "issue-writing",
        evidence: "outlier:8, outlier:9", title: "State the format" }),
      proposal({ category: "deletion", repo: "sandbar", target: "sandbar/prompts/coding-standards.md",
        evidence: "rule:quality:R6", title: "Drop R6" }),
      proposal({ ...edit, evidence: "tag:quality:R9" }),
      "@no-action park:NEEDS-INFO:-: the issues were vague, not the prompts",
    ), context);
    if ("error" in synthesis) throw new Error(synthesis.error);
    await expect(renderReport(input({
      clusters: [...mining.structured, tagged],
      agents: agentsRun({
        failures: [{ step: "tagger correctness 1/1", reason: "wrote: HEAD moved" }],
        synthesis,
      }),
    }))).toMatchFileSnapshot("./__fixtures__/reflect/report-proposals.golden.md");
  });

  it("still renders every table, and leaves every key not addressed, when every step failed", async () => {
    await expect(renderReport(input({
      agents: agentsRun({
        steps: [],
        failures: [
          { step: "tagger quality 1/1", reason: "parse: the answer does not end with <tags-end/>" },
          { step: "synthesizer", reason: "result: FAILED" },
        ],
      }),
    }))).toMatchFileSnapshot("./__fixtures__/reflect/report-failed.golden.md");
  });
});
