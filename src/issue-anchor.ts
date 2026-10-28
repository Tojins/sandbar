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
// Above `condenseAboveChars` the comment thread is also condensed (#197,
// #217). The condenser CLASSIFIES and this module assembles: its answer is one
// `Ci KEEP` or `Ci DROP Cj [reason]` line per comment, `j > i` naming the
// later comment that supersedes it, and `renderIssueText` renders every kept
// comment from the fetched text and each dropped one as a one-line stub. So a
// kept comment is verbatim by construction, and the newest comment can never
// be dropped: no later comment exists for it to cite. The whole comment is the
// unit; the body is never touched. A thread with a drop is labelled condensed
// and points at `gh issue view` for the original.
//
// The answer is cached per issue at `<anchorCacheDir>/<issue>.json`, keyed by
// `condenseKey`: a hash of CONDENSE_CONTRACT_VERSION, the body and the
// trace-dropped comments, not `updatedAt`, which every label flip bumps. Only
// the inner loop's `needs-anchor` step writes it; every anchor read, the
// resolve loop's included, uses the entry whose key matches the thread it just
// fetched and otherwise renders the uncondensed thread. The cache is an
// optimisation: a missing, unreadable or malformed entry is a miss, never an
// error. It stores the parsed answer rather than rendered text, so a hit
// re-renders from what GitHub returned this time.
//
// That boundary is exported as `fetchIssueSnapshot` so the inner loop can file
// the issue as it stood at admission beside the run's logs (#195).
//
// Fetch/parse failures THROW (SandbarError): a missing anchor must halt loudly
// rather than degrade into a placeholder string the agent ignores.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { SandbarError, isErrno } from "./errors.js";
import { BOT_COMMENT_PREFIX, QUOTED_CLOSE, QUOTED_OPEN } from "./finalize.js";
import { type RepoRef, repoSlug } from "./repo-ref.js";
import { lastToken, temperedBlockPattern } from "./token-scan.js";

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

// One comment as every role reads it: attributed, with sandbar's traces
// dropped.
type ThreadComment = {
  readonly author: string;
  readonly createdAt: string | null;
  readonly body: string;
};

function threadOf(issue: IssueJson): readonly ThreadComment[] {
  return (issue.comments ?? []).map((c) => {
    const body = dropSandbarTraces((c.body ?? "").trim());
    return {
      author: isSandbarComment(body)
        ? "Sandbar (orchestrator, not a human)"
        : (c.author?.login ?? "(unknown)"),
      createdAt: c.createdAt ?? null,
      body,
    };
  });
}

// Bump whenever the condenser prompt or `parseCondenseAnswer` changes: it is
// part of `condenseKey`, so every cached answer is then re-asked.
export const CONDENSE_CONTRACT_VERSION = 1;

// The condenser's verdict on one comment. `by` is the 1-based number of the
// later comment that supersedes it.
export type CondenseDecision =
  | { readonly kind: "keep" }
  | { readonly kind: "drop"; readonly by: number; readonly reason: string | null };

// One decision per comment, C1 first.
export type CondenseAnswer = readonly CondenseDecision[];

export type CondenseParse =
  | { readonly kind: "valid"; readonly answer: CondenseAnswer }
  | { readonly kind: "invalid"; readonly reason: string };

export const droppedComments = (answer: CondenseAnswer): number =>
  answer.filter((d) => d.kind === "drop").length;

export type CondensedThread = {
  readonly answer: CondenseAnswer;
  // The tracker the full thread's pointer names.
  readonly repo: RepoRef;
};

