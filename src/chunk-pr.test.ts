// #62 — the review surface's prose. These are the sentences a human reads
// before deciding whether a chunk lands, so what they must not do is claim
// something sandbar does not do.
import { describe, expect, it } from "vitest";

import {
  chunkMembersOnBranch,
  chunkPullRequestBody,
  chunkPullRequestTitle,
} from "./chunk-pr.js";

const member = (number: number, title = `t-${number}`) => ({ number, title });

describe("chunkMembersOnBranch", () => {
  it("unions the branch's earlier members with this cycle's, ascending", () => {
    // The whole point: a chunk grows one member per cycle, and a body built
    // from the merge phase's own knowledge would drop everything older.
    expect(
      chunkMembersOnBranch([member(42), member(44)], [member(43)]),
    ).toEqual([member(42), member(43), member(44)]);
  });

  it("lists an issue once, with the title read this cycle", () => {
    // Defensive against overlapping snapshots: the current cycle's tracker
    // title wins, and the body must never list a member twice.
    expect(
      chunkMembersOnBranch([member(42, "old title")], [member(42, "new title")]),
    ).toEqual([member(42, "new title")]);
  });

  it("is empty for an empty chunk and copes with either side being empty", () => {
    expect(chunkMembersOnBranch([], [])).toEqual([]);
    expect(chunkMembersOnBranch([], [member(1)])).toEqual([member(1)]);
    expect(chunkMembersOnBranch([member(1)], [])).toEqual([member(1)]);
  });
});

describe("chunkPullRequestTitle", () => {
  it("names the chunk by its root, with the root issue's title", () => {
    expect(chunkPullRequestTitle(42, [member(42, "Land the thing"), member(43)])).toBe(
      "Sandbar chunk #42: Land the thing",
    );
  });

  it("still identifies the chunk when the root is not among the members", () => {
    expect(chunkPullRequestTitle(42, [member(43)])).toBe("Sandbar chunk #42");
    expect(chunkPullRequestTitle(42, [member(42, "")])).toBe("Sandbar chunk #42");
  });
});

describe("chunkPullRequestBody", () => {
  const body = (members = [member(42, "First"), member(43, "Second")]): string =>
    chunkPullRequestBody({ members });

  it("is exactly the member list", () => {
    expect(body()).toBe("- #42 — First\n- #43 — Second");
  });
});
