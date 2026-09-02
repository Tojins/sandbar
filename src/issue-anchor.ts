// Issue text for agent prompts, fetched via `gh issue view --json`.
//
// Rejected: `gh issue view --comments` — that flag is TTY-sensitive: piped, gh
// prints ONLY the comment thread, so a comment-less issue yields an EMPTY
// anchor. The --json form is TTY-independent; rendering is a pure function
// (`renderIssueText`) so the prompt shape is table-testable.
//
// Fetch/parse failures THROW (SandbarError): a missing anchor must halt loudly
// rather than degrade into a placeholder string the agent ignores.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { SandbarError } from "./errors.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";

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

// The repository is NAMED, not inferred (#34). `gh issue view` otherwise
// resolves it from the git remotes of the directory it runs in, and this call
// is the one that decides which tracker the implementer's and reviewer's issue
// anchor QUOTES — the one layer of the prompt an agent has no way to sanity
// check, since a different repository's issue #42 reads exactly like this
// repository's would. It was a directory twice over: first `process.cwd()`
// (the prompt-layer call site omitted the optional `cwd` #34 added), then the
// cache's `origin`. `config.ghOwner`/`config.ghRepo` are required fields, so
// naming them is one answer that no directory can contradict.
export async function fetchIssueText(
  issueId: string,
  repo: RepoRef,
): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await exec("gh", [
      "issue",
      "view",
      issueId,
      "--repo",
      repoSlug(repo),
      "--json",
      "title,body,comments",
    ]));
  } catch (err) {
    throw new SandbarError(
      `Failed to fetch issue #${issueId} from ${repoSlug(repo)} via gh: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  let parsed: IssueJson;
  try {
    parsed = JSON.parse(stdout) as IssueJson;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new SandbarError(
      `gh returned non-JSON for issue #${issueId} in ${repoSlug(repo)}: ${stdout.slice(0, 200)}`,
      { cause: err },
    );
  }
  return renderIssueText(issueId, parsed);
}
