import { describe, expect, it } from "vitest";

import {
  type ChunkDerivation,
  type ChunkIssue,
  type ChunkTarget,
  NEEDS_REVIEW_LABEL,
  UNSETTLED,
  deriveChunks,
  landedChunksOf,
  rememberPollGraph,
  settledGraphFor,
} from "./chunks.js";
import { type Lane, computeLanes } from "./lanes.js";

// The graph is stated directly rather than built out of `## Blocked by` prose:
// `deriveChunks` takes parsed edges, exactly like `computeLanes`, and a body
// per fixture would only re-test `parseBlockedBy`.
function issue(
  number: number,
  blockedBy: readonly number[] = [],
  title = `Issue ${number}`,
): ChunkIssue {
  return { number, title, blockedBy };
}

function lanes(
  entries: Record<number, Lane>,
): ReadonlyMap<number, { readonly lane: Lane }> {
  return new Map(
    Object.entries(entries).map(([n, lane]) => [Number(n), { lane }]),
  );
}

// Every issue in the fixture review-gated — the common case once a host sets
// `defaultLane: "review"`, and the one the component shapes are about.
function allReview(issues: readonly ChunkIssue[]): ChunkDerivation {
  return deriveChunks(
    issues,
    lanes(Object.fromEntries(issues.map((i) => [i.number, "review" as Lane]))),
  );
}

const shape = (d: ChunkDerivation) =>
  d.chunks.map((c) => ({ root: c.root, members: c.members }));

describe("deriveChunks — components", () => {
  it("makes an unchained review-gated issue a singleton chunk", () => {
    const d = allReview([issue(10), issue(20)]);
    expect(shape(d)).toEqual([
      { root: 10, members: [10] },
      { root: 20, members: [20] },
    ]);
  });

  it("puts a blocked-by chain in one chunk, rooted at the base", () => {
    const d = allReview([issue(10), issue(11, [10]), issue(12, [11])]);
    expect(shape(d)).toEqual([{ root: 10, members: [10, 11, 12] }]);
    expect(d.blocked).toEqual([]);
  });

  // The root is the parentless member, not the lowest-numbered one: a chain
  // filed out of order still names the branch after the issue everything else
  // is built on.
  it("roots at the parentless member even when it is not the lowest", () => {
    const d = allReview([issue(10, [30]), issue(20, [10]), issue(30)]);
    expect(shape(d)).toEqual([{ root: 30, members: [10, 20, 30] }]);
  });

  it("keeps a fan-out under one root", () => {
    const d = allReview([issue(10), issue(11, [10]), issue(12, [10])]);
    expect(shape(d)).toEqual([{ root: 10, members: [10, 11, 12] }]);
  });

  it("ignores a blocker outside the input set", () => {
    // #9 is not a candidate, so there is no lane to read and nothing to share
    // a branch with — same argument lanes.ts makes for propagation.
    const d = allReview([issue(10, [9])]);
    expect(shape(d)).toEqual([{ root: 10, members: [10] }]);
  });

  it("drops a self-edge rather than deadlocking on it", () => {
    const d = allReview([issue(10, [10])]);
    expect(shape(d)).toEqual([{ root: 10, members: [10] }]);
    expect(d.blocked).toEqual([]);
  });

  it("dedupes a blocker named twice", () => {
    const d = allReview([issue(10), issue(11, [10, 10])]);
    expect(shape(d)).toEqual([{ root: 10, members: [10, 11] }]);
  });

  it("maps every member to its root through chunkOf, and nothing else", () => {
    const d = allReview([issue(10), issue(11, [10]), issue(20)]);
    expect([...d.chunkOf.entries()].sort()).toEqual([
      [10, 10],
      [11, 10],
      [20, 20],
    ]);
  });
});

