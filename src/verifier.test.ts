import { describe, expect, it } from "vitest";

import type { ReviewerResult } from "./inner-loop-machine.js";
import type { PriorReviewRound } from "./prompt.js";
import type { Scenario, ScenarioSet } from "./scenario-parser.js";
import {
  type LedgerEntry,
  type RunnerResult,
  type ScenarioLedger,
  type ScenarioRoundOutcome,
  WHITE_BOX_NO_REVIEW,
  advanceLedger,
  combineVerifier,
  ledgerHeads,
  prepass,
  renderRejection,
  retire,
  reviewScope,
  selectScenarios,
  tallyScenarios,
} from "./verifier.js";

// Scenario text that must never reach a public rendering.
const SENTINEL = "SENTINEL-7f3a";

const scenario = (n: number, needs: Scenario["needs"] = ["ui"]): Scenario => ({
  id: `S${n}`,
  title: `${SENTINEL} title ${n}`,
  needs,
  area: ["src/app.ts"],
  given: [`${SENTINEL} given ${n}`],
  when: ["the user saves"],
  then: ["the row is listed"],
});

const SET: ScenarioSet = {
  version: 1,
  issue: 7,
  seed: { ref: "origin/main", sha: "seed" },
  writer: { provider: "claude", model: "opus", effort: null },
  scenarios: [scenario(1), scenario(2), scenario(3), scenario(10)],
};

const pointer = (id: string): string => `/runs/r1/issue-7/verifier/round-2/${id}/`;

const approved: ReviewerResult = { kind: "reviewer-result", verdict: "APPROVED", prose: "ok" };
const rejected: ReviewerResult = {
  kind: "reviewer-result",
  verdict: "CHANGES-REQUESTED",
  prose: "### Correctness\nnull crashes\n\n<verdict>CHANGES-REQUESTED</verdict>\n",
};
const harnessFailed: ReviewerResult = { kind: "reviewer-harness-failed", detail: "idle" };
const whiteBoxWrote: ReviewerResult = { kind: "reviewer-wrote", detail: "reviewer committed" };

const fail = (id: string): ScenarioRoundOutcome => ({
  id,
  outcome: "fail",
  observed: `${SENTINEL} observed an empty list`,
  evidence: [`${id}/list.png`, `${id}/rows.txt`],
});
const pass = (id: string): ScenarioRoundOutcome => ({ id, outcome: "pass" });
const unverified = (id: string): ScenarioRoundOutcome =>
  ({ id, outcome: "unverified", reason: "runner", runnerReason: `${SENTINEL} no browser` });

const notRun: RunnerResult = { kind: "not-run", prepass: [] };
const reported = (...outcomes: ScenarioRoundOutcome[]): RunnerResult =>
  ({ kind: "reported", outcomes });

const WHITE_BOX_TEXT = "[white-box]\n### Correctness\nnull crashes";

describe("combineVerifier — the white-box review alone (#180)", () => {
  it("parks a write with the reviewer's cause", () => {
    expect(combineVerifier(whiteBoxWrote, notRun, null, pointer))
      .toEqual({ kind: "wrote", cause: "reviewer-wrote", detail: "reviewer committed" });
  });

  it("keeps a review that produced nothing a harness failure", () => {
    expect(combineVerifier(harnessFailed, notRun, null, pointer))
      .toEqual({ kind: "harness-failed", detail: "idle" });
  });

  it("approves an APPROVED review", () => {
    expect(combineVerifier(approved, notRun, null, pointer)).toEqual({ kind: "approved" });
  });

  it("rejects with one tagged white-box unit, without the verdict token", () => {
    expect(combineVerifier(rejected, notRun, null, pointer)).toEqual({
      kind: "rejected",
      units: [{ id: "white-box", text: WHITE_BOX_TEXT, publicText: WHITE_BOX_TEXT }],
      whiteBox: "CHANGES-REQUESTED",
      rejectingPasses: ["correctness"],
    });
  });
});

