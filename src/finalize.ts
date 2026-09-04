// Per-issue branch lifecycle + label flips + issue annotations.
//
// For each issue the orchestrator touched this iteration, dispatches to the
// right side-effects given its terminal state. Run in two passes per cycle
// (#30): the agent terminals are finalised BEFORE the merge phase — they do not
// depend on it, and a merge phase that dies must not take a full attempt
// budget's worth of questions, traces and reviewer prose with it — and the
// merger's own outcomes after. The inputs for each pass are built by
// finalize-inputs.ts; nothing here cares which pass it is in.
//
// Every kind calls reclaimIssueClone — sandbox.close() in the inner loop
// usually has already reclaimed the issue clone, but crash leftovers still need
// deterministic cleanup. Since #98 the clone is a repository of its own, so
// removing it is where commits can be destroyed; `reclaimIssueClone`
// (agent-sandbox.ts) is the one rule for that, and it publishes into the cache
// BEFORE it deletes, answering `preserved` with a reason when it could not.
// Nothing here decides preservation by terminal kind: the arms that would go on
// to delete the cache branch with `-d` (hard-error, needs-ui-prototype) read
// that answer and keep the branch instead, because the cache branch is what
// keeps `pruneStaleIssueClones` off a preserved clone. The reviewer-write
// handoff is the one caller that asks for the clone to be kept when the rule
// would reclaim it: the human is told to inspect it, and uncommitted evidence
// cannot travel through a push. It reports push rejection in the handoff
// comment instead of aborting the rest of the finalise pass. As with every
// human handoff, the explanatory comment precedes the label flip so a comment
// failure cannot park an issue without its recovery instructions.
//
// `git branch -d` is escalated to `-D` only where the caller owns the certainty
// that the work is preserved elsewhere. For `merged`/`chunk-landed`/
// `fresh-attempt` that certainty is structural — the merger just landed the
// branch on the source branch or on the chunk branch and PUSHED it (producing
// different bytes, so the tip is no longer an ancestor of HEAD and `-d`
// correctly refuses), or the silent-noop path is deliberately discarding it.
// `needs-ui-prototype` has no such guarantee (its `hasCommits`
// is per-sandbox-cycle, not per-branch), so it *verifies* containment via
// branchIsContainedInOrigin before forcing, and keeps the branch otherwise.
// `-d` refusing is never on its own a licence to force.
//
// Human-handoff terminals are guarded on live issue state (#16): stamping
// `agentStuck` + a failure comment on an already-CLOSED issue contradicts its
// state and reads as "merged work is broken". The planner's stale-listing
// re-pick (the root cause) is fixed in plan-resolver, but a human can also
// close an issue mid-run, so finalize re-checks `issueState` before any handoff
// write and no-ops (skipped-closed) when the issue is closed.
//
// finalizeOne is pure orchestration over a FinalizeAdapter. realAdapter wires
// the adapter to git/gh.
//
// Handoff labels are configurable (LabelConfig in config.ts) and NOT
// auto-created — a missing/misconfigured label is a host config error. Every
// agent-failure terminal (merge-conflict, merge-gate-red, forge-unverified,
// silent-noop-exhausted, needs-human, review-budget-exhausted) parks the issue
// under the single `agentStuck` label; the *reason* lives in the bot comment.
//
// `chunk-landed` (#60) must remove `ready-for-agent`: on a published member that
// label now requests rework (#94). It also applies the display-only
// `needs-review` label, whose failure still costs only the human cue and never
// blocks landing. The issue comment remains required: it names the review
// branch even when that optional display-label edit fails.
//
// Required side-effects fail loud, they don't swallow (#8). The original bug was
// `editLabels` catching a "label doesn't exist" error, logging it, and returning
// as if the issue had been parked — so the run continued and the issue, never
// removed from the queue, was re-picked forever. Now the required git/gh
// operations (pushBranch, postComment, and the required label flips via
// requireFlip) throw SandbarError on failure; run() surfaces it as the final
// output and stops. editLabels still removes then adds as separate `gh` calls so
// a missing add-label can't abort the queue-removing --remove-label, and it
// returns its outcome structured so the benign `merged` cleanup can ignore a
// failure while the handoff arms turn it into a loud stop.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { type IssueCloneReclaim, reclaimIssueClone } from "./agent-sandbox.js";
import { LAND_LABEL, NEEDS_REVIEW_LABEL } from "./chunks.js";
import { strandedHeadRef } from "./naming.js";
import type { LabelConfig } from "./config.js";
import { SandbarError, isExitCode } from "./errors.js";
import type { HeadMismatch } from "./git-ops.js";
import type { IssueRef } from "./merger.js";
import type { SpecGap } from "./inner-loop.js";
import { type RepoLayout, worktreePathFor } from "./repo-cache.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";

// Where an implementer's commits ended up when it worked off the issue branch
// (#27). Structural alias of git-ops' HeadMismatch — finalize only ever reads
// it, and only to name a sha nothing else will ever mention again.
type StrandedHead = HeadMismatch;

const exec = promisify(execFile);

// The planner queue label sandbar removes when an issue leaves the queue. Fixed
// (not in LabelConfig) — it's the protocol entry label, shared with the
// planner's list filter and the merger; see config.ts LabelConfig.
export const READY_FOR_AGENT_LABEL = "ready-for-agent";

export const BOT_COMMENT_PREFIX = "**Sandbar:**";

// A note that applies to every template below, and to the ones in
// `chunk-land.ts` and `chunk-pr.ts`: these bodies are posted into the HOST
// repository. `#N` in one of them is not a sandbar issue — GitHub resolves it
// against the host's numbering, renders it as a link and files a
// cross-reference event and a notification on whatever issue or pull request
// happens to hold that number. So the `(#N)` citation this codebase uses
// everywhere else stays in module headers and comments; the only `#N` a body
// may carry is one it was HANDED, which is a host issue number by
// construction.
//
// EVERY PARKING TEMPLATE WHOSE TERMINAL PUSHES THE BRANCH NAMES IT (#70).
// These bodies are the place the human is standing when they act — "push a fix
// on this branch" was in three of them and none of them said which. The name is
// re-derivable in principle (`issueBranchName` = number + `kebabSlug(title)`)
// but lossily: `operator's` kebabs to `operator-s`, and a retitled issue gets
// a DIFFERENT branch next cycle, so re-deriving a parked branch's name can
// simply be wrong. It is handed in from `input.issue.branch`, which is the
// branch that was actually pushed.
//
// The qualifier is the whole rule, because two terminals leave no branch to
// name and correctly say so instead. `NEEDS_UI_PROTOTYPE` normally escalates
// before a line of code exists and `finalizeOne` deletes the local branch, so
// it takes a nullable `branchPushed` and names one only on the late
// escalation that did push. `SILENT_NOOP_EXHAUSTED` never has one: that
// terminal discards the branch after every attempt, which its body says.
//
// What each of them names is the LOCATION, never what the push CARRIES. The
// two are not the same claim: an off-branch run pushes the branch and moves
// nothing onto it, and `STRANDED_COMMITS_NOTE` — appended by the needs-info and
// off-branch arms below — is the one sentence entitled to say where the work
// actually is. A template that also claimed "whatever it wrote is pushed here"
// would contradict the paragraph directly beneath it in the same comment body.
//
// Nor does naming it predict what the NEXT attempt will do with it. The branch
// is where the work is now; whether an attempt resumes on it is preflight's
// business and the operator's — preflight offers deleting a merged issue branch,
// and a parked branch deleted by hand seeds the next attempt from
// `origin/<sourceBranch>` instead. #70 asks these bodies to say where the human
// is standing, which is a fact about the present, and every clause past that is
// a forecast the template cannot keep.

