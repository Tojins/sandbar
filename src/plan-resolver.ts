// Deterministic plan resolver.
//
// Picks the issues that are ready to work this cycle by parsing the
// `## Blocked by` section that /to-issues writes into every ready-for-agent
// issue and batch-checking the referenced issues' state.
//
// `fetchCandidates` lists via the `gh` search backend, which lags label/close
// writes by seconds. So an issue merged+closed (and de-queued) in a PRIOR
// iteration of the same run can still surface as a candidate here. To stop the
// planner re-picking it (#16) resolvePlan also drops (a) anything the caller
// passes in `excluded` — the issues this run already merged — and (b) anything
// whose authoritative state (fetched per-candidate alongside blocker states via
// strongly-consistent GraphQL) reads CLOSED.
//
// All ranking logic lives in pure functions (parseBlockedBy, kebabSlug,
// resolvePlan) so it can be table-driven tested. The I/O wrappers
// (fetchCandidates, fetchIssueStates) are thin adapters over `gh`.
//
// `fetchCandidates` NAMES the repository (#34). It used to identify it the way
// `gh` does by default — from the git remotes of the directory the command runs
// in — which made the planner's queue a property of a directory: first of
// wherever the host process was launched, then (once #34 threaded a `cwd`) of
// wherever the cache's `origin` happened to point. `fetchIssueStates` has
// always named the repo, in its GraphQL variables, and the two MUST agree:
// `buildPlan` lists candidates through the first and resolves their
// authoritative state through the second, so a disagreement resolves one
// repository's issue numbers in another — silently dropping or mis-stating
// every candidate rather than failing. Preflight's resume classification calls
// `fetchCandidates` for the same never-desync reason, so the same argument
// covers it.
//
// Passing `RepoRef` rather than a directory is what makes that agreement
// structural: both functions now read `config.ghOwner`/`config.ghRepo`, which
// are required fields, so there is exactly one answer and no directory can
// supply a second. Note neither function takes a `cwd` at all any more — with
// `--repo` given, `gh` never looks at git remotes, so there is no directory
// left for one to be wrong.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { BRANCH_PREFIX } from "./naming.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";

const exec = promisify(execFile);

const WAITING_LABEL = "waiting";
const READY_LABEL = "ready-for-agent";
const DEFAULT_K = 3;

export type IssueState = "OPEN" | "CLOSED";

export type IssueSummary = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
};

export type PlannedIssue = {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
};

export type Plan = readonly PlannedIssue[];

export function parseBlockedBy(body: string): readonly number[] {
  // Match `## Blocked by` (case-insensitive) and capture everything up to the
  // next H2 or end of body.
  const m = body.match(/##\s+Blocked by\s*\n([\s\S]*?)(?:\n##\s|$)/i);
  if (!m || !m[1]) return [];
  const refs = [...m[1].matchAll(/#(\d+)\b/g)].map((r) => Number(r[1]));
  return [...new Set(refs)];
}

export function kebabSlug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function resolvePlan(
  candidates: readonly IssueSummary[],
  issueStates: ReadonlyMap<number, IssueState>,
  excluded: ReadonlySet<number> = new Set(),
  k: number = DEFAULT_K,
): Plan {
  const eligible = candidates.filter((c) => {
    // Drop issues this run already merged, and issues the live tracker now
    // reports CLOSED — both guard against the stale-search re-pick described in
    // the module header (#16). Unknown state (absent from the map) is treated
    // as OPEN so a single state-fetch miss never silently drops a ready issue.
    if (excluded.has(c.number)) return false;
    if (issueStates.get(c.number) === "CLOSED") return false;
    if (c.labels.includes(WAITING_LABEL)) return false;
    const blockers = parseBlockedBy(c.body);
    return blockers.every((n) => issueStates.get(n) === "CLOSED");
  });
  const sorted = [...eligible].sort((a, b) => a.number - b.number);
  return sorted.slice(0, k).map((c) => ({
    id: String(c.number),
    title: c.title,
    branch: `${BRANCH_PREFIX}issue-${c.number}-${kebabSlug(c.title)}`,
  }));
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export async function fetchCandidates(
  repo: RepoRef,
): Promise<readonly IssueSummary[]> {
  const { stdout } = await exec("gh", [
    "issue",
    "list",
    "--repo",
    repoSlug(repo),
    "--label",
    READY_LABEL,
    "--state",
    "open",
    "--json",
    "number,title,body,labels",
    "--limit",
    "200",
  ]);
  const raw = JSON.parse(stdout) as ReadonlyArray<{
    number: number;
    title: string;
    body: string;
    labels: ReadonlyArray<{ name: string }>;
  }>;
  return raw.map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body,
    labels: i.labels.map((l) => l.name),
  }));
}

// Authoritative state for a set of issue numbers, via a single GraphQL batch.
// Used for both blockers (the dependency gate) and the candidates themselves
// (the stale-search CLOSED guard, #16). GraphQL node lookups are strongly
// consistent, unlike the search backend `fetchCandidates` lists through.
export async function fetchIssueStates(
  numbers: readonly number[],
  repo: RepoRef,
): Promise<ReadonlyMap<number, IssueState>> {
  const result = new Map<number, IssueState>();
  if (numbers.length === 0) return result;
  const fields = [...new Set(numbers)]
    .map((n) => `i${n}: issue(number: ${n}) { state }`)
    .join("\n");
  const query = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){${fields}}}`;
  const { stdout } = await exec("gh", [
    "api",
    "graphql",
    "-F",
    `owner=${repo.owner}`,
    "-F",
    `repo=${repo.name}`,
    "-f",
    `query=${query}`,
  ]);
  const parsed = JSON.parse(stdout) as {
    data: {
      repository: Record<string, { state: string } | null>;
    };
  };
  for (const n of numbers) {
    const v = parsed.data.repository[`i${n}`];
    if (v) result.set(n, v.state === "CLOSED" ? "CLOSED" : "OPEN");
  }
  return result;
}

export async function buildPlan(
  repo: RepoRef,
  excluded: ReadonlySet<number> = new Set(),
  k: number = DEFAULT_K,
): Promise<Plan> {
  const candidates = await fetchCandidates(repo);
  // One GraphQL batch covers both the authoritative state of every candidate
  // (the #16 stale-search CLOSED guard) and of every blocker they reference.
  const wanted = new Set<number>();
  for (const c of candidates) {
    wanted.add(c.number);
    for (const n of parseBlockedBy(c.body)) wanted.add(n);
  }
  const states = await fetchIssueStates([...wanted], repo);
  return resolvePlan(candidates, states, excluded, k);
}
