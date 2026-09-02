// Procedural merger — lands DONE branches on the source branch (or, for a
// review-gated issue, on its chunk's branch — see "Two landing targets"), with
// an agentic resolve loop covering conflict, post-merge gate-red, and (in
// verified mode) a red forge.
//
// The merger runs in a dedicated, ephemeral worktree checked out (detached) at
// `origin/<sourceBranch>` — NOT the operator's primary checkout (issue #10).
// run.ts creates that worktree and points this adapter's `cwd` at it, so the
// operator's uncommitted edits (and local-only commits) are physically absent
// from the merge surface: they can never be staged into a merge commit, in the
// clean path or the conflict-resolution path. The merge result is pushed to
// `origin/<sourceBranch>` (how, exactly, depends on the landing mode below);
// the operator's local branch is left untouched (it catches up on the next
// `git pull`, matching how issue branches already seed from origin).
//
// After phase 2 the orchestrator hands DONE branches to runMerger, which
// iterates them in ascending issue-number order and, for each:
//
//   preMergeSha = HEAD                   — for safe revert on abandon
//   git merge --no-ff <branch>
//     conflict   → runResolveLoop({conflict, ...}, cycleIssues)
//                  abandon  → merge --abort OR reset --hard preMergeSha + skip
//                  resolved → fall through to merged.push (loop already gated)
//     clean      → npm install
//                    fail  → reset --hard preMergeSha + skip (unchanged)
//                  → runGate
//                    green → merged.push
//                    red   → runResolveLoop({gate-red, ...}, cycleIssues)
//                            abandon  → reset --hard preMergeSha + skip
//                            resolved → merged.push (loop already gated)
//
// The resolve loop loads the bodies of *all* other issues in this cycle so the
// agent can reason about "branch B's intent collides with branch A — abandon
// B" instead of being stuck inside a single-issue context.
//
// ---------------------------------------------------------------------------
// Two landing targets (#60, §2–3 of the design in #54)
// ---------------------------------------------------------------------------
//
// A DONE branch lands on the source branch unless its issue carries a CHUNK
// (`IssueRef.chunk`, put there by the planner), in which case it lands on that
// chunk's branch — `sandbar/chunk-<root>-<slug>`, created at
// `origin/<sourceBranch>` the first time a member lands on it. Everything
// between the two paths is the same code: same ephemeral worktree, same
// per-issue `merge --no-ff`, same resolve loop with the same sibling issue
// bodies, same gate-2 on the composition, same `preMergeSha` revert on
// abandon. The only differences are what the worktree is detached at, where
// the result is pushed, and what the issue is told afterwards.
//
// CHUNKS ARE LANDED FIRST, and the worktree is put back at the sha it entered
// on before the source-branch pass. Order matters for one reason: the
// source-branch pass ends in the landing (direct push, or the whole verified
// dance), and that is the moment after which `merged: []` in a partial would
// be a lie — see `landed`. Running the chunk groups before it keeps that
// argument exactly as it was, and gives the chunk pushes their own place in
// the partial (`chunkLanded`), which run.ts finalises on a halt just as it
// finalises `skipped`.
//
// The chunk push is DIRECT in both merge modes, and that is a decision rather
// than an omission. `mergeMode: verified` (#22) exists so the forge has the
// last word on what reaches the SOURCE branch; a chunk branch reaches a human,
// whose review is the gate the review lane is asking for, and the forge gets
// its say when the reviewed chunk lands on the source branch. Making CI a
// precondition for showing a human the work would gate a review on a verdict
// about a tree nobody has agreed to yet.
//
// The base is ORIGIN's chunk branch when it has one, never a local ref:
// nothing in the state directory is authoritative, and a chunk branch outlives
// the run that started it, so origin is the only place its history is safe.
// That base is deliberately NOT re-merged with a moved source branch — a chunk
// is reviewed as one unit against the tree it was cut from, and reconciling it
// with the source branch is part of landing the chunk, not of growing it.
//
// EVERY CHUNK PUSH IS FOLLOWED BY A DRAFT PULL REQUEST (#62), created or
// updated, chunk → source branch: the branch is where the work is, the PR is
// where a human reviews it, and the review lane produces nothing anyone can act
// on without it. After the push and after the `chunkLanded` entries, in that
// order — a PR is a handle on commits origin has, and a failure to open one
// must not take a durable landing down with it. What it says is `chunk-pr.ts`;
// the `gh` create-or-update is `forge-pr.ts`; that it is a DRAFT is the
// mechanism disabling GitHub's merge button while leaving review intact, and
// sandbar never un-drafts one a human made ready.
//
// A failure to open it HALTS, like every other tracker write in this loop. The
// landing survives in the partial (those issues are on origin and still owe
// `needs-review`), so what the halt costs is the cycle, and what carrying on would
// cost is a chunk branch growing under a human who was never shown it.
//
// ---------------------------------------------------------------------------
// The third landing: a reviewed CHUNK onto the source branch (#64)
// ---------------------------------------------------------------------------
//
// A human puts `land` on a chunk's pull request; the next cycle merges
// `origin/<chunkBranch>` onto the source branch in the SAME pass as the auto
// lane's DONE branches, before them, and the cycle's one landing carries both.
// `chunk-land.ts` owns the label, the prose and the wrap-up; this file owns
// only what the merge loop does with them.
//
// Sharing the source pass rather than building a second one is the whole
// design. The reviewed chunk and this cycle's fresh branches end up in one
// composition, so gate-2 judges what a human will actually get, verified mode
// asks the forge about it once, and there is no window in which the chunk is on
// the source branch and the cycle's issues are not. It is also why
// `attemptMerge` exists: the merge, the resolve loop, the gate and the revert
// are identical for an issue branch and a chunk branch, and only the tracker
// half — `ready-for-agent` on an issue, `land` on a pull request — differs.
//
// CHUNKS FIRST inside that pass, because their commits are the older ones: they
// were cut from a source branch that has since moved, and a review already said
// yes to them. Fresh work merges on top.
//
// The failure classing follows the same rule as everything else here, read
// through the label-as-queue: a merge the resolve loop could not save is the
// chunk's own problem, so `land` comes off and the pull request says why (a
// label left on would retry that same failing merge every cycle forever). A
// push race, a forge verdict that never arrived, a `gh` that could not be
// reached, an ORIGIN that could not be reached — none of those is a fact about
// the chunk, so the label stays and the next run tries again. Nothing lands and
// nothing is closed in either case.
//
// That last one is why `fetchChunkRef` answers in three states instead of two
// (`ChunkRefLookup`). "Origin has no such branch" is a fact about the chunk and
// parks it; "origin could not be asked" is not, and reading one as the other
// would take a human's `land` label off and tell them their branch had been
// deleted because a proxy dropped a connection.
//
// And one request is honoured by NOT acting on it: a chunk PHASE A JUST GREW.
// Since #61 a whole layer of a chunk plans per cycle, so a member can reach
// the chunk branch minutes after the label was read — and the label was a
// human's yes to the pull request as it stood. Landing then would put commits
// on the source branch that no review covered, and close only the members the
// plan knew about while deleting the branch the rest live on. So the request is
// DEFERRED: nothing merges, `land` stays, the PR says what arrived, and the
// next cycle that adds nothing new lands the chunk. `deferredChunks` reports
// it; it is neither a landing nor a park.
//
// The WRAP-UP runs only after the source branch has moved: close every member
// ON THE BRANCH explicitly (the git-derived ones — a component member that was
// never worked has no commits here and must not be closed; and no `Closes #N`
// will ever fire, since GitHub honours those on its own merge of that pull
// request and sandbar composed this one locally), drop `needs-review`, close the
// PR, delete the chunk branch on origin. It cannot throw,
// by construction: it is entirely inside the post-`landed` window, where a
// wrapped throw would report `merged: []` against a source branch that moved.
// What it could not finish comes back as `ChunkWrapup.residue`, the chunk branch
// is kept when it is non-empty, and the next run's reconciler picks up exactly
// the writes that failed.
//
// After all branches processed, the cycle's merge result is LANDED. Two modes
// (config.mergeMode, #22):
//
//   direct   — the default and today's behaviour: a single
//              `git push origin HEAD:<sourceBranch>`. On a push race
//              (rejected/non-fast-forward), one retry via `git pull --ff-only`
//              then push again; pull-conflict is a hard fail.
//
//   verified — nothing reaches the source branch until the FORGE agrees. The
//              merge result goes to a scratch integration branch, sandbar polls
//              that sha's check runs, and only a green verdict earns the
//              fast-forward push to <sourceBranch>. Red feeds the failing job
//              logs to the resolve loop for a bounded number of rounds. The
//              mechanics live in forge-verify.ts; runMergerWithAdapter owns
//              only what happens to the ISSUES when it fails.
//
// A failed verification is a CYCLE-level outcome, not a per-issue one: the
// forge judged the composed result, and there is no sound way to attribute the
// red to one of several merges that each passed the local gate individually. So
// the whole cycle is reverted to the sha the merger worktree started at,
// `merged` comes back empty, and every issue that had merged is parked under
// `forge-unverified` with a comment saying so — including the possibility that
// it wasn't its fault. Heavy-handed on purpose: the alternative is landing an
// unverified sha, which in the consuming repo means deploying it.
//
// Every throw that can follow a tracker write is a `MergerError` (#33). The
// loop writes as it goes — a branch it cannot land is commented on and stripped
// of `ready-for-agent` on the spot, while applying the handoff label is Phase
// 4b's job — so from the first skip onward there are issues sitting on no queue
// at all until finalise runs. `MergerError.partial` is the only thing that
// survives a halt, and run.ts reaches it through `instanceof MergerError`, so a
// raw `SandbarError` out of `getIssueBody` (which throws by design), a raw
// throw out of `runGate` (#24 D5: a dead issue-lifecycle container is infra,
// not a red), or a raw ENOSPC out of the log sink would leave every issue
// parked earlier in the cycle commented, un-queued and unlabelled. Wrapping is
// not absorbing: the run still halts loud, the message still names the
// underlying failure, and the original error rides along as `cause`.
//
// Two exclusions, both deliberate. Throws BEFORE the first write (a malformed
// issue id out of `sortIssuesAsc`, the opening `getHeadSha`) are left raw —
// there is nothing to carry, and the top-level handler prints a stack this
// branch does not. Throws AFTER the cycle lands are left raw for the opposite
// reason: a partial claiming `merged: []` would then be false, and a partial
// that lies is worse than none. `landed` in runMergerWithAdapter is the line
// between them.
//
// Each surviving merge → `gh issue close <n>`. The close runs AFTER the
// irreversible push, so a transient gh/network blip on it must not strand the
// merged work (issue #14): the close is retried with backoff, and the loop is
// fault-tolerant — it attempts every merged issue and accumulates the ones that
// could not be closed into `MergerSummary.unclosed` rather than throwing on the
// first failure. The orchestrator still runs Phase 4 (label drop + branch
// cleanup) for every merged issue, then halts loud on a non-empty `unclosed`
// list so the operator can close those issues by hand. Dropping the queue label
// is finalise's job, NOT the close's — an un-closed issue is left OPEN but
// de-queued, so the planner never re-picks already-landed work.
//
// Merge commits and agent-authored commits inside the loop are attributed to
// the configured bot identity with a co-author trailer.
//
// ---------------------------------------------------------------------------
// What a resolve attempt leaves behind (#67)
// ---------------------------------------------------------------------------
//
// This file owns the two ENDS of that: the invocation, and the prose.
//
// `runResolveAgent` runs the configured provider in a NAMED, run-scoped
// container. The same provider object owns its argv and line parser; credential
// keys come from `PROVIDER_CREDENTIALS`, so no vendor detail is re-spelled here.
// `captureAgentRun` keeps both raw streams for the byte-verbatim attempt log,
// then `parseCapturedAgentRun` puts only parsed agent speech in the output
// register that the resolve promise parser may read. It answers with the exit
// code, signal, duration and container name too. Before, stderr was piped to a listener
// that was never attached and stdout was returned to the token parser and
// dropped, so a container that died at startup was indistinguishable from an
// agent that said nothing, and the four attempts of one abandoned merge left
// five log lines between them. `captureAgentRun` is the seam that does it; the
// classification and the pipe-drain deadline are its header's.
//
// `buildAbandonComment` is the other end, and the reason all of it is carried:
// that comment is the only artefact a human reads when they find a stuck issue
// in the morning. It now names the conflicted paths, what each attempt did and
// where its output was written — enough to tell a hard conflict from a broken
// container without reading this file. `chunk-land.ts`'s parked-chunk comment
// carries the identical block, from the same renderer, because a reviewer
// standing at a pull request is asking the same question.
//
// What HALTS is resolve-loop.ts's decision, not this file's: an attempt that
// captured nothing throws out of the loop, and it arrives here as any other
// internal failure does — wrapped by `asHalt` into a `MergerError` carrying
// the partial, so the issues this cycle already commented on still reach Phase
// 4 (#33). For a chunk, the label policy of #64 gives the same answer for free:
// a host that could not run a container has said nothing ABOUT the chunk, so
// `land` stays on and the next run tries again.
//
// ---------------------------------------------------------------------------
// The conflict the agent is never asked about (#68)
// ---------------------------------------------------------------------------
//
// AGENTS.md makes every commit move `version` in `package.json` and its two
// mirrors in `package-lock.json`, so two branches landing in one cycle conflict
// in those files BY CONSTRUCTION — every multi-landing cycle, not occasionally.
// `resolveVersionCollision` settles it before `runResolveLoop` is called, and
// only what it could not finish reaches the agent. It is the one conflict in
// the tree whose answer is not a judgement call, and the answer an agent
// re-derives from an expensive bounded budget is one neither side carries:
// `max(ours, theirs)` bumped once.
//
// The scope is `version-conflict.ts`'s to state and is deliberately narrow —
// per file, and only when every hunk in it is a lone version line AND the two
// reconstructed sides differ at nothing but the paths npm mirrors. Everything
// else in those files still goes to the agent untouched, which is why
// `prompts/resolve-conflict.md` states the same `max + 1` rule for the case it
// still sees.
//
// Two things this must not do, both already owned elsewhere. It does not make
// the lockfile consistent — `npmInstall` against the merged tree does that, on
// the clean path this merge now falls through to. And it does not decide
// anything about the merge: when it resolves every conflicted path it commits
// the merge git already prepared, and the caller carries on into `npm install`
// + gate, so a mechanically-resolved merge and a clean one are the same code
// from there on. Everything it did is in the merger log, including a version
// file it looked at and declined.

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import {
  CHUNK_BRANCH_MISSING_PR_COMMENT,
  CHUNK_LAND_DEFERRED_PR_COMMENT,
  CHUNK_LAND_FORGE_UNVERIFIED_PR_COMMENT,
  CHUNK_LAND_ABANDONED_PR_COMMENT,
  type ChunkLandTarget,
  type ChunkWrapup,
  LAND_LABEL,
  chunkForgeWrites,
  wrapUpLandedChunk,
} from "./chunk-land.js";
import { chunkMembersOnBranch, chunkPullRequestContent } from "./chunk-pr.js";
import type { ChunkMember, ChunkTarget } from "./chunks.js";
import { type EnvReader } from "./env.js";
import {
  buildAgentProvider,
  PROVIDER_CREDENTIALS,
  type AgentProviderName,
} from "./agent-providers.js";
import {
  createAgentSpeechAccumulator,
  type AgentProvider,
} from "./agent-sandbox.js";
import { SandbarError } from "./errors.js";
import { type PullRequestRef, ensurePullRequest } from "./forge-pr.js";
import { dirtyWorktreePaths, fetchOriginChunkBranch } from "./git-ops.js";
import {
  type Clock,
  type VerifiedFailureReason,
  type VerifiedLandingOptions,
  type VerifyAdapter,
  runVerifiedLanding,
} from "./forge-verify.js";
import type { GateResult } from "./gate.js";
import { fetchIssueText } from "./issue-anchor.js";
import { gitMountsForWorktree } from "./merger-worktree.js";
import { type RunScope, scopedResourcePrefix } from "./naming.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";
import { RUNTIME } from "./runtime.js";
import {
  RESOLVE_AGENT_TIMEOUT_MS,
  type ResolveAdapter,
  type ResolveAgentRun,
  type ResolveAttemptRecord,
  type ResolveAttemptSink,
  type ResolveAttemptSummary,
  type ResolveLogger,
  SOURCE_TARGET_PHRASE,
  formatConflictPaths,
  formatResolveAttempts,
  runResolveLoop,
} from "./resolve-loop.js";
import {
  isVersionConflictFile,
  planVersionCollision,
  renderVersionResolution,
} from "./version-conflict.js";

