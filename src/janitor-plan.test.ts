import { describe, expect, it } from "vitest";

import type { JanitorTask } from "./config.js";
import type { Terminal } from "./inner-loop.js";
import { EMPTY_JANITOR_LEDGER, type JanitorLedger } from "./janitor-ledger.js";
import {
  JANITOR_CONFLICT_PR_COMMENT,
  type JanitorOutcome,
  decideRollingBase,
  janitorHoldKey,
  janitorOutcome,
  janitorPrContent,
  janitorSourceText,
  pickJanitorTask,
  pickScope,
  renderTaskAnchor,
  runsOnDay,
  visitCounts,
} from "./janitor-plan.js";

const task = (name: string, runsPerDay = 2): JanitorTask => ({
  name, prompt: "standards", runsPerDay, paths: ["."], unit: "file",
});
const ledger = (starts: readonly string[], hold?: JanitorLedger["hold"]): JanitorLedger => ({
  ...EMPTY_JANITOR_LEDGER,
  starts,
  ...(hold === undefined ? {} : { hold }),
});

describe("pickJanitorTask (#205)", () => {
  const pick = (
    tasks: readonly JanitorTask[],
    ledgers: Record<string, JanitorLedger>,
    extra: { landLabelled?: readonly string[]; holdKeys?: Record<string, string> } = {},
  ): string | null => pickJanitorTask({
    tasks,
    ledgers: new Map(Object.entries(ledgers)),
    today: "2026-10-28",
    landLabelled: new Set(extra.landLabelled ?? []),
    holdKeys: new Map(Object.entries(extra.holdKeys ?? {})),
  })?.name ?? null;

  it("takes a never-started task first, then the oldest last start, then config order", () => {
    const tasks = [task("a"), task("b"), task("c")];
    expect(pick(tasks, {
      a: ledger(["2026-10-28T01:00:00.000Z"]),
      b: ledger([]),
      c: ledger([]),
    })).toBe("b");
    expect(pick(tasks, {
      a: ledger(["2026-10-28T03:00:00.000Z"]),
      b: ledger(["2026-10-28T01:00:00.000Z"]),
      c: ledger(["2026-10-28T02:00:00.000Z"]),
    })).toBe("b");
    expect(pick(tasks, { a: ledger([]), b: ledger([]), c: ledger([]) })).toBe("a");
  });

  it("counts only today's starts against runsPerDay", () => {
    const starts = ["2026-10-27T23:00:00.000Z", "2026-10-28T00:30:00.000Z"];
    expect(pick([task("a", 1)], { a: ledger(starts) })).toBeNull();
    expect(pick([task("a", 2)], { a: ledger(starts) })).toBe("a");
    expect(runsOnDay(ledger(starts), "2026-10-27")).toBe(1);
  });

  it("skips a task whose pull request carries land", () => {
    expect(pick([task("a"), task("b")], { a: ledger([]), b: ledger([]) }, { landLabelled: ["a"] })).toBe("b");
  });

  it("skips a held task until its key moves", () => {
    const hold = { kind: "conflict", key: janitorHoldKey("b1", "s1") } as const;
    const ledgers = { a: ledger([], hold) };
    expect(pick([task("a")], ledgers, { holdKeys: { a: janitorHoldKey("b1", "s1") } })).toBeNull();
    expect(pick([task("a")], ledgers, { holdKeys: { a: janitorHoldKey("b1", "s2") } })).toBe("a");
    expect(pick([task("a")], ledgers, { holdKeys: { a: janitorHoldKey(null, "s1") } })).toBe("a");
  });

  it("skips a task with no ledger read", () => {
    expect(pick([task("a")], {})).toBeNull();
  });
});

describe("pickScope (#205)", () => {
  const files = [
    { path: "src/b.ts", bytes: 400 },
    { path: "src/a.ts", bytes: 300 },
    { path: "README.md", bytes: 100 },
    { path: "empty.ts", bytes: 0 },
    { path: "huge.json", bytes: 200_001 },
  ];

  it("takes never-visited files first by path, then by oldest visit, up to the budget", () => {
    expect(pickScope({ files, unit: "file", visits: {}, budgetChars: 450 })).toEqual(["README.md", "src/a.ts"]);
    expect(pickScope({
      files,
      unit: "file",
      visits: { "README.md": "2026-10-02T00:00:00.000Z", "src/a.ts": "2026-10-01T00:00:00.000Z" },
      budgetChars: 10_000,
    })).toEqual(["src/b.ts", "src/a.ts", "README.md"]);
  });

  it("takes at least one file, even one over the budget", () => {
    expect(pickScope({ files, unit: "file", visits: {}, budgetChars: 10 })).toEqual(["README.md"]);
  });

  it("never offers an empty or oversized blob", () => {
    expect(pickScope({
      files: files.filter((f) => f.path === "empty.ts" || f.path === "huge.json"),
      unit: "file",
      visits: {},
      budgetChars: 1_000_000,
    })).toEqual([]);
  });

  it("takes the one least recently visited directory for the directory unit", () => {
    expect(pickScope({ files, unit: "directory", visits: {}, budgetChars: 1 })).toEqual(["."]);
    expect(pickScope({
      files, unit: "directory", visits: { ".": "2026-10-01T00:00:00.000Z" }, budgetChars: 1,
    })).toEqual(["src"]);
  });
});