describe("deriveChunks — the lane is the input", () => {
  it("leaves auto-lane issues out of every chunk", () => {
    const d = deriveChunks(
      [issue(10), issue(11, [10])],
      lanes({ 10: "auto", 11: "auto" }),
    );
    expect(d.chunks).toEqual([]);
    expect(d.chunkOf.size).toBe(0);
    expect(d.blocked).toEqual([]);
  });

  // An auto-lane blocker lands on the source branch through the merger, so by
  // the time the dependent is worked there is nothing left to share a branch
  // with. It is an edge for LANES and not an edge for CHUNKS.
  it("does not join two review-gated issues through an auto-lane blocker", () => {
    const d = deriveChunks(
      [issue(10), issue(11, [10]), issue(12, [10])],
      lanes({ 10: "auto", 11: "review", 12: "review" }),
    );
    expect(shape(d)).toEqual([
      { root: 11, members: [11] },
      { root: 12, members: [12] },
    ]);
  });

  it("treats an issue with no lane at all as not review-gated", () => {
    const d = deriveChunks([issue(10), issue(11, [10])], lanes({ 11: "review" }));
    expect(shape(d)).toEqual([{ root: 11, members: [11] }]);
  });

  // #57's inheritance is already in the map by the time this module reads it,
  // so a chunk needs no second opinion about which issues are gated: everything
  // downstream of a review-gated issue is gated, hence in its chunk.
  it("accepts a computeLanes result as-is, inheritance included", () => {
    const graph = [
      { number: 10, labels: [], blockedBy: [] },
      { number: 11, labels: ["auto-land"], blockedBy: [10] },
      { number: 12, labels: ["auto-land"], blockedBy: [] },
    ];
    const decisions = computeLanes(graph, "review");
    const d = deriveChunks(
      graph.map((g) => issue(g.number, g.blockedBy)),
      decisions,
    );
    // #11's `auto-land` lost to inheritance, so it is in #10's chunk; #12's
    // label held, so it is in no chunk at all.
    expect(shape(d)).toEqual([{ root: 10, members: [10, 11] }]);
  });
});

describe("deriveChunks — several roots, one chunk (#193)", () => {
  it("joins two roots through their common dependent", () => {
    const d = allReview([issue(10), issue(20), issue(30, [10, 20])]);
    expect(shape(d)).toEqual([{ root: 10, members: [10, 20, 30] }]);
    expect(d.chunks[0]?.parentless).toEqual([10, 20]);
    expect(d.blocked).toEqual([]);
  });

  // The series the issue was filed for (Tojins/outdoor): #751 → #752, plus
  // #753 and #754, all blocking #677. One chunk, one review, rooted at the
  // lowest parentless member, with three roots to work in parallel.
  it("chunks a filed series with several roots as one", () => {
    const d = allReview([
      issue(677, [752, 753, 754]),
      issue(751),
      issue(752, [751]),
      issue(753),
      issue(754),
    ]);
    expect(shape(d)).toEqual([
      { root: 751, members: [677, 751, 752, 753, 754] },
    ]);
    expect(d.chunks[0]?.parentless).toEqual([751, 753, 754]);
  });

  it("does not block an issue whose blockers are all in ONE chunk", () => {
    const d = allReview([
      issue(10),
      issue(11, [10]),
      issue(12, [10]),
      issue(13, [11, 12]),
    ]);
    expect(shape(d)).toEqual([{ root: 10, members: [10, 11, 12, 13] }]);
    expect(d.chunks[0]?.parentless).toEqual([10]);
    expect(d.blocked).toEqual([]);
  });

  it("takes both straddlers over the same pair into one chunk", () => {
    const d = allReview([issue(1), issue(2), issue(3, [1, 2]), issue(4, [1, 2])]);
    expect(shape(d)).toEqual([{ root: 1, members: [1, 2, 3, 4] }]);
  });

  it("waits for a blocker's own chunk before judging the dependent", () => {
    const d = allReview([issue(1, [9]), issue(2, [9]), issue(3, [1, 2]), issue(9)]);
    expect(shape(d)).toEqual([{ root: 9, members: [1, 2, 3, 9] }]);
    expect(d.blocked).toEqual([]);
  });
});

// Underway state, stated directly: a landed member is a member ref on an
// origin chunk branch, an in-flight one carries the target it was sent with.
const on = (
  entries: Record<string, readonly number[]>,
): ReadonlyMap<string, ReadonlySet<number>> =>
  new Map(Object.entries(entries).map(([b, ms]) => [b, new Set(ms)]));
const flying = (
  entries: Record<number, ChunkTarget>,
): ReadonlyMap<number, ChunkTarget> =>
  new Map(Object.entries(entries).map(([n, t]) => [Number(n), t]));
const gatedLanes = (issues: readonly ChunkIssue[]) =>
  lanes(Object.fromEntries(issues.map((i) => [i.number, "review" as Lane])));
const underway = (
  issues: readonly ChunkIssue[],
  options: Parameters<typeof deriveChunks>[2],
): ChunkDerivation => deriveChunks(issues, gatedLanes(issues), options);

