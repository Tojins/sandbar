// One idle janitor run (#205): the I/O around `janitor-plan.ts`'s decisions
// and one `runInnerLoop` under the task's name.
//
// The run's start is recorded in the task's ledger before anything else, so
// every run — held, failed or pre-empted included — counts against
// `runsPerDay`: that count is what bounds a task whose runs keep failing.
// Then, with zero tokens:
//   1. the rolling branch's latest pull request, in any state (`gh pr list
//      --head --state all`), and origin's tips of it and of the source as the
//      recompute fetched them, decide fresh or continue (`decideRollingBase`);
//   2. the task's prompt source is read at the source tip; a missing one
//      holds the task (`source-missing`);
//   3. continuing a branch the source has moved past merges the source in
//      with `git merge-tree --write-tree` and `commit-tree` in the bare
//      cache, a driver commit under the bot identity that sits in the run's
//      base, so the roles see only this run's delta. A conflict holds the
//      task and says so on its pull request, once per hold key;
//   4. the scope is picked from the source tip's blobs under the task's
//      pathspecs; with none, the run is `no-change` and spends nothing;
//   5. the previous run's clone is reclaimed (one that must be preserved
//      holds the task, `clone-preserved`) and the local branch set to the
//      base, which the inner loop is handed as a sha, with the rendered task
//      anchor as its spec.
// A hold is a `notice` and the run ends there, with no `janitor-run`.
//
// Only a DONE run reaches origin. Right before its push the runner checks the
// abort flag and re-reads the pull request, discarding the run when it now
// carries `land` (a reviewed PR never grows), then pushes the cache's branch
// with `--force-with-lease` on the origin tip seen at the start (none: the
// branch must not exist). A lease that no longer holds means a human pushed:
// the run is discarded and the next one continues from their tip. Then the
// draft pull request is ensured. Every other ending leaves origin untouched,
// a rejected run's commits included; a rejection writes nothing to GitHub.
//
// Exactly two failures are caught, around the loop: `InnerLoopAbortedError`,
// the pre-emption, is `pre-empted`; a provider's quota or credential error is
// `failed` (the run's provider state has already heard it). Anything else
// propagates to `settleJanitorRun`, which records the run as `failed` and
// settles: the daemon carries on, and `runsPerDay` bounds a repeat.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { JanitorTask, PromptExtension } from "./config.js";
import type { EventInput } from "./events.js";
import { AgentCredentialError, AgentQuotaError, reclaimIssueClone } from "./agent-sandbox.js";
import { chunkForgeWrites, LAND_LABEL } from "./chunk-land.js";
import { faultDetail, isExitCode } from "./errors.js";
import { ensurePullRequest, type PullRequestRef } from "./forge-pr.js";
import { gitStdout, isAncestor, readFileAtRef, revParse, revParseOrNull } from "./git-ops.js";
import {
  type InnerLoopOptions,
  InnerLoopAbortedError,
  runInnerLoop,
} from "./inner-loop.js";
import {
  type JanitorHold,
  type JanitorLedger,
  ledgerWithHold,
  ledgerWithStart,
  ledgerWithVisit,
  readJanitorLedger,
  writeJanitorLedger,
} from "./janitor-ledger.js";
import {
  JANITOR_CONFLICT_PR_COMMENT,
  type JanitorOutcome,
  type LatestPullRequest,
  type ScopeCandidate,
  decideRollingBase,
  janitorHoldKey,
  janitorOutcome,
  janitorPrContent,
  describePrompt,
  type JanitorEnding,
  providerFailure,
  janitorSourceText,
  pickJanitorTask,
  pickScope,
  renderTaskAnchor,
  runsOnDay,
  scopeUnits,
  utcDay,
  visitCounts,
} from "./janitor-plan.js";
import type { IssueLogger } from "./logs.js";
import { janitorBranchName, janitorStackId } from "./naming.js";
import { OriginLeaseLostDuringCleanupError, type OriginWriteBarrier } from "./origin-lock.js";
import { type RepoLayout, worktreePathFor } from "./repo-cache.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";
import { janitorStandards, readQualityStandards } from "./standards-groups.js";
import { startTimer } from "./timing.js";

const exec = promisify(execFile);

