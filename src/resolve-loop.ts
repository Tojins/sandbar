// Agentic resolve loop — fires when `git merge --no-ff` of a DONE branch hits
// a conflict, produces a tree that fails the post-merge gate, or (in verified
// merge mode, #22) produces a merge result the FORGE's CI rejects.
//
// The agent emits `<promise>COMMITTED</promise>` (claims the merge is
// completed or a fix pushed; a still-conflicted tree or still-red gate rolls
// into the next attempt) or `<promise>ABANDON</promise>` with a `<reason>`
// block (the merger reverts the branch and comments on the issue). The agent
// never runs the gate itself; the orchestrator gates between attempts so the
// agent can't talk a red tree into accepting itself.
//
// In `forge-red` mode the loop's local gate is a cheap pre-filter between
// expensive CI rounds: `resolved` means "worth asking the forge again", not
// "verified". forge-verify.ts owns the re-push and the real verdict.
//
// ---------------------------------------------------------------------------
// What an attempt leaves behind (#67)
// ---------------------------------------------------------------------------
//
// Every attempt is RECORDED, in three places, because this loop was
// load-bearing and mute: four of them once produced five log lines between
// them, and the only artefact a human read afterwards named no file, no timing
// and no container.
//
//   * `ResolveAttemptSink` takes the invocation's stdout AND stderr, verbatim,
//     for the run log tree. The adapter never read stderr at all before, so a
//     container that failed to start took its own diagnosis with it.
//   * `log` gets one line per attempt carrying the container name, the exit
//     code, the duration and which of timeout / clean exit / signal ended it.
//   * `ResolveOutcome.abandon` carries the whole journal plus the conflicted
//     paths, so the comment the merger posts can say what actually happened
//     instead of "bailed after 4 attempts".
//
// The provider boundary keeps two forms of output apart: raw stdout is written
// byte-for-byte to the attempt log, while `output` is the provider parser's
// agent-speech register and is the ONLY input to `parseResolveSignal`. This is
// load-bearing for JSONL providers: transport and reasoning text can contain a
// promise token without the agent having made that promise.
//
// And the case that motivated all of it: AN ATTEMPT THAT PRODUCED NO AGENT
// SPEECH IS AN INFRASTRUCTURE FAILURE, NOT AN ANSWER. `parseResolveSignal` reads empty
// output as NO-SIGNAL, which the loop otherwise treats exactly like a COMMITTED
// that left the tree dirty — re-prompt, spend an attempt. So an image that is
// gone, a refused podman socket, an OOM kill or a bad mount was laundered into
// "the agent tried and failed", and burned three quarters of the budget doing
// it in eleven seconds. A terminal failure reported in-band by a provider is
// the same class only when no speech preceded it; once the agent spoke, the
// loop verifies that answer against the tree and gate as usual. `isInfraFailure`
// classes the silent cases and the loop THROWS: the
// merger wraps that into a halt as it does every other internal failure (#33),
// and the remaining attempts are not spent.
//
// The one exception is the TIMEOUT. An attempt SIGTERM'd at
// `RESOLVE_AGENT_TIMEOUT_MS` demonstrably ran for the whole budget — it just
// never got to print — so it is a spent attempt like any other. It is NAMED as
// one in the log line and in the comment, which is the entire difference
// between it and the sub-three-second no-ops it used to be indistinguishable
// from.

import { SandbarError } from "./errors.js";
import {
  type GateTimings,
  formatGateFields,
  summarizeGateFailure,
} from "./gate.js";
import type { MergerGateOutput } from "./merger.js";
import { durationField, startTimer } from "./timing.js";
import { loadTemplate, render } from "./prompts.js";
import { lastToken, literalTokenPattern, temperedBlockPattern } from "./token-scan.js";
import { formatUsageFields } from "./agent-usage.js";
import type { AgentUsage } from "./agent-usage.js";
import type { AgentRunCause, AgentRunEnd } from "./agent-run-end.js";

