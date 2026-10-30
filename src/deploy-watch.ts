// The deploy watch (#198): a red consumer deploy run files one bug issue.
//
// A commit on the source branch is the deploy (#146), and sandbar's own checks
// end at the post-merge gate. The consumer's deploy workflow (outdoor:
// `deploy.yml`, on push to main) already turns red when the deploy breaks;
// this module watches that run on sandbar's behalf and connects a red one back
// to the issues whose merges it shipped. No auto-revert: recovery is a human
// decision, so the only writes are one bug issue per red run and comments.
//
// NO STATE ON DISK. Each tick re-derives everything from origin plus the
// forge: the last RUN_WINDOW `push` runs of the workflow on the source branch,
// each paired with the previous run that was not cancelled (`deployRanges`),
// and the git range between their head shas read from the host bare cache.
// Markers on the forge say what has already been written. A state file would
// have to survive restart, crash and an exit mid-write, and could drift from
// the forge; the cost of having none is that a red run scrolling out of the
// window while the daemon is down is never filed.
//
// ATTRIBUTION IS BY GIT SUBJECT. Every `Merge sandbar/issue-<n>: <title>` in a
// run's range (`parseIssueMergeSubject`, the merger's own subject) is a landing
// that run deployed — including members merged inside a landed chunk. Any
// other non-merge commit outside every merged issue branch is counted, never
// blamed, and a red range with no sandbar merge is not sandbar's to file.
//
// COVERAGE. The consumer's `concurrency: deploy, cancel-in-progress: false`
// cancels the pending run of an older push and deploys both with the newer
// one, so a `cancelled` run is neither a verdict nor a range anchor: its
// landings fall into the next run that was not. `workflow_dispatch` runs are
// human rollbacks and are not listed (`--event push`). The oldest run in the
// window has no anchor and is not attributable.
//
// VERDICTS (`classifyConclusion`): `success`/`neutral` green, `cancelled`
// ignored, `skipped` unverified, everything else — any unknown future value
// too — red. A landing with no concluded covering run within `timeoutMs` of
// its merge's committer time is reported unverified; that is a configured
// deadline, not a measured timing feeding a decision (#82).
//
// WRITES ARE CHECK-THEN-CREATE against forge markers, in the order bug issue →
// each originating issue's comment → event → mark handled, so a restart, a
// crash between writes or a rerun never produces a second issue: the next tick
// redoes only what is missing. Dedupe reads the dedicated label's listing, not
// search, whose index lags (a crash and an immediate retry could file twice).
// The bug body carries `<!-- sandbar:deploy-run=<id> attempt=<n> -->`; the one
// @-mention of the operator is in that body, so a chunk of eight members sends
// one email. This module holds the ONLY `gh issue create` in `src/`
// (`issue-create-site.test.ts`); the issue carries `1-human-spec` plus the
// dedupe label, never `2-agent-build`.
//
// RERUNS. `gh run list` reports a run's latest attempt only. When a filed run
// shows a newer concluded attempt, the bug issue gets one comment for that
// attempt stating its conclusion — attempts that came and went unobserved are
// not reconstructed. A green rerun never closes the issue. A red rerun of a run
// that was green on attempt 1 files as usual, on its attempt.
//
// THE WATCHER. `createDeployWatcher` keeps only memory: which run attempts and
// which unverified landings it has handled, and whether it has seeded. The
// first tick after startup takes stock — concluded runs are marked handled
// without green or unverified events, which every restart would otherwise
// re-emit — but still ensures reds; a red event is emitted only when this
// process filed or commented. `kick()` is single-flight and never awaited;
// `stop()` blocks further writes and emits and resolves with the in-flight
// tick. A forge rate limit hands over to `onRateLimited`, a request the forge
// never answered is a notice, any other forge answer a complaint (once per
// distinct message), and a lease lost to terminal cleanup abandons the tick.
// Nothing else is caught: a bug propagates as the tick's rejection.

