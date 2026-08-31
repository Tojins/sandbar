// #64 — the pure half of landing a reviewed chunk: which chunks a `land` label
// asks for, which ones landed without sandbar, and the wrap-up that closes one
// out. The wrap-up is adapter-driven and never throws, so what is asserted here
// is the ORDER of its writes and where its residue comes from.
import { describe, expect, it } from "vitest";

import {
  CHUNK_LANDED_PR_COMMENT,
  CHUNK_LAND_ABANDONED_PR_COMMENT,
  CHUNK_MEMBER_CLOSED_COMMENT,
  type ChunkWrapupAdapter,
  LAND_LABEL,
  type PullRequestSummary,
  selectLandRequests,
  selectReconciliations,
  wrapUpLandedChunk,
} from "./chunk-land.js";
import { IN_CHUNK_LABEL, type NamedChunk } from "./chunks.js";

const chunk = (
  root: number,
  branch: string,
  members: readonly [number, string][],
  title = "root title",
): NamedChunk => ({
  root,
  branch,
  title,
  members: members.map(([number, t]) => ({ number, title: t })),
});

const pr = (
  number: number,
  headRefName: string,
  title = "pr title",
): PullRequestSummary => ({ number, headRefName, title });

describe("selectLandRequests (#64)", () => {
  it("matches a land-labelled PR to its derived chunk and takes its members", () => {
    const chunks = [
      chunk(42, "sandbar/chunk-42-alpha", [
        [42, "alpha"],
        [43, "beta"],
      ], "alpha"),
    ];
    expect(
      selectLandRequests([pr(9, "sandbar/chunk-42-alpha")], chunks),
    ).toEqual([
      {
        root: 42,
        branch: "sandbar/chunk-42-alpha",
        title: "alpha",
        members: [
          { number: 42, title: "alpha" },
          { number: 43, title: "beta" },
        ],
        pullRequest: 9,
      },
    ]);
  });

  it("keeps a chunk-branch PR the derivation does not know, with no members", () => {
    const [target] = selectLandRequests(
      [pr(9, "sandbar/chunk-42-alpha", "Sandbar chunk #42: alpha")],
      [],
    );
    expect(target).toEqual({
      root: 42,
      branch: "sandbar/chunk-42-alpha",
      title: "Sandbar chunk #42: alpha",
      members: [],
      pullRequest: 9,
    });
  });

  it("ignores a land label on a pull request that is not a chunk's", () => {
    expect(
      selectLandRequests(
        [pr(9, "feature/some-human-branch"), pr(10, "sandbar/issue-7-x")],
        [],
      ),
    ).toEqual([]);
  });

  it("takes the lowest-numbered PR when a head somehow has two, and sorts by root", () => {
    const targets = selectLandRequests(
      [
        pr(30, "sandbar/chunk-9-b"),
        pr(20, "sandbar/chunk-42-a"),
        pr(11, "sandbar/chunk-42-a"),
      ],
      [],
    );
    expect(targets.map((t) => [t.root, t.pullRequest])).toEqual([
      [9, 30],
      [42, 11],
    ]);
  });
});

describe("selectReconciliations (#64)", () => {
  it("pairs a landed branch with its chunk and its open pull request", () => {
    const targets = selectReconciliations(
      ["sandbar/chunk-42-alpha"],
      [chunk(42, "sandbar/chunk-42-alpha", [[42, "alpha"]], "alpha")],
      [pr(9, "sandbar/chunk-42-alpha")],
    );
    expect(targets).toEqual([
      {
        root: 42,
        branch: "sandbar/chunk-42-alpha",
        title: "alpha",
        members: [{ number: 42, title: "alpha" }],
        pullRequest: 9,
      },
    ]);
  });

  it("reconciles a landed branch whose PR a human already closed", () => {
    const [target] = selectReconciliations(
      ["sandbar/chunk-42-alpha"],
      [chunk(42, "sandbar/chunk-42-alpha", [[42, "alpha"]], "alpha")],
      [],
    );
    expect(target?.pullRequest).toBe(0);
    expect(target?.members).toEqual([{ number: 42, title: "alpha" }]);
  });

  it("dedupes branches and drops anything that is not a chunk branch", () => {
    const targets = selectReconciliations(
      [
        "sandbar/chunk-42-alpha",
        "sandbar/chunk-42-alpha",
        "sandbar/issue-42-alpha",
      ],
      [],
      [],
    );
    expect(targets.map((t) => t.branch)).toEqual(["sandbar/chunk-42-alpha"]);
  });
});

// ---------------------------------------------------------------------------

type Recorded = { readonly op: string; readonly arg: string };