export const RESOLVE_MAX_ATTEMPTS = 4;

// 10 minutes per agent invocation: each iteration may need to read several
// related issues + the conflict / gate trace + edit files. The loop bounds
// total agentic time at RESOLVE_MAX_ATTEMPTS × this.
//
// Here rather than beside the adapter that enforces it (#67): the prose this
// module writes has to name the budget an attempt hit, and a comment telling a
// human "the ten-minute timeout" while the adapter counts to five is a comment
// lying about the one number it exists to report.
export const RESOLVE_AGENT_TIMEOUT_MS = 10 * 60_000;

const TRACE_LINES = 200;

// The gate trace the resolve agent is shown: the failing STEP's output, cascade-
// collapsed and tail-truncated, then the stack's container logs verbatim.
//
// Order and separation both matter. `summarizeGateFailure` collapses lines that
// share a timeout signature; a service log is full of near-identical lines, so
// folding the container logs in first would have it collapsing text that was
// never one test run. And the logs go AFTER, because the answer to "the browser
// step got a 500" is in the backend container the step never touched — it is
// context for a diagnosis, not the diagnosis.
function withStackLogs(gate: MergerGateOutput, stepOutput: string): string {
  return summarizeGateFailure(stepOutput, TRACE_LINES) + gate.containerLogs;
}

// Prose templates, loaded once at import (see prompts.ts). The pure prompt
// builders below substitute into these in-memory strings.
const RELATED_INTRO_TPL = loadTemplate("resolve-related-intro");
const CONFLICT_TPL = loadTemplate("resolve-conflict");
const GATE_RED_TPL = loadTemplate("resolve-gate-red");
const FORGE_RED_TPL = loadTemplate("resolve-forge-red");
const DONE_SIGNAL_TPL = loadTemplate("resolve-done-signal");
const COMMITTED_CONFLICT_TPL = loadTemplate("resolve-committed-conflict");
const COMMITTED_GATE_TPL = loadTemplate("resolve-committed-gate");

export type IssueRef = {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
};

export type ResolveMode =
  | { readonly kind: "conflict" }
  | { readonly kind: "gate-red"; readonly initialOutput: MergerGateOutput }
  // Verified merge mode (#22): the composed merge result passed the local gate
  // but the forge's CI rejected it. `initialTrace` is already summarised per
  // failing job by forge-verify.ts (raw CI logs are far too large to pass
  // through unfiltered).
  | {
      readonly kind: "forge-red";
      readonly initialTrace: string;
      readonly failedChecks: string;
    };

// How one resolve-provider `podman run` invocation ended. `timeout` is
// sandbar's own SIGTERM at RESOLVE_AGENT_TIMEOUT_MS and nothing else; `signal` is anything
// else that killed the process (an OOM kill, an operator's Ctrl-C reaching the
// group); `spawn-error` is a runtime that never produced a process at all.
export type ResolveAgentEnd = AgentRunEnd;

// What one invocation actually did. The token parser only ever needed
// `output`; every other field here exists so that an attempt which produced
// nothing can be told apart from an agent that chose to say nothing (#67).
export type ResolveAgentRun = {
  readonly stdout: string;
  readonly stderr: string;
  // Agent speech parsed by the selected provider. Raw stdout remains above for
  // the byte-verbatim attempt log; promise tokens are read only from here.
  readonly output: string;
  readonly end: ResolveAgentEnd;
  // The process's exit code, or null when it was killed before it had one.
  readonly exitCode: number | null;
  // The signal that killed it, or null. Both are carried because a SIGTERM'd
  // process reports one and not the other, and "which of the two ended it" is
  // exactly the question the old log line could not answer.
  readonly signal: string | null;
  readonly durationMs: number;
  // The container it ran in, so an infra failure names something an operator
  // can go and look at (`podman ps -a`, `podman logs`) rather than describing
  // an anonymous process that is already gone.
  readonly container: string;
  // A narrow runtime, provider, or stream-parse explanation. The raw streams
  // remain separate above and the classifier gives a spawn error precedence.
  readonly detail?: string;
  // The discriminated end classification shared with the sandbox wrapper.
  readonly cause: AgentRunCause;
  // Whether this caller should accept the run as an answer or halt as infra.
  readonly verdict: "answer" | "infra";
  readonly usage?: AgentUsage;
  readonly toolCalls: number;
};

