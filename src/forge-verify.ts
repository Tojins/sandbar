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
// Where a sha carries several runs of the same check name (a re-run, or the
// same commit pushed twice), only the newest per name counts — same rule the
// forge UI applies.
//
// Attribution: the landing is always a fast-forward push of commits sandbar
// authored locally, never a server-side merge. `openPullRequest` adds a PR as
// an audit/review handle *around* that push (the forge marks it merged once its
// commits become ancestors of the base), so turning it on never changes who
// authored what.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { lastNLines, stripAnsi, summarizeGateFailure } from "./gate.js";
import {
  type IssueRef,
  type ResolveAdapter,
  type ResolveLogger,
  runResolveLoop,
} from "./resolve-loop.js";

const exec = promisify(execFile);

const MAX_BUFFER = 50 * 1024 * 1024;

// How many push→verify rounds a cycle may spend. Round 1 is the initial
// verification; each further round costs a full CI wall-clock, so the budget is
// small on purpose — the resolve loop gets at most VERIFY_MAX_ROUNDS - 1 shots
// at a red forge before the cycle is parked for a human.
export const VERIFY_MAX_ROUNDS = 3;

// Per failing job, how much of its log reaches the resolve prompt.
export const FORGE_LOG_LINES_PER_JOB = 200;

// Check-run conclusions that count as "this check passed". Everything else —
// failure, timed_out, cancelled, action_required, stale, startup_failure, an
// unknown future value, or a completed run with a null conclusion — counts as
// red. Unknown means red: the whole point of this module is to refuse to land
// on state it cannot read.
export const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set([
  "success",
  "skipped",
  "neutral",
]);

export type ForgeCheckRun = {
  // Check-run id. Monotonic on the forge, so it doubles as the recency key when
  // one commit carries several runs of the same check name.
  readonly id: number;
  readonly name: string;
  // queued | in_progress | completed
  readonly status: string;
  readonly conclusion: string | null;
  // e.g. https://github.com/o/r/actions/runs/123/job/456 — the job id in here is
  // what `gh run view --job` needs to fetch the failing log.
  readonly detailsUrl: string;
};

export type ChecksVerdict =
  | { readonly kind: "pending"; readonly waitingOn: readonly string[] }
  | { readonly kind: "green"; readonly names: readonly string[] }
  | { readonly kind: "red"; readonly failed: readonly ForgeCheckRun[] };

// ---------------------------------------------------------------------------
// Pure aggregation.
// ---------------------------------------------------------------------------

/**
 * Collapse repeated check-run names to the newest run per name (highest id).
 * A re-run of a failed job, or the same sha pushed twice, otherwise leaves the
 * superseded red run visible and would sink a commit the forge considers green.
 */
export function latestByName(
  runs: readonly ForgeCheckRun[],
): readonly ForgeCheckRun[] {
  const byName = new Map<string, ForgeCheckRun>();
  for (const r of runs) {
    const prev = byName.get(r.name);
    if (!prev || r.id > prev.id) byName.set(r.name, r);
  }
  return [...byName.values()];
}

/**
 * Verdict over a sha's check runs.
 *
 * `requiredChecks` empty means "every check the forge reports must pass" —
 * including checks that appear later, which is why an empty run list is
 * `pending` rather than vacuously green. When it is non-empty, only those names
 * are consulted and a name that has not appeared yet keeps the verdict pending
 * (the caller's timeout is what bounds that wait).
 */
export function aggregateCheckRuns(
  runs: readonly ForgeCheckRun[],
  requiredChecks: readonly string[] = [],
): ChecksVerdict {
  const latest = latestByName(runs);

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

  const failed = considered.filter(
    (r) =>
      r.status === "completed" &&
      !PASSING_CONCLUSIONS.has(r.conclusion ?? "__none__"),
  );
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
  listCheckRuns(sha: string): Promise<readonly ForgeCheckRun[]>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: ResolveLogger;
};