// The forge reads and writes one run makes.
export type JanitorForge = {
  latestPullRequest(branch: string): Promise<LatestPullRequest | null>;
  commentOnPullRequest(pr: number, body: string): Promise<void>;
  ensureDraftPullRequest(args: {
    readonly head: string;
    readonly title: string;
    readonly body: string;
  }): Promise<PullRequestRef>;
};

export function realJanitorForge(deps: {
  readonly repo: RepoRef;
  readonly repoDir: string;
  readonly sourceBranch: string;
  readonly beforeOriginWrite: OriginWriteBarrier;
}): JanitorForge {
  const writes = chunkForgeWrites({
    repo: deps.repo,
    gitCwd: deps.repoDir,
    errPrefix: "janitor",
    beforeOriginWrite: deps.beforeOriginWrite,
  });
  return {
    async latestPullRequest(branch) {
      const { stdout } = await exec("gh", [
        "pr", "list", "--repo", repoSlug(deps.repo), "--head", branch,
        "--state", "all", "--json", "number,state,labels", "--limit", "5",
      ]);
      return latestOf(JSON.parse(stdout.trim() || "[]") as unknown);
    },
    commentOnPullRequest: writes.commentOnPullRequest,
    ensureDraftPullRequest: (args) => ensurePullRequest({
      cwd: deps.repoDir,
      repoFlag: repoSlug(deps.repo),
      base: deps.sourceBranch,
      draft: true,
      beforeOriginWrite: deps.beforeOriginWrite,
      ...args,
    }),
  };
}

