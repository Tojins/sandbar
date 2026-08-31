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

import { summarizeGateFailure } from "./gate.js";
import type { MergerGateOutput } from "./merger.js";
import { loadTemplate, render } from "./prompts.js";

export const RESOLVE_MAX_ATTEMPTS = 4;
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

export type ResolveAdapter = {
  runResolveAgent(prompt: string): Promise<{ readonly stdout: string }>;
  isMergeInProgress(): Promise<boolean>;
  conflictDigest(): Promise<{ readonly status: string; readonly diff: string }>;
  npmInstall(): Promise<{ readonly ok: boolean }>;
  runGate(): Promise<
    { readonly ok: true } | ({ readonly ok: false } & MergerGateOutput)
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

  let trace: AttemptTrace;
  if (initialMode.kind === "conflict") {
    const d = await adapter.conflictDigest();
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

    await log(`resolve-attempt ${attempt}/${RESOLVE_MAX_ATTEMPTS} mode=${trace.kind}`);
    const result = await adapter.runResolveAgent(prompt);
    const signal = parseResolveSignal(result.stdout);

    if (signal.kind === "ABANDON") {
      const inProgress = await adapter.isMergeInProgress();
      await log(
        `resolve-abandon attempt=${attempt} reason=${JSON.stringify(signal.reason)} mergeInProgress=${inProgress}`,
      );
      return { kind: "abandon", reason: signal.reason, mergeInProgress: inProgress };
    }

    const stillConflicted = await adapter.isMergeInProgress();
    if (stillConflicted) {
      await log(`resolve-attempt ${attempt} still conflicted; re-prompting`);
      const d = await adapter.conflictDigest();
      trace = { kind: "still-conflicted", digest: formatConflictDigest(d) };
      continue;
    }

    const install = await adapter.npmInstall();
    if (!install.ok) {
      await log(`resolve-attempt ${attempt} npm install failed`);
      trace = {
        kind: "gate-red",
        trace:
          "`npm install` against the merged tree failed. Inspect package.json / package-lock.json — typical cause is a conflict marker left in the lockfile or a missing dependency entry.",
      };
      continue;
    }

    const gate = await adapter.runGate();
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
          return {
            kind: "abandon",
            reason:
              "Silent no-op: agent reported COMMITTED and left no merge in progress, but HEAD did not advance from preMergeSha. Likely `git merge --abort` followed by exit without producing a merge commit.",
            mergeInProgress: false,
            silent: true,
          };
        }
      }
      await log(`resolve-attempt ${attempt} gate green — resolved`);
      return { kind: "resolved" };
    }
    await log(
      `resolve-attempt ${attempt} gate red failedStep=${gate.failedStep ?? "-"}`,
    );
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
  };
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
    mode.kind === "still-conflicted" ? COMMITTED_CONFLICT_TPL : COMMITTED_GATE_TPL;
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

export function parseResolveSignal(stdout: string): ResolveSignal {
  const matches = [...stdout.matchAll(/<promise>([\s\S]*?)<\/promise>/g)];
  if (matches.length === 0) return { kind: "NO-SIGNAL" };
  const token = (matches[matches.length - 1]![1] ?? "").trim();
  if (token === "COMMITTED") return { kind: "COMMITTED" };
  if (token === "ABANDON") {
    const m = stdout.match(/<reason>([\s\S]*?)<\/reason>/);
    const reason = m && m[1] ? m[1].trim() : "(no reason given)";
    return { kind: "ABANDON", reason };
  }
  return { kind: "NO-SIGNAL" };
}