// `failedStep` is a free-form step name since #24 — it comes from the
// consumer's `gateStack.steps`, or is one of sandbar's own pseudo-steps
// (`worktree-clean`, `container:<name>`, `image:<tag>`). It is a label in a
// trace, never branched on.
export type MergerGateOutput = {
  readonly stdout: string;
  readonly stderr: string;
  readonly failedStep: string | null;
  readonly exitCode: number;
  // Carried separately from stdout/stderr all the way to the resolve agent, so
  // the cascade collapse only ever sees step output (see GateResult).
  readonly containerLogs: string;
};

const exec = promisify(execFile);

// The exit status of a failed `exec`, or null when there is none to read — a
// spawn that never got as far as an exit rejects with a string `code` (ENOENT)
// instead. Distinguishing one non-zero exit from another is how a git command
// with documented statuses (`ls-remote --exit-code`) is used as an answer
// rather than as a yes/no.
const exitCodeOf = (err: unknown): number | null => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
};

// What a failed git command said, for an operator to read in a halt message.
// stderr first: git's own diagnosis of why it could not reach a remote is the
// whole content, and `execFile`'s message is the command line around it.
const gitFailureDetail = (err: unknown): string => {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
  if (stderr) return stderr;
  return typeof e?.message === "string" ? e.message : String(err);
};

export const READY_FOR_AGENT_LABEL = "ready-for-agent";

// What a branch was being merged INTO, for the prose that has to name it (#60).
// Every comment the merge loop writes used to say "the source branch", which is
// simply false on a chunk member: nothing of its work is heading there yet, and
// an author sent to look for it on main would not find it.
export type MergeTarget =
  | { readonly kind: "source" }
  | { readonly kind: "chunk"; readonly branch: string };

export const SOURCE_TARGET: MergeTarget = { kind: "source" };

// The noun phrase that names it. The source-branch wording is
// `SOURCE_TARGET_PHRASE` rather than a literal here: the resolve prompt already
// had to name a target before chunks existed, and one phrase written twice is
// two prompts that can come to disagree about what they are describing.
function describeMergeTarget(target: MergeTarget): string {
  return target.kind === "source"
    ? SOURCE_TARGET_PHRASE
    : `its chunk's branch \`${target.branch}\``;
}

export function buildInstallFailedComment(target: MergeTarget): string {
  return (
    `Sandbar merged this branch into ${describeMergeTarget(target)} locally, but \`npm install\` against ` +
    "the merged tree failed — the post-merge gate could not run. The merge has been " +
    "reverted and `ready-for-agent` removed; please investigate the dependency change " +
    "before re-labelling."
  );
}

// The one artefact a human reads when they find a stuck issue in the morning,
// which is why it says so much more than it used to (#67). Before, it named no
// conflicted file, no timing, no agent output and no log path — so "bailed
// after 4 attempts" read identically whether four agents had genuinely failed
// at a hard conflict or one had timed out and three containers had died at
// startup in eleven seconds. The two want completely different things done
// about them.
function buildAbandonComment(args: {
  mode: "conflict" | "gate-red";
  reason: string;
  // The loop's own journal. Its LENGTH is the attempt count in the lede —
  // `RESOLVE_MAX_ATTEMPTS` was a claim about the budget, not about what ran,
  // and an abandon can now leave the loop early.
  attempts: readonly ResolveAttemptSummary[];
  conflictPaths: readonly string[];
  target: MergeTarget;
}): string {
  const where = describeMergeTarget(args.target);
  const n = args.attempts.length;
  const plural = n === 1 ? "" : "s";
  const lede =
    args.mode === "conflict"
      ? [
          `Sandbar attempted to merge this branch into ${where} and the agentic resolve loop bailed after ${n} attempt${plural}.`,
          "The merge has been aborted and `ready-for-agent` removed.",
        ]
      : [
          `Sandbar merged this branch into ${where} locally, but the post-merge gate was still red after ${n} agentic fix attempt${plural}.`,
          "The merge has been reverted and `ready-for-agent` removed.",
        ];
  return [
    ...lede,
    "",
    `Agent's reason: ${args.reason}`,
    ...blockIfAny(formatConflictPaths(args.conflictPaths)),
    "",
    "**What each attempt did:**",
    formatResolveAttempts(args.attempts),
  ].join("\n");
}

// A section, or nothing at all — never an empty heading. Used for the
// conflicted-path list, which a gate-red abandon legitimately has none of.
function blockIfAny(section: string): string[] {
  return section ? ["", section] : [];
}

// Verified merge mode (#22). The forge rejected the cycle's composed merge
// result, so nothing landed and every issue in that result is parked. The
// comment says plainly that this issue may not be the one at fault — a human
// reading it on issue #7 needs to know the failure could belong to #9.
export function buildForgeUnverifiedComment(args: {
  readonly detail: string;
  // What actually went wrong. The lede is written from this, because three of
  // the four reasons are not "the checks rejected your code": on `source-moved`
  // the checks PASSED and the cycle was dropped over a race, and on
  // `checks-timeout` nothing was rejected either. Telling an author their build
  // failed when it went green sends them to read a passing log for a fault that
  // isn't there.
  readonly reason: VerifiedFailureReason;
  readonly siblings: readonly IssueRef[];
  readonly integrationBranch: string;
  readonly sourceBranch: string;
  // The sha that was actually verified, when there was one. The comment cites
  // it rather than the integration BRANCH, because that branch is force-pushed
  // by the next cycle — a human reading this comment tomorrow would follow the
  // ref to someone else's result. The sha keeps its check runs forever.
  readonly verifiedSha: string | null;
  // True when the resolve loop committed fixes during verification. Those
  // commits live only on the reverted merge result and are NOT on the issue
  // branch that is about to be handed over, so the comment has to say so —
  // otherwise the agent's work silently evaporates.
  readonly hasResolveCommits: boolean;
}): string {
  const cause: Record<VerifiedFailureReason, string> = {
    "checks-red":
      "the forge's checks rejected the cycle's composed merge result",
    "checks-timeout":
      "the forge's checks never concluded on the cycle's composed merge result " +
      "(nothing was rejected — the verdict simply never arrived)",
    "source-moved":
      `the forge's checks PASSED, but \`${args.sourceBranch}\` moved before the result ` +
      "could be landed and there were no rounds left to re-verify the re-merged " +
      "result (this is a race, not a fault in the code)",
    "resolve-abandon":
      "the forge's checks were red and sandbar's resolve agent gave up on fixing them",
  };
  const lines = [
    "Sandbar merged this branch into the source branch locally and the post-merge " +
      `gate passed, but ${cause[args.reason]} — so **nothing was landed on ` +
      `\`${args.sourceBranch}\`** and the merge has been reverted. ` +
      "`ready-for-agent` was removed.",
    "",
    `Verification failure: ${args.detail}`,
    "",
    args.verifiedSha
      ? `The check runs are on commit \`${args.verifiedSha}\` (pushed to \`${args.integrationBranch}\`, ` +
        "a scratch ref the next cycle overwrites — follow the sha, not the branch)."
      : `The result was pushed to \`${args.integrationBranch}\`, a scratch ref the next cycle overwrites.`,
  ];
  if (args.hasResolveCommits) {
    lines.push(
      "",
      "**Sandbar's resolve agent committed fix attempts during verification.** " +
        "Those commits were made on the composed merge result, not on this " +
        "issue's branch, and the revert discarded them — the branch handed back " +
        "here does NOT contain them. They are still reachable from the commit " +
        "above if any of that work is worth recovering.",
    );
  }
  if (args.siblings.length > 0) {
    lines.push(
      "",
      "This cycle merged more than one branch, and the forge judged them " +
        "together, so the failure is not necessarily this issue's fault. The " +
        "other issues in the same merge result were: " +
        args.siblings.map((s) => `#${issueNumberOf(s)}`).join(", ") +
        ". They were reverted and parked too.",
    );
  }
  return lines.join("\n");
}

export type IssueRef = {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
  // The chunk this issue's branch lands on (#60), as the planner derived it.
  // Absent or null ⇒ the auto lane, i.e. the source branch. OPTIONAL rather
  // than required because an `IssueRef` is also built by hand in a dozen places
  // that have nothing to do with landing (finalise inputs, resolve-loop
  // context, tests), and forcing every one of them to write `chunk: null` would
  // spread a phase-3 concern across the codebase without making any of them
  // more correct. The one caller whose answer matters — the plan — always sets
  // it.
  readonly chunk?: ChunkTarget | null;
};

// One thing that can be merged onto the worktree's HEAD. `IssueRef` is
// assignable as-is, which is the point: every issue branch that has ever gone
// through this loop is one of these, and #64 added the other kind — a whole
// CHUNK branch, landing on the source branch after its review.
export type MergeUnit = {
  readonly id: string;
  readonly title: string;
  // What `git merge` is given. An issue branch is local (`sandbar/issue-…`); a
  // chunk is merged from ORIGIN's copy, so this is a remote-tracking ref.
  readonly branch: string;
  // The merge commit's subject. Absent ⇒ the issue shape,
  // `Merge sandbar/issue-<n>: <title>` — which is wrong for anything that is
  // not one issue's branch, so a chunk supplies its own.
  readonly mergeMessage?: string;
};

// What one `attemptMerge` did to the worktree, with the tracker deliberately
// untouched. `install-failed` and `abandon` have both already been reverted.
type MergeAttempt =
  | { readonly kind: "merged" }
  | { readonly kind: "install-failed" }
  | {
      readonly kind: "abandon";
      readonly mode: "conflict" | "gate-red";
      readonly reason: string;
      // The resolve loop's HEAD-advance invariant tripped: the agent claimed
      // success and produced no commit. Only an issue branch does anything
      // different with it (a fresh attempt next cycle); a chunk has no
      // implementer to re-run, so it parks like any other abandon.
      readonly silent: boolean;
      // What the resolve loop actually spent, for the prose the caller writes
      // (#67). Carried through `MergeAttempt` rather than re-derived, because
      // only the loop knows how a container exited and only it can say which
      // paths were still unmerged when it gave up.
      readonly attempts: readonly ResolveAttemptSummary[];
      readonly conflictPaths: readonly string[];
    };

export type PushResult =
  | { readonly kind: "ok" }
  | { readonly kind: "race" }
  | { readonly kind: "fatal"; readonly reason: string };

// What origin has for a chunk branch — THREE answers, because two of them are
// one `git fetch` failure from the outside and are not the same fact (#64).
//
//   * present    — origin has it, and the remote-tracking ref now names it.
//   * absent     — origin was reached and does not have the branch. A fact
//                  about the chunk: there is nothing left to land.
//   * unreadable — origin could not be asked at all. A fact about the network,
//                  the credentials or the proxy, and about nothing else.
//
// The distinction is bought with a second question — see `realAdapter` — and
// it is bought because the LANDING is the one reader that cannot afford the
// cheaper answers. Everything else that asks origin for a chunk branch wants a
// BASE, and a base may be answered with the tip the cache already holds
// (`fetchOriginChunkBranch`, #61): being one run behind composes a branch whose
// push origin then rejects as a non-fast-forward, so it costs a cycle and never
// a ref. A landing merges the answer and then DELETES the branch, so a stale
// tip is commits lost — and `absent` spends a human's `land` label and tells
// them their branch is gone. Being wrong either way is durable, so the
// landing takes neither guess: `unreadable` halts and the label survives to
// the next run.
export type ChunkRefLookup =
  | { readonly kind: "present"; readonly ref: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly detail: string };

