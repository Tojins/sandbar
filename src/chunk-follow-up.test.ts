// #63 — the decisions and the prose that turn a changes-requested review into a
// chunk issue.
//
// Two things here are load-bearing rather than cosmetic. The LEDGER decides
// whether a review is filed again next cycle, so the "already converted" case
// is the difference between one issue and one per cycle forever. And the
// `## Blocked by` section is what puts the issue in the chunk at all, so it is
// asserted by parsing it back with the planner's own parser — including
// against a review body written to break it.
import { describe, expect, it } from "vitest";

import type { LandedChunk } from "./chunks.js";
import {
  type ChangesRequestedReview,
  type ChunkPullRequestState,
  type ReviewThread,
  convertedReviewIds,
  followUpIssueBody,
  followUpIssueContent,
  followUpIssueTitle,
  followUpMarker,
  ledgerComment,
  pendingFollowUps,
  unresolvedThreadsFor,
} from "./chunk-follow-up.js";
import { parseBlockedBy } from "./plan-resolver.js";

const review = (
  id: string,
  opts: { author?: string; body?: string } = {},
): ChangesRequestedReview => ({
  id,
  url: `https://github.com/acme/app/pull/7#pullrequestreview-${id}`,
  author: opts.author ?? "alice",
  body: opts.body ?? "",
});

const thread = (
  reviewId: string,
  opts: { resolved?: boolean; path?: string; body?: string } = {},
): ReviewThread => ({
  path: opts.path ?? "src/merger.ts",
  isResolved: opts.resolved ?? false,
  comments: [
    {
      author: "alice",
      body: opts.body ?? "This drops the error.",
      url: "https://github.com/acme/app/pull/7#discussion_r1",
      reviewId,
    },
  ],
});

const pr = (
  parts: Partial<ChunkPullRequestState> = {},
): ChunkPullRequestState => ({
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  reviews: [],
  threads: [],
  comments: [],
  ...parts,
});

const chunk: LandedChunk = {
  root: 42,
  branch: "sandbar/chunk-42-first",
  landed: [
    { number: 42, title: "First" },
    { number: 43, title: "Second" },
  ],
  tips: [{ number: 43, title: "Second" }],
};

describe("convertedReviewIds", () => {
  it("reads every marker the pull request's comments carry", () => {
    expect([
      ...convertedReviewIds([
        `filed #99 ${followUpMarker("PRR_a")}`,
        "a human's comment about something else",
        `filed #100\n\n${followUpMarker("PRR_b")}`,
      ]),
    ]).toEqual(["PRR_a", "PRR_b"]);
  });

  it("is empty for a pull request nobody has filed against", () => {
    expect([...convertedReviewIds(["looks good to me", ""])]).toEqual([]);
  });

  it("matches the marker, not the prose around it", () => {
    // The ledger comment is reworded whenever this module's prose changes; a
    // match on the sentence would re-file every open chunk's reviews the day
    // it did.
    expect([
      ...convertedReviewIds([`totally different words ${followUpMarker("PRR_a")}`]),
    ]).toEqual(["PRR_a"]);
  });
});

describe("unresolvedThreadsFor", () => {
  it("takes the review's own unresolved threads and no others", () => {
    const mine = thread("PRR_a");
    const theirs = thread("PRR_b");
    const settled = thread("PRR_a", { resolved: true });
    expect(unresolvedThreadsFor("PRR_a", [mine, theirs, settled])).toEqual([mine]);
  });

  it("counts a thread a later review REPLIED in", () => {
    // A second pass that answers inside an existing thread is asking for
    // something now; keying on the opening comment would file an issue
    // quoting the review body and none of the substance.
    const replied: ReviewThread = {
      path: "src/run.ts",
      isResolved: false,
      comments: [
        { author: "alice", body: "first pass", url: "u1", reviewId: "PRR_a" },
        { author: "alice", body: "still wrong", url: "u2", reviewId: "PRR_b" },
      ],
    };
    expect(unresolvedThreadsFor("PRR_b", [replied])).toEqual([replied]);
  });
});

describe("pendingFollowUps", () => {
  it("files one issue per unconverted changes-requested review", () => {
    const state = pr({
      reviews: [review("PRR_a"), review("PRR_b")],
      threads: [thread("PRR_a"), thread("PRR_b")],
    });
    expect(pendingFollowUps(state).map((p) => p.review.id)).toEqual([
      "PRR_a",
      "PRR_b",
    ]);
  });

  it("skips a review the ledger already names", () => {
    // The whole idempotence claim: the threads are still unresolved and the
    // review is still CHANGES_REQUESTED, which is the steady state of every
    // converted review forever.
    const state = pr({
      reviews: [review("PRR_a")],
      threads: [thread("PRR_a")],
      comments: [`filed #99 ${followUpMarker("PRR_a")}`],
    });
    expect(pendingFollowUps(state)).toEqual([]);
  });

  it("skips a review with nothing left to ask for", () => {
    // Every thread resolved and no body: the human said what they wanted and
    // then said it was done.
    const state = pr({
      reviews: [review("PRR_a")],
      threads: [thread("PRR_a", { resolved: true })],
    });
    expect(pendingFollowUps(state)).toEqual([]);
  });

  it("files a review that is body-only", () => {
    const state = pr({ reviews: [review("PRR_a", { body: "Rework this." })] });
    expect(pendingFollowUps(state).map((p) => p.review.id)).toEqual(["PRR_a"]);
    expect(pendingFollowUps(state)[0]?.threads).toEqual([]);
  });

  it("files a review whose threads are unresolved even with an empty body", () => {
    const state = pr({
      reviews: [review("PRR_a")],
      threads: [thread("PRR_a")],
    });
    expect(pendingFollowUps(state).map((p) => p.review.id)).toEqual(["PRR_a"]);
  });
});

