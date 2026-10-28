import { describe, expect, it } from "vitest";

import { loadTemplate } from "./prompts.js";
import {
  chunkBucket,
  deletionCandidates,
  extractRules,
  MAX_GIST_CHARS,
  mine,
  parseTags,
  REFLECT_DELETION_MIN_ISSUES,
  tagClusters,
  type Bucket,
  type Finding,
} from "./reflect-mine.js";
import { computeStats, type StatsReport } from "./stats.js";
import type { StatsEvent, StatsRun } from "./stats-record.js";

let seq = 0;
const ev = (fields: Record<string, unknown>): StatsEvent =>
  ({ seq: ++seq, ts: "2026-09-07T10:00:00Z", ...fields }) as unknown as StatsEvent;

const admitted = (issue: number): StatsEvent =>
  ev({ kind: "admitted", issue, title: `Issue ${issue}`, branch: `b-${issue}`, chunk: null, seedRef: "origin/main" });
const terminal = (issue: number, outcome: string, fields: Record<string, unknown> = {}): StatsEvent =>
  ev({ kind: "terminal", issue, title: `Issue ${issue}`, terminal: outcome, reason: null, durationMs: 1, ...fields });
const agent = { provider: "claude", model: "m", effort: null, durationMs: 1 };
const implementer = (issue: number, attempt: number, signal = "COMPLETE"): StatsEvent =>
  ev({ kind: "implementer", issue, attempt, signal, ...agent, transcript: `implementer-${attempt}.log` });
const gate1 = (issue: number, attempt: number, steps: Record<string, boolean>): StatsEvent =>
  ev({
    kind: "gate", issue, attempt, gate: "gate-1", ok: Object.values(steps).every(Boolean), durationMs: 1,
    steps: Object.fromEntries(Object.entries(steps).map(([name, ok]) => [name, { ok, durationMs: 1 }])),
  });
const review = (issue: number, attempt: number): StatsEvent =>
  ev({ kind: "review-pass", issue, attempt, round: attempt, invocation: 1, ...agent,
    result: "completed", transcript: `review-${attempt}.log` });
const reviewRound = (issue: number, attempt: number, correctness: string): StatsEvent =>
  ev({ kind: "review-round", issue, attempt, round: attempt, head: "h", gateOk: true, correctness,
    rejectingPass: null, gateFailures: 0, correctnessFailures: 0, durationMs: 1 });
const fixer = (issue: number, attempt: number, commits: readonly string[]): StatsEvent =>
  ev({ kind: "quality-pass", issue, attempt, round: attempt, ...agent, result: "completed", commits,
    discarded: {}, transcript: `quality-${attempt}.log` });
const lister = (issue: number, attempt: number): StatsEvent =>
  ev({ kind: "quality-review", issue, attempt, round: attempt, invocation: 1, mode: "list", ...agent,
    result: "completed", verdict: "CHANGES-REQUESTED", transcript: `lister-${attempt}.log` });
const adjudication = (issue: number, ruling: string): StatsEvent =>
  ev({ kind: "adjudication", issue, pass: "correctness", attempt: 1, round: 1, head: "h", ruling, ...agent,
    transcript: "adjudicator-1.log" });

const reportOf = (events: readonly StatsEvent[], prose: Record<string, string> = {}): StatsReport => {
  const run: StatsRun = {
    run: "run-1",
    schemaVersion: 6,
    driver: "sandbar test",
    events: [ev({ kind: "run-start", schemaVersion: 6, driver: "sandbar test", configPath: null,
      workdir: "/w", maxParallelIssues: 1, pid: 1 }), ...events],
    prose: new Map(Object.entries(prose)),
  };
  return computeStats({ window: { last: 10 }, withProse: true, runs: [run], skipped: [], ignoredKinds: {} });
};

const RULES = { quality: "1. **Small.** Keep it small.\n2. **Typed.** No any.\n" };

