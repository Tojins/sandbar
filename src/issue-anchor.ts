// Issue text for agent prompts, fetched via `gh issue view --json`.
//
// History: this used to shell out to `gh issue view <id> --comments` and embed
// the stdout verbatim. That flag is TTY-sensitive: when piped (which execFile
// always is), gh prints ONLY the comment thread — so a comment-less issue
// produced an EMPTY anchor and the agents worked from the issue title alone.
// The --json form is TTY-independent and version-stable; rendering is a pure
// function (`renderIssueText`) so the prompt shape is table-testable.
//
// Fetch/parse failures THROW (SandbarError): an agent run without the issue
// spec is exactly the failure mode this module exists to prevent, so a missing
// anchor must halt loudly rather than degrade into a placeholder string the
// agent ignores.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { SandbarError } from "./errors.js";

const exec = promisify(execFile);

export type IssueComment = {
  readonly author?: { readonly login?: string };
  readonly createdAt?: string;
  readonly body?: string;
};

export type IssueJson = {
  readonly title?: string;
  readonly body?: string;
  readonly comments?: readonly IssueComment[];
};

// Pure renderer: title line, body, then the comment thread (when present) with
// author/timestamp headers. No "# Issue anchor" heading here — callers own the
// surrounding structure (prompt.ts adds the layer heading; the resolve loop
// embeds these under its own primary/related-issue headings).
export function renderIssueText(issueId: string, issue: IssueJson): string {
  const lines = [
    `Issue #${issueId}: ${issue.title ?? "(no title)"}`,
    "",
    (issue.body ?? "").trim() || "(no description)",
  ];
  const comments = issue.comments ?? [];
  if (comments.length > 0) {
    lines.push("", "## Comments");
    for (const c of comments) {
      const author = c.author?.login ?? "(unknown)";
      const when = c.createdAt ? ` — ${c.createdAt}` : "";
      lines.push("", `### ${author}${when}`, "", (c.body ?? "").trim());
    }
  }
  return lines.join("\n");
}

export async function fetchIssueText(
  issueId: string,
  cwd?: string,
): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await exec(
      "gh",
      ["issue", "view", issueId, "--json", "title,body,comments"],
      cwd ? { cwd } : {},
    ));
  } catch (err) {
    throw new SandbarError(
      `Failed to fetch issue #${issueId} via gh: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  let parsed: IssueJson;
  try {
    parsed = JSON.parse(stdout) as IssueJson;
  } catch {
    throw new SandbarError(
      `gh returned non-JSON for issue #${issueId}: ${stdout.slice(0, 200)}`,
    );
  }
  return renderIssueText(issueId, parsed);
}