describe("deriveChunks — join, never merge (#193)", () => {
  it("holds an issue that would join two underway chunks", () => {
    const d = underway(
      [issue(10), issue(20), issue(30, [10, 20])],
      { originChunks: on({ "sandbar/chunk-10-a": [10], "sandbar/chunk-20-b": [20] }) },
    );
    // No merging: #10 and #20 stay two chunks and #30 joins neither.
    expect(shape(d)).toEqual([
      { root: 10, members: [10] },
      { root: 20, members: [20] },
    ]);
    expect(d.blocked).toEqual([
      { issue: 30, reason: "joins-two-chunks", blockers: [10, 20] },
    ]);
    expect(d.chunkOf.has(30)).toBe(false);
  });

  it("counts an in-flight member as underway, under its dispatched target", () => {
    const d = underway(
      [issue(10), issue(20), issue(30, [10, 20])],
      {
        originChunks: on({ "sandbar/chunk-10-a": [10] }),
        inFlight: flying({ 20: { root: 20, branch: "sandbar/chunk-20-b" } }),
      },
    );
    expect(d.chunks.map((c) => [c.root, c.branch, c.members])).toEqual([
      [10, "sandbar/chunk-10-a", [10]],
      [20, "sandbar/chunk-20-b", [20]],
    ]);
    expect(d.blocked.map((b) => [b.issue, b.reason])).toEqual([
      [30, "joins-two-chunks"],
    ]);
  });

  it("joins a fresh component to the one underway chunk it connects to", () => {
    // #10 has landed; #20 and #30 are new, connected to it only through #30.
    const d = underway(
      [issue(10), issue(20), issue(30, [10, 20])],
      { originChunks: on({ "sandbar/chunk-10-a": [10] }), settledGraph: null },
    );
    // Joining needs no settling: the graph has not held still, yet #20 and
    // #30 are already #10's.
    expect(d.chunks).toEqual([{
      root: 10,
      members: [10, 20, 30],
      parentless: [10, 20],
      branch: "sandbar/chunk-10-a",
      base: null,
    }]);
    expect(d.blocked).toEqual([]);
  });

  it("blocks what depends on a held issue, transitively", () => {
    const d = underway(
      [issue(10), issue(20), issue(30, [10, 20]), issue(40, [30]), issue(50, [40])],
      { originChunks: on({ "sandbar/chunk-10-a": [10], "sandbar/chunk-20-b": [20] }) },
    );
    expect(d.blocked).toEqual([
      { issue: 30, reason: "joins-two-chunks", blockers: [10, 20] },
      { issue: 40, reason: "unchunked-blocker", blockers: [30] },
      { issue: 50, reason: "unchunked-blocker", blockers: [40] },
    ]);
  });

  it("reports the unchunked blocker even alongside a placed one", () => {
    const d = underway(
      [issue(10), issue(20), issue(30, [10, 20]), issue(40, [10, 30])],
      { originChunks: on({ "sandbar/chunk-10-a": [10], "sandbar/chunk-20-b": [20] }) },
    );
    expect(d.blocked).toEqual([
      { issue: 30, reason: "joins-two-chunks", blockers: [10, 20] },
      { issue: 40, reason: "unchunked-blocker", blockers: [30] },
    ]);
  });

  // A bridge filed between two underway series must not stall either: the
  // chained members already in each chunk stay there, and only the bridge
  // waits.
  it("leaves both underway chunks whole when a bridge is filed between them", () => {
    const d = underway(
      [issue(1), issue(2, [1]), issue(5), issue(6, [5]), issue(9, [2, 6])],
      { originChunks: on({ "sandbar/chunk-1-a": [1], "sandbar/chunk-5-b": [5] }) },
    );
    expect(shape(d)).toEqual([
      { root: 1, members: [1, 2] },
      { root: 5, members: [5, 6] },
    ]);
    expect(d.blocked.map((b) => [b.issue, b.reason])).toEqual([
      [9, "joins-two-chunks"],
    ]);
  });

  it("gives a chunk's root back to the chunk it names", () => {
    // #753 landed on #751's branch while #751 itself was parked; nothing in
    // the graph connects them any more, but #751 still belongs to its chunk.
    const d = underway(
      [issue(751), issue(753)],
      { originChunks: on({ "sandbar/chunk-751-a": [753] }), settledGraph: null },
    );
    expect(d.chunks).toEqual([{
      root: 751,
      members: [751, 753],
      parentless: [751, 753],
      branch: "sandbar/chunk-751-a",
      base: null,
    }]);
  });

  it("keeps an underway member in its chunk even inside a cycle", () => {
    const d = underway(
      [issue(10, [11]), issue(11, [10])],
      { originChunks: on({ "sandbar/chunk-10-a": [10] }) },
    );
    expect(shape(d)).toEqual([{ root: 10, members: [10] }]);
    expect(d.blocked).toEqual([{ issue: 11, reason: "cycle", blockers: [10] }]);
  });
});