import {
  SandbarError,
  hasExitCode,
  isExitCode,
  isForgeRateLimit,
  isForgeTransportFailure,
} from "./errors.js";
import type { DeployWatchSettings } from "./config.js";
import type { EventInput } from "./events.js";
import { BOT_COMMENT_PREFIX } from "./finalize.js";
import {
  type ExecFn,
  MAX_BUFFER,
  PASSING_CONCLUSIONS,
  buildForgeRedTrace,
  defaultExec,
  fetchJobFailedLog,
  pushErrorReason,
} from "./forge-verify.js";
import { parseIssueMergeSubject } from "./naming.js";
import {
  OriginLeaseLostDuringCleanupError,
  type OriginWriteBarrier,
} from "./origin-lock.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";

// Runs listed per tick. Outdoor deploys about ten times a day, so the window
// covers days of downtime.
export const RUN_WINDOW = 20;
// Bug issues read per dedupe listing.
export const BUG_LIST_LIMIT = 100;
// Failed jobs whose log tail reaches the bug body, and lines per job.
export const BUG_LOG_JOBS = 3;
export const BUG_LOG_LINES_PER_JOB = 60;
// GitHub refuses an issue body over 65 536 characters.
export const BUG_BODY_MAX_CHARS = 60_000;
export const HUMAN_SPEC_LABEL = "1-human-spec";

const EXEC_TIMEOUT_MS = 60_000;
const TRUNCATED_NOTE = "\n\n(truncated)";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export type DeployRun = {
  readonly id: number;
  readonly headSha: string;
  readonly status: string;
  // Empty until the run completes.
  readonly conclusion: string;
  readonly attempt: number;
  readonly url: string;
};

// A run and the previous run that was not cancelled: the run deployed
// `anchor.headSha..run.headSha`.
export type RunRange = {
  readonly run: DeployRun;
  readonly anchor: DeployRun;
};

export type Landing = {
  readonly issue: number;
  readonly title: string;
  // The merge commit.
  readonly sha: string;
  readonly committedAtMs: number;
};

export type RangeCommits = {
  readonly landings: readonly Landing[];
  // Non-merge commits outside every merged issue branch.
  readonly otherCommits: number;
};

export type AttributedRange = RunRange & RangeCommits;

export type BugRecord = {
  readonly issue: number;
  readonly runId: number;
  readonly filedAttempt: number;
};

export type RunVerdict = "pending" | "green" | "red" | "unverified" | "ignore";
export type DeployOutcome = Exclude<RunVerdict, "pending" | "ignore">;

// One verdict for #194 to count. For a landing that timed out, `runId` and
// `attempt` are null and `sha` is its merge commit.
export type DeployEvent = {
  readonly kind: "deploy";
  readonly outcome: DeployOutcome;
  readonly workflow: string;
  readonly runId: number | null;
  readonly attempt: number | null;
  readonly sha: string;
  readonly issues: readonly number[];
  readonly bugIssue: number | null;
  readonly filed: boolean;
};

export type DeployWatchEvent =
  | DeployEvent
  | Extract<EventInput, { kind: "notice" | "complaint" }>;

export type FailedJob = {
  readonly name: string;
  readonly url: string;
  readonly conclusion: string;
  readonly failedSteps: readonly string[];
};

export type RedJobs = {
  readonly failed: readonly FailedJob[];
  // Log tails of the first BUG_LOG_JOBS failed jobs.
  readonly logs: readonly { readonly name: string; readonly log: string }[];
};

// A forge or git answer this module could not read.
export class DeployWatchReadError extends SandbarError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DeployWatchReadError";
  }
}

// ---------------------------------------------------------------------------
// Pure layer.
// ---------------------------------------------------------------------------

export function classifyConclusion(status: string, conclusion: string): RunVerdict {
  if (status !== "completed") return "pending";
  if (PASSING_CONCLUSIONS.has(conclusion)) return "green";
  if (conclusion === "cancelled") return "ignore";
  if (conclusion === "skipped") return "unverified";
  return "red";
}

function verdictOf(run: DeployRun): RunVerdict {
  return classifyConclusion(run.status, run.conclusion);
}

function isOutcome(verdict: RunVerdict): verdict is DeployOutcome {
  return verdict !== "pending" && verdict !== "ignore";
}