export const NEEDS_INFO_COMMENT_TEMPLATE = (
  branch: string,
  questions: string,
  needsInfoLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} the agent paused with NEEDS-INFO. The branch is ` +
  `\`${branch}\`. Please answer the questions below, then drop ` +
  `\`${needsInfoLabel}\` and re-apply \`${readyLabel}\` when the answers are ` +
  `ready.\n\n---\n\n${questions}`;

// #21 — the implementer stopped before writing code because the issue implies
// non-trivial user-visible UI and carries no prototype. Same human round-trip
// as NEEDS-INFO (supply the missing artifact, re-label), so it reuses the
// needsInfo label; the comment is what makes the ask concrete.
//
// The unblocking routes are spelled out because most of them silently don't
// work: the agent reads this issue as text (`gh issue view --json`), so a
// pasted screenshot is a URL it can neither authenticate to nor see. An
// in-repo file must be on the source branch before re-labelling, because issue
// branches seed from `origin/<sourceBranch>`, not the operator's local.
// The escape phrase is deliberately verbatim in both this comment and
// prompts/implementer.md ("no prototype needed"): the human types it here and
// the next run's implementer must recognise it in the issue anchor. That
// coupling is pinned by a test.
export const NO_PROTOTYPE_NEEDED_PHRASE = "no prototype needed";

export const NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE = (
  issueNum: number,
  uiImpact: string,
  needsInfoLabel: string,
  readyLabel: string,
  // The escalation normally lands before a line of code exists, but a late one
  // is accepted (see promise-parser) and then the branch was pushed. Saying
  // "stopped before writing any code" in that case tells the human the opposite
  // of what just happened.
  branchPushed: string | null,
): string =>
  `${BOT_COMMENT_PREFIX} the agent stopped ${
    branchPushed === null
      ? "before writing any code"
      : `and pushed what it had to \`${branchPushed}\``
  }. This issue implies user-visible UI that no human has seen, and no prototype ` +
  `was found in the issue body or comments — continuing would mean inventing the ` +
  `design and merging it unseen. The agent's assessment is below.\n\n` +
  `To unblock, either:\n\n` +
  `1. **Give it a prototype it can read.** Suggested route: commit a file to the ` +
  `repo (e.g. \`docs/prototypes/issue-${issueNum}.html\`) and reference it by path ` +
  `here — push it to the source branch first, because issue branches are seeded ` +
  `from origin, not your local checkout. An inline fenced markup block or ASCII ` +
  `wireframe in a comment works just as well, as does a prose spec precise enough ` +
  `to pin the decisions listed below. A screenshot on its own does not: the agent ` +
  `reads this issue as text and cannot see images.\n` +
  `2. **Reply "${NO_PROTOTYPE_NEEDED_PHRASE}"** — in your own comment, not by ` +
  `editing this one — if you're happy for the agent to make these design ` +
  `decisions itself.\n\n` +
  `Then drop \`${needsInfoLabel}\` and re-apply \`${readyLabel}\`.\n\n` +
  `---\n\n${uiImpact}`;

export const NEEDS_HUMAN_COMMENT_TEMPLATE = (
  branch: string,
  failureTrace: string,
  stuckLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} exhausted the consecutive quality-failure budget ` +
  `without a green gate. ` +
  `Investigate the trace below and push a fix on \`${branch}\`, then drop ` +
  `\`${stuckLabel}\` and re-apply \`${readyLabel}\` when ready.\n\n` +
  `<details><summary>Last failure trace</summary>\n\n` +
  `\`\`\`\n${failureTrace}\n\`\`\`\n\n</details>`;

export const NEEDS_HUMAN_NO_SIGNAL_COMMENT_TEMPLATE = (
  branch: string,
  failureTrace: string,
  stuckLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} exhausted the consecutive quality-failure budget ` +
  `because the implementer ` +
  `did not produce an actionable completion signal on the final attempt. ` +
  `Inspect the attempt transcripts and summary below, fix the provider or push ` +
  `a fix on \`${branch}\`, then drop ` +
  `\`${stuckLabel}\` and re-apply \`${readyLabel}\` when ready.\n\n` +
  `<details><summary>Attempt summary</summary>\n\n` +
  `\`\`\`\n${failureTrace}\n\`\`\`\n\n</details>`;

// The worktree could not be brought to a committed state, so no gate ever ran
// (#24 D1). Distinct from NEEDS_HUMAN_COMMENT_TEMPLATE, which says "exhausted
// the quality budget without a green gate" — true-ish but it sends the reader
// looking for a failing test. It may fire early when two attempts leave the
// same dirty set, or when the quality budget expires across changing sets.
// What the human needs is the path list and the knowledge that the cause is
// almost never the branch's code.
export const NEEDS_HUMAN_UNCOMMITTABLE_COMMENT_TEMPLATE = (
  branch: string,
  failureTrace: string,
  stuckLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} stopped: the worktree for \`${branch}\` could not be ` +
  `brought to a committed state across attempts, so no gate could run — a gate ` +
  `verdict is about a commit, and there was never one to judge. The last dirty ` +
  `set is below. It may be a gate step writing outside a gitignored path or a ` +
  `container writing into the tree as another uid. Fix that (or ` +
  `commit/ignore the paths below), then drop \`${stuckLabel}\` and re-apply ` +
  `\`${readyLabel}\`.\n\n` +
  `<details><summary>Uncommitted paths</summary>\n\n` +
  `\`\`\`\n${failureTrace}\n\`\`\`\n\n</details>`;

