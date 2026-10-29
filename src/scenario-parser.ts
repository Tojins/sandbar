// Scenario writer output parser (#203) — pure.
//
// The scenario writer is a cold, read-only role that writes hidden
// Given/When/Then scenarios for an issue while its implementer works. It
// speaks its result; it never writes a file. The token is literal and the last
// one wins (#113): WRITTEN takes the last tempered `<scenarios>` block, NONE
// requires a `<scenario-none-reason>` block.
//
// The block holds one scenario per `### S<n>: <title>` heading, ids S1..Sn in
// order. Under it come a `needs:` line (distinct members of SCENARIO_NEEDS), an
// `area:` line (repo-relative paths, which need not exist at the seed), then
// the clauses: Given+, When+, Then+, with `And` extending the clause above it.
// Blank lines are ignored; a line indented two or more spaces continues the
// clause above it. Any other line is a violation. A set holds 1 to
// MAX_SCENARIOS scenarios: the cap protects a runner's context budget and is
// never what sizes the set, which is the prompt's job. Every violation is
// listed in the one NO-SIGNAL reprompt, so a single correction can fix all.
//
// What each `needs` member means is the prompt's to say and the runner's to
// follow: `ui` drives the sandbox app in a browser, `api` sends HTTP to its own
// endpoints, `sql` queries the issue's DB copy, `integration` goes outbound
// through the egress allowlist, and `cli` runs a repo command in the sandbox.
//
// The set is stored as JSON (`ScenarioSet`) and rendered back to the block
// grammar on demand (`renderScenario`); `scenarioTouched` is the pure selection
// primitive for rerunning a scenario whose area a later change touched.
// `scenarioSetErrors` checks a stored set read back as JSON, such as one a
// replay case pins (#240), against the shape the grammar guarantees.

import { lastToken, literalTokenPattern, temperedBlockPattern } from "./token-scan.js";

export const SCENARIO_NEEDS = ["ui", "api", "sql", "integration", "cli"] as const;
export type ScenarioNeed = (typeof SCENARIO_NEEDS)[number];

export const MAX_SCENARIOS = 20;

export type Scenario = {
  readonly id: string;
  readonly title: string;
  readonly needs: readonly ScenarioNeed[];
  readonly area: readonly string[];
  readonly given: readonly string[];
  readonly when: readonly string[];
  readonly then: readonly string[];
};

export type ScenarioSet = {
  readonly version: 1;
  readonly issue: number;
  readonly seed: { readonly ref: string; readonly sha: string };
  readonly writer: {
    readonly provider: string;
    readonly model: string;
    readonly effort: string | null;
  };
  readonly scenarios: readonly Scenario[];
};

export type ScenarioWriterParseResult =
  | { readonly kind: "WRITTEN"; readonly scenarios: readonly Scenario[] }
  | { readonly kind: "NONE"; readonly reason: string }
  | { readonly kind: "NO-SIGNAL"; readonly reprompt: string };

const TOKEN = literalTokenPattern("scenario-writer", ["WRITTEN", "NONE"]);

const NO_TOKEN =
  "End with exactly `<scenario-writer>WRITTEN</scenario-writer>` followed by a " +
  "`<scenarios>` block holding every scenario, or " +
  "`<scenario-writer>NONE</scenario-writer>` followed by a " +
  "`<scenario-none-reason>` block.";

export function parseScenarioWriter(stdout: string): ScenarioWriterParseResult {
  const token = lastToken(stdout, TOKEN);
  if (token === null) return { kind: "NO-SIGNAL", reprompt: NO_TOKEN };
  if (token === "NONE") {
    const reason = lastToken(stdout, temperedBlockPattern("scenario-none-reason")) ?? "";
    return reason
      ? { kind: "NONE", reason }
      : {
          kind: "NO-SIGNAL",
          reprompt: "A NONE answer requires a `<scenario-none-reason>` block saying why " +
            "nothing the issue changes can be observed from outside.",
        };
  }
  const block = lastToken(stdout, temperedBlockPattern("scenarios"));
  if (block === null) {
    return {
      kind: "NO-SIGNAL",
      reprompt: "A WRITTEN answer requires a `<scenarios>` block holding every scenario.",
    };
  }
  const parsed = parseScenarioBlock(block);
  return parsed.violations.length === 0
    ? { kind: "WRITTEN", scenarios: parsed.scenarios }
    : {
        kind: "NO-SIGNAL",
        reprompt: [
          "Your `<scenarios>` block does not follow the format. Fix every point below " +
            "and answer again with the whole block:",
          ...parsed.violations.map((violation) => `- ${violation}`),
        ].join("\n"),
      };
}

type Clause = "given" | "when" | "then";

const CLAUSE_ORDER: readonly Clause[] = ["given", "when", "then"];

const CLAUSE_KEYWORD = {
  given: "Given",
  when: "When",
  then: "Then",
} as const satisfies Record<Clause, string>;

