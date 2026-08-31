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
//     never as "everything I can see passed". The count is of DISTINCT run ids,
//     because unordered pages fetched one after another can return the same run
//     twice and omit another entirely — counting rows would then reach
//     `total_count` with the red one never read. An envelope with no readable
//     `total_count`, or a run with no readable id, is an unreadable response
//     and throws: there is no safe default for the number the whole
//     completeness argument rests on.
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
//     "the workflow hasn't got here yet" — and the distinction is acted on, not
//     merely recorded: a required name still absent while every other check on
//     the sha has concluded, held for the grace window, is `missing-required`
//     and FATAL. Waiting it out instead would spend a full CI timeout every
//     cycle and drain the backlog into `agent-stuck` over a name that doesn't
//     match what the forge publishes, which is the likeliest misconfiguration
//     of the lot.
//   * AN UNKNOWN IS AN UNKNOWN WHOEVER OWNS IT. A check outside
//     `requiredChecks` that is still running holds the verdict up exactly like
//     a required one: it will conclude, and it can conclude red. The floor says
//     what must exist and pass, never which unknowns may be skipped past —
//     otherwise green means "everything that happened to be finished when I
//     looked was fine".
//   * "SKIPPED" IS NOT "PASSED". A job gated by `if:` or a `paths` filter
//     concludes `skipped` having run nothing. Branch protection counts that as
//     satisfied; this module does not, because a skipped test job is precisely
//     the state it exists to catch.
//
// THE POLL'S PACING AND ITS DEADLINE COME FROM ONE CLOCK (#25). `waitForChecks`
// is a `for (;;)` whose every exit is computed from a `now()` reading, while its
// only yield is a `sleep()`. When those were two independently-optional deps a
// caller could fake the sleep and leave the deadline on the real clock — the
// natural half-mistake for a test — and the loop then polled at zero wall-clock
// against a deadline nothing it controlled could reach: not a hang but a spin,
// one full core for the whole of `timeoutMs`, which at the suite's usual
// `600_000` is ten minutes. Vitest's fork pool made it worse than a slow test:
// the spinner is a separate PROCESS, so anything that kills the parent PID
// alone — `kill -9` on it, `timeout --foreground`, a Python harness's
// `subprocess.run(..., timeout=N)` — reparents it to init, where it keeps
// burning with nothing left on screen to say it exists. Whatever bounds a run
// has to kill the process GROUP; CLAUDE.md's Commands section says which
// wrappers already do. The type-level fix is `Clock`, one object, so a
// half-injected clock cannot be written; the belt-and-braces one is
// `maxPollsFor`, a poll ceiling that fails loud on a clock which does not
// advance, however it was faked.
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
import {
  type PullRequestRef,
  ensurePullRequest as ensureForgePullRequest,
} from "./forge-pr.js";
import { lastNLines, stripAnsi, summarizeGateFailure } from "./gate.js";
import {
  type IssueRef,
  type ResolveAdapter,
  type ResolveLogger,
  runResolveLoop,
} from "./resolve-loop.js";
import type { RepoRef } from "./repo-ref.js";

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
  | {
      readonly kind: "pending";
      readonly waitingOn: readonly string[];
      // Required names that have not appeared on the sha AT ALL, as opposed to
      // ones that are merely still running. The caller needs the distinction:
      // a name that never appears while everything else concludes is a naming
      // mistake, not a slow forge, and parking on it every cycle would drain
      // the backlog into `agent-stuck` for a fault no agent can fix.
      readonly missingRequired?: readonly string[];
    }
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
    if (missing.length > 0) {
      return { kind: "pending", waitingOn: missing, missingRequired: missing };
    }
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

  // Unfinished is counted over EVERY check on the sha, not just the required
  // ones — the same asymmetry that makes an unnamed red sink the cycle. An
  // `in_progress` run outside the floor is an UNKNOWN verdict, and unknown
  // never lands: it WILL conclude, and it can conclude red. Waiting on it is
  // the difference between "everything that had finished by the time I looked
  // was green" and "everything is green".
  //
  // Legacy commit statuses are the deliberate exception, and can't reach here:
  // only FAILING ones are folded into the run list at all (realVerifyAdapter),
  // because third-party integrations leave statuses pending forever.
  const unfinished = latest.filter((r) => r.status !== "completed");
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
  | { readonly kind: "no-checks" }
  // A name in `requiredChecks` never appeared, while everything else on the sha
  // finished and STAYED finished for the grace window. Also a repo-level fault
  // rather than a slow one — almost always a name that doesn't match what the
  // forge reports (`test` vs `test (20.x)`, or the workflow's name rather than
  // the job's). Distinct from `timeout` because parking on it burns a full CI
  // wait every cycle and converts the backlog into `agent-stuck` for a typo.
  | { readonly kind: "missing-required"; readonly names: readonly string[] };

