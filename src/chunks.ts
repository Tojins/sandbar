// Chunk derivation — which review-gated issues land together, on one branch a
// human reviews once (#58, and §2 of the design in #54).
//
// A chunk is DERIVED, never declared. Nobody labels an issue "chunk 3"; the
// chunk falls out of two things sandbar already knows: the lane of each issue
// (`lanes.ts`) and the `## Blocked by` edges the planner already parses. A
// chunk is a connected component of the REVIEW-GATED issues under those edges,
// and a review-gated issue with no review-gated neighbours is a chunk of one.
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
// member whose blockers are satisfied, root or not (#61): the root seeds from
// `origin/<sourceBranch>` — exactly where its chunk branch is created when
// absent, so the two agree — and every member behind it seeds from the chunk's
// TIP, which is where its blockers' commits actually are. A chunk therefore
// grows one LAYER per cycle rather than one member: a member is unblocked by a
// blocker whose merge commit is on the chunk branch, a fact visible in the
// cycle AFTER the one that landed it, so every member planned together is a
// set of siblings.
//
// The one thing still held is a review-gated issue with NO chunk — the output
// of `blocked` below. There is no branch to name and no tip to seed from, so
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
// The swap is not authoritative. The merge commit on the exact fetched chunk
// branch is the de-queue and blocker-satisfaction fact; labels are never read.
// `fetchChunkMembers` lists those git-derived members back into the candidate
// graph so the chunk cannot re-root around whatever remains queued.
//
// Hardcoded, not a `LabelConfig` knob: the configurable labels name a HOST's
// handoff conventions, while this one is a consistent human-facing cue. A knob
// could only let the two spellings drift. The declaration is below the imports.
//
// ---------------------------------------------------------------------------
// The two-chunk-parent rule
// ---------------------------------------------------------------------------
//
// An issue blocked by members of two DIFFERENT chunks is blocked — held out of
// every chunk — until its blockers are on the source branch or all in one
// chunk. Chunks are never merged to accommodate it.
//
// The alternative is the whole reason the rule is written down: plain connected
// components WOULD merge them, since that issue is a path between the two. So
// an issue somebody files across two unrelated review series silently fuses
// both into one branch, and the human who was reviewing a three-issue chunk is
// now handed nine issues they never agreed to look at together. Worse, it is
// retroactive — the merge happens the moment the new issue is filed, to work
// that may already be underway. Refusing to grow a chunk that way keeps the
// unit of review a thing a human chose, and the cost falls on the one issue
// that straddles: it waits, which it would have had to do anyway, since both
// its blockers must land before it can be built on them.
//
// "Blocked" here is a fact about chunk assignment, not a label or a comment.
// Reporting it to a human is a later issue's job; this module names it so
// there is something to report.
//
// ---------------------------------------------------------------------------
// Why the walk is topological, and not a union-find over the edge set
// ---------------------------------------------------------------------------
//
// The two-chunk rule makes the answer depend on the order issues are decided
// in, and only one order is defensible. Take A and B unrelated, X blocked by
// both, and Y also blocked by both. Union-find in issue order unions X with A,
// then X with B — the merge the rule forbids. Deciding each issue by looking at
// the components of the graph WITHOUT it is no better: with X removed, Y joins
// A and B into one component, so X sees one chunk and joins; by symmetry so
// does Y; both join and the chunks are merged after all.
//
// Deciding an issue only once every one of its blockers is decided removes the
// ambiguity entirely: X and Y each see A and B already settled as two chunks,
// and each is blocked. That order is a topological order of the blocked-by
// edges, so the walk here is Kahn's algorithm over the review-gated subgraph,
// smallest issue number first among the ready set purely so the output is
// deterministic.
//
// A consequence worth stating, because it is what makes `root` well defined: a
// chunk only ever grows by attaching an issue whose blockers are all in that
// one chunk, and it is seeded by an issue with no review-gated blockers at all.
// So a chunk has exactly ONE parentless member, its seed. `chunkRoot` still
// takes the lowest-numbered parentless member as #58 specifies it — a total
// rule that does not depend on the reader trusting that argument.
//
// CYCLES are hostile input: two issues can name each other under `## Blocked
// by`, and a human wrote them. Kahn's simply never reaches those nodes, nor
// anything downstream of them, and they come out `blocked` with reason
// `cycle`. That is the honest answer rather than a diagnostic failure — a cycle
// has no parentless member, so it has no root, so it cannot be named; and the
// planner deadlocks on a cyclic pair regardless, since neither blocker will
// ever read CLOSED.
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
import { chunkBranchName } from "./naming.js";

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

