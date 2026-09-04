import { describe, expect, it } from "vitest";
import type { LandedChunk } from "./chunks.js";
import { type ChangesRequestedReview, type ChunkPullRequestState, type ReviewThread, convertedReviewIds, followUpMarker, ledgerComment, memberReviewComment, pendingFollowUps, routeFollowUp, unresolvedThreadsFor } from "./chunk-follow-up.js";

const review = (id: string, body = ""): ChangesRequestedReview => ({ id, url: `https://example.test/reviews/${id}`, author: "alice", body });
const thread = (id: string, path: string): ReviewThread => ({ path, isResolved: false, comments: [{ author: "alice", body: `fix ${path}`, url: `https://example.test/${path}`, reviewId: id }] });
const chunk: LandedChunk = {
  root: 40, branch: "sandbar/chunk-40-root", title: "Root",
  members: [{ number: 40, title: "Root" }, { number: 42, title: "Tip" }, { number: 44, title: "Other tip" }],
  closeOrder: [{ number: 42, title: "Tip" }, { number: 44, title: "Other tip" }, { number: 40, title: "Root" }], rework: [],
  tips: [{ number: 42, title: "Tip" }, { number: 44, title: "Other tip" }],
};

describe("review ledger", () => {
  it("reads markers independently of their surrounding prose", () => {
    expect([...convertedReviewIds([`different ${followUpMarker("PRR_a")}`])]).toEqual(["PRR_a"]);
  });
  it("skips handled and empty reviews but retains body-only reviews", () => {
    const pr: ChunkPullRequestState = { number: 7, url: "u", comments: [followUpMarker("done")], reviews: [review("done"), review("empty"), review("body", "Please rework")], threads: [] };
    expect(pendingFollowUps(pr).map((p) => p.review.id)).toEqual(["body"]);
  });
  it("keeps unresolved threads a later review replied in", () => {
    const t: ReviewThread = { ...thread("old", "a.ts"), comments: [...thread("old", "a.ts").comments, { author: "alice", body: "still wrong", url: "u", reviewId: "new" }] };
    expect(unresolvedThreadsFor("new", [t])).toEqual([t]);
  });
});

describe("routeFollowUp", () => {
  const paths = new Map<number, ReadonlySet<string>>([[40, new Set(["root.ts", "shared.ts"])], [42, new Set(["tip.ts", "shared.ts"])], [44, new Set(["other.ts"])] ]);
  it("routes a uniquely owned path to that member", () => {
    expect(routeFollowUp(chunk, { review: review("r"), threads: [thread("r", "other.ts")] }, paths).map((r) => r.member.number)).toEqual([44]);
  });
  it("routes absent and ambiguous paths to the lowest-numbered tip", () => {
    const routed = routeFollowUp(chunk, { review: review("r"), threads: [thread("r", "missing.ts"), thread("r", "shared.ts")] }, paths);
    expect(routed[0]?.member.number).toBe(42); expect(routed[0]?.threads).toHaveLength(2);
  });
  it("groups one review into one comment per member", () => {
    const routed = routeFollowUp(chunk, { review: review("r"), threads: [thread("r", "root.ts"), thread("r", "other.ts")] }, paths);
    expect(routed.map((r) => [r.member.number, r.threads.map((t) => t.path)])).toEqual([[40, ["root.ts"]], [44, ["other.ts"]]]);
  });
  it("routes a body-only review to the lowest-numbered tip", () => {
    expect(routeFollowUp(chunk, { review: review("r", "Rework it"), threads: [] }, paths)[0]?.member.number).toBe(42);
  });
});

describe("review prose", () => {
  it("quotes only the routed threads in a member comment", () => {
    const out = memberReviewComment({ root: 40, branch: chunk.branch, prNumber: 7, review: review("r", "Overall"), threads: [thread("r", "other.ts")] });
    expect(out).toContain("Overall"); expect(out).toContain("other.ts"); expect(out).not.toContain("root.ts");
  });
  it("records every routed member and the review marker on the PR", () => {
    const out = ledgerComment({ review: review("r"), issueNumbers: [40, 44], branch: chunk.branch });
    expect(out).toContain("#40 and #44"); expect(out).toContain("re-queued them"); expect(out).toContain(followUpMarker("r"));
  });
});
