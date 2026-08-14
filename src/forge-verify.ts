// Forge-verified landing (#22) — the merge result is proven green *on the
// forge* before it is allowed to reach the source branch.
//
// Why this exists at all, given the merger already runs a local post-merge
// gate: independence, not coverage. The local gate and the code under test
// share one process, one podman, one image cache, one env file and one author
// (sandbar). A misread exit code, a sidecar that never came up being treated
// as green, a silently skipped step — nothing disagrees. CI is a second,
// independently authored implementation of "does this work" on a different
// runtime. Running the same suites locally buys correlated confidence, not a
// second opinion. Expanding the local gate can close a coverage gap; it can
// never close this one.
//
// The concrete trigger: a consumer whose `deploy` workflow fires on
// `push: branches: [main]` and trusts main blindly because "the tests workflow
// is the merge gate". Sandbar's direct `git push origin HEAD:main` matches
// neither `pull_request` nor `push: branches-ignore: [main]`, so CI never runs
// and the deploy ships an unverified sha. Branch protection can't backstop it
// on a private free-plan repo (the protection API 403s), so sandbar is the
// enforcer.
//
// Shape — deliberately the cheap one. A branch push already triggers CI on a
// `branches-ignore` workflow, so no pull request is required to get a verdict.
// Once per CYCLE (not per issue, not per implementer attempt), after the
// existing local merge + resolve loop + local gate have produced a green merge
// result in the merger worktree:
//
//   1. force-push that result to `integrationBranch` (a scratch ref sandbar owns)
//   2. poll check runs for the exact sha pushed
//   3. green → fast-forward `git push origin <sha>:<sourceBranch>`; the deploy
//      now fires on a sha the forge verified
//   4. red   → feed the failing jobs' logs to the existing resolve loop, which
//      commits a fix in the merger worktree; re-push, re-poll (bounded by
//      VERIFY_MAX_ROUNDS)
//   5. checks never conclude → park. NEVER fast-forward on unknown state.
//
// Polling is keyed on the pushed SHA, not the branch: a later round moves the
// branch, and sha-scoping makes every stale verdict structurally unreachable.
//
// Reading a sha's checks correctly is harder than it looks, and every one of
// these is a way to land a red sha if you get it wrong:
//
//   * PAGINATION. `/check-runs` pages at 100. A matrix repo routinely reports
//     several hundred runs for one sha, and the API documents no ordering, so
//     the failing run is as likely to be on page 3 as page 1. The listing walks
//     every page and cross-checks the count against the envelope's
//     `total_count`; a short read is reported as INCOMPLETE and read as pending,
//     never as "everything I can see passed".
//   * SUPERSESSION IS PER SUITE, NOT PER NAME. Re-running a job produces a
//     newer run of the same name in the SAME check suite, and only then does the
//     newer one supersede. Two different suites (`on: [push, pull_request]`, or
//     two workflows that happen to name a job identically) legitimately report
//     the same name for the same sha, and both verdicts count. Collapsing on
//     name alone lets a green run in one suite mask a failure in another.
//   * CHECKS APPEAR LATE. A `workflow_run`-chained workflow, a matrix expanded
//     from `fromJSON(needs.*.outputs)`, an app that posts its check after the
//     run it consumes — none of these exist at the first poll. A snapshot in
//     which everything visible has passed is therefore NOT a verdict, which is
//     why green must hold still across GREEN_SETTLE_POLLS consecutive polls
//     with an unchanged run set before it counts.
//   * A CHECK THAT NEVER APPEARS AT ALL is invisible to all of the above, so
//     verified mode requires `requiredChecks` to be named (enforced in
//     config.ts). Those names are the floor: each must exist and pass. Nothing
//     else can distinguish "the workflow isn't triggered for this ref" from
//     "the workflow hasn't got here yet".
//   * "SKIPPED" IS NOT "PASSED". A job gated by `if:` or a `paths` filter
//     concludes `skipped` having run nothing. Branch protection counts that as
//     satisfied; this module does not, because a skipped test job is precisely
//     the state it exists to catch.
//
// Attribution: the landing is always a fast-forward push of commits sandbar
// authored locally, never a server-side merge. `openPullRequest` adds a PR as
// an audit/review handle *around* that push (the forge marks it merged once its
// commits become ancestors of the base), so turning it on never changes who
// authored what.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ResolvedMergeMode } from "./config.js";
import { SandbarError } from "./errors.js";
import { lastNLines, stripAnsi, summarizeGateFailure } from "./gate.js";
import {
  type IssueRef,
  type ResolveAdapter,
  type ResolveLogger,
  runResolveLoop,
} from "./resolve-loop.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 50 * 1024 * 1024;

// How many push→verify rounds a cycle may spend. Round 1 is the initial
// verification; each further round costs a full CI wall-clock, so the budget is
// small on purpose — the resolve loop gets at most VERIFY_MAX_ROUNDS - 1 shots
// at a red forge before the cycle is parked for a human.
export const VERIFY_MAX_ROUNDS = 3;

// Per failing job, how much of its log reaches the resolve prompt.
export const FORGE_LOG_LINES_PER_JOB = 200;

// How many consecutive polls must report the SAME green run set before green is
// believed. Checks keep being created on a sha after earlier ones finish, so a
// single all-green snapshot is a race, not a verdict. Two polls one interval
// apart is cheap (the verdict costs one extra pollIntervalMs) and closes the
// window for anything the forge dispatches off another check's completion.
export const GREEN_SETTLE_POLLS = 2;