// Appended to any handoff comment whose run left commits off the issue branch
// (#27). Split out because three arms need it and only one of them is the
// off-branch terminal itself: NEEDS-INFO and NEEDS-UI-PROTOTYPE are exempt from
// the correction, so for them this note is the ONLY place the work is recorded.
//
// The prose branches on `headRef`, and that distinction is not cosmetic. A
// DETACHED head leaves the commits unreachable until reuse publishes a durable
// pin into the host cache. A scratch BRANCH is pinned there the same way —
// telling that reader their work is about to be pruned would send them to
// perform an urgent rescue of something in no danger, and telling them to
// `git branch <name> <sha>` would have them create a second name for a commit
// that already has one.
export const STRANDED_COMMITS_NOTE = (m: StrandedHead): string =>
  m.headRef === null
    ? `\n\n---\n\n**Work was left off \`${m.branch}\`.** This run committed on a ` +
      `detached HEAD at \`${m.headSha}\`, so none of it is on the branch and ` +
      `nothing above includes it. Sandbar pinned that commit in the host-side ` +
      `cache as \`${strandedHeadRef(m.headSha)}\` before reclaiming the ` +
      `issue clone (the clone is kept instead if that pin failed). Recover it ` +
      `with \`git branch <rescue-name> ${m.headSha}\`, then fold ` +
      `it into \`${m.branch}\` with \`cherry-pick\`/\`merge\` — not ` +
      `\`branch -f\`, unless \`${m.branch}\` is an ancestor of ${m.headSha}.`
    : `\n\n---\n\n**Work was left off \`${m.branch}\`.** This run committed on ` +
      `\`${m.headRef}\` (at \`${m.headSha}\`) instead, so none of it is on the ` +
      `branch and nothing above includes it. Sandbar pinned that commit in the ` +
      `host-side cache as \`${strandedHeadRef(m.headSha)}\` before ` +
      `reclaiming the issue clone (the clone is kept instead if that pin ` +
      `failed). Fold it into \`${m.branch}\` with \`cherry-pick\`/\`merge\`.`;

// The implementer committed off the issue branch and stayed off it after being
// told (#27). Neither the gate-red nor a review-budget comment applies —
// and neither would mention the fact that matters, which is that work exists and
// is not where anyone will look for it.
//
// Deliberately says NOTHING about whether a gate ran, whether the branch moved,
// or whether anything merged. The tempting version of this comment asserts all
// three ("no gate ran, the branch never moved, nothing was merged") because that
// is true of the case #27 describes — an agent detached from its first attempt.
// But that case cannot reach this terminal *or* any other interesting one: with
// no commit on the branch, `parsePromise`'s zero-commit guard downgrades every
// COMPLETE. The path that actually gets here is the ordinary review round-trip,
// where attempt 1 committed on the branch, a gate ran and went green, and only
// the later attempts wandered off — so all three claims would be false, and the
// author would be sent to look for a failing gate that passed.
//
// What is invariant is the part worth saying: the later work is not on the
// branch. STRANDED_COMMITS_NOTE says where it is instead.
export const NEEDS_HUMAN_OFF_BRANCH_COMMENT_TEMPLATE = (
  branch: string,
  failureTrace: string,
  stuckLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} stopped: the implementer committed somewhere other ` +
  `than \`${branch}\` — a detached HEAD, or a branch of its own — and its last ` +
  `attempt was still off the branch. Whatever had already landed on ` +
  `\`${branch}\` is untouched and correct; ` +
  `what the off-branch attempts wrote is not part of it, and no gate verdict on ` +
  `this issue covers that work.\n\n` +
  `Fold the stranded commits in (see below), then drop \`${stuckLabel}\` and ` +
  `re-apply \`${readyLabel}\`.\n\n` +
  `<details><summary>What the implementer was told</summary>\n\n` +
  `\`\`\`\n${failureTrace}\n\`\`\`\n\n</details>`;

// A second consecutive incident with a GREEN
// gate and NO review at all (#41). Every other template here would misdescribe
// it, and the review-budget comment would misdescribe it in
// the most expensive direction: it opens by asserting the reviewer's
// `CHANGES-REQUESTED` is the blocker and then renders the harness's error text
// under a "latest reviewer pass" heading, sending the author to resolve a
// standards complaint nobody made.
//
// So this one says the opposite in as many words: this round's reviewer never
// reviewed the code. The trace is the harness's, and the fix is in the harness
// or the environment — the branch is green and may well be mergeable as it
// stands, which is the one thing the reader most needs to know before they start
// reading their own diff for a defect.
//
// **Every claim it makes is scoped to the round that failed**, for the same
// reason the implementer's note is (see `reviewerHarnessFailedReprompt`): this
// terminal is reachable with an EARLIER round's genuine `CHANGES-REQUESTED`
// behind it — round 1 reviews and rejects, attempt 2's reviewer wedges — and the
// verdict carries that prose. A comment saying no verdict was ever reached and
// nothing was ever asked for would then be false in the direction that costs
// most: the author is told to review the branch themselves while the one real
// report anyone produced about it is dropped on the floor. Nothing else surfaces
// it — the attempt logs are offline and this arm is not `review-budget-exhausted`
// — so it is rendered here, under its own heading, and described as an earlier
// round's and possibly unaddressed rather than as the blocker.
//
// With no prose the stronger sentence is the true one and is kept: no reviewer
// has said anything about this branch at all.
export const NEEDS_HUMAN_REVIEWER_HARNESS_COMMENT_TEMPLATE = (
  branch: string,
  failureTrace: string,
  latestReviewerProse: string | null,
  stuckLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} stopped: the gate is GREEN and the last code-reviewer ` +
  `round produced no review at all — every invocation returned nothing, so no ` +
  `verdict was reached about the current commits. This is a harness or ` +
  `environment failure, not a \`CHANGES-REQUESTED\`: the reviewer did not ask for ` +
  `changes this round, because it did not run, and the trace below is the ` +
  `harness's rather than a finding about this branch.\n\n` +
  (latestReviewerProse === null
    ? `No reviewer has said anything about this branch at all. `
    : `An earlier round did review this branch, and its report is reproduced at ` +
      `the bottom. Treat it as still standing: work went on after it, but nothing ` +
      `reviewed the result, so whether it was addressed is unverified. `) +
  `\`${branch}\` is pushed and its commits pass the gate. Review it yourself, or ` +
  `fix what stopped the reviewer and re-run — then drop \`${stuckLabel}\` and ` +
  `re-apply \`${readyLabel}\`.\n\n` +
  `<details><summary>Why each reviewer invocation produced nothing</summary>\n\n` +
  `\`\`\`\n${failureTrace}\n\`\`\`\n\n</details>` +
  (latestReviewerProse === null
    ? ""
    : `\n\n---\n\nThe last review this branch actually received, from an ` +
      `earlier round:\n\n${latestReviewerProse}`);

export const REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE = (
  branch: string,
  budget: "quality" | "correctness",
  roundsUsed: number,
  latestReviewerProse: string,
  stuckLabel: string,
  readyLabel: string,
): string => {
  const field = budget === "quality" ? "maxQualityRounds" : "maxReviewRounds";
  return `${BOT_COMMENT_PREFIX} exhausted the \`${field}\` ${budget} budget after ` +
  `${roundsUsed} consecutive ${budget} failure${roundsUsed === 1 ? "" : "s"} ` +
  `without that pass reaching an \`APPROVED\` verdict. The latest ${budget} ` +
  `pass below is the ` +
  `report the human needs to resolve. Push a fix on \`${branch}\` (or rewrite ` +
  `the governing issue or project instructions if the reviewer was wrong), ` +
  `then drop \`${stuckLabel}\` and ` +
  `re-apply \`${readyLabel}\` when ready.\n\n---\n\n${latestReviewerProse}`;
};