// Which prompt the attempt was answering — the same three shapes the loop's
// own `AttemptTrace` has, named separately because this one is written to disk
// and read by a human.
export type ResolveAttemptMode = "still-conflicted" | "gate-red" | "forge-red";

// One attempt, handed to the sink for durable capture.
export type ResolveAttemptRecord = ResolveAgentRun & {
  readonly attempt: number;
  // The unit the loop is resolving for — an issue number, or a chunk's root.
  readonly issueId: string;
  readonly mode: ResolveAttemptMode;
};

// Writes one attempt's captured output somewhere durable and answers WHERE.
//
// It answers with the path rather than the caller composing one, because the
// abandon comment has to point a human at these files: a second spelling of
// the filename here is a comment that keeps pointing at `attempt-3.log` for a
// year after the sink started writing `attempt-03.log`. `null` ⇒ captured
// nowhere a human can be sent, which the prose then says outright rather than
// inventing a path.
export type ResolveAttemptSink = (
  record: ResolveAttemptRecord,
) => Promise<string | null>;

// What the loop concluded about the tree the attempt left behind. Recorded per
// attempt so the abandon comment can distinguish four genuine resolution
// failures from one timeout and three containers that never ran.
export type ResolveAttemptVerdict =
  | "still-conflicted"
  | "install-failed"
  | "gate-red"
  | "resolved"
  | "abandon"
  | "silent-noop";

// One attempt as the abandon comment reports it: how the invocation ended, and
// what the loop then made of it. Deliberately holds SIZES and not the output
// itself — the output is on disk, and a comment that inlined four agent
// transcripts would be unreadable and would hit GitHub's body limit.
export type ResolveAttemptSummary = {
  readonly attempt: number;
  readonly end: ResolveAgentEnd;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly container: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly verdict: ResolveAttemptVerdict;
  // Where this attempt's stdout/stderr were written, when a sink took them.
  readonly logPath: string | null;
};

export type ResolveAdapter = {
  // `attempt` is passed so the invocation can be NAMED after it — the
  // container name is the handle on a failure that produced nothing else, and
  // an anonymous one leaves an operator grepping `podman events` by timestamp.
  runResolveAgent(prompt: string, attempt: number): Promise<ResolveAgentRun>;
  isMergeInProgress(): Promise<boolean>;
  // `paths` is the unmerged set (`git diff --name-only --diff-filter=U`), kept
  // apart from the human-readable `status` because the abandon comment lists
  // the conflicted files and parsing them back out of porcelain prose is a
  // parser nobody would trust (#67).
  conflictDigest(): Promise<{
    readonly status: string;
    readonly diff: string;
    readonly paths: readonly string[];
  }>;
  npmInstall(): Promise<{ readonly ok: boolean }>;
  // The timings ride out on both branches (#82): a green re-gate is the one
  // this loop pays for on every recovered attempt, and it has no failure to
  // describe. Reported, never acted on — the loop's bound is
  // `RESOLVE_MAX_ATTEMPTS` and nothing here reads a duration back.
  runGate(): Promise<
    ({ readonly ok: true } | ({ readonly ok: false } & MergerGateOutput)) &
      GateTimings
  >;
  getIssueBody(issueId: string): Promise<string>;
  getHeadSha(): Promise<string>;
};

