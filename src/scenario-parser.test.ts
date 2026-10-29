import { describe, expect, it } from "vitest";

import {
  MAX_SCENARIOS,
  type Scenario,
  parseScenarioWriter,
  renderScenario,
  scenarioSetErrors,
  scenarioTouched,
} from "./scenario-parser.js";

const S1 = [
  "### S1: Paid invoices keep their total",
  "needs: ui, sql",
  "area: app/Invoices, resources/views/invoices/show.blade.php",
  "Given an invoice with two lines",
  "And the invoice is paid",
  "When the user opens it",
  "Then the total is the sum of its lines",
  "And no row in invoice_lines changed",
].join("\n");

const scenario = (n: number): string => [
  `### S${n}: Scenario ${n}`,
  "needs: cli",
  "area: src",
  "Given a state",
  "When an action",
  "Then an outcome",
].join("\n");

const written = (block: string): string =>
  `<scenario-writer>WRITTEN</scenario-writer>\n<scenarios>\n${block}\n</scenarios>`;

const reprompt = (stdout: string): string => {
  const result = parseScenarioWriter(stdout);
  if (result.kind !== "NO-SIGNAL") throw new Error(`expected NO-SIGNAL, got ${result.kind}`);
  return result.reprompt;
};

describe("parseScenarioWriter tokens", () => {
  it("parses a WRITTEN block into scenarios", () => {
    expect(parseScenarioWriter(written(S1))).toEqual({
      kind: "WRITTEN",
      scenarios: [{
        id: "S1",
        title: "Paid invoices keep their total",
        needs: ["ui", "sql"],
        area: ["app/Invoices", "resources/views/invoices/show.blade.php"],
        given: ["an invoice with two lines", "the invoice is paid"],
        when: ["the user opens it"],
        then: ["the total is the sum of its lines", "no row in invoice_lines changed"],
      }],
    });
  });

  it("asks for the token when there is none", () => {
    expect(reprompt(`<scenarios>\n${S1}\n</scenarios>`)).toContain("<scenario-writer>WRITTEN</scenario-writer>");
  });

  it("takes the last well-formed token", () => {
    expect(parseScenarioWriter(
      `${written(S1)}\n<scenario-writer>NONE</scenario-writer>\n` +
        "<scenario-none-reason>A docs change.</scenario-none-reason>",
    )).toEqual({ kind: "NONE", reason: "A docs change." });
    expect(parseScenarioWriter(
      "<scenario-writer>NONE</scenario-writer>\n" + written(S1),
    )).toMatchObject({ kind: "WRITTEN" });
  });

  it("does not let a quoted opener swallow the real block", () => {
    const stdout = "I will write a `<scenarios>` block now.\n" + written(S1);
    expect(parseScenarioWriter(stdout)).toMatchObject({ kind: "WRITTEN", scenarios: [{ id: "S1" }] });
  });

  it("requires a reason for NONE and a block for WRITTEN", () => {
    expect(reprompt("<scenario-writer>NONE</scenario-writer>")).toContain("<scenario-none-reason>");
    expect(reprompt("<scenario-writer>WRITTEN</scenario-writer>")).toContain("<scenarios>");
  });
});

describe("parseScenarioWriter grammar", () => {
  it("requires ids S1..Sn in order", () => {
    expect(reprompt(written(`${S1}\n\n${scenario(3)}`))).toContain("`S3` should be `S2`");
  });

  it("refuses a need outside the closed set, and a repeated one", () => {
    expect(reprompt(written(S1.replace("needs: ui, sql", "needs: ui, browser"))))
      .toContain("`browser` is not a need");
    expect(reprompt(written(S1.replace("needs: ui, sql", "needs: ui, ui"))))
      .toContain("`ui` is named twice");
  });

  it.each([
    ["/app/Invoices", "absolute"],
    ["app/../secrets", "`..` segment"],
    ["app/*.php", "glob character"],
    ["", "an empty path"],
  ])("refuses the area path %j", (path, problem) => {
    expect(reprompt(written(S1.replace(/^area: .*$/m, `area: ${path}`)))).toContain(problem);
  });

  it("accepts an area path that does not exist yet, with a trailing slash", () => {
    expect(parseScenarioWriter(written(S1.replace(/^area: .*$/m, "area: app/NewModule/"))))
      .toMatchObject({ kind: "WRITTEN", scenarios: [{ area: ["app/NewModule/"] }] });
  });

  it("refuses clauses out of order", () => {
    const whenFirst = scenario(1).replace("Given a state\nWhen an action", "When an action\nGiven a state");
    expect(reprompt(written(whenFirst))).toContain("Given out of order");
    const skipsWhen = scenario(1).replace("When an action\n", "");
    const problems = reprompt(written(skipsWhen));
    expect(problems).toContain("Then out of order");
    expect(problems).toContain("has no When clause");
  });

  it("refuses an And with nothing above it", () => {
    expect(reprompt(written(scenario(1).replace("Given a state", "And a state"))))
      .toContain("`And` with no Given");
  });

  it("joins an indented line onto the clause above it", () => {
    const block = scenario(1).replace("Then an outcome", "Then an outcome\n   spanning two lines");
    expect(parseScenarioWriter(written(block))).toMatchObject({
      kind: "WRITTEN",
      scenarios: [{ then: ["an outcome spanning two lines"] }],
    });
  });

  it("names the scenario and line of anything else, and lists every violation", () => {
    const block = `${S1}\nSo the user is happy\n\n${scenario(2).replace("needs: cli\n", "")}`;
    const problems = reprompt(written(block));
    expect(problems).toContain("line 9 (scenario S1): `So the user is happy`");
    expect(problems).toContain("scenario S2 has no `needs:` line");
  });

  it("refuses a field line after the clauses have begun", () => {
    expect(reprompt(written(`${scenario(1)}\nneeds: ui`))).toContain("must come before the first Given");
  });

  it("holds between 1 and 20 scenarios", () => {
    expect(reprompt(written(""))).toContain("holds no scenario");
    const many = Array.from({ length: MAX_SCENARIOS + 1 }, (_, i) => scenario(i + 1)).join("\n\n");
    expect(reprompt(written(many))).toContain(`keep the most valuable ${MAX_SCENARIOS}`);
    const most = Array.from({ length: MAX_SCENARIOS }, (_, i) => scenario(i + 1)).join("\n\n");
    expect(parseScenarioWriter(written(most))).toMatchObject({ kind: "WRITTEN" });
  });
});

