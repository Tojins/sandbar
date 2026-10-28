// Chunk derivation — which review-gated issues land together, on one branch a
// human reviews once (#58, and §2 of the design in #54).
//
// A chunk is DERIVED, never declared. Nobody labels an issue "chunk 3"; the
// chunk falls out of two things sandbar already knows: the lane of each issue
// (`lanes.ts`) and the `## Blocked by` edges the planner already parses. A
// chunk is a connected component of the REVIEW-GATED issues under those edges
// taken in BOTH directions (#193), and a review-gated issue with no
// review-gated neighbours is a chunk of one.
//
// That is the only definition that can be right, because it is the only one
// that matches what a human reviewing the branch is actually looking at. Two
// review-gated issues joined by a blocked-by edge cannot be reviewed apart: the
// dependent's diff is written on top of the blocker's commits, so a review of
// the dependent alone is a review of a tree that includes unreviewed code, and
// a review of the blocker alone approves something the series then changes.
// Conversely, two review-gated issues with no path between them share nothing —
// putting them on one branch would only make a human's review bigger and couple
// two landings that have no reason to be coupled.
//
// Both directions, because a series is filed that way. A freshly filed series
// often has several independent roots that all lead into one final issue, the
// one carrying the human review: #751 → #752, plus #753 and #754, all blocking
// #677. Following edges only downward from each root gives three chunks and
// holds #677 until all three are reviewed and landed apart, which is not what
// the person filing it meant. So a chunk may have several PARENTLESS members,
// and independent roots inside it are worked in parallel.
//
// The lane is the input, not a second opinion about it. Everything here reads
// `lanes.get(n).lane === "review"`, which already carries #57's downward
// inheritance, so a descendant of a review-gated issue is review-gated and
// therefore in its ancestor's chunk by construction. An issue in the AUTO lane
// is not in any chunk and never appears in this module's output: it lands
// through the merger, one branch per issue, exactly as before.
//
// Still a PURE FUNCTION: this module creates no branch and writes no label. It
// answers which issues share a landing target and what that target is called,
// and since #60 the merge phase acts on the answer — a DONE review-gated issue
// is merged onto `chunk.branch` instead of onto the source branch, and finalise
// then puts the display-only `needs-review` label on it.
//
// A whole chunk is WORKED, one layer at a time. `plan-resolver.ts` plans any
// member whose blockers are satisfied (#61). A parentless member that has not
// landed seeds from `origin/<sourceBranch>` and the merger merges it onto the
// chunk branch, creating that branch on the chunk's first landing; every
// member with a blocker inside the chunk, and rework of a landed member, seeds
// from the chunk's TIP, which is where its blockers' commits actually are
// (`ChunkTarget.seed`, read by `git-ops.ts`). A chained member is unblocked by
// a blocker whose origin member ref is contained by the chunk branch, visible
// in the cycle AFTER the one that landed it, so a chain grows one LAYER per
// cycle and every member planned together is a sibling or another root.
//
// What is still held is a review-gated issue with NO chunk — the output of
// `blocked` below. There is no branch to name and no tip to seed from, so
// working it could only end in auto-landing unreviewed code.
//
// ---------------------------------------------------------------------------
// `needs-review`, the display label a landed member carries (#93)
// ---------------------------------------------------------------------------
//
// A review-gated issue whose branch has landed on its chunk's branch is done as
// far as sandbar is concerned, and not done at all as far as a human is:
// nothing has reached the source branch yet, and the review that would justify
// closing the issue has not happened. So the issue stays OPEN, and sandbar
// attempts to replace `ready-for-agent` with `needs-review` for humans.
//
// The swap is not authoritative. Containment by any fetched chunk branch is
// the fail-safe de-queue fact; membership on the exact selected branch is the
// stricter blocker-satisfaction fact. Membership is never read from a label.
// The planner reads those members from git and fetches their issues back into
// the candidate graph, and a landed member answers to the branch carrying it,
// so the chunk cannot re-root around whatever remains queued.
//
// Hardcoded, not a `LabelConfig` knob: configurability is outside #93's scope,
// and the name is embedded in human-facing prose across finalise, chunk
// wrap-up, and the pull-request flow. This declaration is also exported for
// host setup scripts, so one protocol spelling keeps all of those surfaces in
// step. The declaration is below the imports.
//
// ---------------------------------------------------------------------------
// Underway chunks: join, never merge (#193)
// ---------------------------------------------------------------------------
//
// Plain connected components are right for a series nobody has started, and
// wrong for work already in progress: an issue filed across two unrelated
// review series would silently fuse both into one branch, and the human who
// was reviewing a three-issue chunk is handed nine issues they never agreed to
// look at together — retroactively, to work that may already be on origin.
//
// So a component is UNDERWAY once a member is in flight (dispatched to a
// sandbox, `inFlight`; a restart drains running work, so this stays accurate)
// or has landed on a chunk branch (`originChunks`). An underway chunk has an
// IDENTITY — the root its origin branch, or its in-flight members' dispatched
// targets, already name — and keeps it: a lower-numbered root joining later
// never renames it, so there is no spurious `rerooted` drift, and a member's
// `ChunkTarget` is never re-targeted after dispatch. A landed member answers to
// the root encoded in the branch carrying its member ref; a ref inherited
// through the source branch can sit on several branches at once, and the root
// connected to the member, then the lowest, wins.
//
// A not-yet-started part of the graph JOINS the one underway chunk it connects
// to. An issue that would join two or more underway chunks is held
// (`joins-two-chunks`), and so is everything downstream of it
// (`unchunked-blocker`). Chunk branches are never merged; the cost falls on
// the one issue that straddles, which waits for one side to land and close.
//
// ---------------------------------------------------------------------------
// Why the walk is topological, over a union-find
// ---------------------------------------------------------------------------
//
// Groups are built by union-find, each issue uniting with its blockers once
// all of them are decided — Kahn's order over the review-gated subgraph,
// smallest issue number first among the ready set purely so the output is
// deterministic. Uniting every edge from the dependent's side is what makes
// the components undirected: fresh roots A and B with X blocked by both become
// one group through X. The order matters only at the join rule: a group's
// identity is fixed by the first underway chunk it unites with, and an issue
// whose blockers' groups carry two identities is held rather than united. An
// underway issue keeps its identity whatever its edges say, and pulls in any
// fresh group among its blockers. A fresh group that contains the very issue
// an underway chunk is named after joins that chunk: a root belongs to the
// chunk it names.
//
// Root of a FRESH group: its lowest-numbered parentless member — a total rule,
// and the one #58 specified. It becomes the identity once a member is
// dispatched with a target naming it.
//
// CYCLES are hostile input: two issues can name each other under `## Blocked
// by`, and a human wrote them. Kahn's simply never reaches those nodes, nor
// anything downstream of them, and a not-yet-started one comes out `blocked`
// with reason `cycle`. That is the honest answer rather than a diagnostic
// failure — a cycle has no parentless member, so it has no root, so it cannot
// be named; and the planner deadlocks on a cyclic pair regardless, since
// neither blocker will ever read CLOSED. An underway issue keeps its chunk.
//
// ---------------------------------------------------------------------------
// Settling: fresh components wait for the graph to hold still (#193)
// ---------------------------------------------------------------------------
//
// A series is published one issue at a time, and a poll that lands between
// two of them sees roots that a later issue will connect. Started then, they
// would be two underway chunks and the connecting issue would be held. So a
// FRESH component — one no underway chunk claims — starts only once two
// consecutive polls see the same `pendingGraph`: every review-gated issue no
// underway chunk claims, with its edges among those issues (auto-lane issues
// and underway chunks are ignored, so their churn does not hold new work —
// on both sides of the comparison, so an issue that became underway since the
// previous poll leaves the remembered graph too, and one fresh chunk starting
// does not cost every other fresh component another poll).
// Until then its members are `unsettled`. Joining an underway chunk needs no
// settling: a later issue can only join the same chunk or be held.
//
// The previous poll's graph is the caller's memory (`run.ts`), handed back as
// `settledGraph`: no extra GitHub calls and no time knob, and a restart costs
// one extra poll. That is what lets a series published in one go be chunked
// as a whole.
//
// ---------------------------------------------------------------------------
// What is NOT an edge
// ---------------------------------------------------------------------------
//
// Only blockers that are themselves review-gated members of the input set
// contribute. A blocker in the auto lane lands on the source branch through the
// merger, so by the time the dependent is worked it is "on main" and there is
// nothing to share a branch with. A blocker OUTSIDE the input set contributes
// nothing either, for the reason `lanes.ts` gives at length: sandbar has the
// labels only of the issues it listed, so there is no lane to read — and an
// issue with an unresolvable blocker is out of the plan on that ground anyway.
// A self-edge (`#10` inside #10's own `## Blocked by`) is dropped, exactly as
// in `lanes.ts`: an issue is not its own blocker, and keeping it would give
// every self-referencing issue an in-degree Kahn's could never retire.