export const SILENT_NOOP_EXHAUSTED_COMMENT_TEMPLATE = (attempts: number): string =>
  `${BOT_COMMENT_PREFIX} hit the silent-merge-abort failure mode ${attempts} time${attempts === 1 ? "" : "s"} ` +
  `this run. Each time, the merger's resolve-loop reported success but no merge commit landed on the source branch ` +
  `(the agent ran \`git merge --abort\` and exited without producing a merge commit). The branch was ` +
  `discarded after each attempt so the next cycle could re-implement against current source, but the ` +
  `integration drift hasn't healed. A human needs to land this — either by resolving the conflict manually ` +
  `or by re-scoping the issue.`;

// #60 — what a chunk member is told when its branch lands on the chunk branch.
//
// Three things a human needs and none of them is "done": where the work is (a
// branch on origin, not the source branch), why the issue is still open (the
// review that closes it is a review of the whole chunk), and why leaving the
// agent queue did not lose it. The last one matters even when the optional
// display label cannot be applied.
export const CHUNK_LANDED_COMMENT_TEMPLATE = (chunkBranch: string): string =>
  `${BOT_COMMENT_PREFIX} this issue's work is merged and pushed to ` +
  `\`${chunkBranch}\`, the branch its review chunk lands on. The gate is green ` +
  `on the composed branch, and **nothing has reached the source branch** — this ` +
  `issue is review-gated, so a human reviews \`${chunkBranch}\` as one unit ` +
  `before any of it lands.\n\n` +
  `The issue stays OPEN but is out of the agent queue: git records its durable ` +
  `member ref as contained by the chunk branch. It closes when the ` +
  `chunk lands, which a human ` +
  `triggers by putting \`${LAND_LABEL}\` on the chunk's pull request — ` +
  `sandbar then merges \`${chunkBranch}\` into the source branch and closes every ` +
  `issue on it. Re-apply \`ready-for-agent\` to ask sandbar to build a change ` +
  `before the chunk lands. The local issue branch was deleted — \`${chunkBranch}\` carries ` +
  `its commits.`;

type FinalizeKindInput =
  | { readonly kind: "merged"; readonly issue: IssueRef }
  // #60 — a review-gated issue whose branch landed on its chunk's branch, which
  // is now on origin. NOT a close: nothing has reached the source branch and
  // the review that would justify closing has not happened. The issue stays
  // OPEN and attempts to swap `ready-for-agent` for `needs-review` for display.
  | {
      readonly kind: "chunk-landed";
      readonly issue: IssueRef;
      readonly chunkBranch: string;
    }
  | { readonly kind: "merge-conflict"; readonly issue: IssueRef }
  | { readonly kind: "merge-gate-red"; readonly issue: IssueRef }
  // Verified merge mode (#22): merged + locally gated green, but the forge
  // rejected the cycle's composed result, so the merge was reverted and nothing
  // landed. Same handoff shape as merge-gate-red — the merger already posted the
  // explanatory comment and dropped the queue label; finalize pushes the branch
  // (the human needs it on the forge to inspect) and parks it.
  | { readonly kind: "forge-unverified"; readonly issue: IssueRef }
  | {
      readonly kind: "needs-info";
      readonly issue: IssueRef;
      readonly questions: string;
      // #27 — see needs-ui-prototype. This arm always pushes, but an off-branch
      // agent moved nothing, so the push carries none of what it wrote.
      readonly strandedHead: StrandedHead | null;
    }
  // #21 — implementer escalated on non-trivial UI impact with no prototype.
  // Same handoff shape as needs-info (comment + `ready-for-agent` → needsInfo),
  // but the branch is pushed only when `hasCommits`: the escalation normally
  // fires before any code exists, and pushing then would publish a remote
  // branch identical to the source tip — one junk ref per escalation.
  | {
      readonly kind: "needs-ui-prototype";
      readonly issue: IssueRef;
      readonly uiImpact: string;
      readonly hasCommits: boolean;
      // #27 — the agent escalated from off the branch. `hasCommits` is false in
      // that case (commits are counted on the branch), so this arm is about to
      // delete a branch while the work sits on an unnamed dangling commit.
      readonly strandedHead: StrandedHead | null;
    }
  | {
      // Quality-budget exhaustion, or a blocker the agent cannot clear.
      // `cause` selects the comment so the human is pointed at the real blocker
      // (#17): gate-red surfaces the failure trace; uncommittable-worktree surfaces
      // the paths that stayed dirty across attempts (no gate ever ran, so a
      // gate-red comment would describe a failure that did not happen);
      // off-branch-head surfaces where HEAD went (#27) — likewise no gate ran,
      // and the comment is the only place the stranded commit's sha survives;
      // reviewer-harness-failed says the gate is green and nothing reviewed the
      // current commits (#41), which is the one arm where `latestReviewerProse`
      // may be a real report from an EARLIER round: it is rendered, because
      // nothing else surfaces it, but as that earlier round's and never as the
      // reason the issue stopped.
      readonly kind: "needs-human";
      readonly issue: IssueRef;
      readonly cause:
        | "gate-red"
        | "no-signal-exhausted"
        | "uncommittable-worktree"
        | "off-branch-head"
        | "reviewer-harness-failed";
      readonly failureTrace: string;
      readonly latestReviewerProse: string | null;
      readonly qualityBudgetExhausted: number | null;
      readonly strandedHead: StrandedHead | null;
    }
  | {
      readonly kind: "review-budget-exhausted";
      readonly issue: IssueRef;
      readonly budget: "quality" | "correctness";
      readonly roundsUsed: number;
      readonly latestReviewerProse: string;
    }
  | {
      readonly kind: "read-only-agent-wrote";
      readonly issue: IssueRef;
      readonly latestReviewerProse: string;
      readonly actor: "reviewer" | "UI checker";
    }
  | {
      readonly kind: "hard-error";
      readonly issue: IssueRef;
      readonly hasCommits: boolean;
    }
  | {
      readonly kind: "quota";
      readonly issue: IssueRef;
      readonly provider: "claude" | "codex";
      readonly window: string;
      readonly resetsAt?: number;
    }
  // Silent-noop under the retry cap: discard the branch + worktree so the
  // next execution starts fresh against current source. The issue
  // stays `ready-for-agent` and the planner re-picks it.
  | { readonly kind: "fresh-attempt"; readonly issue: IssueRef }
  // Silent-noop retries exhausted: drop `ready-for-agent`, add the handoff
  // label, post a comment explaining the failure mode. No branch is pushed
  // (each silent-noop deleted it; there's nothing on the remote to inspect).
  | {
      readonly kind: "silent-noop-exhausted";
      readonly issue: IssueRef;
      readonly attempts: number;
    };

export type FinalizeInput = FinalizeKindInput & {
  // Correctness-review decisions caused by missing specification, in the order
  // the rounds declared them. Evidence only: this field affects no terminal,
  // label, branch lifecycle, or state-machine decision (#108).
  readonly specGaps: readonly SpecGap[];
};

