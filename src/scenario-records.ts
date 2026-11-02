// The scenario records (#259, #268): what each scenario of an issue's written
// set came to, kept under `<stateDir>/scenarios/` for the curating janitor
// (#265) to read.
//
// When an issue's verifier passes (DONE), the inner loop appends one record
// per scenario of the set to `records.jsonl` there: the issue, the branch sha
// it passed at, the Given/When/Then, the scenario's domains and its final
// verdict. A parked or failed issue writes nothing, and nothing follows the
// branch to its landing. The verdict is read off the cycle's scenario ledger
// (verifier.ts): `pass` for a scenario whose last selection the runner
// passed, `fail-overruled` for one an adjudicator retired, and `unverified`
// for every other, including a pass or a failure whose rerun went unverified. A pass's directory
// from the round that passed it, as `archiveRun` left it, holds the runner's
// scripts; it is copied to `issue-<n>/<sha>/S<n>/` beside the file before
// the records are appended, so no record names a directory that is not
// there, and a runner that left none records `scripts: null`.
//
// A scenario's domains are derived from its `area`, as no writer field says
// them: the declared domains (the stack in effect's at the sha, a branch's
// own edit included) whose `paths` match an area entry or a file under one in
// the tree at the sha.

import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { GateDomain } from "./config.js";
import { globMatcher } from "./gate-selection.js";
import { gitStdout } from "./git-ops.js";
import { type Scenario, type ScenarioSet, scenarioTouched } from "./scenario-parser.js";
import type { LedgerEntry, ScenarioLedger } from "./verifier.js";

export type ScenarioVerdict = "pass" | "fail-overruled" | "unverified";

export type ScenarioRecord = {
  readonly issue: number;
  readonly sha: string;
  readonly id: string;
  readonly given: readonly string[];
  readonly when: readonly string[];
  readonly then: readonly string[];
  readonly domains: readonly string[];
  readonly verdict: ScenarioVerdict;
  // A pass's copied runner directory, relative to the records' directory.
  readonly scripts: string | null;
};

export function finalVerdict(entry: LedgerEntry | undefined): ScenarioVerdict {
  if (entry?.status === "pass") return "pass";
  if (entry?.status === "retired") return "fail-overruled";
  return "unverified";
}

// The names of the domains whose paths reach the scenario's area, given the
// tree's `files`.
export function scenarioDomains(
  scenario: Scenario,
  domains: readonly GateDomain[],
  files: readonly string[],
): readonly string[] {
  const reached = [
    ...scenario.area.map((entry) => entry.replace(/\/+$/, "")),
    ...files.filter((file) => scenarioTouched(scenario, [file])),
  ];
  return [...new Set(domains.filter((d) => reached.some(globMatcher(d.paths))).map((d) => d.name))];
}

// `source` copied to `target` under `dir`, or null when the runner left none.
async function copyScripts(source: string, dir: string, target: string): Promise<string | null> {
  if (!existsSync(source)) return null;
  await rm(join(dir, target), { recursive: true, force: true });
  await cp(source, join(dir, target), { recursive: true });
  return target;
}

export async function appendScenarioRecords(args: {
  readonly stateDir: string;
  readonly worktree: string;
  readonly sha: string;
  readonly set: ScenarioSet;
  readonly ledger: ScenarioLedger;
  readonly domains: readonly GateDomain[];
  // Where verifier round `round`'s `run/` was archived.
  readonly roundDir: (round: number) => string;
}): Promise<void> {
  const { worktree, sha, set, ledger, domains, roundDir } = args;
  const dir = join(args.stateDir, "scenarios");
  const files = (await gitStdout(worktree, ["ls-tree", "-r", "--name-only", "-z", sha]))
    .split("\0")
    .filter((file) => file !== "");
  await mkdir(dir, { recursive: true });
  const records = await Promise.all(set.scenarios.map(async (scenario): Promise<ScenarioRecord> => {
    const entry = ledger.get(scenario.id);
    return {
      issue: set.issue,
      sha,
      id: scenario.id,
      given: scenario.given,
      when: scenario.when,
      then: scenario.then,
      domains: scenarioDomains(scenario, domains, files),
      verdict: finalVerdict(entry),
      scripts: entry?.status === "pass"
        ? await copyScripts(join(roundDir(entry.round), scenario.id), dir, join(`issue-${set.issue}`, sha, scenario.id))
        : null,
    };
  }));
  await appendFile(join(dir, "records.jsonl"), records.map((r) => `${JSON.stringify(r)}\n`).join(""));
}
