// The `missing-tests` structural check (#183, #236): its pure layer as tables, the
// probe and the deletion map run for real on small trees, and the check proved
// able to go red by running `run.mjs` over a fixture branch beside its green
// twin, after a real coverage run.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { StructureError } from "../scripts/structure/core.mjs";
import {
  coverageFindings, lineCoverage, PODMAN_COVERAGE, statementHits, UNIT_COVERAGE, uncoveredFindings,
} from "../scripts/structure/coverage.mjs";
import { deletableLines, deletionEntry, runDeletions } from "../scripts/structure/deletion.mjs";
import {
  lineRuns, plannedMutants, probeResult, runProbe, strykerConfig,
} from "../scripts/structure/probe.mjs";
import {
  capUnits, cappedRuns, hintFinding, isLandingShape, isProduction, missingTestsSummary,
} from "../scripts/structure/missing-tests.mjs";
import { git, run, useFixtures } from "./structure.test-util.js";

const NODE_MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));
const VITEST = join(NODE_MODULES, "vitest", "vitest.mjs");
// Real vitest and Stryker runs, each several seconds when the suite is busy.
const SLOW = 300_000;

const { tempDir, fixtureRepo } = useFixtures();

// A file's istanbul entry with one statement per `[line, hits]`.
const coverageFile = (path: string, statements: [number, number][]) => ({
  path,
  statementMap: Object.fromEntries(statements.map(([line], i) => [
    i, { start: { line, column: 0 }, end: { line, column: 9 } },
  ])),
  s: Object.fromEntries(statements.map(([, hits], i) => [i, hits])),
});

