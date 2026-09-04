// #64 — the plan-time reconciler's ORCHESTRATION, over a fake adapter: which
// landed branches become targets, in what order, and what a wrap-up that could
// not finish leaves behind. The two halves no fake can reach live where the
// convention puts them — the containment question git itself answers is
// `chunk-reconcile-git.test.ts`, and what the `gh` readers do with output they
// cannot parse is in `gh-argv.test.ts`, beside the argv those same calls build.
import { describe, expect, it } from "vitest";

import {
  LAND_LABEL,
  type ChunkWrapupAdapter,
  type PullRequestSummary,
} from "./chunk-land.js";
import { NEEDS_REVIEW_LABEL, type LandedChunk } from "./chunks.js";
import { reconcileLandedChunks } from "./chunk-reconcile.js";

type Recorded = { readonly op: string; readonly arg: string };

function fakeAdapter(
  fail: Partial<Record<string, string>> = {},
): { adapter: ChunkWrapupAdapter; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const record = (op: string, arg: string): void => {
    calls.push({ op, arg });
    const err = fail[`${op}:${arg}`] ?? fail[op];
    if (err) throw new Error(err);
  };
  return {
    calls,
    adapter: {
      async closeIssue(n) {
        record("closeIssue", String(n));
      },
      async removeLabel(n, label) {
        record("removeLabel", `${n}:${label}`);
      },
      async commentOnPullRequest(p) {
        record("commentOnPullRequest", String(p));
      },
      async removePullRequestLabel(p, label) {
        record("removePullRequestLabel", `${p}:${label}`);
      },
      async closePullRequest(p) {
        record("closePullRequest", String(p));
      },
      async deleteChunkBranch(b, members) {
        record("deleteChunkBranch", `${b} [${members.join(",")}]`);
      },
    },
  };
}

// No layout cast: the reconciler takes the bare cache path itself, which is
// all of a `RepoLayout` it ever read.
const REPO_DIR = "/nonexistent";
const REPO = { owner: "acme", name: "app" };

const chunk = (
  root: number,
  members: readonly number[],
): LandedChunk => ({
  root,
  branch: `sandbar/chunk-${root}-c`,
  title: `t-${root}`,
  members: members.map((n) => ({ number: n, title: `t-${n}` })),
  // Ascending, which is what an unrelated pair closes in; a chain is
  // `chunks.ts`'s business and `chunk-land.test.ts`'s to act on.
  closeOrder: members.map((n) => ({ number: n, title: `t-${n}` })),
  // Unread here: the tips are the review scan's half of a `LandedChunk` (#63).
  tips: [],
});

const run = (
  landed: readonly string[],
  chunks: readonly LandedChunk[],
  prs: readonly PullRequestSummary[],
  adapter: ChunkWrapupAdapter,
): ReturnType<typeof reconcileLandedChunks> =>
  reconcileLandedChunks({
    repoDir: REPO_DIR,
    repo: REPO,
    sourceBranch: "main",
    chunks,
    adapter,
    findLanded: async () => landed,
    findPullRequests: async () => prs,
  });

describe("reconcileLandedChunks (#64)", () => {
  it("does nothing at all — and asks the forge nothing — when no chunk has landed", async () => {
    const { adapter, calls } = fakeAdapter();
    let prQueries = 0;
    const r = await reconcileLandedChunks({
      repoDir: REPO_DIR,
      repo: REPO,
      sourceBranch: "main",
      chunks: [chunk(42, [42])],
      adapter,
      findLanded: async () => [],
      findPullRequests: async () => {
        prQueries += 1;
        return [];
      },
    });

    expect(r).toEqual({ reconciled: [], closedIssues: [] });
    expect(calls).toEqual([]);
    expect(prQueries).toBe(0);
  });

  it("closes the members, drops needs-review, closes the PR and deletes the branch", async () => {
    const { adapter, calls } = fakeAdapter();
    const r = await run(
      ["sandbar/chunk-42-c"],
      [chunk(42, [42, 43])],
      [{ number: 9, headRefName: "sandbar/chunk-42-c", title: "chunk 42" }],
      adapter,
    );

    expect(r.closedIssues).toEqual([42, 43]);
    expect(r.reconciled[0]?.residue).toEqual([]);
    expect(calls.map((c) => `${c.op} ${c.arg}`)).toEqual([
      "closeIssue 42",
      `removeLabel 42:${NEEDS_REVIEW_LABEL}`,
      "closeIssue 43",
      `removeLabel 43:${NEEDS_REVIEW_LABEL}`,
      "commentOnPullRequest 9",
      `removePullRequestLabel 9:${LAND_LABEL}`,
      "closePullRequest 9",
      "deleteChunkBranch sandbar/chunk-42-c [42,43]",
    ]);
    expect(r.reconciled[0]?.branchDeleted).toBe(true);
  });

  it("reconciles a branch whose pull request a human already closed", async () => {
    const { adapter, calls } = fakeAdapter();
    const r = await run(["sandbar/chunk-42-c"], [chunk(42, [42])], [], adapter);

    expect(r.closedIssues).toEqual([42]);
    expect(calls.some((c) => c.op.endsWith("PullRequest"))).toBe(false);
    expect(calls.at(-1)).toEqual({
      op: "deleteChunkBranch",
      arg: "sandbar/chunk-42-c [42]",
    });
  });

  it("deletes a landed branch the derivation knows nothing about", async () => {
    // Every member closed by hand already, so the chunk re-derives to nothing.
    // The branch's commits are demonstrably on the source branch, which is the
    // whole licence the delete needs.
    const { adapter, calls } = fakeAdapter();
    const r = await run(["sandbar/chunk-42-c"], [], [], adapter);

    expect(r.closedIssues).toEqual([]);
    expect(r.reconciled[0]?.residue).toEqual([]);
    expect(calls).toEqual([
      { op: "deleteChunkBranch", arg: "sandbar/chunk-42-c []" },
    ]);
  });

  it("keeps the branch and reports residue when a close fails, so the next run retries", async () => {
    const { adapter, calls } = fakeAdapter({ "closeIssue:43": "gh down" });
    const r = await run(["sandbar/chunk-42-c"], [chunk(42, [42, 43])], [], adapter);

    expect(r.closedIssues).toEqual([42]);
    expect(calls.some((c) => c.op === "deleteChunkBranch")).toBe(false);
    expect(r.reconciled[0]?.residue.join("\n")).toContain(
      "#43 could not be closed",
    );
  });

  it("propagates a failed log write", async () => {
    const { adapter } = fakeAdapter();
    await expect(
      reconcileLandedChunks({
        repoDir: REPO_DIR,
        repo: REPO,
        sourceBranch: "main",
        chunks: [chunk(42, [42]), chunk(99, [99])],
        adapter,
        log: () => {
          throw new Error("ENOSPC");
        },
        findLanded: async () => ["sandbar/chunk-42-c", "sandbar/chunk-99-c"],
        findPullRequests: async () => [],
      }),
    ).rejects.toThrow("ENOSPC");
  });

  it("reconciles every landed chunk, in root order, and never stops on the first failure", async () => {
    const { adapter } = fakeAdapter({ "closeIssue:42": "gh down" });
    const r = await run(
      ["sandbar/chunk-99-c", "sandbar/chunk-42-c"],
      [chunk(42, [42]), chunk(99, [99])],
      [],
      adapter,
    );

    expect(r.reconciled.map((x) => x.target.root)).toEqual([42, 99]);
    expect(r.closedIssues).toEqual([99]);
  });
});
