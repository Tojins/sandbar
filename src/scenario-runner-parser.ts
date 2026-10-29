// Scenario runner output parser (#180, #238) — pure, modelled on
// scenario-parser.ts.
//
// The runner emits no verdict: whether its round rejects is derived from its
// per-scenario lines (verifier.ts). The token is literal and the last one wins
// (#113): `<scenario-runner>REPORTED</scenario-runner>` takes the last
// tempered `<scenario-results>` block, which holds one `### S<n>: PASS|FAIL|
// UNVERIFIED` heading per scenario the runner was given. Under a heading come
// `Observed:`, `Evidence:` and `Reason:` lines; a line indented two or more
// spaces continues the `Observed:` or `Reason:` line above it, or under
// `Evidence:` names another path. Blank lines are ignored, and any other line
// is a violation. A FAIL needs `Observed` and at least one `Evidence`, and
// every path it cites must exist; an UNVERIFIED needs `Reason`; a PASS may cite
// evidence. An evidence path names a file under the scenario's own directory,
// `S<n>/…`, relative to `run/`, with no `.`/`..` segment and no glob.
//
// An id the runner was not given, or one reported twice, is a violation; one
// it left out is UNVERIFIED `not-reported`. Every violation is listed in the
// one NO-SIGNAL reprompt the format nudge carries. The parse after the nudge
// is `finalize`d: a scenario still in violation becomes UNVERIFIED, as
// `fail-without-evidence` for a FAIL and `not-reported` otherwise, and the
// rest of the block stands. Only a missing token or block is still NO-SIGNAL
// then.

import { lastToken, literalTokenPattern, temperedBlockPattern } from "./token-scan.js";
import type { ScenarioRoundOutcome } from "./verifier.js";

export type ScenarioRunnerParseResult =
  | { readonly kind: "REPORTED"; readonly outcomes: readonly ScenarioRoundOutcome[] }
  | { readonly kind: "NO-SIGNAL"; readonly reprompt: string };

const TOKEN = literalTokenPattern("scenario-runner", ["REPORTED"]);

const NO_TOKEN =
  "End with exactly `<scenario-runner>REPORTED</scenario-runner>` followed by a " +
  "`<scenario-results>` block holding one `### S<n>: PASS|FAIL|UNVERIFIED` heading " +
  "per scenario.";

const NO_BLOCK =
  "A REPORTED answer requires a `<scenario-results>` block holding one " +
  "`### S<n>: PASS|FAIL|UNVERIFIED` heading per scenario.";

type Verdict = "PASS" | "FAIL" | "UNVERIFIED";
type Field = "Observed" | "Evidence" | "Reason";

type Draft = {
  readonly id: string;
  readonly verdict: Verdict | null;
  observed: string | null;
  readonly evidence: string[];
  reason: string | null;
  // The field the next indented line belongs to.
  current: Field | null;
  readonly problems: string[];
};

const HEADING = /^###\s+(S\d+):\s*(.*?)\s*$/;
const FIELD_LINE = /^(Observed|Evidence|Reason):\s*(.*)$/;
const VERDICTS: readonly string[] = ["PASS", "FAIL", "UNVERIFIED"];
const GLOB = /[*?[\]{}!]/;

export function parseScenarioRunner(
  stdout: string,
  expectedIds: readonly string[],
  evidenceExists: (path: string) => boolean,
  opts: { readonly finalize: boolean },
): ScenarioRunnerParseResult {
  if (lastToken(stdout, TOKEN) === null) return { kind: "NO-SIGNAL", reprompt: NO_TOKEN };
  const block = lastToken(stdout, temperedBlockPattern("scenario-results"));
  if (block === null) return { kind: "NO-SIGNAL", reprompt: NO_BLOCK };
  const { drafts, violations } = parseBlock(block, expectedIds);
  for (const draft of drafts.values()) checkDraft(draft, evidenceExists);
  const problems = [
    ...violations,
    ...[...drafts.values()].flatMap((draft) => draft.problems.map((p) => `${draft.id}: ${p}`)),
  ];
  if (problems.length > 0 && !opts.finalize) {
    return {
      kind: "NO-SIGNAL",
      reprompt: [
        "Your `<scenario-results>` block does not follow the format. Fix every point " +
          "below and answer again with the token and the whole block:",
        ...problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    };
  }
  return {
    kind: "REPORTED",
    outcomes: expectedIds.map((id) => outcomeOf(id, drafts.get(id))),
  };
}

function parseBlock(
  block: string,
  expectedIds: readonly string[],
): { readonly drafts: ReadonlyMap<string, Draft>; readonly violations: readonly string[] } {
  const drafts = new Map<string, Draft>();
  const violations: string[] = [];
  // The heading the following lines belong to; null before the first one and
  // under a heading that was refused, whose lines are then not reported again.
  let draft: Draft | null = null;
  let refused = false;
  for (const [index, line] of block.split("\n").entries()) {
    if (line.trim() === "") continue;
    const at = `line ${index + 1}`;
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const id = heading[1] ?? "";
      const word = heading[2] ?? "";
      draft = null;
      refused = true;
      if (!expectedIds.includes(id)) {
        violations.push(`${at}: \`${id}\` is not one of the scenarios you were given.`);
      } else if (drafts.has(id)) {
        violations.push(`${at}: ${id} is reported twice; report each scenario once.`);
      } else {
        draft = {
          id,
          verdict: VERDICTS.includes(word) ? (word as Verdict) : null,
          observed: null,
          evidence: [],
          reason: null,
          current: null,
          problems: VERDICTS.includes(word)
            ? []
            : [`\`${word}\` is not PASS, FAIL or UNVERIFIED.`],
        };
        drafts.set(id, draft);
        refused = false;
      }
      continue;
    }
    if (draft === null) {
      if (!refused) {
        violations.push(`${at}: \`${line.trim()}\` comes before the first \`### S<n>:\` heading.`);
      }
      continue;
    }
    if (/^ {2,}\S/.test(line)) {
      continueField(draft, line.trim(), at);
      continue;
    }
    const field = FIELD_LINE.exec(line);
    if (field === null) {
      draft.problems.push(
        `${at}: \`${line.trim()}\` is not an \`Observed:\`, \`Evidence:\` or \`Reason:\` line ` +
          "or an indented continuation.",
      );
      continue;
    }
    setField(draft, field[1] as Field, (field[2] ?? "").trim(), at);
  }
  return { drafts, violations };
}

