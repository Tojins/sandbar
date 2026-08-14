// Procedural merger — lands DONE branches on the source branch, with an
// agentic resolve loop covering conflict, post-merge gate-red, and (in verified
// mode) a red forge.
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

import { type EnvReader } from "./env.js";
import { SandbarError } from "./errors.js";
import {
  type VerifiedFailureReason,
  type VerifiedLandingOptions,
  type VerifyAdapter,
  runVerifiedLanding,
} from "./forge-verify.js";
import { type GateResult, runGate } from "./gate.js";
import { fetchIssueText } from "./issue-anchor.js";
import { gitMountsForWorktree } from "./merger-worktree.js";
import type { GateCommand } from "./config.js";
import { RUNTIME } from "./db-sidecar.js";
import {
  RESOLVE_MAX_ATTEMPTS,
  type ResolveAdapter,
  type ResolveLogger,
  runResolveLoop,
} from "./resolve-loop.js";

export type MergerGateOutput = {
  readonly stdout: string;
  readonly stderr: string;
  readonly failedStep: "check" | "test" | null;
  readonly exitCode: number;
};

const exec = promisify(execFile);

export const READY_FOR_AGENT_LABEL = "ready-for-agent";

export const INSTALL_FAILED_COMMENT =
  "Sandbar merged this branch into the source branch locally, but `npm install` against " +
  "the merged tree failed — the post-merge gate could not run. The merge has been " +
  "reverted and `ready-for-agent` removed; please investigate the dependency change " +
  "before re-labelling.";

