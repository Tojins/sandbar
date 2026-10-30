// The Stryker probe of the `missing-tests` check (#183 decision 5, #236):
// the changed lines of `src/**/*.ts` are mutated, and a mutant the suite
// survives is a line no test pins.
//
// The run is a child process whose output goes to `.stryker-tmp/log/`, never
// to the check's: `@stryker-mutator/vitest-runner` over
// `vitest.probe.config.ts` (the unit suite, no podman tests), `perTest`
// coverage so a mutant runs only the tests that reach it, no checker, no
// incremental file (D1: every verdict from scratch), in a sandbox copy under
// `.stryker-tmp/`. Only the mutators in `PROBED_MUTATORS` run: StringLiteral
// and Regex mostly yield equivalent noise. `ignoreStatic`, because a mutant
// of module-scope code reruns every test the module reaches.
//
// `Survived` is a finding. `NoCoverage` is not: coverage owns an unexecuted
// line, and a podman-only line is not probed. A dry run Stryker cannot
// complete (a red test, a crash) throws `StructureError`.
//
// `plannedMutants` asks Stryker's own instrumenter which mutants a run over
// the same ranges will test, so the check can cap the run before paying for
// it (missing-tests.mjs).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Instrumenter } from "@stryker-mutator/instrumenter";

import { LOG_DIR, runLogged, StructureError, WORK_DIR } from "./core.mjs";

// Every mutator Stryker 10 has. A mutant of any other means an upgrade added
// one: `plannedMutants` refuses it until it is sorted in here.
const ALL_MUTATORS = [
  "ArithmeticOperator", "ArrayDeclaration", "ArrowFunction", "AssignmentOperator",
  "BlockStatement", "BooleanLiteral", "CallExpression", "ConditionalExpression",
  "EqualityOperator", "LogicalOperator", "MethodExpression", "ObjectLiteral",
  "OptionalChaining", "Regex", "StringLiteral", "UnaryOperator", "UpdateOperator",
];

export const PROBED_MUTATORS = [
  "ConditionalExpression", "LogicalOperator", "EqualityOperator", "BlockStatement",
  "BooleanLiteral", "OptionalChaining", "ObjectLiteral", "ArrayDeclaration", "ArrowFunction",
];

const EXCLUDED_MUTATORS = ALL_MUTATORS.filter((name) => !PROBED_MUTATORS.includes(name));

const REPORT = `${WORK_DIR}/report.json`;

// Ascending line numbers to `[first, last]` runs of consecutive lines.
export function lineRuns(lines) {
  const runs = [];
  for (const line of lines) {
    const last = runs.at(-1);
    if (last !== undefined && line === last[1] + 1) last[1] = line;
    else runs.push([line, line]);
  }
  return runs;
}

const noop = () => {};
const quiet = Object.fromEntries(
  ["trace", "debug", "info", "warn", "error", "fatal"].flatMap((level) => [
    [level, noop],
    [`is${level[0].toUpperCase()}${level.slice(1)}Enabled`, () => false],
  ]),
);

// The mutants Stryker will test over `runs` of `path` (whose text is
// `content`): `{ path, line, column }` each, 1-based like Stryker's report,
// in line order. A mutant a `Stryker disable` hint switched off is not one.
export async function plannedMutants(path, content, runs) {
  const { mutants } = await new Instrumenter(quiet).instrument(
    [{
      name: path,
      content,
      mutate: runs.map(([first, last]) => ({
        start: { line: first - 1, column: 0 },
        end: { line: last - 1, column: Number.MAX_SAFE_INTEGER },
      })),
    }],
    { plugins: null, ignorers: [], excludedMutations: EXCLUDED_MUTATORS },
  );
  // An excluded mutator's mutants, like a hint's, come back `Ignored`.
  const tested = mutants.filter((mutant) => mutant.status === undefined);
  const unknown = tested.find((mutant) => !PROBED_MUTATORS.includes(mutant.mutatorName));
  if (unknown !== undefined) {
    throw new StructureError(`probe: Stryker mutator ${unknown.mutatorName} is unknown to probe.mjs`);
  }
  return tested
    .map((mutant) => ({ path, line: mutant.location.start.line + 1, column: mutant.location.start.column + 1 }))
    .sort((a, b) => a.line - b.line || a.column - b.column);
}

// `mutate` maps each path to its line runs.
export function strykerConfig(mutate) {
  return {
    testRunner: "vitest",
    plugins: ["@stryker-mutator/vitest-runner"],
    vitest: { configFile: "vitest.probe.config.ts", pool: "forks" },
    coverageAnalysis: "perTest",
    mutate: [...mutate].flatMap(([path, runs]) => runs.map(([first, last]) => `${path}:${first}-${last}`)),
    mutator: { excludedMutations: EXCLUDED_MUTATORS },
    ignoreStatic: true,
    checkers: [],
    incremental: false,
    reporters: ["json"],
    jsonReporter: { fileName: REPORT },
    tempDirName: WORK_DIR,
    cleanTempDir: true,
    ignorePatterns: ["coverage", ".sandbar"],
    allowConsoleColors: false,
  };
}

// `text` on one line, at most 60 characters.
function brief(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 60 ? flat : `${flat.slice(0, 59)}…`;
}

// The source `location` (Stryker's, 1-based) spans in `content`.
function sourceAt(content, { start, end }) {
  const lines = content.split("\n").slice(start.line - 1, end.line);
  lines[lines.length - 1] = lines.at(-1).slice(0, end.column - 1);
  lines[0] = lines[0].slice(start.column - 1);
  return lines.join("\n");
}

// A Stryker JSON report to its findings and counts; `contents` maps each
// mutated path to its text.
export function probeResult(report, contents) {
  const survived = [];
  let killed = 0;
  let statics = 0;
  for (const [path, file] of Object.entries(report.files)) {
    for (const mutant of file.mutants) {
      if (mutant.status === "Killed" || mutant.status === "Timeout") killed++;
      else if (mutant.status === "Ignored" && mutant.static === true) statics++;
      else if (mutant.status === "Survived") survived.push({ path, mutant });
    }
  }
  survived.sort((a, b) => a.path.localeCompare(b.path) || a.mutant.location.start.line - b.mutant.location.start.line);
  const findings = survived.map(({ path, mutant }) => {
    const original = brief(sourceAt(contents.get(path), mutant.location));
    return `${path}:${mutant.location.start.line}  survived ${mutant.mutatorName}: ${original} → ${brief(mutant.replacement)}`;
  });
  return { findings, killed, statics };
}

// Stryker over `mutate` in `dir`, whose `LOG_DIR` exists; `contents` maps
// each mutated path to its text.
export async function runProbe(dir, mutate, contents) {
  const config = join(dir, WORK_DIR, "stryker.config.json");
  writeFileSync(config, JSON.stringify(strykerConfig(mutate)));
  const log = join(dir, LOG_DIR, "stryker.log");
  const bin = join(dir, "node_modules", "@stryker-mutator", "core", "bin", "stryker.js");
  const code = await runLogged([process.execPath, bin, "run", config], dir, log);
  if (code !== 0) {
    const error = readFileSync(log, "utf8").split("\n").find((line) => line.includes("ERROR"));
    const reason = error === undefined ? "" : `: ${error.replace(/^.*ERROR \S+ /, "")}`;
    throw new StructureError(`probe: Stryker exited ${code}${reason} (${LOG_DIR}/stryker.log)`);
  }
  return probeResult(JSON.parse(readFileSync(join(dir, REPORT), "utf8")), contents);
}