const vitest = (dir: string, ...args: string[]) => {
  const result = spawnSync(process.execPath, [VITEST, "run", ...args], { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`vitest ${args.join(" ")}: ${result.stdout}${result.stderr}`);
};

// A tree in a temporary directory, with this repository's node_modules.
const tree = async (files: Record<string, string>): Promise<string> => {
  const dir = await tempDir();
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  await symlink(NODE_MODULES, join(dir, "node_modules"));
  await mkdir(join(dir, ".stryker-tmp", "log"), { recursive: true });
  return dir;
};

describe("which lines the check reads", () => {
  it.each([
    ["src/run.ts", true],
    ["src/deep/x.ts", true],
    ["src/run.test.ts", false],
    ["src/podman-exec.test-util.ts", false],
    ["src/ui.js", false],
    ["scripts/structure/missing-tests.mjs", false],
  ])("isProduction(%s) is %s", (path, expected) => {
    expect(isProduction(path)).toBe(expected);
  });

  it.each([
    ["deploy/ansible/installations/sandbar/sandbar.config.mjs", "src/deploy-*.test.ts and src/structure-wiring.test.ts"],
    ["deploy/ansible/installations/outdoor/files/settings.local.json", "src/deploy-*.test.ts and src/structure-wiring.test.ts"],
    ["deploy/ansible/roles/sandbar/tasks/main.yml", "src/deploy-*.test.ts"],
    ["deploy/ansible/roles/sandbar/templates/sandbar.service.j2", "src/deploy-*.test.ts"],
    ["deploy/ansible/README.md", undefined],
    ["src/config.ts", undefined],
  ])("deletionEntry(%s) is %s", (path, label) => {
    expect(deletionEntry(path)?.label).toBe(label);
  });

  it("deletes no blank or comment-only line", () => {
    const content = ["a: 1", "", "  # why", "{# note #}", "// why", " * doc", "<!-- x -->", "b: 2"].join("\n");
    expect(deletableLines(content, [1, 2, 3, 4, 5, 6, 7, 8])).toEqual([1, 8]);
  });
});

// Each shape built over the `missing-tests-red` fixture: `origin/main` the
// base, `topic` one commit on it, and `other` another branch's commit.
describe("the landing shape", () => {
  // A commit appending a line to `path`, when given.
  const commit = (dir: string, name: string, path?: string) => {
    if (path !== undefined) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), `${name}\n`, { flag: "a" });
      git(dir, "add", path);
    }
    git(dir, "commit", "-q", "--allow-empty", "-m", name);
    return git(dir, "rev-parse", "HEAD");
  };
  const shapes = async () => {
    const dir = await fixtureRepo("missing-tests-red");
    git(dir, "branch", "other", "origin/main");
    git(dir, "checkout", "-q", "other");
    commit(dir, "other");
    git(dir, "checkout", "-q", "--detach", "origin/main");
    return dir;
  };
  // Moves `origin/main` one commit on, as another landing would.
  const moveBase = (dir: string) => {
    const head = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "--detach", "origin/main");
    git(dir, "update-ref", "refs/remotes/origin/main", commit(dir, "moved"));
    git(dir, "checkout", "-q", "--detach", head);
  };

  it.each([
    { name: "gate-2 of a cycle's first branch", landing: true, build: (dir: string) => {
      git(dir, "merge", "-q", "--no-ff", "-m", "land", "topic");
    } },
    { name: "gate-2 of a cycle's second branch", landing: true, build: (dir: string) => {
      git(dir, "merge", "-q", "--no-ff", "-m", "land", "topic");
      git(dir, "merge", "-q", "--no-ff", "-m", "land", "other");
    } },
    { name: "the re-gate after a push race merged the moved base in", landing: true, build: (dir: string) => {
      git(dir, "merge", "-q", "--no-ff", "-m", "land", "topic");
      git(dir, "merge", "-q", "--no-ff", "-m", "land", "other");
      moveBase(dir);
      git(dir, "merge", "-q", "--no-ff", "-m", "sync", "origin/main");
    } },
    { name: "a member landing on a chunk cut before the base moved", landing: true, build: (dir: string) => {
      git(dir, "merge", "-q", "--no-ff", "-m", "chunk", "topic");
      moveBase(dir);
      git(dir, "merge", "-q", "--no-ff", "-m", "chunk", "other");
    } },
    { name: "a chunk refresh", landing: true, build: (dir: string) => {
      git(dir, "merge", "-q", "--no-ff", "-m", "chunk", "topic");
      moveBase(dir);
      git(dir, "merge", "-q", "--no-ff", "-m", "refresh", "origin/main");
    } },
    { name: "gate-1 of a branch", landing: false, build: (dir: string) => {
      git(dir, "checkout", "-q", "topic");
    } },
    { name: "gate-1 of a branch that merged the base in", landing: false, build: (dir: string) => {
      git(dir, "checkout", "-q", "topic");
      moveBase(dir);
      git(dir, "merge", "-q", "--no-ff", "-m", "sync", "origin/main");
    } },
    { name: "gate-2 after the merger synced the lockfile", landing: true, build: (dir: string) => {
      git(dir, "merge", "-q", "--no-ff", "-m", "land", "topic");
      commit(dir, "chore: sync dependency lockfile after merge", "package-lock.json");
    } },
    { name: "a later gate-2 over a lockfile sync", landing: true, build: (dir: string) => {
      git(dir, "merge", "-q", "--no-ff", "-m", "land", "topic");
      commit(dir, "chore: sync dependency lockfile after merge", "package-lock.json");
      git(dir, "merge", "-q", "--no-ff", "-m", "land", "other");
    } },
    { name: "a merge then a commit only deleting production lines", landing: true, build: (dir: string) => {
      git(dir, "merge", "-q", "--no-ff", "-m", "land", "topic");
      git(dir, "rm", "-q", "src/calc.ts");
      commit(dir, "drop");
    } },
    { name: "gate-1 of a branch adding no judged line", landing: false, build: (dir: string) => {
      commit(dir, "docs", "README.md");
    } },
    { name: "gate-1 of a chunk member seeded from the chunk", landing: false, build: (dir: string) => {
      git(dir, "merge", "-q", "--no-ff", "-m", "chunk", "other");
      commit(dir, "member", "src/member.ts");
    } },
    { name: "the re-gate of a resolve agent's fix on a merge", landing: false, build: (dir: string) => {
      git(dir, "merge", "-q", "--no-ff", "-m", "land", "topic");
      commit(dir, "fix", "src/calc.ts");
    } },
    { name: "the re-gate of a resolve agent's fix to a mapped file", landing: false, build: (dir: string) => {
      git(dir, "merge", "-q", "--no-ff", "-m", "land", "topic");
      commit(dir, "fix", "deploy/app.yml");
    } },
    { name: "the re-gate of a resolve agent's fix after a lockfile sync", landing: false, build: (dir: string) => {
      git(dir, "merge", "-q", "--no-ff", "-m", "land", "topic");
      commit(dir, "chore: sync dependency lockfile after merge", "package-lock.json");
      commit(dir, "fix", "src/calc.ts");
    } },
  ])("$name: $landing", async ({ build, landing }) => {
    const dir = await shapes();
    build(dir);
    expect(isLandingShape({ dir }, "origin/main")).toBe(landing);
  });
});

