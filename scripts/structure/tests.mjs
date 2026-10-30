// The `tests` check (#183, #236), the `tests-structure` step, which settles
// `missing-tests`: every line the branch adds is executed and pinned by a
// test. Over the lines `merge-base(HEAD, <base>)..HEAD` adds:
//
//   coverage  a changed line of `src/**/*.ts` (not `*.test.ts` or
//             `*.test-util.ts`) a statement starts on is hit by some test
//             (coverage.mjs);
//   probe     no Stryker mutant of those lines survives the unit suite
//             (probe.mjs);
//   deletion  deleting a changed line of a mapped non-TS file turns its
//             mapped tests red (deletion.mjs);
//   hints     an added `v8 ignore` (or `c8`/`istanbul`) hint says why after
//             `--`, and an added `Stryker disable` hint after `:`. An
//             equivalent mutant needs an escape, or it would burn
//             `maxGateRounds`; a reason makes it one the white-box reviewer
//             can judge.
//
// Probe and deletion together run at most `CAP` units (a mutant or a
// deleted line) in path and line order; the summary counts the rest as
// unprobed. They run beside each other.
//
// The landing shape (HEAD a merge whose first parent is `<base>`: gate-2,
// the resolve re-gate) is skipped in one line: gate-1 settled it on the
// branch, and a mutation run in the serialized landing costs minutes per land.
//
// It reads the worktree, which in the gate is the clean HEAD it judges (D1),
// and writes only under the gitignored `.stryker-tmp/`, cleared first.

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { addedLines, git, LOG_DIR, mergeBase, WORK_DIR } from "./core.mjs";
import { coverageFindings, PODMAN_COVERAGE } from "./coverage.mjs";
import { deletableLines, deletionEntry, runDeletions } from "./deletion.mjs";
import { lineRuns, plannedMutants, runProbe } from "./probe.mjs";

export const CAP = 200;

export function isProduction(path) {
  return /^src\/.*\.ts$/.test(path) && !/\.test(?:-util)?\.ts$/.test(path);
}

// `parents` is `git rev-list --parents -n 1 HEAD` split: HEAD, then its
// parents.
export function isLandingShape(parents, baseSha) {
  return parents.length > 2 && parents[1] === baseSha;
}

const HINTS = [
  { name: "v8 ignore", hint: /\b(?:v8|c8|istanbul) ignore\b/, reason: /\b(?:v8|c8|istanbul) ignore\b.*?--\s*[^\s*]/ },
  { name: "Stryker disable", hint: /\bStryker disable\b/, reason: /\bStryker disable\b[^:]*:\s*\S/ },
];

// The finding for an added line `text`, or null.
export function hintFinding(path, line, text) {
  const bare = HINTS.find(({ hint, reason }) => hint.test(text) && !reason.test(text));
  return bare === undefined ? null : `${path}:${line}  ${bare.name} hint without a reason`;
}

// Probe units, mutants and deleted lines alike, in path and line order: the
// first `cap` are run.
export function capUnits(units, cap) {
  const ordered = [...units].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || (a.column ?? 0) - (b.column ?? 0));
  return { run: ordered.slice(0, cap), over: Math.max(0, ordered.length - cap) };
}

// A file's added-line runs cut before the first of its `planned` mutants
// (in line order) that is not `kept`, so Stryker tests no more than `kept`.
export function cappedRuns(runs, planned, kept) {
  const firstDropped = planned.find((mutant) => !kept.includes(mutant));
  if (firstDropped === undefined) return runs;
  return runs
    .filter(([first]) => first < firstDropped.line)
    .map(([first, last]) => [first, Math.min(last, firstDropped.line - 1)]);
}

const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

// The success line from what each part counted.
export function testsSummary({ covered, unknown, podmanOnly, killed, caught, statics, over }) {
  const unprobed = [
    [podmanOnly, "podman-only line"],
    [statics, "static mutant"],
    [over, "unit over the cap"],
  ].filter(([n]) => n > 0).map(([n, noun]) => count(n, noun));
  return `tests: ${count(covered, "line")} covered, ${count(killed, "mutant")} killed, ` +
    `${count(caught, "line deletion")} caught, 0 survived` +
    (unprobed.length === 0 ? "" : ` (unprobed: ${unprobed.join(", ")})`) +
    (unknown === 0 ? "" : `; ${count(unknown, "line")} unknown without ${PODMAN_COVERAGE}`);
}

// `options.podmanCoverage`: podman coverage is required (coverage.mjs).
export async function checkTests(repo, baseRef, options) {
  const parents = git(repo, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ");
  const baseSha = git(repo, ["rev-parse", "--verify", `${baseRef}^{commit}`]).trim();
  if (isLandingShape(parents, baseSha)) {
    return { findings: [], summary: `tests: skipped, HEAD merges onto ${baseRef} (gate-1 settled the branch)` };
  }
  const added = addedLines(repo, mergeBase(repo, baseRef));
  const contents = new Map(
    [...added.keys()]
      .filter((path) => isProduction(path) || deletionEntry(path) !== undefined)
      .map((path) => [path, readFileSync(join(repo.dir, path), "utf8")]),
  );
  const production = new Map([...added].filter(([path]) => isProduction(path)));

  const findings = [];
  for (const [path, lines] of production) {
    const text = contents.get(path).split("\n");
    for (const line of lines) {
      const finding = hintFinding(path, line, text[line - 1]);
      if (finding !== null) findings.push(finding);
    }
  }
  const coverage = coverageFindings(repo.dir, production, options.podmanCoverage);
  findings.push(...coverage.findings);

  const runs = new Map([...production].map(([path, lines]) => [path, lineRuns(lines)]));
  const planned = new Map(await Promise.all(
    [...runs].map(async ([path, fileRuns]) => [path, await plannedMutants(path, contents.get(path), fileRuns)]),
  ));
  const deletions = [...added]
    .filter(([path]) => deletionEntry(path) !== undefined)
    .flatMap(([path, lines]) => deletableLines(contents.get(path), lines).map((line) => ({ path, line })));
  const { run, over } = capUnits([...[...planned.values()].flat(), ...deletions], CAP);

  const running = new Set(run);
  const mutate = new Map();
  for (const [path, mutants] of planned) {
    const kept = mutants.filter((mutant) => running.has(mutant));
    if (kept.length > 0) mutate.set(path, cappedRuns(runs.get(path), mutants, kept));
  }
  const deleting = deletions.filter((unit) => running.has(unit));

  rmSync(join(repo.dir, WORK_DIR), { recursive: true, force: true });
  mkdirSync(join(repo.dir, LOG_DIR), { recursive: true });
  const [probe, deletion] = await Promise.all([
    mutate.size === 0 ? { findings: [], killed: 0, statics: 0 } : runProbe(repo.dir, mutate, contents),
    deleting.length === 0 ? { findings: [], caught: 0 } : runDeletions(repo.dir, deleting),
  ]);
  findings.push(...probe.findings, ...deletion.findings);

  return {
    findings: findings.length === 0 ? [] : [`tests: ${findings.length} findings`, ...findings],
    summary: testsSummary({ ...coverage.counts, ...probe, caught: deletion.caught, over }),
  };
}
