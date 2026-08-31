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
// All ranking logic lives in pure functions (parseBlockedBy, resolvePlan) so it
// can be table-driven tested. The I/O wrappers (fetchCandidates,
// fetchIssueStates) are thin adapters over `gh`. The branch name a plan carries
// is built by `naming.ts`, which owns both of sandbar's branch shapes (#58) —
// the planner used to spell `sandbar/issue-<n>-<slug>` inline, which made the
// one thing preflight's globs key on a string in two modules.
//
// Lanes (#57). Every candidate also gets a LANE — `auto` (the gate is the last
// word) or `review` (a human looks first) — computed in `lanes.ts` from the
// `auto-land` label, `config.defaultLane`, and downward inheritance along the
// same `## Blocked by` edges this module already parses. The lane graph is the
// WHOLE candidate list, not the eligible subset: gating propagates from issues
// this cycle will not pick, and dropping them from the graph would let a
// descendant read as auto purely because its blocker was still open.
//
// ---------------------------------------------------------------------------
// When is a blocker satisfied? (#59, and §3 of the design in #54)
// ---------------------------------------------------------------------------
//
// It used to be one clause: a blocker is satisfied when it reads CLOSED, which
// for an auto-lane blocker means its work is on the source branch. Chunks add
// the second: a blocker is ALSO satisfied when it carries `IN_CHUNK_LABEL` and
// sits in the SAME chunk as the issue it blocks.
//
// The second clause exists because a chunk member never closes on its own. Its
// branch lands on the chunk's branch, not on the source branch, and the issue
// stays open until a human has reviewed the whole chunk. Under the CLOSED-only
// rule the next member of the same chunk would wait for a review of work it is
// supposed to be built on top of, so a chunk of five would need five separate
// human reviews taken in order — which is the exact opposite of what a chunk is
// for.
//
// It is safe for the same reason it is useful: the members of one chunk share a
// branch. When the dependent is worked, its blocker's commits are already on
// that branch and therefore under the dependent's feet, which is all "satisfied"
// has ever meant here.
//
// CROSS-CHUNK dependencies stay strict, and nothing about them is relaxed. An
// `in-chunk` blocker in a DIFFERENT chunk is on a different branch that has not
// reached the source branch, so its commits are not under the dependent at all;
// treating it as satisfied would start work on a base that does not exist. The
// dependent waits for that other chunk to land and its issues to close —
// exactly what `chunks.ts`'s two-chunk-parent rule already says such an issue
// must do. A dependent with no chunk of its own (an auto-lane issue, or one
// `chunks.ts` held back) fails the same test: `chunkOf` has no entry for it, and
// undefined is never equal to a chunk root.
//
// Two consequences for what this module LISTS. First, blockers are not
// necessarily candidates, so their labels cannot come from the candidate query
// — which is why `fetchIssueStates` now returns an `IssueFacts` (state AND
// labels) per issue rather than a bare state. Second, an issue that has landed
// on a chunk branch has swapped `ready-for-agent` for `in-chunk` and so has
// left the `fetchCandidates` query, yet it must stay in the graph this module
// derives lanes and chunks from — hence `fetchChunkMembers`, whose result
// `buildPlan` unions into the candidate list. Dropping those issues from the
// graph would break the feature in two separate ways: a chunk that has landed
// its root would re-derive itself around the members that are left, under a new
// root and so under a branch name nothing is on; and a descendant of a landed
// review-gated issue would read as AUTO (its gating ancestor having vanished
// from the lane graph) and auto-land unreviewed chunk code onto the source
// branch, which is the back door `lanes.ts` exists to shut. They are listed
// back in and then dropped from the plan by the `in-chunk` label itself: the
// label is the de-queue, and it de-queues here as explicitly as it does through
// the query.
//
// All of this is doubly inert under `defaultLane: "auto"`, where no issue is
// review-gated, no chunk is derived, and the second clause can never be
// reached.
//
// ---------------------------------------------------------------------------
// What the holding rule still covers (#60, and what #57 wrote it for)
// ---------------------------------------------------------------------------
//
// #57 held EVERY review-gated issue out of the plan, because working one could
// only have ended in auto-landing it — there was nowhere else for it to go.
// There is now: phase 3 merges a DONE review-gated issue onto its chunk's
// branch (#60). So the rule narrows to the issues that still have nowhere to
// land, and it narrows on exactly one axis — whether the issue is its chunk's
// ROOT.
//
// A root has no review-gated blocker, so nothing of its chunk's is under it.
// Its issue branch seeds from `origin/<sourceBranch>` (git-ops.ts) and its
// chunk branch is created at `origin/<sourceBranch>` when absent, so the tree
// it is developed against and the tree it lands on are the same one, and the
// merge is honest. A NON-ROOT member is built on a blocker whose commits sit
// on the chunk branch and nowhere else: seeded from origin it would be
// developed against a tree missing the very work it declares itself blocked
// by. Giving those members a branch seeded from the chunk is #61; until then
// they are held, exactly as #57 held them and for the same reason — no landing
// that is not a lie. An issue `chunks.ts` gave no chunk at all (a two-chunk
// parent, a cycle) is held on the same ground: `chunkOf` has no entry, so it
// is not any chunk's root.
//
// A chunk therefore admits at most ONE planned issue per cycle, since a chunk
// has exactly one root — which is also what keeps the merge phase's per-chunk
// grouping free of intra-chunk ordering questions.
//
// `resolvePlan` returns a RESOLUTION rather than a bare plan: the issues it
// held for review, and the `auto-land` labels inheritance overrode, are things
// the run has to report — held work that vanished from the plan without a word
// reads as an empty queue, and an overridden label read as honoured is a human
// believing an issue auto-lands when it never will. Each planned issue also
// carries its CHUNK (`PlannedIssue.chunk`), which is how the landing target
// reaches phase 3: the derivation needs the whole candidate graph and the
// merger sees only DONE branches, so deriving it there would answer a
// different question.
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

