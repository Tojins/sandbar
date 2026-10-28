// The #183 measurement script (#209): pure classification over a report
// object, and its git and CLI edges run for real.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  classify,
  classifyCommit,
  classifyFinding,
  readCommitPaths,
  renderClassification,
  splitFindings,
} from "../scripts/stats-classify.mjs";

const exec = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/stats-classify.mjs", import.meta.url));

const temporaryDirectories = new Set<string>();
afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((path) => rm(path, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "sandbar-stats-classify-"));
  temporaryDirectories.add(dir);
  return dir;
};

const git = async (dir: string, ...args: string[]): Promise<string> =>
  (await exec("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@e", ...args])).stdout.trim();

// Commits `files` on top of HEAD and returns the new sha.
const commit = async (dir: string, files: Readonly<Record<string, string>>): Promise<string> => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "--allow-empty", "-m", "c");
  return git(dir, "rev-parse", "HEAD");
};

const tokens = (input: number | null, output: number | null = null) =>
  ({ input, cached: null, cacheWrite: null, output, reasoning: null });

const row = (fields: Record<string, unknown>) => ({
  run: "run-1", issue: 1, attempt: 1, verdict: null, shas: null, prose: null, tokens: tokens(null),
  ...fields,
});

const LISTER_REPORT = [
  "Let me look at the branch first.",
  "",
  "### Tests",
  "",
  "- `src/a.ts:12` is uncovered: no test reaches the early return.",
  "  Add a case that passes an empty list.",
  "  - nested detail stays with its item",
  "- `src/a.test.ts:40` asserts nothing; delete it or pin the result.",
  "",
  "### Standards",
  "",
  "`src/b.ts:7` swallows the error in a catch that logs and continues.",
  "",
  "`src/b.ts:30` Loose contracts: the field is optional for no reason.",
  "",
  "<verdict>CHANGES-REQUESTED</verdict>",
].join("\n");

describe("splitFindings (#209)", () => {
  it("takes each top-level item under the two dimension headings, nested lines included", () => {
    expect(splitFindings(LISTER_REPORT)).toEqual([
      {
        heading: "Tests",
        text: "- `src/a.ts:12` is uncovered: no test reaches the early return. " +
          "Add a case that passes an empty list. - nested detail stays with its item",
      },
      { heading: "Tests", text: "- `src/a.test.ts:40` asserts nothing; delete it or pin the result." },
      { heading: "Standards", text: "`src/b.ts:7` swallows the error in a catch that logs and continues." },
      { heading: "Standards", text: "`src/b.ts:30` Loose contracts: the field is optional for no reason." },
    ]);
  });

  it("reads nothing outside those headings", () => {
    expect(splitFindings("### Summary\n\n- looks fine\n\n<verdict>APPROVED</verdict>")).toEqual([]);
    expect(splitFindings("### Tests\n- x is uncovered\n## Notes\n- not a finding")).toEqual([
      { heading: "Tests", text: "- x is uncovered" },
    ]);
  });
});

describe("classifyFinding (#209)", () => {
  it.each([
    ["src/a.ts:12 is uncovered", "deletion/uncovered"],
    ["Deleting src/a.ts:12 leaves the suite green", "deletion/uncovered"],
    ["the test at a.test.ts:4 asserts nothing", "deletion/uncovered"],
    ["src/version-conflict.ts:9 has no test", "deletion/uncovered"],
    ["The commit lacks a version bump", "version"],
    ["package.json: version 0.4.1 is not above main's", "version"],
    ["src/version-conflict.ts:9 is too clever", "unclassified"],
    ["src/run.ts now exceeds 1000 lines", "size"],
    ["Spaghetti control flow: the flag is re-checked", "rule:spaghetti"],
    ["Wrong abstraction — an identity wrapper", "rule:wrong-abstraction"],
    ["Logic in the wrong layer: lanes knows about chunks", "rule:wrong-layer"],
    ["Loose contract: `any` in the signature", "rule:loose-contracts"],
    ["Non-atomic orchestration of the two writes", "rule:non-atomic"],
    ["Complexity that doesn't pay for itself", "rule:complexity"],
    ["The module header still describes the old flow", "rule:module-header"],
    ["The timer ordering is fragile", "unclassified"],
  ])("%s → %s", (text, expected) => {
    expect(classifyFinding(text)).toBe(expected);
  });
});

describe("classifyCommit (#209)", () => {
  it.each([
    [["src/a.test.ts", "package.json", "package-lock.json"], "tests only"],
    [["src/__fixtures__/x/golden.json", "src/a.test-util.ts"], "tests only"],
    [["package.json", "package-lock.json"], "version only"],
    [["src/a.ts", "src/a.test.ts", "package.json"], "mixed"],
    [["fixtures/package.json"], "tests only"],
    [[], "empty"],
    [null, "missing"],
  ])("%j → %s", (paths, expected) => {
    expect(classifyCommit(paths)).toBe(expected);
  });
});