describe("decideRollingBase (#205)", () => {
  const pr = (state: "OPEN" | "MERGED" | "CLOSED") => ({ number: 7, state, labels: [] });
  it.each([
    ["no origin branch", null, null, false, "fresh", ""],
    ["no pull request yet", "t1", null, false, "continue", "t1"],
    ["an open pull request", "t1", pr("OPEN"), false, "continue", "t1"],
    ["a merged pull request", "t1", pr("MERGED"), false, "fresh", "t1"],
    ["a closed pull request", "t1", pr("CLOSED"), false, "fresh", "t1"],
    ["a branch the source contains", "t1", pr("OPEN"), true, "fresh", "t1"],
    ["a contained branch with no pull request", "t1", null, true, "fresh", "t1"],
  ] as const)("%s", (_, originTip, latestPr, containedInSource, kind, lease) => {
    expect(decideRollingBase({ originTip, latestPr, containedInSource })).toEqual({ kind, lease });
  });
});

describe("janitorOutcome (#205)", () => {
  const gaps = { specGaps: [] };
  const sha = [{ sha: "c1" }];
  const reviewCut = { latestReviewerProse: "", failureTrace: "", budgetExhausted: null, strandedHead: null };
  const cases: readonly [Terminal, number, JanitorOutcome, string | undefined][] = [
    [{ type: "DONE", commits: sha, ...gaps }, 1, "committed", undefined],
    [{ type: "NEEDS-INFO", questions: "nothing", strandedHead: null, ...gaps }, 0, "no-change", undefined],
    [{ type: "NEEDS-INFO", questions: "q", strandedHead: null, ...gaps }, 2, "rejected", "NEEDS-INFO"],
    [{ type: "NEEDS-UI-PROTOTYPE", uiImpact: "x", commits: [], strandedHead: null, ...gaps }, 0, "rejected", "NEEDS-UI-PROTOTYPE"],
    [{ type: "NEEDS-HUMAN", cause: "gate-red", ...reviewCut, ...gaps } as Terminal, 1, "rejected", "NEEDS-HUMAN: gate-red"],
    [{ type: "NEEDS-HUMAN-REVIEW", cause: "correctness-budget-exhausted", latestReviewerProse: "", roundsUsed: 3, commits: sha, ...gaps }, 1, "rejected", "NEEDS-HUMAN-REVIEW: correctness-budget-exhausted"],
    [{ type: "NEEDS-PARTITION", cause: "measured", slot: "implementer" as never, size: 1, budget: 1, detail: "", commits: [], ...gaps }, 0, "rejected", "NEEDS-PARTITION: measured"],
    [{ type: "NEEDS-STACK-CHANGE", stackChange: {} as never, gate: {} as never, ...gaps }, 1, "rejected", "stack-change"],
    [{ type: "HARD-ERROR", reason: "boom", commits: [], ...gaps }, 0, "failed", "HARD-ERROR"],
    [{ type: "QUOTA", provider: "claude", window: "5h", ...gaps }, 0, "failed", "QUOTA"],
    [{ type: "CREDENTIAL", provider: "codex", detail: "", ...gaps }, 0, "failed", "CREDENTIAL"],
  ];
  it.each(cases)("maps %j", (terminal, commits, outcome, cause) => {
    expect(janitorOutcome(terminal, commits)).toEqual(cause === undefined ? { outcome } : { outcome, cause });
  });

  it("counts a visit only for a run that looked at its scope", () => {
    expect((["committed", "no-change", "rejected", "pre-empted", "failed"] as const).filter(visitCounts))
      .toEqual(["committed", "no-change", "rejected"]);
  });
});

describe("the task anchor and the pull request (#205)", () => {
  it("renders the scope, the source and the task name", () => {
    const anchor = renderTaskAnchor({
      task: "tidy",
      unit: "file",
      scope: ["src/a.ts", "README.md"],
      source: janitorSourceText("standards", "## Tests\n- rule", "main"),
    });
    expect(anchor).toContain("sandbar's idle task `tidy`");
    expect(anchor).toContain("- `src/a.ts`\n- `README.md`");
    expect(anchor).toContain("Find code in scope that breaks these project rules and fix it.\n\n## Tests\n- rule");
    expect(anchor).toContain("<promise>NEEDS-INFO</promise>");
  });

  it("names a directory scope and a file source", () => {
    const anchor = renderTaskAnchor({
      task: "docs",
      unit: "directory",
      scope: ["docs"],
      source: janitorSourceText({ skill: "arch" }, "Do X.", "main"),
    });
    expect(anchor).toContain("- `docs/`, the files directly in it");
    expect(anchor).toContain("From `.claude/skills/arch/SKILL.md` on `main`:\n\nDo X.");
  });

  it("titles the pull request after the task and names its source in one line", () => {
    expect(janitorPrContent("tidy", "standards")).toEqual({
      title: "Idle task: tidy",
      body: "Idle task `tidy`, applying the project standards flagged `{janitor}`.",
    });
    expect(janitorPrContent("docs", { file: "docs/j.md" }).body).toBe("Idle task `docs`, applying `docs/j.md`.");
    expect(janitorPrContent("arch", { skill: "arch" }).body).toBe("Idle task `arch`, applying the skill `arch`.");
  });

  it("says why a conflicted task is held and what releases it", () => {
    const comment = JANITOR_CONFLICT_PR_COMMENT({ branch: "sandbar/janitor-tidy", sourceBranch: "main" });
    expect(comment).toContain("sandbar/janitor-tidy no longer merges cleanly with main");
    expect(comment).toContain("close this pull request");
  });
});
