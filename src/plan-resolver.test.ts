import { describe, expect, it } from "vitest";
import type { ChunkTarget } from "./chunks.js";
import type { Lane } from "./lanes.js";
import { chunkBranchName } from "./naming.js";
import {
  type IssueFacts,
  type IssueState,
  type IssueSummary,
  type Plan,
  type PlanResolution,
  type ReadyLabelPolicy,
  parseBlockedBy,
  resolvePlan as resolvePlanDecision,
} from "./plan-resolver.js";

const membersOn = (
  root: number,
  title: string,
  ...members: number[]
): ReadonlyMap<string, ReadonlySet<number>> =>
  new Map([[chunkBranchName(root, title), new Set(members)]]);

// Two chunks still underway because each kept branch carries its root's
// member ref — the shape a straddler is held against (#193).
const twoKeptChunks = (
  a: number,
  b: number,
): ReadonlyMap<string, ReadonlySet<number>> =>
  new Map([
    [chunkBranchName(a, `Issue ${a}`), new Set([a])],
    [chunkBranchName(b, `Issue ${b}`), new Set([b])],
  ]);

function issue(
  number: number,
  body: string,
  opts: { title?: string; labels?: string[] } = {},
): IssueSummary {
  return {
    number,
    title: opts.title ?? `Issue ${number}`,
    body,
    labels: ["2-agent-build", ...(opts.labels ?? [])],
  };
}

// Most tables predate #136 and exercise other planner dimensions. Keep their
// compact positional fixtures while the production contract requires the
// security-sensitive policy by name.
function resolvePlan(
  candidates: readonly IssueSummary[],
  issueFacts: ReadonlyMap<number, IssueFacts>,
  excluded: ReadonlySet<number> = new Set(),
  k = 3,
  defaultLane: Lane = "auto",
  chunkMembers: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
  ongoing: ReadonlySet<number> = new Set(),
  readyLabelPolicy: ReadyLabelPolicy = "anyone",
  trustedReady: ReadonlySet<number> = new Set(),
  chunksContainingSource: ReadonlySet<string> = new Set(),
): PlanResolution {
  return resolvePlanDecision(candidates, issueFacts, {
    excluded,
    k,
    defaultLane,
    chunkMembers,
    chunksContainingSource,
    ongoing,
    readyLabelPolicy,
    trustedReady,
  });
}

const closed = (...ns: number[]): ReadonlyMap<number, IssueFacts> =>
  new Map(ns.map((n) => [n, {
    state: "CLOSED" as IssueState,
    labels: [],
    readyLabelApplication: null,
  }]));
const states = (
  o: Record<number, IssueState>,
): ReadonlyMap<number, IssueFacts> =>
  new Map(
    Object.entries(o).map(([n, s]) => [Number(n), {
      state: s,
      labels: [],
      readyLabelApplication: null,
    }]),
  );
const facts = (
  o: Record<number, {
    state?: IssueState;
    labels?: readonly string[];
    actor?: string | null;
  }>,
): ReadonlyMap<number, IssueFacts> =>
  new Map(
    Object.entries(o).map(([n, f]) => [
      Number(n),
      {
        state: f.state ?? "OPEN",
        labels: f.labels ?? [],
        readyLabelApplication: f.actor === undefined
          ? null
          : { actor: f.actor, createdAt: "2026-09-08T12:00:00Z" },
      },
    ]),
  );

// The plan half of the resolution, for the selection tests below — they are
// about which issues get picked, and every one of them predates lanes. The
// lane half (waiting, overrides) is asserted on the full resolution in
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

describe("2-agent-build actor admission (#136)", () => {
  const policy = {
    developers: ["Alice", "release-bot[bot]"],
    viewerLogin: "sandbar-bot",
  } as const;

  it.each(["alice", "RELEASE-BOT[BOT]", "SANDBAR-BOT"])(
    "admits a configured or token actor case-insensitively: %s",
    (actor) => {
      const result = resolvePlan(
        [issue(10, "", { labels: ["2-agent-build"] })],
        facts({ 10: { labels: ["2-agent-build"], actor } }),
        new Set(),
        3,
        "auto",
        new Map(),
        new Set(),
        policy,
      );
      expect(result.plan.map((candidate) => candidate.id)).toEqual(["10"]);
      expect(result.waiting).toEqual([]);
    },
  );

  it.each([
    { name: "another login", actor: "mallory", reported: "mallory" },
    { name: "no event in the bounded window", actor: undefined, reported: null },
    { name: "an event whose actor has no login", actor: null, reported: null },
  ])("excludes and reports $name", ({ actor, reported }) => {
    const result = resolvePlan(
      [issue(10, "", { labels: ["2-agent-build"] })],
      facts({ 10: { labels: ["2-agent-build"], actor } }),
      new Set(),
      3,
      "auto",
      new Map(),
      new Set(),
      policy,
    );
    expect(result.plan).toEqual([]);
    expect(result.candidates[0]?.ready).toBe(false);
    expect(result.waiting).toEqual([
      { issue: 10, title: "Issue 10", reason: { kind: "label-actor", actor: reported } },
    ]);
  });

  it("fails closed when the authoritative batch misses a listed issue", () => {
    const result = resolvePlan(
      [issue(10, "")],
      new Map(),
      new Set(),
      3,
      "auto",
      new Map(),
      new Set(),
      policy,
    );
    expect(result.plan).toEqual([]);
    expect(result.waiting[0]?.reason).toEqual({ kind: "label-actor", actor: null });
  });

  it("honors authoritative label removal even when the last actor was allowed", () => {
    const result = resolvePlan(
      [issue(10, "")],
      facts({ 10: { labels: [], actor: "alice" } }),
      new Set(),
      3,
      "auto",
      new Map(),
      new Set(),
      policy,
    );
    expect(result.plan).toEqual([]);
    expect(result.candidates[0]?.ready).toBe(false);
    expect(result.waiting).toEqual([]);
  });

  it("keeps anyone mode's existing behavior without timeline evidence", () => {
    const result = resolvePlan(
      [issue(10, "", { labels: ["2-agent-build"] })],
      facts({ 10: { labels: ["2-agent-build"], actor: "mallory" } }),
    );
    expect(result.plan.map((candidate) => candidate.id)).toEqual(["10"]);
  });

  it("trusts a same-cycle extra candidate re-queued by sandbar", () => {
    const result = resolvePlan(
      [issue(10, "", { labels: ["2-agent-build"] })],
      facts({ 10: { labels: ["2-agent-build"] } }),
      new Set(),
      3,
      "auto",
      new Map(),
      new Set(),
      policy,
      new Set([10]),
    );
    expect(result.plan.map((candidate) => candidate.id)).toEqual(["10"]);
  });

  it("does not treat an outsider's chunk relabelling as a rework request", () => {
    const result = resolvePlan(
      [issue(47, "", { title: "Root", labels: ["2-agent-build"] })],
      facts({ 47: { labels: ["2-agent-build"], actor: "mallory" } }),
      new Set(),
      3,
      "review",
      membersOn(47, "Root", 47),
      new Set(),
      policy,
    );
    expect(result.plan).toEqual([]);
    expect(result.landedChunks[0]?.rework).toEqual([]);
    expect(result.waiting[0]?.reason).toEqual({
      kind: "label-actor",
      actor: "mallory",
    });
  });
});