type Draft = {
  readonly id: string;
  readonly title: string;
  needs: ScenarioNeed[] | null;
  area: string[] | null;
  readonly clauses: Record<Clause, string[]>;
  current: Clause | null;
};

// A clause line's first word, and the clause it opens or extends.
const CLAUSE_WORDS: ReadonlyMap<string, Clause | "and"> = new Map([
  ["Given", "given"],
  ["When", "when"],
  ["Then", "then"],
  ["And", "and"],
]);

const HEADING = /^### (S\d+):(.*)$/;
const WORDS = /^(\S+)(?:\s+(.*))?$/;
const FIELD_LINE = /^(needs|area):(.*)$/;
const GLOB = /[*?[\]{}!]/;

const listOf = (raw: string): string[] => raw.split(",").map((item) => item.trim());

const isNeed = (value: string): value is ScenarioNeed =>
  (SCENARIO_NEEDS as readonly string[]).includes(value);

// Why `path` is not a usable area entry, or null when it is.
function areaPathProblem(path: string): string | null {
  if (path === "") return "an empty path";
  if (path.startsWith("/")) return `\`${path}\` is absolute; name it relative to the repository root`;
  if (GLOB.test(path)) return `\`${path}\` holds a glob character; name the file or directory`;
  const segments = path.replace(/\/+$/, "").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `\`${path}\` has an empty, \`.\` or \`..\` segment`;
  }
  return null;
}

function parseScenarioBlock(block: string): {
  readonly scenarios: readonly Scenario[];
  readonly violations: readonly string[];
} {
  const violations: string[] = [];
  const drafts: Draft[] = [];
  const lines = block.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    const at = `line ${index + 1}`;
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const id = heading[1] ?? "";
      const title = (heading[2] ?? "").trim();
      const expected = `S${drafts.length + 1}`;
      if (id !== expected) violations.push(`${at}: scenario \`${id}\` should be \`${expected}\`; ids run S1, S2, … in order.`);
      if (title === "") violations.push(`${at}: scenario ${id} has no title.`);
      drafts.push({
        id,
        title,
        needs: null,
        area: null,
        clauses: { given: [], when: [], then: [] },
        current: null,
      });
      continue;
    }
    const draft = drafts.at(-1);
    if (draft === undefined) {
      violations.push(`${at}: \`${line.trim()}\` comes before the first \`### S1: <title>\` heading.`);
      continue;
    }
    const where = `${at} (scenario ${draft.id})`;
    if (/^ {2,}\S/.test(line)) {
      const clause = draft.current;
      const last = clause === null ? undefined : draft.clauses[clause].length - 1;
      if (clause === null || last === undefined) {
        violations.push(`${where}: an indented continuation line with no clause above it.`);
      } else {
        draft.clauses[clause][last] = `${draft.clauses[clause][last]} ${line.trim()}`;
      }
      continue;
    }
    const field = FIELD_LINE.exec(line);
    if (field !== null) {
      parseField(draft, field[1] === "needs" ? "needs" : "area", field[2] ?? "", where, violations);
      continue;
    }
    const words = WORDS.exec(line);
    const clause = CLAUSE_WORDS.get(words?.[1] ?? "");
    if (clause !== undefined) {
      parseClause(draft, clause, (words?.[2] ?? "").trim(), where, violations);
      continue;
    }
    violations.push(
      `${where}: \`${line.trim()}\` is not a heading, a \`needs:\` or \`area:\` line, ` +
        "a Given/When/Then/And clause, or an indented continuation.",
    );
  }
  for (const draft of drafts) {
    if (draft.needs === null) violations.push(`scenario ${draft.id} has no \`needs:\` line.`);
    if (draft.area === null) violations.push(`scenario ${draft.id} has no \`area:\` line.`);
    for (const clause of CLAUSE_ORDER) {
      if (draft.clauses[clause].length === 0) {
        violations.push(`scenario ${draft.id} has no ${CLAUSE_KEYWORD[clause]} clause.`);
      }
    }
  }
  if (drafts.length === 0) violations.push("the block holds no scenario.");
  if (drafts.length > MAX_SCENARIOS) {
    violations.push(
      `the block holds ${drafts.length} scenarios; keep the most valuable ${MAX_SCENARIOS}.`,
    );
  }
  return {
    violations,
    scenarios: drafts.map((draft) => ({
      id: draft.id,
      title: draft.title,
      needs: draft.needs ?? [],
      area: draft.area ?? [],
      given: draft.clauses.given,
      when: draft.clauses.when,
      then: draft.clauses.then,
    })),
  };
}