describe("combineVerifier — beside the scenario runner (#238)", () => {
  it.each([
    ["the white-box review", whiteBoxWrote, reported(pass("S1")), "reviewer committed"],
    ["the runner", approved, { kind: "wrote", detail: "runner wrote" } as const, "runner wrote"],
    [
      "both",
      whiteBoxWrote,
      { kind: "wrote", detail: "runner wrote" } as const,
      "reviewer committed\n\nrunner wrote",
    ],
  ])("parks a write by %s as the verifier's", (_name, whiteBox, runner, detail) => {
    expect(combineVerifier(whiteBox, runner, SET, pointer))
      .toEqual({ kind: "wrote", cause: "verifier-wrote", detail });
  });

  it("parks a write over a scenario failure", () => {
    expect(combineVerifier(whiteBoxWrote, reported(fail("S1")), SET, pointer).kind).toBe("wrote");
  });

  it("calls a white-box write the reviewer's when only the pre-pass settled scenarios", () => {
    const runner: RunnerResult = {
      kind: "not-run",
      prepass: [{ id: "S1", outcome: "unverified", reason: "no-db-copy" }],
    };
    expect(combineVerifier(whiteBoxWrote, runner, SET, pointer))
      .toMatchObject({ kind: "wrote", cause: "reviewer-wrote" });
  });

  it.each([
    ["every scenario passing", reported(pass("S1"), pass("S2"))],
    ["unverified scenarios", reported(pass("S1"), unverified("S2"))],
    ["a runner that failed", { kind: "failed", outcomes: [{ id: "S1", outcome: "unverified", reason: "runner-failed" }] } as const],
    ["a pre-pass only", { kind: "not-run", prepass: [{ id: "S1", outcome: "unverified", reason: "app-hook-failed" }] } as const],
  ])("approves an APPROVED review beside %s", (_name, runner) => {
    expect(combineVerifier(approved, runner, SET, pointer)).toEqual({ kind: "approved" });
  });

  it("keeps a white-box harness failure whatever the scenarios did, short of a failure", () => {
    expect(combineVerifier(harnessFailed, reported(pass("S1"), unverified("S2")), SET, pointer))
      .toEqual({ kind: "harness-failed", detail: "idle" });
  });

  it("rejects an APPROVED review beside a failing scenario, with the scenario unit alone", () => {
    const outcome = combineVerifier(approved, reported(pass("S1"), fail("S2")), SET, pointer);
    expect(outcome).toEqual({
      kind: "rejected",
      whiteBox: "APPROVED",
      rejectingPasses: ["scenarios"],
      units: [{
        id: "S2",
        text: [
          `[scenario S2] ${SENTINEL} title 2`,
          `Given ${SENTINEL} given 2`,
          "When the user saves",
          "Then the row is listed",
          `Observed: ${SENTINEL} observed an empty list`,
          "Evidence: /sandbar/verifier/findings/S2/list.png",
          "Evidence: /sandbar/verifier/findings/S2/rows.txt",
        ].join("\n"),
        publicText: "[scenario S2] failed — scenario and evidence withheld; " +
          "on the sandbar host under /runs/r1/issue-7/verifier/round-2/S2/",
      }],
    });
  });

  it("orders the white-box unit first, then the failing scenarios by number", () => {
    const outcome = combineVerifier(
      rejected,
      reported(fail("S10"), pass("S1"), fail("S3"), fail("S2")),
      SET,
      pointer,
    );
    expect(outcome.kind === "rejected" && outcome.units.map((unit) => unit.id))
      .toEqual(["white-box", "S2", "S3", "S10"]);
  });

  it("rejects a failing scenario beside a white-box review that produced nothing, and says so", () => {
    const outcome = combineVerifier(harnessFailed, reported(fail("S1")), SET, pointer);
    expect(outcome).toMatchObject({ kind: "rejected", whiteBox: "HARNESS-FAILED" });
    if (outcome.kind !== "rejected") throw new Error("expected a rejection");
    expect(outcome.units.map((unit) => unit.id)).toEqual(["S1"]);
    expect(renderRejection(outcome, "text").endsWith(`\n\n${WHITE_BOX_NO_REVIEW}`)).toBe(true);
    expect(renderRejection(outcome, "publicText").endsWith(`\n\n${WHITE_BOX_NO_REVIEW}`)).toBe(true);
    expect(outcome.rejectingPasses).toEqual(["scenarios"]);
  });

  it("keeps scenario text out of a public rendering that says the white-box review produced nothing", () => {
    const outcome = combineVerifier(harnessFailed, reported(fail("S1")), SET, pointer);
    if (outcome.kind !== "rejected") throw new Error("expected a rejection");
    const publicText = renderRejection(outcome, "publicText");
    expect(publicText).toContain(WHITE_BOX_NO_REVIEW);
    expect(publicText).not.toContain(SENTINEL);
    expect(publicText).not.toContain("Observed");
    expect(publicText).not.toContain("Given");
    expect(outcome.units.map((unit) => unit.publicText).join("\n")).not.toContain("observed");
  });

  it("never puts scenario text, observations or evidence in the public rendering", () => {
    const outcome = combineVerifier(rejected, reported(fail("S1"), fail("S2")), SET, pointer);
    if (outcome.kind !== "rejected") throw new Error("expected a rejection");
    const publicText = renderRejection(outcome, "publicText");
    expect(publicText).not.toContain(SENTINEL);
    expect(publicText).not.toContain("findings");
    expect(renderRejection(outcome, "text")).toContain(SENTINEL);
  });

  it("refuses a failing scenario the set does not hold", () => {
    expect(() => combineVerifier(approved, reported(fail("S9")), SET, pointer))
      .toThrow(/S9/);
  });
});

