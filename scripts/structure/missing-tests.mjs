// The `missing-tests` check (#183, #236), the `tests-structure` step, which
// settles the rule of that name: every line the branch adds is executed and
// pinned by a test. Over the lines `merge-base(HEAD, <base>)..HEAD` adds:
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
// The landing shape is skipped in one line: gate-1 settled each branch, and a
// mutation run in the serialized landing costs minutes per land. It is HEAD
// reached from `<base>` by first-parent merges, as every gate-2 is: a cycle's
// merges stacked on the source tip, a push race's merge of the moved tip into
// them, a chunk's member merges and refreshes. A commit of its own on that
// path keeps the shape only when it adds no line the check reads, as the
// merger's lockfile sync after a merge adds none. Any other, a branch's for
// gate-1 or a resolve agent's fix, is code no gate has settled, so the check
// runs.
//
// It reads the worktree, which in the gate is the clean HEAD it judges (D1),
// and writes only under the gitignored `.stryker-tmp/`, cleared first and
// removed once the tools answer; a tool that cannot leaves it for the log its
// line names. The worktree is the working directory, `--git-dir` or not: a
// judged file it lacks or cannot read, or a `.stryker-tmp/` it cannot clear,
// is exit 2.

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { addedLines, git, LOG_DIR, mergeBase, withFsError, WORK_DIR } from "./core.mjs";
import { coverageFindings, PODMAN_COVERAGE } from "./coverage.mjs";
import { deletableLines, deletionEntry, runDeletions } from "./deletion.mjs";
import { lineRuns, plannedMutants, runProbe } from "./probe.mjs";

export const CAP = 200;

export function isProduction(path) {
  return /^src\/.*\.ts$/.test(path) && !/\.test(?:-util)?\.ts$/.test(path);
}

// A changed line of `path` is read by the check.
function isJudged(path) {
  return isProduction(path) || deletionEntry(path) !== undefined;
}

// Whether `commit`, not a merge, adds a line the check reads.
function addsJudgedLine(repo, commit) {
  const numstat = git(repo, ["diff-tree", "-r", "--root", "--no-commit-id", "--no-renames", "--numstat", "-z", commit]);
  return numstat.split("\0").some((entry) => {
    const [added, , path] = entry.split("\t");
    return added !== "0" && isJudged(path);
  });
}

export function isLandingShape(repo, baseRef) {
  const path = git(repo, ["rev-list", "--first-parent", "--parents", "HEAD", "--not", baseRef]).trim();
  const commits = path.split("\n").map((line) => line.split(" "));
  return commits.some((ids) => ids.length > 2) &&
    commits.every(([commit, ...parents]) => parents.length > 1 || !addsJudgedLine(repo, commit));
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
export function missingTestsSummary({ covered, unknown, podmanOnly, killed, caught, statics, over }) {
  const unprobed = [
    [podmanOnly, "podman-only line"],
    [statics, "static mutant"],
    [over, "unit over the cap"],
  ].filter(([n]) => n > 0).map(([n, noun]) => count(n, noun));
  return `missing-tests: ${count(covered, "line")} covered, ${count(killed, "mutant")} killed, ` +
    `${count(caught, "line deletion")} caught, 0 survived` +
    (unprobed.length === 0 ? "" : ` (unprobed: ${unprobed.join(", ")})`) +
    (unknown === 0 ? "" : `; ${count(unknown, "line")} unknown without ${PODMAN_COVERAGE}`);
}

// `options.podmanCoverage`: podman coverage is required (coverage.mjs).
export async function checkMissingTests(repo, baseRef, options) {
  if (isLandingShape(repo, baseRef)) {
    return { findings: [], summary: `missing-tests: skipped, HEAD merges onto ${baseRef} (gate-1 settled the branch)` };
  }
  const added = addedLines(repo, mergeBase(repo, baseRef));
  const contents = new Map(
    [...added.keys()]
      .filter(isJudged)
      .map((path) => [path, withFsError(`${path} cannot be read`, () => readFileSync(join(repo.dir, path), "utf8"))]),
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

  withFsError(`${WORK_DIR} cannot be cleared`, () => {
    rmSync(join(repo.dir, WORK_DIR), { recursive: true, force: true });
    mkdirSync(join(repo.dir, LOG_DIR), { recursive: true });
  });
  const [probe, deletion] = await Promise.all([
    mutate.size === 0 ? { findings: [], killed: 0, statics: 0 } : runProbe(repo.dir, mutate, contents),
    deleting.length === 0 ? { findings: [], caught: 0 } : runDeletions(repo.dir, deleting),
  ]);
  findings.push(...probe.findings, ...deletion.findings);
  withFsError(`${WORK_DIR} cannot be removed`, () => rmSync(join(repo.dir, WORK_DIR), { recursive: true, force: true }));

  return {
    findings,
    summary: missingTestsSummary({ ...coverage.counts, ...probe, caught: deletion.caught, over }),
  };
}