function parseField(
  draft: Draft,
  name: "needs" | "area",
  raw: string,
  where: string,
  violations: string[],
): void {
  if (draft.current !== null) {
    violations.push(`${where}: the \`${name}:\` line must come before the first Given.`);
  }
  if (draft[name] !== null) {
    violations.push(`${where}: a second \`${name}:\` line.`);
    return;
  }
  const items = listOf(raw);
  if (name === "area") {
    for (const problem of items.map(areaPathProblem)) {
      if (problem !== null) violations.push(`${where}: area has ${problem}.`);
    }
    draft.area = items;
    return;
  }
  const needs: ScenarioNeed[] = [];
  for (const item of items) {
    if (!isNeed(item)) {
      violations.push(
        `${where}: \`${item}\` is not a need; use one or more of ${SCENARIO_NEEDS.join(", ")}.`,
      );
    } else if (needs.includes(item)) {
      violations.push(`${where}: \`${item}\` is named twice in needs.`);
    } else {
      needs.push(item);
    }
  }
  draft.needs = needs;
}

function parseClause(
  draft: Draft,
  clause: Clause | "and",
  text: string,
  where: string,
  violations: string[],
): void {
  const keyword = clause === "and" ? "And" : CLAUSE_KEYWORD[clause];
  if (text === "") violations.push(`${where}: an empty ${keyword} clause.`);
  if (clause === "and") {
    if (draft.current === null) {
      violations.push(`${where}: \`And\` with no Given, When or Then above it.`);
      return;
    }
    draft.clauses[draft.current].push(text);
    return;
  }
  const position = CLAUSE_ORDER.indexOf(clause);
  const current = draft.current === null ? -1 : CLAUSE_ORDER.indexOf(draft.current);
  if (position < current || position > current + 1) {
    violations.push(
      `${where}: ${keyword} out of order; clauses run Given, then When, then Then, ` +
        "with `And` for more of the same.",
    );
  }
  draft.current = clause;
  draft.clauses[clause].push(text);
}

// The block grammar for one scenario, which `parseScenarioWriter` reads back
// unchanged inside a `<scenarios>` block.
export function renderScenario(s: Scenario): string {
  return [
    `### ${s.id}: ${s.title}`,
    `needs: ${s.needs.join(", ")}`,
    `area: ${s.area.join(", ")}`,
    renderClauses(s),
  ].join("\n");
}

// The scenario's Given/When/Then lines alone.
export function renderClauses(s: Scenario): string {
  const clause = (keyword: string, texts: readonly string[]): string[] =>
    texts.map((text, i) => `${i === 0 ? keyword : "And"} ${text}`);
  return [
    ...clause("Given", s.given),
    ...clause("When", s.when),
    ...clause("Then", s.then),
  ].join("\n");
}

// Whether a change to `changedPaths` reaches the scenario: some changed path
// is one of its area entries or lies under one.
export function scenarioTouched(s: Scenario, changedPaths: readonly string[]): boolean {
  const areas = s.area.map((entry) => entry.replace(/\/+$/, ""));
  return changedPaths.some((path) =>
    areas.some((entry) => path === entry || path.startsWith(`${entry}/`)));
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTextList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function scenarioErrors(value: unknown, at: string, id: string): readonly string[] {
  if (!isObject(value)) return [`${at} is not an object`];
  const errors: string[] = [];
  if (value.id !== id) errors.push(`${at}.id is not ${id}`);
  if (typeof value.title !== "string" || value.title === "") errors.push(`${at}.title is not a non-empty string`);
  const { needs } = value;
  if (!isTextList(needs) || new Set(needs).size !== needs.length || !needs.every(isNeed)) {
    errors.push(`${at}.needs is not a list of distinct ${SCENARIO_NEEDS.join(", ")}`);
  }
  if (!isTextList(value.area)) errors.push(`${at}.area is not a list of strings`);
  for (const clause of CLAUSE_ORDER) {
    const texts = value[clause];
    if (!isTextList(texts) || texts.length === 0) errors.push(`${at}.${clause} is not a non-empty list of strings`);
  }
  return errors;
}

// Every way `value` is not a `ScenarioSet` written for `issue`.
export function scenarioSetErrors(value: unknown, issue: number): readonly string[] {
  if (!isObject(value)) return ["is not an object"];
  const errors: string[] = [];
  if (value.version !== 1) errors.push("version is not 1");
  if (typeof value.issue !== "number" || !Number.isInteger(value.issue) || value.issue <= 0) {
    errors.push("issue is not a positive integer");
  } else if (value.issue !== issue) {
    errors.push(`issue is not ${issue}`);
  }
  const { seed, writer, scenarios } = value;
  if (!isObject(seed) || typeof seed.ref !== "string" || typeof seed.sha !== "string") {
    errors.push("seed is not { ref, sha }");
  }
  if (
    !isObject(writer) || typeof writer.provider !== "string" || typeof writer.model !== "string" ||
    (writer.effort !== null && typeof writer.effort !== "string")
  ) {
    errors.push("writer is not { provider, model, effort }");
  }
  if (!Array.isArray(scenarios) || scenarios.length === 0 || scenarios.length > MAX_SCENARIOS) {
    errors.push(`scenarios is not a list of 1 to ${MAX_SCENARIOS} scenarios`);
  } else {
    scenarios.forEach((scenario: unknown, i) =>
      errors.push(...scenarioErrors(scenario, `scenarios[${i}]`, `S${i + 1}`)));
  }
  return errors;
}