import type { Lane } from "./lanes.js";
import { chunkBranchName, rootIssueFromChunkBranch } from "./naming.js";

// The display label a review-gated issue carries once its work is on its chunk
// branch: OPEN and still to be reviewed. Sandbar writes and later removes it,
// but never reads it; git history is the membership source of truth (#93).
export const NEEDS_REVIEW_LABEL = "needs-review";

// The label a HUMAN puts on a chunk's pull request to land it (#64). The other
// end of the same lifecycle: `needs-review` tells a human review is pending,
// `land` says a reviewer is done with it and the next run should merge the
// branch into the source branch and close every member on it.
//
// Here rather than in `chunk-land.ts`, which owns everything ABOUT it — why it
// is a label and not an approval, why it sits on the pull request, and how it
// behaves as a queue. What lives here is the SPELLING, beside the other chunk
// protocol label, so the module that writes the invitation into the PR body,
// the module that reads it off the forge and the module that takes it back off
// again cannot come to disagree about the string. Hardcoded for the reason
// above and the one `lanes.ts` gives for `auto-land`: it is protocol a human
// uses to address sandbar, not a host's handoff vocabulary.
export const LAND_LABEL = "land";

// `land`, but past a closed landing window (#244, `landing-window.ts`): a
// hotfix a human wants on the source branch now. Otherwise it is `land` in
// every respect, and both are taken off together.
export const LAND_HOTFIX_LABEL = "land-hotfix";