export function deployRanges(runs: readonly DeployRun[]): RunRange[] {
  const ranges: RunRange[] = [];
  let anchor: DeployRun | null = null;
  for (const run of [...runs].sort((a, b) => a.id - b.id)) {
    if (verdictOf(run) === "ignore") continue;
    if (anchor !== null) ranges.push({ run, anchor });
    anchor = run;
  }
  return ranges;
}

// Concluded ranges this process has not handled at their current attempt.
export function rangesDue(
  ranges: readonly RunRange[],
  handled: ReadonlyMap<number, number>,
): RunRange[] {
  return ranges.filter(
    (r) => isOutcome(verdictOf(r.run)) && handled.get(r.run.id) !== r.run.attempt,
  );
}

// The head of the newest run with a verdict: landings after it are not yet
// covered. Null when no run in the window has concluded.
export function coveredThrough(runs: readonly DeployRun[]): string | null {
  const concluded = runs.filter((r) => isOutcome(verdictOf(r)));
  if (concluded.length === 0) return null;
  return concluded.reduce((a, b) => (b.id > a.id ? b : a)).headSha;
}

// Whether any due range needs the bug listing: a red files against it, and a
// rerun may have a bug filed on an earlier attempt.
export function needsBugListing(ranges: readonly AttributedRange[]): boolean {
  return ranges.some(
    (r) => r.landings.length > 0 && (verdictOf(r.run) === "red" || r.run.attempt > 1),
  );
}

export type RangeCommit = {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly committedAtMs: number;
  readonly subject: string;
};

// The range commits reachable from `starts`.
function reachable(
  starts: readonly string[],
  bySha: ReadonlyMap<string, RangeCommit>,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...starts];
  for (let sha = stack.pop(); sha !== undefined; sha = stack.pop()) {
    const commit = bySha.get(sha);
    if (commit === undefined || seen.has(sha)) continue;
    seen.add(sha);
    stack.push(...commit.parents);
  }
  return seen;
}

// `commits` newest first, as `git log` lists them. One landing per issue, its
// newest merge. What an issue merge brought in — reachable from its merged
// side but not from its first parent — is the issue's, not an other commit.
export function attributeCommits(commits: readonly RangeCommit[]): RangeCommits {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const merged = new Set<string>();
  const landings = new Map<number, Landing>();
  for (const c of commits) {
    const parsed = parseIssueMergeSubject(c.subject);
    const [first, ...side] = c.parents;
    if (parsed === null || first === undefined || side.length === 0) continue;
    if (!landings.has(parsed.issue)) {
      landings.set(parsed.issue, { ...parsed, sha: c.sha, committedAtMs: c.committedAtMs });
    }
    const before = reachable([first], bySha);
    for (const sha of reachable(side, bySha)) if (!before.has(sha)) merged.add(sha);
  }
  return {
    landings: [...landings.values()],
    otherCommits: commits.filter((c) => c.parents.length < 2 && !merged.has(c.sha))
      .length,
  };
}

// What the forge says about a due range, read before deciding.
export type ExaminedRange = {
  readonly range: AttributedRange;
  readonly bug: BugRecord | null;
  // Originating issues already carrying this run's marker.
  readonly commentedOrigins: ReadonlySet<number>;
  // Whether the bug issue already has the comment for the run's attempt.
  readonly attemptCommented: boolean;
};

export type TickInput = {
  readonly examined: readonly ExaminedRange[];
  // Landings no concluded run covers yet.
  readonly pending: readonly Landing[];
  readonly reportedLandings: ReadonlySet<string>;
  readonly nowMs: number;
  readonly timeoutMs: number;
  readonly seeding: boolean;
};

// Every action names its range's run; the watcher resolves the run's bug
// issue from the listing, or from the `file-bug` before it.
export type TickAction =
  | { readonly kind: "file-bug"; readonly range: AttributedRange }
  | { readonly kind: "comment-origin"; readonly range: AttributedRange; readonly issue: number }
  | { readonly kind: "comment-attempt"; readonly range: AttributedRange; readonly outcome: DeployOutcome }
  | {
      readonly kind: "record";
      readonly range: AttributedRange;
      readonly outcome: DeployOutcome;
      readonly emit: boolean;
      readonly filed: boolean;
    }
  | { readonly kind: "record-unverified"; readonly landing: Landing; readonly emit: boolean };