import {
  type ChunkTarget,
  IN_CHUNK_LABEL,
  type NamedChunk,
  deriveChunks,
} from "./chunks.js";
import {
  DEFAULT_LANE,
  type Lane,
  type LaneOverride,
  computeLanes,
  laneOverrides,
} from "./lanes.js";
import { issueBranchName } from "./naming.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";

const exec = promisify(execFile);

const WAITING_LABEL = "waiting";
const READY_LABEL = "ready-for-agent";
const DEFAULT_K = 3;

export type IssueState = "OPEN" | "CLOSED";

// What the authoritative (GraphQL) batch knows about one issue. The labels are
// carried for blockers, which are not necessarily candidates and so have no
// entry in the listing this module filters — see the header. An issue absent
// from the batch has no facts at all, and every read below treats that miss the
// safe way round.
export type IssueFacts = {
  readonly state: IssueState;
  readonly labels: readonly string[];
};

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
  // Where this issue's branch lands (#60). Null in the auto lane — the source
  // branch, as always. Non-null only for a review-gated issue, and then it is
  // its chunk's root and branch, computed here rather than re-derived in the
  // merge phase: the derivation needs the whole candidate graph, and phase 3
  // sees only the DONE branches.
  readonly chunk: ChunkTarget | null;
};

export type Plan = readonly PlannedIssue[];

export type PlanResolution = {
  readonly plan: Plan;
  // Issues that cleared every other filter and were held out of the plan by
  // the review lane's holding rule, in issue order. Empty for every host on
  // the default lane. Since #60 these are the review-gated issues that are not
  // their chunk's root (a chained member, waiting for #61) plus the ones
  // `chunks.ts` could give no chunk at all — never a chunk root, which now
  // plans.
  readonly heldForReview: readonly number[];
  // `auto-land` labels that inherited review-gating anyway (#57). Reported for
  // every candidate, not just the eligible ones: the contradiction is a fact
  // about the issue's labels, and a human wants it while the chain is still
  // being queued, not once it reaches the front.
  readonly overrides: readonly LaneOverride[];
  // Every chunk this candidate graph derives, members NAMED, by root (#64).
  //
  // Not a plan and not a landing decision: it is the answer to "which issues
  // are on `sandbar/chunk-<root>-<slug>`?", and nothing but this graph can give
  // it. Landing a reviewed chunk has to close its members and name them on the
  // pull request, while the merge phase sees only the cycle's DONE branches —
  // the same argument that puts `ChunkTarget.landed` here (#62), one level up.
  // Empty for every host on the default lane.
  readonly chunks: readonly NamedChunk[];
};