// An issue named as part of a chunk, in the one form the review surface needs
// it: a number and the title a human reads next to it (#62).
export type ChunkMember = {
  readonly number: number;
  readonly title: string;
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
  // — the ones named by that branch's sandbar merge commits (#62, #93). Ascending, and never including
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
  // The lowest-numbered member with no blocker inside the chunk. It names the
  // branch and identifies the chunk everywhere else.
  readonly root: number;
  // Every issue that lands on this chunk's branch, ascending, root included.
  readonly members: readonly number[];
  // `sandbar/chunk-<root>-<slug>`. Derived, not created — no branch of this
  // name exists yet.
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
  // The ROOT issue's title — the same string `chunkBranchName` slugged. Names
  // the chunk in the merge commit a landing writes and in the prose it posts
  // (#64), and it comes from the root whether or not the root is among
  // `members`, because the branch is named after it either way.
  readonly title: string;
  // Every LANDED member, ascending: the issues whose commits are on the branch.
  //
  // This is the list a landing CLOSES (#64), which is the whole reason it is
  // the git-derived members rather than `Chunk.members`. A component holds
  // members that have never been worked — a chained member waits for its
  // blockers to land — and closing one of those would destroy a queued issue
  // while telling a human its commits were on the source branch, and would
  // cancel the re-rooting the design turns on: a member left OPEN has its
  // blocker satisfied by CLOSED and becomes its own chunk's root, while a
  // closed one never does. It is the same set the chunk's pull request lists
  // (#62), so a landing closes exactly what that PR said it carried.
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
  // chunk again only if the chunk still derives to the same BRANCH NAME — that
  // is, only if its root is still open, since a closed root leaves the graph
  // and re-roots the chunk under a survivor and a different name.
  //
  // Closing in this order and stopping at the first failure is what makes that
  // true, and nothing weaker does. The members left open are then every
  // ancestor of the one that failed plus everything not yet attempted: the
  // root is among them (it is last), every one of them reaches the root
  // through members that are also still open (its own blockers are all later
  // in this order), and no other member of the set is parentless. So the next
  // cycle derives the same root, the same branch and exactly these members —
  // which is the promise the landing's own prose makes to a human.
  //
  // Stopping matters as much as the order: close #43 and fail on #44 with the
  // root #42 left for last, and #44's blocker is gone, so #44 re-roots into a
  // chunk of its own on a branch origin has never had, while the branch it
  // really is on matches nothing and is deleted out from under it.
  readonly closeOrder: readonly ChunkMember[];
  // The landed members that no OTHER landed member is blocked by — the tips of
  // what the branch carries, ascending. Non-empty, and a subset of `members`:
  // it is what a NEW member of the chunk declares under `## Blocked by`
  // (#63) — naming the tips is what puts it in THIS chunk (by the derivation
  // above) and behind everything already on the branch, and naming only them
  // keeps the section down to the edges the chunk's own graph does not already
  // imply.
  readonly tips: readonly ChunkMember[];
};

// Why an issue got no chunk. All three mean "wait", never "give up".
//
//   two-chunk-parent  — its blockers sit in two or more different chunks (the
//                       rule above). Resolves when those chunks land.
//   unchunked-blocker — a blocker of its own has no chunk, so neither can it.
//                       The transitive shadow of the other two reasons.
//   cycle             — it is inside a `## Blocked by` cycle, or downstream of
//                       one. Resolves only when a human edits the bodies.
export type ChunkBlockReason =
  | "two-chunk-parent"
  | "unchunked-blocker"
  | "cycle";

export type ChunkBlock = {
  readonly issue: number;
  readonly reason: ChunkBlockReason;
  // The review-gated blockers that account for the reason, ascending: ALL of
  // them for `two-chunk-parent` (it is the set of chunks they land in that
  // conflicts, so no subset states it) and for `cycle` (which edge closes the
  // loop is not decided here), and only the ones with no chunk of their own for
  // `unchunked-blocker`. Resolve them through `chunkOf` to name the chunks.
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
};

const ascending = (a: number, b: number): number => a - b;

