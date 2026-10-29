import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EventInput } from "./events.js";
import { loadTemplate } from "./prompts.js";
import type { ReviewerResult } from "./inner-loop-machine.js";
import {
  type ParsedStandards,
  type RuleGroup,
  combineGroupReviews,
  combineStandards,
  janitorStandards,
  parseStandards,
  readQualityStandards,
  renderStandards,
} from "./standards-groups.js";
import { type StandaloneStepRun, combineVerifyReview, stepFindings } from "./standalone-steps.js";

const exec = promisify(execFile);

const BUILTIN = parseStandards(loadTemplate("coding-standards"), "sandbar");

const group = (id: string, name: string, body: string, janitor = false): RuleGroup =>
  ({ id, name, origin: "project", body, janitor });

describe("parseStandards (#204)", () => {
  it.each<[string, string, Partial<ParsedStandards>]>([
    [
      "a file without ## is one group, today's behavior",
      "Rule one.\n\nRule two.\n",
      { preamble: "", groups: [group("project", "Project standards", "Rule one.\n\nRule two.")] },
    ],
    [
      "a preamble and two groups",
      "Shared intro.\n\n## Tests\n\nCover it.\n\n## Naming\n\nNo abbreviations.\n",
      {
        preamble: "Shared intro.",
        groups: [group("tests", "Tests", "Cover it."), group("naming", "Naming", "No abbreviations.")],
      },
    ],
    [
      "### and deeper are body",
      "## Tests\n\n### Unit\n\nCover it.\n#### Deeper\n",
      { groups: [group("tests", "Tests", "### Unit\n\nCover it.\n#### Deeper")] },
    ],
    [
      "a closing run of # is dropped",
      "## Tests ##\n\nCover it.\n",
      { groups: [group("tests", "Tests", "Cover it.")] },
    ],
    [
      "CRLF reads as LF",
      "## Tests\r\n\r\nCover it.\r\nAll of it.\r\n",
      { groups: [group("tests", "Tests", "Cover it.\nAll of it.")] },
    ],
    [
      "## inside a ``` fence is body",
      "## Docs\n\n```md\n## Not a group\n```\n",
      { groups: [group("docs", "Docs", "```md\n## Not a group\n```")] },
    ],
    [
      "## inside a ~~~ fence is body, and a shorter or other fence does not close it",
      "## Docs\n\n~~~~\n```\n~~~\n## Not a group\n~~~~\n## After\n\nx\n",
      {
        groups: [
          group("docs", "Docs", "~~~~\n```\n~~~\n## Not a group\n~~~~"),
          group("after", "After", "x"),
        ],
      },
    ],
    [
      "Leave alone in any case goes to leaveAlone, several concatenated in order",
      "## Tests\n\nCover it.\n\n## Leave alone\n\nTaste.\n\n## LEAVE ALONE\n\nGenerated files.\n",
      { groups: [group("tests", "Tests", "Cover it.")], leaveAlone: ["Taste.", "Generated files."] },
    ],
    [
      "a file with only Leave alone keeps the rest as the project group",
      "Rule one.\n\n## Leave alone\n\nTaste.\n",
      { preamble: "", groups: [group("project", "Project standards", "Rule one.")], leaveAlone: ["Taste."] },
    ],
    [
      "colliding slugs take -2, -3, and a project never takes sandbar",
      "## Tests\n\na\n\n## tests!\n\nb\n\n## TESTS\n\nc\n\n## Sandbar\n\nd\n\n## Sandbar 2\n\ne\n",
      {
        groups: [
          group("tests", "Tests", "a"),
          group("tests-2", "tests!", "b"),
          group("tests-3", "TESTS", "c"),
          group("sandbar-2", "Sandbar", "d"),
          group("sandbar-2-2", "Sandbar 2", "e"),
        ],
      },
    ],
  ])("%s", (_name, text, expected) => {
    expect(parseStandards(text, "project")).toMatchObject({ warnings: [], leaveAlone: [], ...expected });
  });

  it.each([
    ["## Tests {janitor}", true],
    ["## Tests { janitor }", true],
    ["## Tests {janitor, x}", true],
    ["## Tests {x janitor}", true],
    ["## Tests", false],
  ])("reads the janitor flag of %s", (heading, janitor) => {
    const [parsed] = parseStandards(`${heading}\n\nCover it.\n`, "project").groups;
    expect(parsed).toEqual(group("tests", "Tests", "Cover it.", janitor));
  });

  it.each<[string, string, RegExp]>([
    ["an unknown flag", "## Tests {jantor}\n\nx\n", /unknown flag \{jantor\} on "## Tests"/],
    ["a flag on Leave alone", "## Tests\n\nx\n\n## Leave alone {janitor}\n\ny\n", /\{janitor\} on "## Leave alone" are ignored/],
    ["an empty group", "## Tests\n\n## Naming\n\nx\n", /"## Tests" has no rules and is dropped/],
    ["a preamble over 600 chars", `${"p".repeat(601)}\n\n## Tests\n\nx\n`, /601 chars \(over 600\): rules belong under a "##" group/],
  ])("warns on %s and never throws", (_name, text, warning) => {
    const parsed = parseStandards(text, "project");
    expect(parsed.warnings).toEqual([expect.stringMatching(warning)]);
    expect(parsed.groups.map((g) => g.janitor)).not.toContain(true);
  });

  it("drops an unknown flag but keeps janitor beside it", () => {
    expect(parseStandards("## Tests {janitor, jantor}\n\nx\n", "project").groups)
      .toEqual([group("tests", "Tests", "x", true)]);
  });

  it("does not warn on a 600-char preamble, nor on one that is the only group", () => {
    expect(parseStandards(`${"p".repeat(600)}\n\n## Tests\n\nx\n`, "project").warnings).toEqual([]);
    expect(parseStandards("p".repeat(601), "project").warnings).toEqual([]);
  });

  // Pins #184: rules are added inside the one built-in group, never beside it.
  it("parses the shipped coding standards to exactly one group and one Leave alone", () => {
    expect(BUILTIN.warnings).toEqual([]);
    expect(BUILTIN.preamble).toBe("");
    expect(BUILTIN.groups).toEqual([expect.objectContaining({
      id: "sandbar",
      name: "Coding standards",
      origin: "sandbar",
      janitor: false,
    })]);
    expect(BUILTIN.groups[0]!.body).toContain("### Violations");
    expect(BUILTIN.leaveAlone).toEqual([expect.stringMatching(/^- Pure taste/)]);
  });
});