export const SPEC_GAPS_COMMENT = (gaps: readonly SpecGap[]): string =>
  `${BOT_COMMENT_PREFIX} the correctness reviewer recorded the following ` +
  `specification gap${gaps.length === 1 ? "" : "s"} and the decision it applied:` +
  gaps.map((gap) => `\n\n### Review round ${gap.round}\n\n${gap.text}`).join("");

export type FinalizeAdapter = {
  pushBranch(branch: string): Promise<void>;
  // git branch -d — refuses if the branch isn't merged, which is desirable.
  // Returns ok=false with the error message instead of throwing so the
  // orchestrator can keep finalising the rest.
  deleteBranch(
    branch: string,
  ): Promise<{ readonly ok: boolean; readonly error?: string }>;
  // git branch -D — force-delete. Only safe in contexts where the caller
  // knows the work is already preserved elsewhere (e.g., the merger just
  // landed it on the source branch via the resolve-loop, where the merge
  // tree differs from the branch's diff so `-d` refuses).
  forceDeleteBranch(
    branch: string,
  ): Promise<{ readonly ok: boolean; readonly error?: string }>;
  // Reclaim the issue clone through `reclaimIssueClone` (agent-sandbox.ts):
  // publish into the cache, then delete — or keep it and say why. `keep` is a
  // reason to preserve a clone the rule would reclaim. sandbox.close() in the
  // inner loop usually has already reclaimed it, in which case `absent`.
  reclaimIssueClone(branch: string, keep?: string): Promise<IssueCloneReclaim>;
  // True iff every commit on `branch` is already contained in
  // origin/<sourceBranch> — i.e. deleting it destroys nothing. This is the
  // *verified* form of the certainty forceDeleteBranch requires; `-d` refusing
  // is NOT that certainty (it also refuses when the local source branch merely
  // trails origin). Git's exit 1 answers false; other failures propagate.
  branchIsContainedInOrigin(branch: string): Promise<boolean>;
  postComment(issueNum: number, body: string): Promise<void>;
  // Removes then adds, as SEPARATE `gh issue edit` calls (remove first). A
  // single `gh issue edit` is atomic: if any --add-label target doesn't exist,
  // gh rejects the whole command and the --remove-label is collateral damage —
  // the issue keeps `ready-for-agent` and the planner re-picks it forever (#8).
  // Splitting guarantees the queue-removal lands even when the handoff label is
  // missing/misconfigured, and the result reports what failed so the caller can
  // fail loud instead of swallowing.
  editLabels(
    issueNum: number,
    remove: readonly string[],
    add: readonly string[],
  ): Promise<LabelEditResult>;
  // Live issue state from the tracker. Read before any human-handoff write so a
  // closed issue (merged earlier this run, or human-closed mid-run) never gets
  // stamped with a handoff label + failure comment (#16).
  issueState(issueNum: number): Promise<"OPEN" | "CLOSED">;
  // Read-back after finalization. A successful write is not accepted until the
  // tracker reports the queue label absent (#87).
  issueLabels(issueNum: number): Promise<readonly string[]>;
};

export type LabelEditResult = {
  readonly ok: boolean;
  // Present iff !ok. Describes which leg(s) failed (remove and/or add).
  readonly error?: string;
};

export type FinalizeAction =
  | { readonly kind: "deleted-local" }
  | { readonly kind: "delete-failed"; readonly error: string }
  | { readonly kind: "pushed" }
  | { readonly kind: "parked-local" }
  | { readonly kind: "kept-branch"; readonly reason: string }
  // A human-handoff terminal landed on an already-CLOSED issue, so the label
  // flip + comment were skipped. Its clone is reclaimed unless it contains
  // evidence the corresponding open-issue handoff would preserve. See #16.
  | { readonly kind: "skipped-closed" }
  | { readonly kind: "noop" };

// Terminals that write a human-handoff annotation (handoff label + a comment)
// to the issue. These are the kinds guarded against an already-CLOSED issue in
// finalizeOne (#16); merged/hard-error/fresh-attempt touch no issue state and
// are exempt.
const HANDOFF_KINDS: ReadonlySet<FinalizeInput["kind"]> = new Set([
  "merge-conflict",
  "merge-gate-red",
  "forge-unverified",
  "needs-info",
  "needs-ui-prototype",
  "needs-human",
  "review-budget-exhausted",
  "read-only-agent-wrote",
  "silent-noop-exhausted",
]);

// Only these successful finalizations decide to remove `ready-for-agent`.
// Quota and infrastructure terminals deliberately leave the issue queued, and
// a closed-issue handoff performs no tracker write at all (#16).
export function finalizationIntendsNotReady(result: FinalizeResult): boolean {
  return result.action.kind !== "skipped-closed" && HANDOFF_KINDS.has(result.input.kind);
}

// The one caller that keeps a clone the reclaim rule would remove — see the
// module header.
const READ_ONLY_AGENT_WROTE_KEEP =
  "a read-only agent changed the repository; kept for human inspection";

const reclaimClone = (
  input: FinalizeInput,
  adapter: FinalizeAdapter,
): Promise<IssueCloneReclaim> =>
  adapter.reclaimIssueClone(
    input.issue.branch,
    input.kind === "read-only-agent-wrote" ? READ_ONLY_AGENT_WROTE_KEEP : undefined,
  );

// What a preserved clone means for the cache branch an arm was about to
// delete: keep it. `pruneStaleIssueClones` removes a marked clone whose cache
// branch is gone, so deleting the branch would hand the preserved clone — and
// whatever the publish could not move out of it — to the next sweep.
const keptForPreservedClone = (reason: string): FinalizeAction => ({
  kind: "kept-branch",
  reason: `kept the cache branch: the issue clone was preserved (${reason})`,
});

export type FinalizeResult = {
  readonly input: FinalizeInput;
  readonly action: FinalizeAction;
};

export function issueNumberOf(issue: IssueRef): number {
  const n = Number(issue.id);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid issue id (expected positive integer): ${issue.id}`);
  }
  return n;
}

// A required human-handoff label flip. The split-call adapter already ran the
// remove first (so the issue leaves the agent queue regardless), but if either
// leg failed we fail loud rather than report a successful handoff that didn't
// happen — the #8 bug. A failed flip is almost always a config error: the
// handoff label doesn't exist in the repo and sandbar never creates labels.
function requireFlip(r: LabelEditResult, issueNum: number): void {
  if (r.ok) return;
  throw new SandbarError(
    `Could not park issue #${issueNum} for a human: applying the handoff labels ` +
      `failed (${r.error ?? "unknown error"}). This is almost certainly a config ` +
      `error — the label does not exist in the repo (sandbar never creates ` +
      `labels). Create it or set config.labels, then re-run.`,
  );
}

// `-d`, escalating to `-D` when it refuses. ONLY for callers that own the
// certainty the work is preserved elsewhere — see the module header. Callers
// without that certainty must verify it (branchIsContainedInOrigin) instead of
// reaching for this.
async function deleteBranchForcing(
  adapter: FinalizeAdapter,
  branch: string,
): Promise<FinalizeAction> {
  const d = await adapter.deleteBranch(branch);
  if (d.ok) return { kind: "deleted-local" };
  const f = await adapter.forceDeleteBranch(branch);
  return f.ok
    ? { kind: "deleted-local" }
    : { kind: "delete-failed", error: f.error ?? d.error ?? "" };
}