// `lanes` is typed to the one field it reads rather than to `LaneDecision`, so
// the table tests can state a lane instead of building a decision around it.
// A `computeLanes` result is assignable as-is.
export function deriveChunks(
  issues: readonly ChunkIssue[],
  lanes: ReadonlyMap<number, { readonly lane: Lane }>,
): ChunkDerivation {
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

  const indegree = new Map<number, number>();
  for (const [number, blockers] of parents) indegree.set(number, blockers.length);

  // Components keyed by their seed. The seed is provisional — the root each
  // chunk reports is recomputed from the members below, by #58's rule.
  const seedOf = new Map<number, number>();
  const componentMembers = new Map<number, number[]>();
  const blocked: ChunkBlock[] = [];

  const ready = [...gated.keys()].filter((n) => indegree.get(n) === 0);
  ready.sort(ascending);
  while (ready.length > 0) {
    const number = ready.shift();
    if (number === undefined) break;
    const blockers = parents.get(number) ?? [];

    // Every blocker is decided by now, so an undecided one can only be a
    // blocker that was itself blocked.
    const unchunked = blockers.filter((b) => !seedOf.has(b));
    if (unchunked.length > 0) {
      blocked.push({ issue: number, reason: "unchunked-blocker", blockers: unchunked });
    } else {
      const seeds = new Set(
        blockers
          .map((b) => seedOf.get(b))
          .filter((s): s is number => s !== undefined),
      );
      if (seeds.size > 1) {
        blocked.push({ issue: number, reason: "two-chunk-parent", blockers });
      } else {
        // No blockers at all ⇒ this issue seeds a chunk of its own.
        const seed = [...seeds][0] ?? number;
        seedOf.set(number, seed);
        const members = componentMembers.get(seed);
        if (members) members.push(number);
        else componentMembers.set(seed, [number]);
      }
    }

    // Retire the edge whether this issue got a chunk or not: a dependent of a
    // blocked issue still has to be DECIDED (as `unchunked-blocker`), and
    // leaving its in-degree standing would silently reclassify it as a cycle.
    for (const child of children.get(number) ?? []) {
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) {
        ready.push(child);
        ready.sort(ascending);
      }
    }
  }

  const chunks: Chunk[] = [];
  const chunkOf = new Map<number, number>();
  for (const rawMembers of componentMembers.values()) {
    const members = [...rawMembers].sort(ascending);
    const inChunk = new Set(members);
    // Parentless WITHIN the chunk: blockers outside it are on the source
    // branch (or in the auto lane and heading there), which is exactly the
    // state the two-chunk rule says an issue is waiting for.
    const parentless = members.filter(
      (m) => !(parents.get(m) ?? []).some((p) => inChunk.has(p)),
    );
    // `members` is non-empty and ascending, and the seed is always parentless,
    // so both fallbacks are unreachable; they are here because an index and a
    // `Map.get` are typed `T | undefined`.
    const root = parentless[0] ?? members[0] ?? 0;
    const title = gated.get(root)?.title ?? "";
    chunks.push({ root, members, branch: chunkBranchName(root, title) });
    for (const member of members) chunkOf.set(member, root);
  }
  chunks.sort((a, b) => a.root - b.root);

  // Whatever Kahn's never reached is in a `## Blocked by` cycle or downstream
  // of one: those are the only nodes whose in-degree never reaches zero.
  for (const number of [...gated.keys()].sort(ascending)) {
    if (seedOf.has(number)) continue;
    if (blocked.some((b) => b.issue === number)) continue;
    blocked.push({
      issue: number,
      reason: "cycle",
      blockers: parents.get(number) ?? [],
    });
  }
  blocked.sort((a, b) => a.issue - b.issue);

  return { chunks, chunkOf, blocked };
}

/**
 * The chunks whose work is on origin: what each carries, and the tips of it.
 *
 * `landed` is the caller's set of members named by merge commits on the exact
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
      closeOrder: closeOrderOf(members, blockersOf).map(asMember),
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
 * cycle, which `deriveChunks` never puts in a chunk in the first place (a
 * cyclic issue comes out `blocked`), so this is a fallback with no caller.
 */
function closeOrderOf(
  members: readonly number[],
  blockersOf: ReadonlyMap<number, readonly number[]>,
): readonly number[] {
  const indegree = new Map<number, number>(
    members.map((m) => [m, (blockersOf.get(m) ?? []).length] as const),
  );
  const dependents = new Map<number, number[]>();
  for (const m of members) {
    for (const blocker of blockersOf.get(m) ?? []) {
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