// How long a sha may report zero check runs before we conclude nothing is going
// to run for it. Long enough to cover queueing on a busy forge, short enough
// that a mis-triggered workflow doesn't burn the full check timeout.
export const NO_CHECKS_GRACE_MS = 120_000;

// The poll's pacing and its deadline, as ONE value (#25) — see the header for
// what the two independently-optional `sleep?`/`now?` deps this replaces cost.
// The shape was the bug rather than a way of writing it: faking one reading and
// leaving the other real is a full-core spin, and it is the natural
// half-mistake, since the first instinct when testing a poller is "don't wait on
// real timers". One object makes that unrepresentable — a caller supplies both
// readings or neither — which closes the whole class, not the one instance.
export type Clock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export type WaitForChecksDeps = {
  listCheckRuns(sha: string): Promise<CheckRunListing>;
  readonly clock?: Clock;
  readonly log?: ResolveLogger;
};

export type WaitForChecksOptions = {
  readonly requiredChecks?: readonly string[];
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly noChecksGraceMs?: number;
  readonly greenSettlePolls?: number;
};

// Slack over the number of polls the deadline itself allows, before the loop
// declares its clock broken. Generous on purpose: this is a backstop against a
// clock that does not advance at all, never a second deadline. Anything pacing
// honestly exits on `elapsed >= timeoutMs` a long way under it.
export const POLL_CEILING_SLACK = 100;

/**
 * The most polls `waitForChecks` may make before it concludes its clock is not
 * advancing — the same idea as `MAX_ITERATIONS` in run.ts, and here for the same
 * reason: a loop whose every exit is computed from an injected reading must
 * still terminate when that reading lies.
 *
 * Every iteration sleeps exactly `pollIntervalMs` (the error-retry path and the
 * bottom of the loop alike), so a clock that advances at all reaches the
 * deadline within `timeoutMs / pollIntervalMs` polls; past that plus slack the
 * clock is not moving, which is a bug and fails loud rather than converting
 * into an infinite spin. Non-positive and non-finite inputs are floored rather
 * than trusted — the job here is to produce a bound, and a NaN bound is the
 * exact state this exists to catch.
 */
