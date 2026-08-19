// 3-layer prompt assembly for the inner-loop implementer and reviewer.
//
// Layer 1 (project anchor):    @CLAUDE.md, @CONTEXT.md (when present),
//                              @docs/adr/* listing, last 10 commits on
//                              sourceBranch. Shared verbatim by both agents.
// Layer 2 (issue anchor):      `gh issue view <id> --json title,body,comments`
//                              rendered deterministically (issue-anchor.ts).
//                              NOT the human-readable `--comments` form, which
//                              is TTY-sensitive and, when piped, omits the
//                              body — a zero-comment issue produced an empty
//                              anchor. A fetch failure throws (SandbarError)
//                              instead of degrading to a placeholder.
// Layer 3 (per-attempt slot):  implementer: attempt counter, full branch diff,
//                              last 200 lines of the previous gate-1 trace,
//                              the previous reviewer's prose (when the prior
//                              round returned CHANGES-REQUESTED), escalation
//                              language at attempts ≥ 6, and the standing
//                              UI-impact check (#21) that gates implementation
//                              on a prototype existing for user-visible work.
//                              reviewer: branch diff + commit list + the
//                              built-in coding standards
//                              (prompts/coding-standards.md) + optional project
//                              standards + verdict-token instructions. Each
//                              reviewer pass is stateless — no prior-round
//                              transcript is included.
//
// All prose lives in prompts/*.md and is loaded via prompts.ts; this module
// only formats data into the templates' placeholders.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { fetchIssueText } from "./issue-anchor.js";
import { loadTemplate, render } from "./prompts.js";
import type { RepoRef } from "./repo-ref.js";

const exec = promisify(execFile);

// Prose templates, loaded once at import (see prompts.ts). The render functions
// below substitute into these in-memory strings and stay pure.
const CODING_STANDARDS = loadTemplate("coding-standards");
const REVIEWER_TPL = loadTemplate("reviewer");
const REVIEWER_PROJECT_STANDARDS_TPL = loadTemplate("reviewer-project-standards");
const IMPLEMENTER_TPL = loadTemplate("implementer");
const IMPLEMENTER_GATE_FAILURE_TPL = loadTemplate("implementer-gate-failure");
const IMPLEMENTER_REVIEWER_FEEDBACK_TPL = loadTemplate("implementer-reviewer-feedback");
const IMPLEMENTER_ESCALATION_TPL = loadTemplate("implementer-escalation");

// Attempt at which the implementer prompt starts surfacing the escalation block.
const ESCALATION_ATTEMPT = 6;

// Append a trailing blank-line separator to a non-empty section so the skeleton
// templates can place optional sections back-to-back without managing spacing.
function section(body: string): string {
  return body ? `${body}\n\n` : "";
}

export type ProjectAnchorOptions = {
  // Where the anchor is read FROM. Explicit rather than inherited from
  // `process.cwd()` (#34): the anchor is the one layer of the prompt the agent
  // has no way to sanity check — it reads as this repo's history and is wrong
  // in a way that looks exactly like a stale checkout.
  //
  // Three sources, because they answer three different questions.
  //
  // `repo` is the tracker (#34). It names the repository outright rather than
  // letting `gh` infer it from a directory's remotes — see issue-anchor.ts.
  //
  // `repoDir` is the bare cache, where the `git log` runs (#38).
  //
  // The tree the emitted `@refs` will be RESOLVED against is deliberately NOT
  // a field here — it is `buildProjectAnchor`'s second argument, so that the
  // two prompt builders can DERIVE it from the worktree they are already
  // given rather than a caller having to remember to supply it. See there.
  readonly repo: RepoRef;
  readonly repoDir: string;
  readonly claudeMdPath: string;
  readonly contextMdPath?: string;
  readonly adrDir?: string;
  readonly sourceBranch: string;
};

export type PromptInputs = {
  readonly issue: { readonly id: string; readonly title: string; readonly branch: string };
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly worktreePath: string;
  readonly lastFailureTrace: string;
  readonly sourceBranch: string;
  readonly extraReprompt?: string;
  readonly latestReviewerProse?: string;
};

export type ReviewerPromptInputs = {
  readonly issue: { readonly id: string; readonly title: string; readonly branch: string };
  // The anchor layers' sources (#34, #38). `repo` names the tracker; `repoDir`
  // is where the `git log` runs, and it stays the bare cache rather than
  // `worktreePath` — that worktree is the reviewer's SUBJECT, and sourcing the
  // project HISTORY from it would make the anchor a function of the branch
  // under review.
  //
  // The doc-existence probes are the opposite case and are derived from
  // `worktreePath`: they decide whether to emit an `@ref` the reviewer will
  // resolve inside its sandbox, against exactly that worktree. Being a function
  // of the branch is the POINT there — a branch that adds
  // `CODING_STANDARDS.md` must be reviewed against it.
  readonly repo: RepoRef;
  readonly repoDir: string;
  readonly worktreePath: string;
  readonly sourceBranch: string;
  // Optional project standards file that *extends* the built-in coding
  // standards. Absent for hosts that rely on the built-in standards alone.
  readonly codingStandardsPath?: string;
  readonly claudeMdPath: string;
  readonly contextMdPath?: string;
};

