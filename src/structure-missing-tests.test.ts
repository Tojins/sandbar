// The `missing-tests` structural check (#183, #236, #264): its pure layer as
// tables, and the check proved able to go red by running `run.mjs` over a
// fixture branch beside its green twin, after a real coverage run.
import { spawnSync } from "node:child_process";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { StructureError } from "../scripts/structure/core.mjs";
import {
  coverageFindings, lineCoverage, PODMAN_COVERAGE, statementHits, UNIT_COVERAGE, uncoveredFindings,
} from "../scripts/structure/coverage.mjs";
import { hintFinding, isProduction, missingTestsSummary } from "../scripts/structure/missing-tests.mjs";
import { git, run, useFixtures } from "./structure.test-util.js";

const NODE_MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));
const VITEST = join(NODE_MODULES, "vitest", "vitest.mjs");
// Real vitest runs, each several seconds when the suite is busy.
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

const write = async (dir: string, path: string, files: Record<string, unknown>) => {
  await mkdir(join(dir, path, ".."), { recursive: true });
  await writeFile(join(dir, path), JSON.stringify(files));
};

const vitest = (dir: string, ...args: string[]) => {
  const result = spawnSync(process.execPath, [VITEST, "run", ...args], { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`vitest ${args.join(" ")}: ${result.stdout}${result.stderr}`);
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
});

describe("hints", () => {
  it.each([
    ["/* v8 ignore next -- the platform branch */", null],
    ["/* v8 ignore next */", "src/x.ts:3  v8 ignore hint without a reason"],
    ["/* v8 ignore next -- */", "src/x.ts:3  v8 ignore hint without a reason"],
    ["/* c8 ignore start */", "src/x.ts:3  v8 ignore hint without a reason"],
    ["/* istanbul ignore else -- unreachable */", null],
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
      { line: 4, state: "covered" },
      { line: 5, state: "uncovered" },
      { line: 7, state: "uncovered" },
      { line: 9, state: "covered" },
    ]);
    expect(lineCoverage("src/a.ts", [4, 5], unit, new Map())).toEqual([
      { line: 4, state: "uncovered" },
      { line: 5, state: "uncovered" },
    ]);
    expect(lineCoverage("src/b.ts", [1], unit, podman)).toBeNull();
  });

  it("groups uncovered lines into runs only a counted, not-uncovered line breaks", () => {
    const counted = [
      { line: 3, state: "uncovered" }, { line: 5, state: "uncovered" }, { line: 6, state: "uncovered" },
      { line: 8, state: "covered" }, { line: 9, state: "uncovered" }, { line: 11, state: "covered" },
      { line: 12, state: "uncovered" },
    ];
    expect(uncoveredFindings("src/a.ts", counted))
      .toEqual(["src/a.ts:3-6  uncovered", "src/a.ts:9  uncovered", "src/a.ts:12  uncovered"]);
  });

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
      covered: 2,
    },
    {
      name: "no podman file locally",
      files: [UNIT_COVERAGE],
      requirePodman: false,
      findings: ["src/a.ts:2-3  uncovered"],
      covered: 1,
    },
  ])("$name", async ({ files, requirePodman, findings, covered }) => {
    const dir = await coverageDir(files);
    expect(coverageFindings(dir, new Map([["src/a.ts", [1, 2, 3]]]), requirePodman))
      .toEqual({ findings, covered });
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

  it("a coverage file that cannot be read is an error", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, UNIT_COVERAGE), { recursive: true });
    expect(() => coverageFindings(dir, new Map(), false))
      .toThrow(new StructureError(`${UNIT_COVERAGE} cannot be read: EISDIR: illegal operation on a directory, read`));
  });

  it.each([
    ["null", null],
    ["a string", "s"],
    ["an array of files", [coverageFile("/w/src/a.ts", [[1, 1]])]],
    ["a file that is a number", { a: 1 }],
    ["a file whose path is not a string", { a: { ...coverageFile("/w/src/a.ts", [[1, 1]]), path: 7 } }],
    ["a file without a statement map", { a: { path: "x", s: {} } }],
    ["a file without hits", { a: { path: "x", statementMap: {} } }],
    ["a statement without a start line", { a: { path: "x", statementMap: { 0: {} }, s: { 0: 1 } } }],
    ["a statement without a hit count", { a: { path: "x", statementMap: { 0: { start: { line: 1 } } }, s: {} } }],
  ])("a coverage file holding %s is an error", async (_name, json) => {
    const dir = await tempDir();
    await write(dir, UNIT_COVERAGE, json as Record<string, unknown>);
    expect(() => coverageFindings(dir, new Map(), false))
      .toThrow(new StructureError(`${UNIT_COVERAGE} is not istanbul coverage`));
  });

  it("a changed file coverage never measured is a finding: it measured another tree", async () => {
    const dir = await tempDir();
    await write(dir, UNIT_COVERAGE, {});
    expect(coverageFindings(dir, new Map([["src/new.ts", [1]]]), false).findings)
      .toEqual([`src/new.ts  absent from ${UNIT_COVERAGE}`]);
  });
});

