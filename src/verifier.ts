// The verifier (#180, #206, #238) — pure. It holds the slot after a green
// gate-1 that the correctness pass held: same `maxReviewRounds` budget, same
// harness-failure rule (#41), same adjudicator path (#167).
//
// It is two cold, read-only agents run side by side in the issue sandbox: the
// white-box reviewer, which is the correctness review on the `reviewer*`
// routing, and, when the scenario writer (#203) wrote a set, the scenario
// runner, which runs every scenario against the branch and reports each as
// PASS, FAIL with evidence, or UNVERIFIED with a reason. `combineVerifier`
// folds the two results into one outcome: a write from either parks, any
// white-box CHANGES-REQUESTED or scenario FAIL rejects, a white-box review
// that produced nothing is a harness failure whatever the scenarios did
// (unreviewed code never reads as DONE), and anything else approves.
// UNVERIFIED never rejects, and a runner that failed as a harness only leaves
// its scenarios unverified. Without scenarios the verifier is the white-box
// review alone.
//
// Two cases make a scenario UNVERIFIED before any model runs (`prepass`): it
// needs SQL while database copies are configured but none is held, or it needs
// the app's UI or API while the `beforeScenarioRun` hook failed.
//
// A rejection is a list of tagged UNITS, concatenated verbatim and never merged
// by a model, because a merging call could silently drop a finding: the
// white-box review first, then each failing scenario by id. A white-box review
// that produced nothing beside a failing scenario adds a line that is not a
// unit (`renderRejection`). Each unit carries two renderings: `text`, which the
// implementer and the adjudicator read, and `publicText`, which is all that may
// reach GitHub. For a `[white-box]` unit the two are the same. A scenario's
// `text` is its Given/When/Then, what the runner observed and its evidence
// under the sandbox's `findings/`; its `publicText` is only its id and where
// the evidence is kept on the host, so finalise cannot publish scenario text
// or database evidence by construction, and the passing scenarios stay a
// holdout. A write's detail is public too: the runner's transcript is named,
// never quoted.
//
// From its second round on, the white-box review is patch-scoped: it reads
// only the change since the last head an earlier round reviewed, provided that
// head is still an ancestor of HEAD. Earlier conclusions about unchanged hunks
// stand, and #88's history carries them.

import type { RejectingPass } from "./events.js";
import type { ReviewerResult, ReviewScope } from "./inner-loop-machine.js";
import type { PriorReviewRound } from "./prompt.js";
import { type Scenario, type ScenarioNeed, type ScenarioSet, renderClauses } from "./scenario-parser.js";
import { stripVerdictTokens } from "./verdict-parser.js";

// Where the runner's workspace is mounted in the issue sandbox: it writes
// under `run/`, and the failing scenarios' evidence is restaged in `findings/`.
export const VERIFIER_MOUNT = "/sandbar/verifier";

// The `beforeScenarioRun` hook's output, in `run/` beside the evidence it
// is archived with.
export const APP_HOOK_LOG = "before-scenario-run.log";

// Why a scenario ended unverified. `runner` is the runner's own call, with its
// words kept for the run directory; every other reason is the host's.
export type UnverifiedReason =
  | "no-db-copy"
  | "app-hook-failed"
  | "runner"
  | "not-reported"
  | "fail-without-evidence"
  | "runner-failed"
  | "input-too-large";

// One scenario's result for a round. `observed` and the evidence paths
// (`S<n>/…`, relative to `run/`) are runner text for the run directory and
// the implementer only.
export type ScenarioRoundOutcome =
  | { readonly id: string; readonly outcome: "pass" }
  | {
      readonly id: string;
      readonly outcome: "fail";
      readonly observed: string;
      readonly evidence: readonly string[];
    }
  | {
      readonly id: string;
      readonly outcome: "unverified";
      readonly reason: Exclude<UnverifiedReason, "runner">;
    }
  | {
      readonly id: string;
      readonly outcome: "unverified";
      readonly reason: "runner";
      readonly runnerReason: string;
    };

