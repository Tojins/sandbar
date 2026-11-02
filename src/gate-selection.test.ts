import { describe, expect, it } from "vitest";

import { TESTS_TOKEN, type ResolvedGateStep, type SanityDeclaration } from "./config.js";
import {
  type ChangedFile,
  expandToken,
  finishSelection,
  globMatcher,
  parseRelatedOutput,
  planSelection,
  selectionPlanFor,
  selectionTraceLine,
  selects,
} from "./gate-selection.js";

const step = (name: string, tests: readonly string[] | null): ResolvedGateStep => ({
  name,
  in: "runner",
  command: tests === null ? ["true"] : ["vitest", "{tests}"],
  timeoutMs: 1_000,
  settles: [],
  standalone: false,
  parallel: false,
  tests,
});

const steps = [
  step("check", null),
  step("test", ["src/**/*.test.ts", "!src/**/*-podman.test.ts"]),
  step("podman-test", ["src/**/*-podman.test.ts"]),
];

const files = [
  "package.json",
  "prompts/a.md",
  "src/config.ts",
  "src/config.test.ts",
  "src/errors.ts",
  "src/errors.test.ts",
  "src/gate.ts",
  "src/gate.test.ts",
  "src/gate-stack-podman.test.ts",
  "src/lanes.ts",
  "src/lanes.test.ts",
];

const declaration: SanityDeclaration = {
  sanity: ["src/config.test.ts"],
  core: { paths: ["src/errors.ts", "src/gate.ts"], sanity: ["src/errors.test.ts"] },
  domains: [
    { name: "gate", description: "", paths: ["src/gate*.ts"], sanity: ["src/gate.test.ts", "src/gate-stack-podman.test.ts"] },
    { name: "planning", description: "", paths: ["src/lanes.ts", "prompts/**"], sanity: ["src/lanes.test.ts"] },
  ],
};

const changedOf = (...paths: string[]): ChangedFile[] =>
  paths.map((path) => ({ path, deleted: path.startsWith("-") })).map((c) =>
    c.deleted ? { path: c.path.slice(1), deleted: true } : c);

const plan = (
  changed: readonly ChangedFile[],
  extra: { declarations?: readonly [SanityDeclaration, ...SanityDeclaration[]]; namedDomains?: string[] } = {},
) => planSelection({
  declarations: extra.declarations ?? [declaration],
  steps,
  changed,
  files,
  namedDomains: extra.namedDomains ?? [],
});

describe("globMatcher", () => {
  it.each<[string[], string, boolean]>([
    [["src/*.ts"], "src/gate.ts", true],
    [["src/*.ts"], "src/sub/gate.ts", false],
    [["src/**/*.ts"], "src/gate.ts", true],
    [["src/**/*.ts"], "src/a/b/gate.ts", true],
    [["prompts/**"], "prompts/x/y.md", true],
    [["src/gate?.ts"], "src/gate1.ts", true],
    [["src/gate?.ts"], "src/gate.ts", false],
    [["src/a.ts"], "src/a+ts", false],
    [["src/a.ts"], "src/aXts", false],
    // Every other regular-expression character is a literal.
    [["src/a(b|c).ts"], "src/a(b|c).ts", true],
    [["src/a(b|c).ts"], "src/ab.ts", false],
    [["src/[ab].ts"], "src/a.ts", false],
    [["src/a{1}$^\\.ts"], "src/a{1}$^\\.ts", true],
    [["src/a{1}.ts"], "src/a.ts", false],
    [["^src/a.ts"], "src/a.ts", false],
    [["Containerfile"], "Containerfile", true],
    [["Containerfile"], "sub/Containerfile", false],
    [["src/**/*.test.ts", "!src/**/*-podman.test.ts"], "src/gate-podman.test.ts", false],
    [["src/**/*.test.ts", "!src/**/*-podman.test.ts"], "src/gate.test.ts", true],
    [["!src/x.ts"], "src/y.ts", false],
  ])("%j against %s is %s", (globs, path, expected) => {
    expect(globMatcher(globs)(path)).toBe(expected);
  });
});

