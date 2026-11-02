// The `missing-tests` check (#183, #236, #264), the `tests-structure` step,
// which settles the coverage clause of the rule of that name: every
// statement line the branch adds is executed by a test. Over the lines
// `merge-base(HEAD, <base>)..HEAD` adds to `src/**/*.ts` (not `*.test.ts` or
// `*.test-util.ts`):
//
//   coverage  a changed line a statement starts on is hit by some test
//             (coverage.mjs), with no threshold: one uncovered line is red;
//   hints     an added `v8 ignore` (or `c8`/`istanbul`) hint says why after
//             `--`, so the white-box reviewer can judge the escape.
//
// Whether a test would notice the behaviour breaking is left to the prose
// rule the quality pass applies, never measured here (#264). The check runs
// at gate-1 and gate-2 alike: a red on a merge result goes to the resolve
// loop as any gate-2 red does.
//
// It reads the worktree, which in the gate is the clean HEAD it judges (D1),
// and writes nothing. The worktree is the working directory, `--git-dir` or
// not: a judged file it lacks or cannot read is exit 2.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { addedLines, mergeBase, withFsError } from "./core.mjs";
import { coverageFindings, PODMAN_COVERAGE } from "./coverage.mjs";

export function isProduction(path) {
  return /^src\/.*\.ts$/.test(path) && !/\.test(?:-util)?\.ts$/.test(path);
}

const HINT = /\b(?:v8|c8|istanbul) ignore\b/;
const REASONED_HINT = /\b(?:v8|c8|istanbul) ignore\b.*?--\s*[^\s*]/;

// The finding for an added line `text`, or null.
export function hintFinding(path, line, text) {
  return HINT.test(text) && !REASONED_HINT.test(text) ? `${path}:${line}  v8 ignore hint without a reason` : null;
}

const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

// The success line from what coverage counted.
export function missingTestsSummary({ covered, unknown }) {
  return `missing-tests: ${count(covered, "line")} covered, 0 uncovered` +
    (unknown === 0 ? "" : `; ${count(unknown, "line")} unknown without ${PODMAN_COVERAGE}`);
}

// `options.podmanCoverage`: podman coverage is required (coverage.mjs).
export function checkMissingTests(repo, baseRef, options) {
  const production = new Map([...addedLines(repo, mergeBase(repo, baseRef))].filter(([path]) => isProduction(path)));

  const findings = [];
  for (const [path, lines] of production) {
    const text = withFsError(`${path} cannot be read`, () => readFileSync(join(repo.dir, path), "utf8")).split("\n");
    for (const line of lines) {
      const finding = hintFinding(path, line, text[line - 1]);
      if (finding !== null) findings.push(finding);
    }
  }
  const coverage = coverageFindings(repo.dir, production, options.podmanCoverage);
  findings.push(...coverage.findings);
  return { findings, summary: missingTestsSummary(coverage.counts) };
}
