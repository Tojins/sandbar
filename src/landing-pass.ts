// The landing pass (#258): a consumer-prompted agent that runs after every
// merge onto the SOURCE branch, clean or resolved, before install and gate-2,
// and may add commits on top of the merge.
//
// Some edits are only correct when made at landing time, because their value
// depends on what landed before them. Outdoor's client version is the case
// that motivated this: a screen change a tab on the previous bundle would
// break bumps `services.appversion` and raises that screen's required client
// version to the new value. Two branches cut from `appversion=3` both write
// `4`, git merges the identical edit cleanly, and the second landing ships
// requirement `4` when it needed `5`. Only a step on the serialized landing,
// after the merge, can know the number; as the implementer's job the rule sat
// in every implementer's context and still went wrong in parallel. The resolve
// agent runs only on a conflict or a red gate, so the merger's prompt extension
// cannot carry it. Its concern stays "reconcile two trees"; this one's is "the
// edits this landing owes the source branch": separate roles, prompts and
// budgets.
//
// What it does is the consumer's (`config.landingPass`); sandbar ships only
// the frame (`prompts/landing-pass*.md`), with no project anchor. A `{ path }`
// prompt is read at the source tip the unit lands on, the pre-merge sha, never
// from the branch being landed, so a branch cannot rewrite its own landing
// instructions. A tip without the file skips the pass, and so does a landing
// that changes no file under `paths`.
//
// The contract, checked after every exit against `mergedSha`, HEAD when the
// pass started: no merge in progress and a clean worktree, `mergedSha` an
// ancestor of HEAD, and every commit in `mergedSha..HEAD` single-parent (no
// merge, no amend, no rebase of the merge commit). A DONE that holds it ends
// the pass, with commits or without; nothing to do is the normal answer. A
// DONE that breaks it, or no signal, is reset to `mergedSha` and re-prompted
// with a note naming what broke, within `LANDING_PASS_MAX_ATTEMPTS`, after
// which it is an abandon. ABANDON with a `<reason>` names what a human must
// decide. An attempt with no agent speech is infrastructure and throws, as
// the resolve loop's does (#67); a timeout is a spent attempt.
//
// After a push race (merger.ts, #253) the pass runs once more on the merge
// result re-merged onto origin's new tip, with the sync opening, reading its
// instructions at that tip: only when it ran for some unit this cycle and
// origin's new commits touch `paths`.
//
// This file is the pure layer (path matcher, signal parser, commit-shape
// check, prompt builder) and the attempt loop over `LandingPassAdapter`. The
// container is the merger adapter's, the resolve agent's invocation under
// another name and its own routing: `landingPassAgent`, `landingPassModelId`
// and `landingPassEffort`, following the merger's CLI, "sonnet" on claude.

import { formatRateLimitFields } from "./agent-run-end.js";
import { formatUsageFields } from "./agent-usage.js";
import type { LandingPassSettings } from "./config.js";
import { SandbarError } from "./errors.js";
import { loadTemplate, render } from "./prompts.js";
import {
  type AttemptRunSummary,
  type ResolveAgentRun,
  RESOLVE_AGENT_TIMEOUT_MS,
  attemptRunSummary,
  buildInfraFailureMessage,
  formatAttemptJournal,
  throwProviderClosure,
} from "./resolve-loop.js";
import { durationField } from "./timing.js";
import { lastToken, literalTokenPattern, temperedBlockPattern } from "./token-scan.js";

export const LANDING_PASS_MAX_ATTEMPTS = 2;

const FRAME_TPL = loadTemplate("landing-pass");
const UNIT_TPL = loadTemplate("landing-pass-unit");
const SYNC_TPL = loadTemplate("landing-pass-sync");
const ISSUES_TPL = loadTemplate("landing-pass-issues");
const RETRY_TPL = loadTemplate("landing-pass-retry");

// Whether a landing that changed `changed` owes the pass: some path under a
// prefix ending in `/`, or equal to any other. No prefixes ⇒ every landing.
export function landingTouchesPaths(
  prefixes: readonly string[] | null,
  changed: readonly string[],
): boolean {
  if (prefixes === null) return true;
  return changed.some((path) =>
    prefixes.some((prefix) => prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix)
  );
}

export type LandingPassSignal =
  | { readonly kind: "DONE" }
  | { readonly kind: "ABANDON"; readonly reason: string }
  | { readonly kind: "NO-SIGNAL" };

// Literal tokens only, last wins (#113), as the resolve signal is read.
const LANDING_PASS_TOKEN = literalTokenPattern("promise", ["DONE", "ABANDON"]);

export function parseLandingPassSignal(output: string): LandingPassSignal {
  const token = lastToken(output, LANDING_PASS_TOKEN);
  if (token === null) return { kind: "NO-SIGNAL" };
  if (token === "DONE") return { kind: "DONE" };
  const reason = lastToken(output, temperedBlockPattern("reason"));
  return { kind: "ABANDON", reason: reason || "(no reason given)" };
}