function rangeActions(e: ExaminedRange, seeding: boolean): TickAction[] {
  const { range, bug } = e;
  const verdict = verdictOf(range.run);
  if (!isOutcome(verdict)) return [];
  const record = (emit: boolean, filed: boolean): TickAction => ({
    kind: "record",
    range,
    outcome: verdict,
    emit,
    filed,
  });
  if (range.landings.length === 0) return [record(false, false)];
  if (bug === null) {
    if (verdict !== "red") return [record(!seeding, false)];
    return [
      { kind: "file-bug", range },
      ...range.landings.map((l): TickAction => ({ kind: "comment-origin", range, issue: l.issue })),
      record(true, true),
    ];
  }
  const writes: TickAction[] = range.landings
    .filter((l) => !e.commentedOrigins.has(l.issue))
    .map((l) => ({ kind: "comment-origin", range, issue: l.issue }));
  if (range.run.attempt > bug.filedAttempt && !e.attemptCommented) {
    writes.push({ kind: "comment-attempt", range, outcome: verdict });
  }
  const emit = verdict === "red" ? writes.length > 0 : !seeding;
  return [...writes, record(emit, false)];
}

export function decideTick(input: TickInput): TickAction[] {
  return [
    ...input.examined.flatMap((e) => rangeActions(e, input.seeding)),
    ...input.pending
      .filter(
        (l) =>
          !input.reportedLandings.has(l.sha) &&
          input.nowMs - l.committedAtMs >= input.timeoutMs,
      )
      .map((landing): TickAction => ({
        kind: "record-unverified",
        landing,
        emit: !input.seeding,
      })),
  ];
}

// ---------------------------------------------------------------------------
// Markers and renderers.
// ---------------------------------------------------------------------------

export function runMarker(runId: number, attempt: number): string {
  return `<!-- sandbar:deploy-run=${runId} attempt=${attempt} -->`;
}

export function parseRunMarker(
  text: string,
): { readonly runId: number; readonly attempt: number } | null {
  const m = text.match(/<!-- sandbar:deploy-run=(\d+) attempt=(\d+) -->/);
  return m && m[1] !== undefined && m[2] !== undefined
    ? { runId: Number(m[1]), attempt: Number(m[2]) }
    : null;
}

const sha7 = (sha: string): string => sha.slice(0, 7);

function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : text.slice(0, max - TRUNCATED_NOTE.length) + TRUNCATED_NOTE;
}

export function renderBugTitle(workflow: string, run: DeployRun): string {
  return `Deploy failed: ${workflow} run ${run.id} on ${sha7(run.headSha)}`;
}