// Adapter shape. Split into the merger's own primitives and the resolve-loop
// primitives (which the merger forwards). The real adapter implements both.
export type MergerAdapter = ResolveAdapter & {
  mergeNoFf(unit: MergeUnit): Promise<{ readonly ok: boolean }>;
  abortMerge(): Promise<void>;
  getHeadSha(): Promise<string>;
  resetHardSha(sha: string): Promise<void>;
  commentOnIssue(issueNum: number, msg: string): Promise<void>;
  removeLabel(issueNum: number, label: string): Promise<void>;
  closeIssue(issueNum: number, comment: string): Promise<void>;
  push(): Promise<PushResult>;
  pullFfOnly(): Promise<{ readonly ok: boolean }>;
  // --- the version collision (#68) ---
  // The unmerged set on its own, without the `git status` + `git diff` that
  // `conflictDigest` runs to build the agent's prompt. Asked twice per
  // conflicted merge — once to find the version files, once to learn whether
  // anything is left after they are staged — and the second question is the
  // whole decision between completing the merge here and calling the agent.
  unmergedPaths(): Promise<readonly string[]>;
  // The conflicted file AS GIT LEFT IT, markers and all. Null ⇒ there is no
  // file to read (a modify/delete conflict), which declines rather than
  // throwing: an unreadable candidate is the agent's problem, not a halt.
  readWorktreeFile(path: string): Promise<string | null>;
  writeWorktreeFile(path: string, contents: string): Promise<void>;
  // `git add -- <path>`, which is what marks one conflict resolved.
  stagePath(path: string): Promise<void>;
  // `git commit --no-edit` on the merge git already prepared, so the subject
  // and the co-author trailer `mergeNoFf` passed survive. Answers rather than
  // throws: a merge that cannot be committed still has a resolve loop behind
  // it, and the staged resolution is visible to the agent as staged.
  commitMerge(): Promise<{ readonly ok: boolean }>;
  // --- chunk landing (#60) ---
  // The ref a chunk's members are merged onto: `origin/<chunkBranch>` when
  // origin has that branch, else `origin/<sourceBranch>` — which is where a
  // chunk branch is created. Origin, not a local ref: the chunk branch outlives
  // this run and nothing in the state directory is authoritative.
  chunkBase(chunkBranch: string): Promise<string>;
  // Detach the merger worktree at `ref`. Called to move between landing targets
  // within one cycle; the tree is clean at every call site (a skipped merge has
  // already been reset, and a landed one is committed).
  checkoutDetached(ref: string): Promise<void>;
  // Push HEAD to `refs/heads/<chunkBranch>` on origin. Never forcing: a
  // rejected push means the chunk branch moved under us, so this composition
  // is not built on what is there and overwriting it would drop a member.
  pushChunkBranch(chunkBranch: string, issueBranches: readonly string[]): Promise<PushResult>;
  // Create-or-update the chunk's DRAFT pull request against the source branch
  // (#62) — the review surface the whole review lane exists to produce. Called
  // once per chunk per cycle, AFTER the push, because a PR is a handle on
  // commits that are on origin. Title and body come from `chunk-pr.ts`: the
  // prose is the caller's, the `gh` is the adapter's, as everywhere else here.
  ensureChunkPullRequest(args: {
    readonly chunkBranch: string;
    readonly title: string;
    readonly body: string;
  }): Promise<PullRequestRef>;
  // --- landing a reviewed chunk on the source branch (#64) ---
  // ORIGIN's copy of the chunk branch, as a remote-tracking ref, freshly
  // fetched — or which of the two ways there is none, since the landing spends
  // those differently. See `ChunkRefLookup`. Unlike `chunkBase` this does NOT
  // fall back to the source branch; merging the source branch into itself
  // would be a no-op that closed every member of a chunk whose work is
  // nowhere.
  fetchChunkRef(chunkBranch: string): Promise<ChunkRefLookup>;
  // Delete the chunk branch on origin, once its commits are on the source
  // branch. The last step of the wrap-up and the one that stops the reconciler
  // seeing this chunk again.
  deleteChunkBranch(
    chunkBranch: string,
    memberIssues: readonly number[],
  ): Promise<void>;
  commentOnPullRequest(pr: number, body: string): Promise<void>;
  // Takes `land` back off, which is what stops a request being honoured
  // again. The wrap-up drops it when a chunk lands; the merge loop drops it on
  // its own when one is parked. See `chunk-land.ts` on the label as a queue.
  removePullRequestLabel(pr: number, label: string): Promise<void>;
  closePullRequest(pr: number): Promise<void>;
};

export type SkipReason =
  | "conflict"
  | "gate-red"
  | "install-failed"
  // Verified merge mode (#22): this issue merged cleanly and passed the local
  // post-merge gate, but the cycle's composed merge result failed forge
  // verification, so nothing was landed. Cycle-level, so every issue that had
  // merged carries it — the red is not attributable to one of them.
  | "forge-unverified"
  // Resolve-loop's HEAD-advance invariant tripped: the agent gave up via a
  // silent `git merge --abort` rather than completing the merge. The branch
  // is intact, but no commit landed on the source branch. Orchestrator
  // decides whether to re-enqueue for a fresh implementer attempt (under
  // the per-issue retry cap) or escalate to human attention.
  | "silent-noop";

// Wired here rather than in `chunk-land.ts` because the merge phase is what
// consumes it: `chunkLanding` present ⇒ this cycle may land reviewed chunks on
// the source branch (#64). Absent ⇒ nothing does, which is every host on the
// default lane and every caller that predates the review lane.
export type ChunkLandingOptions = {
  // What a human asked for: one target per open pull request carrying `land`.
  readonly requests: readonly ChunkLandTarget[];
  // Named rather than derived, because this is the one thing the merge loop has
  // never had to know. The prose a member and a pull request are told has to
  // say where the work went, and `MergeTarget` only ever needed a noun phrase.
  readonly sourceBranch: string;
};

// One request with its destination attached — the form the merge loop carries a
// chunk landing in, so that the two halves of `ChunkLandingOptions` never have
// to be reunited by a defaulted local. Internal: what leaves this module is
// `ChunkWrapup`, which names the target alone.
type ChunkLandingUnit = {
  readonly target: ChunkLandTarget;
  readonly sourceBranch: string;
};

// The same, once origin's copy of the chunk branch has been fetched and merged.
// `ref` is what `fetchChunkRef` resolved — `refs/remotes/origin/<chunk>` — and
// it is the ONLY name for those commits that resolves in the merger worktree:
// that worktree hangs off the bare cache, whose imported `refs/heads/*` are
// deleted on import (`repo-cache.ts`), and nothing sandbar does creates a local
// chunk head afterwards (`preflight.ts` — the merger pushes from a detached
// HEAD). So every prompt that names these commits has to name this, not
// `request.branch`.
type MergedChunkUnit = ChunkLandingUnit & { readonly ref: string };

// A member whose branch is on its chunk's branch AND that branch is on origin
// (#60). Recorded only after the push, so the label finalise applies from it
// never claims durability the commits do not have. Not `merged`: nothing of it
// has reached the source branch, the issue stays OPEN, and what it earns is
// `needs-review` rather than a close.
export type ChunkLanding = {
  readonly issue: IssueRef;
  readonly chunkBranch: string;
};

// A chunk landed on the SOURCE branch this cycle is a `ChunkWrapup` (#64) —
// the one `chunk-reconcile.ts` reports too, since what a landing and a
// reconciliation leave behind is the same object and one `run.ts` report reads
// both. Do not confuse it with `ChunkLanding` above, which points the other
// way: that one is an issue arriving ON a chunk branch, this one is the whole
// chunk leaving it.

// Why a requested chunk did not land. Every one of these has already taken
// `land` off the pull request and said why on it, so the request is not
// repeated until a human re-applies the label — see `chunk-land.ts` on the
// label as a queue, and note what is NOT in this list: a push race, a forge
// verdict that never arrived and a `gh` that could not be reached all leave
// the label alone and halt, because nothing about the chunk is wrong.
export type ChunkLandSkipReason =
  | "branch-missing"
  | "conflict"
  | "gate-red"
  | "install-failed"
  | "forge-unverified";

export type SkippedChunkLand = {
  readonly target: ChunkLandTarget;
  readonly reason: ChunkLandSkipReason;
};

// A requested chunk that this cycle GREW before it could land it (#61 plans a
// whole layer at a time, so a member can reach the chunk branch while a `land`
// label is outstanding). Not a park and not a failure: the label stays on, the
// pull request is told what arrived, and the next cycle that adds nothing new
// lands the chunk. See `chunk-land.ts` on why landing it anyway is the one
// thing the review lane forbids.
export type DeferredChunkLand = {
  readonly target: ChunkLandTarget;
  // The members this cycle put on the branch, in landing order.
  readonly landedNow: readonly ChunkMember[];
};

export type MergerSummary = {
  readonly merged: readonly IssueRef[];
  // Review-gated issues landed on their chunk's branch this cycle, in the order
  // they landed. Empty for every host on the auto lane.
  readonly chunkLanded: readonly ChunkLanding[];
  readonly skipped: readonly {
    readonly issue: IssueRef;
    readonly reason: SkipReason;
  }[];
  readonly pushed: boolean;
  // Issues that merged + pushed but could NOT be closed on the tracker after
  // the retry budget (issue #14). The merge is durable; the only residue is an
  // OPEN issue. Phase 4 still drops `ready-for-agent` so these are never
  // re-picked, but the orchestrator surfaces them as an operator-actionable
  // list and halts. Empty on the happy path.
  readonly unclosed: readonly {
    readonly issue: IssueRef;
    readonly error: string;
  }[];
  // Reviewed chunks landed on the source branch this cycle (#64), each with the
  // residue of its wrap-up. Non-empty residue is operator-actionable and the
  // orchestrator halts on it — the chunk branch is kept in that case, so the
  // next run's reconciler retries exactly the writes that failed.
  readonly mergedChunks: readonly ChunkWrapup[];
  // Requested chunks this cycle grew before it could land them (#61 + #64).
  // The label is untouched, so these are a report and never a queue change.
  readonly deferredChunks: readonly DeferredChunkLand[];
  // Requested chunks that did not land and have had `land` removed. Rides a
  // `MergerError.partial` for the same reason `skipped` does: the pull request
  // has already been written to.
  readonly skippedChunks: readonly SkippedChunkLand[];
};

// The post-push close is a tracker side-effect that runs after the irreversible
// push, so a transient gh/network failure on it is retried with exponential
// backoff before the issue is recorded as un-closed (issue #14).
export const CLOSE_MAX_RETRIES = 2; // 3 attempts total: initial + 2 retries
const CLOSE_BACKOFF_BASE_MS = 1000;
function closeBackoffMs(attempt: number): number {
  // attempt is 1-based for retries (attempt 0 is the initial try, no wait).
  return CLOSE_BACKOFF_BASE_MS * 2 ** (attempt - 1); // 1s, then 2s
}
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class MergerError extends Error {
  // What the merger had already DONE to the tracker before it halted. Issues
  // skipped earlier in the cycle have a comment posted and `ready-for-agent`
  // removed, so if the halt discarded them they would be invisible to the
  // planner AND carry no handoff label — off every queue a human looks at.
  // The orchestrator finalises this before it stops.
  readonly partial: MergerSummary | undefined;

  constructor(
    message: string,
    partial?: MergerSummary,
    // The error this one wraps, when it wraps one (see `asHalt`). run.ts prints
    // its stack for anything that isn't an operator-actionable SandbarError.
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MergerError";
    this.partial = partial;
  }
}

