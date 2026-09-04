// A changes-requested review on a chunk PR becomes a follow-up chunk issue
// (#63, and §4 of the design in #54).
//
// A chunk's review surface is its draft pull request (#62), and a human who
// reviews it has exactly one interface: that page. They request changes there,
// on the threads the diff gave them, and nothing else is asked of them — no
// label to apply, no issue to write, no branch to name. Everything after that
// is sandbar's bookkeeping, and this module is it: each changes-requested
// review becomes ONE issue, blocked by the chunk's tips, which therefore joins
// the chunk by the derivation rule (#58) and is worked like any other member
// (#61) — its branch cut from the chunk tip, its commits landing back on the
// same branch, under the same pull request the review was written on.
//
// The rejected alternative is recorded in #54 and worth restating, because it
// is the obvious one: an agent that reads the PR comments and pushes fixes
// straight onto the chunk branch. That produces commits no issue tracks, work
// no plan authorised and no budget counted, and — the part that actually bites
// — nothing a human can point at when the fix is wrong. An issue is the handle
// on a unit of agent work everywhere else in sandbar; review feedback is not
// special enough to be the one exception.
//
// ---------------------------------------------------------------------------
// Idempotence, which is the whole difficulty
// ---------------------------------------------------------------------------
//
// One review must yield one issue: across cycles, across runs, across further
// comments on the same threads, and across a review whose threads a human
// never resolves. Nothing about the tracker state answers that on its own —
// GitHub does not mark a review "handled", the threads stay unresolved until a
// human says otherwise (sandbar deliberately never resolves one; see below),
// and the review is still `CHANGES_REQUESTED` for as long as the PR is open.
// So a scan that asked only "is there a changes-requested review?" would file
// the same issue every cycle, forever.
//
// The record is a LEDGER COMMENT on the pull request, one per converted
// review, carrying an HTML-comment marker with the review's node id:
//
//     <!-- sandbar:chunk-follow-up review=<review node id> -->
//
// Three properties make that the right place for it. It is on the PR, so the
// one query that reads the reviews reads the ledger with them — no second
// listing, and no second thing to keep in step. It is read through GraphQL on
// the pull request node, which is strongly consistent, unlike the listing
// endpoint `fetchCandidates` uses: a follow-up filed sixty seconds ago
// is visible, which is exactly when the question is asked. And it does not
// depend on the follow-up ISSUE's state — an issue parked with `needs-info`,
// or closed by a human who disagreed with it, has left every label-scoped
// listing sandbar makes, and a ledger keyed on those would re-file it the next
// cycle, which is precisely when a human is least interested in a duplicate.
//
// The issue's BODY carries the same marker (#63 asks for a bot-stamped body,
// and it is what tells a human reading the issue where it came from), but the
// body is provenance and not the index: no strongly-consistent query is keyed
// on issue bodies, so an index made of them could only be a search.
//
// THE ORDER OF THE TWO WRITES is where this can still go wrong, and it is
// written down rather than tuned away. The issue is created first and the
// ledger comment posted second, because the comment names the issue. If the
// comment fails, an issue exists that the ledger does not know about, and the
// next cycle would file a second one — so that failure is LOUD (`SandbarError`,
// the run stops) and its message says which issue exists and what to do about
// it. The other order would trade a duplicate for a silent drop: a ledger entry
// with no issue behind it is a review nothing will ever answer, and nothing
// would ever say so.
//
// A CREATE that fails is the same shape one step earlier, and its message says
// so rather than promising more than it knows. A rejected create wrote nothing
// and the next cycle re-files it; a create whose issue was made and whose
// RESPONSE was lost (a timeout, a reset connection) is indistinguishable from
// here, and leaves exactly the unledgered issue the paragraph above is about.
// So both readings are in the text, with the manual fix attached to the second.
//
// WHAT IS NOT DONE, deliberately: sandbar does not resolve the review threads.
// A thread is resolved when the human who opened it is satisfied, and a bot
// that resolves threads on its own behalf is a bot that closes the loop it was
// supposed to hand back. The ledger is what stops the re-file; resolution stays
// the reviewer's.
//
// ---------------------------------------------------------------------------
// What becomes an issue, and what does not
// ---------------------------------------------------------------------------
//
// The unit is a REVIEW — one submitted `CHANGES_REQUESTED` review — not a
// thread and not a comment. That is what a human did in one act, and it is the
// granularity their "please change these five things" was written at; five
// issues for five threads would scatter one review's argument across five
// branches that then land in some order nobody chose.
//
// A review is skipped when it is already in the ledger, and when it has nothing
// left to ask for: no unresolved thread of its own and an empty body. The
// second clause is what makes a human resolving every thread before sandbar
// next runs mean what they meant by it. A DISMISSED review is not
// `CHANGES_REQUESTED` any more, so it never reaches here at all — dismissal is
// the reviewer's own "never mind", and GitHub already records it.
//
// A thread counts for a review if ANY of its comments belongs to that review,
// not just the one that opened it: a reviewer whose second pass replies inside
// a thread they opened last week is asking for something now, and keying on the
// opening comment would file an issue that quotes the review body and none of
// the substance. The cost is that a thread can be quoted by two follow-ups, one
// per review that spoke in it, which is the honest reading of what happened.
//
// ---------------------------------------------------------------------------
// The `## Blocked by` section, which is what makes any of it work
// ---------------------------------------------------------------------------
//
// The follow-up declares the chunk's TIPS (`LandedChunk.tips`). That single
// section does four things, and every one of them is load-bearing:
//
//   * it puts the issue in the chunk — `chunks.ts` derives a chunk as the
//     connected component of review-gated issues, so an edge to a member IS
//     the membership;
//   * it review-GATES the issue, by #57's downward inheritance, so no host
//     default and no missing label can let review feedback auto-land;
//   * it holds the issue until the work it comments on is really on origin —
//     the tips have durable member refs contained by the chunk branch, the clause
//     the planner already has (#59); and
//   * it puts the issue BEHIND everything on the branch, so the branch it is
//     seeded from (the chunk tip, #61) contains the code the review is about.
//
// It is written FIRST in the body, above the quoted review, and that ordering
// is a correctness requirement rather than a style: `parseBlockedBy` matches
// the first `## Blocked by` in the body and reads every `#N` up to the next
// heading, and the text being quoted is a human's — it may contain anything,
// including a `## Blocked by` heading of its own. Quoted lines are blockquoted,
// which already stops them terminating a section early; putting sandbar's own
// section first is what stops one of them starting one.
//
// PURE where it can be. The decisions (which reviews are pending, what the
// issue says, what the ledger says) are functions over a snapshot of the pull
// request, and the `gh` calls live behind an adapter at the bottom — one read,
// two writes, all three named in `chunk-follow-up-gh.test.ts` by their argv,
// because argv is what a fake adapter cannot see.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ChunkMember, LandedChunk } from "./chunks.js";
import { SandbarError } from "./errors.js";
import { BOT_COMMENT_PREFIX, READY_FOR_AGENT_LABEL } from "./finalize.js";
import type { IssueSummary } from "./plan-resolver.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";