function makeWrapupAdapter(
  fail: Partial<Record<string, string>> = {},
): {
  adapter: ChunkWrapupAdapter;
  calls: Recorded[];
  // The bodies the wrap-up wrote, which is where the "what may this claim?"
  // assertions live: the templates are pure and tested directly, so what is
  // worth pinning here is which of them the wrap-up chose to send.
  bodies: string[];
} {
  const calls: Recorded[] = [];
  const bodies: string[] = [];
  const record = (op: string, arg: string): void => {
    calls.push({ op, arg });
    const err = fail[`${op}:${arg}`] ?? fail[op];
    if (err) throw new Error(err);
  };
  return {
    calls,
    bodies,
    adapter: {
      async closeIssue(n, comment) {
        // After `record`, which is what throws: a close that failed posted no
        // comment, so it must not leave one here either.
        record("closeIssue", String(n));
        bodies.push(comment);
      },
      async removeLabel(n, label) {
        record("removeLabel", `${n}:${label}`);
      },
      async commentOnPullRequest(p, body) {
        record("commentOnPullRequest", String(p));
        bodies.push(body);
      },
      async closePullRequest(p) {
        record("closePullRequest", String(p));
      },
      async deleteChunkBranch(b) {
        record("deleteChunkBranch", b);
      },
    },
  };
}

const target = {
  root: 42,
  branch: "sandbar/chunk-42-alpha",
  title: "alpha",
  members: [
    { number: 42, title: "alpha" },
    { number: 43, title: "beta" },
  ],
  pullRequest: 9,
};

describe("wrapUpLandedChunk (#64)", () => {
  it("closes every member, drops in-chunk, closes the PR, deletes the branch", async () => {
    const { adapter, calls } = makeWrapupAdapter();
    const r = await wrapUpLandedChunk(target, adapter, {
      sourceBranch: "main",
      provenance: "sandbar",
    });
    expect(r.residue).toEqual([]);
    expect(r.closed).toEqual([42, 43]);
    expect(r.branchDeleted).toBe(true);
    expect(calls.map((c) => `${c.op} ${c.arg}`)).toEqual([
      "closeIssue 42",
      `removeLabel 42:${IN_CHUNK_LABEL}`,
      "closeIssue 43",
      `removeLabel 43:${IN_CHUNK_LABEL}`,
      "commentOnPullRequest 9",
      "closePullRequest 9",
      "deleteChunkBranch sandbar/chunk-42-alpha",
    ]);
  });

  it("keeps the branch when a member could not be closed, so the next run retries", async () => {
    const { adapter, calls } = makeWrapupAdapter({ "closeIssue:43": "gh boom" });
    const r = await wrapUpLandedChunk(target, adapter, {
      sourceBranch: "main",
      provenance: "sandbar",
    });
    expect(r.closed).toEqual([42]);
    expect(r.branchDeleted).toBe(false);
    expect(calls.some((c) => c.op === "deleteChunkBranch")).toBe(false);
    // And the un-closed member KEEPS `in-chunk`: an open issue that lost it
    // would be on no queue at all.
    expect(calls.filter((c) => c.op === "removeLabel").map((c) => c.arg)).toEqual([
      `42:${IN_CHUNK_LABEL}`,
    ]);
    expect(r.residue.join("\n")).toContain("#43 could not be closed");
    expect(r.residue.join("\n")).toContain("kept on origin");
  });

  it("tells the pull request what actually closed, not what was asked for", async () => {
    // The wrap-up knows the answer by the time it writes here — the member loop
    // is above it — so a comment reciting the target's member list would be
    // claiming a close that failed two calls earlier.
    const { adapter, bodies } = makeWrapupAdapter({ "closeIssue:43": "gh boom" });
    await wrapUpLandedChunk(target, adapter, {
      sourceBranch: "main",
      provenance: "sandbar",
    });

    const prBody = bodies.at(-1) ?? "";
    expect(prBody).toContain("- #42 — alpha");
    expect(prBody).toContain("Still OPEN");
    expect(prBody).toContain("- #43 — beta");
    expect(prBody).toContain("is KEPT on origin");
    expect(prBody).not.toMatch(/branch is being deleted/);
  });

  it("treats a failed label drop as benign residue and still deletes the branch", async () => {
    const { adapter } = makeWrapupAdapter({ removeLabel: "no such label" });
    const r = await wrapUpLandedChunk(target, adapter, {
      sourceBranch: "main",
      provenance: "sandbar",
    });
    expect(r.closed).toEqual([42, 43]);
    expect(r.branchDeleted).toBe(true);
    expect(r.residue).toHaveLength(2);
    expect(r.residue[0]).toContain("harmless");
  });

  it("still deletes the branch when the pull request will not close", async () => {
    const { adapter } = makeWrapupAdapter({ closePullRequest: "already merged" });
    const r = await wrapUpLandedChunk(target, adapter, {
      sourceBranch: "main",
      provenance: "sandbar",
    });
    expect(r.branchDeleted).toBe(true);
    expect(r.residue.join("\n")).toContain("pull request #9");
  });

  it("skips the pull request entirely when there is none", async () => {
    const { adapter, calls } = makeWrapupAdapter();
    const r = await wrapUpLandedChunk(
      { ...target, pullRequest: 0 },
      adapter,
      { sourceBranch: "main", provenance: "reconciled" },
    );
    expect(r.residue).toEqual([]);
    expect(calls.some((c) => c.op.endsWith("PullRequest"))).toBe(false);
  });

  it("deletes a landed branch that has no members at all", async () => {
    const { adapter } = makeWrapupAdapter();
    const r = await wrapUpLandedChunk(
      { ...target, members: [], pullRequest: 0 },
      adapter,
      { sourceBranch: "main", provenance: "reconciled" },
    );
    expect(r.closed).toEqual([]);
    expect(r.branchDeleted).toBe(true);
    expect(r.residue).toEqual([]);
  });
});

