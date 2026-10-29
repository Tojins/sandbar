import { describe, expect, it } from "vitest";

import { parseScenarioRunner } from "./scenario-runner-parser.js";

const IDS = ["S1", "S2", "S3"];
const EXISTING = new Set(["S2/rows.txt", "S2/list.png"]);
const exists = (path: string): boolean => EXISTING.has(path);

const answer = (block: string, token = "<scenario-runner>REPORTED</scenario-runner>"): string =>
  `I ran them.\n\n${token}\n<scenario-results>\n${block}\n</scenario-results>\n`;

const GOOD = [
  "### S1: PASS",
  "Observed: the row is listed",
  "### S2: FAIL",
  "Observed: the list is empty",
  "  after a reload too",
  "Evidence: S2/rows.txt",
  "Evidence: S2/list.png",
  "",
  "### S3: UNVERIFIED",
  "Reason: playwright is not on PATH",
].join("\n");

const parse = (stdout: string, finalize = false) =>
  parseScenarioRunner(stdout, IDS, exists, { finalize });

const reprompt = (stdout: string): string => {
  const result = parse(stdout);
  if (result.kind !== "NO-SIGNAL") throw new Error(`expected NO-SIGNAL, got ${result.kind}`);
  return result.reprompt;
};

describe("parseScenarioRunner (#238)", () => {
  it("reads one outcome per scenario, joining continuation lines", () => {
    expect(parse(answer(GOOD))).toEqual({
      kind: "REPORTED",
      outcomes: [
        { id: "S1", outcome: "pass" },
        {
          id: "S2",
          outcome: "fail",
          observed: "the list is empty after a reload too",
          evidence: ["S2/rows.txt", "S2/list.png"],
        },
        { id: "S3", outcome: "unverified", reason: "runner", runnerReason: "playwright is not on PATH" },
      ],
    });
  });

  it("reads each line continuing an Evidence: line as another path", () => {
    const block = "### S2: FAIL\nObserved: empty\nEvidence: S2/rows.txt\n  S2/list.png\n";
    expect(parse(answer(block))).toMatchObject({
      kind: "REPORTED",
      outcomes: [{ id: "S1" }, { id: "S2", evidence: ["S2/rows.txt", "S2/list.png"] }, { id: "S3" }],
    });
  });

  it("takes the last token and the last block", () => {
    const quoted = answer("### S1: FAIL\nObserved: draft", "`<scenario-runner>REPORTED</scenario-runner>`");
    expect(parse(`${quoted}\n${answer(GOOD)}`)).toMatchObject({
      kind: "REPORTED",
      outcomes: [{ id: "S1", outcome: "pass" }, { id: "S2" }, { id: "S3" }],
    });
  });

  it.each([
    ["no token", "<scenario-results>\n### S1: PASS\n</scenario-results>", /End with exactly/],
    ["a malformed token", answer(GOOD, "<scenario-runner>DONE</scenario-runner>"), /End with exactly/],
    ["no block", "<scenario-runner>REPORTED</scenario-runner>\nall good", /requires a `<scenario-results>` block/],
  ])("asks again with %s, even when finalizing", (_name, stdout, expected) => {
    expect(reprompt(stdout)).toMatch(expected);
    expect(parse(stdout, true)).toMatchObject({ kind: "NO-SIGNAL" });
  });

  it("makes a scenario it left out unverified, not an error", () => {
    expect(parse(answer("### S1: PASS\n### S3: PASS"))).toEqual({
      kind: "REPORTED",
      outcomes: [
        { id: "S1", outcome: "pass" },
        { id: "S2", outcome: "unverified", reason: "not-reported" },
        { id: "S3", outcome: "pass" },
      ],
    });
  });

  it.each([
    ["an unknown id", "### S9: PASS", /`S9` is not one of the scenarios/],
    ["a duplicate", "### S1: PASS\n### S1: FAIL", /S1 is reported twice/],
    ["a verdict out of the set", "### S1: OK", /`OK` is not PASS, FAIL or UNVERIFIED/],
    ["a line before any heading", "summary\n### S1: PASS", /`summary` comes before the first/],
    ["a stray line", "### S1: PASS\nlooks fine", /`looks fine` is not an `Observed:`/],
    ["a dangling continuation", "### S1: PASS\n  more", /continuation line with no line above/],
    ["a second Observed", "### S1: PASS\nObserved: a\nObserved: b", /a second `Observed:` line/],
    ["an empty field", "### S1: UNVERIFIED\nReason:", /an empty `Reason:` line/],
    ["an UNVERIFIED with no reason", "### S1: UNVERIFIED", /an UNVERIFIED needs a `Reason:`/],
    ["a FAIL with no observation", "### S2: FAIL\nEvidence: S2/rows.txt", /a FAIL needs an `Observed:`/],
    ["a FAIL with no evidence", "### S2: FAIL\nObserved: empty", /a FAIL needs at least one `Evidence:`/],
    ["evidence that does not exist", "### S2: FAIL\nObserved: empty\nEvidence: S2/gone.txt", /`S2\/gone.txt` does not exist/],
    ["evidence outside its scenario", "### S2: FAIL\nObserved: empty\nEvidence: S1/rows.txt", /is not under `S2\/`/],
    ["evidence that escapes", "### S2: FAIL\nObserved: empty\nEvidence: S2/../../etc/passwd", /`\.\.` segment/],
    ["a glob", "### S1: PASS\nEvidence: S1/*.png", /glob character/],
  ])("lists %s in the reprompt", (_name, block, expected) => {
    expect(reprompt(answer(block))).toMatch(expected);
  });

  it("lists every violation in one reprompt", () => {
    const text = reprompt(answer("### S1: UNVERIFIED\n### S2: FAIL\nObserved: empty"));
    expect(text).toMatch(/^Your `<scenario-results>` block does not follow the format/);
    expect(text).toMatch(/S1: an UNVERIFIED needs a `Reason:`/);
    expect(text).toMatch(/S2: a FAIL needs at least one `Evidence:`/);
  });

  it("does not check that a PASS's evidence exists", () => {
    expect(parse(answer("### S1: PASS\nEvidence: S1/never-saved.png"))).toMatchObject({
      kind: "REPORTED",
      outcomes: [{ id: "S1", outcome: "pass" }, { id: "S2" }, { id: "S3" }],
    });
  });

  it("finalized, downgrades what is still wrong and keeps the rest", () => {
    const block = [
      "### S1: PASS",
      "### S2: FAIL",
      "Observed: empty",
      "Evidence: S2/gone.txt",
      "### S3: UNVERIFIED",
      "### S9: FAIL",
    ].join("\n");
    expect(parse(answer(block), true)).toEqual({
      kind: "REPORTED",
      outcomes: [
        { id: "S1", outcome: "pass" },
        { id: "S2", outcome: "unverified", reason: "fail-without-evidence" },
        { id: "S3", outcome: "unverified", reason: "not-reported" },
      ],
    });
  });
});