describe("resolvePlan", () => {
  it("reports every ready issue not admitted with its scheduler reason", () => {
    const ready = { labels: ["2-agent-build"] };
    const resolution = resolvePlan(
      [
        issue(1, "", ready),
        issue(2, "", ready),
        issue(3, "## Blocked by\n- #9\n", ready),
        issue(4, "", ready),
      ],
      states({ 9: "OPEN" }),
      new Set([4]),
      1,
      "auto",
      new Map(),
      new Set([4]),
    );

    expect(resolution.plan.map((candidate) => candidate.id)).toEqual(["1"]);
    expect(resolution.waiting).toEqual([
      { issue: 2, title: "Issue 2", reason: { kind: "no-slot" } },
      { issue: 3, title: "Issue 3", reason: { kind: "blocked", by: [9] } },
      { issue: 4, title: "Issue 4", reason: { kind: "ongoing" } },
    ]);
  });

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

  it.each(["1-human-later", "2-agent-later"])("excludes `%s`-labelled issues even when otherwise unblocked", (later) => {
    const plan = planOf(
      [issue(10, "## Blocked by\nNone\n", { labels: [later] })],
      new Map(),
    );
    expect(plan).toEqual([]);
  });

  it("drops a listed candidate when authoritative facts say it is no longer ready", () => {
    const plan = planOf(
      [issue(10, "", { labels: ["2-agent-build"] })],
      facts({ 10: { labels: [] } }),
    );

    expect(plan).toEqual([]);
  });

  it("keeps the listed ready reading when the authoritative batch misses it", () => {
    const plan = planOf(
      [issue(10, "", { labels: ["2-agent-build"] })],
      new Map(),
    );

    expect(plan.map((p) => p.id)).toEqual(["10"]);
  });

  it("unions authoritative `2-agent-later` with the listing", () => {
    const plan = planOf(
      [issue(10, "", { labels: ["2-agent-build"] })],
      facts({ 10: { labels: ["2-agent-build", "2-agent-later"] } }),
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

  it("drops a candidate the live tracker reports CLOSED — stale listing re-pick (#16)", () => {
    // The candidate surfaced from a lagging `gh issue list` result but its
    // authoritative state is CLOSED: it was merged+closed earlier this run.
    // The guard fails safe in the other direction: a state-fetch MISS keeps the
    // candidate (treated as open) — exercised by every empty-facts test above.
    const plan = planOf(
      [issue(10, ""), issue(11, "")],
      facts({
        10: { state: "CLOSED" },
        11: { labels: ["2-agent-build"] },
      }),
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
        issue(13, "", { labels: ["1-human-later"] }),
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
  });

  it("plans review-gated issues that are their own chunk's root (#60)", () => {
    // Two unrelated review-gated issues are two chunks of one, each its own
    // root, and each lands on a branch of its own. Under #57 both were held.
    const r = resolvePlan([issue(10, ""), issue(11, "")], new Map(), new Set(), 3, "review");

    expect(r.plan.map((p) => p.id)).toEqual(["10", "11"]);
    expect(r.plan.map((p) => p.chunk)).toEqual([
      { root: 10, branch: "sandbar/chunk-10-issue-10", landed: [], seed: "source" },
      { root: 11, branch: "sandbar/chunk-11-issue-11", landed: [], seed: "source" },
    ]);
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
      new Map([["sandbar/chunk-99-x", new Set([99])]]),
    );

    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      ["10", null],
      ["11", { root: 11, branch: "sandbar/chunk-11-issue-11", landed: [], seed: "source" }],
    ]);
  });

  it("holds a review-gated issue that would join two underway chunks", () => {
    // #1 and #2 are two UNDERWAY chunks — each still carried by its kept chunk
    // branch — and #30 straddles them, so `deriveChunks` gives it none (#193:
    // join, never merge). Its blockers are closed, so nothing else is keeping
    // it out of the plan — the holding rule is.
    const r = resolvePlan(
      [issue(1, ""), issue(2, ""), issue(30, "## Blocked by\n- #1\n- #2\n")],
      states({ 1: "CLOSED", 2: "CLOSED" }),
      new Set(),
      3,
      "review",
      twoKeptChunks(1, 2),
    );

    expect(r.plan).toEqual([]);
    expect(r.waiting.filter((entry) => entry.reason.kind === "held")
      .map((entry) => entry.issue)).toEqual([30]);
  });

  it("plans an `auto-land` issue onto the chunk it inherited, and reports the override", () => {
    // #12 is review-gated (no label, `review` default) and has landed on its
    // chunk's branch, so #11's blocker is satisfied (#59) — and #11's own
    // `auto-land` loses to what it is built on. Since #61 losing means landing
    // on #12's chunk rather than being held: the override is not a refusal to
    // work the issue, it is a redirection of where the work goes.
    const r = resolvePlan(
      [issue(11, "## Blocked by\n- #12\n", { labels: ["auto-land"] }), issue(12, "")],
      facts({ 12: {} }),
      new Set(),
      3,
      "review",
      membersOn(12, "Issue 12", 12),
    );

    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      [
        "11",
        {
          root: 12,
          branch: "sandbar/chunk-12-issue-12",
          landed: [{ number: 12, title: "Issue 12" }],
          seed: "tip",
        },
      ],
    ]);
    expect(r.overrides).toEqual([{ issue: 11, gatedBy: 12 }]);
  });

  it("gates a descendant through a blocker THIS cycle would not pick", () => {
    // #12 is CLOSED, so the #16 stale-listing guard drops it from the plan —
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
    // come from #12 staying in the LANE graph. The chunk graph leaves the
    // closed #12 out — no chunk branch carries it, so its work is on the
    // source branch (#193) — and #13 is its own chunk's root.
    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      ["13", { root: 13, branch: "sandbar/chunk-13-issue-13", landed: [], seed: "source" }],
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
      facts({ 12: { labels: ["2-agent-build"] } }),
      new Set(),
      3,
      "review",
    );

    expect(r.overrides).toEqual([{ issue: 13, gatedBy: 12 }]);
    // #12 is the root of the chunk the two of them form, so it plans (#60).
    // #13 is neither planned nor held: it fails the dependency gate, so its
    // lane never got to be the reason it was dropped.
    expect(r.plan.map((p) => p.id)).toEqual(["12"]);
  });

  it("does not count a closed or already-merged issue as held", () => {
    // Three straddlers over the same two underway chunks, so all three are
    // shapes the holding rule still covers — and only the one that is neither
    // closed nor already merged is reported as held.
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
      twoKeptChunks(1, 2),
    );

    expect(r.waiting.filter((entry) => entry.reason.kind === "held")
      .map((entry) => entry.issue)).toEqual([30]);
  });

  it("does not count a `-later` issue as held", () => {
    const r = resolvePlan(
      [issue(10, "", { labels: ["2-agent-later"] })],
      new Map(),
      new Set(),
      3,
      "review",
    );

    expect(r.plan).toEqual([]);
  });

  it("holds review-gated issues without shrinking K for the auto ones", () => {
    // The hold happens before the slice, so a held issue does not silently
    // consume one of the cycle's three slots. #6 and #7 are two closed,
    // still-underway chunks and #2 and #4 straddle both, which is what makes
    // them held rather than merely blocked.
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
      twoKeptChunks(6, 7),
    );

    expect(r.plan.map((p) => p.id)).toEqual(["1", "3", "5"]);
    expect(r.waiting.filter((entry) => entry.reason.kind === "held")
      .map((entry) => entry.issue)).toEqual([2, 4]);
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
// An unsatisfied issue is absent from `plan` and appears in `waiting` as
// blocked, before the lane filter is reached. The `chunk` a planned
// dependent carries is the second half of the assertion — it is what tells
// phase 2 to seed from the chunk tip where the blocker's commits actually are
// (#61), so a member planned with `chunk: null` would be developed against a
// tree missing its blocker's work.
describe("resolvePlan chunk-branch blockers (#59, #93)", () => {
  it("satisfies a blocker named on the SAME derived chunk branch", () => {
    // #10 landed on the chunk branch; #11 is built on it and is in that same
    // chunk by construction, so #10's commits are already under its feet. The
    // chunk #11 carries is #10's, which is what makes that true: phase 2 seeds
    // #11's branch from that branch's tip (#61).
    const r = resolvePlan(
      [issue(10, ""), issue(11, "## Blocked by\n- #10\n")],
      facts({ 10: {} }),
      new Set(),
      3,
      "review",
      membersOn(10, "Issue 10", 10),
    );

    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      [
        "11",
        {
          root: 10,
          branch: "sandbar/chunk-10-issue-10",
          landed: [{ number: 10, title: "Issue 10" }],
          seed: "tip",
        },
      ],
    ]);
  });

  it("does not satisfy a blocker that is merely OPEN", () => {
    // The same graph without branch membership: #10 is open, unlanded, and
    // still blocking. #10 is the chunk's root, so it plans (#60); #11 is
    // neither planned nor held, which is what "not satisfied" looks like —
    // a satisfied #11 would be planned beside it, as the case above shows.
    const r = resolvePlan(
      [issue(10, ""), issue(11, "## Blocked by\n- #10\n")],
      facts({ 10: { labels: ["2-agent-build"] } }),
      new Set(),
      3,
      "review",
    );

    expect(r.plan.map((p) => p.id)).toEqual(["10"]);
  });

  it("keeps cross-chunk dependencies strict: two published parents, two chunks", () => {
    // #30 straddles two chunks, so `deriveChunks` gives it none — and a
    // dependent with no chunk shares one with nobody. Both its blockers have
    // landed, and it still waits, exactly as the two-chunk-parent rule says.
    const r = resolvePlan(
      [
        issue(10, ""),
        issue(20, ""),
        issue(30, "## Blocked by\n- #10\n- #20\n"),
      ],
      facts({ 10: {}, 20: {} }),
      new Set(),
      3,
      "review",
      new Map([
        ...membersOn(10, "Issue 10", 10),
        ...membersOn(20, "Issue 20", 20),
      ]),
    );

    expect(r.plan).toEqual([]);
  });

  it("does not satisfy a blocker that is in no chunk sandbar can derive", () => {
    // #99 is not in the listing at all, so it has no lane and no derived chunk.
    // Naming it on an unrelated branch cannot satisfy #11's blocker.
    const r = resolvePlan(
      [issue(11, "## Blocked by\n- #99\n")],
      facts({ 99: {} }),
      new Set(),
      3,
      "review",
      new Map([["sandbar/chunk-99-x", new Set([99])]]),
    );

    expect(r.plan).toEqual([]);
  });

  it("still satisfies a CLOSED blocker without chunk membership", () => {
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
  });

  it("propagates one LAYER at a time along a chain", () => {
    // #10 landed, #11 can be worked, #12 cannot yet: its own blocker #11 is
    // open and has not landed on the chunk branch. This is what bounds a chunk
    // to one layer per cycle and is why same-cycle members are always siblings
    // — #12 waits for the cycle AFTER the one that lands #11 and publishes its
    // member ref, so it can never be planned alongside the very branch it
    // would have to be seeded from.
    const r = resolvePlan(
      [
        issue(10, ""),
        issue(11, "## Blocked by\n- #10\n"),
        issue(12, "## Blocked by\n- #11\n"),
      ],
      facts({
        10: {},
        11: { labels: ["2-agent-build"] },
        12: { labels: ["2-agent-build"] },
      }),
      new Set(),
      3,
      "review",
      membersOn(10, "Issue 10", 10),
    );

    expect(r.plan.map((p) => p.id)).toEqual(["11"]);
  });

  // The other half of "one layer": several members whose blockers have all
  // landed go together, and they are siblings, not a chain. The merge phase
  // groups them into one chunk landing and their order within it carries no
  // dependency (merger.ts, `groupByChunk`).
  it("plans every member whose blockers have landed, as one layer", () => {
    const r = resolvePlan(
      [
        issue(10, ""),
        issue(11, "## Blocked by\n- #10\n"),
        issue(12, "## Blocked by\n- #10\n"),
      ],
      facts({ 10: {} }),
      new Set(),
      3,
      "review",
      membersOn(10, "Issue 10", 10),
    );

    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      [
        "11",
        {
          root: 10,
          branch: "sandbar/chunk-10-issue-10",
          landed: [{ number: 10, title: "Issue 10" }],
          seed: "tip",
        },
      ],
      [
        "12",
        {
          root: 10,
          branch: "sandbar/chunk-10-issue-10",
          landed: [{ number: 10, title: "Issue 10" }],
          seed: "tip",
        },
      ],
    ]);
  });

  it("queues a refresh when a chained member also relies on a CLOSED blocker", () => {
    const branch = "sandbar/chunk-245-issue-245";
    const r = resolvePlan(
      [
        issue(245, "", { title: "Issue 245" }),
        issue(400, "## Blocked by\n- #245\n- #399\n"),
      ],
      facts({ 245: {}, 399: { state: "CLOSED" } }),
      new Set(),
      3,
      "review",
      new Map([[branch, new Set([245])]]),
    );

    expect(r.plan).toEqual([]);
    expect(r.waiting).toEqual([{
      issue: 400,
      title: "Issue 400",
      reason: { kind: "chunk-refresh", branch, by: [399] },
    }]);
    expect(r.chunkRefreshes).toEqual([{
      root: 245,
      branch,
      base: null,
      title: "Issue 245",
      dependents: [{ number: 400, title: "Issue 400" }],
    }]);
  });

  it("aggregates every selected dependent onto one chunk refresh", () => {
    const branch = "sandbar/chunk-245-issue-245";
    const r = resolvePlan(
      [
        issue(245, "", { title: "Issue 245" }),
        issue(400, "## Blocked by\n- #245\n- #399\n"),
        issue(401, "## Blocked by\n- #245\n- #399\n"),
      ],
      facts({ 245: {}, 399: { state: "CLOSED" } }),
      new Set(),
      3,
      "review",
      new Map([[branch, new Set([245])]]),
    );

    expect(r.chunkRefreshes).toEqual([{
      root: 245,
      branch,
      base: null,
      title: "Issue 245",
      dependents: [
        { number: 400, title: "Issue 400" },
        { number: 401, title: "Issue 401" },
      ],
    }]);
  });

  it("admits the chained member once the chunk contains the source tip", () => {
    const branch = "sandbar/chunk-245-issue-245";
    const r = resolvePlan(
      [
        issue(245, "", { title: "Issue 245" }),
        issue(400, "## Blocked by\n- #245\n- #399\n"),
      ],
      facts({ 245: {}, 399: { state: "CLOSED" } }),
      new Set(),
      3,
      "review",
      new Map([[branch, new Set([245])]]),
      new Set(),
      "anyone",
      new Set(),
      new Set([branch]),
    );

    expect(r.plan.map((issue) => issue.id)).toEqual(["400"]);
    expect(r.chunkRefreshes).toEqual([]);
  });

  it("does not queue a refresh for a member outside the K-sized selection", () => {
    const branch = "sandbar/chunk-245-issue-245";
    const r = resolvePlan(
      [
        issue(245, "", { title: "Issue 245" }),
        issue(400, "## Blocked by\n- #245\n- #399\n"),
      ],
      facts({ 245: {}, 399: { state: "CLOSED" } }),
      new Set(),
      0,
      "review",
      new Map([[branch, new Set([245])]]),
    );

    expect(r.chunkRefreshes).toEqual([]);
    expect(r.waiting).toEqual([{
      issue: 400,
      title: "Issue 400",
      reason: { kind: "no-slot" },
    }]);
  });

  it("does not refresh an unchained chunk root for a CLOSED blocker", () => {
    const r = resolvePlan(
      [issue(400, "## Blocked by\n- #399\n")],
      facts({ 399: { state: "CLOSED" } }),
      new Set(),
      3,
      "review",
    );

    expect(r.plan.map((issue) => issue.id)).toEqual(["400"]);
    expect(r.chunkRefreshes).toEqual([]);
  });

  it("does not let a display label de-queue an auto-lane candidate", () => {
    const r = resolvePlan(
      [issue(10, "", { labels: ["3-human-review"] }), issue(11, "")],
      facts({ 10: { labels: ["2-agent-build"] } }),
      new Set(),
      3,
      "auto",
      new Map(),
    );

    expect(r.plan.map((p) => p.id)).toEqual(["10", "11"]);
  });

  it("does not count a git-derived member as held for review", () => {
    // It is review-gated and out of the plan, but it is not waiting on a human
    // to be worked — it has already been worked. Reporting it as held would
    // make the held list grow with every member a chunk lands.
    const r = resolvePlan(
      [issue(10, "")],
      facts({ 10: {} }),
      new Set(),
      3,
      "review",
      membersOn(10, "Issue 10", 10),
    );

    expect(r.plan).toEqual([]);
  });

  it("uses branch history even when tracker facts have no display label", () => {
    const r = resolvePlan(
      [issue(10, ""), issue(11, "## Blocked by\n- #10\n")],
      facts({ 10: {} }),
      new Set(),
      3,
      "review",
      membersOn(10, "Issue 10", 10),
    );

    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      [
        "11",
        {
          root: 10,
          branch: "sandbar/chunk-10-issue-10",
          landed: [{ number: 10, title: "Issue 10" }],
          seed: "tip",
        },
      ],
    ]);
  });

  it("uses branch history when the facts batch missed the member", () => {
    const r = resolvePlan(
      [issue(10, ""), issue(11, "## Blocked by\n- #10\n")],
      new Map(),
      new Set(),
      3,
      "review",
      membersOn(10, "Issue 10", 10),
    );

    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      [
        "11",
        {
          root: 10,
          branch: "sandbar/chunk-10-issue-10",
          landed: [{ number: 10, title: "Issue 10" }],
          seed: "tip",
        },
      ],
    ]);
  });

  it("is inert with no chunk membership anywhere, on either lane", () => {
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
  });
});