const exec = promisify(execFile);

// The GraphQL read below is the largest `gh` read in this codebase — a hundred
// threads of fifty comments each, plus a hundred issue-comment bodies and fifty
// review bodies, all of them human prose. Node's default ceiling is 1 MB, and
// an overflow here does not degrade: it REJECTS the call, which `reviewState`
// turns into a `SandbarError` that stops the run. Same ceiling `forge-pr` and
// `forge-verify` give their own gh reads.
const MAX_BUFFER = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The snapshot the decisions are made over
// ---------------------------------------------------------------------------

// One comment inside a review thread. `reviewId` is the review it was
// submitted as part of, empty for a comment GitHub attributes to none.
export type ThreadComment = {
  readonly author: string;
  readonly body: string;
  readonly url: string;
  readonly reviewId: string;
};

// A review thread on the pull request. `path` is the file it hangs off, empty
// for a thread with none; the line number is deliberately absent — it moves
// with every push to the branch, and the comment's own URL is the durable way
// back to the exact place.
export type ReviewThread = {
  readonly path: string;
  readonly isResolved: boolean;
  readonly comments: readonly ThreadComment[];
};

// A submitted review whose state is CHANGES_REQUESTED. `id` is the GraphQL node
// id, which is what the ledger is keyed on: it is stable, it is unique across
// the repository, and unlike the review's URL it survives the PR being renamed
// or the reviewer's login changing.
export type ChangesRequestedReview = {
  readonly id: string;
  readonly url: string;
  readonly author: string;
  readonly body: string;
};