describe("mine: structured clusters (#182 Decision 2)", () => {
  it("keys red gate steps and drops a key seen in one issue", () => {
    const { structured } = mine(reportOf([
      admitted(1), gate1(1, 1, { build: true, smoke: false }), gate1(1, 2, { smoke: false }),
      admitted(2), gate1(2, 1, { smoke: false, lint: false }),
    ]), RULES);
    expect(structured).toEqual([{
      key: "gate:gate-1:smoke",
      issues: [1, 2],
      count: 3,
      members: [
        { run: "run-1", issue: 1, attempt: 1 },
        { run: "run-1", issue: 1, attempt: 2 },
        { run: "run-1", issue: 2, attempt: 1 },
      ],
    }]);
  });

  it("keys a red gate with no red step on -", () => {
    const red = (issue: number) =>
      ev({ kind: "gate", issue, gate: "gate-2", ok: false, durationMs: 1 });
    expect(mine(reportOf([red(1), red(2)]), RULES).structured.map((cluster) => cluster.key))
      .toEqual(["gate:gate-2:-"]);
  });

  it("keys non-DONE terminals on their cause", () => {
    const { structured } = mine(reportOf([
      admitted(1), terminal(1, "NEEDS-PARTITION", { cause: "classifier" }),
      admitted(2), terminal(2, "NEEDS-PARTITION", { cause: "classifier" }),
      admitted(3), terminal(3, "NEEDS-INFO"),
      admitted(4), terminal(4, "NEEDS-INFO"),
      admitted(5), terminal(5, "DONE"),
      admitted(6), terminal(6, "DONE"),
    ]), RULES);
    expect(structured.map((cluster) => [cluster.key, cluster.issues])).toEqual([
      ["park:NEEDS-INFO:-", [3, 4]],
      ["park:NEEDS-PARTITION:classifier", [1, 2]],
    ]);
  });

  it("keys invocations that reached no decision on role and result", () => {
    const { structured } = mine(reportOf([
      admitted(1), implementer(1, 1, "FAILED"), implementer(1, 2, "COMPLETE"),
      admitted(2), implementer(2, 1, "FAILED"), implementer(2, 2, "NEEDS-INFO"),
    ]), RULES);
    expect(structured).toEqual([{
      key: "fail:implementer:FAILED",
      issues: [1, 2],
      count: 2,
      members: [
        { run: "run-1", issue: 1, attempt: 1, transcript: "implementer-1.log" },
        { run: "run-1", issue: 2, attempt: 1, transcript: "implementer-1.log" },
      ],
    }]);
  });

  it("keys adjudicator overrules on their pass", () => {
    const { structured } = mine(reportOf([
      admitted(1), adjudication(1, "OVERRULED"),
      admitted(2), adjudication(2, "OVERRULED"),
      admitted(3), adjudication(3, "UPHELD"),
    ]), RULES);
    expect(structured).toEqual([{
      key: "overruled:correctness",
      issues: [1, 2],
      count: 2,
      members: [
        { run: "run-1", issue: 1, attempt: 1, transcript: "adjudicator-1.log" },
        { run: "run-1", issue: 2, attempt: 1, transcript: "adjudicator-1.log" },
      ],
    }]);
  });

  it("orders clusters by issues, then members, then key", () => {
    const { structured } = mine(reportOf([
      admitted(1), implementer(1, 1, "NO-SIGNAL"), implementer(1, 2, "FAILED"),
      admitted(2), implementer(2, 1, "NO-SIGNAL"), implementer(2, 2, "FAILED"), implementer(2, 3, "FAILED"),
      admitted(3), implementer(3, 1, "QUOTA"),
      admitted(4), implementer(4, 1, "QUOTA"),
      admitted(5), implementer(5, 1, "QUOTA"),
    ]), RULES);
    expect(structured.map((cluster) => cluster.key)).toEqual([
      "fail:implementer:QUOTA", "fail:implementer:FAILED", "fail:implementer:NO-SIGNAL",
    ]);
  });
});

