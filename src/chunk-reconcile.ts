// The plan-time reconciler: chunks that reached the source branch without
// sandbar, finished off (#64, §5 of the design in #54, and Q14's second
// residual).
//
// `chunk-land.ts` owns what reconciliation IS and why it exists; this module is
// the I/O around it. Three questions, in order:
//
//   1. Which of origin's chunk branches are contained in
//      `origin/<sourceBranch>`? That is a fact about git, and it is the only
//      test used — a hand-merged pull request, a run killed between the landing
//      push and the first `gh issue close`, and a chunk sandbar landed
//      perfectly all look identical from here, and all three want the same
//      thing done to them.
//   2. Which issues are on each of those branches? The plan's derivation
//      answers that, and nothing else can: `LandedChunk` is built from the
//      candidate graph, which lists `in-chunk` members back in precisely so
//      this question has an answer.
//   3. Is there an open pull request for it? Asked per branch rather than by
//      listing the repository's pull requests, because the branches here are
//      normally zero and never many.
//
// It runs at PLAN time, which is the whole of what makes it defense in depth.
// It needs no merger worktree, no gate stack and no DONE branch, so it still
// runs on the cycle that plans nothing and merges nothing — which is exactly
// the cycle a hand-merged chunk leaves behind. The merge phase's own landing
// (#64's `land` label) and this share one implementation of the wrap-up and
// differ only in whether a merge happened first.
//
// EVERY COMMAND NAMES ITS REPOSITORY (#34), and every git command runs in the
// BARE CACHE — which is the only thing this module needs that the merge phase
// does not have, and therefore the only argument its writes are its own. They
// are not: the adapter is `chunkForgeWrites` with that one cwd supplied, so
// the argv that closes a member is written once (`chunk-land.ts`) and read
// here. Nothing here writes to a worktree, and the one destructive
// operation, `git push origin --delete`, is aimed at origin rather than at any
// local ref, so the "cannot reach the operator's checkout" property holds for
// the same structural reason the rest of the startup path's does.
//
// FAIL-SOFT ON DISCOVERY, loud on the writes. A `gh` or `git` failure while
// working out what to reconcile answers "nothing to reconcile" — the state it
// could not read is still there next cycle, and refusing to start a run over a
// repair that is not urgent would be the wrong trade. Once a target is chosen,
// its writes are the wrap-up's, and what they could not finish comes back as
// residue the orchestrator reports.
//
// REPORTED, AND — unlike the merge phase's own landings — NOT HALTED ON. That
// asymmetry is a decision rather than an oversight, and it rests on where the
// two run. A wrap-up that kept its branch is retried by THIS function, at the
// top of the very next cycle, minutes later and with no operator involved: the
// reconciler is the retry, so halting in front of it stops a run before it has
// done anything, over state the run did not create and that repairs itself.
// The merge phase halts because its residue is its OWN unfinished landing,
// discovered after the cycle's reconcile pass has already been and gone and
// after the source branch has moved — carrying on there means landing more
// work past a repair whose next attempt is a whole cycle away. Both report,
// and both say which of the two residue classes they are reporting
// (`chunkResidue`); only one of them ends the run.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  type ChunkWrapup,
  type ChunkWrapupAdapter,
  type PullRequestSummary,
  chunkForgeWrites,
  selectReconciliations,
  wrapUpLandedChunk,
} from "./chunk-land.js";
import type { LandedChunk } from "./chunks.js";
import {
  ORIGIN_CHUNK_BRANCH_FETCH_REFSPECS,
  ORIGIN_CHUNK_BRANCH_REFGLOBS,
} from "./naming.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";

const exec = promisify(execFile);

const ORIGIN_REF_PREFIX = "refs/remotes/origin/";

// One read that answers rather than throws — the shape every discovery call
// here takes, since a failure to work out WHAT to reconcile is "nothing to
// reconcile" (see the header).
//
// `cwd` is where the difference between the two kinds of read lives, and it is
// the only one: a `git` read runs in the bare cache, and a `gh` read runs
// nowhere in particular, on purpose and by the precedent `plan-resolver.ts`
// states outright — with `--repo` given, gh never looks at a git remote, so
// there is no directory left for one to be wrong about (#34).
async function capture(
  file: string,
  args: readonly string[],
  cwd?: string,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await exec(file, [...args], cwd === undefined ? {} : { cwd });
    return { ok: true, stdout };
  } catch (err) {
    if (typeof (err as { code?: unknown }).code !== "number") throw err;
    return { ok: false, stdout: "" };
  }
}

