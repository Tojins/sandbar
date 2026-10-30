// Changed-line coverage for the `missing-tests` check (#183, #236), read from
// the `coverage-final.json` files the gate's test steps write (istanbul's
// shape, as `@vitest/coverage-v8` writes it): `coverage/unit/` from `test`,
// `coverage/podman/` from `podman-test`.
//
// A changed line counts when a statement starts on it, and is covered when
// either file hits one of those statements. The gate requires podman coverage
// (`--podman-coverage`), so there a missing file is a finding. Elsewhere, a
// local `npm run structure`, it may be absent, and a line no unit test hits
// is then `unknown`, never a finding.

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { StructureError } from "./core.mjs";

export const UNIT_COVERAGE = "coverage/unit/coverage-final.json";
export const PODMAN_COVERAGE = "coverage/podman/coverage-final.json";

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

// `relativePath` in `dir` read as statement hits, or null when it is absent.
export function readCoverage(dir, relativePath) {
  const path = join(dir, relativePath);
  if (!existsSync(path)) return null;
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new StructureError(`${relativePath} is not JSON: ${err.message}`);
  }
  return statementHits(json, dir);
}

// Each of `lines` of `path` a statement starts on, `{ line, state }`:
// `covered` by a unit test, `podman` (covered only by a podman test),
// `uncovered`, or `unknown` when `podman` is null and no unit test hits it.
// A path absent from `unit` is null: what coverage measured is not this tree.
export function lineCoverage(path, lines, unit, podman) {
  const unitLines = unit.get(path);
  if (unitLines === undefined) return null;
  const podmanLines = podman?.get(path);
  return lines.filter((line) => unitLines.has(line)).map((line) => {
    if (unitLines.get(line) > 0) return { line, state: "covered" };
    if (podman === null) return { line, state: "unknown" };
    return { line, state: (podmanLines?.get(line) ?? 0) > 0 ? "podman" : "uncovered" };
  });
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
// paths only) in `dir`, and how many lines were covered, unknown and
// podman-only. `requirePodman`: a missing podman file is a finding.
export function coverageFindings(dir, added, requirePodman) {
  const findings = [];
  const unit = readCoverage(dir, UNIT_COVERAGE);
  const podman = readCoverage(dir, PODMAN_COVERAGE);
  if (unit === null) findings.push(`${UNIT_COVERAGE}: missing, the test step wrote no coverage`);
  if (podman === null && requirePodman) findings.push(`${PODMAN_COVERAGE}: missing, the test step wrote no coverage`);
  const counts = { covered: 0, unknown: 0, podmanOnly: 0 };
  if (unit === null) return { findings, counts };
  for (const [path, lines] of added) {
    const counted = lineCoverage(path, lines, unit, podman);
    if (counted === null) {
      findings.push(`${path}  absent from ${UNIT_COVERAGE}`);
      continue;
    }
    findings.push(...uncoveredFindings(path, counted));
    for (const { state } of counted) {
      if (state === "covered") counts.covered++;
      else if (state === "unknown") counts.unknown++;
      else if (state === "podman") counts.podmanOnly++;
    }
  }
  return { findings, counts };
}