describe("deriveChunks — stable identity (#193)", () => {
  // The design's own example of what must not happen: a lower-numbered root
  // joining later renames nothing.
  it("never renames an underway chunk when a lower root joins", () => {
    const d = underway(
      [issue(40), issue(47, [40]), issue(48, [47])],
      { originChunks: on({ "sandbar/chunk-47-root": [47] }) },
    );
    expect(d.chunks.map((c) => [c.root, c.branch, c.members, c.parentless])).toEqual([
      [47, "sandbar/chunk-47-root", [40, 47, 48], [40]],
    ]);
  });

  it("keeps the in-flight target's root and branch before the first landing", () => {
    // #753 was dispatched as #753's chunk; #751 is filed and joins later.
    const d = underway(
      [issue(677, [751, 753]), issue(751, [], "Renamed"), issue(753)],
      { inFlight: flying({ 753: { root: 753, branch: "sandbar/chunk-753-old" } }) },
    );
    expect(d.chunks.map((c) => [c.root, c.branch, c.members])).toEqual([
      [753, "sandbar/chunk-753-old", [677, 751, 753]],
    ]);
  });

  it("keeps the identity of a branch whose root issue has left the graph", () => {
    const d = underway(
      [issue(753), issue(677, [753])],
      { originChunks: on({ "sandbar/chunk-751-first": [753] }) },
    );
    expect(d.chunks.map((c) => [c.root, c.branch, c.members])).toEqual([
      [751, "sandbar/chunk-751-first", [677, 753]],
    ]);
  });

  // A member ref inherited through the source branch sits on a later chunk's
  // branch too. The member answers to the root it is connected to.
  it("assigns an inherited member ref to the chunk its root is connected to", () => {
    const d = underway(
      [issue(10), issue(11, [10]), issue(20)],
      {
        originChunks: on({
          "sandbar/chunk-10-a": [10, 11],
          "sandbar/chunk-20-b": [10, 11, 20],
        }),
      },
    );
    expect(shape(d)).toEqual([
      { root: 10, members: [10, 11] },
      { root: 20, members: [20] },
    ]);
  });

  // #193, item 7: closeOrder is unchanged for a multi-root chunk — every
  // dependent before its blockers, every other root before the identity
  // root. The partial-close table is in plan-resolver.test.ts, where the
  // CLOSED facts are an input.
  it("closes a multi-root chunk dependents first and its identity root last", () => {
    const branch = "sandbar/chunk-751-series";
    const series = [
      issue(677, [752, 753, 754]),
      issue(751),
      issue(752, [751]),
      issue(753),
      issue(754),
    ];
    const all = new Set([677, 751, 752, 753, 754]);
    const d = underway(series, { originChunks: on({ [branch]: [...all] }) });
    const [landed] = landedChunksOf(d.chunks, series, all);
    expect(landed?.closeOrder.map((m) => m.number)).toEqual([
      677, 754, 753, 752, 751,
    ]);
  });
});