export function maxPollsFor(timeoutMs: number, pollIntervalMs: number): number {
  const interval =
    Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 1;
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
  return Math.ceil(timeout / interval) + POLL_CEILING_SLACK;
}

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
  const clock = deps.clock ?? realClock;
  const sleep = (ms: number) => clock.sleep(ms);
  const now = () => clock.now();
  const log = deps.log ?? (() => undefined);
  const grace = opts.noChecksGraceMs ?? NO_CHECKS_GRACE_MS;
  const settleTarget = opts.greenSettlePolls ?? GREEN_SETTLE_POLLS;
  const started = now();
  const maxPolls = maxPollsFor(opts.timeoutMs, opts.pollIntervalMs);
  let polls = 0;

  // Consecutive polls that have reported the same green run set.
  let greenStreak = 0;
  let greenKey = "";
  let consecutiveErrors = 0;
  // When "a required name is absent AND nothing else is still running" first
  // became true. Held rather than acted on immediately, because that state is
  // transient on any repo with chained workflows: a `workflow_run` job is
  // created seconds AFTER the run that triggers it concludes, so between the
  // two there is an instant where everything visible has finished and the
  // chained check has yet to exist.
  let missingStableSince: number | null = null;

  for (;;) {
    // Fail loud on a clock that is not advancing. Reaching this means every
    // exit below is unreachable — `elapsed` never grows — so the alternative is
    // not a slow poll but a loop that never returns, at full CPU.
    if (++polls > maxPolls) {
      throw new Error(
        `waitForChecks polled ${polls} times for ${sha} without reaching its ` +
          `${opts.timeoutMs}ms deadline (ceiling ${maxPolls} at a ` +
          `${opts.pollIntervalMs}ms interval). The clock backing this poll is ` +
          `not advancing — every exit from the wait is computed from it.`,
      );
    }
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

    // A required name that never appears is indistinguishable from a slow one
    // at any single instant — so the test is not "is it absent now" but "has it
    // been absent while the forge had nothing left to report". Requiring that
    // to hold across the grace window lets a chained workflow's check turn up
    // and reset the clock, while a name that simply doesn't exist on this repo
    // halts instead of burning a full CI timeout every cycle forever.
    const missingRequired =
      verdict.kind === "pending" ? (verdict.missingRequired ?? []) : [];
    const anyUnfinished = runs.some((r) => r.status !== "completed");
    if (
      listing.complete &&
      runs.length > 0 &&
      missingRequired.length > 0 &&
      !anyUnfinished
    ) {
      missingStableSince ??= now();
      if (now() - missingStableSince >= grace) {
        await log(
          `required check(s) never reported for ${sha} while all ${runs.length} other check(s) concluded: ${missingRequired.join(", ")}`,
        );
        return { kind: "missing-required", names: missingRequired };
      }
    } else {
      missingStableSince = null;
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

// One shape for both kinds of pull request sandbar opens, declared beside the
// create-or-update primitive that returns it (#62) and re-exported here: this
// module's adapter is the older consumer, and everything that imported the type
// from it still can.
export type { PullRequestRef } from "./forge-pr.js";

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
  // One clock, forwarded whole into waitForChecks — see `Clock`. Splitting it
  // back into a sleep and a now would re-open #25 at this layer, where the
  // forward is the only thing the pair is ever used for.
  readonly clock?: Clock;
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
  // Issues whose merges are in this cycle's merge result, in MERGE order —
  // ascending, so the last one is the topmost commit. That is the one that
  // anchors the resolve loop (see below); all of them go into the PR body.
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
        ...(deps.clock ? { clock: deps.clock } : {}),
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
    if (outcome.kind === "missing-required") {
      // Same class as no-checks, and the likelier one: the forge IS building
      // the ref, but a name in `requiredChecks` matches nothing it reports.
      // Every cycle would wait out the full check timeout and park, so the
      // backlog drains into `agent-stuck` at one CI wall-clock apiece for what
      // is almost always a typo.
      return fatal(
        `required check(s) never reported for ${sha}: ${outcome.names.join(", ")}. ` +
          `Every other check on the sha concluded, so these names do not match anything the forge ` +
          `publishes for '${opts.integrationBranch}'. requiredChecks holds check-run names as the forge ` +
          `reports them — the JOB name, including any matrix suffix (e.g. "test (20.x)"), not the ` +
          `workflow name and not a legacy commit-status context.`,
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

      // Did the re-merge actually produce anything? `git merge` against a ref
      // that is already an ancestor prints "Already up to date.", exits 0 and
      // creates no commit — so a successful sync that leaves HEAD where it was
      // proves origin/<sourceBranch> never moved, and the push was rejected for
      // some other reason entirely: branch protection, a pre-receive hook, a
      // token without write scope. Those are repo-level faults that recur every
      // cycle, so this is fatal for the same reason no-checks is. Treating them
      // as a race would re-verify a byte-identical sha until the rounds ran out
      // and then park the whole cycle blaming a branch that never moved.
      const afterSync = await deps.resolve.getHeadSha();
      if (afterSync === sha) {
        return fatal(
          `checks passed on ${sha}, but the fast-forward of '${opts.sourceBranch}' was rejected ` +
            `(${ff.reason}) and re-merging origin/${opts.sourceBranch} produced no new commit — it was ` +
            `already an ancestor. The branch did not move, so the push was refused for another reason: ` +
            `branch protection or a required review on '${opts.sourceBranch}', a pre-receive hook, or a ` +
            `token without push access. Verified mode cannot land while that holds.`,
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
    // issue to blame. The topmost merge — last in the ascending MERGE order the
    // caller passes, which since #64 puts a landing chunk's members below the
    // cycle's own branches — anchors the prompt, and every other issue in the
    // cycle rides along as related context: the same cross-branch framing the
    // conflict/gate-red paths already use.
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
  readonly repo: RepoRef;
  readonly exec?: ExecFn;
};

// Operator-facing reason out of a failed git invocation. BOTH streams matter:
// push writes its rejection to stderr, but `git merge` writes "CONFLICT
// (content): Merge conflict in <path>" to STDOUT and leaves stderr empty — so
// reading stderr alone reduces a conflict to "Command failed: git merge …",
// which is the one detail an operator reading a parked cycle actually needs.
function pushErrorReason(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const parts = [(e.stderr ?? "").trim(), (e.stdout ?? "").trim()].filter(
    (p) => p.length > 0,
  );
  return parts.join("\n") || e.message || "unknown git error";
}

const defaultExec: ExecFn = (file, args, opts) =>
  execFileAsync(file, [...args], opts);

export function realVerifyAdapter(deps: RealVerifyAdapterDeps): VerifyAdapter {
  const cwd = deps.cwd;
  const repoFlag = `${deps.repo.owner}/${deps.repo.name}`;
  const exec: ExecFn = deps.exec ?? defaultExec;

  /**
   * Failing entries from the legacy combined-status API, shaped as check runs
   * so the pure aggregation has one kind of thing to reason about. A failure to
   * READ this is not caught: an unreadable half of the verdict is an unknown
   * verdict, and the poller's retry/throw is the right handling.
   *
   * One page of 100. More than 100 distinct status contexts on a single commit
   * does not happen outside pathology, and unlike the check-runs walk a short
   * read here can only lose a red we would otherwise have added — it cannot
   * invent a green.
   */
  const failingStatuses = async (sha: string): Promise<ForgeCheckRun[]> => {
    const { stdout } = await exec(
      "gh",
      [
        "api",
        "-H",
        "Accept: application/vnd.github+json",
        `repos/${repoFlag}/commits/${sha}/status?per_page=100`,
      ],
      { cwd, maxBuffer: MAX_BUFFER },
    );
    const body: unknown = JSON.parse(stdout.trim() || "{}");
    if (typeof body !== "object" || body === null) {
      throw new SandbarError(`Unreadable commit-status response for ${sha}.`);
    }
    // Read the `statuses` ARRAY, never the envelope's `state`: a commit with no
    // statuses at all reports `state: "pending"` (verified against the live
    // API), so a caller that trusted `state` would treat every ordinary commit
    // as permanently unresolved and park every cycle.
    const raw = (body as Record<string, unknown>)["statuses"];
    if (!Array.isArray(raw)) return [];
    const out: ForgeCheckRun[] = [];
    // One entry per context: the combined endpoint is documented to return the
    // latest status per context, in which case this changes nothing. It matters
    // if that ever stops holding — the filter below drops successes, so without
    // collapsing first, a context that failed and was re-run green would read
    // red forever and park every cycle on a stale failure. Keeping the first
    // occurrence is no worse than the status quo under any ordering, and right
    // under the documented one.
    const seen = new Set<string>();
    for (const s of raw) {
      const o = s as Record<string, unknown>;
      const state = typeof o["state"] === "string" ? o["state"] : "";
      const context =
        typeof o["context"] === "string" ? o["context"] : "(unnamed status)";
      if (seen.has(context)) continue;
      seen.add(context);
      if (state !== "failure" && state !== "error") continue;
      out.push({
        id: typeof o["id"] === "number" ? o["id"] : 0,
        // Statuses have no check suite; 0 keeps them from ever colliding with
        // a real suite's supersession key, and the `status:` prefix keeps them
        // from colliding with a check-run name in requiredChecks.
        suiteId: 0,
        name: `status:${context}`,
        status: "completed",
        conclusion: state,
        detailsUrl: typeof o["target_url"] === "string" ? o["target_url"] : "",
      });
    }
    return out;
  };

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
      // being landed.
      //
      // Paged explicitly rather than with `gh --paginate`: `--paginate` with a
      // `--jq` filter emits one JSON document PER PAGE (concatenated, not
      // merged), which JSON.parse rejects, and `--slurp` is too new to rely on
      // in a consumer's toolchain. Walking the pages by hand also keeps
      // `total_count` in reach, which is the only way to know the read was
      // whole — a truncated list of check runs is indistinguishable from a
      // green one.
      // Keyed by check-run id, NOT accumulated into an array: the listing has
      // no documented ordering and page N+1 is a separate request, so a run
      // whose sort position shifts between the two comes back twice while
      // another is never returned at all. Counting rows would then reach
      // `total_count` with a run missing — and the missing one is exactly the
      // one that could be red. Counting DISTINCT ids makes that impossible:
      // duplicates collapse, and the shortfall keeps the listing incomplete.
      const byId = new Map<number, ForgeCheckRun>();
      let totalCount: number | null = null;
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
        // The completeness argument rests entirely on this number, so an
        // envelope without it is an unreadable response, not a zero. Defaulting
        // it to 0 would make `runs.length >= totalCount` true after page 1 and
        // declare a 250-run sha whole at 100 — failing in the one direction
        // this module must never fail in.
        if (typeof env["total_count"] !== "number") {
          throw new SandbarError(
            `check-runs response for ${sha} (page ${page}) has no numeric total_count; ` +
              `the read cannot be shown to be complete.`,
          );
        }
        totalCount = env["total_count"];
        for (const r of rawRuns) {
          const o = r as Record<string, unknown>;
          const suite = o["check_suite"] as Record<string, unknown> | undefined;
          // id and suite id are the supersession key. An unreadable one would
          // silently join every other unreadable run under key `0 <name>`,
          // where `r.id > prev.id` is false and the FIRST row wins — landing a
          // stale green over a later red. Refuse the response instead.
          if (typeof o["id"] !== "number") {
            throw new SandbarError(
              `check-runs response for ${sha} (page ${page}) contains a run with no numeric id.`,
            );
          }
          byId.set(o["id"], {
            id: o["id"],
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
        // Done when the forge's own count is accounted for by DISTINCT runs, or
        // the page came back short (nothing further to fetch).
        if (byId.size >= totalCount || rawRuns.length < CHECK_RUN_PAGE_SIZE) {
          complete = byId.size >= totalCount;
          break;
        }
      }
      const runs: ForgeCheckRun[] = [...byId.values()];
      // The legacy commit-status API is a SECOND, separate place the forge
      // reports verdicts (Buildkite, Jenkins, older Vercel/Codecov apps all
      // POST /statuses/:sha and never create a check run). Ignoring it means a
      // sha whose Actions are green and whose deploy status is red reads as
      // green here.
      //
      // Only FAILING statuses are folded in, deliberately asymmetric: they can
      // turn a verdict red but never green, so this cannot manufacture a
      // landing. Pending statuses are NOT waited for — third-party integrations
      // routinely leave one pending forever, and blocking on those would hang
      // cycles on state nobody is going to conclude. The floor that must
      // actually pass is `requiredChecks`, which is check-run names, so a repo
      // whose entire CI reports through statuses cannot use verified mode. It
      // halts rather than landing something: with no check runs at all that is
      // the no-checks fatal, and otherwise — including when a status is already
      // red, which puts a synthetic run in the list and takes the no-checks
      // branch off the table — the required names never appear while everything
      // else concludes, which is the missing-required fatal.
      runs.push(...(await failingStatuses(sha)));

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
      // Not a draft: this PR is an audit handle for a scratch ref, and drafting
      // it would only make the merge button GitHub is not being asked to press
      // look disabled for a reason that does not apply here. The chunk PR (#62)
      // is the one that draws on the draft mechanism.
      return ensureForgePullRequest({
        exec,
        cwd,
        repoFlag,
        head,
        base: deps.sourceBranch,
        title,
        body,
      });
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