export type ResolveOutcome =
  | { readonly kind: "resolved" }
  | {
      readonly kind: "abandon";
      readonly reason: string;
      // True iff the working tree is still mid-merge when we bail. Caller uses
      // this to choose between `git merge --abort` and `git reset --hard <sha>`.
      readonly mergeInProgress: boolean;
      // True iff the loop's own HEAD-advance invariant tripped — the agent
      // claimed success and left no merge in progress, but HEAD is still at
      // preMergeSha. This is the "silent --abort" case: the agent walked away
      // without producing a merge commit. Caller treats this differently from
      // a real ABANDON: in-run retry is plausible, since the next cycle's
      // implementer will re-attempt against current source with a different
      // conflict surface.
      readonly silent?: boolean;
      // Every attempt this loop spent, in order (#67). The merger's abandon
      // comment is the only artefact a human reads when they find a stuck
      // issue in the morning, and "bailed after 4 attempts" described one
      // ten-minute timeout plus three containers that died at startup.
      readonly attempts: readonly ResolveAttemptSummary[];
      // The unmerged paths as of the last conflict digest taken, or empty when
      // the loop never saw a conflict (a gate-red or forge-red run).
      readonly conflictPaths: readonly string[];
    };

export type ResolveLogger = (line: string) => void | Promise<void>;

export type ResolveLoopDeps = {
  // Pre-built project anchor — fetched once by the caller and reused across
  // all attempts (large, static).
  readonly projectAnchor: string;
  // Sha of HEAD captured before `git merge --no-ff` started. The loop refuses
  // to report "resolved" if HEAD still equals this after an attempt's gate
  // passes — that means no commit was produced (silent abort). Optional for
  // backwards compatibility with callers that don't track preMergeSha; when
  // absent the invariant is skipped.
  readonly preMergeSha?: string;
  // What the branch is being merged INTO, as a noun phrase the prompt drops
  // into a sentence ("a merge of this branch into <target> …"). Optional, and
  // the default is the only target that existed before chunks (#60): a caller
  // that has not thought about it — forge-verify's forge-red loop, which is
  // about the source branch by construction — gets the right answer without
  // saying so.
  readonly target?: string;
  // Where each attempt's stdout and stderr go (#67). Optional: forge-verify's
  // own callers and every test that only cares about the loop's decisions pass
  // nothing, and the loop then reports `logPath: null` rather than pretending
  // a file exists.
  readonly onAttempt?: ResolveAttemptSink;
};

export const SOURCE_TARGET_PHRASE = "the source branch";

type AttemptTrace =
  | { readonly kind: "still-conflicted"; readonly digest: string }
  | { readonly kind: "gate-red"; readonly trace: string }
  | {
      readonly kind: "forge-red";
      readonly trace: string;
      readonly failedChecks: string;
    };