describe("renderRejection", () => {
  const units = [
    { id: "white-box", text: "a", publicText: "A" },
    { id: "S1", text: "b", publicText: "B" },
  ] as const;

  it("joins the chosen rendering in order, a blank line apart", () => {
    expect(renderRejection({ units, whiteBox: "CHANGES-REQUESTED" }, "text")).toBe("a\n\nb");
    expect(renderRejection({ units, whiteBox: "CHANGES-REQUESTED" }, "publicText")).toBe("A\n\nB");
  });
});

describe("prepass", () => {
  const sql = scenario(1, ["sql"]);
  const ui = scenario(2, ["ui"]);
  const api = scenario(3, ["api", "sql"]);
  const cli = scenario(4, ["cli"]);
  const all = [sql, ui, api, cli];

  it.each([
    ["copies off, no hook", { dbCopies: "off", appHook: "none" }, [sql, ui, api, cli], []],
    ["a held copy, a hook that ran", { dbCopies: "held", appHook: "ok" }, [sql, ui, api, cli], []],
    [
      "an unavailable copy",
      { dbCopies: "unavailable", appHook: "ok" },
      [ui, cli],
      [["S1", "no-db-copy"], ["S3", "no-db-copy"]],
    ],
    [
      "a failed app hook",
      { dbCopies: "held", appHook: "failed" },
      [sql, cli],
      [["S2", "app-hook-failed"], ["S3", "app-hook-failed"]],
    ],
    [
      "both",
      { dbCopies: "unavailable", appHook: "failed" },
      [cli],
      [["S1", "no-db-copy"], ["S2", "app-hook-failed"], ["S3", "no-db-copy"]],
    ],
  ] as const)("with %s", (_name, env, run, unverified) => {
    expect(prepass(all, env)).toEqual({
      run,
      unverified: unverified.map(([id, reason]) => ({ id, outcome: "unverified", reason })),
    });
  });
});

describe("tallyScenarios", () => {
  it("counts every selected scenario, pre-pass included", () => {
    expect(tallyScenarios({
      kind: "reported",
      outcomes: [pass("S1"), fail("S2"), unverified("S3"), { id: "S4", outcome: "unverified", reason: "no-db-copy" }],
    })).toEqual({ selected: 4, pass: 1, fail: 1, unverified: 2 });
    expect(tallyScenarios({
      kind: "not-run",
      prepass: [{ id: "S1", outcome: "unverified", reason: "app-hook-failed" }],
    })).toEqual({ selected: 1, pass: 0, fail: 0, unverified: 1 });
  });

  it("is null when the round selected none, or the runner wrote", () => {
    expect(tallyScenarios(notRun)).toBeNull();
    expect(tallyScenarios({ kind: "wrote", detail: "x" })).toBeNull();
  });
});

describe("reviewScope", () => {
  const round = (n: number, head: string): PriorReviewRound => ({
    round: n,
    head,
    correctness: { verdict: "CHANGES-REQUESTED", prose: "x", specGap: null },
  });

  it.each([
    ["no history", [], [], { kind: "full" }],
    ["an ancestor", [round(1, "a")], ["a"], { kind: "since", sha: "a" }],
    ["a non-ancestor", [round(1, "a")], [], { kind: "full" }],
    [
      "the last of several ancestors",
      [round(1, "a"), round(2, "b"), round(3, "c")],
      ["a", "b"],
      { kind: "since", sha: "b" },
    ],
  ] as const)("anchors at %s", (_name, prior, ancestors, expected) => {
    expect(reviewScope(prior, (sha) => (ancestors as readonly string[]).includes(sha)))
      .toEqual(expected);
  });
});