export async function finalizeOne(
  input: FinalizeInput,
  adapter: FinalizeAdapter,
  labels: LabelConfig,
): Promise<FinalizeAction> {
  // #16: never write a handoff annotation to an issue that's already CLOSED.
  // The planner can re-pick a merged+closed issue while `gh issue list` lags
  // (root cause fixed in plan-resolver), and a human can close an issue
  // mid-run — in both cases the handoff write would contradict the closed
  // state. Reclaim ordinary clones, preserve evidence clones, and skip the
  // issue-facing side effects.
  //
  // Correctness-review specification gaps (#108) are a separate required issue
  // comment, posted once per issue and terminal after that closed-handoff guard
  // and before terminal dispatch. This deliberately includes `merged`, whose
  // old arm wrote no comment. The ordered records are evidence only; they do not
  // select an arm or alter any terminal side effect.
  if (HANDOFF_KINDS.has(input.kind)) {
    const n = issueNumberOf(input.issue);
    if ((await adapter.issueState(n)) === "CLOSED") {
      await reclaimClone(input, adapter);
      return { kind: "skipped-closed" };
    }
  }
  if (input.specGaps.length > 0) {
    await adapter.postComment(
      issueNumberOf(input.issue),
      SPEC_GAPS_COMMENT(input.specGaps),
    );
  }
  switch (input.kind) {
    case "merged": {
      // AC: worktree first, then branch — so an interrupt mid-cleanup never
      // leaves a dangling worktree pointing at a deleted ref.
      await adapter.reclaimIssueClone(input.issue.branch);
      // The merger's merge commit auto-closes the issue, but GitHub doesn't
      // strip labels on close — drop `ready-for-agent` so the closed issue
      // isn't left advertising itself as plannable (#7). Best-effort: a failure
      // here is benign (the planner lists open issues, so a closed issue still
      // carrying the label is never re-picked).
      await adapter.editLabels(
        issueNumberOf(input.issue),
        [READY_FOR_AGENT_LABEL],
        [],
      );
      // `-d` may refuse: if the resolve loop produced a different tree on the
      // source branch than the branch's diff, the branch tip isn't an ancestor
      // of HEAD. The merger just landed this branch, so we own the certainty
      // and escalate to `-D`.
      return deleteBranchForcing(adapter, input.issue.branch);
    }
    case "chunk-landed": {
      // #60. Same branch lifecycle as `merged` — the commits are on the chunk
      // branch and that branch is on origin, so the local issue branch is a
      // duplicate and `-D` is safe on the same structural certainty. What
      // differs is everything issue-facing: no close (the review has not
      // happened), and the label flip moves the issue out of the agent queue.
      // It is required because `ready-for-agent` on a published member now
      // deliberately requests another implementation pass (#94).
      const n = issueNumberOf(input.issue);
      await adapter.reclaimIssueClone(input.issue.branch);
      const dequeue = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [],
      );
      if (!dequeue.ok) {
        throw new SandbarError(
          `Could not move chunk member #${n} into review: removing ` +
            `\`${READY_FOR_AGENT_LABEL}\` failed ` +
            `(${dequeue.error ?? "unknown error"}). The issue may still be in the ` +
            `agent queue, so its local branch was kept; fix the label configuration ` +
            `or forge failure, then re-run.`,
        );
      }
      // Display only: the durable comment below still points the human to the
      // review branch when a host has not created `needs-review`.
      await adapter.editLabels(n, [], [NEEDS_REVIEW_LABEL]);
      await adapter.postComment(
        n,
        CHUNK_LANDED_COMMENT_TEMPLATE(input.chunkBranch),
      );
      return deleteBranchForcing(adapter, input.issue.branch);
    }
    case "merge-conflict": {
      const n = issueNumberOf(input.issue);
      await adapter.reclaimIssueClone(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      // The merger already dropped `ready-for-agent`; finalize only parks it
      // under the handoff label.
      const r = await adapter.editLabels(n, [], [labels.agentStuck]);
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "merge-gate-red":
    case "forge-unverified": {
      const n = issueNumberOf(input.issue);
      await adapter.reclaimIssueClone(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      const r = await adapter.editLabels(n, [], [labels.agentStuck]);
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "needs-info": {
      const n = issueNumberOf(input.issue);
      await adapter.reclaimIssueClone(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      await adapter.postComment(
        n,
        NEEDS_INFO_COMMENT_TEMPLATE(
          input.issue.branch,
          input.questions,
          labels.needsInfo,
          READY_FOR_AGENT_LABEL,
        ) +
          (input.strandedHead ? STRANDED_COMMITS_NOTE(input.strandedHead) : ""),
      );
      const r = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.needsInfo],
      );
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "needs-ui-prototype": {
      const n = issueNumberOf(input.issue);
      const reclaim = await adapter.reclaimIssueClone(input.issue.branch);
      if (input.hasCommits) {
        // Late escalation: the agent had already committed before it realised
        // it was inventing UI. Hand the partial work to the human.
        await adapter.pushBranch(input.issue.branch);
      }
      await adapter.postComment(
        n,
        NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE(
          n,
          input.uiImpact,
          labels.needsInfo,
          READY_FOR_AGENT_LABEL,
          input.hasCommits ? input.issue.branch : null,
        ) +
          (input.strandedHead ? STRANDED_COMMITS_NOTE(input.strandedHead) : ""),
      );
      const r = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.needsInfo],
      );
      requireFlip(r, n);
      if (input.hasCommits) return { kind: "pushed" };
      if (reclaim.kind === "preserved") return keptForPreservedClone(reclaim.reason);
      // Nothing was written this sandbox cycle, so drop the local branch:
      // ensureIssueBranch reuses an existing branch verbatim, and keeping an
      // empty one would pin the next run (after the human supplies the
      // prototype) to a stale origin tip.
      //
      // The off-branch case returned above because its clone is evidence that
      // must outlive the handoff. For an ordinary empty attempt, `-d` refusing
      // is not permission to force: it also refuses when the
      // local source branch merely trails the origin tip we seeded from. And
      // `hasCommits` is per-sandbox-cycle, not per-branch — a HARD-ERROR retry
      // restarts the cycle with an empty commit list while the previous
      // attempts' commits are still on the branch, as does a branch left by an
      // interrupted earlier run. So escalate to `-D` only once the branch is
      // *verified* to contain nothing that isn't already on origin; otherwise
      // keep it and report the failure. The other force-deleting arms own that
      // certainty by construction (the merger just landed the work, or the
      // silent-noop path deliberately discards it) — this one does not.
      const d = await adapter.deleteBranch(input.issue.branch);
      if (d.ok) return { kind: "deleted-local" };
      if (!(await adapter.branchIsContainedInOrigin(input.issue.branch))) {
        return {
          kind: "kept-branch",
          reason:
            `${d.error ?? "branch -d refused"} — kept: it carries commits that ` +
            `are not on origin (an earlier attempt's work), and this handoff ` +
            `did not push it.`,
        };
      }
      const f = await adapter.forceDeleteBranch(input.issue.branch);
      return f.ok
        ? { kind: "deleted-local" }
        : { kind: "delete-failed", error: f.error ?? d.error ?? "" };
    }
    case "needs-human": {
      const n = issueNumberOf(input.issue);
      await adapter.reclaimIssueClone(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      // #17: name the real blocker. uncommittable-worktree → the dirty paths, and
      // say that no gate ran; off-branch-head → where HEAD went and how to
      // rescue the commits (#27); gate-red → the gate failure trace.
      // A switch rather than the ternary chain this used to be: one arm per
      // cause, so a cause added to the union without a template here is a
      // compile error instead of the generic gate-red comment silently.
      const body = ((): string => {
        switch (input.cause) {
          case "reviewer-harness-failed":
            return NEEDS_HUMAN_REVIEWER_HARNESS_COMMENT_TEMPLATE(
              input.issue.branch,
              input.failureTrace,
              // An earlier round's real report, when there was one (#41). It is
              // rendered as an earlier round's, never as the blocker — but
              // dropping it would lose the only review this branch ever got,
              // exactly as the reader is told to review it themselves.
              input.latestReviewerProse,
              labels.agentStuck,
              READY_FOR_AGENT_LABEL,
            );
          case "uncommittable-worktree":
            return NEEDS_HUMAN_UNCOMMITTABLE_COMMENT_TEMPLATE(
              input.issue.branch,
              input.failureTrace,
              labels.agentStuck,
              READY_FOR_AGENT_LABEL,
            );
          case "off-branch-head":
            return (
              NEEDS_HUMAN_OFF_BRANCH_COMMENT_TEMPLATE(
                input.issue.branch,
                input.failureTrace,
                labels.agentStuck,
                READY_FOR_AGENT_LABEL,
              ) +
              (input.strandedHead ? STRANDED_COMMITS_NOTE(input.strandedHead) : "")
            );
          case "gate-red":
            return NEEDS_HUMAN_COMMENT_TEMPLATE(
              input.issue.branch,
              input.failureTrace,
              labels.agentStuck,
              READY_FOR_AGENT_LABEL,
            );
          case "no-signal-exhausted":
            return NEEDS_HUMAN_NO_SIGNAL_COMMENT_TEMPLATE(
              input.issue.branch,
              input.failureTrace,
              labels.agentStuck,
              READY_FOR_AGENT_LABEL,
            );
        }
      })();
      await adapter.postComment(
        n,
        body +
          (input.qualityBudgetExhausted === null
            ? ""
            : `\n\nThe \`maxQualityRounds\` budget ran out at ` +
              `${input.qualityBudgetExhausted} consecutive quality failures.`),
      );
      const r = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.agentStuck],
      );
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "quota": {
      const n = issueNumberOf(input.issue);
      await adapter.reclaimIssueClone(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      const reset = input.resetsAt === undefined
        ? "an unknown time"
        : new Date(input.resetsAt * 1000).toISOString();
      await adapter.postComment(
        n,
        `**Sandbar:** The \`${input.provider}\` subscription quota window ` +
          `\`${input.window}\` closed; it resets at ${reset}. The branch ` +
          `\`${input.issue.branch}\` was pushed. This issue remains ` +
          `\`ready-for-agent\` for the next run.`,
      );
      return { kind: "pushed" };
    }
    case "review-budget-exhausted": {
      const n = issueNumberOf(input.issue);
      await adapter.reclaimIssueClone(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      await adapter.postComment(
        n,
        REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE(
          input.issue.branch,
          input.budget,
          input.roundsUsed,
          input.latestReviewerProse,
          labels.agentStuck,
          READY_FOR_AGENT_LABEL,
        ),
      );
      const r = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.agentStuck],
      );
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "read-only-agent-wrote": {
      const n = issueNumberOf(input.issue);
      // Keep the clone: uncommitted read-only-agent writes cannot travel through a
      // push, and deleting it would destroy the evidence this terminal exists
      // to hand to a human. Reclaiming still publishes the branch first, which
      // is what the push below reads.
      await reclaimClone(input, adapter);
      let pushFailure: string | null = null;
      try {
        await adapter.pushBranch(input.issue.branch);
      } catch (err) {
        pushFailure = err instanceof Error ? err.message : String(err);
      }
      await adapter.postComment(
        n,
        `${BOT_COMMENT_PREFIX} stopped because the read-only ${input.actor} changed the issue repository. ` +
          `The write is contained to this issue and its managed clone has been preserved for human inspection.` +
          (pushFailure === null
            ? ""
            : ` The changed branch could not be pushed (${pushFailure}); inspect the preserved clone for the authoritative state.`) +
          `\n\n${input.latestReviewerProse}`,
      );
      const r = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.agentStuck],
      );
      requireFlip(r, n);
      return { kind: pushFailure === null ? "pushed" : "parked-local" };
    }
    case "hard-error": {
      const reclaim = await adapter.reclaimIssueClone(input.issue.branch);
      if (input.hasCommits) {
        await adapter.pushBranch(input.issue.branch);
        // A preserved clone may hold commits the push did not carry (the
        // reason says so when the publish is what failed); name it rather than
        // report a plain push.
        return reclaim.kind === "preserved"
          ? {
              kind: "kept-branch",
              reason: `pushed the cache's copy of the branch and kept the issue clone (${reclaim.reason})`,
            }
          : { kind: "pushed" };
      }
      if (reclaim.kind === "preserved") return keptForPreservedClone(reclaim.reason);
      const r = await adapter.deleteBranch(input.issue.branch);
      return r.ok
        ? { kind: "deleted-local" }
        : { kind: "delete-failed", error: r.error ?? "" };
    }
    case "fresh-attempt": {
      // Same shape as `merged`: worktree first, then branch (with `-D`
      // fallback because the silent-noop branch has commits that aren't on
      // the source branch and `-d` would refuse). No push, no comment, no
      // label flip — the issue stays `ready-for-agent` while its ongoing unit
      // reacquires a pool slot.
      await adapter.reclaimIssueClone(input.issue.branch);
      return deleteBranchForcing(adapter, input.issue.branch);
    }
    case "silent-noop-exhausted": {
      const n = issueNumberOf(input.issue);
      await adapter.reclaimIssueClone(input.issue.branch);
      // The branch from the final silent-noop attempt was already deleted by
      // the merger (we don't push it for human inspection because the work
      // didn't survive the abort). Best-effort delete in case anything's
      // left, but the primary side-effect is the comment + label flip.
      const r = await adapter.deleteBranch(input.issue.branch);
      if (!r.ok) await adapter.forceDeleteBranch(input.issue.branch);
      await adapter.postComment(
        n,
        SILENT_NOOP_EXHAUSTED_COMMENT_TEMPLATE(input.attempts),
      );
      const r2 = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.agentStuck],
      );
      requireFlip(r2, n);
      return { kind: "deleted-local" };
    }
  }
}