describe("hints", () => {
  it.each([
    ["/* v8 ignore next -- the platform branch */", null],
    ["/* v8 ignore next */", "src/x.ts:3  v8 ignore hint without a reason"],
    ["/* v8 ignore next -- */", "src/x.ts:3  v8 ignore hint without a reason"],
    ["/* c8 ignore start */", "src/x.ts:3  v8 ignore hint without a reason"],
    ["/* istanbul ignore else -- unreachable */", null],
    ["// Stryker disable next-line ConditionalExpression: equivalent, the guard repeats", null],
    ["// Stryker disable next-line ConditionalExpression", "src/x.ts:3  Stryker disable hint without a reason"],
    ["// Stryker disable all:", "src/x.ts:3  Stryker disable hint without a reason"],
    ["// Stryker restore all", null],
    ["const ignore = true;", null],
  ])("%s", (text, expected) => {
    expect(hintFinding("src/x.ts", 3, text)).toBe(expected);
  });
});

describe("coverage", () => {
  const unit = statementHits({
    "/w/src/a.ts": coverageFile("/w/src/a.ts", [[1, 3], [2, 0], [2, 1], [4, 0], [5, 0], [7, 0], [9, 2]]),
  }, "/w");
  const podman = statementHits({
    "/w/src/a.ts": coverageFile("/w/src/a.ts", [[1, 0], [2, 0], [4, 5], [5, 0], [7, 0], [9, 0]]),
  }, "/w");

  it("keys files by path under the root and keeps a line's most-hit statement", () => {
    expect([...unit]).toEqual([["src/a.ts", new Map([[1, 3], [2, 1], [4, 0], [5, 0], [7, 0], [9, 2]])]]);
  });

  it("classes each changed statement line, skipping lines no statement starts on", () => {
    expect(lineCoverage("src/a.ts", [1, 3, 4, 5, 7, 9], unit, podman)).toEqual([
      { line: 1, state: "covered" },
      { line: 4, state: "podman" },
      { line: 5, state: "uncovered" },
      { line: 7, state: "uncovered" },
      { line: 9, state: "covered" },
    ]);
    expect(lineCoverage("src/a.ts", [4, 5], unit, null)).toEqual([
      { line: 4, state: "unknown" },
      { line: 5, state: "unknown" },
    ]);
    expect(lineCoverage("src/b.ts", [1], unit, podman)).toBeNull();
  });

  it("groups uncovered lines into runs only a counted, not-uncovered line breaks", () => {
    const counted = [
      { line: 3, state: "uncovered" }, { line: 5, state: "uncovered" }, { line: 6, state: "uncovered" },
      { line: 8, state: "covered" }, { line: 9, state: "uncovered" }, { line: 12, state: "podman" },
    ];
    expect(uncoveredFindings("src/a.ts", counted)).toEqual(["src/a.ts:3-6  uncovered", "src/a.ts:9  uncovered"]);
  });

  const write = async (dir: string, path: string, files: Record<string, unknown>) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), JSON.stringify(files));
  };

  const coverageDir = async (files: string[]) => {
    const dir = await tempDir();
    const a = join(dir, "src/a.ts");
    if (files.includes(UNIT_COVERAGE)) {
      await write(dir, UNIT_COVERAGE, { [a]: coverageFile(a, [[1, 1], [2, 0], [3, 0]]) });
    }
    if (files.includes(PODMAN_COVERAGE)) {
      await write(dir, PODMAN_COVERAGE, { [a]: coverageFile(a, [[1, 0], [2, 0], [3, 4]]) });
    }
    return dir;
  };

  it.each([
    {
      name: "both files, the gate",
      files: [UNIT_COVERAGE, PODMAN_COVERAGE],
      requirePodman: true,
      findings: ["src/a.ts:2  uncovered"],
      counts: { covered: 1, unknown: 0, podmanOnly: 1 },
    },
    {
      name: "no podman file locally",
      files: [UNIT_COVERAGE],
      requirePodman: false,
      findings: [],
      counts: { covered: 1, unknown: 2, podmanOnly: 0 },
    },
  ])("$name", async ({ files, requirePodman, findings, counts }) => {
    const dir = await coverageDir(files);
    expect(coverageFindings(dir, new Map([["src/a.ts", [1, 2, 3]]]), requirePodman))
      .toEqual({ findings, counts });
  });

  // Missing coverage cannot answer the check: exit 2, never a finding.
  it.each([
    { name: "no podman file in the gate", files: [UNIT_COVERAGE], requirePodman: true, missing: PODMAN_COVERAGE },
    { name: "no unit file", files: [PODMAN_COVERAGE], requirePodman: false, missing: UNIT_COVERAGE },
  ])("$name is an error", async ({ files, requirePodman, missing }) => {
    const dir = await coverageDir(files);
    expect(() => coverageFindings(dir, new Map([["src/a.ts", [1, 2, 3]]]), requirePodman))
      .toThrow(new StructureError(`${missing} is missing: the test step wrote no coverage`));
  });

  it("a coverage file that is not JSON is an error", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "coverage/unit"), { recursive: true });
    await writeFile(join(dir, UNIT_COVERAGE), "{");
    expect(() => coverageFindings(dir, new Map(), false)).toThrow(`${UNIT_COVERAGE} is not JSON: `);
  });

  it("a changed file coverage never measured is a finding: it measured another tree", async () => {
    const dir = await tempDir();
    await write(dir, UNIT_COVERAGE, {});
    expect(coverageFindings(dir, new Map([["src/new.ts", [1]]]), false).findings)
      .toEqual([`src/new.ts  absent from ${UNIT_COVERAGE}`]);
  });
});