export const LAND_REQUEST_LABELS: readonly string[] = [LAND_LABEL, LAND_HOTFIX_LABEL];

// An issue named as part of a chunk, in the one form the review surface needs
// it: a number and the title a human reads next to it (#62).
export type ChunkMember = {
  readonly number: number;
  readonly title: string;
};

// An origin branch that cannot safely stand for today's derived chunk. Kept
// as a domain fact rather than landing prose: the planner discovers it from
// the graph and origin inventory, while the landing selector decides whether
// a labelled pull request must be refused (#176).
export type ChunkBranchDrift = {
  readonly existing: string;
  readonly root: number;
  // What this exact branch carries according to its member refs, ascending.
  readonly members: readonly ChunkMember[];
  readonly cause:
    | { readonly kind: "rerooted"; readonly derived: string }
    | { readonly kind: "orphaned" }
    | {
        readonly kind: "ambiguous";
        readonly competing: readonly string[];
      };
};

// Where a review-gated issue lands. Carried on a planned issue so the merge
// phase can point at a chunk without re-deriving one (#60): `root` identifies
// the chunk, `branch` is the ref its members' commits are merged onto and
// pushed to. Absent (or null) on an auto-lane issue, which lands on the source
// branch as everything did before chunks existed.
export type ChunkTarget = {
  readonly root: number;
  readonly branch: string;
  // The chunk's members that were ALREADY on `branch` when the plan was built
  // — the ones whose origin member refs it contains (#62, #93). Ascending, and never including
  // the issue carrying this target, which is on its way there and not there
  // yet.
  //
  // It rides here because the chunk PR's body has to list everything the
  // branch carries, and the merge phase knows only what IT landed: a chunk
  // whose second member lands next cycle would otherwise get a PR describing
  // that member alone, dropping the first — the same wrong-record failure the
  // create-or-update discipline exists to prevent, arriving from the other
  // side. The whole candidate graph is what knows the answer, and that graph
  // only exists in the plan.
  //
  // A SNAPSHOT, and prose only. Nothing may branch a landing decision on it:
  // it was read from the tracker before phase 2 ran, and the authority on what
  // is on the chunk branch is origin. Optional for the same reason `chunk`
  // itself is optional on `IssueRef` — the dozen hand-built targets in tests
  // and context builders have nothing to say about it, and an absent list
  // reads as "none known", which is what they mean.
  readonly landed?: readonly ChunkMember[];
  // Where this member's issue branch is cut (#193), decided at plan time and
  // fixed at dispatch like the rest of the target. "source" for a parentless
  // member that has not landed: it builds on nothing else in the chunk, so it
  // seeds from `origin/<sourceBranch>` and the merger merges it onto the
  // chunk branch, creating that branch on the chunk's first landing. "tip"
  // for a member with blockers inside the chunk and for rework of a landed
  // member: their work has to sit on top of what the chunk branch carries.
  // Absent reads as "tip", the answer that can only refuse, never mis-seed.
  readonly seed?: "source" | "tip";
};

// A chunk that must catch up to the source branch before one or more chained
// members may be admitted (#174). The planner groups triggering dependents by
// branch; the merger refreshes that branch once and parks every dependent if
// the shared refresh cannot be made green.
export type ChunkRefresh = {
  readonly root: number;
  readonly branch: string;
  readonly title: string;
  readonly dependents: readonly ChunkMember[];
};

// The minimum a chunk decision needs. `title` is here and not in `LaneIssue`
// because a chunk, unlike a lane, has a NAME: the branch is slugged from the
// root issue's title.
export type ChunkIssue = {
  readonly number: number;
  readonly title: string;
  readonly blockedBy: readonly number[];
};

export type Chunk = {
  // The chunk's identity: the root its origin branch or its in-flight
  // members' targets already name, and before either exists the
  // lowest-numbered parentless member. It names the branch and identifies the
  // chunk everywhere else. Not necessarily a member: an underway chunk keeps
  // its root even once that issue has left the graph.
  readonly root: number;
  // Every issue that lands on this chunk's branch, ascending.
  readonly members: readonly number[];
  // The members with no blocker inside the chunk, ascending: its roots in the
  // plural sense. Each seeds from the source branch until it has landed.
  readonly parentless: readonly number[];
  // `sandbar/chunk-<root>-<slug>`. One origin branch for `root` keeps its
  // existing name across title edits; otherwise the name is derived from the
  // current title. This function remains pure because origin's branch names
  // are an explicit input.
  readonly branch: string;
};