export async function finalizeAll(
  inputs: readonly FinalizeInput[],
  adapter: FinalizeAdapter,
  labels: LabelConfig,
): Promise<readonly FinalizeResult[]> {
  const results: FinalizeResult[] = [];
  for (const input of inputs) {
    const action = await finalizeOne(input, adapter, labels);
    results.push({ input, action });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Real adapter — shells out to git and gh.
// ---------------------------------------------------------------------------

export type RealFinalizeAdapterDeps = {
  // Every GIT call below runs in `layout.repoDir`, the bare cache (#38) —
  // including the `git branch -d`/`-D` pair, which is the reason that matters.
  // The worktree path it removes still comes from `layout.worktreesDir`, which
  // is BESIDE the cache rather than inside it. The `gh` calls pass no cwd at
  // all since #34: they name the repository with `--repo`, so no directory is
  // consulted and none can be wrong.
  readonly layout: RepoLayout;
  // The tracker the comment/label/state calls address. NAMED, never inferred
  // from the cache's git remotes (#34): these are the writes that hand an issue
  // to a human, and a `gh` that resolved the repository from a directory would
  // post them wherever that directory's `origin` pointed.
  readonly repo: RepoRef;
  // Needed by branchIsContainedInOrigin: issue branches are seeded from
  // origin/<sourceBranch>, so that ref is what "already preserved" means here.
  //
  // Since #61 that is not the only seed — a chained chunk member is cut from
  // `origin/<chunk branch>` — and this check does not know about the second
  // one. It reads conservatively (false ⇒ keep the branch), so the cost is a
  // kept branch and an error line saying it "carries commits that are not on
  // origin (an earlier attempt's work)" about commits that are on origin, on
  // the chunk branch. Narrow: it needs a chunk member reaching the one arm that
  // asks — a NEEDS-UI-PROTOTYPE handoff whose `branch -d` refused. Fixing it
  // means threading the chunk into this adapter, which is #60's shape, not the
  // seeding change's.
  readonly sourceBranch: string;
};

export function realAdapter(deps: RealFinalizeAdapterDeps): FinalizeAdapter {
  const cwd = deps.layout.repoDir;
  return {
    async pushBranch(branch) {
      // Required: the whole point of the non-merged terminals is to hand the
      // branch to a human. If the push fails we must NOT report success and
      // move on (the #8 class of bug) — fail loud.
      try {
        await exec("git", ["push", "origin", `${branch}:${branch}`], { cwd });
      } catch (err) {
        throw new SandbarError(
          `Failed to push branch '${branch}' to origin: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
    async deleteBranch(branch) {
      try {
        await exec("git", ["branch", "-d", branch], { cwd });
        return { ok: true };
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const msg = (e.stderr ?? "").trim() || e.message || String(err);
        return { ok: false, error: msg };
      }
    },
    async forceDeleteBranch(branch) {
      try {
        await exec("git", ["branch", "-D", branch], { cwd });
        return { ok: true };
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const msg = (e.stderr ?? "").trim() || e.message || String(err);
        return { ok: false, error: msg };
      }
    },
    async branchIsContainedInOrigin(branch) {
      // Exit 0 iff the branch tip is an ancestor of (or equal to) the origin
      // tip — every commit on it is already published. Exit 1 answers false;
      // other failures propagate because they do not establish non-containment.
      try {
        await exec(
          "git",
          [
            "merge-base",
            "--is-ancestor",
            branch,
            `origin/${deps.sourceBranch}`,
          ],
          { cwd },
        );
        return true;
      } catch (err) {
        if (!isExitCode(err, 1)) throw err;
        return false;
      }
    },
    async reclaimIssueClone(branch, keep) {
      const path = worktreePathFor(deps.layout.worktreesDir, branch);
      const reclaim = await reclaimIssueClone(cwd, path, branch, keep);
      if (reclaim.kind === "preserved") {
        console.error(`Issue clone preserved at ${path}: ${reclaim.reason}`);
      }
      return reclaim;
    },
    async postComment(issueNum, body) {
      // Required: the comment is the issue's handoff payload (questions, failure
      // trace, reviewer prose). A silently-dropped comment strands the human
      // without the context they need — fail loud.
      try {
        await exec("gh", [
          "issue",
          "comment",
          String(issueNum),
          "--repo",
          repoSlug(deps.repo),
          "--body",
          body,
        ]);
      } catch (err) {
        throw new SandbarError(
          `Failed to post comment on issue #${issueNum}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
    async editLabels(issueNum, remove, add) {
      // Two separate `gh issue edit` calls, remove FIRST. A single combined
      // edit is atomic: if any --add-label target doesn't exist, gh rejects the
      // whole command and the --remove-label never applies — leaving the issue
      // on the agent queue forever. Removing first guarantees the queue-removal
      // lands even when the handoff label is missing/misconfigured (#8).
      const ghEdit = async (flag: "--remove-label" | "--add-label", labelsToApply: readonly string[]): Promise<string | undefined> => {
        if (labelsToApply.length === 0) return undefined;
        const args = [
          "issue",
          "edit",
          String(issueNum),
          "--repo",
          repoSlug(deps.repo),
        ];
        for (const l of labelsToApply) args.push(flag, l);
        try {
          await exec("gh", args);
          return undefined;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      };

      const removeErr = await ghEdit("--remove-label", remove);
      const addErr = await ghEdit("--add-label", add);
      if (!removeErr && !addErr) return { ok: true };

      // Return the failure structured rather than logging-and-swallowing: a
      // required-handoff caller turns this into a loud SandbarError (requireFlip),
      // while the benign `merged` caller (#7 cosmetic cleanup on a closed issue)
      // ignores it.
      const parts: string[] = [];
      if (removeErr) parts.push(`remove [${remove.join(",")}]: ${removeErr}`);
      if (addErr) parts.push(`add [${add.join(",")}]: ${addErr}`);
      return { ok: false, error: parts.join("; ") };
    },
    async issueState(issueNum) {
      // Required precondition for the handoff guard (#16): if we can't read the
      // issue's state we don't guess — fail loud rather than risk stamping a
      // closed issue or skipping a live handoff. `gh issue view` works on
      // closed issues too.
      try {
        const { stdout } = await exec("gh", [
          "issue",
          "view",
          String(issueNum),
          "--repo",
          repoSlug(deps.repo),
          "--json",
          "state",
        ]);
        const parsed = JSON.parse(stdout) as { state?: string };
        return parsed.state === "CLOSED" ? "CLOSED" : "OPEN";
      } catch (err) {
        throw new SandbarError(
          `Failed to read state of issue #${issueNum} before finalising: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
    async issueLabels(issueNum) {
      try {
        const { stdout } = await exec("gh", [
          "issue", "view", String(issueNum), "--repo", repoSlug(deps.repo),
          "--json", "labels", "--jq", ".labels[].name",
        ]);
        return stdout.split("\n").map((label) => label.trim()).filter(Boolean);
      } catch (err) {
        throw new SandbarError(
          `Failed to read labels of issue #${issueNum} after finalising: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
  };
}