export function renderBugBody(args: {
  readonly settings: DeployWatchSettings;
  readonly range: AttributedRange;
  readonly jobs: RedJobs;
}): string {
  const { settings, range, jobs } = args;
  const { run, anchor } = range;
  const head = [
    runMarker(run.id, run.attempt),
    `@${settings.notifyLogin}`,
    "",
    `${BOT_COMMENT_PREFIX} the \`${settings.workflow}\` run for \`${sha7(run.headSha)}\` ` +
      `concluded \`${run.conclusion}\` on attempt ${run.attempt}.`,
    "",
    `- Run: ${run.url}`,
    `- Commit: \`${run.headSha}\``,
    `- Range: \`${sha7(anchor.headSha)}..${sha7(run.headSha)}\``,
    `- Previous deploy: ${anchor.url} (\`${anchor.conclusion || anchor.status}\`)`,
    "",
    "Landed in this range:",
    "",
    ...range.landings.map((l) => `- #${l.issue} — ${l.title} (merge \`${sha7(l.sha)}\`)`),
    ...(range.otherCommits > 0
      ? [`- ${range.otherCommits} other commit(s) not from a sandbar issue merge`]
      : []),
    "",
    "No revert was attempted.",
    "",
    "## Failed jobs",
    "",
    ...(jobs.failed.length === 0
      ? ["(the run reported no failed job)"]
      : jobs.failed.map(
          (j) =>
            `- [${j.name}](${j.url}) — \`${j.conclusion}\`` +
            (j.failedSteps.length > 0
              ? `; failed steps: ${j.failedSteps.map((s) => `\`${s}\``).join(", ")}`
              : ""),
        )),
  ].join("\n");
  const elided = jobs.failed.length - jobs.logs.length;
  const trace =
    buildForgeRedTrace(jobs.logs, BUG_LOG_LINES_PER_JOB) +
    (elided > 0 ? `\n\n(${elided} more failed job(s) not shown)` : "");
  const open = "\n\n## Log tail\n\n````text\n";
  const close = "\n````";
  const budget = BUG_BODY_MAX_CHARS - head.length - open.length - close.length;
  const body =
    budget > TRUNCATED_NOTE.length ? head + open + truncate(trace, budget) + close : head;
  return truncate(body, BUG_BODY_MAX_CHARS);
}

export function renderOriginComment(args: {
  readonly workflow: string;
  readonly run: DeployRun;
  readonly bugIssue: number;
}): string {
  const { run } = args;
  return (
    `${BOT_COMMENT_PREFIX} the \`${args.workflow}\` run that deployed this issue's merge ` +
    `failed (${run.url}). Filed as #${args.bugIssue}; no revert was attempted.\n\n` +
    runMarker(run.id, run.attempt)
  );
}

export function renderAttemptComment(args: {
  readonly workflow: string;
  readonly run: DeployRun;
}): string {
  const { run } = args;
  return (
    `${BOT_COMMENT_PREFIX} attempt ${run.attempt} of the \`${args.workflow}\` run ` +
    `concluded \`${run.conclusion}\` (${run.url}). This issue stays open: recovery ` +
    "is a human decision.\n\n" +
    runMarker(run.id, run.attempt)
  );
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export type DeployWatchAdapter = {
  listRuns(): Promise<readonly DeployRun[]>;
  // Null when either end is missing from the cache: the tick retries after
  // the next fetch.
  landingsBetween(base: string, head: string): Promise<RangeCommits | null>;
  // `base..origin/<sourceBranch>`.
  landingsSince(base: string): Promise<RangeCommits | null>;
  failedJobs(runId: number): Promise<RedJobs>;
  listBugs(): Promise<readonly BugRecord[]>;
  // Whether a comment on `issue` carries this run's marker; `attempt: null`
  // matches any attempt.
  hasMarker(issue: number, runId: number, attempt: number | null): Promise<boolean>;
  createIssue(title: string, body: string): Promise<number>;
  comment(issue: number, body: string): Promise<void>;
};

export type RealDeployWatchAdapterDeps = {
  readonly repo: RepoRef;
  // The host bare cache.
  readonly repoDir: string;
  readonly sourceBranch: string;
  readonly workflow: string;
  readonly label: string;
  readonly beforeOriginWrite: OriginWriteBarrier;
  readonly exec?: ExecFn;
};

function parseJson(stdout: string, what: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new DeployWatchReadError(`${what} is not JSON`, { cause: err });
  }
}

function prop(o: unknown, key: string): unknown {
  return typeof o === "object" && o !== null ? (o as Record<string, unknown>)[key] : undefined;
}

function field<T>(
  o: unknown,
  key: string,
  is: (v: unknown) => v is T,
  what: string,
): T {
  const v = prop(o, key);
  if (!is(v)) throw new DeployWatchReadError(`${what} has no readable \`${key}\``);
  return v;
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isString = (v: unknown): v is string => typeof v === "string";

function arrayOf(json: unknown, what: string): unknown[] {
  if (!Array.isArray(json)) throw new DeployWatchReadError(`${what} is not a list`);
  return json;
}

export function readRuns(json: unknown): DeployRun[] {
  return arrayOf(json, "gh run list").map((r) => ({
    id: field(r, "databaseId", isNumber, "a listed run"),
    headSha: field(r, "headSha", isString, "a listed run"),
    status: field(r, "status", isString, "a listed run"),
    conclusion: field(r, "conclusion", isString, "a listed run"),
    attempt: field(r, "attempt", isNumber, "a listed run"),
    url: field(r, "url", isString, "a listed run"),
  }));
}

export function readRangeLog(stdout: string): RangeCommit[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, parents, ct, subject] = line.split("\0");
      if (sha === undefined || parents === undefined || ct === undefined || subject === undefined) {
        throw new DeployWatchReadError(`unreadable git log line: ${line}`);
      }
      return {
        sha,
        parents: parents.split(" ").filter((p) => p.length > 0),
        committedAtMs: Number(ct) * 1000,
        subject,
      };
    });
}

