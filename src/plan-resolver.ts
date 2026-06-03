// Deterministic plan resolver.
//
// Picks the issues that are ready to work this cycle by parsing the
// `## Blocked by` section that /to-issues writes into every ready-for-agent
// issue and batch-checking the referenced issues' state.
//
// All ranking logic lives in pure functions (parseBlockedBy, kebabSlug,
// resolvePlan) so it can be table-driven tested. The I/O wrappers
// (fetchCandidates, fetchBlockerStates) are thin adapters over `gh`.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { BRANCH_PREFIX } from "./naming.js";

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

export type RepoRef = {
  readonly owner: string;
  readonly name: string;
};

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
  blockerStates: ReadonlyMap<number, IssueState>,
  k: number = DEFAULT_K,
): Plan {
  const eligible = candidates.filter((c) => {
    if (c.labels.includes(WAITING_LABEL)) return false;
    const blockers = parseBlockedBy(c.body);
    return blockers.every((n) => blockerStates.get(n) === "CLOSED");
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

export async function fetchCandidates(): Promise<readonly IssueSummary[]> {
  const { stdout } = await exec("gh", [
    "issue",
    "list",
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

export async function fetchBlockerStates(
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
  k: number = DEFAULT_K,
): Promise<Plan> {
  const candidates = await fetchCandidates();
  const referenced = new Set<number>();
  for (const c of candidates) for (const n of parseBlockedBy(c.body)) referenced.add(n);
  const states = await fetchBlockerStates([...referenced], repo);
  return resolvePlan(candidates, states, k);
}