describe("followUpIssueTitle", () => {
  it("names the chunk and the reviewer", () => {
    expect(followUpIssueTitle(42, review("PRR_a"))).toBe(
      "Chunk #42: address alice's review feedback",
    );
  });

  it("still names the chunk when the author is gone", () => {
    expect(followUpIssueTitle(42, review("PRR_a", { author: "" }))).toBe(
      "Chunk #42: address review feedback",
    );
  });
});

describe("followUpIssueBody", () => {
  const body = (
    opts: {
      review?: ChangesRequestedReview;
      threads?: readonly ReviewThread[];
      tips?: LandedChunk["tips"];
    } = {},
  ): string =>
    followUpIssueBody({
      root: 42,
      branch: "sandbar/chunk-42-first",
      prNumber: 7,
      review: opts.review ?? review("PRR_a", { body: "Two things." }),
      threads: opts.threads ?? [thread("PRR_a")],
      tips: opts.tips ?? chunk.tips,
    });

  it("declares the chunk's tips, and the planner reads them back", () => {
    // Not a formatting assertion: this section is what puts the issue in the
    // chunk, gates it, and holds it behind the work the review is about.
    expect(parseBlockedBy(body())).toEqual([43]);
  });

  it("declares every tip when the branch carries more than one", () => {
    expect(
      parseBlockedBy(
        body({
          tips: [
            { number: 43, title: "Second" },
            { number: 44, title: "Third" },
          ],
        }),
      ),
    ).toEqual([43, 44]);
  });

  it("survives a review body that writes a `## Blocked by` section of its own", () => {
    // Hostile input, and a human wrote it — quoting a blocked-by section back
    // at sandbar is a thing a reviewer does when discussing one. The section
    // sandbar wrote comes first and every quoted line is blockquoted, so the
    // parse is unchanged.
    const hostile = review("PRR_a", {
      body: "As discussed:\n\n## Blocked by\n- #999\n\nplease fix",
    });
    expect(parseBlockedBy(body({ review: hostile }))).toEqual([43]);
  });

  it("survives an issue reference inside a quoted thread", () => {
    expect(
      parseBlockedBy(
        body({ threads: [thread("PRR_a", { body: "see #123 for why" })] }),
      ),
    ).toEqual([43]);
  });

  it("quotes the review body and every thread comment", () => {
    const out = body();
    expect(out).toContain("> Two things.");
    expect(out).toContain("> This drops the error.");
    expect(out).toContain("`src/merger.ts`");
  });

  it("carries the review's marker, so the issue says where it came from", () => {
    expect(body()).toContain(followUpMarker("PRR_a"));
  });

  it("says so when a body-only review left no threads", () => {
    expect(body({ threads: [] })).toContain("no unresolved threads");
  });

  it("names the chunk, its branch and the pull request", () => {
    const out = body();
    expect(out).toContain("chunk #42");
    expect(out).toContain("sandbar/chunk-42-first");
    expect(out).toContain("#7");
  });
});

describe("followUpIssueContent", () => {
  it("is the title and body for one pending review", () => {
    const content = followUpIssueContent({
      chunk,
      prNumber: 7,
      pending: { review: review("PRR_a"), threads: [thread("PRR_a")] },
    });
    expect(content.title).toBe("Chunk #42: address alice's review feedback");
    expect(parseBlockedBy(content.body)).toEqual([43]);
  });
});

describe("ledgerComment", () => {
  it("names the issue it filed and carries the review's marker", () => {
    const out = ledgerComment({
      review: review("PRR_a"),
      issueNumber: 99,
      branch: "sandbar/chunk-42-first",
    });
    expect(out).toContain("#99");
    expect(out).toContain(followUpMarker("PRR_a"));
    // The comment is the ledger, so what it writes must be what the next scan
    // reads.
    expect([...convertedReviewIds([out])]).toEqual(["PRR_a"]);
  });

  it("says sandbar will not resolve the threads", () => {
    // The reviewer is the one who decides they are satisfied, and nothing in
    // the scan depends on their having done it.
    expect(
      ledgerComment({
        review: review("PRR_a"),
        issueNumber: 99,
        branch: "sandbar/chunk-42-first",
      }),
    ).toContain("does not resolve them");
  });
});