export function issueNumberOf(issue: IssueRef): number {
  const n = Number(issue.id);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Invalid issue id (expected positive integer): ${issue.id}`,
    );
  }
  return n;
}

export function sortIssuesAsc(issues: readonly IssueRef[]): IssueRef[] {
  return [...issues].sort((a, b) => issueNumberOf(a) - issueNumberOf(b));
}

export type ChunkGroup = {
  readonly target: MergeTarget & { readonly kind: "chunk" };
  // The chunk's root, which names it and titles its pull request (#62).
  readonly root: number;
  // The members that were already on the chunk branch when the plan was built
  // (#62) — the plan's snapshot, not this cycle's work. Only the PR body reads
  // it; nothing here decides anything by it, because the authority on what the
  // branch carries is origin.
  readonly landed: readonly ChunkMember[];
  // The cycle's DONE branches for this chunk, in the order given.
  readonly members: readonly IssueRef[];
};

// The chunk-landing work of a cycle, grouped by branch and ordered by chunk
// root. One group is one checkout, one push and one pull request, so grouping
// is what keeps the landing at a single call site per chunk rather than one
// per issue.
//
// Groups of more than one member are reachable since #61: a chunk whose root
// has landed can hand this cycle every member blocked on it at once. Those
// members are necessarily SIBLINGS rather than a chain — a member plans only
// once its own blockers are on the chunk branch, which no issue planned in the same
// cycle does — so the order within a group is not a dependency order and
// ascending issue number (what `sortIssuesAsc` already gave) is simply
// deterministic. Being siblings is also why they can conflict with each other
// where a member and its ancestors provably cannot (#54 round-1 Q4): the
// resolve loop handles them exactly as it handles two auto-lane branches.
//
// `root` and `landed` are taken from the FIRST member seen for a branch. Every
// member of one group carries the same `ChunkTarget`, built once per chunk by
// the planner, so first-wins and a union of them agree; first-wins says which
// answer is being trusted rather than papering over a disagreement that would
// mean the plan contradicted itself.
export function groupByChunk(
  issues: readonly IssueRef[],
): readonly ChunkGroup[] {
  const byBranch = new Map<
    string,
    { root: number; landed: readonly ChunkMember[]; members: IssueRef[] }
  >();
  for (const issue of issues) {
    const chunk = issue.chunk;
    if (!chunk) continue;
    const existing = byBranch.get(chunk.branch);
    if (existing) existing.members.push(issue);
    else
      byBranch.set(chunk.branch, {
        root: chunk.root,
        landed: chunk.landed ?? [],
        members: [issue],
      });
  }
  return [...byBranch.entries()]
    .sort((a, b) => a[1].root - b[1].root)
    .map(([branch, { root, landed, members }]) => ({
      target: { kind: "chunk" as const, branch },
      root,
      landed,
      members,
    }));
}

export type MergerLog = (line: string) => void | Promise<void>;

// Optional sink for the gate output when we *enter* the resolve loop in
// gate-red mode. The loop will surface its own outputs separately via its
// log; this sink preserves the existing "merger-gate-<issueId>" artefact.
export type MergerGateOutputSink = (
  issueId: string,
  gate: MergerGateOutput,
) => void | Promise<void>;

// Where a resolve attempt's captured stdout and stderr go (#67), and what it
// answers with: the path it wrote, so the abandon comment can point at a file
// rather than at a pattern this module would have to spell a second time. The
// key is the gate artefact's — an issue id, `chunk-<root>`, or
// `verify-round-<n>` for a forge-red round.
export type MergerResolveAttemptSink = (
  key: string,
  record: ResolveAttemptRecord,
) => Promise<string | null>;

export type RunMergerOptions = {
  // Full set of issues in this cycle (typically the plan's DONE branches).
  // The resolve loop loads the bodies of all *other* entries so the agent has
  // multi-issue context when reasoning about an integration failure.
  readonly cycleIssues?: readonly IssueRef[];
  readonly projectAnchor?: string;
  // Overrides for the post-push close retry (issue #14). Default retries is
  // CLOSE_MAX_RETRIES; default sleep is real setTimeout-backed. Tests inject a
  // no-op sleep so the backoff doesn't slow the suite.
  readonly closeRetries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  // Landing reviewed chunks on the source branch (#64). Absent ⇒ none, which
  // is the whole of the auto lane.
  readonly chunkLanding?: ChunkLandingOptions;
  // Per-resolve-attempt output capture (#67). Absent ⇒ nothing is written and
  // every comment says so outright instead of naming a file that is not there.
  readonly onResolveAttempt?: MergerResolveAttemptSink;
  // Verified merge mode (#22). Absent → direct mode (today's push straight to
  // the source branch). Present → the forge gates the landing. The adapter is
  // required *by the type* exactly when the mode is on, so there is no
  // "verified mode configured but nothing wired up" state to check at runtime.
  readonly verified?: {
    readonly adapter: VerifyAdapter;
    readonly options: Omit<
      VerifiedLandingOptions,
      "mergedIssues" | "cycleIssues" | "projectAnchor"
    >;
    // Test seam for the check-poll clock. ONE object, not a sleep and a now:
    // the poll's pacing and its deadline both read from it, and a caller able
    // to fake one while leaving the other real turns the wait into a full-core
    // spin (#25). See `Clock` in forge-verify.ts.
    readonly clock?: Clock;
  };
};

// What `attemptMerge` needs of the cycle it is running in. A parameter rather
// than a closure so the operation lives at module scope: it reads no
// accumulator and writes none, which is exactly the property that makes it
// shareable by all three landing paths in the first place.
type MergeAttemptDeps = {
  readonly adapter: MergerAdapter;
  readonly emit: (line: string) => Promise<void>;
  readonly projectAnchor: string;
  readonly resolveLog: ResolveLogger;
  readonly onGateRed?: MergerGateOutputSink | undefined;
  // Bound to a KEY by the caller (#67) — `attemptMerge` already carries the one
  // the gate artefact is filed under, so a resolve attempt lands beside the
  // gate output it was prompted from.
  readonly resolveSinkFor: (key: string) => ResolveAttemptSink | undefined;
};

// The version collision, resolved before the agent is asked anything (#68).
//
// AGENTS.md makes every commit move `version` in `package.json` and its two
// mirrors in `package-lock.json`, so two branches landing in one cycle conflict
// there by construction — every time, not occasionally. Spending an agentic
// attempt on the one conflict in the tree whose answer is not a judgement call
// is waste, and the answer it re-derives is one neither side carries:
// `max(ours, theirs)` bumped once. `version-conflict.ts` owns what qualifies
// and what the value is; this owns the git and the log line.
//
// Three answers, and only one of them keeps the agent out of it:
//
//   completed — every conflicted path was a version file this could resolve,
//               and the merge is now committed. The caller falls through to
//               `npm install` + gate exactly as it would for a clean merge, so
//               nothing downstream can tell the difference.
//   partial   — something was staged but conflicts remain (or the commit
//               failed). The resolve loop runs, and the agent sees the version
//               files already resolved and staged.
//   none      — nothing here to do; the conflict is entirely the agent's.
//
// Every branch of it says so in the merger log, including a version file it
// looked at and DECLINED: "why did that cost an attempt" is the question this
// log line exists to answer without anyone opening the tree.
export type VersionCollisionOutcome = "completed" | "partial" | "none";

// Exported for `merger-git.test.ts`: what "the version files are the only
// conflict" and "the merge is committed" mean is git's to define, so the whole
// operation is asserted by running it against a real conflicting merge in the
// shape production uses, rather than against a fake that agrees with it.
export async function resolveVersionCollision(
  adapter: MergerAdapter,
  emit: (line: string) => Promise<void>,
  label: string,
): Promise<VersionCollisionOutcome> {
  const candidates = (await adapter.unmergedPaths()).filter(
    isVersionConflictFile,
  );
  if (candidates.length === 0) return "none";
  const files: { path: string; text: string | null }[] = [];
  for (const path of candidates) {
    files.push({ path, text: await adapter.readWorktreeFile(path) });
  }
  const plan = planVersionCollision(files);
  if (plan === null) return "none";
  for (const d of plan.declined) {
    await emit(
      `version-collision ${label} ${d.path} left to the resolve agent: ${d.reason}`,
    );
  }
  if (plan.version === null || plan.resolved.length === 0) return "none";
  for (const file of plan.resolved) {
    await adapter.writeWorktreeFile(
      file.path,
      renderVersionResolution(file, plan.version),
    );
    await adapter.stagePath(file.path);
    await emit(
      `version-collision ${label} ${file.path} ` +
        `${[...new Set(file.versions)].join(" vs ")} -> ${plan.version}`,
    );
  }
  const remaining = await adapter.unmergedPaths();
  if (remaining.length > 0) {
    await emit(
      `version-collision ${label} staged; still conflicted: ${remaining.join(", ")}`,
    );
    return "partial";
  }
  const committed = await adapter.commitMerge();
  if (!committed.ok) {
    await emit(
      `version-collision ${label} resolved every conflict but the merge commit failed`,
    );
    return "partial";
  }
  await emit(
    `version-collision ${label} resolved the whole conflict at ${plan.version}; no resolve attempt spent`,
  );
  return "completed";
}

// One ref, merged onto whatever the worktree is currently detached at, with
// the resolve loop and the gate given their say and the repo state already
// settled when this returns: a non-`merged` outcome has been reverted and the
// tree is back where it started.
//
// What is deliberately NOT here is the tracker. An issue branch that could not
// land is commented on and stripped of `ready-for-agent`; a chunk that could
// not land is commented on and stripped of `land` (#64). The repo half of
// those two is identical and the tracker half shares nothing, so the split is
// exactly where the two stop agreeing.
//
// Shared verbatim by all three landing paths — issue→source, issue→chunk
// (#60), chunk→source (#64). `target` only ever reaches the prose and the
// log, because conflict resolution, the gate and the revert are the same
// operations whichever branch is underneath.
async function attemptMerge(
  args: {
    readonly unit: MergeUnit;
    readonly target: MergeTarget;
    // Whose issue bodies the resolve agent gets: the cycle's other issues for
    // an issue branch, the chunk's members for a chunk.
    readonly related: readonly IssueRef[];
    // How this unit is named in the merger log — `#12`, or `chunk #42`.
    readonly label: string;
    // The key the gate-red artefact is filed under. An issue id for an issue;
    // `chunk-<root>` for a chunk, so a chunk and its own root issue landing in
    // one cycle cannot overwrite each other's trace.
    readonly gateKey: string;
  },
  deps: MergeAttemptDeps,
): Promise<MergeAttempt> {
  const { adapter, emit, projectAnchor, resolveLog, onGateRed } = deps;
  const { unit, target, label } = args;
  const onAttempt = deps.resolveSinkFor(args.gateKey);
  await emit(`merge-attempt ${label} ${unit.branch}`);
  const preMergeSha = await adapter.getHeadSha();
  const m = await adapter.mergeNoFf(unit);

  // The version collision is settled mechanically first (#68); only what it
  // could not finish reaches the agent. `completed` falls through to the clean
  // path below, merge commit and all.
  if (
    !m.ok &&
    (await resolveVersionCollision(adapter, emit, label)) !== "completed"
  ) {
    await emit(`conflict ${label} entering resolve-loop`);
    const outcome = await runResolveLoop(
      unit,
      args.related,
      { kind: "conflict" },
      adapter,
      {
        projectAnchor,
        preMergeSha,
        target: describeMergeTarget(target),
        ...(onAttempt ? { onAttempt } : {}),
      },
      resolveLog,
    );
    if (outcome.kind === "abandon") {
      if (outcome.mergeInProgress) {
        await adapter.abortMerge();
      } else {
        await adapter.resetHardSha(preMergeSha);
      }
      return {
        kind: "abandon",
        mode: "conflict",
        reason: outcome.reason,
        silent: outcome.silent === true,
        attempts: outcome.attempts,
        conflictPaths: outcome.conflictPaths,
      };
    }
    await emit(`merged ${label} (via resolve-loop)`);
    return { kind: "merged" };
  }

  const inst = await adapter.npmInstall();
  if (!inst.ok) {
    await adapter.resetHardSha(preMergeSha);
    return { kind: "install-failed" };
  }

  const g = await adapter.runGate();
  if (!g.ok) {
    if (onGateRed) {
      await onGateRed(args.gateKey, {
        stdout: g.stdout,
        stderr: g.stderr,
        failedStep: g.failedStep,
        exitCode: g.exitCode,
        containerLogs: g.containerLogs,
      });
    }
    await emit(
      `gate-red ${label} failedStep=${g.failedStep ?? "-"} exitCode=${g.exitCode}; entering resolve-loop`,
    );
    const outcome = await runResolveLoop(
      unit,
      args.related,
      {
        kind: "gate-red",
        initialOutput: {
          stdout: g.stdout,
          stderr: g.stderr,
          failedStep: g.failedStep,
          exitCode: g.exitCode,
          containerLogs: g.containerLogs,
        },
      },
      adapter,
      {
        projectAnchor,
        preMergeSha,
        target: describeMergeTarget(target),
        ...(onAttempt ? { onAttempt } : {}),
      },
      resolveLog,
    );
    if (outcome.kind === "abandon") {
      await adapter.resetHardSha(preMergeSha);
      return {
        kind: "abandon",
        mode: "gate-red",
        reason: outcome.reason,
        silent: outcome.silent === true,
        attempts: outcome.attempts,
        conflictPaths: outcome.conflictPaths,
      };
    }
    await emit(`merged ${label} (gate-red recovered via resolve-loop)`);
    return { kind: "merged" };
  }

  await emit(`merged ${label}`);
  return { kind: "merged" };
}

