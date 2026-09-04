// A changes-requested review on a chunk PR routes back to the landed member it
// concerns (#95, replacing #63's follow-up-issue design; rationale in #92).
// Sandbar comments on that existing issue and adds `ready-for-agent`; #94's
// ordinary rework path resumes it from the chunk tip and lands it back on the
// same branch. No new tracker surface is created.
//
// Routing is deterministic. A thread path is compared with the files each
// member's merge brought onto the chunk branch; one unique owner wins.
// Otherwise the lowest-numbered `LandedChunk.tip` wins. A mis-route costs only
// whose history records the feedback: `implementer-chunk-base.md` licenses
// cross-member rework, so every member can make the right fix. That is why
// phase 1 needs neither a model call nor line-level blame.
//
// Granularity is one comment per (member, review). A review is one human act
// whose threads argue together. Threads routed to one member stay together;
// a review spanning members produces one comment on each containing only that
// member's threads. A body-only review goes to the fallback tip.
//
// Idempotence remains the PR ledger from #63, keyed by the review node id. The
// PR node is strongly consistent, unlike label-scoped issue search, and the
// label flip cannot be the record: after rework lands the label disappears and
// the review would look unhandled again. Member comments and label flips happen
// before the ledger; any failure is loud, so sandbar may repeat a completed
// prefix but never records feedback it did not queue. Threads remain open for
// their human reviewer to resolve.
//
// Pure functions own review selection, routing and prose. Git derives the
// changed paths from each member's merge commit; `gh` reads the review and
// performs the tracker writes behind the adapter below.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ChunkMember, LandedChunk } from "./chunks.js";
import { SandbarError } from "./errors.js";
import { BOT_COMMENT_PREFIX, READY_FOR_AGENT_LABEL } from "./finalize.js";
import { memberBranchName } from "./naming.js";
import type { IssueSummary } from "./plan-resolver.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";

const exec = promisify(execFile);

// The GraphQL read below is the largest `gh` read in this codebase — a hundred
// threads of fifty comments each, plus a hundred issue-comment bodies and fifty
// review bodies, all of them human prose. Node's default ceiling is 1 MB, and
// an overflow here does not degrade: it REJECTS the call, which `reviewState`
// turns into a `SandbarError` that stops the run. Member-path discovery uses
// the same explicit ceiling: its history read scales with the host repository's
// first-parent merges, and a member's changed-path list scales with its tree.
// Same ceiling `forge-pr` and `forge-verify` give their own reads.
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

// Every review id the pull request's comments claim has been handled.
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
// Which reviews are still owed rework
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

export type RoutedFollowUp = {
  readonly member: ChunkMember;
  readonly threads: readonly ReviewThread[];
};

/** Route by unique path ownership, falling back to the lowest-numbered tip. */
export function routeFollowUp(
  chunk: LandedChunk,
  pending: PendingFollowUp,
  pathsByMember: ReadonlyMap<number, ReadonlySet<string>>,
): readonly RoutedFollowUp[] {
  const fallback = [...chunk.tips].sort((a, b) => a.number - b.number)[0];
  if (!fallback) {
    throw new SandbarError(
      `Chunk ${chunk.branch} has no tip to route review feedback to`,
    );
  }
  const grouped = new Map<number, ReviewThread[]>();
  const memberByNumber = new Map(
    chunk.members.map((m) => [m.number, m] as const),
  );
  for (const thread of pending.threads) {
    const owners = chunk.members.filter((m) =>
      pathsByMember.get(m.number)?.has(thread.path),
    );
    const owner = owners.length === 1 ? owners[0] : fallback;
    if (!owner) continue;
    const threads = grouped.get(owner.number) ?? [];
    threads.push(thread);
    grouped.set(owner.number, threads);
  }
  // A body-only review still needs one actionable handle.
  if (pending.threads.length === 0) grouped.set(fallback.number, []);
  return [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, threads]) => ({
      member: memberByNumber.get(number) ?? fallback,
      threads,
    }));
}

// A human's words, rendered so they cannot be mistaken for sandbar's markup.
// Every line is blockquoted so the review remains visually distinct from the
// routing instructions around it.
const quote = (text: string): readonly string[] =>
  text.replace(/\r\n/g, "\n").split("\n").map((line) => `> ${line}`);

