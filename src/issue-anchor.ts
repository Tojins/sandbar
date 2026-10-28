// Structured issue data and issue text for agent prompts, fetched via
// `gh issue view --json`.
//
// Rejected: `gh issue view --comments` — that flag is TTY-sensitive: piped, gh
// prints ONLY the comment thread, so a comment-less issue yields an EMPTY
// anchor. The --json form is TTY-independent; one fetch boundary serves both
// structured orchestration decisions and the pure prompt renderer
// (`renderIssueText`), whose shape remains table-testable.
//
// Sandbar comments are attributed from BOT_COMMENT_PREFIX at position zero of
// the trimmed body. They cannot be attributed from the author login: sandbar
// posts through the same operator account the human uses. Quoted or inline
// occurrences stay human-authored because they do not start the trimmed body.
//
// Sandbar's own comments are rendered without their traces (#197): every
// `<details>` block and every QUOTED_OPEN…QUOTED_CLOSE span (finalize.ts) is
// replaced by a one-line stub, so no role reads a gate trace or an earlier
// round's reviewer prose as specification. Their current versions reach the
// implementer through its own prompt layers. Comments posted before the fences
// existed are cut by their known lead-in lines instead (LEGACY_QUOTE_LEAD_IN).
// Human comments and the body are never touched.
//
// That boundary is exported as `fetchIssueSnapshot` so the inner loop can file
// the issue as it stood at admission beside the run's logs (#195). The inner
// loop reads the issue only through an `IssueSource`: `ghIssueSource` for a
// run, the case file's frozen JSON for a replay, so a replay asks `gh` nothing.
//
// Fetch/parse failures THROW (SandbarError): a missing anchor must halt loudly
// rather than degrade into a placeholder string the agent ignores.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { SandbarError } from "./errors.js";
import { BOT_COMMENT_PREFIX, QUOTED_CLOSE, QUOTED_OPEN } from "./finalize.js";
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

export type IssueData = {
  readonly title: string;
  readonly body: string;
};

const isSandbarComment = (body: string): boolean =>
  body.trim().startsWith(BOT_COMMENT_PREFIX);

// Sandbar never nests `<details>`, so the first `</details>` closes the block.
const DETAILS_BLOCK = /<details><summary>([\s\S]*?)<\/summary>[\s\S]*?<\/details>/g;
// The markers carry no regex metacharacters, so they are spliced in verbatim.
const QUOTED_SPAN = new RegExp(`${QUOTED_OPEN}[\\s\\S]*?${QUOTED_CLOSE}`, "g");
const QUOTE_OMITTED = "_(quoted review omitted.)_";

// Every lead-in finalize.ts put before reviewer prose before the fences, as
// whole lines. A paragraph starting with one is cut up to the next line
// LEGACY_QUOTE_END matches: a stub left by DETAILS_BLOCK, a block it missed, or
// the action line.
const LEGACY_QUOTE_LEAD_IN = new RegExp(
  "^(?:" +
    [
      "Latest quality review from the red round",
      "Latest correctness review \\(an earlier round\\)",
      "Latest (?:quality|correctness) reviewer report",
      "Latest verifier report(?: \\(an earlier round\\))?",
      "Earlier-round reviewer report \\(not a verdict on the current commits\\)",
      "Read-only .+ output",
    ].join("|") +
    "):$",
);
const LEGACY_QUOTE_END = /^(?:_\(|<details>|Action:)/;

function dropLegacyQuotes(text: string): string {
  const out: string[] = [];
  let quoting = false;
  for (const line of text.split("\n")) {
    if (quoting) {
      if (!LEGACY_QUOTE_END.test(line)) continue;
      quoting = false;
      out.push("");
    } else if (LEGACY_QUOTE_LEAD_IN.test(line) && (out.at(-1) ?? "") === "") {
      quoting = true;
      out.push(QUOTE_OMITTED);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// Pure: a comment body as every role reads it. Anything but a sandbar comment
// is returned unchanged.
export function dropSandbarTraces(body: string): string {
  if (!isSandbarComment(body)) return body;
  return dropLegacyQuotes(
    body
      .replace(DETAILS_BLOCK, (_, summary: string) => `_(${summary} omitted.)_`)
      .replace(QUOTED_SPAN, QUOTE_OMITTED),
  );
}

// Pure renderer: title line, body, then the comment thread (when present) with
// author/timestamp headers and sandbar's traces dropped. No "# Issue anchor"
// heading here — callers own the surrounding structure (prompt.ts adds the
// layer heading; the resolve loop embeds it under its primary-issue heading).
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
      const body = dropSandbarTraces((c.body ?? "").trim());
      const author = isSandbarComment(body)
        ? "Sandbar (orchestrator, not a human)"
        : (c.author?.login ?? "(unknown)");
      const when = c.createdAt ? ` — ${c.createdAt}` : "";
      lines.push("", `### ${author}${when}`, "", body);
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
export async function fetchIssueSnapshot(
  issueId: string,
  repo: RepoRef,
): Promise<IssueJson> {
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
  return parsed;
}

// Where the inner loop reads its issue from (#195): every prompt's issue anchor
// and the admission snapshot go through the one source the loop is given.
export type IssueSource = (issueId: string) => Promise<IssueJson>;

export const ghIssueSource = (repo: RepoRef): IssueSource =>
  (issueId) => fetchIssueSnapshot(issueId, repo);

// Structured issue fields for decisions that must not depend on the prompt
// renderer's prose shape. Comments are deliberately absent: dependency edges
// are declarations in the issue body, not discussion appended later.
export async function fetchIssueData(
  issueId: string,
  repo: RepoRef,
): Promise<IssueData> {
  const issue = await fetchIssueSnapshot(issueId, repo);
  return {
    title: issue.title ?? "(no title)",
    body: issue.body ?? "",
  };
}

export async function fetchIssueText(
  issueId: string,
  repo: RepoRef,
): Promise<string> {
  return renderIssueText(issueId, await fetchIssueSnapshot(issueId, repo));
}