// A chunk that has WORK ON ORIGIN, and what the consumers of the review
// surface need to know about it (#63, #64). Derived after the fact from a
// `Chunk` and the set of members read from the chunk branch — see
// `landedChunksOf`. Only the PLAN can build one: the titles come from the
// candidate listing and the membership from the graph that listing carries.
export type LandedChunk = {
  readonly root: number;
  readonly branch: string;
  // The ROOT issue's current title. Names the chunk in the merge commit a
  // landing writes and in the prose it posts (#64), whether or not the root is
  // among `members`. Its slug may differ from an existing branch after a title
  // edit; the root number, not this display string, is the durable identity.
  readonly title: string;
  // Every LANDED member, ascending: the issues whose commits are on the branch.
  //
  // This is the list a landing CLOSES (#64), which is the whole reason it is
  // the git-derived members rather than `Chunk.members`. A component holds
  // members that have never been worked — a chained member waits for its
  // blockers to land — and closing one of those would destroy a queued issue
  // while telling a human its commits were on the source branch. It is the
  // same set the chunk's pull request lists (#62), so a landing closes exactly
  // what that PR said it carried.
  readonly members: readonly ChunkMember[];
  // The same members, in the one order a landing may CLOSE them in: every
  // member before every member it is blocked by, so the ROOT is last.
  //
  // A permutation of `members` rather than a re-ordering of it because the two
  // answer different questions — `members` is what the branch carries, which a
  // human reads ascending, and this is a fact about the blocked-by graph that
  // only the derivation can compute. It is here for one reason, and the reason
  // is what happens when a close FAILS. The wrap-up stops there and keeps the
  // branch so the next cycle's reconciler retries it, and that retry finds the
  // chunk again only if it still has the same root identity and members.
  //
  // Since #193 that holds structurally: the closed members are still on the
  // kept branch, `buildPlan` fetches them back into the graph by their member
  // refs, and a landed member answers to the root its branch encodes — so the
  // next cycle derives the same chunk, root and branch, multi-root or not,
  // which is the promise the landing's own prose makes to a human. The order
  // is kept as the second line of that argument: the members left open are
  // every ancestor of the one that failed plus everything not yet attempted,
  // so the open remainder still reaches the root through open members even
  // for a reader that ignored closed ones.
  readonly closeOrder: readonly ChunkMember[];
  // Members explicitly put back in the authoritative agent queue for rework.
  readonly rework: readonly ChunkMember[];
  // The landed members that no OTHER landed member is blocked by — the tips of
  // what the branch carries, ascending. Non-empty, and a subset of `members`:
  // the lowest-numbered tip is the deterministic fallback when review feedback
  // has no uniquely owning member path (#95). That fallback changes only whose
  // issue history records the rework; every landed member may fix it.
  readonly tips: readonly ChunkMember[];
};

// Why an issue got no chunk. All four mean "wait", never "give up".
//
//   joins-two-chunks  — placing it would join two or more UNDERWAY chunks (the
//                       join rule above). Resolves when those chunks land.
//   unchunked-blocker — a blocker of its own has no chunk, so neither can it.
//                       The transitive shadow of the other reasons.
//   cycle             — it is inside a `## Blocked by` cycle, or downstream of
//                       one. Resolves only when a human edits the bodies.
//   unsettled         — it is in a fresh component and the pending graph has
//                       not yet held still across two polls. Resolves on its
//                       own once it does.
export type ChunkBlockReason =
  | "joins-two-chunks"
  | "unchunked-blocker"
  | "cycle"
  | "unsettled";

export type ChunkBlock = {
  readonly issue: number;
  readonly reason: ChunkBlockReason;
  // The review-gated blockers that account for the reason, ascending: ALL of
  // them for `joins-two-chunks` (it is the set of chunks they land in that
  // conflicts, so no subset states it — or, for a fresh component holding
  // several underway roots, those roots) and for `cycle` (which edge closes
  // the loop is not decided here), only the ones with no chunk of their own for
  // `unchunked-blocker`, and none for `unsettled`. Resolve them through
  // `chunkOf` to name the chunks.
  readonly blockers: readonly number[];
};

export type ChunkDerivation = {
  // By root, ascending.
  readonly chunks: readonly Chunk[];
  // Member issue -> its chunk's root. Every issue in `chunks[].members` and
  // nothing else — an auto-lane issue and a blocked one are both absent.
  readonly chunkOf: ReadonlyMap<number, number>;
  // Review-gated issues that landed in no chunk, in issue order.
  readonly blocked: readonly ChunkBlock[];
  // The settling key: every review-gated issue no underway chunk claims, with
  // its `## Blocked by` edges among those issues, in one canonical string.
  // The caller remembers it across polls and hands it back as
  // `settledGraph`; nothing else may read meaning into its spelling.
  readonly pendingGraph: string;
};