describe("the scenario ledger (#239)", () => {
  const at = (n: number, area: string): Scenario => ({ ...scenario(n), area: [area] });
  const set: ScenarioSet = {
    ...SET,
    scenarios: [at(1, "src/a"), at(2, "src/b"), at(3, "src/c"), at(4, "src/d"), at(5, "src/e")],
  };
  const ids = (run: readonly Scenario[]): string[] => run.map((s) => s.id);

  it("runs every scenario on an empty ledger, none of them a rerun", () => {
    expect(selectScenarios(set, new Map(), new Map())).toEqual({ run: set.scenarios, reruns: [] });
  });

  it("reruns a failure, skips a retired scenario, and runs a passed or unverified one only when touched", () => {
    const ledger: ScenarioLedger = new Map<string, LedgerEntry>([
      ["S1", { status: "fail", head: "h1", round: 1 }],
      ["S2", { status: "pass", head: "h1" }],
      ["S3", { status: "unverified", head: "h2" }],
      ["S4", { status: "retired" }],
    ]);
    const selected = selectScenarios(set, ledger, new Map([["h1", ["src/c/x.ts"]], ["h2", ["src/c/x.ts"]]]));
    expect(ids(selected.run)).toEqual(["S1", "S3", "S5"]);
    expect(selected.reruns).toEqual([{ id: "S1", head: "h1", round: 1 }]);
  });

  it("runs every scenario whose head HEAD no longer contains, but no retired one", () => {
    const ledger: ScenarioLedger = new Map<string, LedgerEntry>([
      ["S1", { status: "pass", head: "gone" }],
      ["S2", { status: "unverified", head: "gone" }],
      ["S3", { status: "pass", head: "kept" }],
      ["S4", { status: "retired" }],
      ["S5", { status: "pass", head: "kept" }],
    ]);
    expect(ids(selectScenarios(set, ledger, new Map([["gone", "all"], ["kept", []]])).run))
      .toEqual(["S1", "S2"]);
  });

  it("names the heads whose change selection reads, once each", () => {
    expect(ledgerHeads(new Map<string, LedgerEntry>([
      ["S1", { status: "fail", head: "h0", round: 1 }],
      ["S2", { status: "pass", head: "h1" }],
      ["S3", { status: "unverified", head: "h1" }],
      ["S4", { status: "retired" }],
      ["S5", { status: "pass", head: "h2" }],
    ]))).toEqual(["h1", "h2"]);
  });

  it("reruns a scenario whose head has no recorded change", () => {
    const { run } = selectScenarios(set, new Map([["S1", { status: "pass", head: "h1" }]]), new Map());
    expect(run.map((s) => s.id)).toContain("S1");
  });

  it("advances only the runner's own verdicts to the round's head", () => {
    const before: ScenarioLedger = new Map<string, LedgerEntry>([
      ["S1", { status: "fail", head: "h1", round: 1 }],
      ["S4", { status: "pass", head: "h1" }],
      ["S5", { status: "retired" }],
    ]);
    const after = advanceLedger(before, "h2", 2, reported(
      pass("S1"),
      fail("S2"),
      unverified("S3"),
      { id: "S4", outcome: "unverified", reason: "no-db-copy" },
    ));
    expect(after).toEqual(new Map<string, LedgerEntry>([
      ["S1", { status: "pass", head: "h2" }],
      ["S4", { status: "pass", head: "h1" }],
      ["S5", { status: "retired" }],
      ["S2", { status: "fail", head: "h2", round: 2 }],
      ["S3", { status: "unverified", head: "h2" }],
    ]));
    expect(before.get("S1")).toEqual({ status: "fail", head: "h1", round: 1 });
  });

  it("leaves the ledger as it was after a runner failure or a write", () => {
    const before: ScenarioLedger = new Map([["S1", { status: "fail", head: "h1", round: 1 }]]);
    const failed: RunnerResult = {
      kind: "failed",
      outcomes: [{ id: "S1", outcome: "unverified", reason: "runner-failed" }],
    };
    expect(advanceLedger(before, "h2", 2, failed)).toEqual(before);
    expect(advanceLedger(before, "h2", 2, { kind: "wrote", detail: "x" })).toEqual(before);
  });

  it("retires overruled scenarios for good", () => {
    const ledger = retire(new Map([["S1", { status: "fail", head: "h1", round: 1 }]]), ["S1", "S2"]);
    expect(ids(selectScenarios(set, ledger, new Map()).run)).toEqual(["S3", "S4", "S5"]);
  });
});