export async function runResolveLoop(
  issue: IssueRef,
  relatedIssues: readonly IssueRef[],
  initialMode: ResolveMode,
  adapter: ResolveAdapter,
  deps: ResolveLoopDeps,
  log: ResolveLogger = () => undefined,
): Promise<ResolveOutcome> {
  const primaryIssueAnchor = await adapter.getIssueBody(issue.id);
  // getIssueBody renders title + body + COMMENTS (issue-anchor.ts), and since
  // #30 Phase 4a runs before the merge — so a sibling that terminated
  // NEEDS-INFO / NEEDS-HUMAN / NEEDS-UI-PROTOTYPE this cycle already carries
  // sandbar's handoff comment by the time this reads it, which it did not when
  // finalise ran after the merge. That is the right side of the trade (knowing
  // a sibling did not land is context, not noise), and the comments are all
  // BOT_COMMENT_PREFIX-stamped so their provenance is legible — but they are
  // written TO A HUMAN and contain imperatives ("push a fix on this branch",
  // "reply 'no prototype needed'"). If a resolve agent is ever seen acting on
  // one, this is the line that let it see it.
  const relatedIssueAnchors: { issue: IssueRef; body: string }[] = [];
  for (const r of relatedIssues) {
    if (r.id === issue.id) continue;
    relatedIssueAnchors.push({
      issue: r,
      body: await adapter.getIssueBody(r.id),
    });
  }

  // The journal the abandon comment is written from, and the paths it names.
  // Both accumulate as the loop runs; both are reported on every abandon,
  // including the exhausted one that used to say nothing but a count.
  const attempts: ResolveAttemptSummary[] = [];
  let conflictPaths: readonly string[] = [];

  let trace: AttemptTrace;
  if (initialMode.kind === "conflict") {
    const d = await adapter.conflictDigest();
    conflictPaths = d.paths;
    trace = { kind: "still-conflicted", digest: formatConflictDigest(d) };
  } else if (initialMode.kind === "forge-red") {
    trace = {
      kind: "forge-red",
      trace: initialMode.initialTrace,
      failedChecks: initialMode.failedChecks,
    };
  } else {
    trace = {
      kind: "gate-red",
      trace: withStackLogs(
        initialMode.initialOutput,
        `${initialMode.initialOutput.stdout}\n${initialMode.initialOutput.stderr}`,
      ),
    };
  }

  for (let attempt = 1; attempt <= RESOLVE_MAX_ATTEMPTS; attempt++) {
    const prompt = buildResolvePromptBody({
      projectAnchor: deps.projectAnchor,
      // Passed through undefined and defaulted once, in the builder: two
      // `?? SOURCE_TARGET_PHRASE` on one value is two places to change it.
      target: deps.target,
      primaryIssue: issue,
      primaryIssueAnchor,
      relatedIssueAnchors,
      attempt,
      maxAttempts: RESOLVE_MAX_ATTEMPTS,
      mode: trace,
    });

    await log(
      `resolve-attempt ${attempt}/${RESOLVE_MAX_ATTEMPTS} mode=${trace.kind}`,
    );
    const run = await adapter.runResolveAgent(prompt, attempt);
    // Captured BEFORE anything is decided about the run, so the file exists
    // even on the path that throws — an infra failure whose output went
    // nowhere is the exact hole this issue was filed about.
    const logPath = deps.onAttempt
      ? await deps.onAttempt({
          ...run,
          attempt,
          issueId: issue.id,
          mode: trace.kind,
        })
      : null;
    await log(
      `resolve-attempt ${attempt} ${describeRunEnd(run)} container=${run.container}` +
        formatUsageFields(run.usage, run.toolCalls) +
        (logPath ? ` log=${logPath}` : ""),
    );

    // One journal entry per attempt, filed once the loop knows what it made of
    // the tree. A closure over this attempt's run so that every `continue` and
    // every `return` below files exactly one, and none of them has to restate
    // the eight fields that came out of the invocation.
    const record = (verdict: ResolveAttemptVerdict): void => {
      attempts.push({
        attempt,
        end: run.end,
        exitCode: run.exitCode,
        signal: run.signal,
        durationMs: run.durationMs,
        container: run.container,
        stdoutBytes: run.stdout.length,
        stderrBytes: run.stderr.length,
        verdict,
        logPath,
      });
    };

    // Nothing ran. Not an answer, and not this loop's to absorb — see the
    // header. Thrown rather than returned as an abandon, because an abandon is
    // a statement about the CODE ("this conflict cannot be resolved") that
    // parks the issue under `agent-stuck` and takes it off the queue; what
    // happened here is a statement about the host.
    if (isInfraFailure(run)) {
      // Deliberately NOT recorded in the journal. A journal entry states what
      // the loop concluded about the tree the attempt left, and this attempt
      // left the tree untouched — there is no honest verdict to file. Nothing
      // reads the journal on this path anyway: the throw is the report, and
      // the file the sink just wrote is the evidence behind it.
      throw new SandbarError(
        buildInfraFailureMessage(issue, attempt, run, logPath),
      );
    }

    const signal = parseResolveSignal(run.output);

    if (signal.kind === "ABANDON") {
      const inProgress = await adapter.isMergeInProgress();
      await log(
        `resolve-abandon attempt=${attempt} reason=${JSON.stringify(signal.reason)} mergeInProgress=${inProgress}`,
      );
      record("abandon");
      return {
        kind: "abandon",
        reason: signal.reason,
        mergeInProgress: inProgress,
        attempts,
        conflictPaths,
      };
    }

    const stillConflicted = await adapter.isMergeInProgress();
    if (stillConflicted) {
      await log(`resolve-attempt ${attempt} still conflicted; re-prompting`);
      record("still-conflicted");
      const d = await adapter.conflictDigest();
      conflictPaths = d.paths;
      trace = { kind: "still-conflicted", digest: formatConflictDigest(d) };
      continue;
    }

    const installTimer = startTimer();
    const install = await adapter.npmInstall();
    await log(
      `resolve-attempt ${attempt} install ok=${install.ok} ` +
        durationField(installTimer()),
    );
    if (!install.ok) {
      await log(`resolve-attempt ${attempt} npm install failed`);
      record("install-failed");
      trace = {
        kind: "gate-red",
        trace:
          "`npm install` against the merged tree failed. Inspect package.json / package-lock.json — typical cause is a conflict marker left in the lockfile or a missing dependency entry.",
      };
      continue;
    }

    const gate = await adapter.runGate();
    // The same one rendering the other three consumers use, on green and red
    // alike; the verdict-specific lines below keep their own wording.
    await log(`resolve-attempt ${attempt} gate ${formatGateFields(gate)}`);
    if (gate.ok) {
      // HEAD-advance invariant: a gate-green tree at the same sha as the
      // pre-merge HEAD means the agent walked away without producing a merge
      // commit. The gate is green only because the source never moved. Treat
      // as a silent abandon — the agent's reasoning context is spent, and
      // looping won't recover (`git merge --abort` cleared MERGE_HEAD, so
      // attempt N+1 has no conflict to work on).
      if (deps.preMergeSha !== undefined) {
        const head = await adapter.getHeadSha();
        if (head === deps.preMergeSha) {
          await log(
            `resolve-attempt ${attempt} gate green but HEAD did not advance — silent abandon`,
          );
          record("silent-noop");
          return {
            kind: "abandon",
            reason:
              "Silent no-op: agent reported COMMITTED and left no merge in progress, but HEAD did not advance from preMergeSha. Likely `git merge --abort` followed by exit without producing a merge commit.",
            mergeInProgress: false,
            silent: true,
            attempts,
            conflictPaths,
          };
        }
      }
      await log(`resolve-attempt ${attempt} gate green — resolved`);
      record("resolved");
      return { kind: "resolved" };
    }
    await log(
      `resolve-attempt ${attempt} gate red failedStep=${gate.failedStep ?? "-"}`,
    );
    record("gate-red");
    trace = {
      kind: "gate-red",
      trace: withStackLogs(gate, `${gate.stdout}\n${gate.stderr}`),
    };
  }

  await log(`resolve-exhausted after ${RESOLVE_MAX_ATTEMPTS} attempts`);
  const inProgress = await adapter.isMergeInProgress();
  return {
    kind: "abandon",
    reason: `Exhausted ${RESOLVE_MAX_ATTEMPTS} resolve attempts.`,
    mergeInProgress: inProgress,
    attempts,
    conflictPaths,
  };
}