describe("mine: buckets", () => {
  it("buckets rejecting reviews, committing fixers and overrules, each with its speech", () => {
    const { buckets } = mine(reportOf([
      admitted(1),
      fixer(1, 1, ["c1"]), fixer(1, 2, []),
      review(1, 1), reviewRound(1, 1, "CHANGES-REQUESTED"),
      review(1, 2), reviewRound(1, 2, "APPROVED"),
      adjudication(1, "OVERRULED"),
      admitted(2), review(2, 1), reviewRound(2, 1, "CHANGES-REQUESTED"),
    ], {
      "1/quality-1.log": "fixed R1",
      "1/quality-2.log": "nothing to fix",
      "1/review-1.log": "wrong edge",
      "1/review-2.log": "fine",
      "1/adjudicator-1.log": "the reviewer misread",
    }), RULES);
    expect(buckets).toEqual([
      {
        source: "quality",
        vocabulary: {
          kind: "rules",
          rules: [{ label: "R1", title: "Small." }, { label: "R2", title: "Typed." }],
          listerIssues: 1,
        },
        findings: [{ id: "F1", run: "run-1", issue: 1, transcript: "quality-1.log", prose: "fixed R1" }],
      },
      {
        source: "correctness",
        vocabulary: { kind: "open" },
        // Issue 2's log is gone, so it has no finding.
        findings: [{ id: "F1", run: "run-1", issue: 1, transcript: "review-1.log", prose: "wrong edge" }],
      },
      {
        source: "overruled:correctness",
        vocabulary: { kind: "open" },
        findings: [{ id: "F1", run: "run-1", issue: 1, transcript: "adjudicator-1.log", prose: "the reviewer misread" }],
      },
    ]);
  });

  it("counts the issues a lister or a fixer ran on, once each", () => {
    const { buckets } = mine(reportOf([
      admitted(1), lister(1, 1), fixer(1, 1, []),
      admitted(2), lister(2, 1),
      admitted(3), fixer(3, 1, []),
    ]), RULES);
    expect(buckets[0]?.vocabulary).toMatchObject({ kind: "rules", listerIssues: 3 });
  });

  it("keeps the rule bucket when it is empty and drops empty open ones", () => {
    const { buckets } = mine(reportOf([admitted(1), fixer(1, 1, [])]), { quality: "no bold items" });
    expect(buckets).toEqual([{
      source: "quality",
      vocabulary: { kind: "rules", rules: [{ label: "quality", title: "quality" }], listerIssues: 1 },
      findings: [],
    }]);
  });
});

describe("mine: outliers", () => {
  const done = (issue: number, gates: number): StatsEvent[] => [
    admitted(issue),
    ...Array.from({ length: gates }, (_, index) => gate1(issue, index + 1, { test: true })),
    terminal(issue, "DONE"),
  ];

  it("flags rounds over max(p90, 2 × median), spec gaps, and NEEDS-INFO or NEEDS-PARTITION", () => {
    const { outliers } = mine(reportOf([
      ...done(1, 1), ...done(2, 1), ...done(3, 1), ...done(4, 2), ...done(5, 3),
      admitted(6), terminal(6, "DONE", { specGaps: 1 }),
      admitted(7), terminal(7, "NEEDS-INFO", { reason: "Which format?" }),
      admitted(8), terminal(8, "NEEDS-PARTITION"),
      admitted(9), terminal(9, "NEEDS-HUMAN"),
    ]), RULES);
    // Over DONE issues [1, 1, 1, 2, 3, 0]: p90 3, median 1, so the bar is 3.
    expect(outliers.map((outlier) => outlier.issue)).toEqual([6, 7, 8]);
    expect(outliers[1]).toEqual({
      issue: 7, rounds: 0, attempts: 0, specGaps: null, outcome: "NEEDS-INFO", reason: "Which format?",
    });
  });

  it("flags rounds over twice the median when that is the higher bar", () => {
    const { outliers } = mine(reportOf([
      ...done(1, 2), ...done(2, 2), ...done(3, 2), ...done(4, 2), ...done(5, 2),
      ...done(6, 2), ...done(7, 2), ...done(8, 2), ...done(9, 3), ...done(10, 5),
    ]), RULES);
    // p90 3, median 2: the bar is 4, so issue 9 is over p90 and still no outlier.
    expect(outliers.map((outlier) => [outlier.issue, outlier.rounds])).toEqual([[10, 5]]);
  });

  it("has no rounds bar without a DONE issue", () => {
    expect(mine(reportOf([admitted(1), gate1(1, 1, { test: false })]), RULES).outliers).toEqual([]);
  });
});