const threadHeading = (thread: ReviewThread): string =>
  thread.path.length > 0 ? `### \`${thread.path}\`` : "### Pull request thread";

export function memberReviewComment(args: {
  readonly root: number;
  readonly branch: string;
  readonly prNumber: number;
  readonly review: ChangesRequestedReview;
  readonly threads: readonly ReviewThread[];
}): string {
  const who = args.review.author.length > 0 ? args.review.author : "A reviewer";
  const lines: string[] = [
    `${BOT_COMMENT_PREFIX} ${who} requested changes on the draft pull request ` +
      `for chunk #${args.root} (#${args.prNumber}). This feedback was routed ` +
      `here for rework; the issue will resume from \`${args.branch}\` and land ` +
      `back on that chunk.`,
    "",
    "Do what the review asks for. Sandbar does not resolve review threads — " +
      "the reviewer resolves them when they are satisfied, and nothing here " +
      "depends on their doing so.",
    "",
    `Review: ${args.review.url}`,
  ];
  lines.push("", "## The review");
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
  return lines.join("\n");
}

// The ledger entry, and the reviewer's receipt: it is on the page they are
// looking at, so the answer to "where did my review go?" is one line under it.
export function ledgerComment(args: {
  readonly review: ChangesRequestedReview;
  readonly issueNumbers: readonly number[];
  readonly branch: string;
}): string {
  const issues = args.issueNumbers.map((n) => `#${n}`).join(" and ");
  return (
    `${BOT_COMMENT_PREFIX} commented on ${issues} for the changes requested ` +
    `in [this review](${args.review.url}) and re-queued them. Their rework ` +
    `lands on \`${args.branch}\`, so this pull request will show the commits.\n\n` +
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
  memberPaths(
    chunk: LandedChunk,
  ): Promise<ReadonlyMap<number, ReadonlySet<string>>>;
  requeueMember(issueNumber: number, comment: string): Promise<IssueSummary>;
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
//     are where a just-handled review is recorded; reading the oldest hundred
//     of a busy pull request would re-queue and comment on old reviews every
//     cycle. Read from the new end, a comment falling out of the window costs
//     at most one repeated routing before the new ledger entry settles it.
//   * `reviews(...,last:50)` is the newest fifty changes-requested reviews. A
//     review old enough to fall out of that was handled long ago; a review too
//     NEW to be seen would never be routed at all, which is a silent drop
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
      // review would be re-queued every cycle. Unreachable from GitHub; dropped
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
  readonly repoDir: string;
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
    async memberPaths(chunk) {
      const chunkRef = `refs/remotes/origin/${chunk.branch}`;
      const memberRefs = chunk.members.map(
        (member) => `refs/remotes/origin/${memberBranchName(member.number)}`,
      );
      const [{ stdout: mergesOut }, { stdout: memberShasOut }] =
        await Promise.all([
          exec(
            "git",
            ["rev-list", "--parents", "--first-parent", "--merges", chunkRef],
            { cwd: args.repoDir, maxBuffer: MAX_BUFFER },
          ),
          exec("git", ["rev-parse", ...memberRefs], { cwd: args.repoDir }),
        ]);
      const mergeByMemberSha = new Map<string, [string, string]>();
      for (const line of mergesOut.trim().split("\n").filter(Boolean)) {
        const [merge, firstParent, ...otherParents] = line.trim().split(/\s+/);
        if (!merge || !firstParent) continue;
        for (const parent of otherParents) {
          if (!mergeByMemberSha.has(parent)) {
            mergeByMemberSha.set(parent, [firstParent, merge]);
          }
        }
      }
      const memberShas = memberShasOut.trim().split("\n");
      if (memberShas.length !== chunk.members.length) {
        throw new SandbarError(
          `Resolved ${memberShas.length} member refs for ${chunk.members.length} ` +
            `members on ${chunk.branch}`,
        );
      }
      const entries = await Promise.all(
        chunk.members.map(async (member, index) => {
          const merge = mergeByMemberSha.get(memberShas[index] ?? "");
          if (!merge) {
            throw new SandbarError(
              `Could not find member #${member.number}'s merge on ${chunk.branch}`,
            );
          }
          const { stdout } = await exec(
            "git",
            ["diff", "--name-only", merge[0], merge[1]],
            { cwd: args.repoDir, maxBuffer: MAX_BUFFER },
          );
          const paths = new Set(
            stdout.split("\n").map((path) => path.trim()).filter(Boolean),
          );
          return [member.number, paths] as const;
        }),
      );
      return new Map(entries);
    },
    async requeueMember(issueNumber, comment) {
      await exec("gh", [
        "issue", "comment", String(issueNumber), "--repo", slug,
        "--body", comment,
      ]);
      await exec("gh", [
        "issue", "edit", String(issueNumber), "--repo", slug,
        "--add-label", READY_FOR_AGENT_LABEL,
      ]);
      const { stdout } = await exec("gh", [
        "issue", "view", String(issueNumber), "--repo", slug,
        "--json", "number,title,body,labels",
      ]);
      const raw = JSON.parse(stdout) as {
        number: number; title: string; body: string;
        labels: readonly { name: string }[];
      };
      return {
        number: raw.number,
        title: raw.title,
        body: raw.body,
        labels: raw.labels.map((l) => l.name),
      };
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
 * Route every unconverted changes-requested review to existing chunk members.
 *
 * Returns the issues it re-queued, in the shape the planner lists candidates in,
 * so the caller can re-plan WITH them (`buildPlan`'s `extraCandidates`) instead
 * of waiting for the search index — see this module's header, and the
 * plan-resolver's.
 *
 * LOUD on failure, like every other tracker write that carries the only copy of
 * something (#8). A read that fails leaves sandbar unable to say whether a
 * review is waiting, while the merge phase would go on adding members to the
 * branch it is waiting on; a member write that fails leaves feedback
 * unanswered; and a ledger failure makes the next cycle repeat the routing.
 * None is worth carrying on past.
 */
export async function routeChunkReviewFollowUps(args: {
  readonly chunks: readonly LandedChunk[];
  readonly adapter: ChunkFollowUpAdapter;
  readonly log?: (line: string) => void | Promise<void>;
}): Promise<readonly IssueSummary[]> {
  const log = args.log ?? (() => {});
  const requeued = new Map<number, IssueSummary>();
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
    let pathsByMember: ReadonlyMap<number, ReadonlySet<string>> | undefined;
    for (const pending of pendingFollowUps(state)) {
      try {
        pathsByMember ??= await args.adapter.memberPaths(chunk);
      } catch (err) {
        throw new SandbarError(
          `Could not read the member merges on chunk ${chunk.branch}, so ` +
            `sandbar cannot route review ${pending.review.url}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      const routed = routeFollowUp(chunk, pending, pathsByMember);
      const issueNumbers: number[] = [];
      try {
        for (const route of routed) {
          const candidate = await args.adapter.requeueMember(
            route.member.number,
            memberReviewComment({
              root: chunk.root,
              branch: chunk.branch,
              prNumber: state.number,
              review: pending.review,
              threads: route.threads,
            }),
          );
          issueNumbers.push(route.member.number);
          requeued.set(candidate.number, candidate);
        }
      } catch (err) {
        if (err instanceof SandbarError) throw err;
        throw new SandbarError(
          `Could not re-queue all members for the review requesting changes ` +
            `on chunk ${chunk.branch} (${pending.review.url}, on ${state.url}). ` +
            `The review is not ledgered, so the next cycle retries it: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      try {
        await args.adapter.postLedgerComment(
          state.number,
          ledgerComment({
            review: pending.review,
            issueNumbers,
            branch: chunk.branch,
          }),
        );
      } catch (err) {
        throw new SandbarError(
          `Re-queued ${issueNumbers.map((n) => `#${n}`).join(", ")} for the ` +
            `review requesting changes on chunk ${chunk.branch} ` +
            `(${pending.review.url}), but could not record it ` +
            `on pull request #${state.number}. That comment is what stops the ` +
            `next cycle routing the same review again, so post it by hand — the ` +
            `body needs to contain ${followUpMarker(pending.review.id)} — or ` +
            `let sandbar retry it: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      await log(
        `chunk ${chunk.branch}: re-queued ${issueNumbers.map((n) => `#${n}`).join(", ")} for a changes-requested ` +
          `review on PR #${state.number} (${pending.review.url})`,
      );
    }
  }
  return [...requeued.values()];
}