describe("deriveChunks — frozen chunks stack, never join (#243)", () => {
  const F = "sandbar/chunk-10-a";
  const frozenF = { originChunks: on({ [F]: [10, 11] }), frozen: new Set([F]) };

  it("stacks a new issue blocked by a frozen chunk's member on that chunk", () => {
    const d = underway([issue(10), issue(11, [10]), issue(50, [11], "Fix")], frozenF);
    expect(d.chunks).toEqual([
      { root: 10, members: [10, 11], parentless: [10], branch: F, base: null },
      {
        root: 50,
        members: [50],
        parentless: [50],
        branch: "sandbar/chunk-50_on_10-fix",
        base: F,
      },
    ]);
    expect(d.blocked).toEqual([]);
  });

  it("joins the same issue to the chunk once nothing freezes it", () => {
    const d = underway(
      [issue(10), issue(11, [10]), issue(50, [11])],
      { originChunks: on({ [F]: [10, 11] }) },
    );
    expect(shape(d)).toEqual([{ root: 10, members: [10, 11, 50] }]);
  });

  it("stacks the frozen chunk's own queued members, and keeps its in-flight ones", () => {
    const d = underway(
      [issue(10), issue(11, [10]), issue(12, [10]), issue(13, [12])],
      {
        originChunks: on({ [F]: [10] }),
        inFlight: flying({ 11: { root: 10, branch: F } }),
        frozen: new Set([F]),
      },
    );
    expect(d.chunks.map((c) => [c.root, c.members, c.branch, c.base])).toEqual([
      [10, [10, 11], F, null],
      [12, [12, 13], "sandbar/chunk-12_on_10-issue-12", F],
    ]);
  });

  it("holds the root a frozen chunk is named after while it is not on the branch", () => {
    // #11, another root of the chunk, landed before #10 did.
    const d = underway([issue(10), issue(11)], {
      originChunks: on({ [F]: [11] }),
      frozen: new Set([F]),
    });
    expect(shape(d)).toEqual([{ root: 10, members: [11] }]);
    expect(d.blocked).toEqual([{ issue: 10, reason: "frozen", blockers: [10] }]);
  });

  it("does not pull a fresh blocker group into a frozen chunk", () => {
    const d = underway([issue(5), issue(10), issue(11, [10, 5])], frozenF);
    expect(d.chunks.map((c) => [c.root, c.members, c.base])).toEqual([
      [5, [5], null],
      [10, [10, 11], null],
    ]);
  });

  it("answers a member a stacked branch contains to the base", () => {
    // Root #5 is lower than its base's #10, so "lowest" alone would hand
    // #10 and #11 to the stacked chunk.
    const C = "sandbar/chunk-5_on_10-c";
    const d = underway(
      [issue(5, [11]), issue(10), issue(11, [10])],
      { originChunks: on({ [F]: [10, 11], [C]: [5, 10, 11] }), frozen: new Set([F]) },
    );
    expect(d.chunks.map((c) => [c.root, c.members, c.branch, c.base])).toEqual([
      [5, [5], C, F],
      [10, [10, 11], F, null],
    ]);
  });

  it("joins an issue blocked by a stacked chunk and its base to the stacked one, frozen or not", () => {
    const C = "sandbar/chunk-50_on_10-c";
    const issues = [issue(10), issue(11, [10]), issue(50, [11]), issue(60, [11, 50])];
    const originChunks = on({ [F]: [10, 11], [C]: [10, 11, 50] });
    for (const frozen of [new Set([F]), new Set<string>()]) {
      const d = underway(issues, { originChunks, frozen });
      expect(shape(d)).toEqual([
        { root: 10, members: [10, 11] },
        { root: 50, members: [50, 60] },
      ]);
    }
  });

  it("stacks on a frozen stacked chunk, not on its base", () => {
    const C = "sandbar/chunk-50_on_10-c";
    const d = underway(
      [issue(10), issue(11, [10]), issue(50, [11]), issue(60, [11, 50])],
      { originChunks: on({ [F]: [10, 11], [C]: [10, 11, 50] }), frozen: new Set([F, C]) },
    );
    expect(d.chunks.map((c) => [c.root, c.members, c.branch])).toEqual([
      [10, [10, 11], F],
      [50, [50], C],
      [60, [60], "sandbar/chunk-60_on_50-issue-60"],
    ]);
  });

  it("drops the base once it has landed and left origin", () => {
    const C = "sandbar/chunk-50_on_10-c";
    const d = underway([issue(50), issue(60, [50])], { originChunks: on({ [C]: [50] }) });
    expect(d.chunks).toEqual([
      { root: 50, members: [50, 60], parentless: [50], branch: C, base: null },
    ]);
  });

  it("holds an issue blocked by two frozen chunks it cannot stack on together", () => {
    const G = "sandbar/chunk-20-b";
    const d = underway(
      [issue(10), issue(20), issue(30, [10, 20])],
      { originChunks: on({ [F]: [10], [G]: [20] }), frozen: new Set([F, G]) },
    );
    expect(d.blocked).toEqual([
      { issue: 30, reason: "joins-two-chunks", blockers: [10, 20] },
    ]);
  });
});