// Everything one scan needs to know about one chunk's pull request.
export type ChunkPullRequestState = {
  readonly number: number;
  readonly url: string;
  readonly reviews: readonly ChangesRequestedReview[];
  readonly threads: readonly ReviewThread[];
  // The PR's issue-comment bodies — the ledger, and nothing else is read out
  // of them.
  readonly comments: readonly string[];
};

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export const followUpMarker = (reviewId: string): string =>
  `<!-- sandbar:chunk-follow-up review=${reviewId} -->`;

// Every review id the pull request's comments claim has been converted.
// Matching on the marker rather than the prose means the ledger comment can be
// reworded without re-filing every follow-up in every open chunk.
export function convertedReviewIds(
  comments: readonly string[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const body of comments) {
    for (const m of body.matchAll(
      /<!--\s*sandbar:chunk-follow-up\s+review=([^\s>]+)\s*-->/g,
    )) {
      const id = m[1];
      if (id) ids.add(id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Which reviews are still owed an issue
// ---------------------------------------------------------------------------

export type PendingFollowUp = {
  readonly review: ChangesRequestedReview;
  // The review's unresolved threads, in the order the pull request gave them.
  readonly threads: readonly ReviewThread[];
};

export function unresolvedThreadsFor(
  reviewId: string,
  threads: readonly ReviewThread[],
): readonly ReviewThread[] {
  return threads.filter(
    (t) => !t.isResolved && t.comments.some((c) => c.reviewId === reviewId),
  );
}

export function pendingFollowUps(
  pr: ChunkPullRequestState,
): readonly PendingFollowUp[] {
  const converted = convertedReviewIds(pr.comments);
  const pending: PendingFollowUp[] = [];
  for (const review of pr.reviews) {
    if (converted.has(review.id)) continue;
    const threads = unresolvedThreadsFor(review.id, pr.threads);
    // Nothing left to ask for: every thread resolved and no review body. The
    // human said what they wanted and then said it was done.
    if (threads.length === 0 && review.body.trim().length === 0) continue;
    pending.push({ review, threads });
  }
  return pending;
}

// ---------------------------------------------------------------------------
// What the issue says
// ---------------------------------------------------------------------------

export function followUpIssueTitle(
  root: number,
  review: ChangesRequestedReview,
): string {
  return review.author.length > 0
    ? `Chunk #${root}: address ${review.author}'s review feedback`
    : `Chunk #${root}: address review feedback`;
}

// A human's words, rendered so they cannot be mistaken for sandbar's markup.
// Every line is blockquoted — which is also what keeps a heading inside them
// from ending the `## Blocked by` section above, since that section ends only
// at a `##` immediately after a newline.
const quote = (text: string): readonly string[] =>
  text.replace(/\r\n/g, "\n").split("\n").map((line) => `> ${line}`);

const threadHeading = (thread: ReviewThread): string =>
  thread.path.length > 0 ? `### \`${thread.path}\`` : "### Pull request thread";

export function followUpIssueBody(args: {
  readonly root: number;
  readonly branch: string;
  readonly prNumber: number;
  readonly review: ChangesRequestedReview;
  readonly threads: readonly ReviewThread[];
  // The chunk's tips — what this issue is blocked by. Non-empty; an empty
  // section would make the issue the root of a chunk of its own (`chunks.ts`,
  // `landedChunksOf`).
  readonly tips: readonly ChunkMember[];
}): string {
  const who = args.review.author.length > 0 ? args.review.author : "A reviewer";
  const lines: string[] = [
    `${BOT_COMMENT_PREFIX} ${who} requested changes on the draft pull request ` +
      `for chunk #${args.root} (#${args.prNumber}), and this issue is that ` +
      `review. It belongs to the chunk: its branch is cut from the tip of ` +
      `\`${args.branch}\`, and its commits land back there, under the same ` +
      `pull request the review was written on.`,
    "",
    "Do what the review asks for. Sandbar does not resolve review threads — " +
      "the reviewer resolves them when they are satisfied, and nothing here " +
      "depends on their doing so.",
    "",
    // FIRST, above the quoted review, and see the header for why that is a
    // correctness requirement. Bare `#N` per entry: `parseBlockedBy` reads
    // every `#N` in the section, so a title alongside one would be a second
    // chance to name a number nobody meant.
    "## Blocked by",
  ];
  for (const tip of args.tips) lines.push(`- #${tip.number}`);
  lines.push("", "## The review", "", `${args.review.url}`);
  if (args.review.body.trim().length > 0) {
    lines.push("", ...quote(args.review.body));
  }
  for (const thread of args.threads) {
    lines.push("", threadHeading(thread));
    for (const comment of thread.comments) {
      const author = comment.author.length > 0 ? comment.author : "reviewer";
      lines.push("", `**${author}** ([comment](${comment.url})):`, "");
      lines.push(...quote(comment.body));
    }
  }
  if (args.threads.length === 0) {
    lines.push(
      "",
      "The review left no unresolved threads of its own — its body above is " +
        "the whole of it.",
    );
  }
  lines.push("", followUpMarker(args.review.id));
  return lines.join("\n");
}

export type FollowUpIssueContent = {
  readonly title: string;
  readonly body: string;
};

export function followUpIssueContent(args: {
  readonly chunk: LandedChunk;
  readonly prNumber: number;
  readonly pending: PendingFollowUp;
}): FollowUpIssueContent {
  return {
    title: followUpIssueTitle(args.chunk.root, args.pending.review),
    body: followUpIssueBody({
      root: args.chunk.root,
      branch: args.chunk.branch,
      prNumber: args.prNumber,
      review: args.pending.review,
      threads: args.pending.threads,
      tips: args.chunk.tips,
    }),
  };
}

// The ledger entry, and the reviewer's receipt: it is on the page they are
// looking at, so the answer to "where did my review go?" is one line under it.
export function ledgerComment(args: {
  readonly review: ChangesRequestedReview;
  readonly issueNumber: number;
  readonly branch: string;
}): string {
  return (
    `${BOT_COMMENT_PREFIX} filed #${args.issueNumber} for the changes ` +
    `requested in [this review](${args.review.url}). It joins this chunk, is ` +
    `worked like every other member, and lands on \`${args.branch}\` — this ` +
    `pull request will show the commits.\n\n` +
    `The threads stay open: sandbar does not resolve them, so resolving one ` +
    `is still how you say you are satisfied.\n\n` +
    `${followUpMarker(args.review.id)}`
  );
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export type ChunkFollowUpAdapter = {
  // The chunk branch's open pull request, or null when it has none — a chunk
  // whose PR a human closed, or one whose landing pushed the branch but whose
  // PR call failed (the merger halts on that, but the branch is durable and a
  // later cycle retries it).
  reviewState(chunkBranch: string): Promise<ChunkPullRequestState | null>;
  // Returns the new issue's number.
  createIssue(content: FollowUpIssueContent): Promise<number>;
  postLedgerComment(prNumber: number, body: string): Promise<void>;
};

// The GraphQL read. One call per chunk branch rather than one aliased call for
// all of them: the branch is a STRING variable, and a query with one alias per
// chunk needs one variable per alias, which trades a per-chunk round trip for
// a query built by string concatenation out of names this module does not own.
// Chunks are counted in ones, and the call happens only for chunks that have
// landed something.
//
// The caps are stated rather than paginated, and every one of them is `last:`
// — the NEWEST page. That is not a preference: GitHub's connections default to
// ASCENDING creation order, so `first:` would hand back the OLDEST page of
// each, which is the wrong end of all three.
//
//   * `comments(last:100)` is the ledger read, and it is the one cap with a
//     real failure mode. Ledger entries are appended, so the newest comments
//     are where a just-converted review is recorded; reading the oldest
//     hundred of a busy pull request would stop seeing them at all and re-file
//     every review every cycle, forever, one issue and one comment at a time
//     with nothing reporting it. Read from the new end, a comment falling out
//     of the window costs at most ONE duplicate and then settles, because the
//     ledger entry that duplicate writes is by construction the newest comment
//     on the page.
//   * `reviews(...,last:50)` is the newest fifty changes-requested reviews. A
//     review old enough to fall out of that was converted long ago; a review
//     too NEW to be seen would never be filed at all, which is a silent drop
//     rather than a truncation.
//   * `reviewThreads(last:100)` is the newest hundred threads, which is where
//     a review submitted minutes ago put its own. Losing the oldest costs a
//     quoted thread on an issue that links the pull request beside it; losing
//     the newest would make a body-empty review look like it had nothing left
//     to ask for, so `pendingFollowUps` would skip it — and nothing skipped is
//     ever ledgered, so it would be skipped again every cycle after.
//
// The one `first:` is the INNER `comments(first:50)` on a thread, and it is
// deliberate rather than an oversight in its neighbours' company: a thread
// opens with the point being made, so the start of that conversation is the
// defensible prefix. Every other cap here is a window on an append-only list
// where the prefix is the part already dealt with.
const REVIEW_QUERY = `query($owner:String!,$repo:String!,$head:String!,$base:String!){
  repository(owner:$owner,name:$repo){
    pullRequests(headRefName:$head,baseRefName:$base,states:OPEN,first:10,orderBy:{field:CREATED_AT,direction:DESC}){
      nodes{
        number
        url
        comments(last:100){nodes{body}}
        reviews(states:[CHANGES_REQUESTED],last:50){nodes{id url body author{login}}}
        reviewThreads(last:100){nodes{
          isResolved
          path
          comments(first:50){nodes{body url author{login} pullRequestReview{id}}}
        }}
      }
    }
  }
}`;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

type RawNode = Record<string, unknown>;

const nodesOf = (v: unknown): readonly RawNode[] => {
  const nodes = (v as { nodes?: unknown } | null | undefined)?.nodes;
  return Array.isArray(nodes)
    ? nodes.filter((n): n is RawNode => typeof n === "object" && n !== null)
    : [];
};

function parseReviewState(stdout: string): ChunkPullRequestState | null {
  const parsed: unknown = JSON.parse(stdout);
  const repository = (
    parsed as { data?: { repository?: { pullRequests?: unknown } | null } }
  )?.data?.repository;
  // First node, i.e. the most recently created open PR on this head. That is
  // the same one `ensurePullRequest` re-titles and re-bodies (`gh pr list`
  // answers newest first), so the scan and the merger are looking at one page.
  const pr = nodesOf(repository?.pullRequests)[0];
  if (!pr || typeof pr["number"] !== "number") return null;
  return {
    number: pr["number"],
    url: str(pr["url"]),
    comments: nodesOf(pr["comments"]).map((c) => str(c["body"])),
    reviews: nodesOf(pr["reviews"])
      .map((r) => ({
        id: str(r["id"]),
        url: str(r["url"]),
        author: str((r["author"] as RawNode | null)?.["login"]),
        body: str(r["body"]),
      }))
      // A review with no node id cannot be ledgered, and an unledgerable
      // review would be re-filed every cycle. Unreachable from GitHub; dropped
      // rather than trusted.
      .filter((r) => r.id.length > 0),
    threads: nodesOf(pr["reviewThreads"]).map((t) => ({
      path: str(t["path"]),
      isResolved: t["isResolved"] === true,
      comments: nodesOf(t["comments"]).map((c) => ({
        author: str((c["author"] as RawNode | null)?.["login"]),
        body: str(c["body"]),
        url: str(c["url"]),
        reviewId: str((c["pullRequestReview"] as RawNode | null)?.["id"]),
      })),
    })),
  };
}

export function realAdapter(args: {
  readonly repo: RepoRef;
  // The base every chunk PR is opened against — `config.sourceBranch`. Part of
  // the lookup rather than decoration: `ensurePullRequest` finds the PR it
  // re-titles by the head-to-base PAIR, so a scan asking by head alone could
  // read a pull request the merger does not maintain — one a human retargeted
  // at another base — and post the ledger comment where the next scan will not
  // look for it.
  readonly sourceBranch: string;
}): ChunkFollowUpAdapter {
  const { repo } = args;
  const slug = repoSlug(repo);
  return {
    async reviewState(chunkBranch) {
      // `-f`, not `-F`: every one of these is a string, and `-F` types its
      // value, so a repository or a branch that looks like a number would
      // reach GraphQL as one and fail the query's `String!`.
      const { stdout } = await exec(
        "gh",
        [
          "api",
          "graphql",
          "-f",
          `owner=${repo.owner}`,
          "-f",
          `repo=${repo.name}`,
          "-f",
          `head=${chunkBranch}`,
          "-f",
          `base=${args.sourceBranch}`,
          "-f",
          `query=${REVIEW_QUERY}`,
        ],
        { maxBuffer: MAX_BUFFER },
      );
      return parseReviewState(stdout);
    },
    async createIssue(content) {
      const { stdout } = await exec("gh", [
        "issue",
        "create",
        "--repo",
        slug,
        "--title",
        content.title,
        "--body",
        content.body,
        // The queue label, so the issue is a candidate on the very next plan.
        // Its LANE needs no label: `## Blocked by` names a review-gated member,
        // and gating is inherited downward (#57).
        "--label",
        READY_FOR_AGENT_LABEL,
      ]);
      const url = stdout.trim().split("\n").pop() ?? "";
      const m = url.match(/\/issues\/(\d+)/);
      const number = m && m[1] ? Number(m[1]) : 0;
      if (number === 0) {
        throw new SandbarError(
          `Filed a chunk review follow-up issue but could not read its number ` +
            `out of gh's output (${JSON.stringify(url)}). The issue exists; ` +
            `nothing recorded it, so the next cycle would file a second one. ` +
            `Find it on the tracker and either close it or add the marker ` +
            `comment to the chunk's pull request by hand.`,
        );
      }
      return number;
    },
    async postLedgerComment(prNumber, body) {
      await exec("gh", [
        "pr",
        "comment",
        String(prNumber),
        "--repo",
        slug,
        "--body",
        body,
      ]);
    },
  };
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * File one issue per unconverted changes-requested review on every chunk that
 * has work on origin (#63).
 *
 * Returns the issues it created, in the shape the planner lists candidates in,
 * so the caller can re-plan WITH them (`buildPlan`'s `extraCandidates`) instead
 * of waiting for the listing — see this module's header, and the
 * plan-resolver's.
 *
 * LOUD on failure, like every other tracker write that carries the only copy of
 * something (#8). A read that fails leaves sandbar unable to say whether a
 * review is waiting, while the merge phase would go on adding members to the
 * branch it is waiting on; a create that fails leaves a review unanswered for
 * the same reason; and a ledger comment that fails leaves an issue nothing
 * knows about, which is the one failure that COMPOUNDS — every later cycle
 * files another. None of the three is worth carrying on past.
 */
export async function fileChunkReviewFollowUps(args: {
  readonly chunks: readonly LandedChunk[];
  readonly adapter: ChunkFollowUpAdapter;
  readonly log?: (line: string) => void | Promise<void>;
}): Promise<readonly IssueSummary[]> {
  const log = args.log ?? (() => {});
  const created: IssueSummary[] = [];
  for (const chunk of args.chunks) {
    let state: ChunkPullRequestState | null;
    try {
      state = await args.adapter.reviewState(chunk.branch);
    } catch (err) {
      throw new SandbarError(
        `Could not read the reviews on chunk ${chunk.branch}'s pull request. ` +
          `Sandbar cannot tell whether a human has asked for changes there, ` +
          `and carrying on would land more work onto a branch whose review it ` +
          `has not read: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (!state) continue;
    for (const pending of pendingFollowUps(state)) {
      const content = followUpIssueContent({
        chunk,
        prNumber: state.number,
        pending,
      });
      let issueNumber: number;
      try {
        issueNumber = await args.adapter.createIssue(content);
      } catch (err) {
        if (err instanceof SandbarError) throw err;
        throw new SandbarError(
          `Could not file the follow-up issue for the review requesting ` +
            `changes on chunk ${chunk.branch} (${pending.review.url}, on ` +
            `${state.url}). ` +
            `The issue was most likely not created, in which case the next ` +
            `cycle files it and there is nothing to do. If it WAS created and ` +
            `only the response was lost, it is unledgered, so the next cycle ` +
            `files a second one — check the tracker, and either close the ` +
            `duplicate or record it by hand with a comment containing ` +
            `${followUpMarker(pending.review.id)}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      try {
        await args.adapter.postLedgerComment(
          state.number,
          ledgerComment({
            review: pending.review,
            issueNumber,
            branch: chunk.branch,
          }),
        );
      } catch (err) {
        throw new SandbarError(
          `Filed #${issueNumber} for the review requesting changes on chunk ` +
            `${chunk.branch} (${pending.review.url}), but could not record it ` +
            `on pull request #${state.number}. That comment is what stops the ` +
            `next cycle filing the same issue again, so post it by hand — the ` +
            `body needs to contain ${followUpMarker(pending.review.id)} — or ` +
            `close #${issueNumber} and let sandbar re-file it: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      created.push({
        number: issueNumber,
        title: content.title,
        body: content.body,
        labels: [READY_FOR_AGENT_LABEL],
      });
      await log(
        `chunk ${chunk.branch}: filed #${issueNumber} for a changes-requested ` +
          `review on PR #${state.number} (${pending.review.url})`,
      );
    }
  }
  return created;
}