// ---------------------------------------------------------------------------
// What an attempt did — reporting (#67). Pure; the loop, the merger's abandon
// comment and chunk-land's pull-request comment all read from here, so there
// is one vocabulary for "the ten-minute timeout" rather than three.
// ---------------------------------------------------------------------------

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

const bytes = (n: number): string =>
  n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}kB`;

// The log line's half: dense, greppable, one attempt per line.
function describeRunEnd(run: ResolveAgentRun): string {
  return (
    `ended=${run.end} after=${seconds(run.durationMs)} ` +
    `exit=${run.exitCode ?? "-"} signal=${run.signal ?? "-"} ` +
    `stdout=${bytes(run.stdout.length)} stderr=${bytes(run.stderr.length)}`
  );
}

// The prose half, for a comment a human reads once and acts on.
function describeEndForHumans(run: {
  readonly end: ResolveAgentEnd;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
}): string {
  switch (run.end) {
    case "timeout":
      return (
        `ran for ${seconds(run.durationMs)} and was killed by sandbar's ` +
        `${RESOLVE_AGENT_TIMEOUT_MS / 60_000}-minute per-attempt timeout`
      );
    case "signal":
      return `was killed by ${run.signal ?? "a signal"} after ${seconds(run.durationMs)}`;
    case "spawn-error":
      return `never started (after ${seconds(run.durationMs)})`;
    default:
      return `exited with code ${run.exitCode ?? "?"} after ${seconds(run.durationMs)}`;
  }
}