const ascending = (a: number, b: number): number => a - b;

export function chunkBranchesByRoot(
  branches: readonly string[],
): ReadonlyMap<number, readonly string[]> {
  const byRoot = new Map<number, string[]>();
  for (const branch of branches) {
    const root = rootIssueFromChunkBranch(branch);
    if (root === null) continue;
    const existing = byRoot.get(root);
    if (existing) existing.push(branch);
    else byRoot.set(root, [branch]);
  }
  return byRoot;
}

// What the derivation is told about work already underway, and about the
// graph the previous polls saw. Every field is optional so a table test can
// state a bare graph; `plan-resolver.ts` passes all of them.
export type DeriveChunksOptions = {
  // Origin's chunk branches, each with the issues whose member refs it
  // contains (`readChunkMembers`). A contained member has LANDED, so its
  // component is underway, and the branch's encoded root is its identity.
  readonly originChunks?: ReadonlyMap<string, ReadonlySet<number>>;
  // In-flight issues and the chunk their dispatched `ChunkTarget` names.
  // Fixed at dispatch, so it is identity, not a second opinion about it.
  readonly inFlight?: ReadonlyMap<number, ChunkTarget>;
  // The pending graph the caller accepts as settled (see "Settling" above):
  // fresh components start only when today's `pendingGraph` equals it.
  // Undefined disables the gate — every fresh component starts — which is
  // what a table test about shapes wants; null settles nothing.
  readonly settledGraph?: string | null;
};

