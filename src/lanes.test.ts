// #57 — lane computation as a table over (labels, defaultLane, blocked-by
// graph). Nothing here touches the planner or `gh`: the whole decision is a
// pure function of those three inputs, which is what makes the holding rule
// and the override notice testable without a tracker.
import { describe, expect, it } from "vitest";

import {
  AUTO_LAND_LABEL,
  DEFAULT_LANE,
  LANE_OVERRIDE_COMMENT,
  LANE_OVERRIDE_MARKER,
  type LaneIssue,
  computeLanes,
  laneOverrides,
  needsLaneOverrideNotice,
} from "./lanes.js";

const node = (
  number: number,
  blockedBy: number[] = [],
  labels: string[] = [],
): LaneIssue => ({ number, labels, blockedBy });

const auto = (number: number, blockedBy: number[] = []): LaneIssue =>
  node(number, blockedBy, [AUTO_LAND_LABEL]);

const laneOf = (
  issues: readonly LaneIssue[],
  defaultLane: "review" | "auto",
): Record<number, string> =>
  Object.fromEntries(
    [...computeLanes(issues, defaultLane)].map(([n, d]) => [n, d.lane]),
  );

describe("the default lane", () => {
  // The whole feature is opt-in, and this is the line that says so: a host
  // that sets nothing gets what sandbar did before lanes existed.
  it("is auto", () => {
    expect(DEFAULT_LANE).toBe("auto");
  });
});

describe("computeLanes", () => {
  it("routes an unlabelled issue to the host default", () => {
    expect(laneOf([node(1)], "auto")).toEqual({ 1: "auto" });
    expect(laneOf([node(1)], "review")).toEqual({ 1: "review" });
  });

  it("routes an `auto-land` issue to auto whatever the default", () => {
    expect(laneOf([auto(1)], "review")).toEqual({ 1: "auto" });
    expect(laneOf([auto(1)], "auto")).toEqual({ 1: "auto" });
  });

  it("ignores unrelated labels", () => {
    expect(laneOf([node(1, [], ["ready-for-agent", "waiting"])], "auto")).toEqual({
      1: "auto",
    });
  });

  it("is entirely inert under `defaultLane: auto` — nothing to inherit", () => {
    // No issue can declare review, so no edge can carry anything, whatever the
    // graph looks like.
    const graph = [node(1), auto(2, [1]), node(3, [2]), node(4, [3])];
    expect(laneOf(graph, "auto")).toEqual({ 1: "auto", 2: "auto", 3: "auto", 4: "auto" });
    expect(laneOverrides(computeLanes(graph, "auto"))).toEqual([]);
  });

  it("inherits review DOWNWARD across a blocked-by edge", () => {
    expect(laneOf([node(1), auto(2, [1])], "review")).toEqual({
      1: "review",
      2: "review",
    });
  });

  it("inherits transitively down a chain", () => {
    expect(laneOf([node(1), auto(2, [1]), auto(3, [2]), auto(4, [3])], "review")).toEqual(
      { 1: "review", 2: "review", 3: "review", 4: "review" },
    );
  });

  it("never inherits UPWARD — a blocker is unaffected by its dependents", () => {
    // #2 is review-gated and blocked by #1, which is labelled `auto-land`.
    // #1's commits are complete before #2 starts, so nothing about #2 can reach
    // back and gate #1 — a bidirectional walk would make #1 review here.
    expect(laneOf([auto(1), node(2, [1])], "review")).toEqual({
      1: "auto",
      2: "review",
    });
    // ...and nothing reports #1's lane as inherited, since nothing reached it.
    expect(
      computeLanes([auto(1), node(2, [1])], "review").get(1)?.inheritedFrom,
    ).toBe(null);
  });

  it("gates a dependent when ANY one of its blockers is review-gated", () => {
    expect(laneOf([auto(1), node(2), auto(3, [1, 2])], "review")).toEqual({
      1: "auto",
      2: "review",
      3: "review",
    });
  });

  it("leaves siblings of a gated issue alone", () => {
    expect(laneOf([node(1), auto(2, [1]), auto(3)], "review")).toEqual({
      1: "review",
      2: "review",
      3: "auto",
    });
  });

  it("contributes nothing for a blocker outside the input set", () => {
    // #99 is not a candidate — closed, or not on the queue. There is no lane to
    // read, so it gates nothing.
    expect(laneOf([auto(1, [99])], "auto")).toEqual({ 1: "auto" });
    expect(computeLanes([auto(1, [99])], "auto").has(99)).toBe(false);
  });

  it("terminates on a cycle in the blocked-by graph", () => {
    // Two issues naming each other. Deadlocked in the planner regardless
    // (neither blocker ever reads CLOSED), but it must not hang here.
    expect(laneOf([node(1, [2]), auto(2, [1])], "review")).toEqual({
      1: "review",
      2: "review",
    });
  });

  it("terminates on a cycle whose members are all auto-land", () => {
    expect(laneOf([auto(1, [2]), auto(2, [1])], "review")).toEqual({
      1: "auto",
      2: "auto",
    });
  });

  it("does not let an issue gate itself", () => {
    // A self-referencing `## Blocked by`. The lane is its own declaration, and
    // nothing reports it as inherited.
    const d = computeLanes([node(1, [1])], "review").get(1);
    expect(d?.lane).toBe("review");
    expect(d?.inheritedFrom).toBe(null);
  });

  it("names the DIRECT blocker as the source of inherited gating", () => {
    // Gating originates at #1 and reaches #3 through #2. #2 is what a human can
    // act on for #3.
    const d = computeLanes([node(1), auto(2, [1]), auto(3, [2])], "review").get(3);
    expect(d?.inheritedFrom).toBe(2);
  });

  it("keeps `declared` as what the issue asked for", () => {
    const d = computeLanes([node(1), auto(2, [1])], "review").get(2);
    expect(d?.declared).toBe("auto");
    expect(d?.lane).toBe("review");
  });
});

