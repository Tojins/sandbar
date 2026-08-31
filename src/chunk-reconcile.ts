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
//      answers that, and nothing else can: `NamedChunk` is built from the
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
// EVERY COMMAND NAMES ITS REPOSITORY (#34), and every git command runs in
// `layout.repoDir` — the bare cache. Nothing here writes to a worktree, and the
// one destructive operation, `git push origin --delete`, is aimed at origin
// rather than at any local ref, so the "cannot reach the operator's checkout"
// property holds for the same structural reason the rest of the startup path's
// does.
//
// FAIL-SOFT ON DISCOVERY, loud on the writes. A `gh` or `git` failure while
// working out what to reconcile answers "nothing to reconcile" — the state it
// could not read is still there next cycle, and refusing to start a run over a
// repair that is not urgent would be the wrong trade. Once a target is chosen,
// its writes are the wrap-up's, and what they could not finish comes back as
// residue the orchestrator reports.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  type ChunkLandTarget,
  type ChunkWrapupAdapter,
  type ChunkWrapupResult,
  type PullRequestSummary,
  selectReconciliations,
  wrapUpLandedChunk,
} from "./chunk-land.js";
import type { NamedChunk } from "./chunks.js";
import { SandbarError } from "./errors.js";
import {
  ORIGIN_CHUNK_BRANCH_FETCH_REFSPECS,
  ORIGIN_CHUNK_BRANCH_REFGLOBS,
} from "./naming.js";
import type { RepoLayout } from "./repo-cache.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";

const exec = promisify(execFile);

const ORIGIN_REF_PREFIX = "refs/remotes/origin/";

// A `gh` read. No `cwd`, on purpose and by the precedent `plan-resolver.ts`
// states outright: with `--repo` given, gh never looks at git remotes, so
// there is no directory left for one to be wrong (#34).
async function captureGh(
  args: readonly string[],
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await exec("gh", [...args]);
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

async function captureOk(
  cwd: string,
  file: string,
  args: readonly string[],
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await exec(file, [...args], { cwd });
    return { ok: true, stdout };
  } catch {
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
 */
export async function findLandedChunkBranches(
  repoDir: string,
  sourceBranch: string,
): Promise<readonly string[]> {
  await captureOk(repoDir, "git", [
    "fetch",
    "origin",
    "--prune",
    sourceBranch,
    ...ORIGIN_CHUNK_BRANCH_FETCH_REFSPECS,
    "--quiet",
  ]);
  const listed = await captureOk(repoDir, "git", [
    "for-each-ref",
    "--format=%(refname)",
    ...ORIGIN_CHUNK_BRANCH_REFGLOBS,
  ]);
  if (!listed.ok) return [];
  const landed: string[] = [];
  for (const ref of listed.stdout.split("\n").map((s) => s.trim())) {
    if (!ref.startsWith(ORIGIN_REF_PREFIX)) continue;
    const contained = await captureOk(repoDir, "git", [
      "merge-base",
      "--is-ancestor",
      ref,
      `${ORIGIN_REF_PREFIX}${sourceBranch}`,
    ]);
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
    const r = await captureGh([
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
  const r = await captureGh([
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
  } catch {
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

/**
 * The wrap-up's writes, outside the merge phase.
 *
 * Deliberately the same shape as the merger's own adapter methods, spelled out
 * again rather than shared with it: the merger's run from the ephemeral merger
 * worktree, and these run from the bare cache, which is the only place that
 * exists at plan time.
 */
export function realReconcileAdapter(deps: {
  readonly repoDir: string;
  readonly repo: RepoRef;
}): ChunkWrapupAdapter {
  const slug = repoSlug(deps.repo);
  const gh = async (args: readonly string[], what: string): Promise<void> => {
    try {
      await exec("gh", [...args]);
    } catch (err) {
      throw new SandbarError(
        `reconcile: ${what}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  };
  return {
    closeIssue: (n, comment) =>
      gh(
        ["issue", "close", String(n), "--repo", slug, "--comment", comment],
        `failed to close issue #${n}`,
      ),
    removeLabel: (n, label) =>
      gh(
        ["issue", "edit", String(n), "--repo", slug, "--remove-label", label],
        `failed to remove label '${label}' from issue #${n}`,
      ),
    commentOnPullRequest: (pr, body) =>
      gh(
        ["pr", "comment", String(pr), "--repo", slug, "--body", body],
        `failed to comment on pull request #${pr}`,
      ),
    closePullRequest: (pr) =>
      gh(
        ["pr", "close", String(pr), "--repo", slug],
        `failed to close pull request #${pr}`,
      ),
    async deleteChunkBranch(chunkBranch) {
      // Origin, from the bare cache. Safe on the one precondition that put
      // this branch in front of us: its commits are contained in
      // `origin/<sourceBranch>`.
      try {
        await exec(
          "git",
          ["push", "origin", "--delete", `refs/heads/${chunkBranch}`],
          { cwd: deps.repoDir },
        );
      } catch (err) {
        throw new SandbarError(
          `reconcile: failed to delete the landed chunk branch ${chunkBranch} on origin: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
  };
}

export type ChunkReconciliation = ChunkWrapupResult & {
  readonly target: ChunkLandTarget;
};

export type ReconcileResult = {
  // One entry per chunk branch found already on the source branch, in root
  // order. Empty is the overwhelmingly common answer.
  readonly reconciled: readonly ChunkReconciliation[];
  // Every issue closed across all of them, which is what the caller adds to its
  // "already merged this run" exclusion set.
  readonly closedIssues: readonly number[];
  // Everything no wrap-up could finish. Non-empty is operator-actionable, and
  // the chunk branches involved were kept so the next run retries them.
  readonly residue: readonly string[];
};

/**
 * Find and finish every chunk that is already on the source branch.
 *
 * Returns an empty result — never throws — when there is nothing to do, which
 * is the state of every host on the auto lane and of nearly every cycle on the
 * review lane.
 */
export async function reconcileLandedChunks(cfg: {
  readonly layout: RepoLayout;
  readonly repo: RepoRef;
  readonly sourceBranch: string;
  // The plan's derivation: how a branch learns which issues are on it.
  readonly chunks: readonly NamedChunk[];
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
  const repoDir = cfg.layout.repoDir;
  const log = cfg.log ?? ((): void => undefined);
  const landed = await (cfg.findLanded ?? findLandedChunkBranches)(
    repoDir,
    cfg.sourceBranch,
  );
  if (landed.length === 0) {
    return { reconciled: [], closedIssues: [], residue: [] };
  }
  const prs = await (cfg.findPullRequests ?? fetchPullRequestsForBranches)(
    cfg.repo,
    landed,
  );
  const targets = selectReconciliations(landed, cfg.chunks, prs);
  const adapter =
    cfg.adapter ?? realReconcileAdapter({ repoDir, repo: cfg.repo });

  const reconciled: ChunkReconciliation[] = [];
  const closedIssues: number[] = [];
  const residue: string[] = [];
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
    residue.push(...wrapup.residue);
  }
  return { reconciled, closedIssues, residue };
}