export async function runMergerWithAdapter(
  issues: readonly IssueRef[],
  adapter: MergerAdapter,
  log?: MergerLog,
  onGateRed?: MergerGateOutputSink,
  opts: RunMergerOptions = {},
): Promise<MergerSummary> {
  const merged: IssueRef[] = [];
  const chunkLanded: ChunkLanding[] = [];
  const skipped: { issue: IssueRef; reason: SkipReason }[] = [];
  // #64. `skippedChunks` is written before the landing and so rides a partial;
  // `mergedChunks` is only ever written after it, so a partial's is always
  // empty, exactly as `merged`'s is.
  const skippedChunks: SkippedChunkLand[] = [];
  // #64 + #61: requests this cycle grew before it could land them. Carried on a
  // partial like `skippedChunks`, and for the same reason — the pull request
  // has already been commented on by the time anything below can throw.
  const deferredChunks: DeferredChunkLand[] = [];
  // Kept whole rather than split into a request list and a source-branch
  // string. The two are only meaningful together — the branch names where the
  // requests are going — and pulling them apart means giving the branch a
  // default for the case where there are no requests, which is an invariant
  // held by a sentinel rather than stated. Narrowed once, inside
  // `landRequestedChunks`, which is the only thing that reads it.
  const chunkLanding = opts.chunkLanding;
  const cycle = opts.cycleIssues ?? issues;
  const projectAnchor = opts.projectAnchor ?? "";
  const closeRetries = opts.closeRetries ?? CLOSE_MAX_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;
  // Every exit from this function after its first tracker write has to carry
  // that write to Phase 4. The loop below comments on an issue and drops
  // `ready-for-agent`, but applying the HANDOFF label is Phase 4b's job — so
  // between those two moments the issue is on no queue at all, invisible to
  // the planner and to a human filtering on `agent-stuck`. `MergerError.partial`
  // is the only channel that survives a halt (run.ts finalises it, then stops),
  // and run.ts's `instanceof MergerError` check is what routes to it, so
  // anything else thrown out of the loop or the landing is re-thrown WRAPPED
  // rather than absorbed: the run still halts loud and the message still names
  // the underlying failure, but the tracker state reaches Phase 4 first (#33).
  //
  // What such a partial may claim is `nothingLanded()` below, in one place.
  //
  // The original error rides along as `cause`. Without it an unexpected bug —
  // as opposed to a designed `SandbarError` — arrives at run.ts's merger-halted
  // branch as a bare message, and that branch is precisely the one that does
  // NOT reach the top-level handler that would have printed a stack.

  // The summary of a cycle that landed NOTHING — every halt, every park and
  // every early return below, which is the only thing any of them is entitled
  // to claim. One claim, so one spelling: eight literals of it were eight
  // chances for the next field added to `MergerSummary` to reach seven of them.
  //
  // `merged` is `[]` here and never the local array — see `landed` for why
  // that is a fact rather than a hope, and for the one window where it stops
  // being one. `mergedChunks` and `unclosed` are `[]` for the same reason one
  // level down: both are written only inside `settleLanding`, past that window.
  //
  // `chunkLanded` is the opposite and is carried VERBATIM: those commits really
  // are on origin (the entry is written after the push) and the issues really
  // receive their `needs-review` display label. Landing a chunk does not move the source
  // branch, so it takes nothing away from the `merged: []` claim beside it —
  // the two answer different questions. `skipped` and `skippedChunks` are the
  // same: a tracker write already made, which is the whole reason a partial
  // exists (#33).
  //
  // COPIED, not aliased. A `MergerError.partial` outlives this function, and
  // an array a later iteration could still push to is a partial that changes
  // after it was reported.
  const nothingLanded = (): MergerSummary => ({
    merged: [],
    chunkLanded: [...chunkLanded],
    skipped: [...skipped],
    pushed: false,
    unclosed: [],
    mergedChunks: [],
    skippedChunks: [...skippedChunks],
    deferredChunks: [...deferredChunks],
  });

  const asHalt =
    (context: string) =>
    (err: unknown): never => {
      if (err instanceof MergerError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new MergerError(`${context}: ${msg}`, nothingLanded(), {
        cause: err,
      });
    };

  // Flipped the instant this cycle's work reaches origin. Before that point a
  // halt provably landed nothing — the merges exist only in the ephemeral
  // merger worktree run.ts removes in its `finally` — so `merged: []` and
  // `pushed: false` in a partial are facts. After it they would be lies, and a
  // partial that lies is worse than no partial: run.ts would report a halt,
  // finalise only the skipped, and leave the landed issues open, queued and
  // unclosed while the source branch has already moved. So past that point
  // failures are NOT wrapped — they go to the top-level handler with their
  // stack intact.
  //
  // Residual window, accepted: the verified path's fast-forward happens INSIDE
  // runVerifiedLanding, which logs one line after it (`verify: fast-forwarded
  // …`). A throw from that single log write is still wrapped and would report
  // `merged: []` against a source branch that did move. `fastForwardSource`
  // itself cannot throw (it catches and returns `rejected`), so that log line
  // is the whole of it. The direct path has no such window — `adapter.push()`
  // sits out here, and `landed` flips before anything else runs.
  let landed = false;
  const emit = async (line: string): Promise<void> => {
    if (!log) return;
    try {
      await log(line);
    } catch (err) {
      // #33 entered through the log sink instead of `gh`: an ENOSPC on the run
      // log after the loop's first skip strands every issue parked so far, and
      // `no merges, no push` below fires exactly when EVERY issue was parked.
      if (landed) throw err;
      asHalt("Merger log write failed")(err);
    }
  };
  const resolveLog: ResolveLogger = (line) => emit(line);

  // Verified mode only: capture the sha the merger worktree started at — the
  // state to revert the WHOLE cycle to when the forge rejects the composed
  // result. Carried on the mode object itself so the landing branch below can
  // never see a null base sha and silently fall through to a direct push; and
  // read only when the mode is on, so direct-mode callers (and their test
  // fakes) don't pay an extra getHeadSha.
  const verified = opts.verified
    ? { ...opts.verified, cycleBaseSha: await adapter.getHeadSha() }
    : null;

  // One key's worth of the cycle's attempt sink, or nothing when no sink was
  // wired. Curried here rather than at each call site because `attemptMerge`
  // and the verified landing both need the same binding and only differ in
  // what they call the key.
  const resolveSinkFor = (key: string): ResolveAttemptSink | undefined => {
    const sink = opts.onResolveAttempt;
    if (!sink) return undefined;
    return (record) => sink(key, record);
  };

  // Everything module-scope `attemptMerge` needs of this cycle, bound once.
  const mergeDeps: MergeAttemptDeps = {
    adapter,
    emit,
    projectAnchor,
    resolveLog,
    onGateRed,
    resolveSinkFor,
  };

  // One DONE issue branch. True means its commits are on HEAD; false means it
  // was skipped and HEAD is back where it started.
  const mergeOne = async (
    issue: IssueRef,
    target: MergeTarget,
  ): Promise<boolean> => {
    try {
      const n = issueNumberOf(issue);
      const outcome = await attemptMerge(
        {
          unit: issue,
          target,
          related: cycle.filter((c) => c.id !== issue.id),
          label: `#${n}`,
          gateKey: issue.id,
        },
        mergeDeps,
      );
      if (outcome.kind === "merged") return true;

      if (outcome.kind === "install-failed") {
        await adapter.commentOnIssue(n, buildInstallFailedComment(target));
        await adapter.removeLabel(n, READY_FOR_AGENT_LABEL);
        skipped.push({ issue, reason: "install-failed" });
        await emit(`skip #${n} reason=install-failed`);
        return false;
      }
      if (outcome.silent) {
        // Silent abandon: no comment, no label flip. The orchestrator's
        // finalize will either delete the branch + leave it on the queue
        // (fresh attempt next cycle) or escalate to human attention, based
        // on the per-issue retry count it tracks in runState.
        skipped.push({ issue, reason: "silent-noop" });
        await emit(`skip #${n} reason=silent-noop: ${outcome.reason}`);
        return false;
      }
      await adapter.commentOnIssue(
        n,
        buildAbandonComment({
          mode: outcome.mode,
          reason: outcome.reason,
          attempts: outcome.attempts,
          conflictPaths: outcome.conflictPaths,
          target,
        }),
      );
      await adapter.removeLabel(n, READY_FOR_AGENT_LABEL);
      skipped.push({ issue, reason: outcome.mode });
      await emit(
        `skip #${n} reason=${outcome.mode} resolve-abandon: ${outcome.reason}`,
      );
      return false;
    } catch (err) {
      // Not a hypothetical throw site: `getIssueBody` throws by design when
      // `gh` fails (see realAdapter below), and `runGate` throws — rather than
      // reddening — when an issue-lifecycle container has died under it
      // (#24 D5). Either lands here AFTER an earlier issue in this same cycle
      // was commented on and de-labelled.
      return asHalt(`Merge loop failed on issue #${issue.id}`)(err);
    }
  };

  // ---------------------------------------------------------------------
  // Phase A: the chunk landings (#60), before the source-branch pass — see
  // the header for why that order and not the other one.
  // ---------------------------------------------------------------------

  // ONE chunk branch: base the worktree at origin's copy of it, merge every
  // member of the group on, push, and open or update the review surface.
  // Named for the same reason `landRequestedChunks` below is — it is one pass
  // over one input, and what it leaves behind is exactly the `chunkLanded`
  // entries its members earned by reaching origin.
  //
  // A closure rather than a module-scope function taking its deps, unlike
  // `attemptMerge`: it WRITES `chunkLanded`, and it has to write it before the
  // pull-request call below, which halts. Returning the landed members for a
  // caller to record instead would mean a halt on the PR left them out of the
  // partial — and their commits are on origin by then, so `needs-review` is owed
  // whether or not the review surface came up.
  const landChunkGroup = async (group: ChunkGroup): Promise<void> => {
    const branch = group.target.branch;
    const landedMembers: IssueRef[] = [];
    try {
      const base = await adapter.chunkBase(branch);
      await emit(`chunk ${branch}: base ${base}`);
      await adapter.checkoutDetached(base);
    } catch (err) {
      asHalt(`Chunk landing failed to base ${branch}`)(err);
    }
    for (const member of group.members) {
      if (await mergeOne(member, group.target)) landedMembers.push(member);
    }
    if (landedMembers.length === 0) {
      await emit(`chunk ${branch}: nothing landed`);
      return;
    }
    // The one place a chunk branch is written, and the reason the whole group
    // is merged before it: a member is only ever recorded as landed once the
    // commits carrying it are on origin.
    const push = await adapter
      .pushChunkBranch(branch, landedMembers.map((member) => member.branch))
      .catch(asHalt(`Chunk push failed for ${branch}`));
    if (push.kind !== "ok") {
      // Not force-pushed and not retried. A rejected push means the chunk
      // branch moved under this cycle, so the composition here was built on a
      // base that is no longer the branch — landing it would silently drop
      // whatever moved it. The members keep `ready-for-agent` and their issue
      // branches, so the next run re-merges them onto the branch as it now is.
      throw new MergerError(
        `Could not push chunk branch ${branch} (${push.kind === "race" ? "rejected — the branch moved under this cycle" : push.reason}). ` +
          `${landedMembers.length} issue(s) merged onto it locally and were NOT landed: ` +
          `${landedMembers.map((m) => `#${issueNumberOf(m)}`).join(", ")}. ` +
          `They keep ready-for-agent and their branches; the composition is discarded with the merger worktree.`,
        nothingLanded(),
      );
    }
    for (const member of landedMembers) {
      chunkLanded.push({ issue: member, chunkBranch: branch });
    }
    await emit(
      `chunk ${branch}: landed ${landedMembers.map((m) => `#${issueNumberOf(m)}`).join(", ")} and pushed`,
    );

    // The review surface (#62), last and never first: a pull request is a
    // handle on commits, and one opened before the push would point at a
    // branch origin does not have. The members are already recorded as landed
    // above, so a failure here costs the PR and not the landing.
    const prMembers = chunkMembersOnBranch(
      group.landed,
      landedMembers.map((m) => ({
        number: issueNumberOf(m),
        title: m.title,
      })),
    );
    const pr = await adapter
      .ensureChunkPullRequest({
        chunkBranch: branch,
        ...chunkPullRequestContent({
          root: group.root,
          branch,
          members: prMembers,
        }),
      })
      .catch(
        // Loud, like every other tracker write in this loop. The landing is
        // durable and the partial carries it, so the members still get
        // `needs-review`; what is missing is the thing a human reviews, and a run
        // that carried on would keep landing work onto a branch nobody had
        // been shown.
        asHalt(
          `Chunk branch ${branch} is on origin with ` +
            `${landedMembers.map((m) => `#${issueNumberOf(m)}`).join(", ")} landed on it, ` +
            `but its draft pull request could not be opened or updated. Those issues keep ` +
            `their landing and are labelled needs-review when that display write succeeds; ` +
            `open or update the PR by hand (or fix ` +
            `gh's permissions — the next cycle that lands a member on this chunk retries it)`,
        ),
      );
    await emit(`chunk ${branch}: draft PR ${pr.url || `#${pr.number}`}`);
  };

  // Every group, and HEAD put back where the cycle started once they are done
  // — so Phase B merges onto `origin/<sourceBranch>` and not onto the last
  // chunk this happened to land. Nothing else in this function moves HEAD
  // across issues. The entry sha is read only when there IS a group, so a
  // cycle without one makes no extra call.
  const landChunkGroups = async (
    groups: readonly ChunkGroup[],
  ): Promise<void> => {
    if (groups.length === 0) return;
    const sourceBaseSha = await adapter.getHeadSha();
    for (const group of groups) await landChunkGroup(group);
    await adapter
      .checkoutDetached(sourceBaseSha)
      .catch(
        asHalt("Could not return the merger worktree to the source branch"),
      );
  };

  const sorted = sortIssuesAsc(issues);
  await landChunkGroups(groupByChunk(sorted));

  // ---------------------------------------------------------------------
  // Phase B: the source-branch pass. Reviewed chunks first (#64), then the
  // auto lane's DONE branches, then ONE landing over what they compose to.
  //
  // Chunks go first because they are the older work: their commits were cut
  // from a `origin/<sourceBranch>` that has since moved, and a review said yes
  // to them. Putting them down first and merging this cycle's fresh branches
  // on top means the gate that decides the cycle sees the composition a human
  // will actually get, and it means the one landing at the end covers both —
  // there is no second push, no second verified round, and no window in which
  // a chunk is on the source branch and the cycle's issues are not.
  // ---------------------------------------------------------------------

  // Everything the resolve agent should be able to read about a chunk: the
  // member issues, all pointing at where their work actually is. Their own
  // issue branches are long since deleted (finalise reaps one when its member
  // lands on the chunk), so naming those would send an agent to a ref that is
  // not there — and so, for the same reason, would naming the chunk branch:
  // only `origin/<chunk>` exists here, which is why the caller passes the ref
  // `fetchChunkRef` resolved rather than `request.branch`. See
  // `MergedChunkUnit`.
  const chunkMemberRefs = (unit: MergedChunkUnit): readonly IssueRef[] =>
    unit.target.members.map((m) => ({
      id: String(m.number),
      title: m.title,
      branch: unit.ref,
    }));

  // Take `land` back off and say why on the pull request. The chunk itself is
  // untouched — branch, members and labels all as they were — so what this
  // costs a human is re-applying one label once they have dealt with whatever
  // the comment describes.
  //
  // RECORDED FIRST, before either write, on the same argument `landChunkGroup`
  // makes one phase up: the park is a decision already taken — the merge is
  // reverted and nothing of this chunk is landing this cycle — while the two
  // `gh` calls below can throw and halt. A `MergerError.partial` that omitted a
  // pull request already commented on would report a reviewer as untold when
  // they had been told, which is the one thing a partial exists to get right.
  const parkChunk = async (
    request: ChunkLandTarget,
    comment: string,
    reason: ChunkLandSkipReason,
  ): Promise<void> => {
    skippedChunks.push({ target: request, reason });
    if (request.pullRequest > 0) {
      await adapter.commentOnPullRequest(request.pullRequest, comment);
      await adapter.removePullRequestLabel(request.pullRequest, LAND_LABEL);
    }
    await emit(`chunk ${request.branch}: not landed (${reason})`);
  };

  // Say on the pull request that the chunk grew, and leave the label where it
  // is. The one outcome here that is neither a landing nor a park: nothing
  // about the request is wrong and nothing about the chunk is either, so the
  // queue is untouched and the next cycle honours it — see `chunk-land.ts` on
  // why the landing may not simply take the new commits with it.
  const deferChunk = async (
    request: ChunkLandTarget,
    landedNow: readonly ChunkMember[],
    sourceBranch: string,
  ): Promise<void> => {
    if (request.pullRequest > 0) {
      await adapter.commentOnPullRequest(
        request.pullRequest,
        CHUNK_LAND_DEFERRED_PR_COMMENT({
          chunkBranch: request.branch,
          sourceBranch,
          landedNow,
        }),
      );
    }
    deferredChunks.push({ target: request, landedNow });
    await emit(
      `chunk ${request.branch}: not landed (grew this cycle: ` +
        `${landedNow.map((m) => `#${m.number}`).join(", ")}); \`${LAND_LABEL}\` kept`,
    );
  };

  // Every requested chunk — merged onto HEAD, parked, or deferred — returning
  // the ones whose commits are now on the composition. Lifted out of the body
  // because it is one self-contained pass over one input: it reads `adapter`,
  // `attemptMerge`, `parkChunk` and `deferChunk`, and writes nothing but its
  // own return value and the two lists those last two append to.
  //
  // The pairing with `sourceBranch` is where `ChunkLandingOptions` is taken
  // apart, and it happens here rather than as two locals at the top for the
  // reason the type exists: two locals would need a default branch name for the
  // cycle that has no requests at all, and an empty string that only ever works
  // because nothing reads it is an invariant held by luck. Inside this function
  // a destination exists because a request does.
  const landRequestedChunks = async (): Promise<MergedChunkUnit[]> => {
    if (!chunkLanding) return [];
    // What Phase A put on each chunk branch a moment ago, by branch. Read from
    // `chunkLanded` rather than from the plan because that list is the record
    // of what actually reached ORIGIN — a member whose push failed is not on
    // the branch and is no reason to defer anything.
    const grewThisCycle = new Map<string, ChunkMember[]>();
    for (const landing of chunkLanded) {
      const members = grewThisCycle.get(landing.chunkBranch) ?? [];
      members.push({
        number: issueNumberOf(landing.issue),
        title: landing.issue.title,
      });
      grewThisCycle.set(landing.chunkBranch, members);
    }
    const onHead: MergedChunkUnit[] = [];
    for (const request of chunkLanding.requests) {
      const pending: ChunkLandingUnit = {
        target: request,
        sourceBranch: chunkLanding.sourceBranch,
      };
      try {
        // Grew under the request, in this very cycle (#61's layer landing, one
        // phase up). The plan read this chunk's members BEFORE phase 2, so the
        // wrap-up would close what was on the branch then and delete the branch
        // that carries the rest — while putting commits on the source branch
        // that the pull request did not carry when a human labelled it.
        // Nothing is merged and the label is left alone.
        const landedNow = grewThisCycle.get(request.branch);
        if (landedNow) {
          await deferChunk(request, landedNow, pending.sourceBranch);
          continue;
        }
        const found = await adapter.fetchChunkRef(request.branch);
        if (found.kind === "unreadable") {
          // Origin could not be asked, so nothing is known about this chunk —
          // and `land` is a human's request that only a fact about the chunk
          // may cancel. Halting keeps the label on for the next run; parking
          // here would drop it and tell a reviewer their branch was deleted on
          // the strength of a proxy hiccup. This is the same class as a push
          // race and it is handled the same way.
          throw new SandbarError(
            `origin's copy of ${request.branch} could not be read, so there is ` +
              `no way to tell a deleted chunk branch from an unreachable ` +
              `origin: ${found.detail}`,
          );
        }
        if (found.kind === "absent") {
          // Origin was reached and does not have the branch. Either the
          // reconciler already landed this chunk and deleted it (and the label
          // is stale), or somebody deleted the branch by hand. Merging the
          // source branch into itself instead would be a silent no-op that
          // closed every member of a chunk whose work is nowhere, so this
          // parks rather than lands.
          await parkChunk(
            request,
            CHUNK_BRANCH_MISSING_PR_COMMENT({ chunkBranch: request.branch }),
            "branch-missing",
          );
          continue;
        }
        const unit: MergedChunkUnit = { ...pending, ref: found.ref };
        const outcome = await attemptMerge(
          {
            unit: {
              id: String(request.root),
              title: request.title,
              branch: unit.ref,
              // Named for the BRANCH, not for an issue: what is being merged is
              // a whole chunk, and `Merge sandbar/issue-<root>` would claim it
              // was one issue's work.
              mergeMessage: `Merge ${request.branch}: ${request.title}`,
            },
            target: SOURCE_TARGET,
            related: chunkMemberRefs(unit),
            label: `chunk #${request.root}`,
            gateKey: `chunk-${request.root}`,
          },
          mergeDeps,
        );
        if (outcome.kind === "merged") {
          onHead.push(unit);
          continue;
        }
        await parkChunk(
          request,
          CHUNK_LAND_ABANDONED_PR_COMMENT({
            chunkBranch: request.branch,
            sourceBranch: pending.sourceBranch,
            mode:
              outcome.kind === "install-failed"
                ? "install-failed"
                : outcome.mode,
            reason: outcome.kind === "install-failed" ? "" : outcome.reason,
            // The same diagnostics the auto lane's issue comment carries
            // (#67). A reviewer reading a parked chunk needs to tell a real
            // collision from a broken container exactly as an issue's author
            // does, and `install-failed` never entered the loop at all.
            attempts: outcome.kind === "install-failed" ? [] : outcome.attempts,
            conflictPaths:
              outcome.kind === "install-failed" ? [] : outcome.conflictPaths,
          }),
          outcome.kind === "install-failed" ? "install-failed" : outcome.mode,
        );
      } catch (err) {
        asHalt(`Chunk landing failed on ${request.branch}`)(err);
      }
    }
    return onHead;
  };

  // Merged onto HEAD, awaiting the landing. They become `mergedChunks` only
  // once the source branch has actually moved — the same rule `merged` follows,
  // and for the same reason.
  const chunkMergesOnHead = await landRequestedChunks();

  for (const issue of sorted) {
    if (issue.chunk) continue;
    if (await mergeOne(issue, SOURCE_TARGET)) merged.push(issue);
  }

  // Everything that has to happen once the source branch has moved, in one
  // place because both landing modes reach it and neither may skip half of it.
  // Nothing here throws — `wrapUpLandedChunk` collects residue rather than
  // raising (including from the `emit` handed to it, which by then throws on a
  // failed log write), and `closeMergedIssues` is fault-tolerant by design.
  // That is what keeps the post-`landed` window free of the wrapped-throw
  // problem the whole of `asHalt` exists for.
  const settleLanding = async (): Promise<MergerSummary> => {
    const mergedChunks: ChunkWrapup[] = [];
    for (const { target, sourceBranch } of chunkMergesOnHead) {
      const wrapup = await wrapUpLandedChunk(target, adapter, {
        sourceBranch,
        provenance: "sandbar",
        log: (line) => emit(line),
      });
      mergedChunks.push({ target, ...wrapup });
    }
    return {
      merged,
      chunkLanded,
      skipped,
      pushed: true,
      unclosed: await closeMergedIssues(merged, adapter, {
        closeRetries,
        sleep,
        emit,
      }),
      mergedChunks,
      skippedChunks,
      deferredChunks,
    };
  };

  if (merged.length === 0 && chunkMergesOnHead.length === 0) {
    // Both halves of that sentence are about the SOURCE branch, and a cycle
    // that landed chunks says so rather than reading as "nothing happened".
    await emit(
      chunkLanded.length === 0
        ? `no merges, no push`
        : `no merges onto the source branch, no push there — ${chunkLanded.length} issue(s) landed on a chunk branch above`,
    );
    return nothingLanded();
  }

  if (verified) {
    // Everything from here to the end of the cycle runs AFTER issues have been
    // commented on and de-labelled earlier in this loop, so anything that
    // escapes must still carry that tracker state to Phase 4 — otherwise those
    // issues end with `ready-for-agent` stripped and no handoff label: off the
    // planner's list and off every human's filter.
    //
    // Wrapping matters at least as much here as in the loop: verified landing
    // reaches the forge over the network and through `gh`, so unlike the local
    // merge path it has genuine infrastructure failures (an unreachable API for
    // three consecutive polls, an unreadable response, a `gh` without the right
    // scope).
    const haltVerified = asHalt("Verified merge failed");

    // What the forge is asked to judge, and what the forge-red resolve loop is
    // given as context (#22) — declared here because verified mode is the only
    // thing that reads it, and the merge order below matters to nothing else.
    // A landed chunk's members belong in both: the composed result contains
    // their commits, so a red the forge reports may well be theirs.
    //
    // In MERGE ORDER, chunks first, because `runVerifiedLanding` anchors its
    // resolve prompt on the LAST entry and documents that as the topmost merge.
    // Chunks go down first and this cycle's fresh branches on top, so ascending
    // merge order is the chunks and then `merged` — the other way round the
    // anchor would be the bottom-most commit in the composition, described to
    // an agent as the top.
    const landingIssues: readonly IssueRef[] = [
      ...chunkMergesOnHead.flatMap(chunkMemberRefs),
      ...merged,
    ];

    const landing = await runVerifiedLanding(
      {
        ...verified.options,
        mergedIssues: landingIssues,
        cycleIssues: cycle,
        projectAnchor,
        // Keyed by ROUND (#67): each round runs a fresh resolve loop whose
        // attempts start again at 1, so a single key would have round 2
        // overwrite round 1's capture attempt for attempt.
        onResolveAttempt: (round) => resolveSinkFor(`verify-round-${round}`),
      },
      {
        verify: verified.adapter,
        resolve: adapter,
        log: resolveLog,
        ...(verified.clock ? { clock: verified.clock } : {}),
      },
    ).catch(haltVerified);

    if (landing.kind === "fatal") {
      await emit(`verify fatal: ${landing.detail}`);
      // The merges are NOT reverted here: a fatal means we could not determine
      // or could not act on the verdict, and the merger worktree is ephemeral
      // anyway. What must survive is the tracker state for issues skipped
      // earlier in this cycle — they are already commented and de-labelled.
      //
      // The merged-but-unlanded issues are named in the message: they keep
      // `ready-for-agent` and their branches (the next run's preflight picks
      // them up as resumable), but nothing else tells the operator which work
      // was composed and thrown away with the worktree.
      const stranded = merged.map((m) => `#${issueNumberOf(m)}`).join(", ");
      throw new MergerError(
        `Verified merge could not land: ${landing.detail}` +
          (stranded
            ? ` — ${merged.length} issue(s) merged locally and NOT landed: ${stranded}. ` +
              `They keep ready-for-agent and their branches; the merge result itself is discarded ` +
              `with the ephemeral merger worktree.`
            : ""),
        nothingLanded(),
      );
    }

    if (landing.kind === "abandoned") {
      await emit(
        `verify abandoned reason=${landing.reason} rounds=${landing.rounds}: ${landing.detail}`,
      );
      // Cycle-level revert: the forge judged all of these merges together.
      // Wrapped like the landing itself: this loop writes tracker state issue
      // by issue, so a `gh` failure on the second of three must not discard
      // what the first one already applied.
      await adapter.resetHardSha(verified.cycleBaseSha).catch(haltVerified);
      for (const issue of merged) {
        // The whole body, not a `.catch` per call: `buildForgeUnverifiedComment`
        // is evaluated as an ARGUMENT, so it runs before the promise it feeds
        // exists and a throw from it lands outside any `.catch` attached to
        // that promise. Same for `issueNumberOf`.
        try {
          const n = issueNumberOf(issue);
          await adapter.commentOnIssue(
            n,
            buildForgeUnverifiedComment({
              detail: landing.detail,
              reason: landing.reason,
              siblings: merged.filter((m) => m.id !== issue.id),
              integrationBranch: verified.options.integrationBranch,
              sourceBranch: verified.options.sourceBranch,
              verifiedSha: landing.lastSha,
              hasResolveCommits: landing.resolveCommits,
            }),
          );
          await adapter.removeLabel(n, READY_FOR_AGENT_LABEL);
          skipped.push({ issue, reason: "forge-unverified" });
          await emit(`skip #${n} reason=forge-unverified`);
        } catch (err) {
          haltVerified(err);
        }
      }
      // The chunks in the same composed result (#64). Cycle-level like the
      // issues beside them and parked the same way: `land` comes off and the
      // pull request says the forge judged the whole composition, not this
      // chunk. The revert above already took their merges with it.
      for (const { target, sourceBranch } of chunkMergesOnHead) {
        try {
          await parkChunk(
            target,
            CHUNK_LAND_FORGE_UNVERIFIED_PR_COMMENT({
              chunkBranch: target.branch,
              sourceBranch,
              detail: landing.detail,
              siblings: merged.map((m) => issueNumberOf(m)),
            }),
            "forge-unverified",
          );
        } catch (err) {
          haltVerified(err);
        }
      }
      return nothingLanded();
    }

    // Origin has moved. From here `merged: []` would be a lie, so nothing below
    // is wrapped — see `landed`.
    landed = true;
    await emit(
      `verify landed ${landing.sha} after ${landing.rounds} round(s); closing ${merged.length} issue(s)` +
        (chunkMergesOnHead.length > 0
          ? ` and wrapping up ${chunkMergesOnHead.length} chunk(s)`
          : ""),
    );
    return settleLanding();
  }

  await emit(`push attempt 1`);
  let push = await adapter.push();
  if (push.kind === "race") {
    await emit(`push race; pull --ff-only`);
    const pull = await adapter.pullFfOnly();
    if (!pull.ok) {
      await emit(`pull --ff-only failed`);
      throw new MergerError(
        "Push to origin source branch was rejected and `git pull --ff-only` then failed " +
          "(origin source has diverged). Operator must reconcile manually.",
        nothingLanded(),
      );
    }
    await emit(`push attempt 2`);
    push = await adapter.push();
    if (push.kind === "race") {
      await emit(`push race retry exhausted`);
      throw new MergerError(
        "Push race retry exhausted: still rejected after one fast-forward pull and re-push.",
        nothingLanded(),
      );
    }
  }
  if (push.kind === "fatal") {
    await emit(`push fatal: ${push.reason}`);
    throw new MergerError(
      `Push to origin source branch failed: ${push.reason}`,
      nothingLanded(),
    );
  }

  // Origin has moved — see `landed`.
  landed = true;
  await emit(
    `push ok; closing ${merged.length} issue(s)` +
      (chunkMergesOnHead.length > 0
        ? ` and wrapping up ${chunkMergesOnHead.length} chunk(s)`
        : ""),
  );
  return settleLanding();
}

// Fault-tolerant close: the landing already happened, so one issue's transient
// close failure must not skip the close of the rest (issue #14). Retry each with
// backoff, accumulate the persistent failures, never throw here. Shared by both
// landing modes — the tracker reconciliation is identical once the source branch
// has moved.
async function closeMergedIssues(
  merged: readonly IssueRef[],
  adapter: MergerAdapter,
  deps: {
    readonly closeRetries: number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly emit: (line: string) => Promise<void>;
  },
): Promise<{ issue: IssueRef; error: string }[]> {
  const unclosed: { issue: IssueRef; error: string }[] = [];
  for (const issue of merged) {
    const n = issueNumberOf(issue);
    let lastErr = "";
    let ok = false;
    for (let attempt = 0; attempt <= deps.closeRetries; attempt++) {
      if (attempt > 0) await deps.sleep(closeBackoffMs(attempt));
      try {
        await adapter.closeIssue(n, "Completed by Sandbar");
        ok = true;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        await deps.emit(
          `close #${n} attempt ${attempt + 1} failed: ${lastErr}`,
        );
      }
    }
    if (!ok) {
      unclosed.push({ issue, error: lastErr });
      await deps.emit(
        `close #${n} giving up after ${deps.closeRetries + 1} attempt(s): ${lastErr}`,
      );
    }
  }
  return unclosed;
}

// ---------------------------------------------------------------------------
// Real adapter — shells out to git, gh, podman, and runGate.
// ---------------------------------------------------------------------------

export type RealAdapterDeps = {
  readonly cwd: string;
  // The run's podman namespace (#28), for the one container this module starts
  // — the resolve agent's. It was ANONYMOUS until #67, which meant a container
  // that died at startup could not even be named in the failure it caused; and
  // an unscoped name would be swept by no run and reported as unattributable
  // debris by every one of them.
  readonly scope: RunScope;
  // The tracker the comment / label / close calls address, NAMED rather than
  // inferred from the merger worktree's git remotes (#34). This is the phase
  // that closes issues, so a repository resolved from a directory is a repository
  // whose issues get closed for work that landed somewhere else.
  readonly repo: RepoRef;
  readonly sourceBranch: string;
  readonly botName: string;
  readonly botEmail: string;
  readonly coauthorTrailer: string;
  // The provider/model pair for the resolve invocation (#74). realAdapter
  // builds the one provider object that owns both argv and output parsing, so
  // credential routing cannot disagree with the command being invoked.
  readonly mergerAgent: AgentProviderName;
  readonly mergerModelId: string;
  // The image the resolve agent runs in — augmented with exactly the providers
  // routed by this run, unlike any gate-stack image (#24 D7, #75).
  readonly sandboxImage: string;
  readonly env: EnvReader;
  // Gate-2, already bound to the merger worktree's stack. The merger does not
  // build the stack itself: run.ts owns the stack's lifecycle for the whole
  // merge phase, so a single bringup covers every branch in the cycle.
  readonly runStackGate: () => Promise<GateResult>;
};

type CapturedAgentRun = Omit<ResolveAgentRun, "output">;

// The default merge subject, and it names an ISSUE — which is why anything
// that is not one issue's branch (a chunk, #64) carries its own
// `MergeUnit.mergeMessage` instead of being described as one.
function mergeMessageFor(issue: MergeUnit): string {
  return `Merge sandbar/issue-${issueNumberOf(issue)}: ${issue.title}`;
}

function gitAuthorEnv(deps: RealAdapterDeps): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: deps.botName,
    GIT_AUTHOR_EMAIL: deps.botEmail,
    GIT_COMMITTER_NAME: deps.botName,
    GIT_COMMITTER_EMAIL: deps.botEmail,
  };
}