function setField(draft: Draft, field: Field, value: string, at: string): void {
  if (value === "") {
    draft.problems.push(`${at}: an empty \`${field}:\` line.`);
    draft.current = null;
    return;
  }
  if (field === "Evidence") {
    draft.evidence.push(value);
    draft.current = field;
    return;
  }
  const key = field === "Observed" ? "observed" : "reason";
  if (draft[key] !== null) {
    draft.problems.push(`${at}: a second \`${field}:\` line.`);
    return;
  }
  draft[key] = value;
  draft.current = field;
}

function continueField(draft: Draft, text: string, at: string): void {
  const { current } = draft;
  if (current === null) {
    draft.problems.push(`${at}: an indented continuation line with no line above it to continue.`);
  } else if (current === "Evidence") {
    draft.evidence.push(text);
  } else {
    const key = current === "Observed" ? "observed" : "reason";
    draft[key] = `${draft[key]} ${text}`;
  }
}

// Why `path` is not evidence `id` may cite, or null when it is.
function evidencePathProblem(id: string, path: string): string | null {
  if (!path.startsWith(`${id}/`)) return `evidence \`${path}\` is not under \`${id}/\``;
  if (GLOB.test(path)) return `evidence \`${path}\` holds a glob character; name the file`;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `evidence \`${path}\` has an empty, \`.\` or \`..\` segment`;
  }
  return null;
}

function checkDraft(draft: Draft, evidenceExists: (path: string) => boolean): void {
  for (const path of draft.evidence) {
    const problem = evidencePathProblem(draft.id, path);
    if (problem !== null) draft.problems.push(`${problem}.`);
    else if (draft.verdict === "FAIL" && !evidenceExists(path)) {
      draft.problems.push(
        `evidence \`${path}\` does not exist under /sandbar/verifier/run/; save it there or cite what you saved.`,
      );
    }
  }
  if (draft.verdict === "FAIL") {
    if (draft.observed === null) draft.problems.push("a FAIL needs an `Observed:` line.");
    if (draft.evidence.length === 0) {
      draft.problems.push("a FAIL needs at least one `Evidence:` line naming a file you saved.");
    }
  }
  if (draft.verdict === "UNVERIFIED" && draft.reason === null) {
    draft.problems.push("an UNVERIFIED needs a `Reason:` line.");
  }
}

function outcomeOf(id: string, draft: Draft | undefined): ScenarioRoundOutcome {
  if (draft === undefined) return { id, outcome: "unverified", reason: "not-reported" };
  if (draft.problems.length > 0) {
    return {
      id,
      outcome: "unverified",
      reason: draft.verdict === "FAIL" ? "fail-without-evidence" : "not-reported",
    };
  }
  // `checkDraft` made each line a verdict needs a problem when it is missing.
  const required = (value: string | null): string => {
    if (value === null) throw new Error(`scenario ${id} passed its checks with a line missing`);
    return value;
  };
  switch (draft.verdict) {
    case "PASS":
      return { id, outcome: "pass" };
    case "FAIL":
      return { id, outcome: "fail", observed: required(draft.observed), evidence: draft.evidence };
    case "UNVERIFIED":
      return { id, outcome: "unverified", reason: "runner", runnerReason: required(draft.reason) };
    case null:
      throw new Error(`scenario ${id} has no verdict and no problem`);
  }
}
