// 3-layer prompt assembly for the inner-loop implementer and reviewer.
//
// Layer 1 (project anchor):    @CLAUDE.md, @CONTEXT.md (when present),
//                              @docs/adr/* listing, last 10 commits on
//                              sourceBranch. Reviewer additionally references
//                              the coding standards file.
// Layer 2 (issue anchor):      `gh issue view <id> --comments` output verbatim.
// Layer 3 (per-attempt slot):  implementer: attempt counter, full branch diff,
//                              last 200 lines of the previous gate-1 trace,
//                              escalation language at attempts ≥ 6.
//                              reviewer: branch diff + commit list + standards
//                              guidance.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type ProjectAnchorOptions = {
  readonly claudeMdPath: string;
  readonly contextMdPath?: string;
  readonly adrDir?: string;
  readonly codingStandardsPath: string;
  readonly sourceBranch: string;
  readonly includeCodingStandards: boolean;
};

export type PromptInputs = {
  readonly issue: { readonly id: string; readonly title: string; readonly branch: string };
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly worktreePath: string;
  readonly lastFailureTrace: string;
  readonly sourceBranch: string;
  readonly extraReprompt?: string;
};

export type ReviewerPromptInputs = {
  readonly issue: { readonly id: string; readonly title: string; readonly branch: string };
  readonly worktreePath: string;
  readonly sourceBranch: string;
  readonly codingStandardsPath: string;
  readonly claudeMdPath: string;
  readonly contextMdPath?: string;
};

export async function buildPrompt(
  inputs: PromptInputs,
  anchor: Omit<ProjectAnchorOptions, "includeCodingStandards">,
): Promise<string> {
  const layers = [
    await buildProjectAnchor({ ...anchor, includeCodingStandards: false }),
    await buildIssueAnchor(inputs.issue.id),
    await buildAttemptSlot(inputs),
  ];
  return layers.join("\n\n---\n\n");
}

export async function buildReviewerPrompt(
  inputs: ReviewerPromptInputs,
): Promise<string> {
  const layers = [
    await buildProjectAnchor({
      claudeMdPath: inputs.claudeMdPath,
      contextMdPath: inputs.contextMdPath,
      codingStandardsPath: inputs.codingStandardsPath,
      sourceBranch: inputs.sourceBranch,
      includeCodingStandards: true,
    }),
    await buildIssueAnchor(inputs.issue.id),
    await buildReviewerSlot(inputs),
  ];
  return layers.join("\n\n---\n\n");
}

export async function buildProjectAnchor(
  opts: ProjectAnchorOptions,
): Promise<string> {
  const lines = ["# Project anchor", "", `Conventions: @${opts.claudeMdPath}`];
  if (opts.contextMdPath && existsSync(opts.contextMdPath)) {
    lines.push(`Context: @${opts.contextMdPath}`);
  }
  if (opts.includeCodingStandards && existsSync(opts.codingStandardsPath)) {
    lines.push(`Coding standards: @${opts.codingStandardsPath}`);
  }
  if (opts.adrDir && existsSync(opts.adrDir)) {
    const adrs = readdirSync(opts.adrDir).filter((f) => f.endsWith(".md")).sort();
    if (adrs.length > 0) {
      lines.push("", "ADRs:");
      for (const a of adrs) lines.push(`- @${join(opts.adrDir, a)}`);
    }
  }
  lines.push("", `Last 10 commits on \`${opts.sourceBranch}\`:`, "```");
  try {
    const { stdout } = await exec("git", [
      "log",
      opts.sourceBranch,
      "-n",
      "10",
      "--format=%h %s",
    ]);
    lines.push(stdout.trim());
  } catch {
    lines.push("(unavailable)");
  }
  lines.push("```");
  return lines.join("\n");
}

async function buildIssueAnchor(issueId: string): Promise<string> {
  let body: string;
  try {
    const { stdout } = await exec("gh", ["issue", "view", issueId, "--comments"]);
    body = stdout;
  } catch (e) {
    body = `(failed to fetch issue: ${(e as Error).message})`;
  }
  return `# Issue anchor\n\n${body}`;
}

