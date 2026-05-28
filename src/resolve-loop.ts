// Agentic resolve loop — fires when `git merge --no-ff` of a DONE branch into
// the source branch hits a conflict OR produces a tree that fails the
// post-merge gate.
//
// Each attempt is a fresh prompt: project anchor + primary issue body + bodies
// of all other issues in the same cycle + the current conflict markers or gate
// trace + a small done-signal block. The agent emits one of:
//   <promise>COMMITTED</promise> — claims it has either completed the merge
//                                  (conflict mode) or pushed a fix on top of
//                                  HEAD (gate-red mode). The orchestrator
//                                  inspects state and gates. A still-conflicted
//                                  tree or a still-red gate rolls into the
//                                  next attempt with the new trace.
//   <promise>ABANDON</promise>     — this can't be resolved automatically.
//                                  Paired with a <reason> block. Surfaces to
//                                  the merger so the branch is reverted and
//                                  the issue gets a human-readable comment.
//
// The agent never runs the gate itself; the orchestrator gates between
// attempts so the agent can't talk a red tree into accepting itself.

import { lastNLines } from "./gate.js";
import type { MergerGateOutput } from "./merger.js";

export const RESOLVE_MAX_ATTEMPTS = 4;
const TRACE_LINES = 200;

export type IssueRef = {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
};

export type ResolveMode =
  | { readonly kind: "conflict" }
  | { readonly kind: "gate-red"; readonly initialOutput: MergerGateOutput };

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
};

type AttemptTrace =
  | { readonly kind: "still-conflicted"; readonly digest: string }
  | { readonly kind: "gate-red"; readonly trace: string };

export async function runResolveLoop(
  issue: IssueRef,
  relatedIssues: readonly IssueRef[],
  initialMode: ResolveMode,
  adapter: ResolveAdapter,
  deps: ResolveLoopDeps,
  log: ResolveLogger = () => undefined,
): Promise<ResolveOutcome> {
  const primaryIssueAnchor = await adapter.getIssueBody(issue.id);
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
  } else {
    trace = {
      kind: "gate-red",
      trace: lastNLines(
        `${initialMode.initialOutput.stdout}\n${initialMode.initialOutput.stderr}`,
        TRACE_LINES,
      ),
    };
  }

  for (let attempt = 1; attempt <= RESOLVE_MAX_ATTEMPTS; attempt++) {
    const prompt = buildResolvePromptBody({
      projectAnchor: deps.projectAnchor,
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
      trace: lastNLines(`${gate.stdout}\n${gate.stderr}`, TRACE_LINES),
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
    const blocks = inputs.relatedIssueAnchors.map(
      ({ issue, body }) =>
        [
          `## Related issue #${issue.id}: ${issue.title}`,
          ``,
          `Branch: ${issue.branch}`,
          ``,
          body,
        ].join("\n"),
    );
    parts.push(
      [
        `# Related issues in this run`,
        ``,
        `These branches are also active this cycle. Some may already have merged into the source branch; others are queued behind this one. Read them to understand whether the conflict or failure is a real integration bug, stale work, or a case where two intents genuinely contradict and one should lose.`,
        ``,
        blocks.join("\n\n"),
      ].join("\n"),
    );
  }

  parts.push(`# Task\n\n${renderModeBlock(inputs.mode)}`);

  parts.push(buildDoneSignal(inputs.attempt, inputs.maxAttempts, inputs.mode));

  return parts.join("\n\n---\n\n");
}

function renderModeBlock(mode: AttemptTrace): string {
  if (mode.kind === "still-conflicted") {
    return [
      "A `git merge --no-ff` of this branch into the source branch is in progress and has hit a conflict.",
      "",
      mode.digest,
      "",
      "Resolve every conflict, `git add` the files, and `git commit --no-edit` to complete the merge. The orchestrator will then run the project's `check` + `test` against the result.",
    ].join("\n");
  }
  return [
    "This branch merged cleanly into the source branch, but the post-merge gate (project's `check` + `test`) is failing against the merged tree.",
    "",
    "## Gate output (last 200 lines)",
    "",
    "```",
    mode.trace,
    "```",
    "",
    "Commit a fix on top of HEAD. The merge commit itself stays in place; your work is a follow-up commit. If the two branches' intents genuinely contradict and the failure can't be reconciled with a small fix, declare ABANDON with a `<reason>` that names the colliding issues and which one should lose.",
  ].join("\n");
}

function buildDoneSignal(
  attempt: number,
  maxAttempts: number,
  mode: AttemptTrace,
): string {
  const lines: string[] = [];
  lines.push(`# Attempt ${attempt} of ${maxAttempts}`, "");
  lines.push("## Done signals", "");
  if (mode.kind === "still-conflicted") {
    lines.push(
      "- `<promise>COMMITTED</promise>` — you have resolved every conflict marker, `git add`-ed the files, and `git commit --no-edit`-ed. The orchestrator gates next.",
    );
  } else {
    lines.push(
      "- `<promise>COMMITTED</promise>` — you have committed a fix on top of HEAD. The orchestrator re-runs the gate next.",
    );
  }
  lines.push(
    "- `<promise>ABANDON</promise>` plus `<reason>…</reason>` — this can't be resolved automatically. Reason should be specific: which two intents collide, which branch you believe should lose, or what human decision is missing.",
    "",
    "After you exit, the orchestrator inspects the working tree. A claim of COMMITTED with the merge still mid-merge, or with the gate still red, rolls you back into the next attempt with the updated trace.",
    "",
    "Do not run the gate yourself.",
    "Do not push.",
  );
  return lines.join("\n");
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