describe("extractRules (#182 Decision 4)", () => {
  it("reads R1–R7 from sandbar's coding standards", () => {
    expect(extractRules(loadTemplate("coding-standards"))).toEqual([
      { label: "R1", title: "Complexity that doesn't pay for itself." },
      { label: "R2", title: "Spaghetti control flow." },
      { label: "R3", title: "Wrong abstraction." },
      { label: "R4", title: "Logic in the wrong layer." },
      { label: "R5", title: "Loose contracts." },
      { label: "R6", title: "Non-atomic orchestration." },
      { label: "R7", title: "Wrong or idle prose." },
    ]);
  });

  it("reads bulleted bold leads and nothing from a group without them", () => {
    expect(extractRules("- **One.** a\n- plain\n  - **Two.** b\nsome **bold** prose")).toEqual([
      { label: "R1", title: "One." }, { label: "R2", title: "Two." },
    ]);
    expect(extractRules("Keep it tidy.\n- no bold here")).toEqual([]);
  });
});

const finding = (n: number, issue: number, chars: number): Finding =>
  ({ id: `F${n}`, run: "run-1", issue, transcript: `t-${n}.log`, prose: "x".repeat(chars) });

const bucketOf = (findings: readonly Finding[], listerIssues = REFLECT_DELETION_MIN_ISSUES): Bucket => ({
  source: "quality",
  vocabulary: { kind: "rules", rules: [{ label: "R1", title: "Small." }, { label: "R2", title: "Typed." }], listerIssues },
  findings,
});

describe("chunkBucket", () => {
  const ids = (chunks: readonly Bucket[]) => chunks.map((chunk) => chunk.findings.map((f) => f.id));

  it("splits in order at the size bound and keeps an oversized finding alone", () => {
    const bucket = bucketOf([finding(1, 1, 4), finding(2, 1, 6), finding(3, 2, 1), finding(4, 2, 20), finding(5, 3, 3)]);
    expect(ids(chunkBucket(bucket, 10))).toEqual([["F1", "F2"], ["F3"], ["F4"], ["F5"]]);
    expect(chunkBucket(bucket, 10)[0]).toMatchObject({ source: "quality", vocabulary: bucket.vocabulary });
  });

  it("keeps a bucket that fits whole, and yields nothing for an empty one", () => {
    expect(ids(chunkBucket(bucketOf([finding(1, 1, 4), finding(2, 2, 4)])))).toEqual([["F1", "F2"]]);
    expect(chunkBucket(bucketOf([]))).toEqual([]);
  });
});