describe("probe", () => {
  it("runs consecutive lines together", () => {
    expect(lineRuns([1, 2, 3, 7, 9, 10])).toEqual([[1, 3], [7, 7], [9, 10]]);
    expect(lineRuns([])).toEqual([]);
  });

  it("plans the probed mutators' mutants inside the runs, none a hint disabled", async () => {
    const content = [
      "export const f = (a: boolean, b: string) => a && b === \"x\";",
      "export const g = 1 + 2;",
      "// Stryker disable next-line all: the fixture's own escape",
      "export const h = (a: boolean) => !a;",
      "export const i = (a?: { b: number }) => a?.b;",
    ].join("\n");
    const planned = await plannedMutants("src/m.ts", content, [[1, 2], [4, 5]]);
    expect(planned.every((mutant) => mutant.path === "src/m.ts")).toBe(true);
    // Line 2's only mutant is an ArithmeticOperator; line 4's are disabled.
    expect(new Set(planned.map((mutant) => mutant.line))).toEqual(new Set([1, 5]));
    expect(planned).toEqual([...planned].sort((a, b) => a.line - b.line || a.column - b.column));
    expect(await plannedMutants("src/m.ts", content, [[3, 4]])).toEqual([]);
  });

  it("asks Stryker for the changed ranges with the probe's settings", () => {
    expect(strykerConfig(new Map([["src/a.ts", [[3, 5], [9, 9]]], ["src/b.ts", [[1, 1]]]]))).toMatchObject({
      testRunner: "vitest",
      vitest: { configFile: "vitest.probe.config.ts" },
      coverageAnalysis: "perTest",
      mutate: ["src/a.ts:3-5", "src/a.ts:9-9", "src/b.ts:1-1"],
      checkers: [],
      incremental: false,
      tempDirName: ".stryker-tmp",
      mutator: { excludedMutations: expect.arrayContaining(["StringLiteral", "Regex", "ArithmeticOperator"]) },
    });
  });

  it("finds each survivor and counts killed and static mutants; NoCoverage is coverage's", () => {
    // Stryker's report: 1-based lines and columns, the end column exclusive.
    const at = (line: number, column: number, endLine: number, endColumn: number) => ({
      start: { line, column }, end: { line: endLine, column: endColumn },
    });
    const report = {
      files: {
        "src/b.ts": {
          mutants: [
            { status: "Survived", mutatorName: "BlockStatement", location: at(1, 24, 4, 2), replacement: "{}" },
          ],
        },
        "src/a.ts": {
          mutants: [
            { status: "Survived", mutatorName: "ConditionalExpression", location: at(2, 5, 2, 24), replacement: "false" },
            { status: "Killed", mutatorName: "EqualityOperator", location: at(2, 5, 2, 19), replacement: "exitCode === 0" },
            { status: "Timeout", mutatorName: "BooleanLiteral", location: at(3, 1, 3, 5), replacement: "false" },
            { status: "NoCoverage", mutatorName: "BlockStatement", location: at(3, 1, 3, 5), replacement: "{}" },
            { status: "Ignored", static: true, mutatorName: "ArrayDeclaration", location: at(1, 1, 1, 3), replacement: "[]" },
            { status: "Ignored", mutatorName: "StringLiteral", location: at(1, 1, 1, 3), replacement: "\"\"" },
          ],
        },
      },
    };
    const contents = new Map([
      ["src/a.ts", "[1]\nif (exitCode !== 0 || x) {\ntrue"],
      ["src/b.ts", `export function long() {\n  ${"a".repeat(40)}();\n  ${"b".repeat(40)}();\n}`],
    ]);
    expect(probeResult(report, contents)).toEqual({
      findings: [
        "src/a.ts:2  survived ConditionalExpression: exitCode !== 0 || x → false",
        `src/b.ts:1  survived BlockStatement: { ${"a".repeat(40)}(); ${"b".repeat(13)}… → {}`,
      ],
      killed: 2,
      statics: 1,
    });
  });

  it("a probe whose dry run goes red is a one-line error naming its log", { timeout: SLOW }, async () => {
    const dir = await tree({
      "vitest.config.ts": "export default { test: { include: [\"src/**/*.test.ts\"] } };\n",
      "vitest.probe.config.ts": "export { default } from \"./vitest.config.ts\";\n",
      "src/a.ts": "export const yes = (a: boolean) => a;\n",
      "src/a.test.ts": "import { expect, it } from \"vitest\";\nimport { yes } from \"./a.js\";\nit(\"is red\", () => expect(yes(true)).toBe(false));\n",
    });
    const contents = new Map([["src/a.ts", await readFile(join(dir, "src/a.ts"), "utf8")]]);
    await expect(runProbe(dir, new Map([["src/a.ts", [[1, 1]]]]), contents))
      .rejects.toThrow(/^probe: Stryker exited 1: .*initial test run.* \(\.stryker-tmp\/log\/stryker\.log\)$/);
  });
});