describe("deriveChunks — settling (#193)", () => {
  it("holds a fresh component until the pending graph is settled", () => {
    const issues = [issue(753), issue(754), issue(677, [753, 754])];
    const first = underway(issues, { settledGraph: null });
    expect(first.chunks).toEqual([]);
    expect(first.blocked).toEqual([
      { issue: 677, reason: "unsettled", blockers: [] },
      { issue: 753, reason: "unsettled", blockers: [] },
      { issue: 754, reason: "unsettled", blockers: [] },
    ]);
    const second = underway(issues, { settledGraph: first.pendingGraph });
    expect(shape(second)).toEqual([{ root: 753, members: [677, 753, 754] }]);
    expect(second.blocked).toEqual([]);
  });

  it("does not settle a graph that changed since the previous poll", () => {
    const early = underway([issue(753), issue(754)], { settledGraph: null });
    const later = underway(
      [issue(753), issue(754), issue(677, [753, 754])],
      { settledGraph: early.pendingGraph },
    );
    expect(later.chunks).toEqual([]);
    expect(later.pendingGraph).not.toBe(early.pendingGraph);
  });

  it("states the pending graph canonically, ignoring underway chunks", () => {
    const one = underway(
      [issue(1), issue(2, [1]), issue(7), issue(8, [7])],
      { originChunks: on({ "sandbar/chunk-7-x": [7] }) },
    );
    const two = underway(
      [issue(8, [7]), issue(2, [1]), issue(1), issue(7)],
      { originChunks: on({ "sandbar/chunk-7-x": [7, 8] }) },
    );
    expect(one.pendingGraph).toBe("1 2<1");
    expect(two.pendingGraph).toBe(one.pendingGraph);
  });

  it("ignores issues that became underway since the previous poll", () => {
    // Both series were pending at the previous poll; #1's has started since.
    // #5's is unchanged, so it settles without waiting another poll.
    const issues = [issue(1), issue(2, [1]), issue(5), issue(6, [5])];
    const previous = underway(issues, { settledGraph: null }).pendingGraph;
    expect(previous).toBe("1 2<1 5 6<5");
    const d = underway(issues, {
      settledGraph: previous,
      inFlight: flying({ 1: { root: 1, branch: "sandbar/chunk-1-issue-1" } }),
    });
    expect(shape(d)).toEqual([
      { root: 1, members: [1, 2] },
      { root: 5, members: [5, 6] },
    ]);
  });

  it("leaves the gate open when no settled graph is given at all", () => {
    expect(shape(allReview([issue(1)]))).toEqual([{ root: 1, members: [1] }]);
  });
});

describe("chunk settle memory (#193)", () => {
  it("settles only on two consecutive polls that agree", () => {
    let memory = UNSETTLED;
    expect(settledGraphFor(memory, true)).toBeNull();
    memory = rememberPollGraph(memory, "1 2<1");
    // The next poll compares against it; a recompute between polls does not.
    expect(settledGraphFor(memory, true)).toBe("1 2<1");
    expect(settledGraphFor(memory, false)).toBeNull();
    memory = rememberPollGraph(memory, "1 2<1");
    expect(settledGraphFor(memory, false)).toBe("1 2<1");
    memory = rememberPollGraph(memory, "1 2<1 3");
    expect(settledGraphFor(memory, false)).toBeNull();
    expect(settledGraphFor(memory, true)).toBe("1 2<1 3");
  });
});

describe("deriveChunks — hostile input", () => {
  it("terminates on a cycle and blocks its members", () => {
    const d = allReview([issue(10, [11]), issue(11, [10])]);
    expect(d.chunks).toEqual([]);
    expect(d.blocked).toEqual([
      { issue: 10, reason: "cycle", blockers: [11] },
      { issue: 11, reason: "cycle", blockers: [10] },
    ]);
  });

  it("blocks what hangs off a cycle without disturbing unrelated chunks", () => {
    const d = allReview([
      issue(1),
      issue(2, [1]),
      issue(10, [11]),
      issue(11, [10]),
      issue(12, [10]),
    ]);
    expect(shape(d)).toEqual([{ root: 1, members: [1, 2] }]);
    expect(d.blocked.map((b) => [b.issue, b.reason])).toEqual([
      [10, "cycle"],
      [11, "cycle"],
      [12, "cycle"],
    ]);
  });

  it("returns empty for an empty candidate list", () => {
    const d = deriveChunks([], new Map());
    expect(d).toEqual({ chunks: [], chunkOf: new Map(), blocked: [], pendingGraph: "" });
  });
});