const VERDICT_PROSE: Record<ResolveAttemptVerdict, string> = {
  "still-conflicted": "the tree was still conflicted",
  "install-failed": "`npm install` against the merged tree failed",
  "gate-red": "the post-merge gate was still red",
  resolved: "the gate went green",
  abandon: "the agent asked to abandon",
  "silent-noop": "the agent left no merge and no commit",
};

// The cause rules and the merger's explicit silent-run policy are owned by
// agent-run-end.ts; this adapter consumes only its judgement (#114).
export function isInfraFailure(run: ResolveAgentRun): boolean {
  return run.verdict === "infra";
}

// How much of stderr rides along in the halt message. The whole of it is on
// disk; what belongs in a message an operator reads in a terminal is the tail,
// which is where a container's own complaint ("image not known", "cannot
// connect to podman socket") lands.
const INFRA_STDERR_TAIL = 600;

export function buildInfraFailureMessage(
  issue: IssueRef,
  attempt: number,
  run: ResolveAgentRun,
  logPath: string | null,
): string {
  const remaining = RESOLVE_MAX_ATTEMPTS - attempt;
  const tail = run.stderr.trim().slice(-INFRA_STDERR_TAIL);
  return (
    `merger: the resolve agent for #${issue.id} produced no output on attempt ` +
    `${attempt}/${RESOLVE_MAX_ATTEMPTS}. Container \`${run.container}\` ` +
    `${describeEndForHumans(run)}` +
    (run.detail ? ` (${run.detail})` : "") +
    ". A silent provider or container failure is infrastructure, not an agent " +
    "declining to answer, so the merge phase halts here " +
    `rather than spending the remaining ${remaining} resolve attempt` +
    `${remaining === 1 ? "" : "s"} on it. ` +
    (logPath
      ? `Its stdout and stderr are at ${logPath}.`
      : "Its stdout and stderr were not captured to a file (no attempt sink " +
        "was wired into this run).") +
    (tail ? `\n\nstderr (tail):\n${tail}` : "")
  );
}

// The attempt-by-attempt block every abandon comment carries. Markdown, since
// both consumers post it to a forge.
export function formatResolveAttempts(
  attempts: readonly ResolveAttemptSummary[],
): string {
  if (attempts.length === 0) {
    return "No resolve attempt was recorded.";
  }
  return attempts
    .map((a) => {
      const where = a.logPath ? ` Output: \`${a.logPath}\`.` : "";
      return (
        `- **Attempt ${a.attempt}** — the agent ${describeEndForHumans(a)}, ` +
        `writing ${bytes(a.stdoutBytes)} of stdout and ${bytes(a.stderrBytes)} ` +
        `of stderr; ${VERDICT_PROSE[a.verdict]}.` +
        ` Container \`${a.container}\`.${where}`
      );
    })
    .join("\n");
}

// The conflicted-file block. Empty for a gate-red or forge-red abandon, where
// there were never any — saying "conflicted paths: none" there would read as a
// clean merge rather than as a question that was never asked.
export function formatConflictPaths(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  return (
    `**Conflicted path${paths.length === 1 ? "" : "s"} (${paths.length}):**\n` +
    paths.map((f) => `- \`${f}\``).join("\n")
  );
}