describe("deletion", () => {
  it("a mapped test red before any deletion is a one-line error", { timeout: SLOW }, async () => {
    const dir = await tree({
      "vitest.config.ts": "export default { test: { include: [\"src/**/*.test.ts\"] } };\n",
      "deploy/app.yml": "name: app\n",
      "src/deploy-app.test.ts": "import { expect, it } from \"vitest\";\nit(\"is red\", () => expect(1).toBe(2));\n",
    });
    await expect(runDeletions(dir, [{ path: "deploy/app.yml", line: 1 }]))
      .rejects.toThrow("deletion: src/deploy-*.test.ts fail with no line deleted (.stryker-tmp/log/deletion-baseline-1.log)");
  });
});

describe("the cap", () => {
  it("runs the first units in path and line order and counts the rest", () => {
    const units = [
      { path: "src/b.ts", line: 1, column: 1 },
      { path: "deploy/x.yml", line: 4 },
      { path: "src/a.ts", line: 9, column: 3 },
      { path: "src/a.ts", line: 9, column: 1 },
      { path: "src/a.ts", line: 2, column: 5 },
    ];
    expect(capUnits(units, 3)).toEqual({ run: [units[1], units[4], units[3]], over: 2 });
    expect(capUnits(units, 10).over).toBe(0);
  });

  it("cuts a file's runs before its first mutant left out", () => {
    const planned = [
      { path: "src/a.ts", line: 2, column: 1 },
      { path: "src/a.ts", line: 5, column: 1 },
      { path: "src/a.ts", line: 9, column: 1 },
    ];
    const runs: [number, number][] = [[1, 3], [5, 7], [9, 12]];
    expect(cappedRuns(runs, planned, planned)).toEqual(runs);
    expect(cappedRuns(runs, planned, planned.slice(0, 2))).toEqual([[1, 3], [5, 7]]);
    expect(cappedRuns([[1, 12]], planned, planned.slice(0, 2))).toEqual([[1, 8]]);
  });
});