// How many failing jobs' logs are fetched and shown to the resolve agent. A
// matrix red can fail 50 jobs; they are near-identical, each log is up to
// megabytes, and the fetch is serial. The elision is reported in the trace so
// the agent is never silently shown a partial picture.
export const MAX_FAILED_JOB_LOGS = 5;

// Check-run listing paging. The cap exists only so a pathological response
// can't spin forever; 20 × 100 is far past any real sha (the largest observed
// in the wild is a few hundred), and hitting it yields an INCOMPLETE listing,
// which parks the cycle rather than landing on a partial read.
export const CHECK_RUN_PAGE_SIZE = 100;
export const CHECK_RUN_PAGE_LIMIT = 20;

// Consecutive listCheckRuns failures tolerated before the poll gives up. A
// 20-minute wait at a 15s interval is ~80 API calls; a single 502 from the forge
// must not discard a cycle's merges. Sustained failure still throws — loudly,
// per the fail-loud rule — rather than being read as "no checks".
export const CHECK_POLL_MAX_CONSECUTIVE_ERRORS = 3;

// Check-run conclusions that count as "this check passed". Everything else —
// failure, timed_out, cancelled, action_required, stale, startup_failure, an
// unknown future value, or a completed run with a null conclusion — counts as
// red. Unknown means red: the whole point of this module is to refuse to land
// on state it cannot read.
//
// `skipped` is deliberately NOT here. GitHub's own branch protection treats a
// skipped check as satisfied, but branch protection isn't making this module's
// claim. A job skipped by an `if:` guard or a `paths` filter ran no tests, and
// "the test job didn't actually run" is the exact failure verified mode exists
// to catch — a required check that reports `skipped` is not a verdict, it is
// the absence of one.
export const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set([
  "success",
  "neutral",
]);

export type ForgeCheckRun = {
  // Check-run id. Monotonic on the forge, so it doubles as the recency key when
  // one commit carries several runs of the same check name IN THE SAME SUITE.
  readonly id: number;
  // Check-suite id. Part of the supersession key: a re-run supersedes within its
  // suite, but two suites reporting the same name are two independent verdicts.
  readonly suiteId: number;
  readonly name: string;
  // queued | in_progress | completed
  readonly status: string;
  readonly conclusion: string | null;
  // e.g. https://github.com/o/r/actions/runs/123/job/456 — the job id in here is
  // what `gh run view --job` needs to fetch the failing log.
  readonly detailsUrl: string;
};

// What the forge reported for a sha, plus whether that list is known to be the
// WHOLE list. `complete: false` means the walk could not account for every run
// the API said exists (a short page read, a page cap, a mid-walk race). An
// incomplete listing can never produce a verdict — see waitForChecks.
export type CheckRunListing = {
  readonly runs: readonly ForgeCheckRun[];
  readonly complete: boolean;
};

export type ChecksVerdict =
  | { readonly kind: "pending"; readonly waitingOn: readonly string[] }
  | { readonly kind: "green"; readonly names: readonly string[] }
  | { readonly kind: "red"; readonly failed: readonly ForgeCheckRun[] };

// ---------------------------------------------------------------------------
// Pure aggregation.
// ---------------------------------------------------------------------------

/**
 * Collapse superseded check runs to the newest run per (suite, name).
 *
 * Re-running a job leaves the old run visible on the sha; without this a
 * superseded red would sink a commit the forge considers green. But the
 * supersession is only real WITHIN a check suite. GitHub returns runs for every
 * suite attached to the sha, and two suites reporting the same job name (a
 * workflow on `[push, pull_request]`, or two workflows with a job called
 * `build`) are two independent verdicts — collapsing them on name alone lets
 * the higher-id one silently erase the other's failure, which is not a
 * hypothetical: it is the common shape on any repo with dual triggers.
 */
export function latestPerCheck(
  runs: readonly ForgeCheckRun[],
): readonly ForgeCheckRun[] {
  const byCheck = new Map<string, ForgeCheckRun>();
  for (const r of runs) {
    // suiteId is numeric, so the first space is always the separator and the
    // composite key is unambiguous however the check name is spelled.
    const key = `${r.suiteId} ${r.name}`;
    const prev = byCheck.get(key);
    if (!prev || r.id > prev.id) byCheck.set(key, r);
  }
  return [...byCheck.values()];
}

/**
 * Verdict over a sha's check runs.
 *
 * With `requiredChecks` named — which verified mode enforces — those names are
 * the floor: each must EXIST and every run reporting it (in any suite) must
 * pass. A name that has not appeared keeps the verdict pending, so "the
 * workflow was never triggered for this ref" can never read as green; the
 * caller's timeout bounds that wait. Checks outside the list still count when
 * they fail: a red is a red whoever reported it, and ignoring one would mean
 * knowingly landing on a sha the forge shows as failing.
 *
 * `requiredChecks` empty is the weaker contract "every check the forge happens
 * to report must pass" — retained for direct callers and tests, but not
 * reachable from a RunConfig, because a snapshot of whatever exists at this
 * instant cannot distinguish a check that is late from one that is absent.
 */