describe("parseTags (#182 Decision 4)", () => {
  const rules = bucketOf([finding(1, 1, 1), finding(2, 2, 1)]);
  const open: Bucket = { ...rules, source: "correctness", vocabulary: { kind: "open" } };

  it("reads each tag line, skips the model's prose, and lets a finding carry two labels", () => {
    expect(parseTags("Labels follow.\n\nF1 R1 :: helper wraps one call \nF1 R2 :: any in a contract\n" +
      "F2 R1 :: three layers for one value\n<tags-end/>\n", rules)).toEqual({ tags: [
      { id: "F1", label: "R1", gist: "helper wraps one call" },
      { id: "F1", label: "R2", gist: "any in a contract" },
      { id: "F2", label: "R1", gist: "three layers for one value" },
    ] });
    expect(parseTags("F2 new:missing-null-check :: no guard\n<tags-end/>", open))
      .toEqual({ tags: [{ id: "F2", label: "new:missing-null-check", gist: "no guard" }] });
    expect(parseTags("Nothing recurs.\n<tags-end/>", rules)).toEqual({ tags: [] });
  });

  it.each([
    ["a missing end token", "F1 R1 :: a", rules, "does not end with <tags-end/>"],
    ["an end token that is not last", "<tags-end/>\nF1 R1 :: a", rules, "does not end with"],
    ["an unknown id", "F3 R1 :: a\n<tags-end/>", rules, "F3 names no finding"],
    ["a label outside the rules", "F1 R7 :: a\n<tags-end/>", rules, "R7 is not in the quality vocabulary"],
    ["a rule label in an open bucket", "F1 R1 :: a\n<tags-end/>", open, "R1 is not in the correctness"],
    ["a slug that is not kebab", "F1 new:Not_Kebab :: a\n<tags-end/>", open, "is not in the correctness"],
    ["a malformed tag line", "F1 R1 - a\n<tags-end/>", rules, "not a tag line: F1 R1 - a"],
    ["an empty gist", "F1 R1 :: \n<tags-end/>", rules, "the gist must be"],
    ["an over-long gist", `F1 R1 :: ${"g".repeat(MAX_GIST_CHARS + 1)}\n<tags-end/>`, rules, "the gist must be"],
    ["a repeated tag", "F1 R1 :: a\nF1 R1 :: b\n<tags-end/>", rules, "F1 R1 is tagged twice"],
  ])("rejects the whole answer on %s", (_name, text, bucket, error) => {
    expect(parseTags(text, bucket)).toEqual({ error: expect.stringContaining(error) });
  });
});

describe("tagClusters", () => {
  it("keys labels seen in two or more issues", () => {
    const bucket = bucketOf([finding(1, 1, 1), finding(2, 2, 1), finding(3, 3, 1)]);
    expect(tagClusters([{
      bucket,
      tags: [
        { id: "F1", label: "R1", gist: "a" },
        { id: "F2", label: "R1", gist: "b" },
        { id: "F3", label: "R2", gist: "c" },
      ],
    }])).toEqual([{
      key: "tag:quality:R1",
      issues: [1, 2],
      count: 2,
      members: [
        { run: "run-1", issue: 1, transcript: "t-1.log" },
        { run: "run-1", issue: 2, transcript: "t-2.log" },
      ],
    }]);
  });

  it("refuses a tag that names no finding", () => {
    expect(() => tagClusters([{ bucket: bucketOf([]), tags: [{ id: "F9", label: "R1", gist: "" }] }]))
      .toThrow("tag F9 names no finding of bucket quality");
  });
});

describe("deletionCandidates (#182 Decision 6)", () => {
  const tags = [{ id: "F1", label: "R1", gist: "a" }];

  it("lists the rules no tag hit once the lister ran on enough issues", () => {
    expect(deletionCandidates([{ bucket: bucketOf([finding(1, 1, 1)]), tags }])).toEqual([
      { key: "rule:quality:R2", title: "Typed.", listerIssues: REFLECT_DELETION_MIN_ISSUES },
    ]);
  });

  it("lists none below the issue floor or for an open bucket", () => {
    const below = bucketOf([finding(1, 1, 1)], REFLECT_DELETION_MIN_ISSUES - 1);
    const open: Bucket = { source: "correctness", vocabulary: { kind: "open" }, findings: [] };
    expect(deletionCandidates([{ bucket: below, tags }, { bucket: open, tags: [] }])).toEqual([]);
  });
});