export async function buildPrompt(
  inputs: PromptInputs,
  anchor: ProjectAnchorOptions,
): Promise<string> {
  const layers = [
    // The probe tree is DERIVED from the worktree this prompt is about, not
    // taken from `anchor` (#34). The caller cannot get it wrong because the
    // caller does not supply it — which matters because "which tree" is
    // type-invisible: every candidate is a string, so a call site handed the
    // source worktree instead type-checks, passes every test that exercises
    // this module directly, and silently drops the `@ref` for any doc the
    // branch itself adds.
    await buildProjectAnchor(anchor, inputs.worktreePath),
    await buildIssueAnchor(inputs.issue.id, anchor.repo),
    await buildAttemptSlot(inputs),
  ];
  return layers.join("\n\n---\n\n");
}

export async function buildReviewerPrompt(
  inputs: ReviewerPromptInputs,
): Promise<string> {
  const layers = [
    await buildProjectAnchor(
      {
        repo: inputs.repo,
        repoDir: inputs.repoDir,
        claudeMdPath: inputs.claudeMdPath,
        contextMdPath: inputs.contextMdPath,
        sourceBranch: inputs.sourceBranch,
      },
      inputs.worktreePath,
    ),
    await buildIssueAnchor(inputs.issue.id, inputs.repo),
    await buildReviewerSlot(inputs),
  ];
  return layers.join("\n\n---\n\n");
}

// `probeWorktree` is the tree the emitted `@refs` will be resolved in — the
// working tree the agent gets. It is a POSITIONAL argument rather than a field
// on `opts` because the two prompt builders derive it from the worktree they
// are already about, and only the merge phase supplies one by hand; a field
// would have made it one more string among six that a call site has to get
// right, with nothing but a name to distinguish it from `repoDir` and no test
// able to see the difference (see `buildPrompt`).
//
// The probe and the resolver have to be asked of the same tree or the answer is
// silent in both directions, and it has been asked of three different wrong
// ones: `process.cwd()` before #34, the operator's checkout (uncommitted edits,
// so a real `CONTEXT.md` the agent cannot open) after it, and `worktrees/source`
// after #38 — a clean tree at `origin/<sourceBranch>`, which is what an issue
// worktree SEEDS from and stops being the moment the branch adds a doc. That
// last one is the case worth naming: when the issue IS "add
// CODING_STANDARDS.md", the branch has it and the source tree does not, so the
// reviewer was handed no `@ref` to the very standards the commit under review
// had just authored.
export async function buildProjectAnchor(
  opts: ProjectAnchorOptions,
  probeWorktree: string,
): Promise<string> {
  // The @refs stay exactly as the host wrote them — the agent resolves them
  // from the repo root inside its sandbox, so they must not be re-rooted. Only
  // the host-side "does this exist" probe is resolved, and it is resolved
  // against `probeWorktree`: the very tree the agent will resolve the @ref in.
  // The answer is silent either way — a real CONTEXT.md dropped from the
  // prompt, or a dead @ref handed to the agent — which is why the probe and the
  // resolver must be the same tree rather than merely similar ones (#34).
  const lines = ["# Project anchor", "", `Conventions: @${opts.claudeMdPath}`];
  if (
    opts.contextMdPath &&
    existsSync(resolve(probeWorktree, opts.contextMdPath))
  ) {
    lines.push(`Context: @${opts.contextMdPath}`);
  }
  const adrDir = opts.adrDir;
  if (adrDir) {
    const adrDirPath = resolve(probeWorktree, adrDir);
    const adrs = existsSync(adrDirPath)
      ? readdirSync(adrDirPath).filter((f) => f.endsWith(".md")).sort()
      : [];
    if (adrs.length > 0) {
      lines.push("", "ADRs:");
      for (const a of adrs) lines.push(`- @${join(adrDir, a)}`);
    }
  }
  lines.push("", `Last 10 commits on \`${opts.sourceBranch}\`:`, "```");
  try {
    // `origin/<sourceBranch>`, not the bare name (#38). The cache deliberately
    // holds no local copy of the source branch — `origin/<sourceBranch>` is
    // what every worktree seeds from and what the merger lands on, so it is
    // also the history the agent should be shown.
    const { stdout } = await exec(
      "git",
      ["log", `origin/${opts.sourceBranch}`, "-n", "10", "--format=%h %s"],
      { cwd: opts.repoDir },
    );
    lines.push(stdout.trim());
  } catch {
    lines.push("(unavailable)");
  }
  lines.push("```");
  return lines.join("\n");
}

async function buildIssueAnchor(
  issueId: string,
  repo: RepoRef,
): Promise<string> {
  return `# Issue anchor\n\n${await fetchIssueText(issueId, repo)}`;
}

