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

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import type { ChunkTarget } from "./chunks.js";
import { type EnvReader } from "./env.js";
import { SandbarError } from "./errors.js";
import { dirtyWorktreePaths } from "./git-ops.js";
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
import { type RepoRef, repoSlug } from "./repo-ref.js";
import { RUNTIME } from "./runtime.js";
import {
  RESOLVE_MAX_ATTEMPTS,
  type ResolveAdapter,
  type ResolveLogger,
  runResolveLoop,
} from "./resolve-loop.js";

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

export const READY_FOR_AGENT_LABEL = "ready-for-agent";

// What a branch was being merged INTO, for the prose that has to name it (#60).
// Every comment the merge loop writes used to say "the source branch", which is
// simply false on a chunk member: nothing of its work is heading there yet, and
// an author sent to look for it on main would not find it.
export type MergeTarget =
  | { readonly kind: "source" }
  | { readonly kind: "chunk"; readonly branch: string };

export const SOURCE_TARGET: MergeTarget = { kind: "source" };

export function describeMergeTarget(target: MergeTarget): string {
  return target.kind === "source"
    ? "the source branch"
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

function buildAbandonComment(args: {
  mode: "conflict" | "gate-red";
  reason: string;
  attempts: number;
  target: MergeTarget;
}): string {
  const where = describeMergeTarget(args.target);
  if (args.mode === "conflict") {
    return [
      `Sandbar attempted to merge this branch into ${where} and the agentic resolve loop bailed after ${args.attempts} attempt${args.attempts === 1 ? "" : "s"}.`,
      "The merge has been aborted and `ready-for-agent` removed.",
      "",
      `Agent's reason: ${args.reason}`,
    ].join("\n");
  }
  return [
    `Sandbar merged this branch into ${where} locally, but the post-merge gate was still red after ${args.attempts} agentic fix attempt${args.attempts === 1 ? "" : "s"}.`,
    "The merge has been reverted and `ready-for-agent` removed.",
    "",
    `Agent's reason: ${args.reason}`,
  ].join("\n");
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
    "checks-red": "the forge's checks rejected the cycle's composed merge result",
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

export type PushResult =
  | { readonly kind: "ok" }
  | { readonly kind: "race" }
  | { readonly kind: "fatal"; readonly reason: string };

// Adapter shape. Split into the merger's own primitives and the resolve-loop
// primitives (which the merger forwards). The real adapter implements both.
export type MergerAdapter = ResolveAdapter & {
  mergeNoFf(issue: IssueRef): Promise<{ readonly ok: boolean }>;
  abortMerge(): Promise<void>;
  getHeadSha(): Promise<string>;
  resetHardSha(sha: string): Promise<void>;
  commentOnIssue(issueNum: number, msg: string): Promise<void>;
  removeLabel(issueNum: number, label: string): Promise<void>;
  closeIssue(issueNum: number, comment: string): Promise<void>;
  push(): Promise<PushResult>;
  pullFfOnly(): Promise<{ readonly ok: boolean }>;
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
  pushChunkBranch(chunkBranch: string): Promise<PushResult>;
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

// A member whose branch is on its chunk's branch AND that branch is on origin
// (#60). Recorded only after the push, so the label finalise applies from it
// never claims durability the commits do not have. Not `merged`: nothing of it
// has reached the source branch, the issue stays OPEN, and what it earns is
// `in-chunk` rather than a close.
export type ChunkLanding = {
  readonly issue: IssueRef;
  readonly chunkBranch: string;
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
    throw new Error(`Invalid issue id (expected positive integer): ${issue.id}`);
  }
  return n;
}

export function sortIssuesAsc(issues: readonly IssueRef[]): IssueRef[] {
  return [...issues].sort((a, b) => issueNumberOf(a) - issueNumberOf(b));
}

export type ChunkGroup = {
  readonly target: MergeTarget & { readonly kind: "chunk" };
  // The cycle's DONE branches for this chunk, in the order given.
  readonly members: readonly IssueRef[];
};

// The chunk-landing work of a cycle, grouped by branch and ordered by chunk
// root. One group is one checkout and one push, so grouping is what keeps the
// landing at a single call site per chunk rather than one per issue.
//
// A group with more than one member is not reachable today — the planner only
// ever picks a chunk's root, and a chunk has exactly one (see chunks.ts) — but
// grouping rather than assuming that keeps #61's chained members a change to
// the planner alone.
export function groupByChunk(issues: readonly IssueRef[]): readonly ChunkGroup[] {
  const byBranch = new Map<string, { root: number; members: IssueRef[] }>();
  for (const issue of issues) {
    const chunk = issue.chunk;
    if (!chunk) continue;
    const existing = byBranch.get(chunk.branch);
    if (existing) existing.members.push(issue);
    else byBranch.set(chunk.branch, { root: chunk.root, members: [issue] });
  }
  return [...byBranch.entries()]
    .sort((a, b) => a[1].root - b[1].root)
    .map(([branch, { members }]) => ({
      target: { kind: "chunk" as const, branch },
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
  // `merged` is `[]` on every one of these, never the local array — see
  // `landed` for the exact reason that is a fact rather than a hope, and for
  // the one window where it stops being one.
  //
  // `chunkLanded` is the opposite: it is carried VERBATIM, because those
  // commits really are on origin (the entry is written after the push) and the
  // issues really do need their `in-chunk` label. Landing a chunk does not move
  // the source branch, so it takes nothing away from the `merged: []` claim
  // beside it — the two answer different questions.
  //
  // The original error rides along as `cause`. Without it an unexpected bug —
  // as opposed to a designed `SandbarError` — arrives at run.ts's merger-halted
  // branch as a bare message, and that branch is precisely the one that does
  // NOT reach the top-level handler that would have printed a stack.
  const asHalt =
    (context: string) =>
    (err: unknown): never => {
      if (err instanceof MergerError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new MergerError(
        `${context}: ${msg}`,
        { merged: [], chunkLanded: [...chunkLanded], skipped, pushed: false, unclosed: [] },
        { cause: err },
      );
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

  // One branch, merged onto whatever the worktree is currently detached at.
  // TRUE when a commit for this issue is on that HEAD; FALSE when the issue was
  // skipped and HEAD is back where it was. Shared verbatim by both landing
  // targets (#60) — `target` only ever reaches the prose and the log, because
  // conflict resolution, the gate and the revert are the same operations
  // whichever branch is underneath.
  const mergeOne = async (
    issue: IssueRef,
    target: MergeTarget,
  ): Promise<boolean> => {
    try {
      const n = issueNumberOf(issue);
      const relatedIssues = cycle.filter((c) => c.id !== issue.id);

      await emit(`merge-attempt #${n} ${issue.branch}`);
      const preMergeSha = await adapter.getHeadSha();
      const m = await adapter.mergeNoFf(issue);

      if (!m.ok) {
        await emit(`conflict #${n} entering resolve-loop`);
        const outcome = await runResolveLoop(
          issue,
          relatedIssues,
          { kind: "conflict" },
          adapter,
          { projectAnchor, preMergeSha, target: describeMergeTarget(target) },
          resolveLog,
        );
        if (outcome.kind === "abandon") {
          if (outcome.mergeInProgress) {
            await adapter.abortMerge();
          } else {
            await adapter.resetHardSha(preMergeSha);
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
              mode: "conflict",
              reason: outcome.reason,
              attempts: RESOLVE_MAX_ATTEMPTS,
              target,
            }),
          );
          await adapter.removeLabel(n, READY_FOR_AGENT_LABEL);
          skipped.push({ issue, reason: "conflict" });
          await emit(`skip #${n} reason=conflict resolve-abandon: ${outcome.reason}`);
          return false;
        }
        await emit(`merged #${n} (via resolve-loop)`);
        return true;
      }

      const inst = await adapter.npmInstall();
      if (!inst.ok) {
        await adapter.resetHardSha(preMergeSha);
        await adapter.commentOnIssue(n, buildInstallFailedComment(target));
        await adapter.removeLabel(n, READY_FOR_AGENT_LABEL);
        skipped.push({ issue, reason: "install-failed" });
        await emit(`skip #${n} reason=install-failed`);
        return false;
      }

      const g = await adapter.runGate();
      if (!g.ok) {
        if (onGateRed) {
          await onGateRed(issue.id, {
            stdout: g.stdout,
            stderr: g.stderr,
            failedStep: g.failedStep,
            exitCode: g.exitCode,
            containerLogs: g.containerLogs,
          });
        }
        await emit(
          `gate-red #${n} failedStep=${g.failedStep ?? "-"} exitCode=${g.exitCode}; entering resolve-loop`,
        );
        const outcome = await runResolveLoop(
          issue,
          relatedIssues,
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
          { projectAnchor, preMergeSha, target: describeMergeTarget(target) },
          resolveLog,
        );
        if (outcome.kind === "abandon") {
          await adapter.resetHardSha(preMergeSha);
          if (outcome.silent) {
            // Same silent-abandon handling as the conflict path — the agent
            // reverted the merge commit instead of fixing the gate. Treat as a
            // fresh-attempt candidate.
            skipped.push({ issue, reason: "silent-noop" });
            await emit(`skip #${n} reason=silent-noop: ${outcome.reason}`);
            return false;
          }
          await adapter.commentOnIssue(
            n,
            buildAbandonComment({
              mode: "gate-red",
              reason: outcome.reason,
              attempts: RESOLVE_MAX_ATTEMPTS,
              target,
            }),
          );
          await adapter.removeLabel(n, READY_FOR_AGENT_LABEL);
          skipped.push({ issue, reason: "gate-red" });
          await emit(`skip #${n} reason=gate-red resolve-abandon: ${outcome.reason}`);
          return false;
        }
        await emit(`merged #${n} (gate-red recovered via resolve-loop)`);
        return true;
      }

      await emit(`merged #${n}`);
      return true;
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
  const sorted = sortIssuesAsc(issues);
  const chunkGroups = groupByChunk(sorted);
  // The sha the worktree entered on, i.e. `origin/<sourceBranch>`, to return to
  // after the chunk landings have moved HEAD. Read only when there is a chunk
  // to land, so a cycle without one makes no extra call.
  const sourceBaseSha =
    chunkGroups.length > 0 ? await adapter.getHeadSha() : null;

  for (const group of chunkGroups) {
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
      continue;
    }
    // The one place a chunk branch is written, and the reason the whole group
    // is merged before it: a member is only ever recorded as landed once the
    // commits carrying it are on origin.
    const push = await adapter
      .pushChunkBranch(branch)
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
        { merged: [], chunkLanded: [...chunkLanded], skipped, pushed: false, unclosed: [] },
      );
    }
    for (const member of landedMembers) {
      chunkLanded.push({ issue: member, chunkBranch: branch });
    }
    await emit(
      `chunk ${branch}: landed ${landedMembers.map((m) => `#${issueNumberOf(m)}`).join(", ")} and pushed`,
    );
  }

  // Back to where the cycle started, so the source-branch pass below merges
  // onto `origin/<sourceBranch>` and not onto the last chunk it happened to
  // land. Nothing else in this function moves HEAD across issues.
  if (sourceBaseSha !== null) {
    await adapter
      .checkoutDetached(sourceBaseSha)
      .catch(asHalt("Could not return the merger worktree to the source branch"));
  }

  // ---------------------------------------------------------------------
  // Phase B: the source-branch pass — the auto lane, unchanged since #22.
  // ---------------------------------------------------------------------
  for (const issue of sorted) {
    if (issue.chunk) continue;
    if (await mergeOne(issue, SOURCE_TARGET)) merged.push(issue);
  }

  if (merged.length === 0) {
    await emit(`no merges, no push`);
    return { merged, chunkLanded, skipped, pushed: false, unclosed: [] };
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

    const landing = await runVerifiedLanding(
      {
        ...verified.options,
        mergedIssues: merged,
        cycleIssues: cycle,
        projectAnchor,
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
        {
          merged: [],
          chunkLanded,
          skipped,
          pushed: false,
          unclosed: [],
        },
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
      return { merged: [], chunkLanded, skipped, pushed: false, unclosed: [] };
    }

    // Origin has moved. From here `merged: []` would be a lie, so nothing below
    // is wrapped — see `landed`.
    landed = true;
    await emit(
      `verify landed ${landing.sha} after ${landing.rounds} round(s); closing ${merged.length} issue(s)`,
    );
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
    };
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
        { merged: [], chunkLanded, skipped, pushed: false, unclosed: [] },
      );
    }
    await emit(`push attempt 2`);
    push = await adapter.push();
    if (push.kind === "race") {
      await emit(`push race retry exhausted`);
      throw new MergerError(
        "Push race retry exhausted: still rejected after one fast-forward pull and re-push.",
        { merged: [], chunkLanded, skipped, pushed: false, unclosed: [] },
      );
    }
  }
  if (push.kind === "fatal") {
    await emit(`push fatal: ${push.reason}`);
    throw new MergerError(`Push to origin source branch failed: ${push.reason}`, {
      merged: [],
      chunkLanded,
      skipped,
      pushed: false,
      unclosed: [],
    });
  }

  // Origin has moved — see `landed`.
  landed = true;
  await emit(`push ok; closing ${merged.length} issue(s)`);
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
  };
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
        await deps.emit(`close #${n} attempt ${attempt + 1} failed: ${lastErr}`);
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
  // The tracker the comment / label / close calls address, NAMED rather than
  // inferred from the merger worktree's git remotes (#34). This is the phase
  // that closes issues, so a repository resolved from a directory is a repository
  // whose issues get closed for work that landed somewhere else.
  readonly repo: RepoRef;
  readonly sourceBranch: string;
  readonly botName: string;
  readonly botEmail: string;
  readonly coauthorTrailer: string;
  readonly modelId: string;
  // The image the resolve agent runs in — claude is installed there, not in
  // any gate-stack image (#24 D7).
  readonly sandboxImage: string;
  readonly env: EnvReader;
  // Gate-2, already bound to the merger worktree's stack. The merger does not
  // build the stack itself: run.ts owns the stack's lifecycle for the whole
  // merge phase, so a single bringup covers every branch in the cycle.
  readonly runStackGate: () => Promise<GateResult>;
};

function mergeMessageFor(issue: IssueRef): string {
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

// 10 minutes per agent invocation: each iteration may need to read multiple
// related issues + the conflict / gate trace + edit files. The loop above
// bounds total agentic time at RESOLVE_MAX_ATTEMPTS × this.
const RESOLVE_AGENT_TIMEOUT_MS = 10 * 60_000;

export function realAdapter(deps: RealAdapterDeps): MergerAdapter {
  const cwd = deps.cwd;
  return {
    async mergeNoFf(issue) {
      try {
        await exec(
          "git",
          [
            "merge",
            "--no-ff",
            "--no-edit",
            "-m",
            mergeMessageFor(issue),
            "-m",
            deps.coauthorTrailer,
            issue.branch,
          ],
          { cwd, env: gitAuthorEnv(deps) },
        );
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    async runResolveAgent(prompt) {
      // Runs claude inside a podman container off the SANDBOX image (claude is
      // pre-installed there; no gate-stack image is required to have it).
      // Bind-mounts the merger worktree at /workspace so
      // the agent's edits and commits are live on host. `cwd` is a git worktree
      // (detached at origin/<sourceBranch>), so its `.git` is a gitlink file
      // pointing at the parent repo's common git dir — that dir is identity-
      // mounted too so in-container git can follow the link. Captures stdout
      // for the promise-token parser to inspect.
      const extraMounts = await gitMountsForWorktree(cwd);
      const stdout = await new Promise<string>((resolve) => {
        const args: string[] = [
          "run",
          "--rm",
          "-i",
          "--userns=keep-id",
          "--user",
          "1000:1000",
          "-v",
          `${cwd}:/workspace`,
          ...extraMounts.flatMap((m) => ["-v", `${m}:${m}`]),
          "-w",
          "/workspace",
          "-e",
          "HOME=/tmp",
          "--label",
          "sandbar=true",
        ];
        for (const key of [
          "CLAUDE_CODE_OAUTH_TOKEN",
          "ANTHROPIC_API_KEY",
          "GH_TOKEN",
        ]) {
          const v = deps.env(key);
          if (v) args.push("-e", `${key}=${v}`);
        }
        args.push(
          "-e",
          `GIT_AUTHOR_NAME=${deps.botName}`,
          "-e",
          `GIT_AUTHOR_EMAIL=${deps.botEmail}`,
          "-e",
          `GIT_COMMITTER_NAME=${deps.botName}`,
          "-e",
          `GIT_COMMITTER_EMAIL=${deps.botEmail}`,
        );
        args.push(
          "--entrypoint",
          "claude",
          deps.sandboxImage,
          "--print",
          "--dangerously-skip-permissions",
          "--model",
          deps.modelId,
          "-p",
          "-",
        );
        const child = spawn(RUNTIME, args, {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let buf = "";
        child.stdout.on("data", (chunk) => {
          buf += chunk.toString();
        });
        const timer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            /* already exited */
          }
        }, RESOLVE_AGENT_TIMEOUT_MS);
        child.on("error", () => {
          clearTimeout(timer);
          resolve(buf);
        });
        child.on("exit", () => {
          clearTimeout(timer);
          resolve(buf);
        });
        // A child that exits before reading its prompt — a missing binary, an
        // agent that dies on startup, the SIGTERM above — makes this write
        // fail with EPIPE. With no listener on the stream that is an UNCAUGHT
        // exception: it would take the whole run down from inside a promise
        // executor, skipping the orchestrator's structured handling entirely.
        // Not swallowed — the exit/error handlers above still resolve with
        // whatever was captured, and an agent that produced no promise token
        // is re-prompted by the caller.
        child.stdin.on("error", () => {
          /* the child is gone; its exit handler is the reporting path */
        });
        child.stdin.write(prompt);
        child.stdin.end();
      });
      return { stdout };
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
      return { status: status.trim(), diff: diff.trim() };
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
    async removeLabel(n, label) {
      // Required: this is the twin of the #8 bug — silently failing to drop
      // `ready-for-agent` leaves the issue on the queue to be re-picked forever.
      try {
        await exec("gh", [
          "issue",
          "edit",
          String(n),
          "--repo",
          repoSlug(deps.repo),
          "--remove-label",
          label,
        ]);
      } catch (err) {
        throw new SandbarError(
          `merger: failed to remove label '${label}' from issue #${n}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
    async closeIssue(n, comment) {
      // Throws on a single failed attempt; the close loop in
      // runMergerWithAdapter retries with backoff and, if every attempt fails,
      // records the issue in MergerSummary.unclosed (issue #14). The queue label
      // is dropped by Phase 4 regardless, so a persistently-un-closable issue is
      // left OPEN but de-queued (never re-picked), and the operator is told.
      try {
        await exec("gh", [
          "issue",
          "close",
          String(n),
          "--repo",
          repoSlug(deps.repo),
          "--comment",
          comment,
        ]);
      } catch (err) {
        throw new SandbarError(
          `merger: failed to close issue #${n} after merging it: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
    async push() {
      try {
        // The worktree is detached at origin/<sourceBranch>; push HEAD to the
        // source branch ref on origin. The operator's local branch is left
        // untouched (it fast-forwards on their next pull).
        await exec(
          "git",
          ["push", "origin", `HEAD:${deps.sourceBranch}`],
          { cwd },
        );
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
    async chunkBase(chunkBranch) {
      // Ask ORIGIN, every time. A chunk branch outlives the run that created
      // it and `.sandbar` is disposable, so a local ref is at best a cache and
      // at worst a stale answer that would land this cycle's member on a base
      // missing an earlier one. The refspec is explicit (and forced) so the
      // remote-tracking ref is updated in a BARE cache too, where a plain
      // `git fetch origin <branch>` writes only FETCH_HEAD.
      const remoteRef = `refs/remotes/origin/${chunkBranch}`;
      try {
        await exec(
          "git",
          ["fetch", "origin", `+refs/heads/${chunkBranch}:${remoteRef}`, "--quiet"],
          { cwd },
        );
        return remoteRef;
      } catch {
        // Origin has no such branch: this is the chunk's first landing, and
        // `origin/<sourceBranch>` is where a chunk branch is created. A fetch
        // that failed for some OTHER reason (network, auth) lands here too and
        // reads as "first landing" — the composition would then be based on
        // the source branch and the push below would be rejected as
        // non-fast-forward rather than silently overwriting the branch, which
        // is the safe way for this to be wrong.
        return `origin/${deps.sourceBranch}`;
      }
    },
    async checkoutDetached(ref) {
      // Not `--force`: the tree is clean at every call site, and a dirty one
      // means something (a resolve agent, a gate step writing outside a
      // gitignored path) left work behind. Failing here surfaces that as a
      // halt; forcing would delete it.
      await exec("git", ["checkout", "--detach", ref], { cwd });
    },
    async pushChunkBranch(chunkBranch) {
      try {
        await exec(
          "git",
          ["push", "origin", `HEAD:refs/heads/${chunkBranch}`],
          { cwd },
        );
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
    },
  };
}