function formatConflictDigest(d: {
  readonly status: string;
  readonly diff: string;
}): string {
  return [
    "## git status",
    "",
    "```",
    d.status,
    "```",
    "",
    "## conflict markers (full diff)",
    "",
    "```diff",
    d.diff,
    "```",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Prompt body — pure.
// ---------------------------------------------------------------------------

export type ResolvePromptInputs = {
  readonly projectAnchor: string;
  readonly primaryIssue: IssueRef;
  readonly primaryIssueAnchor: string;
  readonly relatedIssueAnchors: readonly {
    readonly issue: IssueRef;
    readonly body: string;
  }[];
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly mode: AttemptTrace;
  // The branch the merge lands on, named in prose (#60). Optional for the same
  // reason it is optional on the deps: every caller that predates chunks means
  // the source branch.
  readonly target?: string;
};

export function buildResolvePromptBody(inputs: ResolvePromptInputs): string {
  const parts: string[] = [inputs.projectAnchor];

  parts.push(
    [
      `# Primary issue (this branch)`,
      ``,
      `Issue #${inputs.primaryIssue.id}: ${inputs.primaryIssue.title}`,
      `Branch: ${inputs.primaryIssue.branch}`,
      ``,
      inputs.primaryIssueAnchor,
    ].join("\n"),
  );

  if (inputs.relatedIssueAnchors.length > 0) {
    const blocks = inputs.relatedIssueAnchors
      .map(({ issue, body }) =>
        [
          `## Related issue #${issue.id}: ${issue.title}`,
          ``,
          `Branch: ${issue.branch}`,
          ``,
          body,
        ].join("\n"),
      )
      .join("\n\n");
    parts.push(render(RELATED_INTRO_TPL, { blocks }));
  }

  parts.push(
    `# Task\n\n${renderModeBlock(inputs.mode, inputs.target ?? SOURCE_TARGET_PHRASE)}`,
  );

  parts.push(buildDoneSignal(inputs.attempt, inputs.maxAttempts, inputs.mode));

  return parts.join("\n\n---\n\n");
}

function renderModeBlock(mode: AttemptTrace, target: string): string {
  if (mode.kind === "still-conflicted") {
    return render(CONFLICT_TPL, { digest: mode.digest, target });
  }
  if (mode.kind === "forge-red") {
    return render(FORGE_RED_TPL, {
      trace: mode.trace,
      failedChecks: mode.failedChecks,
    });
  }
  return render(GATE_RED_TPL, { trace: mode.trace, target });
}

function buildDoneSignal(
  attempt: number,
  maxAttempts: number,
  mode: AttemptTrace,
): string {
  const committedSignal =
    mode.kind === "still-conflicted"
      ? COMMITTED_CONFLICT_TPL
      : COMMITTED_GATE_TPL;
  return render(DONE_SIGNAL_TPL, {
    attempt: String(attempt),
    maxAttempts: String(maxAttempts),
    committedSignal,
  });
}

// ---------------------------------------------------------------------------
// Signal parsing — pure.
// ---------------------------------------------------------------------------

export type ResolveSignal =
  | { readonly kind: "COMMITTED" }
  | { readonly kind: "ABANDON"; readonly reason: string }
  | { readonly kind: "NO-SIGNAL" };

// Literal tokens only, last wins; a `<promise>` quoted in the agent's prose is
// not a signal and cannot swallow the real one (#113, token-scan.ts). The
// `<reason>` block is free text, so it takes the tempered form instead.
const RESOLVE_TOKEN_ALL = literalTokenPattern("promise", ["COMMITTED", "ABANDON"]);

export function parseResolveSignal(stdout: string): ResolveSignal {
  const token = lastToken(stdout, RESOLVE_TOKEN_ALL);
  if (token === null) return { kind: "NO-SIGNAL" };
  if (token === "COMMITTED") return { kind: "COMMITTED" };
  const reason = lastToken(stdout, temperedBlockPattern("reason"));
  return { kind: "ABANDON", reason: reason || "(no reason given)" };
}