describe("classify (#209)", () => {
  it("counts findings per class, apportions tokens by finding count, and lists the unclassified", () => {
    const report = {
      invocations: [
        row({ role: "quality-list", verdict: "CHANGES-REQUESTED", prose: LISTER_REPORT, tokens: tokens(300, 100) }),
        row({ role: "quality-fix", shas: ["s1", "s2"], tokens: tokens(800) }),
        row({ role: "quality-verify", verdict: "CHANGES-REQUESTED", prose: "### Tests\n- a.ts:1 uncovered" }),
        row({ role: "quality-fix", shas: ["s3"], tokens: tokens(null) }),
        row({ issue: 2, role: "quality-list", verdict: "CHANGES-REQUESTED", prose: null }),
        row({ issue: 3, role: "quality-list", verdict: "APPROVED", prose: "<verdict>APPROVED</verdict>" }),
        row({ issue: 4, role: "quality-list", verdict: "CHANGES-REQUESTED", prose: "### Standards\n- the version bump is missing" }),
        row({ issue: 4, role: "quality-fix", shas: ["s4"], tokens: tokens(null) }),
        row({ issue: 4, role: "implementer", shas: null }),
      ],
    };
    const paths = new Map<string, readonly string[] | null>([
      ["s1", ["src/a.test.ts", "package.json"]],
      ["s2", ["src/b.ts", "package.json"]],
      ["s3", ["package.json", "package-lock.json"]],
      ["s4", null],
    ]);
    expect(renderClassification(classify(report, paths))).toBe([
      "Quality findings: 5 from 3 CHANGES-REQUESTED lister reports (1 without speech)",
      "class                   findings  share  lister tokens  fixer tokens",
      "deletion/uncovered      2         40%    200            400",
      "version                 1         20%    -              -",
      "size                    0         0%     -              -",
      "rule:complexity         0         0%     -              -",
      "rule:spaghetti          0         0%     -              -",
      "rule:wrong-abstraction  0         0%     -              -",
      "rule:wrong-layer        0         0%     -              -",
      "rule:loose-contracts    1         20%    100            200",
      "rule:non-atomic         0         0%     -              -",
      "rule:module-header      0         0%     -              -",
      "unclassified            1         20%    100            200",
      "",
      "Fixer commits: 4",
      "class         commits",
      "tests only    1",
      "version only  1",
      "mixed         1",
      "empty         0",
      "missing       1",
      "",
      "Unclassified findings: 1",
      "run-1 #1 attempt 1 [Standards] `src/b.ts:7` swallows the error in a catch that logs and continues.",
      "",
    ].join("\n"));
  });

  it("prints - for every share when no report was read", () => {
    const rendered = renderClassification(classify({ invocations: [] }, new Map()));
    expect(rendered).toContain("Quality findings: 0 from 0 CHANGES-REQUESTED lister reports (0 without speech)");
    expect(rendered).toContain("unclassified            0         -      -              -");
  });
});

describe("readCommitPaths (real git, #209)", () => {
  it("reads each commit's paths and names a sha the repo lacks as null", async () => {
    const dir = await tempDir();
    await git(dir, "init", "-q", "-b", "main");
    await commit(dir, { "src/a.ts": "a" });
    const tests = await commit(dir, { "src/a.test.ts": "t", "package.json": "{}" });
    const empty = await commit(dir, {});
    const missing = "0".repeat(40);
    expect(readCommitPaths(dir, [tests, empty, missing, tests])).toEqual(new Map([
      [tests, ["package.json", "src/a.test.ts"]],
      [empty, []],
      [missing, null],
    ]));
  });
});

describe("node scripts/stats-classify.mjs (#209)", () => {
  const classifyCli = async (args: readonly string[]) => {
    try {
      const { stdout } = await exec(process.execPath, [SCRIPT, ...args]);
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      const failed = err as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  };

  it("classifies a report against the repo named by --repo", async () => {
    const dir = await tempDir();
    await git(dir, "init", "-q", "-b", "main");
    const sha = await commit(dir, { "package.json": "{}" });
    const reportPath = join(dir, "report.json");
    await writeFile(reportPath, JSON.stringify({
      invocations: [
        row({ role: "quality-list", verdict: "CHANGES-REQUESTED", prose: "### Tests\n- a.ts:3 uncovered" }),
        row({ role: "quality-fix", shas: [sha] }),
      ],
    }));
    const result = await classifyCli([reportPath, "--repo", dir]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("deletion/uncovered      1         100%");
    expect(result.stdout).toContain("version only  1");
  });

  it.each([
    ["a report without prose", [{ role: "quality-list", shas: null }]],
    ["a report without shas", [{ role: "quality-list", prose: null }]],
  ])("exits 2 on %s", async (_name, invocations) => {
    const dir = await tempDir();
    const reportPath = join(dir, "report.json");
    await writeFile(reportPath, JSON.stringify({ invocations }));
    const result = await classifyCli([reportPath]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("rerun stats with --json --with-prose");
  });

  it.each([
    ["no report", []],
    ["an unknown flag", ["r.json", "--verbose"]],
  ])("exits 2 on %s", async (_name, args) => {
    const result = await classifyCli(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: stats-classify.mjs");
  });
});