export function parseBlockedBy(body: string): readonly number[] {
  // Match `## Blocked by` (case-insensitive) and capture everything up to the
  // next H2 or end of body.
  const m = body.match(/##\s+Blocked by\s*\n([\s\S]*?)(?:\n##\s|$)/i);
  if (!m || !m[1]) return [];
  const refs = [...m[1].matchAll(/#(\d+)\b/g)].map((r) => Number(r[1]));
  return [...new Set(refs)];
}

export function resolvePlan(
  // `candidates` is the whole graph, not just the queue: `buildPlan` unions the
  // `in-chunk` members in (header), and the filter below drops them again.
  candidates: readonly IssueSummary[],
  issueFacts: ReadonlyMap<number, IssueFacts>,
  excluded: ReadonlySet<number> = new Set(),
  k: number = DEFAULT_K,
  defaultLane: Lane = DEFAULT_LANE,
): PlanResolution {
  // Parsed once and shared with the lane graph: the `## Blocked by` section is
  // the dependency gate below AND the edge set gating inherits along, and two
  // parses of one body are two chances for them to disagree.
  const blockedBy = new Map(
    candidates.map((c) => [c.number, parseBlockedBy(c.body)] as const),
  );
  const lanes = computeLanes(
    candidates.map((c) => ({
      number: c.number,
      labels: c.labels,
      blockedBy: blockedBy.get(c.number) ?? [],
    })),
    defaultLane,
  );
  // The same graph again, one layer up: chunk assignment is what makes the
  // in-chunk clause of `blockerSatisfied` a statement about ONE branch, and
  // since #60 it is also the landing target a planned review-gated issue
  // carries. `chunkOf` answers both "same chunk?" and "is this issue its
  // chunk's root?"; `chunks` names the branch.
  const { chunks, chunkOf } = deriveChunks(
    candidates.map((c) => ({
      number: c.number,
      title: c.title,
      blockedBy: blockedBy.get(c.number) ?? [],
    })),
    lanes,
  );
  const chunkByRoot = new Map(chunks.map((c) => [c.root, c] as const));

  // `in-chunk` from either source, because neither invents a label and each can
  // be missing one the other has: the authoritative batch may have skipped the
  // issue entirely, and the lagging search index may predate the flip. For the
  // de-queue below the union is the fail-safe reading outright — an issue named
  // by either source stays out of the plan. For the satisfaction clause it is
  // the permissive direction, and the case it could get wrong does not arise:
  // the only way to disagree that way round is a label the tracker has since
  // lost, and a member keeps `in-chunk` for as long as its commits sit on the
  // chunk branch — it loses the label when the chunk lands and the issue
  // closes, at which point the CLOSED clause above answers first anyway.
  const listedLabels = new Map(
    candidates.map((c) => [c.number, c.labels] as const),
  );
  const isInChunk = (n: number): boolean =>
    (issueFacts.get(n)?.labels ?? []).includes(IN_CHUNK_LABEL) ||
    (listedLabels.get(n) ?? []).includes(IN_CHUNK_LABEL);

  // The chunk an issue lands on, or null when it lands on the source branch.
  // Null covers both an auto-lane issue and a review-gated one `deriveChunks`
  // held back — the second can never reach the plan (see the lane filter
  // below), so a null here is always the auto lane by the time it is read.
  //
  // `landed` is the chunk PR's member list (#62): the members whose work is
  // already ON the branch, which is exactly the ones carrying `in-chunk`. It is
  // computed here rather than in the merge phase because only this function has
  // the whole candidate graph — phase 3 sees the cycle's DONE branches and
  // nothing else, so a chunk growing by one member per cycle would otherwise
  // get a PR that forgets every member but the newest. Titles come from the
  // listing, which carries every chunk member by construction:
  // `fetchChunkMembers` lists the landed ones back in, and `deriveChunks` only
  // ever names issues it was given.
  const titleOf = new Map(candidates.map((c) => [c.number, c.title] as const));
  const chunkTargetOf = (n: number): ChunkTarget | null => {
    const root = chunkOf.get(n);
    if (root === undefined) return null;
    const chunk = chunkByRoot.get(root);
    if (!chunk) return null;
    const landed = chunk.members
      .filter((m) => m !== n && isInChunk(m))
      .map((m) => ({ number: m, title: titleOf.get(m) ?? "" }));
    return { root: chunk.root, branch: chunk.branch, landed };
  };

  // CLOSED means the blocker's work is on the source branch. `in-chunk` in the
  // SAME chunk means it is on the branch this issue will be worked on. Nothing
  // else counts — a cross-chunk `in-chunk` blocker, or a dependent with no
  // chunk at all, leaves `theirs`/`ours` unequal (or undefined) and the issue
  // blocked. Header, "When is a blocker satisfied?" (#59).
  const blockerSatisfied = (blocker: number, dependent: number): boolean => {
    if (issueFacts.get(blocker)?.state === "CLOSED") return true;
    if (!isInChunk(blocker)) return false;
    const theirs = chunkOf.get(blocker);
    return theirs !== undefined && theirs === chunkOf.get(dependent);
  };

  const heldForReview: number[] = [];
  const eligible = candidates.filter((c) => {
    // Drop issues this run already merged, and issues the live tracker now
    // reports CLOSED — both guard against the stale-search re-pick described in
    // the module header (#16). Unknown state (absent from the map) is treated
    // as OPEN so a single state-fetch miss never silently drops a ready issue.
    if (excluded.has(c.number)) return false;
    if (issueFacts.get(c.number)?.state === "CLOSED") return false;
    // Already developed and already landed on its chunk's branch (#59). It is
    // here only to hold its place in the two graphs above, and it is dropped
    // before the review-lane hold below so it is never reported as "held": it
    // is not waiting for anything this cycle can give it.
    if (isInChunk(c.number)) return false;
    if (c.labels.includes(WAITING_LABEL)) return false;
    const blockers = blockedBy.get(c.number) ?? [];
    if (!blockers.every((n) => blockerSatisfied(n, c.number))) return false;
    // LAST, so `heldForReview` counts only issues that would otherwise have
    // been ELIGIBLE — not necessarily planned, since the K slice below can
    // still drop an eligible one. A review-gated issue that is also blocked,
    // closed or already merged is not being "held" by its lane; it was already
    // out on some other filter, and reporting it as held would make the
    // holding rule look like it costs more than it does.
    //
    // What is still held (#60): a review-gated issue that is not its chunk's
    // ROOT, and one `deriveChunks` gave no chunk at all. Everything else has
    // somewhere to land — see "What the holding rule still covers" above.
    if (lanes.get(c.number)?.lane === "review" && chunkOf.get(c.number) !== c.number) {
      heldForReview.push(c.number);
      return false;
    }
    return true;
  });
  // The derivation itself, members named, for the two consumers that need a
  // whole chunk rather than one issue's landing target (#64): the reader of the
  // `land` label and the reconciler. Every member has a title here for the same
  // reason `ChunkTarget.landed` does — `fetchChunkMembers` lists the landed
  // members back in, so the candidate listing carries every member of every
  // chunk by construction.
  const namedChunks: NamedChunk[] = chunks.map((c) => ({
    root: c.root,
    branch: c.branch,
    title: titleOf.get(c.root) ?? "",
    members: c.members.map((m) => ({ number: m, title: titleOf.get(m) ?? "" })),
  }));

  const sorted = [...eligible].sort((a, b) => a.number - b.number);
  const plan = sorted.slice(0, k).map((c) => ({
    id: String(c.number),
    title: c.title,
    branch: issueBranchName(c.number, c.title),
    chunk: chunkTargetOf(c.number),
  }));
  return {
    plan,
    heldForReview: heldForReview.sort((a, b) => a - b),
    overrides: laneOverrides(lanes),
    chunks: namedChunks,
  };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

async function listOpenIssuesLabelled(
  repo: RepoRef,
  label: string,
): Promise<readonly IssueSummary[]> {
  const { stdout } = await exec("gh", [
    "issue",
    "list",
    "--repo",
    repoSlug(repo),
    "--label",
    label,
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

// The queue: open and `ready-for-agent`. This is the set an issue is IN or OUT
// of, and preflight's resume classification reads it for exactly that meaning,
// so the chunk members below are deliberately not folded in here — a landed
// member is out of the queue, and its issue branch is not a branch this cycle
// resumes.
export async function fetchCandidates(
  repo: RepoRef,
): Promise<readonly IssueSummary[]> {
  return listOpenIssuesLabelled(repo, READY_LABEL);
}

// The issues already landed on a chunk branch (#59). Not queue members — they
// are never planned — but the lane and chunk graphs are wrong without them, for
// the two reasons the header spells out: a chunk re-rooted around its surviving
// members names a branch nothing is on, and a descendant whose gating ancestor
// left the graph reads as auto.
export async function fetchChunkMembers(
  repo: RepoRef,
): Promise<readonly IssueSummary[]> {
  return listOpenIssuesLabelled(repo, IN_CHUNK_LABEL);
}

// Authoritative facts for a set of issue numbers, via a single GraphQL batch.
// Used for both blockers (the dependency gate) and the candidates themselves
// (the stale-search CLOSED guard, #16). GraphQL node lookups are strongly
// consistent, unlike the search backend `fetchCandidates` lists through.
//
// LABELS as well as state since #59, and for blockers they are the only source
// there is: a blocker need not be a candidate, so the listing may not carry it
// at all, and `in-chunk` is now half of what "satisfied" means. `first: 100` is
// GitHub's own per-page maximum, so a truncated set would need an issue with
// more than a hundred labels; were one to exist, the missing label reads as
// "not in a chunk" and the dependent stays blocked, which is the harmless way
// to be wrong.
export async function fetchIssueStates(
  numbers: readonly number[],
  repo: RepoRef,
): Promise<ReadonlyMap<number, IssueFacts>> {
  const result = new Map<number, IssueFacts>();
  if (numbers.length === 0) return result;
  const fields = [...new Set(numbers)]
    .map(
      (n) =>
        `i${n}: issue(number: ${n}) { state labels(first: 100) { nodes { name } } }`,
    )
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
      repository: Record<
        string,
        {
          state: string;
          labels?: { nodes?: ReadonlyArray<{ name?: string } | null> | null };
        } | null
      >;
    };
  };
  for (const n of numbers) {
    const v = parsed.data.repository[`i${n}`];
    if (!v) continue;
    result.set(n, {
      state: v.state === "CLOSED" ? "CLOSED" : "OPEN",
      labels: (v.labels?.nodes ?? [])
        .map((l) => l?.name)
        .filter((name): name is string => typeof name === "string"),
    });
  }
  return result;
}

// Named options rather than a fourth positional: `defaultLane` is the one the
// single caller cares about and `k` the one it never passes, and
// `buildPlan(repo, merged, undefined, lane)` is a hole nobody should have to
// read past. `resolvePlan` keeps its positional shape — it is the table-tested
// pure function, and its tests state every argument anyway.
export type BuildPlanOptions = {
  readonly excluded?: ReadonlySet<number>;
  readonly k?: number;
  readonly defaultLane?: Lane;
};

export async function buildPlan(
  repo: RepoRef,
  options: BuildPlanOptions = {},
): Promise<PlanResolution> {
  const excluded = options.excluded ?? new Set<number>();
  const k = options.k ?? DEFAULT_K;
  // The queue plus the issues already landed on a chunk branch (#59). Two
  // queries because `gh issue list --label` ANDs its labels, and one graph
  // because lanes and chunks are only right over both sets. Deduped by number,
  // queue entry winning, for the one case the lagging search index can produce:
  // an issue mid-flip showing up under both labels at once.
  const listed = [
    ...(await fetchCandidates(repo)),
    ...(await fetchChunkMembers(repo)),
  ];
  const byNumber = new Map<number, IssueSummary>();
  for (const issue of listed) {
    if (!byNumber.has(issue.number)) byNumber.set(issue.number, issue);
  }
  const candidates = [...byNumber.values()];
  // One GraphQL batch covers both the authoritative facts of every candidate
  // (the #16 stale-search CLOSED guard) and of every blocker they reference.
  const wanted = new Set<number>();
  for (const c of candidates) {
    wanted.add(c.number);
    for (const n of parseBlockedBy(c.body)) wanted.add(n);
  }
  const facts = await fetchIssueStates([...wanted], repo);
  return resolvePlan(
    candidates,
    facts,
    excluded,
    k,
    options.defaultLane ?? DEFAULT_LANE,
  );
}
