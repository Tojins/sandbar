import { describe, expect, it } from "vitest";

import {
  type ChunkDerivation,
  type ChunkIssue,
  IN_CHUNK_LABEL,
  deriveChunks,
  landedChunksOf,
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

describe("deriveChunks — the two-chunk-parent rule", () => {
  it("blocks an issue whose blockers sit in two different chunks", () => {
    const d = allReview([issue(10), issue(20), issue(30, [10, 20])]);
    // No merging: #10 and #20 stay two chunks and #30 joins neither.
    expect(shape(d)).toEqual([
      { root: 10, members: [10] },
      { root: 20, members: [20] },
    ]);
    expect(d.blocked).toEqual([
      { issue: 30, reason: "two-chunk-parent", blockers: [10, 20] },
    ]);
    expect(d.chunkOf.has(30)).toBe(false);
  });

  it("does not block an issue whose blockers are all in ONE chunk", () => {
    const d = allReview([
      issue(10),
      issue(11, [10]),
      issue(12, [10]),
      issue(13, [11, 12]),
    ]);
    expect(shape(d)).toEqual([{ root: 10, members: [10, 11, 12, 13] }]);
    expect(d.blocked).toEqual([]);
  });

  // The order-independence the topological walk buys. Two straddlers over the
  // same pair: neither may be decided by looking at the graph without itself,
  // because each would then see the other joining the two chunks into one.
  it("blocks BOTH straddlers over the same pair of chunks", () => {
    const d = allReview([issue(1), issue(2), issue(3, [1, 2]), issue(4, [1, 2])]);
    expect(shape(d)).toEqual([
      { root: 1, members: [1] },
      { root: 2, members: [2] },
    ]);
    expect(d.blocked.map((b) => b.issue)).toEqual([3, 4]);
  });

  // The case a union-find in issue order gets wrong: #3's blockers land in one
  // chunk, but only once #1 and #2 have themselves been placed.
  it("waits for a blocker's own chunk before judging the dependent", () => {
    const d = allReview([issue(1, [9]), issue(2, [9]), issue(3, [1, 2]), issue(9)]);
    expect(shape(d)).toEqual([{ root: 9, members: [1, 2, 3, 9] }]);
    expect(d.blocked).toEqual([]);
  });

  it("blocks what depends on a blocked issue, transitively", () => {
    const d = allReview([
      issue(10),
      issue(20),
      issue(30, [10, 20]),
      issue(40, [30]),
      issue(50, [40]),
    ]);
    expect(shape(d)).toEqual([
      { root: 10, members: [10] },
      { root: 20, members: [20] },
    ]);
    expect(d.blocked).toEqual([
      { issue: 30, reason: "two-chunk-parent", blockers: [10, 20] },
      { issue: 40, reason: "unchunked-blocker", blockers: [30] },
      { issue: 50, reason: "unchunked-blocker", blockers: [40] },
    ]);
  });

  // A blocked issue must not silently take its own dependents' chunk with it:
  // #40 is blocked by both a real chunk and a blocked issue, and the reason
  // reported is the one a human can act on first.
  it("reports the unchunked blocker even alongside a placed one", () => {
    const d = allReview([
      issue(10),
      issue(20),
      issue(30, [10, 20]),
      issue(40, [10, 30]),
    ]);
    expect(d.blocked).toEqual([
      { issue: 30, reason: "two-chunk-parent", blockers: [10, 20] },
      { issue: 40, reason: "unchunked-blocker", blockers: [30] },
    ]);
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
    expect(d).toEqual({ chunks: [], chunkOf: new Map(), blocked: [] });
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
describe("IN_CHUNK_LABEL (#59)", () => {
  it("is spelled `in-chunk`", () => {
    expect(IN_CHUNK_LABEL).toBe("in-chunk");
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
        title: "First",
        members: [
          { number: 42, title: "First" },
          { number: 43, title: "Second" },
        ],
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
