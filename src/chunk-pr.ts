// The chunk PR — what a human is actually handed by the review lane (#62, and
// §5 of the design in #54).
//
// A chunk branch on origin is where a review-gated group's work lands (#60),
// but a branch is not a review surface: it has no threads, no diff a reviewer
// can comment on line by line, and nothing that tells whoever finds it what it
// is or why the issues it came from are still open. The pull request is that
// surface, and this module is the prose on it. Opening it is `merger.ts`'s job,
// one create-or-update per chunk per cycle, immediately after the push that
// made the branch durable; the `gh` dance itself is `forge-pr.ts`.
//
// DRAFT is the mechanism, and it is chosen for exactly one property (#54 Q14):
// a draft PR disables GitHub's merge button while leaving review completely
// functional. Sandbar composes chunk branches and means to land them itself, so
// a merge from the PR page is a landing the orchestrator does not know about —
// issues left open, `in-chunk` labels left applied, a chunk branch nobody
// retires. Draft state makes the accident hard and leaves the deliberate act
// available: a human can mark the PR ready and merge it by hand in two steps.
// That override is TOLERATED, not fought — `forge-pr.ts` re-titles and
// re-bodies an existing PR and never touches its draft state, and reconciling a
// chunk landed that way is #64.
//
// WHAT THE BODY MAY CLAIM. #62 sketches the draft line as "review here; apply
// the `land` label to land; the merge button is disabled by design", and the
// middle clause is not written below, deliberately: there is no `land` label
// today and nothing that would read one. A PR body that invites a human to
// apply a label no code watches is a review surface that lies on its first
// sentence. So the prose says what is true now — the merge button is off by
// design, landing a reviewed chunk is not automated yet, and the issues stay
// open and labelled until it is — and the sentence that invites the label
// belongs to the issue that builds it.
//
// PURE, and separate from the merger for the reason every other piece of
// sandbar prose is: the templates are the part a human reads, so they are the
// part worth reading in a test rather than through a fake adapter.
//
// The member list is EVERYTHING THE BRANCH CARRIES, not this cycle's landings.
// A chunk grows one member per cycle, so a body rebuilt from the merge phase's
// own knowledge would describe the newest member alone and drop the ones a
// reviewer is looking at right above it. `ChunkTarget.landed` (the planner's
// snapshot of the members carrying `in-chunk`) is the other half, and
// `chunkMembersOnBranch` is where the two are put together.

import { type ChunkMember, IN_CHUNK_LABEL } from "./chunks.js";

export type ChunkPullRequestContent = {
  readonly title: string;
  readonly body: string;
};

/**
 * Every member whose work is on the chunk branch: the ones that were already
 * there (the planner's `in-chunk` snapshot) plus the ones that landed now.
 *
 * Ascending and deduped by issue number, with the LANDING side's title winning
 * a collision — it was read from the tracker this cycle, and the snapshot's
 * copy is a cycle older. The two lists are disjoint in practice (an issue
 * landing now does not yet carry `in-chunk`); the tie-break is here so that a
 * re-run over a member whose label flip failed cannot double-list it.
 */
export function chunkMembersOnBranch(
  alreadyOnBranch: readonly ChunkMember[],
  landedNow: readonly ChunkMember[],
): readonly ChunkMember[] {
  const byNumber = new Map<number, ChunkMember>();
  for (const m of alreadyOnBranch) byNumber.set(m.number, m);
  for (const m of landedNow) byNumber.set(m.number, m);
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

// `Sandbar chunk #<root>: <the root issue's title>`. The root names the chunk
// everywhere else (it names the branch), so it names the PR too. The fallback
// is unreachable in practice — the root is the first member to land, so it is
// on the branch before any other member can be — but a title is not worth a
// throw, and `Sandbar chunk #42` still identifies the chunk.
export function chunkPullRequestTitle(
  root: number,
  members: readonly ChunkMember[],
): string {
  const rootTitle = members.find((m) => m.number === root)?.title ?? "";
  return rootTitle.length > 0
    ? `Sandbar chunk #${root}: ${rootTitle}`
    : `Sandbar chunk #${root}`;
}

export function chunkPullRequestBody(args: {
  readonly branch: string;
  // Everything on the branch, from `chunkMembersOnBranch`. Non-empty by
  // construction: the merger opens the PR only after a member has landed.
  readonly members: readonly ChunkMember[];
}): string {
  const lines = [
    "**Draft on purpose.** This is a sandbar review chunk: a group of",
    "review-gated issues that are reviewed together and land together. Their",
    "work is merged onto `" + args.branch + "` — none of it has reached the",
    "base branch of this pull request.",
    "",
    "Issues on `" + args.branch + "`:",
    "",
  ];
  for (const m of args.members) {
    lines.push(`- #${m.number} — ${m.title}`);
  }
  lines.push(
    "",
    "Review here: everything a review needs works in a draft — the diff, the",
    "commits, comments and threads. What draft state disables is the merge",
    "button, and that is the point. Sandbar composed this branch and lands it",
    "itself, so a merge from this page is a landing the orchestrator never sees:",
    "the issues above would stay open, keep their `" + IN_CHUNK_LABEL + "` label",
    "and stay out of the queue.",
    "",
    "Landing a reviewed chunk is not automated yet — until it is, a human lands",
    "it and reconciles those issues by hand.",
    "",
    "Sandbar rewrites this title and description every time a member lands on",
    "`" + args.branch + "`, so the list above is what the branch carries. It",
    "never changes the draft state: marking this pull request ready for review",
    "is a deliberate override, and sandbar leaves it alone.",
  );
  return lines.join("\n");
}

export function chunkPullRequestContent(args: {
  readonly root: number;
  readonly branch: string;
  readonly members: readonly ChunkMember[];
}): ChunkPullRequestContent {
  return {
    title: chunkPullRequestTitle(args.root, args.members),
    body: chunkPullRequestBody({ branch: args.branch, members: args.members }),
  };
}