// The highest-numbered pull request `gh pr list` answered with.
function latestOf(listed: unknown): LatestPullRequest | null {
  if (!Array.isArray(listed)) throw new Error(`gh pr list answered no list: ${JSON.stringify(listed)}`);
  let latest: LatestPullRequest | null = null;
  for (const raw of listed as readonly Record<string, unknown>[]) {
    const { number, state, labels } = raw;
    if (typeof number !== "number" || (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED")) {
      throw new Error(`gh pr list answered an unreadable pull request: ${JSON.stringify(raw)}`);
    }
    if (latest !== null && latest.number > number) continue;
    latest = {
      number,
      state,
      labels: Array.isArray(labels)
        ? labels.flatMap((label: { name?: unknown }) => typeof label.name === "string" ? [label.name] : [])
        : [],
    };
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Git in the bare cache
// ---------------------------------------------------------------------------

export type RollingRefresh =
  | { readonly kind: "clean"; readonly sha: string }
  | { readonly kind: "conflict" };

// The rolling branch brought level with the source: as it is when it already
// contains the source tip, else a driver merge commit of the two.
export async function refreshRollingBranch(args: {
  readonly repoDir: string;
  readonly branch: string;
  readonly branchTip: string;
  readonly sourceBranch: string;
  readonly sourceTip: string;
  readonly botName: string;
  readonly botEmail: string;
}): Promise<RollingRefresh> {
  const { repoDir, branchTip, sourceTip } = args;
  if (await isAncestor(repoDir, sourceTip, branchTip)) return { kind: "clean", sha: branchTip };
  let tree: string;
  try {
    tree = (await gitStdout(repoDir, ["merge-tree", "--write-tree", branchTip, sourceTip])).split("\n")[0]!;
  } catch (err) {
    if (isExitCode(err, 1)) return { kind: "conflict" };
    throw err;
  }
  const { stdout } = await exec("git", [
    "commit-tree", tree, "-p", branchTip, "-p", sourceTip,
    "-m", `Merge ${args.sourceBranch} into ${args.branch}`,
  ], {
    cwd: repoDir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: args.botName,
      GIT_AUTHOR_EMAIL: args.botEmail,
      GIT_COMMITTER_NAME: args.botName,
      GIT_COMMITTER_EMAIL: args.botEmail,
    },
  });
  return { kind: "clean", sha: stdout.trim() };
}

// Every blob at `tip` the pathspecs match, with its size. `ls-tree` takes no
// pathspec magic, so `diff-tree` against the empty tree does the matching.
export async function listScopeCandidates(
  repoDir: string,
  tip: string,
  paths: readonly string[],
): Promise<readonly ScopeCandidate[]> {
  const emptyTree = (await gitStdout(repoDir, ["hash-object", "-t", "tree", "--stdin"], "")).trim();
  const matched = new Set(
    (await gitStdout(repoDir, ["diff-tree", "-r", "--name-only", "--no-renames", "-z", emptyTree, tip, "--", ...paths]))
      .split("\0").filter((path) => path !== ""),
  );
  const candidates: ScopeCandidate[] = [];
  for (const entry of (await gitStdout(repoDir, ["ls-tree", "-r", "-l", "-z", tip])).split("\0")) {
    const m = entry.match(/^(\d+) blob [0-9a-f]+ +(\d+)\t(.*)$/s);
    if (m === null || m[1] === "120000" || !matched.has(m[3]!)) continue;
    candidates.push({ path: m[3]!, bytes: Number(m[2]) });
  }
  return candidates;
}

// Push the cache's branch to origin unless origin's copy has moved off
// `lease` (empty: unless origin has one). False when the lease no longer
// holds; any other push failure throws.
export async function pushRollingBranch(
  repoDir: string,
  branch: string,
  lease: string,
): Promise<boolean> {
  const ref = `refs/heads/${branch}`;
  try {
    await exec("git", ["push", "--quiet", `--force-with-lease=${ref}:${lease}`, "origin", `${ref}:${ref}`], {
      cwd: repoDir,
      env: { ...process.env, LC_ALL: "C" },
    });
    return true;
  } catch (err) {
    // `--force-with-lease` names its refusal in the push's own stderr.
    if (String((err as { stderr?: unknown }).stderr ?? "").includes("(stale info)")) return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The task due next
// ---------------------------------------------------------------------------

// `pickJanitorTask` over the tasks' ledgers and the rolling branch and source
// tips the recompute just fetched.
export async function dueJanitorTask(args: {
  readonly tasks: readonly JanitorTask[];
  readonly layout: RepoLayout;
  readonly sourceBranch: string;
  readonly landLabelled: ReadonlySet<string>;
  readonly now: Date;
  readonly onNotice: (message: string) => Promise<void>;
}): Promise<JanitorTask | null> {
  const { repoDir, stateDir } = args.layout;
  const sourceTip = await revParse(repoDir, `refs/remotes/origin/${args.sourceBranch}`);
  const read = await Promise.all(args.tasks.map(async (task) => ({
    task: task.name,
    ledger: await readJanitorLedger(stateDir, task.name, args.onNotice),
    holdKey: janitorHoldKey(
      await revParseOrNull(repoDir, `refs/remotes/origin/${janitorBranchName(task.name)}`),
      sourceTip,
    ),
  })));
  return pickJanitorTask({
    tasks: args.tasks,
    ledgers: new Map(read.map(({ task, ledger }) => [task, ledger])),
    today: utcDay(args.now),
    landLabelled: args.landLabelled,
    holdKeys: new Map(read.map(({ task, holdKey }) => [task, holdKey])),
  });
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

export type JanitorRunDeps = {
  readonly task: JanitorTask;
  readonly layout: RepoLayout;
  readonly sourceBranch: string;
  readonly botName: string;
  readonly botEmail: string;
  // A file task's scope budget is a quarter of this.
  readonly maxContextChars: number;
  // `promptExtensions.reviewerQuality`, where a `standards` task's groups live.
  readonly standards: PromptExtension | undefined;
  readonly forge: JanitorForge;
  readonly beforeOriginWrite: OriginWriteBarrier;
  // The loop's options but the subject, its log and its abort, which the run owns.
  readonly loop: Omit<InnerLoopOptions, "janitor" | "signal" | "attemptLogger" | "sandboxLogBaseDir" | "onEvent">;
  readonly attemptLogger: IssueLogger;
  readonly onEvent: (event: EventInput) => Promise<void>;
  readonly signal: AbortSignal;
  readonly now: () => Date;
  readonly runLoop?: typeof runInnerLoop;
};

// A run as the daemon holds it: one that throws is recorded as a complaint and
// a `failed` run, and that record is its outcome. Nothing awaits a run but
// cleanup, so a rethrow would reach the unhandled-rejection trap and stop the
// daemon with every issue in flight. A lease lost to cleanup is cleanup's to
// record. `onEnd` runs either way.
export async function settleJanitorRun(args: {
  readonly task: string;
  readonly run: () => Promise<unknown>;
  readonly emit: (event: EventInput) => Promise<void>;
  readonly durationMs: () => number;
  readonly onEnd: () => void;
}): Promise<void> {
  try {
    await args.run();
  } catch (err) {
    if (err instanceof OriginLeaseLostDuringCleanupError) return;
    await args.emit({
      kind: "complaint",
      severity: "error",
      message: `Janitor task '${args.task}' failed: ${faultDetail(err)}`,
    });
    await args.emit({
      kind: "janitor-run",
      task: args.task,
      branch: janitorBranchName(args.task),
      outcome: "failed",
      scope: [],
      durationMs: args.durationMs(),
    });
  } finally {
    args.onEnd();
  }
}

// A committed run adds what it carried and, once published, its pull request.
type RunEnding =
  | { readonly outcome: "committed"; readonly commits: number; readonly pullRequest?: number }
  | Exclude<JanitorEnding, { readonly outcome: "committed" }>;

export async function runJanitor(deps: JanitorRunDeps): Promise<JanitorOutcome | "held"> {
  const timer = startTimer();
  const { task, layout, sourceBranch } = deps;
  const { repoDir, stateDir } = layout;
  const branch = janitorBranchName(task.name);
  const notice = (message: string): Promise<void> => deps.onEvent({ kind: "notice", message });
  const report = async (ending: RunEnding, scope: readonly string[]): Promise<JanitorOutcome> => {
    await deps.onEvent({ kind: "janitor-run", task: task.name, branch, ...ending, scope, durationMs: timer() });
    return ending.outcome;
  };
  const startedAt = deps.now();
  let ledger: JanitorLedger = ledgerWithHold(
    ledgerWithStart(await readJanitorLedger(stateDir, task.name, notice), startedAt),
    null,
  );
  await writeJanitorLedger(stateDir, task.name, ledger);

  const latestPr = await deps.forge.latestPullRequest(branch);
  const sourceTip = await revParse(repoDir, `refs/remotes/origin/${sourceBranch}`);
  const originTip = await revParseOrNull(repoDir, `refs/remotes/origin/${branch}`);
  const hold = async (kind: JanitorHold["kind"], why: string): Promise<"held"> => {
    ledger = ledgerWithHold(ledger, { kind, key: janitorHoldKey(originTip, sourceTip) });
    await writeJanitorLedger(stateDir, task.name, ledger);
    await notice(`Janitor task '${task.name}' is held until ${branch} or ${sourceBranch} moves: ${why}`);
    return "held";
  };
  const rolling = decideRollingBase({
    originTip,
    latestPr,
    containedInSource: originTip !== null && await isAncestor(repoDir, originTip, sourceTip),
  });

  const sourceText = await readTaskSource(deps);
  if (sourceText === null) {
    return await hold("source-missing", task.prompt === "standards"
      ? "no project standards group is flagged {janitor}"
      : `${describePrompt(task.prompt).path} is missing at origin/${sourceBranch}`);
  }

  let base = sourceTip;
  if (rolling.kind === "continue") {
    const refreshed = await refreshRollingBranch({
      repoDir, branch, branchTip: rolling.lease, sourceBranch, sourceTip,
      botName: deps.botName, botEmail: deps.botEmail,
    });
    if (refreshed.kind === "conflict") {
      if (latestPr !== null) {
        await deps.forge.commentOnPullRequest(latestPr.number, JANITOR_CONFLICT_PR_COMMENT({ branch, sourceBranch }));
      }
      return await hold("conflict", `${branch} conflicts with ${sourceBranch}`);
    }
    base = refreshed.sha;
  }

  const candidates = await listScopeCandidates(repoDir, sourceTip, task.paths);
  const scope = pickScope({
    files: candidates,
    unit: task.unit,
    visits: ledger.visits,
    budgetChars: Math.floor(deps.maxContextChars / 4),
  });
  if (scope.length === 0) return await report({ outcome: "no-change", cause: "nothing in scope" }, scope);

  const clone = worktreePathFor(layout.worktreesDir, branch);
  const reclaim = await reclaimIssueClone(repoDir, clone, branch);
  if (reclaim.kind === "preserved") {
    await deps.onEvent({
      kind: "complaint",
      severity: "error",
      message: `Janitor clone preserved at ${clone}: ${reclaim.reason}`,
    });
    return await hold("clone-preserved", `its clone at ${clone} is preserved`);
  }
  await exec("git", ["update-ref", `refs/heads/${branch}`, base], { cwd: repoDir });
  await deps.onEvent({
    kind: "janitor-start",
    task: task.name,
    branch,
    base,
    fresh: rolling.kind === "fresh",
    scope,
    runsToday: runsOnDay(ledger, utcDay(startedAt)),
    runsPerDay: task.runsPerDay,
  });

  const ended = await runLoop(deps, branch, base, renderTaskAnchor({
    task: task.name,
    unit: task.unit,
    scope,
    source: janitorSourceText(task.prompt, sourceText, sourceBranch),
  }));
  const result = ended.outcome === "committed" ? await publish(deps, branch, rolling.lease, ended) : ended;

  if (visitCounts(result.outcome)) {
    ledger = ledgerWithVisit(ledger, scope, deps.now(), new Set(scopeUnits(candidates, task.unit).keys()));
    await writeJanitorLedger(stateDir, task.name, ledger);
  }
  return await report(result, scope);
}

// The prompt source's text at the source tip, or null when it has none.
async function readTaskSource(deps: JanitorRunDeps): Promise<string | null> {
  const { prompt } = deps.task;
  const { path } = describePrompt(prompt);
  if (path !== null) {
    return await readFileAtRef(deps.layout.repoDir, `refs/remotes/origin/${deps.sourceBranch}`, path);
  }
  const standards = await readQualityStandards({
    repoDir: deps.layout.repoDir,
    sourceBranch: deps.sourceBranch,
    extension: deps.standards,
    onEvent: deps.onEvent,
  });
  return janitorStandards(standards)?.text ?? null;
}

async function runLoop(
  deps: JanitorRunDeps,
  branch: string,
  base: string,
  anchor: string,
): Promise<RunEnding> {
  const loop = deps.runLoop ?? runInnerLoop;
  try {
    const terminal = await loop(
      { id: janitorStackId(deps.task.name), title: `Idle task: ${deps.task.name}`, branch },
      {
        ...deps.loop,
        attemptLogger: deps.attemptLogger,
        sandboxLogBaseDir: deps.attemptLogger.dir,
        onEvent: deps.onEvent,
        janitor: { task: deps.task.name, base: { ref: base, chunkBranch: null }, anchor },
        signal: deps.signal,
      },
    );
    const commits = Number((await gitStdout(deps.layout.repoDir, [
      "rev-list", "--count", `${base}..refs/heads/${branch}`,
    ])).trim());
    const ending = janitorOutcome(terminal, commits);
    return ending.outcome === "committed" ? { ...ending, commits } : ending;
  } catch (err) {
    if (err instanceof InnerLoopAbortedError) return { outcome: "pre-empted" };
    if (err instanceof AgentQuotaError) return providerFailure("QUOTA");
    if (err instanceof AgentCredentialError) return providerFailure("CREDENTIAL");
    throw err;
  }
}

// A committed run's one write to origin, and its draft pull request.
async function publish(
  deps: JanitorRunDeps,
  branch: string,
  lease: string,
  committed: Extract<RunEnding, { readonly outcome: "committed" }>,
): Promise<RunEnding> {
  if (deps.signal.aborted) return { outcome: "pre-empted" };
  const latest = await deps.forge.latestPullRequest(branch);
  if (latest?.state === "OPEN" && latest.labels.includes(LAND_LABEL)) {
    return { outcome: "pre-empted", cause: "land" };
  }
  await deps.beforeOriginWrite();
  if (!(await pushRollingBranch(deps.layout.repoDir, branch, lease))) {
    return { outcome: "failed", cause: "lease" };
  }
  const pr = await deps.forge.ensureDraftPullRequest({ head: branch, ...janitorPrContent(deps.task.name, deps.task.prompt) });
  return { ...committed, ...(pr.number > 0 ? { pullRequest: pr.number } : {}) };
}