// What the worktree looks like after an attempt, against `mergedSha`.
export type CommitShape = {
  readonly mergeInProgress: boolean;
  // `git status --porcelain` lines.
  readonly dirtyPaths: readonly string[];
  // `mergedSha` is an ancestor of HEAD.
  readonly descends: boolean;
  // `mergedSha..HEAD`, oldest first; empty when HEAD does not descend.
  readonly commits: readonly { readonly sha: string; readonly parents: number }[];
};

// What breaks the contract, as the clause the re-prompt names; null when the
// pass may keep what it committed.
export function commitShapeProblem(shape: CommitShape): string | null {
  if (shape.mergeInProgress) return "a merge was left in progress";
  if (shape.dirtyPaths.length > 0) {
    return `the worktree was left dirty (${shape.dirtyPaths.join(", ")})`;
  }
  if (!shape.descends) {
    return "HEAD no longer descended from the merge (amended, rebased or reset)";
  }
  const merge = shape.commits.find((commit) => commit.parents !== 1);
  return merge === undefined
    ? null
    : `commit ${merge.sha} has ${merge.parents} parents, and only single-parent ` +
      "commits may follow the merge";
}

// How the prompt opens: one unit just merged, or the push race's re-merge of
// the cycle's landings onto origin's new tip.
export type LandingPassOpening =
  | {
      readonly kind: "unit";
      // `#12`, `chunk #40` or `janitor <task>`.
      readonly label: string;
      readonly branch: string;
      readonly preMergeSha: string;
    }
  | {
      readonly kind: "sync";
      readonly labels: readonly string[];
      readonly oldTip: string;
      readonly newTip: string;
    };

export type LandingPassPromptInputs = {
  readonly opening: LandingPassOpening;
  // The source branch's name.
  readonly target: string;
  readonly mergedSha: string;
  // The issues the landing carries, one `gh issue view` line each.
  readonly issues: readonly number[];
  readonly repoSlug: string;
  readonly instructions: string;
  readonly attempt: number;
  // Why the previous attempt was reset; null on attempt 1.
  readonly retry: string | null;
};