describe("summary", () => {
  it.each([
    [1, "missing-tests: 1 line covered, 0 uncovered"],
    [37, "missing-tests: 37 lines covered, 0 uncovered"],
  ])("%i covered", (covered, line) => {
    expect(missingTestsSummary(covered)).toBe(line);
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

  const writeCoverage = async (dir: string, content: string) => {
    await mkdir(join(dir, "coverage/unit"), { recursive: true });
    await writeFile(join(dir, UNIT_COVERAGE), content);
  };

  const expectCannotAnswer = (result: ReturnType<typeof run>, line: RegExp) => {
    expect(result).toMatchObject({ status: 2, stderr: "" });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatch(line);
  };

  // Root reads and writes past a file's mode, as the gate's runner does.
  const asRoot = process.getuid?.() === 0;

  it("goes red on an uncovered line and a bare hint", { timeout: SLOW }, async () => {
    const { dir, result } = await gateRun("missing-tests-red");
    expect(result).toEqual({
      status: 1,
      lines: ["src/calc.ts:7  v8 ignore hint without a reason", "src/calc.ts:10  uncovered"],
      stderr: "",
    });
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("passes its green twin in one line", { timeout: SLOW }, async () => {
    const { result } = await gateRun("missing-tests-green");
    expect(result).toEqual({ status: 0, lines: ["missing-tests: 3 lines covered, 0 uncovered"], stderr: "" });
  });

  it("cannot answer without the coverage the test steps write, in one line", async () => {
    const dir = await fixtureRepo("missing-tests-red");
    expect(run(dir, "missing-tests", "--base", "origin/main", "--podman-coverage")).toEqual({
      status: 2,
      lines: ["missing-tests: coverage/unit/coverage-final.json is missing: the test step wrote no coverage"],
      stderr: "",
    });
  });

  // JSON.parse quotes the text it choked on, newlines included.
  it.each([
    ["a line of garbage", "not json\n"],
    ["an error page", "<html>\n<body>502</body>\n</html>\n"],
  ])("cannot answer over coverage that is %s, in one line", async (_name, content) => {
    const dir = await fixtureRepo("missing-tests-red");
    await writeCoverage(dir, content);
    expectCannotAnswer(
      run(dir, "missing-tests", "--base", "origin/main"),
      /^missing-tests: coverage\/unit\/coverage-final\.json is not JSON: /,
    );
  });

  it.each([
    ["a directory", (path: string) => mkdir(path, { recursive: true }), / cannot be read: EISDIR: /],
    ["null", (path: string) => writeFile(path, "null"), / is not istanbul coverage$/],
  ])("cannot answer over a coverage file that is %s, in one line", async (_name, make, reason) => {
    const dir = await fixtureRepo("missing-tests-red");
    await mkdir(join(dir, "coverage/unit"), { recursive: true });
    await make(join(dir, UNIT_COVERAGE));
    const result = run(dir, "missing-tests", "--base", "origin/main");
    expectCannotAnswer(result, /^missing-tests: coverage\/unit\/coverage-final\.json/);
    expect(result.lines[0]).toMatch(reason);
  });

  // A file the check cannot read is exit 2, never a crash's exit 1,
  // which reads as a finding.
  it.each([
    ["lacks", (path: string) => rm(path), "ENOENT: no such file or directory, open"],
    ["holds a directory for", async (path: string) => {
      await rm(path);
      await mkdir(path);
    }, "EISDIR: illegal operation on a directory, read"],
  ])("cannot answer when the worktree %s an added file, in one line", async (_name, make, reason) => {
    const dir = await fixtureRepo("missing-tests-red");
    await make(join(dir, "src/calc.ts"));
    expectCannotAnswer(
      run(dir, "missing-tests", "--base", "origin/main"),
      new RegExp(`^missing-tests: src/calc\\.ts cannot be read: ${reason}`),
    );
  });

  it.skipIf(asRoot)("cannot answer over an added file it may not read, in one line", async () => {
    const dir = await fixtureRepo("missing-tests-red");
    await chmod(join(dir, "src/calc.ts"), 0);
    expectCannotAnswer(
      run(dir, "missing-tests", "--base", "origin/main"),
      /^missing-tests: src\/calc\.ts cannot be read: EACCES: /,
    );
  });

  it("cannot answer with --git-dir from a directory that is not the worktree, in one line", async () => {
    const dir = await fixtureRepo("missing-tests-red");
    const elsewhere = await tempDir();
    expect(run(elsewhere, "missing-tests", "--base", "origin/main", "--git-dir", join(dir, ".git"))).toEqual({
      status: 2,
      lines: [
        `missing-tests: src/calc.ts cannot be read: ENOENT: no such file or directory, open '${elsewhere}/src/calc.ts'`,
      ],
      stderr: "",
    });
  });

  // Without podman coverage no podman test ran, so a local run reds what the
  // unit tests leave unhit rather than passing it (#264).
  it("reds a line no unit test hits when no podman coverage was written", async () => {
    const dir = await fixtureRepo("missing-tests-red");
    const calc = join(dir, "src/calc.ts");
    await write(dir, UNIT_COVERAGE, { [calc]: coverageFile(calc, [[2, 1], [5, 1], [8, 1], [10, 0]]) });
    expect(run(dir, "missing-tests", "--base", "origin/main")).toEqual({
      status: 1,
      lines: ["src/calc.ts:7  v8 ignore hint without a reason", "src/calc.ts:10  uncovered"],
      stderr: "",
    });
  });

  // A merge result is judged as a branch is (#264): the merger's gate-2 has
  // no skip.
  it("checks the landing shape as it checks a branch", async () => {
    const dir = await fixtureRepo("missing-tests-red");
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "land", "topic");
    const calc = join(dir, "src/calc.ts");
    await write(dir, UNIT_COVERAGE, { [calc]: coverageFile(calc, [[2, 1], [5, 0], [8, 1], [10, 0]]) });
    await write(dir, PODMAN_COVERAGE, { [calc]: coverageFile(calc, [[5, 3], [10, 0]]) });
    expect(run(dir, "missing-tests", "--base", "origin/main", "--podman-coverage")).toEqual({
      status: 1,
      lines: ["src/calc.ts:7  v8 ignore hint without a reason", "src/calc.ts:10  uncovered"],
      stderr: "",
    });
  });
});