describe("the prose (#64)", () => {
  it("tells a member why it closed and names its siblings", () => {
    const body = CHUNK_MEMBER_CLOSED_COMMENT({
      chunkBranch: "sandbar/chunk-42-alpha",
      sourceBranch: "main",
      provenance: "sandbar",
      others: [{ number: 43, title: "beta" }],
    });
    expect(body).toContain(LAND_LABEL);
    expect(body).toContain("sandbar/chunk-42-alpha");
    expect(body).toContain("#43");
    expect(body).toContain(IN_CHUNK_LABEL);
  });

  it("does not claim sandbar landed a chunk a human merged", () => {
    const body = CHUNK_MEMBER_CLOSED_COMMENT({
      chunkBranch: "sandbar/chunk-42-alpha",
      sourceBranch: "main",
      provenance: "reconciled",
      others: [],
    });
    expect(body).toContain("already contained in");
    expect(body).not.toContain("sandbar merged");
  });

  it("does not promise a delete the member comment cannot have seen", () => {
    // It is written inside the member loop: the closes the delete is gated on
    // have not all been attempted yet, so it may say what becomes of the branch
    // but not that it is already gone.
    const body = CHUNK_MEMBER_CLOSED_COMMENT({
      chunkBranch: "sandbar/chunk-42-alpha",
      sourceBranch: "main",
      provenance: "sandbar",
      others: [],
    });
    expect(body).not.toMatch(/branch is deleted/);
    expect(body).toContain("retired once every issue on it has closed");
  });

  it("says the PR is closed rather than merged, and lists what actually closed", () => {
    const body = CHUNK_LANDED_PR_COMMENT({
      chunkBranch: "sandbar/chunk-42-alpha",
      sourceBranch: "main",
      provenance: "sandbar",
      closed: [{ number: 42, title: "alpha" }],
      unclosed: [],
    });
    expect(body).toContain("- #42 — alpha");
    expect(body).toContain("closed rather than merged");
    expect(body).toContain("The chunk branch is being deleted.");
  });

  it("names the members it could NOT close, and does not claim the branch went", () => {
    // The claim #60 had to go back and unpick, one level up: a comment that
    // listed #43 under "Issues closed" while #43 is open two lines above it.
    const body = CHUNK_LANDED_PR_COMMENT({
      chunkBranch: "sandbar/chunk-42-alpha",
      sourceBranch: "main",
      provenance: "sandbar",
      closed: [{ number: 42, title: "alpha" }],
      unclosed: [{ number: 43, title: "beta" }],
    });
    expect(body).toContain("- #42 — alpha");
    expect(body).toContain("Still OPEN");
    expect(body).toContain("- #43 — beta");
    expect(body).toContain("is KEPT on origin");
    expect(body).not.toMatch(/branch is being deleted/);
  });

  it("says the land label was removed when the merge was abandoned", () => {
    const body = CHUNK_LAND_ABANDONED_PR_COMMENT({
      chunkBranch: "sandbar/chunk-42-alpha",
      sourceBranch: "main",
      mode: "conflict",
      reason: "two branches rewrote the same file",
      attempts: 4,
    });
    expect(body).toContain("conflicted");
    expect(body).toContain("4 attempts");
    expect(body).toContain("two branches rewrote the same file");
    expect(body).toContain(`\`${LAND_LABEL}\` label has been removed`);
  });
});

describe("wrapUpLandedChunk never throws (#64)", () => {
  it("finishes the wrap-up when the log sink throws", async () => {
    // The merge phase hands it a sink that throws once the source branch has
    // moved — `merger.ts` stops wrapping errors past that point on purpose. A
    // failed log write must not abandon a member's close halfway through.
    const { adapter, calls } = makeWrapupAdapter();
    const r = await wrapUpLandedChunk(target, adapter, {
      sourceBranch: "main",
      provenance: "sandbar",
      log: () => {
        throw new Error("ENOSPC");
      },
    });

    expect(r.closed).toEqual([42, 43]);
    expect(r.branchDeleted).toBe(true);
    expect(r.residue).toEqual([]);
    expect(calls.at(-1)?.op).toBe("deleteChunkBranch");
  });
});