// `lanes` is typed to the one field it reads rather than to `LaneDecision`, so
// the table tests can state a lane instead of building a decision around it.
// A `computeLanes` result is assignable as-is.
export function deriveChunks(
  issues: readonly ChunkIssue[],
  lanes: ReadonlyMap<number, { readonly lane: Lane }>,
  options: DeriveChunksOptions = {},
): ChunkDerivation {
  const originChunks = options.originChunks ?? new Map<string, ReadonlySet<number>>();
  const inFlight = options.inFlight ?? new Map<number, ChunkTarget>();
  const gated = new Map<number, ChunkIssue>();
  for (const issue of issues) {
    if (lanes.get(issue.number)?.lane === "review") gated.set(issue.number, issue);
  }

  // Parents = the review-gated blockers inside the set, deduped and ascending;
  // children is the same edge set reversed, which is the direction Kahn's walks.
  const parents = new Map<number, readonly number[]>();
  const children = new Map<number, number[]>();
  for (const [number, issue] of gated) {
    const blockers = [...new Set(issue.blockedBy)]
      .filter((b) => b !== number && gated.has(b))
      .sort(ascending);
    parents.set(number, blockers);
    for (const blocker of blockers) {
      const existing = children.get(blocker);
      if (existing) existing.push(number);
      else children.set(blocker, [number]);
    }
  }

  // The whole graph's components, edges in both directions. Read only to
  // disambiguate a member ref contained by more than one chunk branch (below).
  const whole = new UnionFind();
  for (const [number, blockers] of parents) {
    whole.add(number);
    for (const blocker of blockers) whole.union(number, blocker);
  }

  // Identity of every UNDERWAY issue: the root its chunk already answers to.
  // An in-flight member's dispatched target wins; a landed member answers to
  // the root encoded in the branch carrying its member ref. A ref inherited
  // through the source branch can make several branches contain one member, so
  // prefer a root connected to it, then the lowest — the older chunk, which is
  // the one that inherited copies came from.
  const containing = new Map<number, number[]>();
  for (const [branch, members] of originChunks) {
    const root = rootIssueFromChunkBranch(branch);
    if (root === null) continue;
    for (const member of members) {
      const roots = containing.get(member);
      if (roots) roots.push(root);
      else containing.set(member, [root]);
    }
  }
  const identityOf = new Map<number, number>();
  for (const number of gated.keys()) {
    const dispatched = inFlight.get(number);
    if (dispatched) {
      identityOf.set(number, dispatched.root);
      continue;
    }
    const roots = [...new Set(containing.get(number) ?? [])].sort(ascending);
    if (roots.length === 0) continue;
    const connected = roots.filter(
      (r) => gated.has(r) && whole.find(r) === whole.find(number),
    );
    identityOf.set(number, connected[0] ?? roots[0]!);
  }
  const underwayRoots = new Set(identityOf.values());

  // Groups are built by union-find; a group's identity is the underway root it
  // answers to, or absent while it is FRESH. Two identities never meet in one
  // group: every union below is refused, or held, when it would do that.
  const groups = new UnionFind();
  const identity = new Map<number, number>();
  const identityOfGroup = (n: number): number | undefined => identity.get(groups.find(n));
  const join = (a: number, b: number): void => {
    const id = identityOfGroup(a) ?? identityOfGroup(b);
    const top = groups.union(a, b);
    if (id !== undefined) identity.set(top, id);
  };
  for (const [number, root] of identityOf) {
    groups.add(number);
    identity.set(groups.find(number), root);
  }

  const held = new Map<number, ChunkBlock>();
  const indegree = new Map<number, number>();
  for (const [number, blockers] of parents) indegree.set(number, blockers.length);
  const reached = new Set<number>();
  const ready = [...gated.keys()].filter((n) => indegree.get(n) === 0);
  ready.sort(ascending);
  while (ready.length > 0) {
    const number = ready.shift();
    if (number === undefined) break;
    reached.add(number);
    // Every blocker is decided by now: placed in a group, or held.
    const blockers = parents.get(number) ?? [];
    if (identityOf.has(number)) {
      // Underway already. It keeps its identity whatever its edges say, and
      // pulls in any FRESH blocker group — the join rule, read from below.
      for (const b of blockers) {
        if (groups.has(b) && identityOfGroup(b) === undefined) join(number, b);
      }
    } else {
      const unchunked = blockers.filter((b) => !groups.has(b));
      const ids = new Set(
        blockers
          .map(identityOfGroup)
          .filter((id): id is number => id !== undefined),
      );
      if (unchunked.length > 0) {
        held.set(number, { issue: number, reason: "unchunked-blocker", blockers: unchunked });
      } else if (ids.size > 1) {
        held.set(number, { issue: number, reason: "joins-two-chunks", blockers });
      } else {
        groups.add(number);
        for (const b of blockers) join(number, b);
      }
    }

    // Retire the edge whether this issue got a group or not: a dependent of a
    // held issue still has to be DECIDED (as `unchunked-blocker`), and leaving
    // its in-degree standing would silently reclassify it as a cycle.
    for (const child of children.get(number) ?? []) {
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) {
        ready.push(child);
        ready.sort(ascending);
      }
    }
  }

  // Whatever Kahn's never reached is in a `## Blocked by` cycle or downstream
  // of one. An underway member keeps the group it was seeded into above.
  for (const number of [...gated.keys()].sort(ascending)) {
    if (reached.has(number) || identityOf.has(number)) continue;
    held.set(number, { issue: number, reason: "cycle", blockers: parents.get(number) ?? [] });
  }

  // Members of each group, keyed by the group's union-find top.
  const membersOf = new Map<number, number[]>();
  for (const number of [...gated.keys()].sort(ascending)) {
    if (!groups.has(number)) continue;
    const top = groups.find(number);
    const members = membersOf.get(top);
    if (members) members.push(number);
    else membersOf.set(top, [number]);
  }

  // A fresh group holding the very issue an underway chunk is named after is
  // that chunk's: the root belongs to the chunk it names. Holding two such
  // issues would join two underway chunks, so it is held instead.
  for (const [top, members] of membersOf) {
    if (identity.has(top)) continue;
    const named = [...new Set(members.filter((m) => underwayRoots.has(m)))];
    if (named.length === 1) identity.set(top, named[0]!);
    else if (named.length > 1) {
      for (const m of members) {
        held.set(m, { issue: m, reason: "joins-two-chunks", blockers: named });
      }
      membersOf.delete(top);
    }
  }

  // The settling comparison: every review-gated issue no underway chunk
  // claims, with its edges among those issues.
  const underway = (n: number): boolean =>
    groups.has(n) && membersOf.has(groups.find(n)) && identity.has(groups.find(n));
  const pending = [...gated.keys()].filter((n) => !underway(n)).sort(ascending);
  const pendingSet = new Set(pending);
  const pendingGraph = graphKey(
    pending.map((n) => [n, (parents.get(n) ?? []).filter((p) => pendingSet.has(p))]),
  );
  // Underway chunks are ignored on BOTH sides: an issue that has become
  // underway since the previous poll (a fresh chunk that just started, an
  // issue that joined one) leaves the remembered graph too, so one chunk
  // starting does not cost every other fresh component another poll.
  const settled = options.settledGraph === undefined || (
    options.settledGraph !== null &&
    graphKey(
      parseGraphKey(options.settledGraph)
        .filter(([n]) => !underway(n))
        .map(([n, edges]) => [n, edges.filter((e) => !underway(e))]),
    ) === pendingGraph
  );

  const byRoot = new Map<number, number[]>();
  for (const [top, members] of membersOf) {
    let root = identity.get(top);
    if (root === undefined) {
      if (!settled) {
        for (const m of members) held.set(m, { issue: m, reason: "unsettled", blockers: [] });
        continue;
      }
      const inGroup = new Set(members);
      // `members` is non-empty and holds no cycle, so a parentless member
      // exists; the fallback is here because an index is typed `T | undefined`.
      root = members.find(
        (m) => !(parents.get(m) ?? []).some((p) => inGroup.has(p)),
      ) ?? members[0]!;
    }
    const existing = byRoot.get(root);
    if (existing) existing.push(...members);
    else byRoot.set(root, [...members]);
  }

  const chunks: Chunk[] = [];
  const chunkOf = new Map<number, number>();
  const originBranchesByRoot = chunkBranchesByRoot([...originChunks.keys()].sort());
  for (const [root, rawMembers] of byRoot) {
    const members = [...rawMembers].sort(ascending);
    const inChunk = new Set(members);
    // Parentless WITHIN the chunk: blockers outside it are on the source
    // branch (or in the auto lane and heading there).
    const parentless = members.filter(
      (m) => !(parents.get(m) ?? []).some((p) => inChunk.has(p)),
    );
    const originBranches = originBranchesByRoot.get(root) ?? [];
    // The issue number is the durable identity. One existing origin branch
    // for this root wins over today's spelling, and before the first landing
    // so does the branch an in-flight member was dispatched to. More than one
    // origin branch is deliberately not selected: the planner reports every
    // competing branch as drifted and holds new work.
    const dispatched = members
      .map((m) => inFlight.get(m))
      .find((t) => t !== undefined && t.root === root)?.branch;
    const branch = originBranches.length === 1
      ? originBranches[0]!
      : originBranches.length === 0 && dispatched !== undefined
      ? dispatched
      : chunkBranchName(root, gated.get(root)?.title ?? "");
    chunks.push({ root, members, parentless, branch });
    for (const member of members) chunkOf.set(member, root);
  }
  chunks.sort((a, b) => a.root - b.root);

  const blocked = [...held.values()].sort((a, b) => a.issue - b.issue);
  return { chunks, chunkOf, blocked, pendingGraph };
}