async function buildAttemptSlot(inputs: PromptInputs): Promise<string> {
  const { worktreePath, sourceBranch } = inputs;

  let diff = "";
  try {
    const { stdout } = await exec(
      "git",
      ["log", "-p", "--reverse", `${sourceBranch}..HEAD`],
      {
        cwd: worktreePath,
        maxBuffer: 50 * 1024 * 1024,
      },
    );
    diff = stdout;
  } catch {
    diff = "";
  }

  return renderAttemptSlot({ ...inputs, diff });
}

// Pure renderer for the implementer slot, separated from the git I/O above so
// the prompt's shape is table-testable. Optional sections collapse to "" when
// their input is absent; `section()` supplies the trailing blank line.
export type AttemptSlotRender = PromptInputs & { readonly diff: string };

export function renderAttemptSlot(inputs: AttemptSlotRender): string {
  const {
    issue,
    attempt,
    maxAttempts,
    lastFailureTrace,
    extraReprompt,
    latestReviewerProse,
    diff,
  } = inputs;

  const workDone = diff.trim()
    ? `## Work done so far\n\n\`\`\`diff\n${diff.trim()}\n\`\`\``
    : "No commits yet on this branch.";

  const gateFailure = lastFailureTrace
    ? render(IMPLEMENTER_GATE_FAILURE_TPL, { trace: lastFailureTrace })
    : "";

  const reviewerFeedback = latestReviewerProse
    ? render(IMPLEMENTER_REVIEWER_FEEDBACK_TPL, { prose: latestReviewerProse })
    : "";

  const orchestratorNote = extraReprompt
    ? `## Orchestrator note\n\n${extraReprompt}`
    : "";

  const escalation =
    attempt >= ESCALATION_ATTEMPT
      ? render(IMPLEMENTER_ESCALATION_TPL, {
          attempt: String(attempt),
          maxAttempts: String(maxAttempts),
        })
      : "";

  return render(IMPLEMENTER_TPL, {
    attempt: String(attempt),
    maxAttempts: String(maxAttempts),
    issueId: issue.id,
    issueTitle: issue.title,
    branch: issue.branch,
    workDone: section(workDone),
    gateFailure: section(gateFailure),
    reviewerFeedback: section(reviewerFeedback),
    orchestratorNote: section(orchestratorNote),
    escalation: section(escalation),
  });
}

async function buildReviewerSlot(inputs: ReviewerPromptInputs): Promise<string> {
  const { worktreePath, sourceBranch } = inputs;

  let commits = "";
  try {
    const { stdout } = await exec(
      "git",
      ["log", `${sourceBranch}..HEAD`, "--oneline"],
      { cwd: worktreePath },
    );
    commits = stdout.trim();
  } catch {
    commits = "";
  }

  let diff = "";
  try {
    const { stdout } = await exec(
      "git",
      ["diff", `${sourceBranch}...HEAD`],
      { cwd: worktreePath, maxBuffer: 50 * 1024 * 1024 },
    );
    diff = stdout.trim();
  } catch {
    diff = "";
  }

  // Only point at the project standards file when it actually exists, so a
  // configured-but-absent path doesn't send the reviewer chasing a dead @ref.
  // Probed in the worktree UNDER REVIEW, which is where the reviewer will
  // resolve the @ref — so the commit that adds the standards is reviewed
  // against them (#34).
  const codingStandardsPath =
    inputs.codingStandardsPath &&
    existsSync(resolve(worktreePath, inputs.codingStandardsPath))
      ? inputs.codingStandardsPath
      : undefined;

  return renderReviewerSlot({ ...inputs, codingStandardsPath, commits, diff });
}

// Pure renderer for the reviewer slot. Extracted so tests can pin the prompt's
// shape without mocking git. Reviewer is strictly stateless across rounds:
// nothing here carries prior-round content beyond what's already in the diff.
export type ReviewerSlotRender = ReviewerPromptInputs & {
  readonly commits: string;
  readonly diff: string;
};

export function renderReviewerSlot(inputs: ReviewerSlotRender): string {
  const { issue, sourceBranch, codingStandardsPath, claudeMdPath, contextMdPath, commits, diff } =
    inputs;

  const commitsBlock = commits
    ? `## Commits on this branch\n\n\`\`\`\n${commits}\n\`\`\``
    : "";

  const diffBlock = diff
    ? `## Branch diff\n\n\`\`\`diff\n${diff}\n\`\`\``
    : "## Branch diff\n\n(empty — no changes against the source branch)";

  const projectStandards = codingStandardsPath
    ? render(REVIEWER_PROJECT_STANDARDS_TPL, { codingStandardsPath })
    : "";

  const conventionsRef = contextMdPath
    ? `@${claudeMdPath} (and @${contextMdPath} if it exists)`
    : `@${claudeMdPath}`;

  return render(REVIEWER_TPL, {
    branch: issue.branch,
    sourceBranch,
    issueId: issue.id,
    issueTitle: issue.title,
    commits: section(commitsBlock),
    diff: section(diffBlock),
    codingStandards: CODING_STANDARDS,
    projectStandards: section(projectStandards),
    conventionsRef,
  });
}
