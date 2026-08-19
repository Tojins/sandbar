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
  // Two directories, because they answer two different questions (#38).
  // `repoDir` is the bare cache, where the `git log` runs. `sourceWorktree` is
  // the persistent worktree detached at `origin/<sourceBranch>` — the only
  // place the host-side "does this doc exist" probes can be asked, since a bare
  // repo has no files and the operator's checkout has their uncommitted edits
  // in it. It is also the closest tree to what the agent will actually see:
  // issue worktrees seed from the same commit.
  readonly repoDir: string;
  readonly sourceWorktree: string;
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
  // The anchor layers' sources, for the `git log`/`gh issue view` and the
  // doc-existence probes respectively (#34, #38). NOT `worktreePath`: that is a
  // linked worktree of the same repo and would answer the same questions, but
  // it is the reviewer's SUBJECT, and sourcing the project anchor from it would
  // make the anchor a function of the branch under review.
  readonly repoDir: string;
  readonly sourceWorktree: string;
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
    await buildProjectAnchor(anchor),
    await buildIssueAnchor(inputs.issue.id, anchor.repoDir),
    await buildAttemptSlot(inputs),
  ];
  return layers.join("\n\n---\n\n");
}

export async function buildReviewerPrompt(
  inputs: ReviewerPromptInputs,
): Promise<string> {
  const layers = [
    await buildProjectAnchor({
      repoDir: inputs.repoDir,
      sourceWorktree: inputs.sourceWorktree,
      claudeMdPath: inputs.claudeMdPath,
      contextMdPath: inputs.contextMdPath,
      sourceBranch: inputs.sourceBranch,
    }),
    await buildIssueAnchor(inputs.issue.id, inputs.repoDir),
    await buildReviewerSlot(inputs),
  ];
  return layers.join("\n\n---\n\n");
}

export async function buildProjectAnchor(
  opts: ProjectAnchorOptions,
): Promise<string> {
  // The @refs stay exactly as the host wrote them — the agent resolves them
  // from the repo root inside its sandbox, so they must not be re-rooted. Only
  // the host-side "does this exist" probe is resolved, and it is resolved
  // against the SOURCE WORKTREE (#38): a tree at `origin/<sourceBranch>`, which
  // is what the issue worktrees seed from. The answer is silent either way — a
  // real CONTEXT.md dropped from the prompt, or a dead @ref handed to the agent
  // — so it has to be asked of a tree that resembles the one the agent gets.
  // (The known residual is narrowed but not closed: a doc the BRANCH adds is
  // still absent here, so the commit that introduces a CODING_STANDARDS.md is
  // reviewed without an @ref to it.)
  const lines = ["# Project anchor", "", `Conventions: @${opts.claudeMdPath}`];
  if (
    opts.contextMdPath &&
    existsSync(resolve(opts.sourceWorktree, opts.contextMdPath))
  ) {
    lines.push(`Context: @${opts.contextMdPath}`);
  }
  const adrDir = opts.adrDir;
  if (adrDir) {
    const adrDirPath = resolve(opts.sourceWorktree, adrDir);
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

// `gh issue view` resolves the repo from the git remotes of the directory it
// runs in, so the cwd decides which tracker the anchor quotes (#34).
// `fetchIssueText` has always accepted one — merger.ts passes its worktree —
// and this call site was simply not passing it.
async function buildIssueAnchor(
  issueId: string,
  cwd: string,
): Promise<string> {
  return `# Issue anchor\n\n${await fetchIssueText(issueId, cwd)}`;
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
  const codingStandardsPath =
    inputs.codingStandardsPath &&
    existsSync(resolve(inputs.sourceWorktree, inputs.codingStandardsPath))
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