// #62 — the chunk PR's member list. The planner is the only place that knows
// which members are ALREADY on a chunk branch: it has the whole candidate
// graph, and phase 3 has this cycle's DONE branches and nothing else.
//
// Since #61 a planned issue with a landed sibling is the ORDINARY case: a
// member plans once its blockers are named by the exact chunk branch. The graph
// below is the mirror of that shape: the already-landed member is behind the
// root, and branch history is what the plan hands the PR body.
describe("resolvePlan chunk PR members (#62)", () => {
  it("carries the chunk's already-landed members, with their titles", () => {
    const r = resolvePlan(
      [
        issue(10, "", { title: "Root" }),
        issue(11, "## Blocked by\n- #10\n", {
          title: "Landed member",
        }),
      ],
      facts({ 11: {} }),
      new Set(),
      3,
      "review",
      membersOn(10, "Root", 11),
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

describe("resolvePlan git membership safety (#93)", () => {
  it("re-plans a member only when the authoritative batch says it is ready", () => {
    const result = resolvePlan(
      [issue(47, "", { title: "Root" })],
      facts({ 47: { labels: ["2-agent-build"] } }),
      new Set(),
      3,
      "review",
      membersOn(47, "Root", 47),
    );

    expect(result.plan.map((p) => p.id)).toEqual(["47"]);
    expect(result.plan[0]!.chunk).not.toBeNull();
  });

  it("retains authoritative rework even when scheduler exclusion prevents a restart", () => {
    const result = resolvePlan(
      [issue(47, "", { title: "Root" })],
      facts({ 47: { labels: ["2-agent-build"] } }),
      new Set([47]), 3, "review", membersOn(47, "Root", 47),
    );

    expect(result.plan).toEqual([]);
    expect(result.landedChunks[0]?.rework).toEqual([
      { number: 47, title: "Root" },
    ]);
  });

  it("retains rework while its chained member waits for a chunk refresh", () => {
    const branch = "sandbar/chunk-245-issue-245";
    const result = resolvePlan(
      [
        issue(245, "", { title: "Issue 245" }),
        issue(400, "## Blocked by\n- #245\n- #399\n"),
      ],
      facts({
        245: {},
        399: { state: "CLOSED" },
        400: { labels: ["2-agent-build"] },
      }),
      new Set(),
      3,
      "review",
      new Map([[branch, new Set([245, 400])]]),
    );

    expect(result.plan).toEqual([]);
    expect(result.chunkRefreshes).toHaveLength(1);
    expect(result.landedChunks[0]?.rework).toEqual([
      { number: 400, title: "Issue 400" },
    ]);
  });

  it.each([
    {
      name: "closed",
      candidate: issue(47, "", { title: "Root" }),
      issueFacts: facts({ 47: { state: "CLOSED", labels: ["2-agent-build"] } }),
      excluded: new Set<number>(),
    },
    {
      name: "waiting",
      candidate: issue(47, "", { title: "Root", labels: ["1-human-later"] }),
      issueFacts: facts({ 47: { labels: ["2-agent-build"] } }),
      excluded: new Set<number>(),
    },
    {
      name: "blocked",
      candidate: issue(47, "## Blocked by\n- #99\n", { title: "Root" }),
      issueFacts: facts({ 47: { labels: ["2-agent-build"] } }),
      excluded: new Set<number>(),
    },
  ])("does not defer landing for a $name member the planner will not work", ({
    candidate,
    issueFacts,
    excluded,
  }) => {
    const result = resolvePlan(
      [candidate], issueFacts, excluded, 3, "review", membersOn(47, "Root", 47),
    );

    expect(result.plan).toEqual([]);
    expect(result.landedChunks[0]?.rework).toEqual([]);
  });

  it("ignores 3-human-review when git does not name the member", () => {
    const candidate = issue(47, "", { labels: ["2-agent-build", "3-human-review"] });
    const result = resolvePlan(
      [candidate], facts({ 47: { labels: ["2-agent-build"] } }),
      new Set(), 3, "review", new Map(),
    );
    expect(result.plan.map((p) => p.id)).toEqual(["47"]);
  });

  // #193: a landed member answers to the root its branch encodes, so the
  // chunk keeps that identity even when the graph alone would root it
  // elsewhere — here at #47, which never named a branch.
  it("keeps the identity of the branch a landed member is on", () => {
    const candidates = [
      issue(47, "", { title: "Root" }),
      issue(48, "## Blocked by\n- #47\n", { title: "Child" }),
    ];
    const result = resolvePlan(
      candidates,
      facts({ 47: {}, 48: { labels: ["2-agent-build"] } }),
      new Set(),
      3,
      "review",
      new Map([["sandbar/chunk-99-other", new Set([47])]]),
    );
    expect(result.plan).toEqual([expect.objectContaining({
      id: "48",
      chunk: {
        root: 99,
        branch: "sandbar/chunk-99-other",
        landed: [{ number: 47, title: "Root" }],
        seed: "tip",
      },
    })]);
    expect(result.landedChunks.map((c) => [c.root, c.branch])).toEqual([
      [99, "sandbar/chunk-99-other"],
    ]);
    expect(result.chunkNameDrifts).toEqual([]);
  });

  // A member ref inherited through the source branch sits on a later chunk's
  // branch too. Membership there still de-queues, but the member answers to
  // the chunk its root is connected to, so the later branch neither satisfies
  // its dependent nor lists it for review or closure.
  it("de-queues membership on any branch but does not satisfy from the wrong branch", () => {
    const candidates = [
      issue(47, "", { title: "Root" }),
      issue(48, "## Blocked by\n- #47\n", { title: "Child" }),
      issue(99, "", { title: "Other" }),
    ];
    const result = resolvePlan(
      candidates,
      facts({ 47: {}, 48: { labels: ["2-agent-build"] }, 99: {} }),
      new Set(),
      3,
      "review",
      new Map([
        ["sandbar/chunk-47-root", new Set([47])],
        ["sandbar/chunk-99-other", new Set([47, 99])],
      ]),
    );
    expect(result.plan.map((p) => [p.id, p.chunk?.branch])).toEqual([
      ["48", "sandbar/chunk-47-root"],
    ]);
    expect(
      result.landedChunks.map((c) => [c.branch, c.members.map((m) => m.number)]),
    ).toEqual([
      ["sandbar/chunk-47-root", [47]],
      ["sandbar/chunk-99-other", [99]],
    ]);
    expect(result.chunkNameDrifts).toEqual([]);
  });

  it("reports a branch whose members all answer to another chunk", () => {
    const result = resolvePlan(
      [issue(47, "", { title: "Root" })],
      facts({ 47: {} }),
      new Set(),
      3,
      "review",
      new Map([
        ["sandbar/chunk-47-root", new Set([47])],
        ["sandbar/chunk-99-other", new Set([47])],
      ]),
    );
    expect(result.chunkNameDrifts).toEqual([{
      existing: "sandbar/chunk-99-other",
      root: 99,
      members: [{ number: 47, title: "Root" }],
      cause: { kind: "orphaned" },
    }]);
  });

  it("keeps the origin branch when the root title changes", () => {
    const result = resolvePlan(
      [issue(47, "", { title: "New title" })],
      facts({ 47: {} }),
      new Set(),
      3,
      "review",
      new Map([["sandbar/chunk-47-old-title", new Set([47])]]),
    );
    expect(result.plan).toEqual([]);
    expect(result.landedChunks[0]?.branch).toBe("sandbar/chunk-47-old-title");
    expect(result.landedChunks[0]?.members).toEqual([
      { number: 47, title: "New title" },
    ]);
    expect(result.chunkNameDrifts).toEqual([]);
  });

  it("seeds new work onto the sole origin branch even before it has member refs", () => {
    const result = resolvePlan(
      [issue(47, "", { title: "New title" })],
      facts({ 47: { labels: ["2-agent-build"] } }),
      new Set(),
      3,
      "review",
      new Map([["sandbar/chunk-47-old-title", new Set<number>()]]),
    );
    expect(result.plan).toEqual([expect.objectContaining({
      id: "47",
      chunk: expect.objectContaining({
        root: 47,
        branch: "sandbar/chunk-47-old-title",
      }),
    })]);
    expect(result.chunkNameDrifts).toEqual([]);
  });

  it("refuses to choose between two origin branches for one root", () => {
    const result = resolvePlan(
      [
        issue(47, "", { title: "Current title" }),
        issue(48, "## Blocked by\n- #47\n", { title: "Child" }),
      ],
      facts({ 47: {}, 48: {} }),
      new Set(),
      3,
      "review",
      new Map([
        ["sandbar/chunk-47-old-title", new Set([47])],
        ["sandbar/chunk-47-current-title", new Set<number>()],
      ]),
    );
    expect(result.plan).toEqual([]);
    expect(result.landedChunks).toEqual([]);
    expect(result.chunkNameDrifts).toEqual([
      {
        existing: "sandbar/chunk-47-current-title",
        root: 47,
        members: [],
        cause: {
          kind: "ambiguous",
          competing: [
            "sandbar/chunk-47-current-title",
            "sandbar/chunk-47-old-title",
          ],
        },
      },
      {
        existing: "sandbar/chunk-47-old-title",
        root: 47,
        members: [{ number: 47, title: "Current title" }],
        cause: {
          kind: "ambiguous",
          competing: [
            "sandbar/chunk-47-current-title",
            "sandbar/chunk-47-old-title",
          ],
        },
      },
    ]);
  });

  it("holds eligible work when the current-title branch has an ambiguous twin", () => {
    const current = "sandbar/chunk-47-current-title";
    const result = resolvePlan(
      [
        issue(47, "", { title: "Current title" }),
        issue(48, "## Blocked by\n- #47\n", { title: "Child" }),
      ],
      facts({
        47: { labels: ["2-agent-build"] },
        48: { labels: ["2-agent-build"] },
      }),
      new Set(),
      3,
      "review",
      new Map([
        [current, new Set([47])],
        ["sandbar/chunk-47-old-title", new Set<number>()],
      ]),
    );

    expect(result.plan).toEqual([]);
    expect(result.waiting).toEqual([
      {
        issue: 47,
        title: "Current title",
        reason: { kind: "held", why: "drifted-branches" },
      },
      {
        issue: 48,
        title: "Child",
        reason: { kind: "blocked", by: [47] },
      },
    ]);
    expect(result.landedChunks).toEqual([]);
  });

  // #193: a lower-numbered root joining later never renames an underway
  // chunk. The new prerequisite joins #47's chunk as one more parentless
  // member, seeded from the source branch and merged onto the same branch.
  it("joins a new lower-numbered root to the underway chunk without drift", () => {
    const result = resolvePlan(
      [
        issue(40, "", { title: "New prerequisite" }),
        issue(47, "## Blocked by\n- #40\n", { title: "Root" }),
        issue(48, "## Blocked by\n- #47\n", { title: "Child" }),
      ],
      facts({
        40: { labels: ["2-agent-build"] },
        47: {},
        48: { labels: ["2-agent-build"] },
      }),
      new Set(),
      3,
      "review",
      new Map([["sandbar/chunk-47-root", new Set([47])]]),
    );
    expect(result.chunkNameDrifts).toEqual([]);
    expect(result.plan.map((p) => [p.id, p.chunk])).toEqual([
      ["40", {
        root: 47,
        branch: "sandbar/chunk-47-root",
        landed: [{ number: 47, title: "Root" }],
        seed: "source",
      }],
      ["48", {
        root: 47,
        branch: "sandbar/chunk-47-root",
        landed: [{ number: 47, title: "Root" }],
        seed: "tip",
      }],
    ]);
  });

  // #193, item 7: a wrap-up closes in `closeOrder` and stops at the first
  // failure, keeping the branch for the reconciler's retry. Whatever prefix
  // closed, the closed members are still on the kept branch and come back
  // through their member refs, so the retry finds the same chunk, root,
  // branch, members and close order — for a multi-root chunk too.
  const series = [
    issue(677, "## Blocked by\n- #752\n- #753\n- #754\n", { title: "Final" }),
    issue(751, "", { title: "First root" }),
    issue(752, "## Blocked by\n- #751\n", { title: "Second" }),
    issue(753, "", { title: "Other root" }),
    issue(754, "", { title: "Third root" }),
  ];
  const seriesBranch = "sandbar/chunk-751-first-root";
  const closeOrder = [677, 754, 753, 752, 751];
  it.each([0, 1, 2, 3, 4])(
    "re-derives a multi-root chunk whole after %i closes succeeded",
    (closedCount) => {
      const closedNow = new Set(closeOrder.slice(0, closedCount));
      const result = resolvePlan(
        series,
        facts(Object.fromEntries(series.map((c) => [
          c.number,
          closedNow.has(c.number) ? { state: "CLOSED" as const } : {},
        ]))),
        new Set(),
        3,
        "review",
        new Map([[seriesBranch, new Set(closeOrder)]]),
      );
      expect(result.chunkNameDrifts).toEqual([]);
      expect(result.landedChunks).toHaveLength(1);
      const [chunk] = result.landedChunks;
      expect(chunk?.root).toBe(751);
      expect(chunk?.branch).toBe(seriesBranch);
      expect(chunk?.members.map((m) => m.number)).toEqual([677, 751, 752, 753, 754]);
      expect(chunk?.closeOrder.map((m) => m.number)).toEqual(closeOrder);
    },
  );

  it("reports an origin chunk whose root has left the graph", () => {
    const result = resolvePlan(
      [],
      new Map(),
      new Set(),
      3,
      "review",
      new Map([["sandbar/chunk-47-root", new Set([47])]]),
    );
    expect(result.chunkNameDrifts).toEqual([{
      existing: "sandbar/chunk-47-root",
      root: 47,
      members: [{ number: 47, title: "" }],
      cause: { kind: "orphaned" },
    }]);
  });
});

// #63, #64 — the derivation the plan carries for the two phases that act on a
// chunk as a whole. Both exist because only this function has the candidate
// graph: nothing downstream of the plan could name the chunks with work on
// origin, what each branch carries or what is at its tip, and nothing that
// lists issues could see one filed sixty seconds ago.
describe("resolvePlan landed chunks (#63, #64)", () => {
  it("intersects inherited refs with each derived chunk's component", () => {
    // Inheritance alone cannot make #10 a member of #20's edge-disjoint
    // component: landedChunksOf provides that independent boundary. The title-
    // drift case above is where exact derived-branch membership is the sole
    // guard, because the old branch's member remains in the same component.
    const r = resolvePlan(
      [issue(10, "", { title: "Alpha" }), issue(20, "", { title: "Beta" })],
      facts({ 10: {}, 20: {} }),
      new Set(),
      3,
      "review",
      new Map([
        ["sandbar/chunk-10-alpha", new Set([10])],
        ["sandbar/chunk-20-beta", new Set([10, 20])],
      ]),
    );
    expect(r.landedChunks.map((chunk) => ({
      branch: chunk.branch,
      members: chunk.members.map((member) => member.number),
      closeOrder: chunk.closeOrder.map((member) => member.number),
    }))).toEqual([
      { branch: "sandbar/chunk-10-alpha", members: [10], closeOrder: [10] },
      { branch: "sandbar/chunk-20-beta", members: [20], closeOrder: [20] },
    ]);
  });

  it("reports a chunk with work on origin: what its branch carries, and the tips", () => {
    const r = resolvePlan(
      [
        issue(10, "", { title: "Root" }),
        issue(11, "## Blocked by\n- #10\n", {
          title: "Second",
        }),
        issue(12, "## Blocked by\n- #11\n", { title: "Queued" }),
      ],
      facts({ 10: {}, 11: {} }),
      new Set(),
      3,
      "review",
      membersOn(10, "Root", 10, 11),
    );

    expect(r.landedChunks).toEqual([
      {
        root: 10,
        branch: "sandbar/chunk-10-root",
        base: null,
        title: "Root",
        members: [
          { number: 10, title: "Root" },
          { number: 11, title: "Second" },
        ],
        closeOrder: [
          { number: 11, title: "Second" },
          { number: 10, title: "Root" },
        ],
        rework: [],
        tips: [{ number: 11, title: "Second" }],
      },
    ]);
  });

  it("keeps a closed root in the graph and closes it last", () => {
    const r = resolvePlan(
      [
        issue(10, "", { title: "Root" }),
        issue(11, "## Blocked by\n- #10\n", { title: "Second" }),
      ],
      facts({ 10: { state: "CLOSED" }, 11: {} }),
      new Set(),
      3,
      "review",
      membersOn(10, "Root", 10, 11),
    );

    expect(r.landedChunks[0]?.branch).toBe("sandbar/chunk-10-root");
    expect(r.landedChunks[0]?.closeOrder.map((member) => member.number)).toEqual([
      11,
      10,
    ]);
  });

  it("leaves a member that has never landed off the list a landing CLOSES", () => {
    // #64's whole correctness: #12 above is in the chunk's COMPONENT and is
    // planned this very cycle, but no commit of it is anywhere. Closing it
    // when the chunk lands would destroy queued work and tell a human it had
    // landed, so `members` is the branch-history set and never `Chunk.members`.
    const r = resolvePlan(
      [
        issue(10, "", { title: "Root" }),
        issue(11, "## Blocked by\n- #10\n", { title: "Queued" }),
      ],
      facts({ 10: {} }),
      new Set(),
      3,
      "review",
      membersOn(10, "Root", 10),
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
      [issue(10, "")],
      facts({ 10: {} }),
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
    // is already named by the exact chunk branch.
    const r = resolvePlan(
      [
        issue(10, "", { title: "Root" }),
        issue(50, "## Blocked by\n- #10\n", { title: "Chunk #10: address review feedback" }),
      ],
      facts({ 10: {} }),
      new Set(),
      3,
      "review",
      membersOn(10, "Root", 10),
    );

    expect(r.plan.map((p) => p.id)).toEqual(["50"]);
    expect(r.plan[0]?.chunk?.branch).toBe("sandbar/chunk-10-root");
  });
});

// #193 — chunks are components under `## Blocked by` edges in both
// directions, underway chunks keep their identity, and fresh ones wait for
// the pending graph to hold still across two polls.
describe("resolvePlan multi-root chunks (#193)", () => {
  const series = [
    issue(677, "## Blocked by\n- #752\n- #753\n- #754\n", { title: "Final" }),
    issue(751, "", { title: "First root" }),
    issue(752, "## Blocked by\n- #751\n", { title: "Second" }),
    issue(753, "", { title: "Other root" }),
    issue(754, "", { title: "Third root" }),
  ];
  const resolve = (opts: {
    readonly settledGraph?: string | null;
    readonly inFlight?: ReadonlyMap<number, ChunkTarget | null>;
    readonly chunkMembers?: ReadonlyMap<string, ReadonlySet<number>>;
    readonly ongoing?: ReadonlySet<number>;
  }) =>
    resolvePlanDecision(series, new Map(), {
      defaultLane: "review",
      readyLabelPolicy: "anyone",
      k: 5,
      ...opts,
    });

  it("works every root of a fresh series in parallel, all onto one branch", () => {
    const r = resolve({});
    const target = {
      root: 751,
      branch: "sandbar/chunk-751-first-root",
      landed: [],
      seed: "source",
    };
    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      ["751", target],
      ["753", target],
      ["754", target],
    ]);
  });

  it("holds a fresh series until two polls have seen the same graph", () => {
    const first = resolve({ settledGraph: null });
    expect(first.plan).toEqual([]);
    expect(first.waiting.filter((w) => w.reason.kind === "held").map((w) => w.issue))
      .toEqual([751, 753, 754]);
    expect(first.pendingChunkGraph).toBe("677<752,753,754 751 752<751 753 754");

    const second = resolve({ settledGraph: first.pendingChunkGraph });
    expect(second.plan.map((p) => p.id)).toEqual(["751", "753", "754"]);
  });

  it("lets an in-flight root's target name the chunk others join", () => {
    // #753 was dispatched alone before the rest of the series was filed. The
    // series now joins #753's chunk rather than re-rooting at #751, and needs
    // no settling to do it.
    const r = resolve({
      settledGraph: null,
      ongoing: new Set([753]),
      inFlight: new Map([[753, { root: 753, branch: "sandbar/chunk-753-other-root" }]]),
    });
    expect(r.plan.map((p) => [p.id, p.chunk?.root, p.chunk?.branch, p.chunk?.seed]))
      .toEqual([
        ["751", 753, "sandbar/chunk-753-other-root", "source"],
        ["754", 753, "sandbar/chunk-753-other-root", "source"],
      ]);
    expect(r.pendingChunkGraph).toBe("");
  });

  it("seeds a not-yet-landed root from the source even once the branch exists", () => {
    const r = resolve({
      chunkMembers: new Map([["sandbar/chunk-751-first-root", new Set([751])]]),
    });
    expect(r.plan.map((p) => [p.id, p.chunk?.seed])).toEqual([
      ["752", "tip"],
      ["753", "source"],
      ["754", "source"],
    ]);
  });
});

describe("resolvePlan frozen and stacked chunks (#243)", () => {
  const F = chunkBranchName(10, "Issue 10");
  const C = chunkBranchName(50, "Issue 50", 10);
  const chain = [
    issue(10, ""),
    issue(11, "## Blocked by\n- #10\n"),
  ];
  const resolveWith = (
    candidates: readonly IssueSummary[],
    issueFacts: ReadonlyMap<number, IssueFacts>,
    options: {
      readonly chunkMembers: ReadonlyMap<string, ReadonlySet<number>>;
      readonly frozenChunks?: ReadonlySet<string>;
      readonly chunksContainingBase?: ReadonlySet<string>;
    },
  ): PlanResolution =>
    resolvePlanDecision(candidates, issueFacts, {
      readyLabelPolicy: "anyone",
      defaultLane: "review",
      ...options,
    });

  it("plans a new issue blocked by a frozen chunk's member onto a chunk stacked on its tip", () => {
    const r = resolveWith(
      [...chain, issue(50, "## Blocked by\n- #11\n")],
      facts({ 10: {}, 11: {} }),
      { chunkMembers: new Map([[F, new Set([10, 11])]]), frozenChunks: new Set([F]) },
    );
    expect(r.plan.map((p) => [p.id, p.chunk])).toEqual([
      ["50", { root: 50, branch: C, landed: [], seed: "tip", base: F }],
    ]);
    expect(r.chunkRefreshes).toEqual([]);
  });

  it("holds rework of a frozen chunk's member, which keeps its landing waiting", () => {
    const r = resolveWith(
      chain,
      facts({ 10: {}, 11: { labels: ["2-agent-build"] } }),
      { chunkMembers: new Map([[F, new Set([10, 11])]]), frozenChunks: new Set([F]) },
    );
    expect(r.plan).toEqual([]);
    expect(r.waiting).toEqual([
      { issue: 11, title: "Issue 11", reason: { kind: "held", why: "frozen" } },
    ]);
    expect(r.landedChunks.map((c) => c.rework)).toEqual([[{ number: 11, title: "Issue 11" }]]);
  });

  it("refreshes a stacked chunk onto a base that moved before admitting its next member", () => {
    // #12 landed on the base after `land` came off; #51 needs it and #50.
    const candidates = [
      ...chain,
      issue(12, "## Blocked by\n- #11\n"),
      issue(50, "## Blocked by\n- #11\n"),
      issue(51, "## Blocked by\n- #12\n- #50\n"),
    ];
    const chunkMembers = new Map([
      [F, new Set([10, 11, 12])],
      [C, new Set([10, 11, 50])],
    ]);
    const stale = resolveWith(candidates, facts({ 10: {}, 11: {}, 12: {}, 50: {} }), {
      chunkMembers,
    });
    expect(stale.plan).toEqual([]);
    expect(stale.waiting).toEqual([
      { issue: 51, title: "Issue 51", reason: { kind: "chunk-refresh", branch: C, by: [] } },
    ]);
    expect(stale.chunkRefreshes).toEqual([{
      root: 50,
      branch: C,
      base: F,
      title: "Issue 50",
      dependents: [{ number: 51, title: "Issue 51" }],
    }]);

    const caughtUp = resolveWith(candidates, facts({ 10: {}, 11: {}, 12: {}, 50: {} }), {
      chunkMembers: new Map([[F, new Set([10, 11, 12])], [C, new Set([10, 11, 12, 50])]]),
      chunksContainingBase: new Set([C]),
    });
    expect(caughtUp.plan.map((p) => [p.id, p.chunk?.branch, p.chunk?.base])).toEqual([
      ["51", C, F],
    ]);
  });

  it("refreshes a stacked chunk onto a base that moved with no member waiting", () => {
    // Rework landed on the base after `land` came off: same members, new tip.
    const candidates = [...chain, issue(50, "## Blocked by\n- #11\n")];
    const issueFacts = facts({ 10: {}, 11: {}, 50: {} });
    const chunkMembers = new Map([[F, new Set([10, 11])], [C, new Set([10, 11, 50])]]);
    expect(resolveWith(candidates, issueFacts, { chunkMembers }).chunkRefreshes).toEqual([{
      root: 50,
      branch: C,
      base: F,
      title: "Issue 50",
      dependents: [],
    }]);
    expect(resolveWith(candidates, issueFacts, {
      chunkMembers,
      chunksContainingBase: new Set([C]),
    }).chunkRefreshes).toEqual([]);
    // A frozen stacked chunk takes nothing, its base included.
    expect(resolveWith(candidates, issueFacts, {
      chunkMembers,
      frozenChunks: new Set([C]),
    }).chunkRefreshes).toEqual([]);
  });

  it("holds a stacked member whose frozen base lacks a blocker that closed since", () => {
    const r = resolveWith(
      [...chain, issue(50, "## Blocked by\n- #11\n- #9\n")],
      facts({ 9: { state: "CLOSED" }, 10: {}, 11: {} }),
      { chunkMembers: new Map([[F, new Set([10, 11])]]), frozenChunks: new Set([F]) },
    );
    expect(r.plan).toEqual([]);
    expect(r.waiting).toEqual([
      { issue: 50, title: "Issue 50", reason: { kind: "held", why: "frozen" } },
    ]);
    expect(r.chunkRefreshes).toEqual([]);
  });

  it("reports a stacked chunk's base on what it carries", () => {
    const r = resolveWith(
      [...chain, issue(50, "## Blocked by\n- #11\n")],
      facts({ 10: {}, 11: {}, 50: {} }),
      { chunkMembers: new Map([[F, new Set([10, 11])], [C, new Set([10, 11, 50])]]) },
    );
    expect(r.landedChunks.map((c) => [c.branch, c.base, c.members.map((m) => m.number)])).toEqual([
      [F, null, [10, 11]],
      [C, F, [50]],
    ]);
    expect(r.chunkNameDrifts).toEqual([]);
  });
});