async function buildAttemptSlot(inputs: PromptInputs): Promise<string> {
  const {
    issue,
    attempt,
    maxAttempts,
    lastFailureTrace,
    worktreePath,
    sourceBranch,
    extraReprompt,
  } = inputs;
  const lines: string[] = [];
  lines.push(`# Attempt ${attempt} of ${maxAttempts}`);
  lines.push("");
  lines.push(`Fix issue #${issue.id}: ${issue.title}`);
  lines.push(`Branch: ${issue.branch}`);
  lines.push("");

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
  if (diff.trim()) {
    lines.push("## Work done so far");
    lines.push("");
    lines.push("```diff");
    lines.push(diff.trim());
    lines.push("```");
    lines.push("");
  } else {
    lines.push("No commits yet on this branch.");
    lines.push("");
  }

  if (lastFailureTrace) {
    lines.push("## Previous gate-1 failure (last 200 lines)");
    lines.push("");
    lines.push("```");
    lines.push(lastFailureTrace);
    lines.push("```");
    lines.push("");
    lines.push("Fix the failures. Gate-1 runs the project's `check` + `test` commands.");
    lines.push("");
  }

  if (extraReprompt) {
    lines.push("## Orchestrator note");
    lines.push("");
    lines.push(extraReprompt);
    lines.push("");
  }

  if (attempt >= 6) {
    lines.push("## Escalation");
    lines.push("");
    lines.push(
      `This is attempt ${attempt}/${maxAttempts}. If you cannot make further progress:`,
    );
    lines.push(
      "- Emit `<promise>NEEDS-INFO</promise>` with a `<questions>` block listing the specific decisions or facts you need.",
    );
    lines.push(
      "- Or revert to the last-good commit and let the orchestrator route this to a human reviewer.",
    );
    lines.push("");
  }

  lines.push("## Done signal");
  lines.push("");
  lines.push(
    "When the implementation is complete and committed, emit `<promise>COMPLETE</promise>`. " +
      "Gate-1 (project's `check` + `test`) is the deciding authority — a passing claim with " +
      "a red gate sends you to the next attempt with the failure output.",
  );
  lines.push(
    "If you need information you cannot derive from the issue or codebase, emit " +
      "`<promise>NEEDS-INFO</promise>` followed by a `<questions>` block.",
  );

  return lines.join("\n");
}

async function buildReviewerSlot(inputs: ReviewerPromptInputs): Promise<string> {
  const { issue, worktreePath, sourceBranch, codingStandardsPath, claudeMdPath, contextMdPath } =
    inputs;
  const lines: string[] = [];
  lines.push("# Review");
  lines.push("");
  lines.push(
    `Review the implementation on branch \`${issue.branch}\` against \`${sourceBranch}\`.`,
  );
  lines.push(`Issue #${issue.id}: ${issue.title}`);
  lines.push("");

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

  if (commits) {
    lines.push("## Commits on this branch");
    lines.push("");
    lines.push("```");
    lines.push(commits);
    lines.push("```");
    lines.push("");
  }
  if (diff) {
    lines.push("## Branch diff");
    lines.push("");
    lines.push("```diff");
    lines.push(diff);
    lines.push("```");
    lines.push("");
  }

  const conventionsRef = contextMdPath
    ? `@${claudeMdPath} (and @${contextMdPath} if it exists)`
    : `@${claudeMdPath}`;
  lines.push("## Review process");
  lines.push("");
  lines.push(
    `Apply the standards from @${codingStandardsPath} and the conventions from ` +
      `${conventionsRef}. Look for: unnecessary complexity, redundant abstractions, ` +
      "unclear naming, missing tests for new behaviour, unsafe casts, security issues. " +
      "Preserve functionality — change how, not what.",
  );
  lines.push("");
  lines.push(
    "If you find improvements, make the edits directly on this branch and commit them. " +
      "If the code already meets the standards, make no changes.",
  );
  lines.push("");
  lines.push(
    "Gate-2 (project's `check` + `test`) runs after you finish, regardless of whether " +
      "you committed. A red gate-2 with reviewer commits causes those commits to be reverted " +
      "automatically — the implementer's work is preserved either way.",
  );

  return lines.join("\n");
}