export function buildLandingPassPrompt(inputs: LandingPassPromptInputs): string {
  const { opening, target, mergedSha } = inputs;
  const landing = opening.kind === "unit"
    ? render(UNIT_TPL, {
        label: opening.label,
        branch: opening.branch,
        target,
        mergedSha,
        preMergeSha: opening.preMergeSha,
      })
    : render(SYNC_TPL, {
        labels: opening.labels.join(", "),
        target,
        oldTip: opening.oldTip,
        newTip: opening.newTip,
        mergedSha,
      });
  const issues = inputs.issues.length === 0
    ? ""
    : `\n\n${render(ISSUES_TPL, {
        issues: inputs.issues
          .map((n) => `- \`gh issue view ${n} --repo ${inputs.repoSlug} --json title,body\``)
          .join("\n"),
      })}`;
  const retry = inputs.retry === null
    ? ""
    : `\n${render(RETRY_TPL, {
        previous: String(inputs.attempt - 1),
        mergedSha,
        problem: inputs.retry,
      })}\n`;
  return render(FRAME_TPL, {
    landing,
    issues,
    instructions: inputs.instructions,
    attempt: String(inputs.attempt),
    maxAttempts: String(LANDING_PASS_MAX_ATTEMPTS),
    retry,
    mergedSha,
  });
}

// `halt` is an attempt the loop throws on: no agent speech, or a provider's
// quota or credential closure.
export type LandingPassAttemptOutcome = "done" | "retry" | "abandon" | "halt";

// One attempt, for the run's log tree and event record.
export type LandingPassAttemptRecord = ResolveAgentRun & {
  readonly attempt: number;
  readonly outcome: LandingPassAttemptOutcome;
  // Commits the pass kept on top of the merge; 0 unless `done`.
  readonly commits: number;
};

// One attempt as the abandon comment reports it: a pass that ends `done`
// has no comment, and a `halt` throws.
export type LandingPassAttemptSummary = AttemptRunSummary & (
  | { readonly outcome: "retry"; readonly problem: string }
  | { readonly outcome: "abandon" }
);

export function formatLandingPassAttempts(
  attempts: readonly LandingPassAttemptSummary[],
): string {
  return formatAttemptJournal(attempts, (a) =>
    a.outcome === "retry" ? `it was reset: ${a.problem}` : "the agent asked to abandon");
}

export type LandingPassOutcome =
  | { readonly kind: "skipped"; readonly why: string }
  | { readonly kind: "done"; readonly commits: number }
  | {
      readonly kind: "abandon";
      readonly reason: string;
      readonly attempts: readonly LandingPassAttemptSummary[];
    };

export type LandingPassAdapter = {
  runLandingPassAgent(prompt: string, attempt: number): Promise<ResolveAgentRun>;
  // `git diff --name-only from..to`.
  changedPaths(from: string, to: string): Promise<readonly string[]>;
  // `path` as committed at `rev`, null when `rev` has no such file.
  readFileAt(rev: string, path: string): Promise<string | null>;
  commitShape(mergedSha: string): Promise<CommitShape>;
  getHeadSha(): Promise<string>;
  resetHardSha(sha: string): Promise<void>;
};

export type LandingPassDeps = {
  readonly settings: LandingPassSettings;
  readonly log: (line: string) => Promise<void>;
  // Writes the attempt's output and answers where, as a resolve attempt's.
  readonly onAttempt?: (record: LandingPassAttemptRecord) => Promise<string | null>;
};

// One pass over the merge at HEAD. `promptAt` is the source tip whose
// instructions apply and `changed` the range that must touch `paths`. Every
// outcome but `done` leaves HEAD at the merge, clean.
export async function runLandingPass(
  args: {
    readonly label: string;
    readonly promptAt: string;
    readonly changed: { readonly from: string; readonly to: string };
    readonly prompt: Omit<LandingPassPromptInputs, "mergedSha" | "instructions" | "attempt" | "retry">;
  },
  adapter: LandingPassAdapter,
  deps: LandingPassDeps,
): Promise<LandingPassOutcome> {
  const { label } = args;
  const skipped = async (why: string): Promise<LandingPassOutcome> => {
    await deps.log(`landing-pass ${label} skipped: ${why}`);
    return { kind: "skipped", why };
  };
  const changed = await adapter.changedPaths(args.changed.from, args.changed.to);
  if (!landingTouchesPaths(deps.settings.paths, changed)) return skipped("no path matches");
  const { prompt } = deps.settings;
  let instructions: string | null;
  if ("text" in prompt) {
    instructions = prompt.text;
  } else {
    instructions = await adapter.readFileAt(args.promptAt, prompt.path);
    if (instructions === null) return skipped(`${prompt.path} absent at ${args.promptAt}`);
  }

  const mergedSha = await adapter.getHeadSha();
  const attempts: LandingPassAttemptSummary[] = [];
  let retry: string | null = null;
  for (let attempt = 1; attempt <= LANDING_PASS_MAX_ATTEMPTS; attempt++) {
    const run = await adapter.runLandingPassAgent(
      buildLandingPassPrompt({ ...args.prompt, instructions, mergedSha, attempt, retry }),
      attempt,
    );
    const verdict = await judgeAttempt(run, mergedSha, adapter);
    const logPath = deps.onAttempt
      ? await deps.onAttempt({
          ...run,
          attempt,
          outcome: verdict.outcome,
          commits: verdict.outcome === "done" ? verdict.commits : 0,
        })
      : null;
    await deps.log(
      `landing-pass ${label} attempt ${attempt} container=${run.container} ` +
        `end=${run.end} ${durationField(run.durationMs)} outcome=${verdict.outcome}` +
        formatUsageFields(run.usage, run.toolCalls, run.peakContext) +
        formatRateLimitFields(run.rateLimit) +
        (logPath ? ` log=${logPath}` : ""),
    );
    if (verdict.outcome === "halt") {
      throwProviderClosure(run);
      throw new SandbarError(buildInfraFailureMessage({
        agent: `the landing pass for ${label}`,
        budget: "landing-pass attempt",
        attempt,
        maxAttempts: LANDING_PASS_MAX_ATTEMPTS,
        run,
        logPath,
      }));
    }
    if (verdict.outcome === "done") {
      await deps.log(`landing-pass ${label} done commits=${verdict.commits}`);
      return { kind: "done", commits: verdict.commits };
    }
    await adapter.resetHardSha(mergedSha);
    const summary = attemptRunSummary(run, attempt, logPath);
    if (verdict.outcome === "abandon") {
      attempts.push({ ...summary, outcome: "abandon" });
      await deps.log(`landing-pass ${label} abandon: ${verdict.reason}`);
      return { kind: "abandon", reason: verdict.reason, attempts };
    }
    attempts.push({ ...summary, outcome: "retry", problem: verdict.problem });
    retry = verdict.problem;
  }
  const reason =
    `${LANDING_PASS_MAX_ATTEMPTS} landing-pass attempts were reset; the last because ${retry}.`;
  await deps.log(`landing-pass ${label} abandon: ${reason}`);
  return { kind: "abandon", reason, attempts };
}

type AttemptVerdict =
  | { readonly outcome: "halt" }
  | { readonly outcome: "abandon"; readonly reason: string }
  | { readonly outcome: "done"; readonly commits: number }
  | { readonly outcome: "retry"; readonly problem: string };

async function judgeAttempt(
  run: ResolveAgentRun,
  mergedSha: string,
  adapter: LandingPassAdapter,
): Promise<AttemptVerdict> {
  if (run.verdict !== "answer") return { outcome: "halt" };
  const signal = parseLandingPassSignal(run.output);
  if (signal.kind === "ABANDON") return { outcome: "abandon", reason: signal.reason };
  if (signal.kind === "NO-SIGNAL") {
    return {
      outcome: "retry",
      problem: run.end === "timeout"
        ? `it was killed at the ${RESOLVE_AGENT_TIMEOUT_MS / 60_000}-minute timeout before signalling`
        : "it signalled neither DONE nor ABANDON",
    };
  }
  const shape = await adapter.commitShape(mergedSha);
  const problem = commitShapeProblem(shape);
  return problem === null
    ? { outcome: "done", commits: shape.commits.length }
    : { outcome: "retry", problem };
}