export function realDeployWatchAdapter(deps: RealDeployWatchAdapterDeps): DeployWatchAdapter {
  const repoFlag = repoSlug(deps.repo);
  const baseExec = deps.exec ?? defaultExec;
  const exec: ExecFn = (file, args, opts) =>
    baseExec(file, args, { ...opts, timeout: EXEC_TIMEOUT_MS });
  const cwd = deps.repoDir;
  const gh = async (args: readonly string[]): Promise<string> =>
    (await exec("gh", args, { cwd, maxBuffer: MAX_BUFFER })).stdout;
  const git = async (args: readonly string[]): Promise<string> =>
    (await exec("git", ["-C", cwd, ...args], { cwd, maxBuffer: MAX_BUFFER })).stdout;

  const hasCommit = async (rev: string): Promise<boolean> => {
    try {
      await git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
      return true;
    } catch (err) {
      // `--quiet` answers a missing commit with exit 1 and nothing else.
      if (isExitCode(err, 1)) return false;
      throw err;
    }
  };

  const landingsBetween = async (base: string, head: string): Promise<RangeCommits | null> => {
    const present = await Promise.all([hasCommit(base), hasCommit(head)]);
    if (present.includes(false)) return null;
    return attributeCommits(
      readRangeLog(await git(["log", "--format=%H%x00%P%x00%ct%x00%s", `${base}..${head}`])),
    );
  };

  return {
    async listRuns() {
      return readRuns(
        parseJson(
          await gh([
            "run",
            "list",
            "--repo",
            repoFlag,
            "--workflow",
            deps.workflow,
            "--branch",
            deps.sourceBranch,
            "--event",
            "push",
            "--limit",
            String(RUN_WINDOW),
            "--json",
            "databaseId,headSha,status,conclusion,attempt,url",
          ]),
          "gh run list",
        ),
      );
    },

    landingsBetween,

    landingsSince(base) {
      return landingsBetween(base, `refs/remotes/origin/${deps.sourceBranch}`);
    },

    async failedJobs(runId) {
      const view = parseJson(
        await gh(["run", "view", String(runId), "--repo", repoFlag, "--json", "jobs"]),
        "gh run view",
      );
      const jobs = arrayOf(prop(view, "jobs"), "gh run view jobs").map((j) => ({
        id: field(j, "databaseId", isNumber, "a run job"),
        name: field(j, "name", isString, "a run job"),
        url: field(j, "url", isString, "a run job"),
        conclusion: field(j, "conclusion", isString, "a run job"),
        steps: arrayOf(prop(j, "steps"), "a run job steps"),
      }));
      // A job concluded like a run: cancelled and skipped jobs did not fail.
      const failed = jobs.filter((j) => classifyConclusion("completed", j.conclusion) === "red");
      const logs = await Promise.all(
        failed.slice(0, BUG_LOG_JOBS).map(async (j) => ({
          name: j.name,
          log: await fetchJobFailedLog({
            exec,
            cwd,
            repoFlag,
            jobId: String(j.id),
            name: j.name,
            conclusion: j.conclusion,
            url: j.url,
          }),
        })),
      );
      return {
        failed: failed.map((j) => ({
          name: j.name,
          url: j.url,
          conclusion: j.conclusion,
          failedSteps: j.steps
            .filter((s) => field(s, "conclusion", isString, "a job step") === "failure")
            .map((s) => field(s, "name", isString, "a job step")),
        })),
        logs,
      };
    },

    async listBugs() {
      const issues = arrayOf(
        parseJson(
          await gh([
            "issue",
            "list",
            "--repo",
            repoFlag,
            "--label",
            deps.label,
            "--state",
            "all",
            "--limit",
            String(BUG_LIST_LIMIT),
            "--json",
            "number,body",
          ]),
          "gh issue list",
        ),
        "gh issue list",
      );
      return issues.flatMap((i) => {
        const marker = parseRunMarker(field(i, "body", isString, "a listed issue"));
        return marker === null
          ? []
          : [{
              issue: field(i, "number", isNumber, "a listed issue"),
              runId: marker.runId,
              filedAttempt: marker.attempt,
            }];
      });
    },

    async hasMarker(issue, runId, attempt) {
      const view = parseJson(
        await gh(["issue", "view", String(issue), "--repo", repoFlag, "--json", "comments"]),
        "gh issue view",
      );
      return arrayOf(prop(view, "comments"), "gh issue view comments").some((c) => {
        const marker = parseRunMarker(field(c, "body", isString, "an issue comment"));
        return marker !== null && marker.runId === runId &&
          (attempt === null || marker.attempt === attempt);
      });
    },

    async createIssue(title, body) {
      await deps.beforeOriginWrite();
      const url = (
        await gh([
          "issue",
          "create",
          "--repo",
          repoFlag,
          "--title",
          title,
          "--body",
          body,
          "--label",
          HUMAN_SPEC_LABEL,
          "--label",
          deps.label,
        ])
      ).trim();
      const m = url.match(/\/issues\/(\d+)$/);
      if (!m || m[1] === undefined) {
        throw new DeployWatchReadError(`gh issue create answered ${JSON.stringify(url)}`);
      }
      return Number(m[1]);
    },

    async comment(issue, body) {
      await deps.beforeOriginWrite();
      await gh(["issue", "comment", String(issue), "--repo", repoFlag, "--body", body]);
    },
  };
}