// How long the stdio pipes are given to drain after the child has exited
// (#67). The capture settles on `close`, not `exit`, because `exit` fires
// before the last chunk of a large agent transcript has been delivered — and
// since an EMPTY capture is now read as an infrastructure failure and halts the
// run, settling early would turn a perfectly good attempt into a halt.
//
// `close` waits for every copy of the stdio fds to be released, though, which
// a grandchild can hold open indefinitely. So the exit is the deadline: once
// the child is gone, the pipes get this long and then the capture settles with
// whatever arrived. Otherwise the one bound on the merge phase would be a
// process that has already exited.
const STDIO_FLUSH_GRACE_MS = 2_000;

// One bounded child process, captured whole (#67).
//
// Lifted out of the adapter and exported because this is where the delicate
// part of #67 lives, and none of it is about podman: the classification, the
// pipe-drain race and the EPIPE are facts about `child_process`, so they are
// asserted by RUNNING a process rather than by mocking one. The adapter above
// contributes only the argv.
//
// SETTLES ON `close`, NOT `exit`. `exit` fires when the process is gone,
// which is before the last chunk of its stdout has been delivered to us — and
// since an empty capture is now read as an infrastructure failure that halts
// the run, settling there would turn a large, perfectly good agent transcript
// into a halt at random. `close` waits for the stdio fds instead. Its own
// hazard is the mirror image: a grandchild holding a pipe open would keep it
// from ever firing, so the exit arms a deadline (STDIO_FLUSH_GRACE_MS) and the
// capture settles with whatever arrived by then.
export function captureAgentRun(
  file: string,
  args: readonly string[],
  input: string,
  opts: { readonly container: string; readonly timeoutMs: number },
): Promise<CapturedAgentRun> {
  const startedAt = Date.now();
  return new Promise<CapturedAgentRun>((resolve) => {
    const child = spawn(file, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });

    let timedOut = false;
    let exit: { code: number | null; signal: string | null } | null = null;
    let spawnError: string | null = null;
    let settled = false;
    let flushTimer: NodeJS.Timeout | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already exited */
      }
    }, opts.timeoutMs);

    // Which of the four ways it ended, decided in ONE place so the log line,
    // the log file and the abandon comment cannot come to disagree. The
    // timeout outranks the signal it sent: that SIGTERM is ours, and reporting
    // it as "killed by a signal" would bury the one fact an operator needs,
    // which is that the full budget elapsed.
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (flushTimer) clearTimeout(flushTimer);
      const end: CapturedAgentRun["end"] = spawnError
        ? "spawn-error"
        : timedOut
          ? "timeout"
          : exit?.signal
            ? "signal"
            : "exit";
      resolve({
        stdout: out,
        stderr: err,
        end,
        exitCode: exit?.code ?? null,
        signal: exit?.signal ?? null,
        durationMs: Date.now() - startedAt,
        container: opts.container,
        ...(spawnError ? { detail: spawnError } : {}),
      });
    };

    child.on("error", (e) => {
      // The runtime never produced a process (a missing binary, EPERM). There
      // is no output coming, so there is nothing to wait to drain.
      spawnError = e.message;
      settle();
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      flushTimer = setTimeout(settle, STDIO_FLUSH_GRACE_MS);
      flushTimer.unref();
    });
    child.on("close", settle);
    // A child that exits before reading its prompt — a missing binary, an
    // agent that dies on startup, the SIGTERM above — makes this write fail
    // with EPIPE. With no listener on the stream that is an UNCAUGHT
    // exception: it would take the whole run down from inside a promise
    // executor, skipping the orchestrator's structured handling entirely. Not
    // swallowed — the handlers above still settle with whatever was captured,
    // and an invocation that captured NOTHING is classed as the infrastructure
    // failure it is (#67) rather than re-prompted.
    child.stdin.on("error", () => {
      /* the child is gone; the exit/close handlers are the reporting path */
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

// Interpret a completed capture through the SAME provider object that built
// its command. Raw streams stay on the returned run for #67's attempt log;
// only this parsed speech register is eligible to carry a resolve promise.
export function parseCapturedAgentRun(
  run: CapturedAgentRun,
  agent: AgentProvider,
): ResolveAgentRun {
  const speech = createAgentSpeechAccumulator(agent);
  for (const line of run.stdout.split(/\r?\n/)) {
    speech.ingest(agent.parseStreamLine(line));
  }
  return {
    ...run,
    // Both supported providers emit structured transport here. Resolve
    // promises therefore have no raw fallback: only events their provider
    // parser classified as agent speech may reach parseResolveSignal (#74).
    output: speech.output(""),
    detail: run.detail ?? speech.failure,
  };
}

export function buildResolveRunArgv(args: {
  readonly container: string;
  readonly cwd: string;
  readonly extraMounts: readonly string[];
  readonly image: string;
  readonly command: string;
  readonly credentials: Readonly<Record<string, string | undefined>>;
  readonly botName: string;
  readonly botEmail: string;
}): readonly string[] {
  const argv = [
    "run",
    "--rm",
    "-i",
    "--name",
    args.container,
    "--userns=keep-id",
    "--user",
    "1000:1000",
    "-v",
    `${args.cwd}:/workspace`,
    ...args.extraMounts.flatMap((mount) => ["-v", `${mount}:${mount}`]),
    "-w",
    "/workspace",
    "-e",
    "HOME=/tmp",
    "--label",
    "sandbar=true",
  ];
  for (const [key, value] of Object.entries(args.credentials)) {
    if (value) argv.push("-e", `${key}=${value}`);
  }
  argv.push(
    "-e",
    `GIT_AUTHOR_NAME=${args.botName}`,
    "-e",
    `GIT_AUTHOR_EMAIL=${args.botEmail}`,
    "-e",
    `GIT_COMMITTER_NAME=${args.botName}`,
    "-e",
    `GIT_COMMITTER_EMAIL=${args.botEmail}`,
    "--entrypoint",
    "/bin/sh",
    args.image,
    "-c",
    args.command,
  );
  return argv;
}

export function resolveAgentCredentials(
  provider: AgentProviderName,
  env: EnvReader,
): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(
    [...PROVIDER_CREDENTIALS[provider].map(({ key }) => key), "GH_TOKEN"].map(
      (key) => [key, env(key)],
    ),
  );
}

export function realAdapter(deps: RealAdapterDeps): MergerAdapter {
  const cwd = deps.cwd;
  // No resume semantics: every resolve attempt is a fresh container whose
  // prompt carries the complete state.
  const agentProvider = buildAgentProvider(deps.mergerAgent, deps.mergerModelId);
  // The merger worktree is always detached, so every push it makes is HEAD to a
  // named ref on origin, and every one of them classifies its failure the same
  // way. ONE copy of that classification (#60): the race regex is the whole
  // basis for "the target moved under this cycle, so never force and never
  // retry", which both landing targets rest on — a second copy is a git version
  // or a server phrasing a rejection differently, patched in one place and
  // silently reclassified as `fatal` in the other.
  const pushHeadTo = async (dest: string): Promise<PushResult> => {
    try {
      await exec("git", ["push", "origin", `HEAD:${dest}`], { cwd });
      return { kind: "ok" };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const stderr = e.stderr ?? "";
      if (/rejected|non-fast-forward|fetch first|stale info/i.test(stderr)) {
        return { kind: "race" };
      }
      return {
        kind: "fatal",
        reason: stderr.trim() || e.message || "unknown push error",
      };
    }
  };
  // The unmerged set. One spelling, shared by the conflict digest the resolve
  // agent reads (#67) and the mechanical version resolution that runs before it
  // (#68) — the second asks the same question twice per conflicted merge, and a
  // second copy of the flags is a chance for the two to come to disagree about
  // what "still conflicted" means. An empty list on failure is honest for both
  // readers: the comment renders no section, and the mechanical path declines.
  const unmergedPaths = async (): Promise<readonly string[]> => {
    try {
      const r = await exec("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd,
      });
      return r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  // ORIGIN's copy of a chunk branch, for the #64 landing — and the one place
  // in this file that asks the question WITHOUT `fetchOriginChunkBranch`
  // (git-ops.ts), which `chunkBase` above and #61's seeding share.
  //
  // The refspec is the same one, and so is the reason for it: ask origin every
  // time, because a chunk branch outlives the run that created it and
  // `.sandbar` is disposable, and spell the refspec explicitly (and forced) so
  // the remote-tracking ref is updated in a BARE cache too, where a plain
  // `git fetch origin <branch>` writes only FETCH_HEAD.
  //
  // What differs is WHAT A FAILED FETCH MAY BE ANSWERED WITH, and the two
  // policies are opposite because being wrong costs each caller something
  // different. A base may fall back to the tip the cache already holds (#61):
  // it is at worst one run behind, and a composition built on a stale base is
  // rejected as a non-fast-forward push. A LANDING may not. Merging a stale tip
  // lands less than the branch carries and then DELETES that branch on origin,
  // so being one fetch behind is commits gone — and answering the same failure
  // with "origin has no such branch" spends a human's `land` label and tells
  // them their branch was deleted.
  //
  // Hence three answers, and a second question to tell two of them apart:
  // `ls-remote --exit-code` exits 2 for "reached origin, no matching ref" and
  // something else non-zero for "could not ask". A probe that SUCCEEDS is
  // `unreadable` too — origin has the branch and the fetch still failed, which
  // is the transport being unreliable rather than the chunk being gone. See
  // `ChunkRefLookup`.
  const fetchChunkRef = async (
    chunkBranch: string,
  ): Promise<ChunkRefLookup> => {
    const remoteRef = `refs/remotes/origin/${chunkBranch}`;
    try {
      await exec(
        "git",
        [
          "fetch",
          "origin",
          `+refs/heads/${chunkBranch}:${remoteRef}`,
          "--quiet",
        ],
        { cwd },
      );
      return { kind: "present", ref: remoteRef };
    } catch (fetchErr) {
      const probe = await exec(
        "git",
        ["ls-remote", "--exit-code", "origin", `refs/heads/${chunkBranch}`],
        { cwd },
      ).then(
        () => null,
        (err: unknown) => err,
      );
      if (probe !== null && exitCodeOf(probe) === 2) return { kind: "absent" };
      return {
        kind: "unreadable",
        detail: gitFailureDetail(probe ?? fetchErr),
      };
    }
  };
  return {
    // The six writes a chunk wrap-up makes, from the one place they are
    // spelled (#64) — `closeIssue` and `removeLabel` among them, which the auto
    // lane has used since long before chunks existed and which are the same two
    // `gh` calls either way. Spread first so anything below can override, and
    // given this worktree as the cwd `git push --delete` runs in; the
    // reconciler passes the bare cache instead and that is the whole of the
    // difference. See `chunk-land.ts`.
    ...chunkForgeWrites({ repo: deps.repo, gitCwd: cwd, errPrefix: "merger" }),
    async mergeNoFf(unit) {
      try {
        await exec(
          "git",
          [
            "merge",
            "--no-ff",
            "--no-edit",
            "-m",
            unit.mergeMessage ?? mergeMessageFor(unit),
            "-m",
            deps.coauthorTrailer,
            unit.branch,
          ],
          { cwd, env: gitAuthorEnv(deps) },
        );
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    async runResolveAgent(prompt, attempt) {
      // Runs the routed provider inside a podman container off the SANDBOX
      // image, augmented with this run's routed providers (#75).
      // Bind-mounts the merger worktree at /workspace so
      // the agent's edits and commits are live on host. `cwd` is a git worktree
      // (detached at origin/<sourceBranch>), so its `.git` is a gitlink file
      // pointing at the parent repo's common git dir — that dir is identity-
      // mounted too so in-container git can follow the link.
      //
      // Captures stdout for the promise-token parser AND stderr, the exit
      // status, the duration and the container's name (#67). Before, stderr was
      // piped and never read: the process that told us why it could not start
      // wrote its reason into a pipe nobody had attached a listener to.
      //
      // NAMED, and scoped like everything else this run creates (#28), so the
      // existing prefix sweep reaps a leftover and the failure message has
      // something an operator can pass to `podman logs`. The uuid is what keeps
      // two cycles resolving the same issue from colliding on the name; the
      // attempt number is in it so the name is greppable against the log line.
      const container = `${scopedResourcePrefix(deps.scope)}resolve-${attempt}-${randomUUID()}`;
      const extraMounts = await gitMountsForWorktree(cwd);
      const command = agentProvider.buildPrintCommand({
        prompt,
        dangerouslySkipPermissions: true,
      });
      const args = buildResolveRunArgv({
        container,
        cwd,
        extraMounts,
        image: deps.sandboxImage,
        command: command.command,
        credentials: resolveAgentCredentials(deps.mergerAgent, deps.env),
        botName: deps.botName,
        botEmail: deps.botEmail,
      });
      const run = await captureAgentRun(RUNTIME, args, command.stdin ?? "", {
        container,
        timeoutMs: RESOLVE_AGENT_TIMEOUT_MS,
      });
      return parseCapturedAgentRun(run, agentProvider);
    },
    async isMergeInProgress() {
      // NOT `<cwd>/.git/MERGE_HEAD`. Since #10 the merger always runs in a
      // LINKED WORKTREE, whose `.git` is a gitlink file, not a directory — the
      // merge state lives at `.git/worktrees/<name>/MERGE_HEAD` in the parent
      // repo. Testing the naive path returns false unconditionally in
      // production, which silently disabled the resolve loop's "still
      // conflicted, here is the digest" re-prompt. `--git-path` resolves it
      // correctly in a worktree and in a plain checkout alike.
      try {
        const { stdout } = await exec(
          "git",
          ["rev-parse", "--git-path", "MERGE_HEAD"],
          { cwd },
        );
        const p = stdout.trim();
        if (!p) return false;
        return existsSync(isAbsolute(p) ? p : join(cwd, p));
      } catch {
        // Not a git dir at all, or git is unusable — the caller's next git
        // command will fail loudly with a better message than this one could.
        return false;
      }
    },
    async conflictDigest() {
      let status = "";
      let diff = "";
      try {
        const r = await exec("git", ["status", "--short"], { cwd });
        status = r.stdout;
      } catch {
        status = "(git status failed)";
      }
      try {
        const r = await exec("git", ["diff"], {
          cwd,
          maxBuffer: 50 * 1024 * 1024,
        });
        diff = r.stdout;
      } catch {
        diff = "(git diff failed)";
      }
      // The unmerged set, asked for as such rather than parsed back out of the
      // porcelain above (#67): the abandon comment lists these files, and a
      // status-line parser that silently produced an empty list would make a
      // hard conflict read like a broken container — the exact confusion the
      // comment exists to end. An empty list on failure is honest: the comment
      // renders no section at all rather than claiming nothing conflicted.
      return {
        status: status.trim(),
        diff: diff.trim(),
        paths: await unmergedPaths(),
      };
    },
    unmergedPaths,
    async readWorktreeFile(path) {
      try {
        return await readFile(join(cwd, path), "utf8");
      } catch {
        return null;
      }
    },
    async writeWorktreeFile(path, contents) {
      await writeFile(join(cwd, path), contents, "utf8");
    },
    async stagePath(path) {
      await exec("git", ["add", "--", path], { cwd });
    },
    async commitMerge() {
      try {
        // `--cleanup=strip` because git wrote the `# Conflicts:` block into
        // MERGE_MSG when the merge stopped, and a commit made without an
        // editor keeps comment lines by default — the merge subject and the
        // co-author trailer `mergeNoFf` supplied are the whole message this
        // should carry.
        await exec(
          "git",
          ["commit", "--no-edit", "--no-verify", "--cleanup=strip"],
          { cwd, env: gitAuthorEnv(deps) },
        );
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    async getIssueBody(issueId) {
      // Throws (SandbarError) on fetch failure: a resolve agent reasoning
      // about cross-branch intent without the issue specs is worse than a
      // halted merge phase.
      return fetchIssueText(issueId, deps.repo);
    },
    async getHeadSha() {
      const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd });
      return stdout.trim();
    },
    async resetHardSha(sha) {
      await exec("git", ["reset", "--hard", sha], { cwd });
    },
    async abortMerge() {
      try {
        await exec("git", ["merge", "--abort"], { cwd });
      } catch {
        /* best-effort */
      }
    },
    // `npm install` is sandbar's own step, and it WRITES TRACKED FILES: it
    // rewrites package-lock.json whenever the lock is out of sync with
    // package.json, which is exactly the state merging two branches that both
    // touched dependencies produces. The gate that runs next refuses a dirty
    // tree (#24 D1) — so without this the merge of two perfectly good branches
    // reds with `failedStep: worktree-clean` and a message about uncommitted
    // changes that never mentions npm, then burns the resolve budget while
    // every retry re-runs the install and re-creates the condition.
    //
    // The lockfile update genuinely belongs in the merge result, so commit it.
    // Only when the tree was CLEAN beforehand, though: a dirty tree on entry
    // means someone else's uncommitted work is in there (the resolve agent
    // leaving edits is the case gate-2's check exists to catch), and sweeping
    // that into a lockfile commit would both mislabel it and defeat the check.
    // In that case leave it alone and let the gate refuse, as it should.
    async npmInstall() {
      const dirtyBefore = await dirtyWorktreePaths(cwd);
      try {
        await exec("npm", ["install", "--no-audit", "--no-fund"], {
          cwd,
          maxBuffer: 50 * 1024 * 1024,
        });
      } catch {
        return { ok: false };
      }
      if (dirtyBefore.length > 0) return { ok: true };
      const dirtyAfter = await dirtyWorktreePaths(cwd);
      if (dirtyAfter.length === 0) return { ok: true };
      try {
        await exec("git", ["add", "-A"], { cwd });
        await exec(
          "git",
          [
            "commit",
            "--no-verify",
            "-m",
            "chore: sync dependency lockfile after merge\n\n" +
              "Written by `npm install` in the merger worktree, committed so " +
              "the gate's verdict is about a commit (#24 D1).",
          ],
          { cwd },
        );
      } catch (err) {
        // Committing sandbar's own install output is not optional — leaving it
        // uncommitted hands the next gate a guaranteed `worktree-clean` red
        // that no agent can fix. Fail loud rather than proceed into it.
        throw new SandbarError(
          "merger: `npm install` modified tracked files and they could not be " +
            `committed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      return { ok: true };
    },
    async runGate() {
      const r: GateResult = await deps.runStackGate();
      if (r.ok) return { ok: true };
      return {
        ok: false,
        stdout: r.stdout,
        stderr: r.stderr,
        failedStep: r.failedStep,
        containerLogs: r.containerLogs,
        exitCode: r.exitCode,
      };
    },
    async commentOnIssue(n, msg) {
      // Required: this comment is the merger's explanation of an abandon/revert.
      // Swallowing it would strand the human without the reason — fail loud.
      try {
        await exec("gh", [
          "issue",
          "comment",
          String(n),
          "--repo",
          repoSlug(deps.repo),
          "--body",
          msg,
        ]);
      } catch (err) {
        throw new SandbarError(
          `merger: failed to comment on issue #${n}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
    async push() {
      // The worktree is detached at origin/<sourceBranch>; push HEAD to the
      // source branch ref on origin. The operator's local branch is left
      // untouched (it fast-forwards on their next pull).
      return pushHeadTo(deps.sourceBranch);
    },
    async pullFfOnly() {
      try {
        await exec("git", ["pull", "--ff-only", "origin", deps.sourceBranch], {
          cwd,
        });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    fetchChunkRef,
    async chunkBase(chunkBranch) {
      // Ask ORIGIN, every time — `fetchOriginChunkBranch` owns that argument
      // and the refspec it rests on. Shared with the issue-branch seeding in
      // git-ops.ts since #61, because a chained member is DEVELOPED against
      // this same base: two copies of the question are two chances for the
      // tree a member was written on and the tree it is merged onto to
      // diverge, which is exactly what the by-construction no-conflict
      // property forbids.
      //
      // Null ⇒ the cache can name no such ref at all: this is the chunk's
      // first landing, and `origin/<sourceBranch>` is where a chunk branch is
      // created. A fetch that merely FAILED (network, auth, or a sibling's
      // concurrent fetch winning the ref lock) does not answer null — it
      // answers with the tip the cache already holds, which is the whole point
      // of sharing the function with the seeding. And should the cache ever be
      // wrong about a chunk that does exist, the composition is based on the
      // source branch and the push below is rejected as non-fast-forward
      // rather than silently overwriting the branch, which is the safe way to
      // be wrong.
      return (
        (await fetchOriginChunkBranch(cwd, chunkBranch)) ??
        `origin/${deps.sourceBranch}`
      );
    },
    async checkoutDetached(ref) {
      // Not `--force`: the tree is clean at every call site, and a dirty one
      // means something (a resolve agent, a gate step writing outside a
      // gitignored path) left work behind. Failing here surfaces that as a
      // halt; forcing would delete it.
      await exec("git", ["checkout", "--detach", ref], { cwd });
    },
    async pushChunkBranch(chunkBranch, issueBranches) {
      // Fully qualified, unlike the source branch's: a chunk branch may not
      // exist on origin yet, and git only creates a ref from an unambiguous
      // destination.
      try {
        await exec("git", [
          "push",
          "--atomic",
          "origin",
          `HEAD:refs/heads/${chunkBranch}`,
          ...issueBranches.map((branch) => `${branch}:refs/heads/${branch}`),
        ], { cwd });
        return { kind: "ok" };
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const stderr = e.stderr ?? "";
        if (/rejected|non-fast-forward|fetch first|stale info/i.test(stderr)) {
          return { kind: "race" };
        }
        return { kind: "fatal", reason: stderr.trim() || e.message || "unknown push error" };
      }
    },
    async ensureChunkPullRequest({ chunkBranch, title, body }) {
      // DRAFT, which is the whole mechanism (#54 Q14): it disables GitHub's
      // merge button while leaving review fully functional. Only on create —
      // `ensurePullRequest` re-titles and re-bodies a PR that already exists
      // and never touches its draft state, so a human who marked this one
      // ready for review keeps that decision. chunk-pr.ts's header owns the
      // argument.
      return ensurePullRequest({
        cwd,
        repoFlag: repoSlug(deps.repo),
        head: chunkBranch,
        base: deps.sourceBranch,
        title,
        body,
        draft: true,
      });
    },
  };
}