function buildAbandonComment(args: {
  mode: "conflict" | "gate-red";
  reason: string;
  attempts: number;
}): string {
  if (args.mode === "conflict") {
    return [
      `Sandbar attempted to merge this branch into the source branch and the agentic resolve loop bailed after ${args.attempts} attempt${args.attempts === 1 ? "" : "s"}.`,
      "The merge has been aborted and `ready-for-agent` removed.",
      "",
      `Agent's reason: ${args.reason}`,
    ].join("\n");
  }
  return [
    `Sandbar merged this branch into the source branch locally, but the post-merge gate was still red after ${args.attempts} agentic fix attempt${args.attempts === 1 ? "" : "s"}.`,
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

export type MergerSummary = {
  readonly merged: readonly IssueRef[];
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

  constructor(message: string, partial?: MergerSummary) {
    super(message);
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
    // Test seams for the check-poll clock.
    readonly sleep?: (ms: number) => Promise<void>;
    readonly now?: () => number;
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
  const skipped: { issue: IssueRef; reason: SkipReason }[] = [];
  const cycle = opts.cycleIssues ?? issues;
  const projectAnchor = opts.projectAnchor ?? "";
  const closeRetries = opts.closeRetries ?? CLOSE_MAX_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;
  const emit = async (line: string): Promise<void> => {
    if (log) await log(line);
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

  for (const issue of sortIssuesAsc(issues)) {
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
        { projectAnchor, preMergeSha },
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
          continue;
        }
        await adapter.commentOnIssue(
          n,
          buildAbandonComment({
            mode: "conflict",
            reason: outcome.reason,
            attempts: RESOLVE_MAX_ATTEMPTS,
          }),
        );
        await adapter.removeLabel(n, READY_FOR_AGENT_LABEL);
        skipped.push({ issue, reason: "conflict" });
        await emit(`skip #${n} reason=conflict resolve-abandon: ${outcome.reason}`);
        continue;
      }
      merged.push(issue);
      await emit(`merged #${n} (via resolve-loop)`);
      continue;
    }

    const inst = await adapter.npmInstall();
    if (!inst.ok) {
      await adapter.resetHardSha(preMergeSha);
      await adapter.commentOnIssue(n, INSTALL_FAILED_COMMENT);
      await adapter.removeLabel(n, READY_FOR_AGENT_LABEL);
      skipped.push({ issue, reason: "install-failed" });
      await emit(`skip #${n} reason=install-failed`);
      continue;
    }

    const g = await adapter.runGate();
    if (!g.ok) {
      if (onGateRed) {
        await onGateRed(issue.id, {
          stdout: g.stdout,
          stderr: g.stderr,
          failedStep: g.failedStep,
          exitCode: g.exitCode,
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
          },
        },
        adapter,
        { projectAnchor, preMergeSha },
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
          continue;
        }
        await adapter.commentOnIssue(
          n,
          buildAbandonComment({
            mode: "gate-red",
            reason: outcome.reason,
            attempts: RESOLVE_MAX_ATTEMPTS,
          }),
        );
        await adapter.removeLabel(n, READY_FOR_AGENT_LABEL);
        skipped.push({ issue, reason: "gate-red" });
        await emit(`skip #${n} reason=gate-red resolve-abandon: ${outcome.reason}`);
        continue;
      }
      merged.push(issue);
      await emit(`merged #${n} (gate-red recovered via resolve-loop)`);
      continue;
    }

    merged.push(issue);
    await emit(`merged #${n}`);
  }

  if (merged.length === 0) {
    await emit(`no merges, no push`);
    return { merged, skipped, pushed: false, unclosed: [] };
  }

  if (verified) {
    // Everything from here to the end of the cycle runs AFTER issues have been
    // commented on and de-labelled earlier in this loop, so anything that
    // escapes must still carry that tracker state to Phase 4 — otherwise those
    // issues end with `ready-for-agent` stripped and no handoff label: off the
    // planner's list and off every human's filter.
    //
    // This re-throws rather than absorbing: verified landing reaches the forge
    // over the network and through `gh`, so unlike the local merge path it has
    // genuine infrastructure failures (an unreachable API for three consecutive
    // polls, an unreadable response, a `gh` without the right scope). Those must
    // still stop the run loudly — MergerError is precisely a loud halt that
    // finalises first.
    const asHalt = (err: unknown): never => {
      if (err instanceof MergerError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new MergerError(`Verified merge failed: ${msg}`, {
        merged: [],
        skipped,
        pushed: false,
        unclosed: [],
      });
    };

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
        ...(verified.sleep ? { sleep: verified.sleep } : {}),
        ...(verified.now ? { now: verified.now } : {}),
      },
    ).catch(asHalt);

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
      await adapter.resetHardSha(verified.cycleBaseSha).catch(asHalt);
      for (const issue of merged) {
        const n = issueNumberOf(issue);
        await adapter
          .commentOnIssue(
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
          )
          .catch(asHalt);
        await adapter.removeLabel(n, READY_FOR_AGENT_LABEL).catch(asHalt);
        skipped.push({ issue, reason: "forge-unverified" });
        await emit(`skip #${n} reason=forge-unverified`);
      }
      return { merged: [], skipped, pushed: false, unclosed: [] };
    }

    await emit(
      `verify landed ${landing.sha} after ${landing.rounds} round(s); closing ${merged.length} issue(s)`,
    );
    return {
      merged,
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
        { merged: [], skipped, pushed: false, unclosed: [] },
      );
    }
    await emit(`push attempt 2`);
    push = await adapter.push();
    if (push.kind === "race") {
      await emit(`push race retry exhausted`);
      throw new MergerError(
        "Push race retry exhausted: still rejected after one fast-forward pull and re-push.",
        { merged: [], skipped, pushed: false, unclosed: [] },
      );
    }
  }
  if (push.kind === "fatal") {
    await emit(`push fatal: ${push.reason}`);
    throw new MergerError(`Push to origin source branch failed: ${push.reason}`, {
      merged: [],
      skipped,
      pushed: false,
      unclosed: [],
    });
  }

  await emit(`push ok; closing ${merged.length} issue(s)`);
  return {
    merged,
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
  readonly sourceBranch: string;
  readonly botName: string;
  readonly botEmail: string;
  readonly coauthorTrailer: string;
  readonly modelId: string;
  readonly gateImage: string;
  readonly gateCommands: GateCommand;
  readonly env: EnvReader;
  readonly gateOpts: {
    readonly worktreePath: string;
    readonly networkName: string;
    readonly dbHost: string;
    readonly dbPort: number;
    readonly gateEnv: Readonly<Record<string, string>>;
  };
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
      // Runs claude inside a podman container off the gate image (claude is
      // pre-installed there). Bind-mounts the merger worktree at /workspace so
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
          deps.gateImage,
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
      return fetchIssueText(issueId, cwd);
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
    async npmInstall() {
      try {
        await exec("npm", ["install", "--no-audit", "--no-fund"], {
          cwd,
          maxBuffer: 50 * 1024 * 1024,
        });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    async runGate() {
      const r: GateResult = await runGate({
        ...deps.gateOpts,
        gateImage: deps.gateImage,
        gateCommands: deps.gateCommands,
      });
      if (r.ok) return { ok: true };
      return {
        ok: false,
        stdout: r.stdout,
        stderr: r.stderr,
        failedStep: r.failedStep,
        exitCode: r.exitCode,
      };
    },
    async commentOnIssue(n, msg) {
      // Required: this comment is the merger's explanation of an abandon/revert.
      // Swallowing it would strand the human without the reason — fail loud.
      try {
        await exec("gh", ["issue", "comment", String(n), "--body", msg], {
          cwd,
        });
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
        await exec(
          "gh",
          ["issue", "edit", String(n), "--remove-label", label],
          { cwd },
        );
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
        await exec(
          "gh",
          ["issue", "close", String(n), "--comment", comment],
          { cwd },
        );
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
  };
}