describe("deriveChunks — branch naming", () => {
  it("names the branch after the root issue, not the lowest member", () => {
    const d = allReview([
      issue(10, [30], "Downstream work"),
      issue(30, [], "Chunk derivation"),
    ]);
    expect(d.chunks.map((c) => c.branch)).toEqual([
      "sandbar/chunk-30-chunk-derivation",
    ]);
  });

  it("gives a singleton chunk a chunk branch, not an issue branch", () => {
    const d = allReview([issue(58, [], "Chunk derivation")]);
    expect(d.chunks[0]?.branch).toBe("sandbar/chunk-58-chunk-derivation");
  });
});

describe("deriveChunks — determinism", () => {
  it("is independent of the order the candidates arrive in", () => {
    const issues = [
      issue(1),
      issue(2, [1]),
      issue(3),
      issue(4, [2, 3]),
      issue(5, [4]),
    ];
    const forward = allReview(issues);
    const reversed = allReview([...issues].reverse());
    expect(shape(reversed)).toEqual(shape(forward));
    expect(reversed.blocked).toEqual(forward.blocked);
    expect(reversed.chunks.map((c) => c.branch)).toEqual(
      forward.chunks.map((c) => c.branch),
    );
  });

  it("orders chunks by root and members ascending", () => {
    const d = allReview([issue(30), issue(31, [30]), issue(10), issue(11, [10])]);
    expect(d.chunks.map((c) => c.root)).toEqual([10, 30]);
    expect(d.chunks.map((c) => c.members)).toEqual([
      [10, 11],
      [30, 31],
    ]);
  });
});

// #59 — the spelling is protocol: a later issue writes this label onto the
// tracker and `plan-resolver.ts` reads it back, so a typo on either side is a
// chunk that never advances rather than a failure anyone sees.
describe("NEEDS_REVIEW_LABEL (#93)", () => {
  it("is spelled `needs-review`", () => {
    expect(NEEDS_REVIEW_LABEL).toBe("needs-review");
  });
});