// `pendingGraph`'s spelling: ascending issues, each with its ascending
// in-graph blockers, as `n` or `n<a,b`, space-separated. Only this module
// writes or reads it.
type GraphEntry = readonly [number, readonly number[]];

function graphKey(entries: readonly GraphEntry[]): string {
  return [...entries]
    .sort((a, b) => a[0] - b[0])
    .map(([n, edges]) => {
      const sorted = [...edges].sort(ascending);
      return sorted.length > 0 ? `${n}<${sorted.join(",")}` : `${n}`;
    })
    .join(" ");
}

function parseGraphKey(key: string): readonly GraphEntry[] {
  return key.split(" ").filter(Boolean).map((token): GraphEntry => {
    const [n, edges] = token.split("<");
    return [Number(n), edges ? edges.split(",").map(Number) : []];
  });
}

// The settling memory `run.ts` carries across recomputes (#193): the pending
// graph the latest poll saw, and whether it equalled the one the poll before
// saw. Kept in memory only, so a restart costs one extra poll.
export type ChunkSettleMemory = {
  readonly lastPoll: string | null;
  readonly agreed: boolean;
};

export const UNSETTLED: ChunkSettleMemory = { lastPoll: null, agreed: false };

// The `settledGraph` a recompute may plan with. At a poll, the previous
// poll's graph: today's settles iff the two consecutive polls agree. Between
// polls (a freed slot, a landing), only a graph two polls already agreed on —
// otherwise a recompute seconds after a poll would settle a series that is
// still being published.
export function settledGraphFor(
  memory: ChunkSettleMemory,
  atPoll: boolean,
): string | null {
  return atPoll || memory.agreed ? memory.lastPoll : null;
}

// What a poll's recompute leaves behind for the next one.
export function rememberPollGraph(
  memory: ChunkSettleMemory,
  pendingGraph: string,
): ChunkSettleMemory {
  return { lastPoll: pendingGraph, agreed: memory.lastPoll === pendingGraph };
}

// A plain union-find over issue numbers. `union` returns the surviving top so
// the caller can carry a group's data across the merge.
class UnionFind {
  readonly #parent = new Map<number, number>();

  has(n: number): boolean {
    return this.#parent.has(n);
  }