describe("combineStandards (#204)", () => {
  it("puts the built-in group first and its Leave alone before the project's", () => {
    const project = parseStandards("Intro.\n\n## Tests\n\nx\n\n## Leave alone\n\nGenerated.\n", "project");
    const combined = combineStandards(BUILTIN, project);
    expect(combined.groups.map((g) => g.id)).toEqual(["sandbar", "tests"]);
    expect(combined.preamble).toBe("Intro.");
    expect(combined.leaveAlone).toEqual([BUILTIN.leaveAlone[0], "Generated."]);
    expect(combined.warnings).toEqual([]);
  });

  it("is the built-in standards alone without a project file", () => {
    expect(combineStandards(BUILTIN, null)).toEqual({
      groups: BUILTIN.groups,
      preamble: "",
      leaveAlone: BUILTIN.leaveAlone,
      warnings: [],
    });
  });

  it("warns above 5 groups in total, the built-in one included", () => {
    const groups = (n: number) =>
      parseStandards(Array.from({ length: n }, (_, i) => `## G${i}\n\nx\n`).join("\n"), "project");
    expect(combineStandards(BUILTIN, groups(4)).warnings).toEqual([]);
    expect(combineStandards(BUILTIN, groups(5)).warnings)
      .toEqual([expect.stringMatching(/^6 rule groups \(over 5\)/)]);
  });
});

describe("renderStandards (#204)", () => {
  const standards = combineStandards(
    BUILTIN,
    parseStandards("Intro.\n\n## Tests {janitor}\n\nx\n\n## Naming\n\ny\n\n## Leave alone\n\nGenerated.\n", "project"),
  );
  const leaveAlone = `## Leave alone\n\n${BUILTIN.leaveAlone[0]}\n\nGenerated.`;

  it("renders every group under its heading for lens all, without flags", () => {
    expect(renderStandards(standards, { kind: "all" })).toBe(
      `Intro.\n\n## Coding standards\n\n${BUILTIN.groups[0]!.body}\n\n## Tests\n\nx\n\n## Naming\n\ny\n\n${leaveAlone}`,
    );
  });

  it("renders one group with the preamble and Leave alone for a group lens", () => {
    expect(renderStandards(standards, { kind: "group", group: standards.groups[2]! }))
      .toBe(`Intro.\n\n## Naming\n\ny\n\n${leaveAlone}`);
  });
});

