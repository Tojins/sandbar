// Changed-line coverage for the `missing-tests` check (#183, #236), read from
// the `coverage-final.json` files the gate's test steps write (istanbul's
// shape, as `@vitest/coverage-v8` writes it): `coverage/unit/` from `test`,
// `coverage/podman/` from `podman-test`.
//
// A changed line counts when a statement starts on it in a file that
// measured its path, and is covered when either file hits one of those
// statements. In the gate (`--podman-coverage`) a step removes `coverage/`
// before the suites run, so an absent file is a suite whose step the test
// selection skipped (#259, #269): empty coverage, and a line no other suite
// hits is uncovered. Elsewhere, a local `npm run structure`, the
// podman file may be absent too (no podman test ran, #264), but a missing
// unit file cannot answer the check: `StructureError`, exit 2. Nor, anywhere,
// can a file that cannot be read, is not JSON or is not istanbul's shape.

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { StructureError, parseJson, withFsError } from "./core.mjs";

export const UNIT_COVERAGE = "coverage/unit/coverage-final.json";
export const PODMAN_COVERAGE = "coverage/podman/coverage-final.json";

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// Whether `json` has the shape `statementHits` reads: per file a `path`, and
// a start line and a hit count per statement.
function isCoverage(json) {
  return isRecord(json) && Object.values(json).every((file) =>
    isRecord(file) && typeof file.path === "string" && isRecord(file.statementMap) && isRecord(file.s) &&
    Object.entries(file.statementMap).every(([id, location]) =>
      Number.isInteger(location?.start?.line) && typeof file.s[id] === "number"));
}

// A `coverage-final.json` to `Map<path, Map<line, hits>>`: per file relative
// to `root`, the most any statement starting on a line was hit.
export function statementHits(json, root) {
  const files = new Map();
  for (const file of Object.values(json)) {
    const lines = new Map();
    for (const [id, location] of Object.entries(file.statementMap)) {
      const line = location.start.line;
      lines.set(line, Math.max(lines.get(line) ?? 0, file.s[id]));
    }
    files.set(relative(root, file.path), lines);
  }
  return files;
}

// `relativePath` in `dir` read as statement hits, or none when it is absent
// and not `required`.
export function readCoverage(dir, relativePath, required) {
  const path = join(dir, relativePath);
  if (!existsSync(path)) {
    if (required) throw new StructureError(`${relativePath} is missing: the test step wrote no coverage`);
    return new Map();
  }
  const text = withFsError(`${relativePath} cannot be read`, () => readFileSync(path, "utf8"));
  const json = parseJson(text, relativePath);
  if (!isCoverage(json)) throw new StructureError(`${relativePath} is not istanbul coverage`);
  return statementHits(json, dir);
}

// Each of `lines` of `path` a statement starts on, `{ line, state }`:
// `covered` by a test of one of `suites`, or `uncovered`. A path no suite
// measured is null: what coverage measured is not this tree.
export function lineCoverage(path, lines, suites) {
  const measured = suites.flatMap((suite) => suite.get(path) ?? []);
  if (measured.length === 0) return null;
  return lines.filter((line) => measured.some((hits) => hits.has(line))).map((line) => ({
    line,
    state: measured.some((hits) => (hits.get(line) ?? 0) > 0) ? "covered" : "uncovered",
  }));
}

// `src/x.ts:12-15  uncovered` per run of uncovered lines, a run broken only
// by a counted line that is not uncovered.
export function uncoveredFindings(path, counted) {
  const findings = [];
  let run = null;
  const close = () => {
    if (run === null) return;
    findings.push(`${path}:${run[0] === run[1] ? run[0] : `${run[0]}-${run[1]}`}  uncovered`);
    run = null;
  };
  for (const { line, state } of counted) {
    if (state !== "uncovered") close();
    else if (run === null) run = [line, line];
    else run[1] = line;
  }
  close();
  return findings;
}

// The coverage findings over `added` (`Map<path, number[]>`, production
// paths only) in `dir`, and how many lines were covered. `inGate`: a
// missing unit file is a skipped suite, not an error.
export function coverageFindings(dir, added, inGate) {
  const findings = [];
  const suites = [readCoverage(dir, UNIT_COVERAGE, !inGate), readCoverage(dir, PODMAN_COVERAGE, false)];
  let covered = 0;
  for (const [path, lines] of added) {
    const counted = lineCoverage(path, lines, suites);
    if (counted === null) {
      findings.push(`${path}  absent from every coverage file`);
      continue;
    }
    findings.push(...uncoveredFindings(path, counted));
    covered += counted.filter(({ state }) => state === "covered").length;
  }
  return { findings, covered };
}