describe("renderScenario", () => {
  it("renders back to the block grammar the parser reads", () => {
    const first = parseScenarioWriter(written(S1));
    if (first.kind !== "WRITTEN") throw new Error("fixture did not parse");
    const [only] = first.scenarios;
    expect(renderScenario(only!)).toBe(S1);
    expect(parseScenarioWriter(written(first.scenarios.map(renderScenario).join("\n\n"))))
      .toEqual(first);
  });
});

describe("scenarioTouched", () => {
  const touched: Scenario = {
    id: "S1",
    title: "t",
    needs: ["ui"],
    area: ["app/Invoices", "routes/web.php"],
    given: ["g"],
    when: ["w"],
    then: ["t"],
  };

  it.each([
    [["routes/web.php"], true],
    [["app/Invoices"], true],
    [["app/Invoices/Show.php"], true],
    [["app/InvoicesArchive/Show.php"], false],
    [["app/Inv"], false],
    [["README.md"], false],
    [[], false],
  ])("on %j is %s", (paths, expected) => {
    expect(scenarioTouched(touched, paths)).toBe(expected);
  });

  it("reads an area entry with a trailing slash as the directory", () => {
    expect(scenarioTouched({ ...touched, area: ["app/Invoices/"] }, ["app/Invoices/Show.php"]))
      .toBe(true);
  });
});

describe("scenarioSetErrors (#240)", () => {
  const stored = (n: number) =>
    ({ id: `S${n}`, title: "t", needs: ["cli"], area: [], given: ["g"], when: ["w"], then: ["t"] });
  const set = {
    version: 1,
    issue: 7,
    seed: { ref: "origin/main", sha: "a".repeat(40) },
    writer: { provider: "claude", model: "m", effort: null },
    scenarios: [stored(1), stored(2)],
  };

  it("accepts a set the writer filed", () => {
    expect(scenarioSetErrors(set)).toEqual([]);
    expect(scenarioSetErrors({ ...set, writer: { ...set.writer, effort: "high" } })).toEqual([]);
  });

  it("lists every violation, not the first", () => {
    expect(scenarioSetErrors({
      version: 2,
      issue: 0,
      seed: { ref: "origin/main" },
      writer: { provider: "claude", model: "m" },
      scenarios: [
        { ...stored(1), title: "", needs: ["cli", "cli"], area: "src" },
        { ...stored(3), needs: ["gui"], given: [], when: "w", then: [7] },
        "S3",
      ],
    })).toEqual([
      "version is not 1",
      "issue is not a positive integer",
      "seed is not { ref, sha }",
      "writer is not { provider, model, effort }",
      "scenarios[0].title is not a non-empty string",
      "scenarios[0].needs is not a list of distinct ui, api, sql, integration, cli",
      "scenarios[0].area is not a list of strings",
      "scenarios[1].id is not S2",
      "scenarios[1].needs is not a list of distinct ui, api, sql, integration, cli",
      "scenarios[1].given is not a non-empty list of strings",
      "scenarios[1].when is not a non-empty list of strings",
      "scenarios[1].then is not a non-empty list of strings",
      "scenarios[2] is not an object",
    ]);
  });

  it.each([
    ["no object", null, ["is not an object"]],
    ["no scenarios", { ...set, scenarios: [] }, [`scenarios is not a list of 1 to ${MAX_SCENARIOS} scenarios`]],
    [
      "too many scenarios",
      { ...set, scenarios: Array.from({ length: MAX_SCENARIOS + 1 }, (_, i) => stored(i + 1)) },
      [`scenarios is not a list of 1 to ${MAX_SCENARIOS} scenarios`],
    ],
  ])("refuses %s", (_, value, errors) => {
    expect(scenarioSetErrors(value)).toEqual(errors);
  });
});