describe("combineGroupReviews (#204)", () => {
  const sandbar = BUILTIN.groups[0]!;
  const naming = group("naming", "Naming", "y");
  const tests = group("tests", "Tests", "x");
  const approved: ReviewerResult = { kind: "reviewer-result", verdict: "APPROVED", prose: "<verdict>APPROVED</verdict>" };
  const requested = (finding: string): ReviewerResult =>
    ({ kind: "reviewer-result", verdict: "CHANGES-REQUESTED", prose: `\n${finding}\n<verdict>CHANGES-REQUESTED</verdict>\n` });
  const failed = (detail: string): ReviewerResult => ({ kind: "reviewer-harness-failed", detail });
  const wrote = (detail: string): ReviewerResult => ({ kind: "reviewer-wrote", detail });

  it.each<[string, readonly ReviewerResult[], ReviewerResult]>([
    ["every group approved approves", [approved, approved, approved],
      { kind: "reviewer-result", verdict: "APPROVED", prose: "" }],
    ["a write anywhere is a write, tagged per writing group", [wrote("a.ts"), requested("x"), wrote("b.ts")],
      { kind: "reviewer-wrote", detail: "[group: sandbar] a.ts\n\n[group: tests] b.ts" }],
    ["a write outranks a harness failure", [failed("dead"), wrote("a.ts"), approved],
      { kind: "reviewer-wrote", detail: "[group: naming] a.ts" }],
    ["requests concatenate in group order, verdict tokens stripped", [requested("s1"), approved, requested("t1")],
      { kind: "reviewer-result", verdict: "CHANGES-REQUESTED",
        prose: `[group: sandbar] ${sandbar.name}\n\ns1\n\n[group: tests] Tests\n\nt1` }],
    ["a request names each group that produced no review", [failed("dead"), requested("n1"), failed("gone")],
      { kind: "reviewer-result", verdict: "CHANGES-REQUESTED",
        prose: "[group: naming] Naming\n\nn1\n\n[group: sandbar] produced no review this pass." +
          "\n\n[group: tests] produced no review this pass." }],
    ["a harness failure beside approvals is no review", [approved, failed("dead"), approved],
      { kind: "reviewer-harness-failed", detail: "[group: naming] dead" }],
    ["harness failures alone are no review, tagged", [failed("dead"), failed("gone"), approved],
      { kind: "reviewer-harness-failed", detail: "[group: sandbar] dead\n\n[group: naming] gone" }],
  ])("%s", (_name, results, expected) => {
    const groups = [sandbar, naming, tests];
    const reviews = results.map((review, i) => ({ group: groups[i]!, review }));
    expect(combineGroupReviews(reviews, [])).toEqual(expected);
  });

  it("refuses an empty fan-out rather than approving it", () => {
    expect(() => combineGroupReviews([], [])).toThrow(/no group reviews/);
  });

  // #247: each early step run, as `stepFindings` renders it, beside the
  // groups. Only a failed step is a finding.
  describe("beside the early run of the standalone steps (#247)", () => {
    const step = { name: "lint", in: "app", command: ["lint"], timeoutMs: 1000, settles: [], standalone: true };
    const base = { step, image: "app:gate", durationMs: 3, output: "src/a.ts:1 inline it" };
    const columns: readonly (readonly [string, readonly StandaloneStepRun[]])[] = [
      ["no standalone step", []],
      ["a passed step", [{ ...base, result: "passed", exitCode: 0, detail: null }]],
      ["a failed step", [{ ...base, result: "failed", exitCode: 1, detail: null }]],
      ["a timed-out step", [{ ...base, result: "timed-out", exitCode: null, detail: null }]],
      ["an unavailable step", [{ ...base, result: "unavailable", exitCode: null, detail: "no image" }]],
    ];
    const finding = stepFindings([{ ...base, result: "failed", exitCode: 1, detail: null }])[0]!;
    const changes = (...prose: string[]): ReviewerResult =>
      ({ kind: "reviewer-result", verdict: "CHANGES-REQUESTED", prose: prose.join("\n\n") });
    const s1 = `[group: sandbar] ${sandbar.name}\n\ns1`;
    const noReview = "[group: sandbar] produced no review this pass.";

    // Each row: the groups' results, then what the pass is without a finding
    // and with one.
    const rows: readonly (readonly [string, readonly ReviewerResult[], ReviewerResult, ReviewerResult])[] = [
      ["every group approved", [approved, approved, approved],
        { kind: "reviewer-result", verdict: "APPROVED", prose: "" }, changes(finding)],
      ["a group requested changes", [requested("s1"), approved, approved], changes(s1), changes(s1, finding)],
      ["some groups failed", [failed("dead"), approved, approved],
        { kind: "reviewer-harness-failed", detail: "[group: sandbar] dead" }, changes(finding, noReview)],
      ["every group failed", [failed("dead"), failed("gone"), failed("lost")],
        { kind: "reviewer-harness-failed", detail: "[group: sandbar] dead\n\n[group: naming] gone\n\n[group: tests] lost" },
        changes(finding, noReview, "[group: naming] produced no review this pass.",
          "[group: tests] produced no review this pass.")],
      ["a group wrote", [wrote("a.ts"), approved, approved],
        { kind: "reviewer-wrote", detail: "[group: sandbar] a.ts" },
        { kind: "reviewer-wrote", detail: "[group: sandbar] a.ts" }],
    ];

    it.each(rows.flatMap(([row, results, without, withFinding]) => columns.map(([column, runs]) =>
      [`${row}, ${column}`, results, runs, column === "a failed step" ? withFinding : without] as const)))(
      "folds %s",
      (_name, results, runs, expected) => {
        const groups = [sandbar, naming, tests];
        const reviews = results.map((review, i) => ({ group: groups[i]!, review }));
        expect(combineGroupReviews(reviews, stepFindings(runs))).toEqual(expected);
      },
    );

    // The verify's fold (#247), with the same columns.
    const verifyRows: readonly (readonly [string, ReviewerResult, ReviewerResult])[] = [
      ["an approved verify", approved, changes(finding)],
      ["a verify with items open", requested("v1"), changes("v1", finding)],
      ["a verify that produced no review", failed("dead"), failed("dead")],
      ["a verify that wrote", wrote("a.ts"), wrote("a.ts")],
    ];
    it.each(verifyRows.flatMap(([row, review, withFinding]) => columns.map(([column, runs]) =>
      [`${row}, ${column}`, review, runs, column === "a failed step" ? withFinding : review] as const)))(
      "folds %s",
      (_name, review, runs, expected) => {
        expect(combineVerifyReview(review, stepFindings(runs))).toEqual(expected);
      },
    );
  });
});

