// #62 — the review surface's prose. These are the sentences a human reads
// before deciding whether a chunk lands, so what they must not do is claim
// something sandbar does not do.
import { describe, expect, it } from "vitest";

import { LAND_LABEL } from "./chunk-land.js";

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

  it("invites the one label that lands the chunk (#64)", () => {
    // #62 held this sentence back because no code watched the label. #64 built
    // the mechanism, so the invitation is written — and it names the LABEL, not
    // an approval, because approve-now-land-later is the workflow the trigger
    // was chosen to keep.
    const b = body();
    expect(b).toContain(`\`${LAND_LABEL}\` label on this pull request`);
    expect(b).toMatch(/[Aa]pproving is not the trigger/);
  });

  it("says what landing actually does, so the label is not a leap of faith", () => {
    const b = body();
    expect(b).toContain("closes every issue above");
    expect(b).toContain("deletes the branch");
  });

  it("still says a hand-merge is recovered from rather than forbidden", () => {
    // The draft state makes the accident hard; the reconciler is what makes it
    // survivable, and a reviewer who did it anyway needs to know that.
    expect(body()).toMatch(/already contained in/);
  });
});