describe("summary", () => {
  const counts = { covered: 1, unknown: 0, podmanOnly: 0, killed: 1, caught: 1, statics: 0, over: 0 };
  it.each([
    { name: "nothing unprobed", counts, line: "missing-tests: 1 line covered, 1 mutant killed, 1 line deletion caught, 0 survived" },
    {
      name: "every kind unprobed, and unknown lines",
      counts: { covered: 37, unknown: 3, podmanOnly: 4, killed: 52, caught: 0, statics: 2, over: 1 },
      line: "missing-tests: 37 lines covered, 52 mutants killed, 0 line deletions caught, 0 survived " +
        `(unprobed: 4 podman-only lines, 2 static mutants, 1 unit over the cap); 3 lines unknown without ${PODMAN_COVERAGE}`,
    },
  ])("$name", ({ counts: c, line }) => {
    expect(missingTestsSummary(c)).toBe(line);
  });
});

// The proofs that the check can go red (#183 §3), beside the green twin:
// coverage from a real vitest v8 run of each test step, then the check.
describe("run.mjs missing-tests", () => {
  const gateRun = async (fixture: string) => {
    const dir = await fixtureRepo(fixture);
    await symlink(NODE_MODULES, join(dir, "node_modules"));
    vitest(dir, "--exclude", "**/*-podman.test.ts", "--coverage.enabled", "--coverage.reportsDirectory=coverage/unit");
    vitest(dir, "podman.test.ts", "--coverage.enabled", "--coverage.reportsDirectory=coverage/podman");
    return { dir, result: run(dir, "missing-tests", "--base", "origin/main", "--podman-coverage") };
  };

  it("goes red on an uncovered line, a survivor, a green deletion and a bare hint", { timeout: SLOW }, async () => {
    const { dir, result } = await gateRun("missing-tests-red");
    expect(result).toEqual({
      status: 1,
      lines: [
        "src/calc.ts:7  Stryker disable hint without a reason",
        "src/calc.ts:9  uncovered",
        "src/calc.ts:2  survived EqualityOperator: n > max → n >= max",
        "deploy/app.yml:2  deleted, src/deploy-*.test.ts stayed green",
      ],
      stderr: "",
    });
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("passes its green twin in one line", { timeout: SLOW }, async () => {
    const { result } = await gateRun("missing-tests-green");
    expect(result).toEqual({
      status: 0,
      lines: ["missing-tests: 2 lines covered, 5 mutants killed, 2 line deletions caught, 0 survived (unprobed: 1 podman-only line)"],
      stderr: "",
    });
  });

  it("cannot answer without the coverage the test steps write, in one line", async () => {
    const dir = await fixtureRepo("missing-tests-red");
    expect(run(dir, "missing-tests", "--base", "origin/main", "--podman-coverage")).toEqual({
      status: 2,
      lines: ["missing-tests: coverage/unit/coverage-final.json is missing: the test step wrote no coverage"],
      stderr: "",
    });
  });

  it("skips the landing shape in one line, with no coverage to read", async () => {
    const dir = await fixtureRepo("missing-tests-red");
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "land", "topic");
    expect(run(dir, "missing-tests", "--base", "origin/main")).toEqual({
      status: 0,
      lines: ["missing-tests: skipped, HEAD merges onto origin/main (gate-1 settled the branch)"],
      stderr: "",
    });
  });
});