export type WaitForChecksOptions = {
  readonly requiredChecks?: readonly string[];
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly noChecksGraceMs?: number;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForChecks(
  sha: string,
  opts: WaitForChecksOptions,
  deps: WaitForChecksDeps,
): Promise<ChecksOutcome> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);
  const grace = opts.noChecksGraceMs ?? NO_CHECKS_GRACE_MS;
  const started = now();

  for (;;) {
    const runs = await deps.listCheckRuns(sha);
    const verdict = aggregateCheckRuns(runs, opts.requiredChecks ?? []);
    if (verdict.kind === "green") {
      await log(`checks green: ${verdict.names.join(", ")}`);
      return { kind: "green", names: verdict.names };
    }
    if (verdict.kind === "red") {
      await log(
        `checks red: ${verdict.failed.map((f) => `${f.name}=${f.conclusion ?? "?"}`).join(", ")}`,
      );
      return { kind: "red", failed: verdict.failed };
    }

    const elapsed = now() - started;
    if (runs.length === 0 && elapsed >= grace) {
      await log(`no check runs reported for ${sha} after ${elapsed}ms`);
      return { kind: "no-checks" };
    }
    if (elapsed >= opts.timeoutMs) {
      await log(
        `checks still pending after ${elapsed}ms: ${verdict.waitingOn.join(", ")}`,
      );
      return { kind: "timeout", waitingOn: verdict.waitingOn };
    }
    await log(`checks pending (${verdict.waitingOn.join(", ")}); polling`);
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
  listCheckRuns(sha: string): Promise<readonly ForgeCheckRun[]>;
  // Failing job's log, best-effort: an unreachable log must degrade the resolve
  // prompt, not abort the landing.
  fetchFailureLog(run: ForgeCheckRun): Promise<string>;
  // git push origin <sha>:<sourceBranch> — a fast-forward by construction
  // (the verified sha descends from origin/<sourceBranch> as observed when the
  // merger worktree was created). A rejection means origin moved underneath us.
  fastForwardSource(sha: string): Promise<PushOutcome>;
  // openPullRequest only. Create-or-reuse; the same PR carries every round of a
  // cycle, so a resolve-loop fix shows up as another commit on it.
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
  | "no-checks"
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
  const abandon = async (
    reason: VerifiedFailureReason,
    detail: string,
    rounds: number,
  ): Promise<VerifiedLandingResult> => {
    if (pr) {
      await deps.verify.closePullRequest(
        pr.number,
        `Sandbar reverted this cycle's merges: ${detail}`,
      );
    }
    return { kind: "abandoned", reason, detail, rounds };
  };

  for (let round = 1; round <= maxRounds; round++) {
    const sha = await deps.resolve.getHeadSha();
    await log(
      `verify round ${round}/${maxRounds}: pushing ${sha} to ${opts.integrationBranch}`,
    );
    const pushed = await deps.verify.pushIntegration(opts.integrationBranch);
    if (pushed.kind !== "ok") {
      return {
        kind: "fatal",
        detail: `push to integration branch '${opts.integrationBranch}' was rejected: ${pushed.reason}`,
      };
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
      return abandon(
        "no-checks",
        `no check runs were created for ${sha} on '${opts.integrationBranch}'. Is the CI workflow triggered for this branch?`,
        round,
      );
    }

    if (outcome.kind === "green") {
      const ff = await deps.verify.fastForwardSource(sha);
      if (ff.kind !== "ok") {
        return {
          kind: "fatal",
          detail:
            `checks passed on ${sha} but the fast-forward to '${opts.sourceBranch}' was rejected: ${ff.reason}. ` +
            `origin/${opts.sourceBranch} moved while the forge was verifying; the verified sha no longer fast-forwards. ` +
            `Nothing was landed — re-run sandbar to re-merge and re-verify against the new tip.`,
        };
      }
      await log(`verify: fast-forwarded ${opts.sourceBranch} to ${sha}`);
      return { kind: "landed", sha, rounds: round, pullRequest: pr };
    }

    // Red.
    const failedNames = outcome.failed.map((f) => f.name).join(", ");
    if (round === maxRounds) {
      return abandon(
        "checks-red",
        `forge checks red after ${round} round(s): ${failedNames}`,
        round,
      );
    }

    const jobs: { name: string; log: string }[] = [];
    for (const f of outcome.failed) {
      jobs.push({ name: f.name, log: await deps.verify.fetchFailureLog(f) });
    }
    const trace = buildForgeRedTrace(jobs);

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
      return abandon(
        "resolve-abandon",
        `forge checks red (${failedNames}); resolve loop gave up: ${resolved.reason}`,
        round,
      );
    }
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
  };
}

// ---------------------------------------------------------------------------
// Real adapter — shells out to git + gh.
// ---------------------------------------------------------------------------

export type RealVerifyAdapterDeps = {
  // The merger worktree (detached at origin/<sourceBranch>).
  readonly cwd: string;
  readonly sourceBranch: string;
  readonly repo: { readonly owner: string; readonly name: string };
};

function pushErrorReason(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr ?? "").trim() || e.message || "unknown push error";
}

export function realVerifyAdapter(deps: RealVerifyAdapterDeps): VerifyAdapter {
  const cwd = deps.cwd;
  const repoFlag = `${deps.repo.owner}/${deps.repo.name}`;

  return {
    async pushIntegration(branch) {
      // Observe the remote ref first so the force-push can be lease-protected:
      // the merger worktree has no remote-tracking ref for a scratch branch it
      // never checks out, so the implicit `--force-with-lease` form would have
      // nothing to compare against.
      let remoteSha: string | null = null;
      try {
        const { stdout } = await exec(
          "git",
          ["ls-remote", "origin", `refs/heads/${branch}`],
          { cwd },
        );
        const first = stdout.split("\n")[0]?.trim();
        remoteSha = first ? (first.split(/\s+/)[0] ?? null) : null;
      } catch (err) {
        return { kind: "rejected", reason: pushErrorReason(err) };
      }
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
      const { stdout } = await exec(
        "gh",
        [
          "api",
          "-H",
          "Accept: application/vnd.github+json",
          `repos/${repoFlag}/commits/${sha}/check-runs?per_page=100`,
          "--jq",
          ".check_runs",
        ],
        { cwd, maxBuffer: MAX_BUFFER },
      );
      const raw: unknown = JSON.parse(stdout.trim() || "[]");
      if (!Array.isArray(raw)) return [];
      return raw.map((r) => {
        const o = r as Record<string, unknown>;
        return {
          id: typeof o["id"] === "number" ? o["id"] : 0,
          name: typeof o["name"] === "string" ? o["name"] : "(unnamed)",
          status: typeof o["status"] === "string" ? o["status"] : "queued",
          conclusion:
            typeof o["conclusion"] === "string" ? o["conclusion"] : null,
          detailsUrl:
            typeof o["details_url"] === "string" ? o["details_url"] : "",
        };
      });
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
        return {
          number: typeof o["number"] === "number" ? o["number"] : 0,
          url: typeof o["url"] === "string" ? o["url"] : "",
        };
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