describe("laneOverrides", () => {
  it("reports an `auto-land` label that inheritance overrode", () => {
    expect(laneOverrides(computeLanes([node(1), auto(2, [1])], "review"))).toEqual([
      { issue: 2, gatedBy: 1 },
    ]);
  });

  it("reports nothing for an issue that never asked for auto", () => {
    expect(laneOverrides(computeLanes([node(1), node(2, [1])], "review"))).toEqual([]);
  });

  it("reports nothing for an `auto-land` issue that got what it asked for", () => {
    expect(laneOverrides(computeLanes([auto(1), auto(2, [1])], "review"))).toEqual([]);
  });

  it("reports every overridden issue in the chain, in issue order", () => {
    expect(
      laneOverrides(computeLanes([auto(9, [1]), node(1), auto(2, [1])], "review")),
    ).toEqual([
      { issue: 2, gatedBy: 1 },
      { issue: 9, gatedBy: 1 },
    ]);
  });
});

describe("the override notice", () => {
  it("names the blocker that carried the gating in", () => {
    expect(LANE_OVERRIDE_COMMENT(12)).toContain("#12");
    expect(LANE_OVERRIDE_COMMENT(12)).toContain(AUTO_LAND_LABEL);
  });

  it("carries the marker that keeps it to one per issue", () => {
    expect(LANE_OVERRIDE_COMMENT(12)).toContain(LANE_OVERRIDE_MARKER);
  });

  it("is needed when the issue has no comments at all", () => {
    expect(needsLaneOverrideNotice([])).toBe(true);
  });

  it("is needed when no existing comment carries the marker", () => {
    expect(needsLaneOverrideNotice(["**Sandbar:** something else", "a human"])).toBe(
      true,
    );
  });

  it("is not needed once one does — a held issue re-plans every cycle", () => {
    expect(needsLaneOverrideNotice([LANE_OVERRIDE_COMMENT(12)])).toBe(false);
  });

  it("recognises the marker whatever the prose around it says", () => {
    // Matching the marker rather than the wording is what lets the notice be
    // reworded without re-notifying every overridden issue on every queue.
    expect(needsLaneOverrideNotice([`old wording\n\n${LANE_OVERRIDE_MARKER}`])).toBe(
      false,
    );
  });
});
