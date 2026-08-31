import { describe, expect, it } from "vitest";
import { IN_CHUNK_LABEL } from "./chunks.js";
import {
  type IssueFacts,
  type IssueState,
  type IssueSummary,
  type Plan,
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

const closed = (...ns: number[]): ReadonlyMap<number, IssueFacts> =>
  new Map(ns.map((n) => [n, { state: "CLOSED" as IssueState, labels: [] }]));
const states = (
  o: Record<number, IssueState>,
): ReadonlyMap<number, IssueFacts> =>
  new Map(
    Object.entries(o).map(([n, s]) => [Number(n), { state: s, labels: [] }]),
  );
// The authoritative facts of a blocker that has landed on its chunk's branch:
// still OPEN, carrying `in-chunk` and nothing else.
const facts = (
  o: Record<number, { state?: IssueState; labels?: string[] }>,
): ReadonlyMap<number, IssueFacts> =>
  new Map(
    Object.entries(o).map(([n, f]) => [
      Number(n),
      { state: f.state ?? "OPEN", labels: f.labels ?? [] },
    ]),
  );

// The plan half of the resolution, for the selection tests below — they are
// about which issues get picked, and every one of them predates lanes. The
// lane half (heldForReview, overrides) is asserted on the full resolution in
// its own describe.
const planOf = (...args: Parameters<typeof resolvePlan>): Plan =>
  resolvePlan(...args).plan;

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

describe("resolvePlan", () => {
  it("includes issues with no `## Blocked by` section", () => {
    const plan = planOf([issue(10, "# Just a body")], new Map());
    expect(plan.map((p) => p.id)).toEqual(["10"]);
  });

  it("includes issues whose blockers are all CLOSED", () => {
    const plan = planOf(
      [issue(10, "## Blocked by\n- #1\n")],
      closed(1),
    );
    expect(plan.map((p) => p.id)).toEqual(["10"]);
  });

  it("excludes issues whose blocker is OPEN", () => {
    const plan = planOf(
      [issue(10, "## Blocked by\n- #1\n")],
      states({ 1: "OPEN" }),
    );
    expect(plan).toEqual([]);
  });

  it("requires ALL blockers to be CLOSED", () => {
    const plan = planOf(
      [issue(10, "## Blocked by\n- #1\n- #2\n")],
      states({ 1: "CLOSED", 2: "OPEN" }),
    );
    expect(plan).toEqual([]);
  });

  it("excludes `waiting`-labelled issues even when otherwise unblocked", () => {
    const plan = planOf(
      [issue(10, "## Blocked by\nNone\n", { labels: ["waiting"] })],
      new Map(),
    );
    expect(plan).toEqual([]);
  });

  it("treats unknown blocker numbers as open (safe default)", () => {
    const plan = planOf(
      [issue(10, "## Blocked by\n- #999\n")],
      new Map(),
    );
    expect(plan).toEqual([]);
  });

  it("sorts ascending by issue number", () => {
    const plan = planOf(
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
    const plan = planOf(
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
    const plan = planOf(
      [issue(1, ""), issue(2, ""), issue(3, "")],
      new Map(),
      new Set(),
      1,
    );
    expect(plan.length).toBe(1);
  });

  it("excludes issues in the in-run merged set (#16)", () => {
    const plan = planOf(
      [issue(10, ""), issue(11, "")],
      new Map(),
      new Set([10]),
    );
    expect(plan.map((p) => p.id)).toEqual(["11"]);
  });

  it("drops a candidate the live tracker reports CLOSED — stale search re-pick (#16)", () => {
    // The candidate surfaced from `gh issue list` (lagging search index) but its
    // authoritative state is CLOSED: it was merged+closed earlier this run.
    // The guard fails safe in the other direction: a state-fetch MISS keeps the
    // candidate (treated as open) — exercised by every empty-facts test above.
    const plan = planOf(
      [issue(10, ""), issue(11, "")],
      states({ 10: "CLOSED", 11: "OPEN" }),
    );
    expect(plan.map((p) => p.id)).toEqual(["11"]);
  });

  it("emits branch names in the documented format", () => {
    const plan = planOf(
      [issue(42, "", { title: "Fix Auth Bug!" })],
      new Map(),
    );
    expect(plan[0]!.branch).toBe("sandbar/issue-42-fix-auth-bug");
  });

  it("table: mixed candidates → only the unblocked ones flow through", () => {
    const plan = planOf(
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

// #57 — the holding rule and what the resolution reports about it. Lane
// COMPUTATION is lanes.test.ts's job; these are about the planner's use of it.
//
// #60 narrowed the rule to "not this chunk's root"; #61 narrows it to its last
// clause, "no chunk at all". Every member of a chunk plans — the root seeded
// from the source branch, a chained member from the chunk tip — so the ONE
// shape below that still produces a held issue is a straddler: an issue blocked
// by members of two different chunks, which chunks.ts refuses to give a chunk
// to at all. (Its transitive shadow and a `## Blocked by` cycle are the other
// two ways to have no chunk; chunks.test.ts owns the derivation.)
describe("resolvePlan lanes (#57)", () => {
  it("is inert on the default lane: everything plans, nothing is held", () => {
    const r = resolvePlan([issue(10, ""), issue(11, "")], new Map());

    expect(r.plan.map((p) => p.id)).toEqual(["10", "11"]);
    expect(r.heldForReview).toEqual([]);
    expect(r.overrides).toEqual([]);
  });

  it("is inert on the default lane even with `auto-land` labels in play", () => {
    const r = resolvePlan(
      [issue(10, "", { labels: ["auto-land"] }), issue(11, "")],
      new Map(),
      new Set(),
      3,
      "auto",
    );

    expect(r.plan.map((p) => p.id)).toEqual(["10", "11"]);
    expect(r.heldForReview).toEqual([]);
  });

  it("plans review-gated issues that are their own chunk's root (#60)", () => {
    // Two unrelated review-gated issues are two chunks of one, each its own
    // root, and each lands on a branch of its own. Under #57 both were held.
    const r = resolvePlan([issue(10, ""), issue(11, "")], new Map(), new Set(), 3, "review");

    expect(r.plan.map((p) => p.id)).toEqual(["10", "11"]);
    expect(r.plan.map((p) => p.chunk)).toEqual([
      { root: 10, branch: "sandbar/chunk-10-issue-10", landed: [] },
      { root: 11, branch: "sandbar/chunk-11-issue-11", landed: [] },
    ]);
    expect(r.heldForReview).toEqual([]);
  });

  it("gives an auto-lane issue no chunk, and a review-gated one its own (#60)", () => {
    // The lane is the whole difference in what the plan carries: an auto-land
    // issue lands on the source branch and names no chunk; the review-gated
    // one beside it names the branch phase 3 will merge it onto.
    const r = resolvePlan(
      [issue(10, "", { labels: ["auto-land"] }), issue(11, "")],
      new Map(),
      new Set(),
      3,
      "review",
    );

    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      ["10", null],
      ["11", { root: 11, branch: "sandbar/chunk-11-issue-11", landed: [] }],
    ]);
    expect(r.heldForReview).toEqual([]);
  });

  it("holds a review-gated issue whose blockers sit in two different chunks", () => {
    // #1 and #2 are two chunks; #30 straddles them, so `deriveChunks` gives it
    // none and it is nobody's root. Its blockers are closed, so nothing else
    // is keeping it out of the plan — the holding rule is.
    const r = resolvePlan(
      [issue(1, ""), issue(2, ""), issue(30, "## Blocked by\n- #1\n- #2\n")],
      states({ 1: "CLOSED", 2: "CLOSED" }),
      new Set(),
      3,
      "review",
    );

    expect(r.plan).toEqual([]);
    expect(r.heldForReview).toEqual([30]);
  });

  it("plans an `auto-land` issue onto the chunk it inherited, and reports the override", () => {
    // #12 is review-gated (no label, `review` default) and has landed on its
    // chunk's branch, so #11's blocker is satisfied (#59) — and #11's own
    // `auto-land` loses to what it is built on. Since #61 losing means landing
    // on #12's chunk rather than being held: the override is not a refusal to
    // work the issue, it is a redirection of where the work goes.
    const r = resolvePlan(
      [issue(11, "## Blocked by\n- #12\n", { labels: ["auto-land"] }), issue(12, "", { labels: [IN_CHUNK_LABEL] })],
      facts({ 12: { labels: [IN_CHUNK_LABEL] } }),
      new Set(),
      3,
      "review",
    );

    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      [
        "11",
        {
          root: 12,
          branch: "sandbar/chunk-12-issue-12",
          landed: [{ number: 12, title: "Issue 12" }],
        },
      ],
    ]);
    expect(r.heldForReview).toEqual([]);
    expect(r.overrides).toEqual([{ issue: 11, gatedBy: 12 }]);
  });

  it("gates a descendant through a blocker THIS cycle would not pick", () => {
    // #12 is CLOSED, so the #16 stale-search guard drops it from the plan —
    // but it is still a candidate, so its lane is known and it gates #13. Drop
    // non-planned issues from the lane graph and #13 reads as auto here.
    const r = resolvePlan(
      [
        issue(12, ""),
        issue(13, "## Blocked by\n- #12\n", { labels: ["auto-land"] }),
      ],
      states({ 12: "CLOSED" }),
      new Set(),
      3,
      "review",
    );

    // #13 plans, and the CHUNK it carries is the proof the gating landed: an
    // auto-lane issue is in no chunk at all, so a `chunk` here can only have
    // come from #12 staying in the graph. (The chunk is rooted at a closed
    // issue only because a CLOSED candidate is a stale-search artefact by
    // construction — #16 — and it clears as soon as the index catches up.)
    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      ["13", { root: 12, branch: "sandbar/chunk-12-issue-12", landed: [] }],
    ]);
    expect(r.overrides).toEqual([{ issue: 13, gatedBy: 12 }]);
  });

  it("reports an override on a candidate that is not eligible at all", () => {
    // #13's blocker is OPEN, so it fails the dependency gate — but its label is
    // contradicted today and the human should hear it today.
    const r = resolvePlan(
      [
        issue(12, ""),
        issue(13, "## Blocked by\n- #12\n", { labels: ["auto-land"] }),
      ],
      states({ 12: "OPEN" }),
      new Set(),
      3,
      "review",
    );

    expect(r.overrides).toEqual([{ issue: 13, gatedBy: 12 }]);
    // #12 is the root of the chunk the two of them form, so it plans (#60).
    // #13 is neither planned nor held: it fails the dependency gate, so its
    // lane never got to be the reason it was dropped.
    expect(r.plan.map((p) => p.id)).toEqual(["12"]);
    expect(r.heldForReview).toEqual([]);
  });

  it("does not count a closed or already-merged issue as held", () => {
    // Three straddlers over the same two chunks, so all three are shapes the
    // holding rule still covers — and only the one that is neither closed nor
    // already merged is reported as held.
    const r = resolvePlan(
      [
        issue(1, ""),
        issue(2, ""),
        issue(30, "## Blocked by\n- #1\n- #2\n"),
        issue(31, "## Blocked by\n- #1\n- #2\n"),
        issue(32, "## Blocked by\n- #1\n- #2\n"),
      ],
      states({ 1: "CLOSED", 2: "CLOSED", 31: "CLOSED" }),
      new Set([32]),
      3,
      "review",
    );

    expect(r.heldForReview).toEqual([30]);
  });

  it("does not count a `waiting` issue as held", () => {
    const r = resolvePlan(
      [issue(10, "", { labels: ["waiting"] })],
      new Map(),
      new Set(),
      3,
      "review",
    );

    expect(r.heldForReview).toEqual([]);
  });

  it("holds review-gated issues without shrinking K for the auto ones", () => {
    // The hold happens before the slice, so a held issue does not silently
    // consume one of the cycle's three slots. #6 and #7 are two closed chunks
    // and #2 and #4 straddle both, which is what makes them held rather than
    // merely blocked.
    const r = resolvePlan(
      [
        issue(1, "", { labels: ["auto-land"] }),
        issue(2, "## Blocked by\n- #6\n- #7\n"),
        issue(3, "", { labels: ["auto-land"] }),
        issue(4, "## Blocked by\n- #6\n- #7\n"),
        issue(5, "", { labels: ["auto-land"] }),
        issue(6, ""),
        issue(7, ""),
      ],
      states({ 6: "CLOSED", 7: "CLOSED" }),
      new Set(),
      3,
      "review",
    );

    expect(r.plan.map((p) => p.id)).toEqual(["1", "3", "5"]);
    expect(r.heldForReview).toEqual([2, 4]);
  });
});

// #59 — the second satisfaction clause, and the de-queue that makes it
// necessary. Chunk DERIVATION is chunks.test.ts's job; these are about the
// planner's use of it.
//
// Note what the observable is, and that #61 collapsed it back to one shape. A
// satisfied blocker means the dependent reaches the LANE filter, and since #61
// every member of a chunk clears it, so a satisfied dependent is simply
// PLANNED — carrying the chunk it will land on and be seeded from. An
// UNSATISFIED one is in neither `plan` nor `heldForReview`: it drops out at the
// dependency gate, before the lane filter is reached at all. So "absent from
// both" is what "not satisfied" looks like here, and the `chunk` a planned
// dependent carries is the second half of the assertion — it is what tells
// phase 2 to seed from the chunk tip where the blocker's commits actually are
// (#61), so a member planned with `chunk: null` would be developed against a
// tree missing its blocker's work.
describe("resolvePlan in-chunk blockers (#59)", () => {
  const inChunk = { labels: [IN_CHUNK_LABEL] };

  it("satisfies a blocker that is `in-chunk` in the SAME chunk", () => {
    // #10 landed on the chunk branch; #11 is built on it and is in that same
    // chunk by construction, so #10's commits are already under its feet. The
    // chunk #11 carries is #10's, which is what makes that true: phase 2 seeds
    // #11's branch from that branch's tip (#61).
    const r = resolvePlan(
      [issue(10, "", inChunk), issue(11, "## Blocked by\n- #10\n")],
      facts({ 10: { labels: [IN_CHUNK_LABEL] } }),
      new Set(),
      3,
      "review",
    );

    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      [
        "11",
        {
          root: 10,
          branch: "sandbar/chunk-10-issue-10",
          landed: [{ number: 10, title: "Issue 10" }],
        },
      ],
    ]);
    expect(r.heldForReview).toEqual([]);
  });

  it("does not satisfy a blocker that is merely OPEN", () => {
    // The same graph with the label taken away: #10 is open, unlanded, and
    // still blocking. #10 is the chunk's root, so it plans (#60); #11 is
    // neither planned nor held, which is what "not satisfied" looks like —
    // a satisfied #11 would be planned beside it, as the case above shows.
    const r = resolvePlan(
      [issue(10, ""), issue(11, "## Blocked by\n- #10\n")],
      facts({ 10: {} }),
      new Set(),
      3,
      "review",
    );

    expect(r.plan.map((p) => p.id)).toEqual(["10"]);
    expect(r.heldForReview).toEqual([]);
  });

  it("keeps cross-chunk dependencies strict: two `in-chunk` parents, two chunks", () => {
    // #30 straddles two chunks, so `deriveChunks` gives it none — and a
    // dependent with no chunk shares one with nobody. Both its blockers have
    // landed, and it still waits, exactly as the two-chunk-parent rule says.
    const r = resolvePlan(
      [
        issue(10, "", inChunk),
        issue(20, "", inChunk),
        issue(30, "## Blocked by\n- #10\n- #20\n"),
      ],
      facts({
        10: { labels: [IN_CHUNK_LABEL] },
        20: { labels: [IN_CHUNK_LABEL] },
      }),
      new Set(),
      3,
      "review",
    );

    expect(r.heldForReview).toEqual([]);
  });

  it("does not satisfy an `in-chunk` blocker that is in no chunk sandbar can see", () => {
    // #99 is not in the listing at all, so it has no lane and no chunk. The
    // label alone is not the criterion — the shared branch is.
    const r = resolvePlan(
      [issue(11, "## Blocked by\n- #99\n")],
      facts({ 99: { labels: [IN_CHUNK_LABEL] } }),
      new Set(),
      3,
      "review",
    );

    expect(r.heldForReview).toEqual([]);
  });

  it("still satisfies a CLOSED blocker, label or no label", () => {
    // #10 is not in the listing, so it is in no chunk and #11 has no gated
    // blocker: #11 roots a chunk of its own and plans (#60).
    const r = resolvePlan(
      [issue(11, "## Blocked by\n- #10\n")],
      facts({ 10: { state: "CLOSED" } }),
      new Set(),
      3,
      "review",
    );

    expect(r.plan.map((p) => p.id)).toEqual(["11"]);
    expect(r.heldForReview).toEqual([]);
  });

  it("propagates one LAYER at a time along a chain", () => {
    // #10 landed, #11 can be worked, #12 cannot yet: its own blocker #11 is
    // open and has not landed on the chunk branch. This is what bounds a chunk
    // to one layer per cycle and is why same-cycle members are always siblings
    // — #12 waits for the cycle AFTER the one that lands #11 and flips it to
    // `in-chunk`, so it can never be planned alongside the very branch it
    // would have to be seeded from.
    const r = resolvePlan(
      [
        issue(10, "", inChunk),
        issue(11, "## Blocked by\n- #10\n"),
        issue(12, "## Blocked by\n- #11\n"),
      ],
      facts({ 10: { labels: [IN_CHUNK_LABEL] }, 11: {}, 12: {} }),
      new Set(),
      3,
      "review",
    );

    expect(r.plan.map((p) => p.id)).toEqual(["11"]);
    expect(r.heldForReview).toEqual([]);
  });

  // The other half of "one layer": several members whose blockers have all
  // landed go together, and they are siblings, not a chain. The merge phase
  // groups them into one chunk landing and their order within it carries no
  // dependency (merger.ts, `groupByChunk`).
  it("plans every member whose blockers have landed, as one layer", () => {
    const r = resolvePlan(
      [
        issue(10, "", inChunk),
        issue(11, "## Blocked by\n- #10\n"),
        issue(12, "## Blocked by\n- #10\n"),
      ],
      facts({ 10: { labels: [IN_CHUNK_LABEL] } }),
      new Set(),
      3,
      "review",
    );

    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      [
        "11",
        {
          root: 10,
          branch: "sandbar/chunk-10-issue-10",
          landed: [{ number: 10, title: "Issue 10" }],
        },
      ],
      [
        "12",
        {
          root: 10,
          branch: "sandbar/chunk-10-issue-10",
          landed: [{ number: 10, title: "Issue 10" }],
        },
      ],
    ]);
    expect(r.heldForReview).toEqual([]);
  });

  it("drops an `in-chunk` candidate from the plan — the label is the de-queue", () => {
    // Stated on the AUTO lane so nothing else can be the reason: without the
    // in-chunk drop, #10 is an ordinary unblocked candidate and plans.
    const r = resolvePlan(
      [issue(10, "", inChunk), issue(11, "")],
      facts({ 10: { labels: [IN_CHUNK_LABEL] } }),
      new Set(),
      3,
      "auto",
    );

    expect(r.plan.map((p) => p.id)).toEqual(["11"]);
  });

  it("does not count an `in-chunk` candidate as held for review", () => {
    // It is review-gated and out of the plan, but it is not waiting on a human
    // to be worked — it has already been worked. Reporting it as held would
    // make the held list grow with every member a chunk lands.
    const r = resolvePlan(
      [issue(10, "", inChunk)],
      facts({ 10: { labels: [IN_CHUNK_LABEL] } }),
      new Set(),
      3,
      "review",
    );

    expect(r.plan).toEqual([]);
    expect(r.heldForReview).toEqual([]);
  });

  it("reads the label from the authoritative facts when the listing lags", () => {
    // The search index still shows #10 as it was before the flip. GraphQL is
    // strongly consistent, so it decides — both that #10 is out of the plan and
    // that #11's blocker is satisfied.
    const r = resolvePlan(
      [issue(10, ""), issue(11, "## Blocked by\n- #10\n")],
      facts({ 10: { labels: [IN_CHUNK_LABEL] } }),
      new Set(),
      3,
      "review",
    );

    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      [
        "11",
        {
          root: 10,
          branch: "sandbar/chunk-10-issue-10",
          landed: [{ number: 10, title: "Issue 10" }],
        },
      ],
    ]);
    expect(r.heldForReview).toEqual([]);
  });

  it("reads the label from the listing when the facts batch missed the issue", () => {
    // The other direction of the same fail-safe: a state-fetch miss must not
    // resurrect a landed member into the plan.
    const r = resolvePlan(
      [issue(10, "", inChunk), issue(11, "## Blocked by\n- #10\n")],
      new Map(),
      new Set(),
      3,
      "review",
    );

    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      [
        "11",
        {
          root: 10,
          branch: "sandbar/chunk-10-issue-10",
          landed: [{ number: 10, title: "Issue 10" }],
        },
      ],
    ]);
    expect(r.heldForReview).toEqual([]);
  });

  it("is inert with no `in-chunk` label anywhere, on either lane", () => {
    const candidates = [
      issue(10, ""),
      issue(11, "## Blocked by\n- #10\n"),
      issue(12, "## Blocked by\n- #9\n"),
    ];

    const auto = resolvePlan(candidates, facts({ 9: { state: "CLOSED" } }));
    expect(auto.plan.map((p) => p.id)).toEqual(["10", "12"]);

    const review = resolvePlan(
      candidates,
      facts({ 9: { state: "CLOSED" } }),
      new Set(),
      3,
      "review",
    );
    // #10 and #12 root chunks of their own and plan; #11 is blocked by an open,
    // unlanded #10 and is neither planned nor held. Nothing about that answer
    // came from the label — there isn't one anywhere in the graph.
    expect(review.plan.map((p) => p.id)).toEqual(["10", "12"]);
    expect(review.heldForReview).toEqual([]);
  });
});

