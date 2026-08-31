// #64 — the plan-time reconciler. Two halves, tested the two ways CLAUDE.md
// asks for: the orchestration over a fake adapter, and the one question that is
// a fact about git — "is this chunk branch already contained in the source
// branch?" — asserted by running git against real repositories.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChunkWrapupAdapter, PullRequestSummary } from "./chunk-land.js";
import { IN_CHUNK_LABEL, type NamedChunk } from "./chunks.js";
import {
  findLandedChunkBranches,
  reconcileLandedChunks,
} from "./chunk-reconcile.js";
import type { RepoLayout } from "./repo-cache.js";

const exec = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@e",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

// ---------------------------------------------------------------------------

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
      async closePullRequest(p) {
        record("closePullRequest", String(p));
      },
      async deleteChunkBranch(b) {
        record("deleteChunkBranch", b);
      },
    },
  };
}

const LAYOUT = { repoDir: "/nonexistent" } as unknown as RepoLayout;
const REPO = { owner: "acme", name: "app" };

const chunk = (
  root: number,
  members: readonly number[],
): NamedChunk => ({
  root,
  branch: `sandbar/chunk-${root}-c`,
  title: `t-${root}`,
  members: members.map((n) => ({ number: n, title: `t-${n}` })),
});

const run = (
  landed: readonly string[],
  chunks: readonly NamedChunk[],
  prs: readonly PullRequestSummary[],
  adapter: ChunkWrapupAdapter,
): ReturnType<typeof reconcileLandedChunks> =>
  reconcileLandedChunks({
    layout: LAYOUT,
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
      layout: LAYOUT,
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

    expect(r).toEqual({ reconciled: [], closedIssues: [], residue: [] });
    expect(calls).toEqual([]);
    expect(prQueries).toBe(0);
  });

  it("closes the members, drops in-chunk, closes the PR and deletes the branch", async () => {
    const { adapter, calls } = fakeAdapter();
    const r = await run(
      ["sandbar/chunk-42-c"],
      [chunk(42, [42, 43])],
      [{ number: 9, headRefName: "sandbar/chunk-42-c", title: "chunk 42" }],
      adapter,
    );

    expect(r.closedIssues).toEqual([42, 43]);
    expect(r.residue).toEqual([]);
    expect(calls.map((c) => `${c.op} ${c.arg}`)).toEqual([
      "closeIssue 42",
      `removeLabel 42:${IN_CHUNK_LABEL}`,
      "closeIssue 43",
      `removeLabel 43:${IN_CHUNK_LABEL}`,
      "commentOnPullRequest 9",
      "closePullRequest 9",
      "deleteChunkBranch sandbar/chunk-42-c",
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
      arg: "sandbar/chunk-42-c",
    });
  });

  it("deletes a landed branch the derivation knows nothing about", async () => {
    // Every member closed by hand already, so the chunk re-derives to nothing.
    // The branch's commits are demonstrably on the source branch, which is the
    // whole licence the delete needs.
    const { adapter, calls } = fakeAdapter();
    const r = await run(["sandbar/chunk-42-c"], [], [], adapter);

    expect(r.closedIssues).toEqual([]);
    expect(r.residue).toEqual([]);
    expect(calls).toEqual([
      { op: "deleteChunkBranch", arg: "sandbar/chunk-42-c" },
    ]);
  });

  it("keeps the branch and reports residue when a close fails, so the next run retries", async () => {
    const { adapter, calls } = fakeAdapter({ "closeIssue:43": "gh down" });
    const r = await run(["sandbar/chunk-42-c"], [chunk(42, [42, 43])], [], adapter);

    expect(r.closedIssues).toEqual([42]);
    expect(calls.some((c) => c.op === "deleteChunkBranch")).toBe(false);
    expect(r.residue.join("\n")).toContain("#43 could not be closed");
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

// ---------------------------------------------------------------------------

describe("findLandedChunkBranches (real git)", () => {
  let root: string;
  let origin: string;
  let cache: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-recon-"));
    origin = join(root, "origin.git");
    cache = join(root, "cache.git");
    const work = join(root, "work");
    await exec("git", ["init", "-b", "main", work], { env: GIT_ENV });
    await writeFile(join(work, "a.txt"), "a");
    await git(work, "add", ".");
    await git(work, "commit", "-m", "base");
    await exec("git", ["init", "--bare", "-b", "main", origin], { env: GIT_ENV });
    await git(work, "remote", "add", "origin", origin);
    await git(work, "push", "origin", "main");

    // A chunk branch that IS on main, and one that is not.
    await git(work, "checkout", "-b", "sandbar/chunk-42-landed");
    await writeFile(join(work, "b.txt"), "b");
    await git(work, "add", ".");
    await git(work, "commit", "-m", "chunk 42");
    await git(work, "push", "origin", "sandbar/chunk-42-landed");
    await git(work, "checkout", "main");
    await git(work, "merge", "--no-ff", "-m", "land 42", "sandbar/chunk-42-landed");
    await git(work, "push", "origin", "main");

    await git(work, "checkout", "-b", "sandbar/chunk-77-open");
    await writeFile(join(work, "c.txt"), "c");
    await git(work, "add", ".");
    await git(work, "commit", "-m", "chunk 77");
    await git(work, "push", "origin", "sandbar/chunk-77-open");

    await exec("git", ["clone", "--bare", origin, cache], { env: GIT_ENV });
    // A bare clone's `origin` is the URL it came from, but its refs live under
    // `refs/heads`; the cache sandbar builds keeps origin's under
    // `refs/remotes/origin/*`, which is what the fetch below establishes.
    await git(cache, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await git(cache, "fetch", "origin", "--quiet");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns only the chunk branch whose commits are on the source branch", async () => {
    expect(await findLandedChunkBranches(cache, "main")).toEqual([
      "sandbar/chunk-42-landed",
    ]);
  });

  it("says nothing has landed when the repository has no chunk branch at all", async () => {
    await git(cache, "push", "origin", "--delete", "refs/heads/sandbar/chunk-42-landed");
    await git(cache, "push", "origin", "--delete", "refs/heads/sandbar/chunk-77-open");
    expect(await findLandedChunkBranches(cache, "main")).toEqual([]);
  });
});