// What the runner's side of a round came to: no runner at all (no scenarios,
// or every one settled by the pre-pass), a report, a failure that left the
// scenarios it ran unverified, or a write. `outcomes` include the pre-pass's.
export type RunnerResult =
  | { readonly kind: "not-run"; readonly prepass: readonly ScenarioRoundOutcome[] }
  | { readonly kind: "reported" | "failed"; readonly outcomes: readonly ScenarioRoundOutcome[] }
  | { readonly kind: "wrote"; readonly detail: string };

export type VerifierUnit = {
  readonly id: "white-box" | `S${number}`;
  readonly text: string;
  readonly publicText: string;
};

export type WhiteBoxVerdict = "APPROVED" | "CHANGES-REQUESTED" | "HARNESS-FAILED";

export type VerifierOutcome =
  | {
      readonly kind: "wrote";
      // `reviewer-wrote` when the runner did not run; with both in the
      // sandbox, its shared snapshot cannot say which one wrote.
      readonly cause: "reviewer-wrote" | "verifier-wrote";
      readonly detail: string;
    }
  | { readonly kind: "harness-failed"; readonly detail: string }
  | { readonly kind: "approved" }
  | {
      readonly kind: "rejected";
      readonly units: readonly VerifierUnit[];
      readonly whiteBox: WhiteBoxVerdict;
      // The passes that rejected, the white-box review's first.
      readonly rejectingPasses: readonly RejectingPass[];
    };

// A round's scenarios, as `review-round` records them.
export type ScenarioTally = {
  readonly selected: number;
  readonly pass: number;
  readonly fail: number;
  readonly unverified: number;
};

// The round's scenario outcomes, pre-pass included; none for a write.
export function runnerOutcomes(runner: RunnerResult): readonly ScenarioRoundOutcome[] {
  switch (runner.kind) {
    case "not-run":
      return runner.prepass;
    case "reported":
    case "failed":
      return runner.outcomes;
    case "wrote":
      return [];
  }
}

// Null when the round selected no scenario.
export function tallyScenarios(runner: RunnerResult): ScenarioTally | null {
  const outcomes = runnerOutcomes(runner);
  if (outcomes.length === 0) return null;
  const count = (outcome: ScenarioRoundOutcome["outcome"]): number =>
    outcomes.filter((o) => o.outcome === outcome).length;
  return {
    selected: outcomes.length,
    pass: count("pass"),
    fail: count("fail"),
    unverified: count("unverified"),
  };
}

// Fold the round's results into one outcome (see the module header).
// `evidencePointer` is where a scenario's evidence is kept on the host.
export function combineVerifier(
  whiteBox: ReviewerResult,
  runner: RunnerResult,
  set: ScenarioSet | null,
  evidencePointer: (id: string) => string,
): VerifierOutcome {
  const wrote = [
    ...(whiteBox.kind === "reviewer-wrote" ? [whiteBox.detail] : []),
    ...(runner.kind === "wrote" ? [runner.detail] : []),
  ];
  if (wrote.length > 0) {
    return {
      kind: "wrote",
      cause: runner.kind === "not-run" ? "reviewer-wrote" : "verifier-wrote",
      detail: wrote.join("\n\n"),
    };
  }
  const verdict: WhiteBoxVerdict = whiteBox.kind === "reviewer-result"
    ? whiteBox.verdict
    : "HARNESS-FAILED";
  const failing = runnerOutcomes(runner)
    .flatMap((o) => (o.outcome === "fail" ? [o] : []))
    .sort((a, b) => scenarioNumber(a.id) - scenarioNumber(b.id));
  if (verdict === "CHANGES-REQUESTED" || failing.length > 0) {
    const whiteBoxUnits: VerifierUnit[] = whiteBox.kind === "reviewer-result" &&
        whiteBox.verdict === "CHANGES-REQUESTED"
      ? [whiteBoxUnit(whiteBox.prose)]
      : [];
    return {
      kind: "rejected",
      units: [
        ...whiteBoxUnits,
        ...failing.map((o) => scenarioUnit(scenarioOf(set, o.id), o, evidencePointer(o.id))),
      ],
      whiteBox: verdict,
      rejectingPasses: [
        ...(verdict === "CHANGES-REQUESTED" ? ["correctness" as const] : []),
        ...(failing.length > 0 ? ["scenarios" as const] : []),
      ],
    };
  }
  if (whiteBox.kind === "reviewer-harness-failed") {
    return { kind: "harness-failed", detail: whiteBox.detail };
  }
  return { kind: "approved" };
}