// Pure renderer: title line, body, then the comment thread (when present) with
// author/timestamp headers and sandbar's traces dropped. No "# Issue anchor"
// heading here — callers own the surrounding structure (prompt.ts adds the
// layer heading; the resolve loop embeds it under its primary-issue heading).
// With a condenser answer that drops anything, each dropped comment becomes a
// stub naming what superseded it; a run of drops shares one paragraph.
export function renderIssueText(
  issueId: string,
  issue: IssueJson,
  condensed?: CondensedThread,
): string {
  const lines = [
    `Issue #${issueId}: ${issue.title ?? "(no title)"}`,
    "",
    (issue.body ?? "").trim() || "(no description)",
  ];
  const thread = threadOf(issue);
  if (thread.length === 0) return lines.join("\n");
  const decisions = condensed?.answer ?? [];
  const dropped = droppedComments(decisions);
  if (condensed === undefined || dropped === 0) {
    lines.push("", "## Comments");
  } else {
    if (decisions.length !== thread.length) {
      throw new Error(
        `a condenser answer for ${decisions.length} comments rendered over ${thread.length}`,
      );
    }
    lines.push(
      "",
      "## Comments (condensed)",
      "",
      `${dropped} of ${thread.length} comments were dropped as superseded by later ` +
        `ones; every other comment is verbatim. Full thread: ` +
        `\`gh issue view ${issueId} --repo ${repoSlug(condensed.repo)} --comments\`.`,
    );
  }
  thread.forEach((c, k) => {
    const decision = decisions[k];
    if (decision?.kind !== "drop") {
      const when = c.createdAt === null ? "" : ` — ${c.createdAt}`;
      lines.push("", `### ${c.author}${when}`, "", c.body);
      return;
    }
    const by = thread[decision.by - 1]!;
    const stub =
      `_Dropped: ${c.author}, ${c.createdAt ?? "(undated)"}, superseded by ` +
      `${by.author}, ${by.createdAt ?? "(undated)"}` +
      `${decision.reason === null ? "" : `: ${decision.reason}`}_`;
    if (decisions[k - 1]?.kind === "drop") lines.push(stub);
    else lines.push("", stub);
  });
  return lines.join("\n");
}

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

// What a condenser answer is about: the contract, the body and the thread as
// the roles read it. The title and labels are not, so a label flip or a
// retitle keeps the cached answer.
export function condenseKey(issue: IssueJson): string {
  return sha256(JSON.stringify([
    CONDENSE_CONTRACT_VERSION,
    issue.body ?? "",
    threadOf(issue),
  ]));
}

// The condenser's input: the body as context, then each comment numbered as
// its answer names it.
export function renderCondenserInput(issueId: string, issue: IssueJson): string {
  const lines = [
    `Issue #${issueId}: ${issue.title ?? "(no title)"}`,
    "",
    "## Issue body (context only, always kept)",
    "",
    (issue.body ?? "").trim() || "(no description)",
  ];
  threadOf(issue).forEach((c, k) => {
    lines.push("", `### C${k + 1} — ${c.author} — ${c.createdAt ?? "(undated)"}`, "", c.body);
  });
  return lines.join("\n");
}

const CONDENSE_LINE = /^C(\d+)\s+(?:KEEP|DROP\s+C(\d+)(?:\s+(.*))?)$/;
const REASON_MAX_CHARS = 120;

function shortReason(raw: string | undefined): string | null {
  const reason = (raw ?? "").replace(/\s+/g, " ").trim();
  if (reason === "") return null;
  return reason.length > REASON_MAX_CHARS
    ? `${reason.slice(0, REASON_MAX_CHARS)}…`
    : reason;
}

// Why `answer` cannot be rendered over `n` comments, or null when it can:
// one decision per comment, each drop naming a later comment.
function answerProblem(answer: CondenseAnswer, n: number): string | null {
  if (answer.length !== n) return `${answer.length} decisions for ${n} comments`;
  for (const [k, decision] of answer.entries()) {
    if (decision.kind === "drop" && (decision.by <= k + 1 || decision.by > n)) {
      return `C${k + 1} is dropped for C${decision.by}, which is not a later comment`;
    }
  }
  return null;
}

// The last `<condense>` block (#113's tempered scan), one decision per
// comment 1..n. Anything else is invalid; the caller falls back to the
// uncondensed thread.
export function parseCondenseAnswer(stdout: string, n: number): CondenseParse {
  const invalid = (reason: string): CondenseParse => ({ kind: "invalid", reason });
  const block = lastToken(stdout, temperedBlockPattern("condense"));
  if (block === null) return invalid("no <condense> block");
  const byComment = new Map<number, CondenseDecision>();
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const match = CONDENSE_LINE.exec(line);
    if (match === null) return invalid(`unreadable line: ${line}`);
    const i = Number(match[1]);
    if (i < 1 || i > n) return invalid(`C${i} is not a comment`);
    if (byComment.has(i)) return invalid(`C${i} is answered twice`);
    byComment.set(
      i,
      match[2] === undefined
        ? { kind: "keep" }
        : { kind: "drop", by: Number(match[2]), reason: shortReason(match[3]) },
    );
  }
  const answer: CondenseDecision[] = [];
  for (let i = 1; i <= n; i += 1) {
    const decision = byComment.get(i);
    if (decision === undefined) return invalid(`C${i} is not answered`);
    answer.push(decision);
  }
  const problem = answerProblem(answer, n);
  return problem === null ? { kind: "valid", answer } : invalid(problem);
}