describe("planSelection", () => {
  it("selects only the global set for a change no domain reaches", () => {
    const p = plan(changedOf("package.json"));
    expect(p).toMatchObject({
      global: ["src/config.test.ts"],
      core: [],
      domains: {},
      changed: [],
      relatedInput: ["package.json"],
      ignored: [],
    });
  });

  it("adds core's set for a core file and keeps it from domains and related", () => {
    const p = plan(changedOf("src/gate.ts"));
    expect(p.core).toEqual(["src/errors.test.ts"]);
    expect(p.domains).toEqual({});
    expect(p.relatedInput).toEqual([]);
  });

  it("adds every domain a changed path reaches, deleted ones included", () => {
    const p = plan(changedOf("src/gate-stack.ts", "-prompts/a.md"));
    expect(p.domains).toEqual({
      gate: ["src/gate-stack-podman.test.ts", "src/gate.test.ts"],
      planning: ["src/lanes.test.ts"],
    });
    expect(p.relatedInput).toEqual(["src/gate-stack.ts"]);
  });

  it("adds the changed files a step's tests match, never a deleted one", () => {
    const p = plan(changedOf("src/lanes.test.ts", "-src/gate.test.ts", "src/lanes.ts", "src/gate-stack-podman.test.ts"));
    // The podman file is one step's own, though the other step excludes it.
    expect(p.changed).toEqual(["src/lanes.test.ts", "src/gate-stack-podman.test.ts"]);
    expect(p.relatedInput).toEqual(["src/lanes.test.ts", "src/lanes.ts", "src/gate-stack-podman.test.ts"]);
  });

  it("adds a domain named by hand and records one the stack does not declare", () => {
    const p = plan([], { namedDomains: ["planning", "ui"] });
    expect(p.domains).toEqual({ planning: ["src/lanes.test.ts"] });
    expect(p.ignored).toEqual([{ kind: "domain", name: "ui" }]);
  });

  it("records a sanity glob that matches no file of the tree, once", () => {
    const stale: SanityDeclaration = {
      sanity: ["src/gone.test.ts", "src/config.test.ts"],
      core: { paths: ["src/errors.ts"], sanity: ["src/errors-gone.test.ts"] },
      domains: [{ name: "planning", description: "", paths: ["src/lanes.ts"], sanity: ["src/lanes-*.test.ts"] }],
    };
    const p = plan(changedOf("src/errors.ts", "src/lanes.ts"), { declarations: [stale, stale] });
    expect(p.global).toEqual(["src/config.test.ts"]);
    expect(p.ignored).toEqual([
      { kind: "glob", set: "sanity", glob: "src/gone.test.ts" },
      { kind: "glob", set: "core", glob: "src/errors-gone.test.ts" },
      { kind: "glob", set: "domain 'planning'", glob: "src/lanes-*.test.ts" },
    ]);
  });

  it("does not let an exclusion hide a sanity glob's other matches", () => {
    const p = plan([], {
      declarations: [{ ...declaration, sanity: ["src/*.test.ts", "!src/lanes.test.ts"] }],
    });
    expect(p.global).toEqual([
      "src/config.test.ts", "src/errors.test.ts", "src/gate-stack-podman.test.ts", "src/gate.test.ts",
    ]);
  });

  it("unions parts 1–3 over a branch's own declaration, and keeps related to the first's core", () => {
    const branch: SanityDeclaration = {
      sanity: ["src/lanes.test.ts"],
      core: { paths: ["src/lanes.ts"], sanity: ["src/errors.test.ts"] },
      domains: [{ name: "gate", description: "", paths: ["src/lanes.ts"], sanity: ["src/config.test.ts"] }],
    };
    const p = plan(changedOf("src/lanes.ts"), { declarations: [declaration, branch] });
    expect(p.global).toEqual(["src/config.test.ts", "src/lanes.test.ts"]);
    expect(p.core).toEqual(["src/errors.test.ts"]);
    expect(p.domains).toEqual({ planning: ["src/lanes.test.ts"] });
    expect(p.relatedInput).toEqual(["src/lanes.ts"]);
  });

  it("selects nothing beyond the global set without a core or domains", () => {
    const p = plan(changedOf("src/gate.ts"), { declarations: [{ sanity: [], core: null, domains: [] }] });
    expect(p).toMatchObject({ global: [], core: [], domains: {}, relatedInput: ["src/gate.ts"] });
  });
});