function whiteBoxUnit(prose: string): VerifierUnit {
  const text = `[white-box]\n${stripVerdictTokens(prose).trim()}`;
  return { id: "white-box", text, publicText: text };
}

const scenarioNumber = (id: string): number => Number(id.slice(1));

function scenarioOf(set: ScenarioSet | null, id: string): Scenario {
  const scenario = set?.scenarios.find((s) => s.id === id);
  if (scenario === undefined) throw new Error(`scenario ${id} failed but is not in the round's set`);
  return scenario;
}

function scenarioUnit(
  scenario: Scenario,
  outcome: Extract<ScenarioRoundOutcome, { outcome: "fail" }>,
  pointer: string,
): VerifierUnit {
  const id = scenario.id as `S${number}`;
  return {
    id,
    text: [
      `[scenario ${id}] ${scenario.title}`,
      renderClauses(scenario),
      `Observed: ${outcome.observed}`,
      ...outcome.evidence.map((path) => `Evidence: ${VERIFIER_MOUNT}/findings/${path}`),
    ].join("\n"),
    publicText:
      `[scenario ${id}] failed — scenario and evidence withheld; on the sandbar host under ${pointer}`,
  };
}

// What a write's detail says in place of a transcript that may quote a
// scenario or its evidence: the detail reaches GitHub.
export const withheldTranscript = (filename: string): string =>
  `(withheld; ${filename} in the issue's run log directory on the sandbar host)`;

// Said beside a failing scenario when the white-box review produced nothing:
// the report is no code review's.
export const WHITE_BOX_NO_REVIEW = "[white-box] produced no review this round.";

// A rejection's units in one rendering, a blank line apart, and the
// white-box line when it produced no review.
export function renderRejection(
  rejection: { readonly units: readonly VerifierUnit[]; readonly whiteBox: WhiteBoxVerdict },
  form: "text" | "publicText",
): string {
  return [
    ...rejection.units.map((unit) => unit[form]),
    ...(rejection.whiteBox === "HARNESS-FAILED" ? [WHITE_BOX_NO_REVIEW] : []),
  ].join("\n\n");
}

// What the runner can rely on this round: whether a database copy is held
// when copies are configured, and how the `beforeScenarioRun` hook went.
export type RunnerEnvironment = {
  readonly dbCopies: "off" | "held" | "unavailable";
  readonly appHook: "ok" | "failed" | "none";
};

const APP_NEEDS: readonly ScenarioNeed[] = ["ui", "api"];

// The scenarios the runner gets, and those settled unverified before it runs.
export function prepass(
  run: readonly Scenario[],
  env: RunnerEnvironment,
): { readonly run: readonly Scenario[]; readonly unverified: readonly ScenarioRoundOutcome[] } {
  const kept: Scenario[] = [];
  const unverified: ScenarioRoundOutcome[] = [];
  for (const scenario of run) {
    const reason = scenario.needs.includes("sql") && env.dbCopies === "unavailable"
      ? "no-db-copy"
      : scenario.needs.some((need) => APP_NEEDS.includes(need)) && env.appHook === "failed"
        ? "app-hook-failed"
        : null;
    if (reason === null) kept.push(scenario);
    else unverified.push({ id: scenario.id, outcome: "unverified", reason });
  }
  return { run: kept, unverified };
}

// What the white-box review reads this round: the whole branch, or the change
// since the LAST earlier round whose head HEAD still contains. A head the
// branch no longer contains (a rewritten history) cannot anchor a range.
export function reviewScope(
  prior: readonly PriorReviewRound[],
  isAncestor: (sha: string) => boolean,
): ReviewScope {
  const anchor = [...prior].reverse().find((round) => isAncestor(round.head));
  return anchor === undefined ? { kind: "full" } : { kind: "since", sha: anchor.head };
}