// #62 — the chunk PR's member list. The planner is the only place that knows
// which members are ALREADY on a chunk branch: it has the whole candidate
// graph, and phase 3 has this cycle's DONE branches and nothing else.
//
// Since #61 a planned issue with a landed sibling is the ORDINARY case: a
// member plans once its blockers carry `in-chunk`, and a blocker carrying that
// label is a member already on the chunk branch. The graph below is the mirror
// of that shape — here the landed member is the one BEHIND, which only a
// hand-applied label reaches — and the assertion is the same either way:
// whatever holds `in-chunk` is what the plan hands the PR body.
describe("resolvePlan chunk PR members (#62)", () => {
  it("carries the chunk's already-landed members, with their titles", () => {
    const r = resolvePlan(
      [
        issue(10, "", { title: "Root" }),
        issue(11, "## Blocked by\n- #10\n", {
          title: "Landed member",
          labels: [IN_CHUNK_LABEL],
        }),
      ],
      facts({ 11: { labels: [IN_CHUNK_LABEL] } }),
      new Set(),
      3,
      "review",
    );

    expect(r.plan.map((p) => p.chunk?.landed)).toEqual([
      [{ number: 11, title: "Landed member" }],
    ]);
  });

  it("never lists the issue that is on its way there", () => {
    // The planned issue's own work is not on the branch yet — the merge phase
    // is what puts it there, and it adds itself to the list afterwards.
    const r = resolvePlan([issue(10, "")], new Map(), new Set(), 3, "review");

    expect(r.plan[0]!.chunk?.landed).toEqual([]);
  });

  it("gives an auto-lane issue no chunk to carry a list on", () => {
    const r = resolvePlan([issue(10, "")], new Map(), new Set(), 3, "auto");

    expect(r.plan[0]!.chunk).toBeNull();
  });
});