export function aggregateCheckRuns(
  runs: readonly ForgeCheckRun[],
  requiredChecks: readonly string[] = [],
): ChecksVerdict {
  const latest = latestPerCheck(runs);

  const isFailed = (r: ForgeCheckRun): boolean =>
    r.status === "completed" &&
    !PASSING_CONCLUSIONS.has(r.conclusion ?? "__none__");

  let considered: readonly ForgeCheckRun[];
  if (requiredChecks.length > 0) {
    const missing = requiredChecks.filter(
      (name) => !latest.some((r) => r.name === name),
    );
    if (missing.length > 0) return { kind: "pending", waitingOn: missing };
    considered = latest.filter((r) => requiredChecks.includes(r.name));
  } else {
    if (latest.length === 0) {
      return { kind: "pending", waitingOn: ["(no checks reported yet)"] };
    }
    considered = latest;
  }

  // Failures are collected over EVERY check on the sha, not just the required
  // ones: required names decide what must be waited for, never which reds may
  // be ignored. Reporting them all also means the resolve agent sees the whole
  // failure surface rather than an arbitrary subset of it.
  const failed = latest.filter(isFailed);
  if (failed.length > 0) return { kind: "red", failed };

  const unfinished = considered.filter((r) => r.status !== "completed");
  if (unfinished.length > 0) {
    return { kind: "pending", waitingOn: unfinished.map((r) => r.name) };
  }
  return { kind: "green", names: considered.map((r) => r.name) };
}

/**
 * Job id out of a check run's details URL
 * (`…/actions/runs/<runId>/job/<jobId>`). Null when the URL isn't an Actions
 * job — an external check reports no fetchable log.
 */
export function jobIdFromDetailsUrl(detailsUrl: string): string | null {
  const m = detailsUrl.match(/\/job\/(\d+)/);
  return m && m[1] ? m[1] : null;
}

/**
 * The forge-red trace handed to the resolve agent. Each failing job is
 * summarised INDEPENDENTLY (cascade collapse + tail) before the sections are
 * joined, so a chatty first job can't push the others out of the window.
 */