// #63, #64 — what a chunk with work on origin looks like to the two phases
// that act on the whole chunk. `tips` is what the review scan is after: it is
// what a follow-up issue declares under `## Blocked by`, so it decides both
// which chunk that issue joins and whether it waits for the work its review is
// about. `members` is what a LANDING is after, and it is the sharper of the
// two — that list is CLOSED when the chunk lands.
describe("landedChunksOf (#63, #64)", () => {
  const chain = allReview([
    issue(42, [], "First"),
    issue(43, [42], "Second"),
    issue(44, [43], "Third"),
  ]);

  it("omits a chunk with nothing landed", () => {
    // No branch on origin, no pull request, and nothing to be blocked by.
    expect(landedChunksOf(chain.chunks, [], new Set())).toEqual([]);
  });

  it("names the chunk, its branch, what it carries, and the deepest of that", () => {
    // #44 is a member of the chunk and has landed nothing, so it is in neither
    // list: what a landing closes (#64) is what is ON the branch, never the
    // whole component.
    const issues = [issue(42, [], "First"), issue(43, [42], "Second"), issue(44, [43], "Third")];
    expect(landedChunksOf(chain.chunks, issues, new Set([42, 43]))).toEqual([
      {
        root: 42,
        branch: "sandbar/chunk-42-first",
        base: null,
        title: "First",
        members: [
          { number: 42, title: "First" },
          { number: 43, title: "Second" },
        ],
        closeOrder: [
          { number: 43, title: "Second" },
          { number: 42, title: "First" },
        ],
        rework: [],
        tips: [{ number: 43, title: "Second" }],
      },
    ]);
  });

  it("names the chunk after its ROOT even when the root has not landed", () => {
    // The branch is `chunkBranchName(root, title)` whatever has landed on it,
    // and the landing's merge commit and prose have to name the same chunk the
    // branch does.
    const issues = [issue(42, [], "First"), issue(43, [42], "Second")];
    const landed = landedChunksOf(allReview(issues).chunks, issues, new Set([43]));
    expect(landed[0]?.title).toBe("First");
    expect(landed[0]?.members).toEqual([{ number: 43, title: "Second" }]);
  });

  it("reports every tip when the branch carries siblings", () => {
    // A chunk grows one LAYER per cycle, so two members landing together is
    // the normal case — and a follow-up must sit behind both.
    const issues = [issue(42, [], "First"), issue(43, [42], "A"), issue(44, [42], "B")];
    const d = allReview(issues);
    expect(landedChunksOf(d.chunks, issues, new Set([42, 43, 44]))[0]?.tips).toEqual([
      { number: 43, title: "A" },
      { number: 44, title: "B" },
    ]);
  });

  it("ignores a blocker that has not landed", () => {
    // #44 is blocked by #43, which is still queued: nothing of #43 is on the
    // branch, so #42 is still what the branch ends at. (#44 landing before its
    // own blocker cannot happen; the fixture only pins the rule.)
    const issues = [issue(42, [], "First"), issue(43, [42], "Second"), issue(44, [43], "Third")];
    expect(landedChunksOf(chain.chunks, issues, new Set([42]))[0]?.tips).toEqual([
      { number: 42, title: "First" },
    ]);
  });

  it("names a member the issue list has lost, rather than dropping it", () => {
    // The number is the part `## Blocked by` acts on; an absent title costs a
    // line of prose, an absent member would cost the edge.
    expect(landedChunksOf(chain.chunks, [], new Set([42]))[0]?.tips).toEqual([
      { number: 42, title: "" },
    ]);
  });

  // #64 — the order a LANDING may close these in, which is the same graph read
  // the other way. It exists because a close that fails keeps the branch, and
  // the next cycle finds that branch only if the chunk still derives to the
  // same NAME — which it does only while the root is open.
  it("orders the closes dependents-first, so the root is last", () => {
    const issues = [issue(42, [], "First"), issue(43, [42], "Second"), issue(44, [43], "Third")];
    expect(
      landedChunksOf(chain.chunks, issues, new Set([42, 43, 44]))[0]?.closeOrder,
    ).toEqual([
      { number: 44, title: "Third" },
      { number: 43, title: "Second" },
      { number: 42, title: "First" },
    ]);
  });

  it("orders siblings among themselves, ascending, and still ends at the root", () => {
    // A layer of two (#61 plans a whole layer): neither is behind the other,
    // so only their place BEFORE the root is fixed.
    const issues = [issue(42, [], "First"), issue(44, [42], "B"), issue(43, [42], "A")];
    expect(
      landedChunksOf(allReview(issues).chunks, issues, new Set([42, 43, 44]))[0]
        ?.closeOrder,
    ).toEqual([
      { number: 44, title: "B" },
      { number: 43, title: "A" },
      { number: 42, title: "First" },
    ]);
  });

  it("ignores an edge to a member that has not landed", () => {
    // #43 is queued, so nothing of it is on the branch: #44 is behind #42 as
    // far as this branch is concerned, whatever its body says.
    const issues = [issue(42, [], "First"), issue(43, [42], "Second"), issue(44, [43], "Third")];
    expect(
      landedChunksOf(chain.chunks, issues, new Set([42, 44]))[0]?.closeOrder,
    ).toEqual([
      { number: 44, title: "Third" },
      { number: 42, title: "First" },
    ]);
  });

  it("never drops a member from the close order, cycle or not", () => {
    // Unreachable for the same reason the tips fallback is — a cyclic issue is
    // `blocked` and never a chunk member — and total anyway: a member missing
    // from this list is a member the wrap-up never closes at all.
    const cyclic = [issue(42, [43], "First"), issue(43, [42], "Second")];
    const chunk = {
      root: 42,
      members: [42, 43],
      branch: "sandbar/chunk-42-first",
    };
    expect(
      landedChunksOf([chunk], cyclic, new Set([42, 43]))[0]?.closeOrder,
    ).toEqual([
      { number: 42, title: "First" },
      { number: 43, title: "Second" },
    ]);
  });

  it("never reports an empty tip list", () => {
    // Unreachable — the edge set is a DAG — and defended anyway: an issue with
    // an empty `## Blocked by` section is the root of a chunk of its own, on a
    // branch of its own, answering a review nobody is looking at.
    const cyclic = [issue(42, [43], "First"), issue(43, [42], "Second")];
    const chunk = {
      root: 42,
      members: [42, 43],
      branch: "sandbar/chunk-42-first",
    };
    expect(landedChunksOf([chunk], cyclic, new Set([42, 43]))[0]?.tips).toEqual([
      { number: 42, title: "First" },
      { number: 43, title: "Second" },
    ]);
  });
});