describe("janitorStandards (#204)", () => {
  it("is null when no group is flagged", () => {
    expect(janitorStandards(combineStandards(BUILTIN, parseStandards("## Tests\n\nx\n", "project")))).toBeNull();
    expect(janitorStandards(combineStandards(BUILTIN, null))).toBeNull();
  });

  it("renders only the flagged project groups, never the built-in one", () => {
    const flaggedBuiltin = { ...BUILTIN, groups: BUILTIN.groups.map((g) => ({ ...g, janitor: true })) };
    const janitor = janitorStandards(combineStandards(
      flaggedBuiltin,
      parseStandards("## Tests {janitor}\n\nx\n\n## Naming\n\ny\n", "project"),
    ));
    expect(janitor?.groups.map((g) => g.id)).toEqual(["tests"]);
    expect(janitor?.text).toBe(`## Tests\n\nx\n\n## Leave alone\n\n${BUILTIN.leaveAlone[0]}`);
  });
});

// Real git (#186's rule): the grader is the source tip's file, never the
// branch's own.
describe("readQualityStandards (#204)", () => {
  let repo: string;
  const git = (...args: string[]) =>
    exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo });
  const commitFile = async (text: string) => {
    await writeFile(join(repo, "STANDARDS.md"), text);
    await git("add", "-A");
    await git("commit", "-qm", "standards");
  };
  const read = (extension: Parameters<typeof readQualityStandards>[0]["extension"], events: EventInput[] = []) =>
    readQualityStandards({ repoDir: repo, sourceBranch: "main", extension, onEvent: (e) => { events.push(e); } });

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "sandbar-standards-"));
    await git("init", "-q", "-b", "work");
    await commitFile("## Tests\n\nTip rule.\n");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("reads a path extension at origin/<sourceBranch>, not the branch's edit", async () => {
    await commitFile("## Tests\n\nBranch rule.\n");
    const standards = await read({ path: "STANDARDS.md" });
    expect(standards.groups.map((g) => g.body)).toEqual([BUILTIN.groups[0]!.body, "Tip rule."]);
  });

  it("is the built-in standards alone when the tip has no such file or none is configured", async () => {
    expect(await read({ path: "MISSING.md" })).toEqual(combineStandards(BUILTIN, null));
    expect(await read(undefined)).toEqual(combineStandards(BUILTIN, null));
  });

  it("parses a text extension as the project file", async () => {
    expect((await read({ text: "## Naming\n\nNo abbreviations.\n" })).groups.map((g) => g.id))
      .toEqual(["sandbar", "naming"]);
  });

  it("complains once per version of the file", async () => {
    const events: EventInput[] = [];
    const extension = { text: "## Tests {jantor}\n\nx\n" };
    await read(extension, events);
    await read(extension, events);
    await read({ text: "## Tests {jantr}\n\nx\n" }, events);
    expect(events).toEqual([
      expect.objectContaining({ kind: "complaint", severity: "warning", message: expect.stringContaining("{jantor}") }),
      expect.objectContaining({ kind: "complaint", severity: "warning", message: expect.stringContaining("{jantr}") }),
    ]);
  });
});