export function buildForgeRedTrace(
  jobs: readonly { readonly name: string; readonly log: string }[],
): string {
  if (jobs.length === 0) {
    return "(the forge reported a failure but no job log could be retrieved)";
  }
  return jobs
    .map((j) =>
      [
        `### ${j.name}`,
        "",
        j.log.trim()
          ? summarizeGateFailure(stripAnsi(j.log), FORGE_LOG_LINES_PER_JOB)
          : // A job can be red with no failing *step* — cancelled, or the runner
            // never started. Say so, rather than leaving a bare heading that
            // reads as "the log was empty, so this probably passed".
            "(no step output captured — the job may have been cancelled or failed to start)",
      ].join("\n"),
    )
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Polling.
// ---------------------------------------------------------------------------

export type ChecksOutcome =
  | { readonly kind: "green"; readonly names: readonly string[] }
  | { readonly kind: "red"; readonly failed: readonly ForgeCheckRun[] }
  | { readonly kind: "timeout"; readonly waitingOn: readonly string[] }
  // No check run ever appeared for the sha within the grace window. Distinct
  // from `timeout` because the operator action differs: this is "the workflow
  // isn't triggered for this ref" (paths filter, branch filter, Actions
  // disabled), not "CI is slow".
  | { readonly kind: "no-checks" };

// How long a sha may report zero check runs before we conclude nothing is going
// to run for it. Long enough to cover queueing on a busy forge, short enough
// that a mis-triggered workflow doesn't burn the full check timeout.
export const NO_CHECKS_GRACE_MS = 120_000;

export type WaitForChecksDeps = {
  listCheckRuns(sha: string): Promise<CheckRunListing>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: ResolveLogger;
};

export type WaitForChecksOptions = {
  readonly requiredChecks?: readonly string[];
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly noChecksGraceMs?: number;
  readonly greenSettlePolls?: number;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Identity of a run set, for the settle comparison. Two polls "agree" only if
 * they saw the same runs in the same states — a newly created check, or one
 * that concluded between polls, restarts the settle count.
 */
function runSetKey(runs: readonly ForgeCheckRun[]): string {
  return [...runs]
    .map((r) => `${r.id}:${r.status}:${r.conclusion ?? ""}`)
    .sort()
    .join("|");
}

export async function waitForChecks(
  sha: string,
  opts: WaitForChecksOptions,
  deps: WaitForChecksDeps,
): Promise<ChecksOutcome> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);
  const grace = opts.noChecksGraceMs ?? NO_CHECKS_GRACE_MS;
  const settleTarget = opts.greenSettlePolls ?? GREEN_SETTLE_POLLS;
  const started = now();

  // Consecutive polls that have reported the same green run set.
  let greenStreak = 0;
  let greenKey = "";
  let consecutiveErrors = 0;

  for (;;) {
    let listing: CheckRunListing;
    try {
      listing = await deps.listCheckRuns(sha);
      consecutiveErrors = 0;
    } catch (err) {
      // The forge is the authority we are waiting on; a transient failure to
      // reach it is not a verdict. Retry a few times, then fail loud — the one
      // thing that must never happen is reading an unreachable forge as "no
      // checks" (which would look like a misconfigured trigger) or as green.
      consecutiveErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      if (consecutiveErrors >= CHECK_POLL_MAX_CONSECUTIVE_ERRORS) throw err;
      await log(
        `check poll failed (${consecutiveErrors}/${CHECK_POLL_MAX_CONSECUTIVE_ERRORS}): ${msg}; retrying`,
      );
      if (now() - started >= opts.timeoutMs) {
        return { kind: "timeout", waitingOn: ["(check listing unreachable)"] };
      }
      await sleep(opts.pollIntervalMs);
      continue;
    }

    const runs = listing.runs;
    const verdict = listing.complete
      ? aggregateCheckRuns(runs, opts.requiredChecks ?? [])
      : // A listing that could not account for every run the forge says exists
        // is not evidence of anything: the runs it is missing are exactly the
        // ones that could be red. Wait for a complete read.
        ({
          kind: "pending",
          waitingOn: ["(incomplete check listing)"],
        } satisfies ChecksVerdict);

    if (verdict.kind === "green") {
      const key = runSetKey(runs);
      if (key === greenKey) {
        greenStreak++;
      } else {
        greenKey = key;
        greenStreak = 1;
      }
      if (greenStreak >= settleTarget) {
        await log(
          `checks green (stable over ${greenStreak} polls): ${verdict.names.join(", ")}`,
        );
        return { kind: "green", names: verdict.names };
      }
      // Green but not yet settled: fall through to the sleep so a check that is
      // dispatched off another one's completion has a chance to appear.
      await log(
        `checks green but unsettled (${greenStreak}/${settleTarget}); re-polling`,
      );
    } else {
      greenStreak = 0;
      greenKey = "";
    }

    if (verdict.kind === "red") {
      await log(
        `checks red: ${verdict.failed.map((f) => `${f.name}=${f.conclusion ?? "?"}`).join(", ")}`,
      );
      return { kind: "red", failed: verdict.failed };
    }

    const elapsed = now() - started;
    if (listing.complete && runs.length === 0 && elapsed >= grace) {
      await log(`no check runs reported for ${sha} after ${elapsed}ms`);
      return { kind: "no-checks" };
    }
    // Green-but-unsettled counts as pending here on purpose: running out the
    // clock mid-settle parks the cycle rather than landing a verdict that was
    // still moving the last time we looked.
    const waitingOn =
      verdict.kind === "green"
        ? [`(green, awaiting ${settleTarget - greenStreak} more stable poll(s))`]
        : verdict.waitingOn;
    if (elapsed >= opts.timeoutMs) {
      await log(`checks still pending after ${elapsed}ms: ${waitingOn.join(", ")}`);
      return { kind: "timeout", waitingOn };
    }
    if (verdict.kind !== "green") {
      await log(`checks pending (${waitingOn.join(", ")}); polling`);
    }
    await sleep(opts.pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// The landing.
// ---------------------------------------------------------------------------

export type PushOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "rejected"; readonly reason: string };

export type PullRequestRef = {
  readonly number: number;
  readonly url: string;
};

export type VerifyAdapter = {
  // Force-push HEAD of the merger worktree to the integration branch. Lease-
  // protected against the ref's observed value, so a third party moving it is a
  // rejection rather than a silent overwrite.
  pushIntegration(branch: string): Promise<PushOutcome>;
  // The sha's check runs, and whether the listing is known to be complete.
  // Throws if the forge is unreachable — an error is not a verdict, and the
  // poller retries it rather than reading it as "no checks".
  listCheckRuns(sha: string): Promise<CheckRunListing>;
  // Failing job's log, best-effort: an unreachable log must degrade the resolve
  // prompt, not abort the landing.
  fetchFailureLog(run: ForgeCheckRun): Promise<string>;
  // git push origin <sha>:<sourceBranch> — a fast-forward by construction
  // (the verified sha descends from origin/<sourceBranch> as observed when the
  // merger worktree was created). A rejection means origin moved underneath us.
  fastForwardSource(sha: string): Promise<PushOutcome>;
  // Merge the current origin/<sourceBranch> into the merge result, for when the
  // fast-forward is rejected because origin moved during the (multi-minute) CI
  // wait. Produces a new composed result that MUST be re-verified — which is
  // why this consumes a round rather than retrying the push.
  syncWithSource(): Promise<{ readonly ok: boolean; readonly reason: string }>;
  // openPullRequest only. Create-or-update: a PR that outlived an earlier cycle
  // gets this cycle's title and body, because a reused PR describing the
  // previous cycle's issues is a wrong audit record, which is the one thing a
  // PR-as-audit-handle must not be.
  ensurePullRequest(args: {
    readonly head: string;
    readonly title: string;
    readonly body: string;
  }): Promise<PullRequestRef>;
  // openPullRequest only, best-effort. After the fast-forward the forge normally
  // marks the PR merged on its own; this closes one that outlived its purpose
  // (an abandoned cycle, or a forge that didn't notice).
  closePullRequest(number: number, comment: string): Promise<void>;
};

export type VerifiedFailureReason =
  | "checks-red"
  | "checks-timeout"
  // A green verdict was won, but origin/<sourceBranch> moved before it could be
  // landed and the rounds to re-verify the re-merged result ran out.
  | "source-moved"
  // NB: there is no "no-checks" reason. A sha the forge never builds is a
  // repository-configuration failure, so it is fatal rather than parked.
  | "resolve-abandon";

export type VerifiedLandingResult =
  | {
      readonly kind: "landed";
      readonly sha: string;
      readonly rounds: number;
      readonly pullRequest: PullRequestRef | null;
    }
  | {
      // The cycle could not be verified. Nothing was pushed to the source
      // branch; the caller reverts the merger worktree and parks the issues.
      readonly kind: "abandoned";
      readonly reason: VerifiedFailureReason;
      readonly detail: string;
      readonly rounds: number;
      // The last sha actually submitted to the forge, so the caller can point a
      // human at the commit the check runs hang off rather than at the scratch
      // branch, which the next cycle overwrites.
      readonly lastSha: string | null;
      // Whether the resolve loop committed anything during verification. Those
      // commits are on the (about to be reverted) merge result only — the
      // caller has to say so, or the agent's work vanishes unannounced.
      readonly resolveCommits: boolean;
    }
  // Infrastructure said no: a push was rejected. Distinct from `abandoned`
  // because it is not the agents' failure and the caller halts loud on it
  // instead of parking issues under a handoff label.
  | { readonly kind: "fatal"; readonly detail: string };

export type VerifiedLandingDeps = {
  readonly verify: VerifyAdapter;
  // The merger adapter — satisfies ResolveAdapter, which is all the resolve
  // loop needs. `getHeadSha` also comes from here.
  readonly resolve: ResolveAdapter;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: ResolveLogger;
};

export type VerifiedLandingOptions = {
  readonly integrationBranch: string;
  readonly requiredChecks?: readonly string[];
  readonly checkTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly noChecksGraceMs?: number;
  readonly greenSettlePolls?: number;
  readonly openPullRequest?: boolean;
  readonly sourceBranch: string;
  // Issues whose merges are in this cycle's merge result, ascending. The last
  // one anchors the resolve loop (see below); all of them go into the PR body.
  readonly mergedIssues: readonly IssueRef[];
  // Every issue in the cycle, for the resolve loop's cross-branch context.
  readonly cycleIssues: readonly IssueRef[];
  readonly projectAnchor: string;
  readonly maxRounds?: number;
};

/**
 * The landing options implied by a resolved verified-mode config.
 *
 * This exists as a named, tested function rather than an object literal at the
 * call site because it is the single point where a mistake is catastrophic and
 * silent: passing `sourceBranch` where `integrationBranch` belongs turns the
 * whole mechanism into a force-push of an UNVERIFIED merge result straight onto
 * the branch it was built to protect, and every other test in the suite would
 * still pass. `resolveMergeMode` refuses that config; this keeps the wiring
 * honest afterwards.
 */
export function verifiedLandingOptionsFrom(
  mode: Extract<ResolvedMergeMode, { kind: "verified" }>,
  sourceBranch: string,
): Omit<
  VerifiedLandingOptions,
  "mergedIssues" | "cycleIssues" | "projectAnchor"
> {
  if (mode.integrationBranch === sourceBranch) {
    throw new SandbarError(
      `Verified landing would push to its own source branch ('${sourceBranch}'). ` +
        `This is unreachable through resolveMergeMode and indicates the merge ` +
        `mode was constructed by hand.`,
    );
  }
  return {
    integrationBranch: mode.integrationBranch,
    requiredChecks: mode.requiredChecks,
    checkTimeoutMs: mode.checkTimeoutMs,
    pollIntervalMs: mode.pollIntervalMs,
    noChecksGraceMs: mode.noChecksGraceMs,
    openPullRequest: mode.openPullRequest,
    sourceBranch,
  };
}

function pullRequestBody(opts: VerifiedLandingOptions): string {
  // Deliberately NOT `Closes #n`. Auto-close only fires for PRs merged into the
  // repository's DEFAULT branch, and sandbar's sourceBranch need not be it —
  // relying on it would silently strand issues open on any other source branch.
  // Sandbar closes its own issues after the push (see merger.ts), which also
  // keeps the #14 unclosed-retry machinery intact and identical in both modes.
  const lines = [
    "Sandbar cycle integration branch. Every commit here already passed the",
    "local post-merge gate; this PR exists so the forge verifies the composed",
    "result before it reaches `" + opts.sourceBranch + "`.",
    "",
    "Issues in this merge result:",
    "",
  ];
  for (const i of opts.mergedIssues) {
    lines.push(`- #${i.id} — ${i.title}`);
  }
  lines.push(
    "",
    "Sandbar lands this by fast-forwarding `" +
      opts.sourceBranch +
      "` to the verified sha, so the commits are authored exactly as they were",
    "locally. Do not merge this PR by hand while a run is in progress.",
  );
  return lines.join("\n");
}

export async function runVerifiedLanding(
  opts: VerifiedLandingOptions,
  deps: VerifiedLandingDeps,
): Promise<VerifiedLandingResult> {
  const log = deps.log ?? (() => undefined);
  const maxRounds = opts.maxRounds ?? VERIFY_MAX_ROUNDS;
  let pr: PullRequestRef | null = null;

  // Every abandon path closes the pull request (when there is one): the cycle's
  // merges are about to be reverted, so leaving an open PR pointing at a broken
  // integration ref would advertise work that no longer exists.
  const closePr = async (why: string): Promise<void> => {
    if (pr) {
      await deps.verify.closePullRequest(pr.number, why);
      pr = null;
    }
  };

  // Set as the loop progresses so every abandon can report where the evidence
  // is and whether agent work is about to be discarded.
  let lastSha: string | null = null;
  let resolveCommits = false;

  const abandon = async (
    reason: VerifiedFailureReason,
    detail: string,
    rounds: number,
  ): Promise<VerifiedLandingResult> => {
    await closePr(`Sandbar reverted this cycle's merges: ${detail}`);
    return {
      kind: "abandoned",
      reason,
      detail,
      rounds,
      lastSha,
      resolveCommits,
    };
  };

  // A fatal ends the run, but the PR still has to go: the merger worktree is
  // about to be destroyed with the merges in it, so an open PR would advertise
  // an integration ref nothing will ever land — and would be silently REUSED by
  // the next run's first cycle, carrying this cycle's title into a PR about
  // different issues.
  const fatal = async (detail: string): Promise<VerifiedLandingResult> => {
    await closePr(`Sandbar could not land this cycle: ${detail}`);
    return { kind: "fatal", detail };
  };

  for (let round = 1; round <= maxRounds; round++) {
    const sha = await deps.resolve.getHeadSha();
    lastSha = sha;
    await log(
      `verify round ${round}/${maxRounds}: pushing ${sha} to ${opts.integrationBranch}`,
    );
    const pushed = await deps.verify.pushIntegration(opts.integrationBranch);
    if (pushed.kind !== "ok") {
      return fatal(
        `push to integration branch '${opts.integrationBranch}' was rejected: ${pushed.reason}`,
      );
    }

    if (opts.openPullRequest) {
      // After the push, so the PR opens against a ref that already exists.
      pr = await deps.verify.ensurePullRequest({
        head: opts.integrationBranch,
        title: `Sandbar: land ${opts.mergedIssues.length} issue(s) into ${opts.sourceBranch}`,
        body: pullRequestBody(opts),
      });
      await log(`verify: pull request ${pr.url}`);
    }

    const outcome = await waitForChecks(
      sha,
      {
        requiredChecks: opts.requiredChecks,
        timeoutMs: opts.checkTimeoutMs,
        pollIntervalMs: opts.pollIntervalMs,
        ...(opts.noChecksGraceMs !== undefined
          ? { noChecksGraceMs: opts.noChecksGraceMs }
          : {}),
        ...(opts.greenSettlePolls !== undefined
          ? { greenSettlePolls: opts.greenSettlePolls }
          : {}),
      },
      {
        listCheckRuns: (s) => deps.verify.listCheckRuns(s),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        log,
      },
    );

    if (outcome.kind === "timeout") {
      return abandon(
        "checks-timeout",
        `checks on ${sha} did not conclude within ${opts.checkTimeoutMs}ms (waiting on: ${outcome.waitingOn.join(", ")})`,
        round,
      );
    }
    if (outcome.kind === "no-checks") {
      // FATAL, not parked. "Nothing runs for this ref" is a property of the
      // repository's configuration, not of this cycle's code: the next cycle
      // will hit it identically, and the one after that. Parking would quietly
      // convert the entire backlog into `agent-stuck`, one cycle at a time,
      // for a failure no agent caused and no human was told about. Halting
      // loudly on the first occurrence is the only outcome an operator can act
      // on — and matches sandbar's rule that infrastructure failures stop the
      // run rather than being absorbed into per-issue outcomes.
      return fatal(
        `no check runs were created for ${sha} on '${opts.integrationBranch}' within the grace window. ` +
          `Verified merge mode cannot gate a branch the forge does not build: check that the CI workflow ` +
          `triggers for '${opts.integrationBranch}' (a branches/paths filter, or Actions disabled, will do this), ` +
          `or switch mergeMode back to "direct".`,
      );
    }

    if (outcome.kind === "green") {
      const ff = await deps.verify.fastForwardSource(sha);
      if (ff.kind === "ok") {
        await log(`verify: fast-forwarded ${opts.sourceBranch} to ${sha}`);
        return { kind: "landed", sha, rounds: round, pullRequest: pr };
      }

      // origin/<sourceBranch> moved while the forge was verifying — with a
      // multi-minute CI wait this is routine, not exceptional. The verified sha
      // no longer fast-forwards, and force-landing it would silently drop
      // whatever arrived in the meantime. Merge the new tip in and re-verify:
      // the composed result CHANGED, so the old verdict does not carry over.
      // That costs a round, which is the honest price.
      if (round === maxRounds) {
        return abandon(
          "source-moved",
          `checks passed on ${sha} but '${opts.sourceBranch}' moved during verification (${ff.reason}), ` +
            `and no verification rounds were left to re-verify the re-merged result`,
          round,
        );
      }
      await log(
        `verify: ${opts.sourceBranch} moved under a verified sha; re-merging and re-verifying`,
      );
      const sync = await deps.verify.syncWithSource();
      if (!sync.ok) {
        // A conflict against the new tip is beyond this loop's remit: the
        // resolve loop's contract is a red gate or a merge it started, not a
        // third party's concurrent commit.
        return abandon(
          "source-moved",
          `checks passed on ${sha} but '${opts.sourceBranch}' moved during verification, and re-merging ` +
            `the new tip failed: ${sync.reason}`,
          round,
        );
      }
      continue;
    }

    // Red.
    const failedNames = outcome.failed.map((f) => f.name).join(", ");
    if (round === maxRounds) {
      return abandon(
        "checks-red",
        `forge checks red on ${sha} after ${round} round(s): ${failedNames}`,
        round,
      );
    }

    // Cap the log fetch. A red matrix can fail dozens of near-identical jobs;
    // each log is fetched serially and can run to megabytes, and a prompt built
    // from fifty of them is neither affordable nor readable. The elision is
    // stated in the trace — the agent must never be handed a partial picture it
    // thinks is the whole one.
    const toFetch = outcome.failed.slice(0, MAX_FAILED_JOB_LOGS);
    const elided = outcome.failed.length - toFetch.length;
    const jobs: { name: string; log: string }[] = [];
    for (const f of toFetch) {
      jobs.push({ name: f.name, log: await deps.verify.fetchFailureLog(f) });
    }
    const trace =
      buildForgeRedTrace(jobs) +
      (elided > 0
        ? `\n\n(${elided} further failing check(s) not shown: ${outcome.failed
            .slice(MAX_FAILED_JOB_LOGS)
            .map((f) => f.name)
            .join(", ")})`
        : "");

    // The red is a property of the COMPOSED merge result, so there is no single
    // issue to blame. The topmost merge (last in ascending order) anchors the
    // prompt and every other issue in the cycle rides along as related context —
    // the same cross-branch framing the conflict/gate-red paths already use.
    const primary = opts.mergedIssues[opts.mergedIssues.length - 1];
    if (!primary) {
      return abandon(
        "checks-red",
        `forge checks red (${failedNames}) and no merged issue to anchor a fix on`,
        round,
      );
    }
    const related = opts.cycleIssues.filter((c) => c.id !== primary.id);

    await log(`verify: forge red (${failedNames}); entering resolve-loop`);
    const resolved = await runResolveLoop(
      primary,
      related,
      { kind: "forge-red", initialTrace: trace, failedChecks: failedNames },
      deps.resolve,
      { projectAnchor: opts.projectAnchor, preMergeSha: sha },
      log,
    );
    if (resolved.kind === "abandon") {
      // A SILENT abandon left HEAD where it was, so no fix commits exist; a
      // reasoned one may have committed before giving up.
      if (!resolved.silent) resolveCommits = true;
      return abandon(
        "resolve-abandon",
        `forge checks red on ${sha} (${failedNames}); resolve loop gave up: ${resolved.reason}`,
        round,
      );
    }
    // Resolved means the loop's HEAD-advance invariant held: there are commits
    // on the merge result that exist nowhere else.
    resolveCommits = true;
    // Resolved locally — HEAD advanced and the LOCAL gate is green again. That
    // is a pre-filter, not a verdict: the next round re-pushes and asks the
    // forge again.
  }

  /* c8 ignore next 6 -- unreachable: the loop returns on every path */
  return {
    kind: "abandoned",
    reason: "checks-red",
    detail: "verification rounds exhausted",
    rounds: maxRounds,
    lastSha,
    resolveCommits,
  };
}

// ---------------------------------------------------------------------------
// Real adapter — shells out to git + gh.
// ---------------------------------------------------------------------------

// The one process seam in this module. Production passes nothing and gets
// execFile; tests pass a fake to assert the ARGV — which is where the bugs in a
// shell-out layer live (a missing --paginate, a wrong refspec, a --jq that
// yields null on a shape the API really returns) and which no amount of testing
// against a hand-written adapter fake can reach.
export type ExecFn = (
  file: string,
  args: readonly string[],
  opts: { readonly cwd: string; readonly maxBuffer?: number },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export type RealVerifyAdapterDeps = {
  // The merger worktree (detached at origin/<sourceBranch>).
  readonly cwd: string;
  readonly sourceBranch: string;
  readonly repo: { readonly owner: string; readonly name: string };
  readonly exec?: ExecFn;
};

function pushErrorReason(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr ?? "").trim() || e.message || "unknown push error";
}

const defaultExec: ExecFn = (file, args, opts) =>
  execFileAsync(file, [...args], opts);

export function realVerifyAdapter(deps: RealVerifyAdapterDeps): VerifyAdapter {
  const cwd = deps.cwd;
  const repoFlag = `${deps.repo.owner}/${deps.repo.name}`;
  const exec: ExecFn = deps.exec ?? defaultExec;

  return {
    async pushIntegration(branch) {
      // Observe the remote ref first so the force-push can be lease-protected:
      // the merger worktree has no remote-tracking ref for a scratch branch it
      // never checks out, so the implicit `--force-with-lease` form would have
      // nothing to compare against.
      // NB: an ls-remote failure is NOT reported as a rejected push — it never
      // got as far as a push, and calling it one would hand the operator a
      // diagnosis ("the forge refused the ref") for what is really an
      // unreachable remote. Let it throw.
      const { stdout } = await exec(
        "git",
        ["ls-remote", "origin", `refs/heads/${branch}`],
        { cwd },
      );
      const first = stdout.split("\n")[0]?.trim();
      const remoteSha: string | null = first
        ? (first.split(/\s+/)[0] ?? null)
        : null;
      const force = remoteSha
        ? [`--force-with-lease=refs/heads/${branch}:${remoteSha}`]
        : [];
      try {
        await exec(
          "git",
          ["push", ...force, "origin", `HEAD:refs/heads/${branch}`],
          { cwd },
        );
        return { kind: "ok" };
      } catch (err) {
        return { kind: "rejected", reason: pushErrorReason(err) };
      }
    },

    async listCheckRuns(sha) {
      // Check runs are sha-scoped, which is exactly the guarantee this module
      // needs: a verdict can never be about a different commit than the one
      // being landed. Legacy commit *statuses* (the pre-checks API) are not
      // consulted — GitHub Actions reports check runs.
      //
      // Paged explicitly rather than with `gh --paginate`: `--paginate` with a
      // `--jq` filter emits one JSON document PER PAGE (concatenated, not
      // merged), which JSON.parse rejects, and `--slurp` is too new to rely on
      // in a consumer's toolchain. Walking the pages by hand also keeps
      // `total_count` in reach, which is the only way to know the read was
      // whole — a truncated list of check runs is indistinguishable from a
      // green one.
      const runs: ForgeCheckRun[] = [];
      let totalCount = 0;
      let complete = false;
      for (let page = 1; page <= CHECK_RUN_PAGE_LIMIT; page++) {
        const { stdout } = await exec(
          "gh",
          [
            "api",
            "-H",
            "Accept: application/vnd.github+json",
            `repos/${repoFlag}/commits/${sha}/check-runs?per_page=${CHECK_RUN_PAGE_SIZE}&page=${page}`,
          ],
          { cwd, maxBuffer: MAX_BUFFER },
        );
        const body: unknown = JSON.parse(stdout.trim() || "{}");
        if (typeof body !== "object" || body === null) {
          // A shape we can't read is not "zero check runs" — that would be
          // reported as a mis-triggered workflow. Fail loud.
          throw new SandbarError(
            `Unreadable check-runs response for ${sha} (page ${page}).`,
          );
        }
        const env = body as Record<string, unknown>;
        const rawRuns = env["check_runs"];
        if (!Array.isArray(rawRuns)) {
          throw new SandbarError(
            `check-runs response for ${sha} (page ${page}) has no check_runs array.`,
          );
        }
        totalCount =
          typeof env["total_count"] === "number"
            ? env["total_count"]
            : totalCount;
        for (const r of rawRuns) {
          const o = r as Record<string, unknown>;
          const suite = o["check_suite"] as Record<string, unknown> | undefined;
          runs.push({
            id: typeof o["id"] === "number" ? o["id"] : 0,
            suiteId:
              suite && typeof suite["id"] === "number" ? suite["id"] : 0,
            name: typeof o["name"] === "string" ? o["name"] : "(unnamed)",
            status: typeof o["status"] === "string" ? o["status"] : "queued",
            conclusion:
              typeof o["conclusion"] === "string" ? o["conclusion"] : null,
            detailsUrl:
              typeof o["details_url"] === "string" ? o["details_url"] : "",
          });
        }
        // Done when the forge's own count is accounted for, or the page came
        // back short (nothing further to fetch).
        if (runs.length >= totalCount || rawRuns.length < CHECK_RUN_PAGE_SIZE) {
          complete = runs.length >= totalCount;
          break;
        }
      }
      // `complete: false` reaches the poller as "keep waiting", never as a
      // verdict: it means either the page cap was hit or checks were being
      // created underneath the walk, and in both cases the runs we did not see
      // are exactly the ones that might be red.
      return { runs, complete };
    },

    async fetchFailureLog(run) {
      const jobId = jobIdFromDetailsUrl(run.detailsUrl);
      if (!jobId) {
        return `(no Actions job behind check "${run.name}"; see ${run.detailsUrl || "the forge"})`;
      }
      try {
        const { stdout } = await exec(
          "gh",
          ["run", "view", "--repo", repoFlag, "--job", jobId, "--log-failed"],
          { cwd, maxBuffer: MAX_BUFFER },
        );
        // `--log-failed` is empty when nothing failed at the STEP level — a
        // cancelled job, a runner that never started. Report the conclusion
        // instead of an empty section.
        if (!stdout.trim()) {
          return `(job "${run.name}" concluded "${run.conclusion ?? "unknown"}" with no failing step output; see ${run.detailsUrl})`;
        }
        return lastNLines(stdout, FORGE_LOG_LINES_PER_JOB * 4);
      } catch (err) {
        // Best-effort by contract: a missing log degrades the resolve prompt,
        // it does not abort the landing.
        return `(could not fetch log for "${run.name}": ${
          err instanceof Error ? err.message : String(err)
        }; see ${run.detailsUrl || "the forge"})`;
      }
    },

    async fastForwardSource(sha) {
      try {
        await exec(
          "git",
          ["push", "origin", `${sha}:refs/heads/${deps.sourceBranch}`],
          { cwd },
        );
        return { kind: "ok" };
      } catch (err) {
        return { kind: "rejected", reason: pushErrorReason(err) };
      }
    },

    async syncWithSource() {
      // Fetch the current tip and merge it in. Deliberately a merge, not a
      // rebase: the merge result's commits are already on the integration ref
      // (and possibly a PR), and rewriting them would orphan both.
      try {
        await exec("git", ["fetch", "origin", deps.sourceBranch], { cwd });
      } catch (err) {
        return { ok: false, reason: pushErrorReason(err) };
      }
      try {
        await exec(
          "git",
          [
            "merge",
            "--no-ff",
            "-m",
            `Merge origin/${deps.sourceBranch} into sandbar integration result`,
            "FETCH_HEAD",
          ],
          { cwd },
        );
        return { ok: true, reason: "" };
      } catch (err) {
        // Leave nothing half-merged behind: the caller parks the cycle and the
        // worktree is reset to the cycle base, but an in-progress merge would
        // make that reset ambiguous.
        await exec("git", ["merge", "--abort"], { cwd }).catch(() => undefined);
        return { ok: false, reason: pushErrorReason(err) };
      }
    },

    async ensurePullRequest({ head, title, body }) {
      const { stdout } = await exec(
        "gh",
        [
          "pr",
          "list",
          "--repo",
          repoFlag,
          "--head",
          head,
          "--base",
          deps.sourceBranch,
          "--state",
          "open",
          "--json",
          "number,url",
        ],
        { cwd, maxBuffer: MAX_BUFFER },
      );
      const existing: unknown = JSON.parse(stdout.trim() || "[]");
      if (Array.isArray(existing) && existing.length > 0) {
        const o = existing[0] as Record<string, unknown>;
        const number = typeof o["number"] === "number" ? o["number"] : 0;
        const url = typeof o["url"] === "string" ? o["url"] : "";
        // Re-title and re-body it. This PR is a scratch ref's audit handle, so
        // a survivor from an earlier cycle would otherwise describe issues that
        // are not in the merge result it now points at.
        if (number > 0) {
          await exec(
            "gh",
            [
              "pr",
              "edit",
              String(number),
              "--repo",
              repoFlag,
              "--title",
              title,
              "--body",
              body,
            ],
            { cwd, maxBuffer: MAX_BUFFER },
          );
        }
        return { number, url };
      }
      const created = await exec(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          repoFlag,
          "--head",
          head,
          "--base",
          deps.sourceBranch,
          "--title",
          title,
          "--body",
          body,
        ],
        { cwd, maxBuffer: MAX_BUFFER },
      );
      const url = created.stdout.trim().split("\n").pop() ?? "";
      const m = url.match(/\/pull\/(\d+)/);
      return { number: m && m[1] ? Number(m[1]) : 0, url };
    },

    async closePullRequest(number, comment) {
      if (number <= 0) return;
      try {
        await exec(
          "gh",
          ["pr", "close", String(number), "--repo", repoFlag, "--comment", comment],
          { cwd },
        );
      } catch {
        /* best-effort: an already-merged or already-closed PR is fine */
      }
    },
  };
}