// #63, #64 — the derivation the plan carries for the two phases that act on a
// chunk as a whole. Both exist because only this function has the candidate
// graph: nothing downstream of the plan could name the chunks with work on
// origin, what each branch carries or what is at its tip, and nothing that
// lists issues could see one filed sixty seconds ago.
describe("resolvePlan landed chunks (#63, #64)", () => {
  it("reports a chunk with work on origin: what its branch carries, and the tips", () => {
    const r = resolvePlan(
      [
        issue(10, "", { title: "Root", labels: [IN_CHUNK_LABEL] }),
        issue(11, "## Blocked by\n- #10\n", {
          title: "Second",
          labels: [IN_CHUNK_LABEL],
        }),
        issue(12, "## Blocked by\n- #11\n", { title: "Queued" }),
      ],
      facts({
        10: { labels: [IN_CHUNK_LABEL] },
        11: { labels: [IN_CHUNK_LABEL] },
      }),
      new Set(),
      3,
      "review",
    );

    expect(r.landedChunks).toEqual([
      {
        root: 10,
        branch: "sandbar/chunk-10-root",
        title: "Root",
        members: [
          { number: 10, title: "Root" },
          { number: 11, title: "Second" },
        ],
        closeOrder: [
          { number: 11, title: "Second" },
          { number: 10, title: "Root" },
        ],
        tips: [{ number: 11, title: "Second" }],
      },
    ]);
  });

  it("leaves a member that has never landed off the list a landing CLOSES", () => {
    // #64's whole correctness: #12 above is in the chunk's COMPONENT and is
    // planned this very cycle, but no commit of it is anywhere. Closing it
    // when the chunk lands would destroy queued work and tell a human it had
    // landed, so `members` is the `in-chunk` set and never `Chunk.members`.
    const r = resolvePlan(
      [
        issue(10, "", { title: "Root", labels: [IN_CHUNK_LABEL] }),
        issue(11, "## Blocked by\n- #10\n", { title: "Queued" }),
      ],
      facts({ 10: { labels: [IN_CHUNK_LABEL] } }),
      new Set(),
      3,
      "review",
    );

    expect(r.plan.map((p) => p.id)).toEqual(["11"]);
    expect(r.landedChunks[0]?.members).toEqual([{ number: 10, title: "Root" }]);
  });

  it("reports nothing before a chunk's first landing", () => {
    // The scan makes no call at all in this state: there is no branch on
    // origin and so no pull request to have been reviewed, and there is
    // nothing a `land` label could be asking for.
    const r = resolvePlan([issue(10, "")], new Map(), new Set(), 3, "review");

    expect(r.landedChunks).toEqual([]);
  });

  it("reports nothing on the default lane", () => {
    const r = resolvePlan(
      [issue(10, "", { labels: [IN_CHUNK_LABEL] })],
      facts({ 10: { labels: [IN_CHUNK_LABEL] } }),
      new Set(),
      3,
      "auto",
    );

    expect(r.landedChunks).toEqual([]);
  });

  it("plans a follow-up issue blocked by the tip it was filed behind", () => {
    // The end-to-end claim of #63, stated as the planner sees it: a follow-up
    // declaring the chunk's tip is review-gated by inheritance, lands in that
    // same chunk, and is eligible in the very cycle it was filed — its blocker
    // already carries `in-chunk`.
    const r = resolvePlan(
      [
        issue(10, "", { title: "Root", labels: [IN_CHUNK_LABEL] }),
        issue(50, "## Blocked by\n- #10\n", { title: "Chunk #10: address review feedback" }),
      ],
      facts({ 10: { labels: [IN_CHUNK_LABEL] } }),
      new Set(),
      3,
      "review",
    );

    expect(r.plan.map((p) => p.id)).toEqual(["50"]);
    expect(r.plan[0]?.chunk?.branch).toBe("sandbar/chunk-10-root");
    expect(r.heldForReview).toEqual([]);
  });
});
