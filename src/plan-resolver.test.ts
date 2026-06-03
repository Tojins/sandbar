import { describe, expect, it } from "vitest";
import {
  type IssueState,
  type IssueSummary,
  kebabSlug,
  parseBlockedBy,
  resolvePlan,
} from "./plan-resolver.js";

function issue(
  number: number,
  body: string,
  opts: { title?: string; labels?: string[] } = {},
): IssueSummary {
  return {
    number,
    title: opts.title ?? `Issue ${number}`,
    body,
    labels: opts.labels ?? [],
  };
}

const closed = (...ns: number[]): ReadonlyMap<number, IssueState> =>
  new Map(ns.map((n) => [n, "CLOSED"]));
const states = (
  o: Record<number, IssueState>,
): ReadonlyMap<number, IssueState> =>
  new Map(Object.entries(o).map(([n, s]) => [Number(n), s]));

describe("parseBlockedBy", () => {
  it("returns empty when no `## Blocked by` section is present", () => {
    expect(parseBlockedBy("# Foo\n## Acceptance\n")).toEqual([]);
  });

  it("returns empty when `## Blocked by` says None", () => {
    expect(parseBlockedBy("## Blocked by\n\nNone\n")).toEqual([]);
  });

  it("returns empty when `## Blocked by` says `None - can start immediately`", () => {
    expect(
      parseBlockedBy("## Blocked by\n\nNone - can start immediately\n"),
    ).toEqual([]);
  });

  it("extracts a single `#N` reference", () => {
    expect(parseBlockedBy("## Blocked by\n\n- #42\n")).toEqual([42]);
  });

  it("extracts multiple `#N` references in order", () => {
    expect(parseBlockedBy("## Blocked by\n\n- #1\n- #2\n- #100\n")).toEqual([
      1, 2, 100,
    ]);
  });

  it("dedupes repeated refs", () => {
    expect(parseBlockedBy("## Blocked by\n- #5\n- #5\n")).toEqual([5]);
  });

  it("stops at the next H2", () => {
    expect(
      parseBlockedBy("## Blocked by\n- #1\n## Acceptance criteria\n- #999\n"),
    ).toEqual([1]);
  });

  it("is case-insensitive on the header", () => {
    expect(parseBlockedBy("## blocked BY\n- #7\n")).toEqual([7]);
  });

  it("does not match `#N` inside other sections", () => {
    expect(parseBlockedBy("## Notes\nsee #99 for context\n")).toEqual([]);
  });

  it("ignores malformed `## Blocked by` lines without #N refs", () => {
    expect(parseBlockedBy("## Blocked by\n- some text\n")).toEqual([]);
  });
});

describe("kebabSlug", () => {
  it("lowercases ASCII", () => {
    expect(kebabSlug("Foo Bar")).toBe("foo-bar");
  });

  it("hyphenates non-alphanumeric runs", () => {
    expect(kebabSlug("Foo: bar's & baz!")).toBe("foo-bar-s-baz");
  });

  it("strips diacritics", () => {
    expect(kebabSlug("Café Münchën")).toBe("cafe-munchen");
  });

  it("trims leading/trailing hyphens", () => {
    expect(kebabSlug("  --foo--bar  ")).toBe("foo-bar");
  });

  it("collapses non-ASCII to a single hyphen", () => {
    expect(kebabSlug("foo→bar")).toBe("foo-bar");
  });
});

describe("resolvePlan", () => {
  it("includes issues with no `## Blocked by` section", () => {
    const plan = resolvePlan([issue(10, "# Just a body")], new Map());
    expect(plan.map((p) => p.id)).toEqual(["10"]);
  });

  it("includes issues whose blockers are all CLOSED", () => {
    const plan = resolvePlan(
      [issue(10, "## Blocked by\n- #1\n")],
      closed(1),
    );
    expect(plan.map((p) => p.id)).toEqual(["10"]);
  });

  it("excludes issues whose blocker is OPEN", () => {
    const plan = resolvePlan(
      [issue(10, "## Blocked by\n- #1\n")],
      states({ 1: "OPEN" }),
    );
    expect(plan).toEqual([]);
  });

  it("requires ALL blockers to be CLOSED", () => {
    const plan = resolvePlan(
      [issue(10, "## Blocked by\n- #1\n- #2\n")],
      states({ 1: "CLOSED", 2: "OPEN" }),
    );
    expect(plan).toEqual([]);
  });

  it("excludes `waiting`-labelled issues even when otherwise unblocked", () => {
    const plan = resolvePlan(
      [issue(10, "## Blocked by\nNone\n", { labels: ["waiting"] })],
      new Map(),
    );
    expect(plan).toEqual([]);
  });

  it("treats unknown blocker numbers as open (safe default)", () => {
    const plan = resolvePlan(
      [issue(10, "## Blocked by\n- #999\n")],
      new Map(),
    );
    expect(plan).toEqual([]);
  });

  it("sorts ascending by issue number", () => {
    const plan = resolvePlan(
      [
        issue(42, "## Blocked by\nNone\n"),
        issue(7, "## Blocked by\nNone\n"),
        issue(15, "## Blocked by\nNone\n"),
      ],
      new Map(),
    );
    expect(plan.map((p) => p.id)).toEqual(["7", "15", "42"]);
  });

  it("truncates to K=3 by default", () => {
    const plan = resolvePlan(
      [
        issue(1, ""),
        issue(2, ""),
        issue(3, ""),
        issue(4, ""),
        issue(5, ""),
      ],
      new Map(),
    );
    expect(plan.length).toBe(3);
    expect(plan.map((p) => p.id)).toEqual(["1", "2", "3"]);
  });

  it("respects a custom K", () => {
    const plan = resolvePlan(
      [issue(1, ""), issue(2, ""), issue(3, "")],
      new Map(),
      1,
    );
    expect(plan.length).toBe(1);
  });

  it("emits branch names in the documented format", () => {
    const plan = resolvePlan(
      [issue(42, "", { title: "Fix Auth Bug!" })],
      new Map(),
    );
    expect(plan[0]!.branch).toBe("sandbar/issue-42-fix-auth-bug");
  });

  it("table: mixed candidates → only the unblocked ones flow through", () => {
    const plan = resolvePlan(
      [
        issue(10, "## Blocked by\nNone\n"),
        issue(11, "## Blocked by\n- #5\n- #6\n"),
        issue(12, "## Blocked by\n- #7\n"),
        issue(13, "", { labels: ["waiting"] }),
        issue(2, ""),
      ],
      states({ 5: "CLOSED", 6: "CLOSED", 7: "OPEN" }),
    );
    expect(plan.map((p) => p.id)).toEqual(["2", "10", "11"]);
  });
});