  add(n: number): void {
    if (!this.#parent.has(n)) this.#parent.set(n, n);
  }

  find(n: number): number {
    let top = n;
    for (let up = this.#parent.get(top); up !== undefined && up !== top; up = this.#parent.get(top)) {
      top = up;
    }
    // Path compression: every node walked now points at the top directly.
    for (let at = n; at !== top;) {
      const up = this.#parent.get(at)!;
      this.#parent.set(at, top);
      at = up;
    }
    return top;
  }

  union(a: number, b: number): number {
    this.add(a);
    this.add(b);
    const ta = this.find(a);
    const tb = this.find(b);
    // The lower number survives, so the result never depends on call order.
    const [top, child] = ta <= tb ? [ta, tb] : [tb, ta];
    this.#parent.set(child, top);
    return top;
  }
}

/**
 * The chunks whose work is on origin: what each carries, and the tips of it.
 *
 * `landed` is the caller's set of member refs contained by the exact
 * fetched chunk branch, so it means "this member's work is on the branch". `issues`
 * is the same list `deriveChunks` was given, and is where the titles and the
 * blocked-by edges come from; a member missing from it contributes an empty
 * title rather than dropping out, because the number is the part anything acts
 * on.
 *
 * A chunk with nothing landed is omitted: no branch on origin, no pull request,
 * and nothing for a new member to be blocked by.
 *
 * `tips` falls back to the whole landed set if every landed member is blocked
 * by another one. That is unreachable — the edge set is a DAG, which is what
 * Kahn's walk above relies on — and it is written down anyway because an EMPTY
 * tips list is not a harmless degradation: an issue with an empty
 * `## Blocked by` section has no blockers, so it is parentless, so it is the
 * root of a chunk of its OWN, on a branch of its own, and the review it was
 * filed for gets answered somewhere nobody is looking.
 */
export function landedChunksOf(
  chunks: readonly Chunk[],
  issues: readonly ChunkIssue[],
  landed: ReadonlySet<number>,
  rework: ReadonlySet<number> = new Set(),
): readonly LandedChunk[] {
  const byNumber = new Map(issues.map((i) => [i.number, i] as const));
  const asMember = (n: number): ChunkMember => ({
    number: n,
    title: byNumber.get(n)?.title ?? "",
  });
  const out: LandedChunk[] = [];
  for (const chunk of chunks) {
    // `chunk.members` is ascending, so both lists below are too.
    const members = chunk.members.filter((m) => landed.has(m));
    if (members.length === 0) continue;
    const onBranch = new Set(members);
    // The branch's own edge set: each landed member's blockers that are also
    // on the branch. A blocker OUTSIDE the landed set contributes nothing to
    // either answer below — it is not in this chunk at all, or still queued,
    // and either way nothing of it is on the branch to be behind.
    const blockersOf = new Map<number, readonly number[]>();
    const covered = new Set<number>();
    for (const m of members) {
      const blockers = [...new Set(byNumber.get(m)?.blockedBy ?? [])].filter(
        (b) => b !== m && onBranch.has(b),
      );
      blockersOf.set(m, blockers);
      // Landed members some other landed member is built on top of.
      for (const blocker of blockers) covered.add(blocker);
    }
    const tips = members.filter((m) => !covered.has(m));
    out.push({
      root: chunk.root,
      branch: chunk.branch,
      title: byNumber.get(chunk.root)?.title ?? "",
      members: members.map(asMember),
      closeOrder: closeOrderOfChunkMembers(
        members,
        blockersOf,
        chunk.root,
      ).map(asMember),
      rework: members.filter((m) => rework.has(m)).map(asMember),
      tips: (tips.length > 0 ? tips : members).map(asMember),
    });
  }
  return out;
}

/**
 * `LandedChunk.closeOrder`, as numbers: dependents before blockers, root last.
 *
 * Kahn's again, over the branch's own edge set in the blockers-first direction
 * — smallest number first among the ready set, purely so the answer is
 * deterministic — and then reversed. The walk is the same one `deriveChunks`
 * runs over the whole review-gated graph, and it is run again here rather than
 * remembered because this is a different graph: the landed members only, whose
 * edges are the subset that is actually on the branch.
 *
 * TOTAL. Anything the walk never reaches goes FIRST, ascending, rather than
 * being dropped — the caller closes what it is given, so a missing member is a
 * member that never closes at all, and putting them first keeps the root last
 * where the walk did reach it. That can only happen for a `## Blocked by`
 * cycle edited in among LANDED members: `deriveChunks` holds a cyclic issue
 * that has not started, but an underway one keeps its chunk (#193), so every
 * member stays closeable here.
 */
export function closeOrderOfChunkMembers(
  members: readonly number[],
  blockersOf: ReadonlyMap<number, readonly number[]>,
  root: number,
): readonly number[] {
  // A landing-time membership refresh can discover a member that was absent
  // from the plan which built this graph. The branch name still identifies its
  // one root, so make that invariant explicit rather than relying on every
  // fetched issue body to reproduce the complete path back to it.
  const completeBlockers = new Map<number, readonly number[]>(
    members.map((member) => [
      member,
      member === root || !members.includes(root)
        ? (blockersOf.get(member) ?? [])
        : [...new Set([...(blockersOf.get(member) ?? []), root])],
    ]),
  );
  const indegree = new Map<number, number>(
    members.map((m) => [m, (completeBlockers.get(m) ?? []).length] as const),
  );
  const dependents = new Map<number, number[]>();
  for (const m of members) {
    for (const blocker of completeBlockers.get(m) ?? []) {
      const existing = dependents.get(blocker);
      if (existing) existing.push(m);
      else dependents.set(blocker, [m]);
    }
  }

  const ready = members.filter((m) => indegree.get(m) === 0).sort(ascending);
  const blockersFirst: number[] = [];
  while (ready.length > 0) {
    const number = ready.shift();
    if (number === undefined) break;
    blockersFirst.push(number);
    for (const dependent of dependents.get(number) ?? []) {
      const left = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, left);
      if (left === 0) {
        ready.push(dependent);
        ready.sort(ascending);
      }
    }
  }

  const reached = new Set(blockersFirst);
  return [
    ...members.filter((m) => !reached.has(m)),
    ...blockersFirst.reverse(),
  ];
}