describe("parseRelatedOutput", () => {
  const tree = new Set(files);

  it("reads one path a line, trimmed, blank lines and repeats dropped", () => {
    expect(parseRelatedOutput("src/lanes.test.ts\n\n  src/gate.test.ts \nsrc/lanes.test.ts\n", tree))
      .toEqual({ files: ["src/gate.test.ts", "src/lanes.test.ts"] });
  });

  it("names every printed path that is not a file of the tree", () => {
    expect(parseRelatedOutput("src/gate.test.ts\n/w/src/lanes.test.ts\nsrc/nope.test.ts\n", tree))
      .toEqual({ missing: ["/w/src/lanes.test.ts", "src/nope.test.ts"] });
  });
});

describe("finishSelection", () => {
  it("unions the parts, splits them by step and records what no step runs", () => {
    const p = plan(changedOf("src/gate-stack.ts", "src/errors.ts", "src/lanes.test.ts"));
    const selection = finishSelection(p, ["src/lanes.test.ts", "prompts/a.md"], steps);
    expect(selection).toEqual({
      global: ["src/config.test.ts"],
      core: ["src/errors.test.ts"],
      domains: { gate: ["src/gate-stack-podman.test.ts", "src/gate.test.ts"] },
      changed: ["src/lanes.test.ts"],
      related: ["src/lanes.test.ts", "prompts/a.md"],
      files: [
        "src/config.test.ts",
        "src/errors.test.ts",
        "src/gate-stack-podman.test.ts",
        "src/gate.test.ts",
        "src/lanes.test.ts",
      ],
      steps: {
        test: ["src/config.test.ts", "src/errors.test.ts", "src/gate.test.ts", "src/lanes.test.ts"],
        "podman-test": ["src/gate-stack-podman.test.ts"],
      },
      ignored: [{ kind: "unstepped", file: "prompts/a.md" }],
    });
  });

  it("leaves a step whose tests match nothing selected with none", () => {
    const selection = finishSelection(plan([]), [], steps);
    expect(selection.steps).toEqual({ test: ["src/config.test.ts"], "podman-test": [] });
  });
});

describe("expandToken", () => {
  it("replaces the {tests} entry with one entry per file, wherever it stands", () => {
    expect(
      expandToken(["vitest", "run", "{tests}", "--reporter=dot"], TESTS_TOKEN, ["a.test.ts", "b.test.ts"]),
    ).toEqual(["vitest", "run", "a.test.ts", "b.test.ts", "--reporter=dot"]);
    expect(expandToken(["vitest", "{tests}x"], TESTS_TOKEN, ["a.test.ts"])).toEqual(["vitest", "{tests}x"]);
  });
});

describe("selectionPlanFor", () => {
  const stack = { containers: [], steps: [step("check", null)], ...declaration, related: null };

  it("reads nothing for a stack whose steps declare no tests", async () => {
    expect(selects(stack)).toBe(false);
    await expect(selectionPlanFor({ stack, classification: { kind: "same" } }, "/nonexistent", "main"))
      .resolves.toBeNull();
  });

  it("is asked of a stack with a selecting step", () => {
    expect(selects({ ...stack, steps })).toBe(true);
  });
});

describe("selectionTraceLine", () => {
  const selection = finishSelection(plan([]), [], steps);

  it("names the files a gate ran, and says so when there were none", () => {
    expect(selectionTraceLine(selection))
      .toBe("[sandbar] this gate ran these test files:\nsrc/config.test.ts\n\n");
    expect(selectionTraceLine({ ...selection, files: [] }))
      .toBe("[sandbar] this gate's selection held no test file.\n\n");
    expect(selectionTraceLine(undefined)).toBe("");
  });
});