export type CondenseCacheEntry = {
  readonly v: number;
  readonly key: string;
  readonly answer: CondenseAnswer;
  readonly provider: string;
  readonly model: string;
  readonly at: string;
};

// What the cache holds for one thread: its answer, or a miss. `problem` is
// null for no entry or one about another thread, and otherwise says why the
// file could not be used, for the caller to log.
export type CondenseCacheRead =
  | { readonly kind: "hit"; readonly answer: CondenseAnswer }
  | { readonly kind: "miss"; readonly problem: string | null };

// No entry for this thread: nothing to log.
const NO_ENTRY: CondenseCacheRead = { kind: "miss", problem: null };

const cachePath = (cacheDir: string, issueId: string): string =>
  join(cacheDir, `${issueId}.json`);

const isDecision = (value: unknown): value is CondenseDecision => {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return d.kind === "keep" ||
    (d.kind === "drop" && Number.isInteger(d.by) &&
      (d.reason === null || typeof d.reason === "string"));
};

// An OS error from the read itself, as opposed to a bug in this code.
const isSystemError = (err: unknown): err is NodeJS.ErrnoException =>
  err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string";

export async function readCondenseCache(
  cacheDir: string,
  issueId: string,
  key: string,
  comments: number,
): Promise<CondenseCacheRead> {
  const path = cachePath(cacheDir, issueId);
  const miss = (problem: string): CondenseCacheRead => ({
    kind: "miss",
    problem: `anchor cache ${path} ${problem}`,
  });
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (!isSystemError(err)) throw err;
    return isErrno(err, "ENOENT") ? NO_ENTRY : miss(`is unreadable: ${err.message}`);
  }
  let entry: Partial<Record<keyof CondenseCacheEntry, unknown>>;
  try {
    entry = JSON.parse(text) as typeof entry;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return miss("is not JSON");
  }
  if (entry.v !== CONDENSE_CONTRACT_VERSION || entry.key !== key) return NO_ENTRY;
  const answer = entry.answer;
  if (!Array.isArray(answer) || !answer.every(isDecision)) {
    return miss("holds no condenser answer");
  }
  const problem = answerProblem(answer, comments);
  return problem === null ? { kind: "hit", answer } : miss(`holds an invalid answer: ${problem}`);
}

// Written whole, tmp + rename, so a reader never sees half an entry.
export async function writeCondenseCache(
  cacheDir: string,
  issueId: string,
  entry: Omit<CondenseCacheEntry, "v" | "at">,
): Promise<void> {
  const path = cachePath(cacheDir, issueId);
  const record: CondenseCacheEntry = {
    v: CONDENSE_CONTRACT_VERSION,
    ...entry,
    at: new Date().toISOString(),
  };
  await mkdir(cacheDir, { recursive: true });
  const incoming = `${path}.tmp-${process.pid}`;
  await writeFile(incoming, JSON.stringify(record));
  await rename(incoming, path);
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

// One issue as the roles read it, with the sizes the `issue-anchor` event
// reports: `rawChars` before the trace drop, `tracedChars` after it, and
// `text` — condensed when the cache holds an answer for this thread.
export type IssueAnchor = {
  readonly text: string;
  readonly json: IssueJson;
  readonly key: string;
  readonly cache: CondenseCacheRead;
  readonly rawChars: number;
  readonly tracedChars: number;
};

export async function fetchIssueAnchor(
  issueId: string,
  repo: RepoRef,
  cacheDir: string,
): Promise<IssueAnchor> {
  const json = await fetchIssueSnapshot(issueId, repo);
  const key = condenseKey(json);
  const comments = json.comments ?? [];
  const cache = await readCondenseCache(cacheDir, issueId, key, comments.length);
  const traced = renderIssueText(issueId, json);
  // The trace drop only shortens comment bodies, so the untraced render is
  // longer by exactly what it removed.
  const removed = comments.reduce((sum, c) => {
    const body = (c.body ?? "").trim();
    return sum + body.length - dropSandbarTraces(body).length;
  }, 0);
  return {
    text: cache.kind === "hit"
      ? renderIssueText(issueId, json, { answer: cache.answer, repo })
      : traced,
    json,
    key,
    cache,
    rawChars: traced.length + removed,
    tracedChars: traced.length,
  };
}

export async function fetchIssueText(
  issueId: string,
  repo: RepoRef,
  cacheDir: string,
): Promise<string> {
  return (await fetchIssueAnchor(issueId, repo, cacheDir)).text;
}