// ---------------------------------------------------------------------------
// Watcher.
// ---------------------------------------------------------------------------

export type DeployWatcherDeps = {
  readonly adapter: DeployWatchAdapter;
  readonly settings: DeployWatchSettings;
  readonly emit: (event: DeployWatchEvent) => Promise<unknown>;
  readonly onRateLimited: () => Promise<void>;
  readonly now?: () => number;
};

export type DeployWatcher = {
  kick(): void;
  stop(): Promise<void>;
};

// `execFile`'s own timeout: the child was killed, the forge never answered.
function isExecTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null &&
    (err as { killed?: unknown }).killed === true;
}

export function createDeployWatcher(deps: DeployWatcherDeps): DeployWatcher {
  const { adapter, settings } = deps;
  const now = deps.now ?? Date.now;
  const handled = new Map<number, number>();
  const reportedLandings = new Set<string>();
  const complained = new Set<string>();
  let seeded = false;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const examine = async (
    range: AttributedRange,
    bugs: readonly BugRecord[],
  ): Promise<ExaminedRange> => {
    const bug = bugs.find((b) => b.runId === range.run.id) ?? null;
    if (bug === null || range.landings.length === 0) {
      return { range, bug, commentedOrigins: new Set(), attemptCommented: false };
    }
    const [origins, attemptCommented] = await Promise.all([
      Promise.all(
        range.landings.map(async (l) =>
          (await adapter.hasMarker(l.issue, range.run.id, null)) ? [l.issue] : [],
        ),
      ),
      range.run.attempt > bug.filedAttempt
        ? adapter.hasMarker(bug.issue, range.run.id, range.run.attempt)
        : Promise.resolve(false),
    ]);
    return { range, bug, commentedOrigins: new Set(origins.flat()), attemptCommented };
  };

  const execute = async (
    actions: readonly TickAction[],
    bugIssues: Map<number, number>,
  ): Promise<void> => {
    const bugOf = (run: DeployRun): number => {
      const issue = bugIssues.get(run.id);
      if (issue === undefined) throw new Error(`no bug issue for run ${run.id}`);
      return issue;
    };
    for (const action of actions) {
      if (stopped) return;
      switch (action.kind) {
        case "file-bug": {
          const { run } = action.range;
          const jobs = await adapter.failedJobs(run.id);
          if (stopped) return;
          bugIssues.set(
            run.id,
            await adapter.createIssue(
              renderBugTitle(settings.workflow, run),
              renderBugBody({ settings, range: action.range, jobs }),
            ),
          );
          break;
        }
        case "comment-origin": {
          const { run } = action.range;
          await adapter.comment(
            action.issue,
            renderOriginComment({ workflow: settings.workflow, run, bugIssue: bugOf(run) }),
          );
          break;
        }
        case "comment-attempt": {
          const { run } = action.range;
          await adapter.comment(bugOf(run), renderAttemptComment({ workflow: settings.workflow, run }));
          break;
        }
        case "record": {
          const { run, landings } = action.range;
          if (action.emit) {
            await deps.emit({
              kind: "deploy",
              outcome: action.outcome,
              workflow: settings.workflow,
              runId: run.id,
              attempt: run.attempt,
              sha: run.headSha,
              issues: landings.map((l) => l.issue),
              bugIssue: bugIssues.get(run.id) ?? null,
              filed: action.filed,
            });
          }
          handled.set(run.id, run.attempt);
          break;
        }
        case "record-unverified": {
          const { landing } = action;
          if (action.emit) {
            await deps.emit({
              kind: "deploy",
              outcome: "unverified",
              workflow: settings.workflow,
              runId: null,
              attempt: null,
              sha: landing.sha,
              issues: [landing.issue],
              bugIssue: null,
              filed: false,
            });
          }
          reportedLandings.add(landing.sha);
          break;
        }
      }
    }
  };

  const tick = async (): Promise<void> => {
    const runs = await adapter.listRuns();
    const due = rangesDue(deployRanges(runs), handled);
    const through = coveredThrough(runs);
    const [read, pending] = await Promise.all([
      Promise.all(
        due.map(async (r) => {
          const commits = await adapter.landingsBetween(r.anchor.headSha, r.run.headSha);
          return commits === null ? [] : [{ ...r, ...commits }];
        }),
      ),
      through === null ? Promise.resolve(null) : adapter.landingsSince(through),
    ]);
    const attributed = read.flat();
    const bugs = needsBugListing(attributed) ? await adapter.listBugs() : [];
    const examined = await Promise.all(attributed.map((r) => examine(r, bugs)));
    const actions = decideTick({
      examined,
      pending: pending?.landings ?? [],
      reportedLandings,
      nowMs: now(),
      timeoutMs: settings.timeoutMs,
      seeding: !seeded,
    });
    await execute(actions, new Map(bugs.map((b) => [b.runId, b.issue])));
    if (!stopped) seeded = true;
  };

  const report = async (event: DeployWatchEvent): Promise<void> => {
    if (!stopped) await deps.emit(event);
  };

  const runTick = async (): Promise<void> => {
    try {
      await tick();
    } catch (err) {
      if (err instanceof OriginLeaseLostDuringCleanupError) return;
      if (isForgeRateLimit(err)) return await deps.onRateLimited();
      const reason = pushErrorReason(err);
      if (isForgeTransportFailure(err) || isExecTimeout(err)) {
        return await report({
          kind: "notice",
          message: `Deploy watch: the forge did not answer (${reason}); retrying on the next poll.`,
        });
      }
      if (!hasExitCode(err) && !(err instanceof DeployWatchReadError)) throw err;
      const message = `Deploy watch: ${reason}`;
      if (complained.has(message)) return;
      complained.add(message);
      await report({ kind: "complaint", severity: "warning", message });
    }
  };

  return {
    kick() {
      if (stopped || inFlight !== null) return;
      inFlight = runTick().finally(() => {
        inFlight = null;
      });
    },
    async stop() {
      stopped = true;
      await inFlight;
    },
  };
}
