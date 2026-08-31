// #62 — the review surface's prose. These are the sentences a human reads
// before deciding whether a chunk lands, so what they must not do is claim
// something sandbar does not do.
import { describe, expect, it } from "vitest";

import {
  chunkMembersOnBranch,
  chunkPullRequestBody,
  chunkPullRequestContent,
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
    // Reachable only if a member landed and its `in-chunk` flip failed, so it
    // is planned again; double-listing it would make the body a wrong record.
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
    chunkPullRequestBody({ branch: "sandbar/chunk-42-first", members });

  it("lists every member by number and title", () => {
    expect(body()).toContain("- #42 — First");
    expect(body()).toContain("- #43 — Second");
  });

  it("names the chunk branch", () => {
    expect(body()).toContain("sandbar/chunk-42-first");
  });

  it("says why the merge button is off and that the draft state is deliberate", () => {
    const b = body();
    expect(b).toContain("Draft on purpose");
    expect(b).toMatch(/merge\s+button/);
    expect(b).toMatch(/ready for review/);
  });

  it("says nothing has reached the base branch", () => {
    expect(body()).toMatch(/has reached the\nbase branch|reached the base branch/);
  });

  it("does not invite a label nothing reads yet", () => {
    // #62 sketches "apply the `land` label to land". There is no such label and
    // nothing that would watch one, and a review surface whose first
    // instruction does nothing is worse than one that stays quiet — the
    // sentence belongs to the issue that builds the mechanism.
    expect(body()).not.toMatch(/`land`/);
  });

  it("does not claim sandbar will land the reviewed chunk on its own", () => {
    // It cannot yet. The body may say the merge button is disabled by design;
    // it may not promise an automation that does not exist.
    expect(body()).toContain("not automated yet");
  });
});

describe("chunkPullRequestContent", () => {
  it("is the title and body for one chunk", () => {
    const content = chunkPullRequestContent({
      root: 42,
      branch: "sandbar/chunk-42-first",
      members: [member(42, "First")],
    });
    expect(content.title).toBe("Sandbar chunk #42: First");
    expect(content.body).toContain("- #42 — First");
  });
});