/**
 * Origin's chunk branches whose tips are already contained in
 * `origin/<sourceBranch>`, as branch names.
 *
 * Fetches first, and with the same refspecs preflight uses: preflight runs once
 * at startup and this runs every cycle, so a chunk a human merged twenty
 * minutes into a run is invisible without it. `--prune` on those same
 * destinations is what stops a branch somebody deleted on origin answering
 * "yes, still there" out of a stale cache — which would send the wrap-up to
 * close issues on the strength of a ref that no longer exists.
 *
 * That makes the fetch LOAD-BEARING rather than an optimisation, so a fetch
 * that failed answers "nothing has landed". A cache can be stale in both
 * directions — a branch origin no longer has, and a source branch that has not
 * caught up — and both readings are wrong in a way that writes to the tracker.
 * `gh` reaching the forge over HTTPS while git's transport is down (an expired
 * key, a proxy) is enough to produce exactly that, so it is not hypothetical.
 * Returning empty is the same fail-soft the rest of discovery here uses: the
 * state is still there next cycle.
 */
export async function findLandedChunkBranches(
  repoDir: string,
  sourceBranch: string,
): Promise<readonly string[]> {
  const fetched = await capture(
    "git",
    [
      "fetch",
      "origin",
      "--prune",
      sourceBranch,
      ...ORIGIN_CHUNK_BRANCH_FETCH_REFSPECS,
      "--quiet",
    ],
    repoDir,
  );
  if (!fetched.ok) return [];
  const listed = await capture(
    "git",
    ["for-each-ref", "--format=%(refname)", ...ORIGIN_CHUNK_BRANCH_REFGLOBS],
    repoDir,
  );
  if (!listed.ok) return [];
  const landed: string[] = [];
  for (const ref of listed.stdout.split("\n").map((s) => s.trim())) {
    if (!ref.startsWith(ORIGIN_REF_PREFIX)) continue;
    const contained = await capture(
      "git",
      ["merge-base", "--is-ancestor", ref, `${ORIGIN_REF_PREFIX}${sourceBranch}`],
      repoDir,
    );
    if (contained.ok) landed.push(ref.slice(ORIGIN_REF_PREFIX.length));
  }
  return landed;
}

/**
 * The open pull requests for the given branches, at most one each.
 *
 * Per branch rather than one listing of the repository: the caller's list is
 * normally empty and never long, and `--head` is a filter the forge applies
 * rather than one this has to trust a `--limit` to have not truncated.
 */
export async function fetchPullRequestsForBranches(
  repo: RepoRef,
  branches: readonly string[],
): Promise<readonly PullRequestSummary[]> {
  const found: PullRequestSummary[] = [];
  for (const branch of branches) {
    const r = await capture("gh", [
      "pr",
      "list",
      "--repo",
      repoSlug(repo),
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,headRefName,title",
    ]);
    if (!r.ok) continue;
    found.push(...parsePullRequests(r.stdout));
  }
  return found;
}

/**
 * Every open pull request carrying `land`, whatever its head branch is —
 * `selectLandRequests` is what decides which of them name a chunk.
 *
 * Fail-soft, like the rest of discovery here: a forge that could not be listed
 * means no chunk is landed this cycle, and the label is still on the pull
 * request for the next one.
 */
export async function fetchLandRequestPullRequests(
  repo: RepoRef,
  label: string,
): Promise<readonly PullRequestSummary[]> {
  const r = await capture("gh", [
    "pr",
    "list",
    "--repo",
    repoSlug(repo),
    "--label",
    label,
    "--state",
    "open",
    "--json",
    "number,headRefName,title",
    "--limit",
    "200",
  ]);
  if (!r.ok) return [];
  return parsePullRequests(r.stdout);
}

// `gh pr list --json` output, defensively. A field the forge answered in a
// shape this cannot read drops the pull request rather than the whole list: an
// unreadable entry is one chunk not landed this cycle, and a throw here is a
// run that will not start.
function parsePullRequests(stdout: string): readonly PullRequestSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() || "[]");
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PullRequestSummary[] = [];
  for (const raw of parsed) {
    const o = raw as Record<string, unknown>;
    const number = o["number"];
    const headRefName = o["headRefName"];
    if (typeof number !== "number" || typeof headRefName !== "string") continue;
    out.push({
      number,
      headRefName,
      title: typeof o["title"] === "string" ? o["title"] : "",
    });
  }
  return out;
}

export type ReconcileResult = {
  // One entry per chunk branch found already on the source branch, in root
  // order. Empty is the overwhelmingly common answer.
  readonly reconciled: readonly ChunkWrapup[];
  // Every issue closed across all of them, which is what the caller adds to its
  // "already merged this run" exclusion set.
  readonly closedIssues: readonly number[];
  // What a wrap-up could not finish stays on the entry it belongs to and is
  // deliberately NOT flattened into one list here. Two different things fail:
  // a chunk whose branch is still on origin, which the next cycle's reconciler
  // retries, and a retired chunk that left a cosmetic line nothing will ever
  // look at again. One list of strings cannot tell a caller which it is
  // holding, and a caller that guesses promises a repair that is not coming.
  // `chunkResidue` in `chunk-land.ts` is the split, and it is what `run.ts`
  // reports off.
};

/**
 * Find and finish every chunk that is already on the source branch.
 *
 * Returns an empty result — never throws — when there is nothing to do, which
 * is the state of every host on the auto lane and of nearly every cycle on the
 * review lane.
 */
export async function reconcileLandedChunks(cfg: {
  // The bare object cache, which is the only checkout that exists at plan time.
  // `repoDir` rather than the whole `RepoLayout` because that is all of it this
  // reads, and it is what the two functions below already take.
  readonly repoDir: string;
  readonly repo: RepoRef;
  readonly sourceBranch: string;
  // The plan's derivation: how a branch learns which issues are on it.
  readonly chunks: readonly LandedChunk[];
  readonly log?: (line: string) => void | Promise<void>;
  // Test seam. The real one talks to `gh` and to origin.
  readonly adapter?: ChunkWrapupAdapter;
  readonly findLanded?: (
    repoDir: string,
    sourceBranch: string,
  ) => Promise<readonly string[]>;
  readonly findPullRequests?: (
    repo: RepoRef,
    branches: readonly string[],
  ) => Promise<readonly PullRequestSummary[]>;
}): Promise<ReconcileResult> {
  const repoDir = cfg.repoDir;
  // Logging is a required side effect: losing it would hide reconciliation
  // writes from the durable run record (#99).
  const log = async (line: string): Promise<void> => cfg.log?.(line);
  const landed = await (cfg.findLanded ?? findLandedChunkBranches)(
    repoDir,
    cfg.sourceBranch,
  );
  if (landed.length === 0) {
    return { reconciled: [], closedIssues: [] };
  }
  const prs = await (cfg.findPullRequests ?? fetchPullRequestsForBranches)(
    cfg.repo,
    landed,
  );
  const targets = selectReconciliations(landed, cfg.chunks, prs);
  // The merge phase's writes, with the one thing that actually differs
  // supplied: `git push --delete` runs in the BARE CACHE here, because at plan
  // time the merger worktree does not exist yet and may never. Nothing else
  // about a reconciliation's writes is its own, so there is no wrapper around
  // this to name.
  const adapter =
    cfg.adapter ??
    chunkForgeWrites({
      repo: cfg.repo,
      gitCwd: repoDir,
      errPrefix: "reconcile",
    });

  const reconciled: ChunkWrapup[] = [];
  const closedIssues: number[] = [];
  for (const target of targets) {
    await log(
      `reconcile ${target.branch}: already on ${cfg.sourceBranch}; ` +
        `${target.members.length} member(s) to close`,
    );
    const wrapup = await wrapUpLandedChunk(target, adapter, {
      sourceBranch: cfg.sourceBranch,
      provenance: "reconciled",
      log,
    });
    reconciled.push({ target, ...wrapup });
    closedIssues.push(...wrapup.closed);
  }
  return { reconciled, closedIssues };
}
