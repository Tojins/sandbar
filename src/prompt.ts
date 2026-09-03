// 3-layer prompt assembly for the inner-loop implementer and reviewer:
// project anchor (shared verbatim by both agents), issue anchor
// (issue-anchor.ts), and a per-attempt slot (implementer: attempt state,
// branch diff, sandbox-stack report #44, gate trace, reviewer prose, UI-impact
// check #21, and the same coding standards the reviewer applies plus a live
// pre-promise diff checklist (#78); reviewer: diff + commits, split into a
// correctness pass and a self-sufficient checklist follow-up sharing one
// provider session (#19), plus every earlier successful review round (#88).
// After its first whole-branch follow-up listing, that history also anchors a
// strict review of only the lines no follow-up has seen yet (#107).
//
// The issue anchor uses `--json`, NOT the human-readable `--comments` form —
// that one is TTY-sensitive and, when piped, omits the body. A fetch failure
// throws (SandbarError) instead of degrading to a placeholder.
//
// Every range a slot renders is anchored at the issue branch's SEED REF, never
// a bare branch name (#40, #61): the agents' worktree head namespace holds
// exactly one ref — the issue branch (repo-cache.ts deletes the imported
// `refs/heads/*`) — so `main` never resolves there. Range failures throw (see
// `readGit`), and a reviewer over an empty changeset is refused outright.
//
// The seed ref is not derived here: `ensureIssueBranch` returns the base it
// actually seeded from (`IssueBranchBase`) and the inner loop hands the same
// value to both builders, so the tree an agent's diff is measured against is
// by construction the tree its branch was cut from. Deriving a second answer
// in this module is precisely how a chunk member would be shown its ancestors'
// whole chunk as "the work done so far".
//
// All prose lives in prompts/*.md and is loaded via prompts.ts; this module
// only formats data into the templates' placeholders.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { SandbarError } from "./errors.js";
import type { IssueBranchBase } from "./git-ops.js";
import { fetchIssueText } from "./issue-anchor.js";
import { loadTemplate, render } from "./prompts.js";
import type { RepoRef } from "./repo-ref.js";
import type { SandboxContainerStatus } from "./sandbox-stack.js";
import type { ParsedVerdict } from "./verdict-parser.js";

const exec = promisify(execFile);

// Prose templates, loaded once at import (see prompts.ts). The render functions
// below substitute into these in-memory strings and stay pure.
const CODING_STANDARDS = loadTemplate("coding-standards");
const REVIEWER_TPL = loadTemplate("reviewer");
const REVIEWER_FOLLOWUP_TPL = loadTemplate("reviewer-followup");
const REVIEWER_PRIOR_ROUNDS_TPL = loadTemplate("reviewer-prior-rounds");
const REVIEWER_PROJECT_STANDARDS_TPL = loadTemplate("reviewer-project-standards");
const IMPLEMENTER_TPL = loadTemplate("implementer");
const IMPLEMENTER_GATE_FAILURE_TPL = loadTemplate("implementer-gate-failure");
const IMPLEMENTER_REVIEWER_FEEDBACK_TPL = loadTemplate("implementer-reviewer-feedback");
const IMPLEMENTER_ESCALATION_TPL = loadTemplate("implementer-escalation");
const IMPLEMENTER_SANDBOX_STACK_TPL = loadTemplate("implementer-sandbox-stack");
const IMPLEMENTER_CHUNK_BASE_TPL = loadTemplate("implementer-chunk-base");
const REVIEWER_CHUNK_BASE_TPL = loadTemplate("reviewer-chunk-base");

// Attempt at which the implementer prompt starts surfacing the escalation block.
const ESCALATION_ATTEMPT = 6;

// Ceiling on a single git read below. Generous because the thing it bounds is a
// whole branch's `log -p`; it is a limit, not an allocation, so the two-line
// commit list is given the same one rather than a second knob.
const GIT_READ_MAX_BUFFER = 50 * 1024 * 1024;

// What a truncated read renders instead of stopping mid-hunk. Deliberately not
// diff-shaped, so no agent reads it as content.
function truncationNote(limit: number): string {
  return `[sandbar] output truncated: exceeded the ${limit}-byte read limit for this slot.`;
}

// Every git read behind a prompt slot goes through here, and the two ways it can
// fail are deliberately NOT the same answer (#40).
//
// git BLOWING UP is a fault. The ranges below are built on the ref the issue
// branch was seeded from and read in a worktree sandbar created itself, so
// there is no working configuration in which they fail: the seed is either
// `origin/<sourceBranch>`, which preflight verifies exists in the cache, or a
// chunk tip (#61), which `ensureIssueBranch` fetched and then cut this very
// branch from a moment earlier. Mapping that onto the empty string — which is
// what all three call sites did — makes it
// indistinguishable from "there is genuinely nothing here yet", which is the
// legitimate reading on attempt 1. That is the whole reason #40 stayed
// invisible for a run: git exited 128 on every call, and the prompt said "No
// commits yet on this branch." So it throws instead, and it throws SandbarError
// because the failure is permanent — a fresh sandbox reproduces it exactly.
//
// A maxBuffer overflow is the exception, and it is not a fault at all: the
// output is real, there is just more of it than the buffer holds. Node rejects
// with the truncated prefix on `err.stdout`, so that prefix is returned with a
// marker rather than thrown — a partial diff the agent can read beats both a
// halted issue and, once again, an empty string that reads as "no work yet".
//
// Exported, with the bound as a parameter, for one reason: the truncation path
// is the half nobody can fake. That node hands back the prefix on `err.stdout`
// rather than losing it is behaviour node defines, so it is asserted by running
// it — against real git, at a bound a test can reach, instead of a 50MB fixture.
export async function readGit(
  args: readonly string[],
  cwd: string,
  what: string,
  maxBuffer: number = GIT_READ_MAX_BUFFER,
): Promise<string> {
  try {
    const { stdout } = await exec("git", [...args], { cwd, maxBuffer });
    return stdout;
  } catch (err) {
    if (
      (err as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    ) {
      const partial = (err as { stdout?: unknown }).stdout;
      return `${typeof partial === "string" ? partial : ""}\n${truncationNote(maxBuffer)}\n`;
    }
    throw new SandbarError(
      `could not read ${what}: \`git ${args.join(" ")}\` failed in ${cwd}. ` +
        `Prompt ranges are anchored at the ref the issue branch was SEEDED from — ` +
        `\`origin/<sourceBranch>\`, or a chunk branch's tip for a chunk member (#61), ` +
        `named in \`${what}\` above — and that ref resolves in sandbar's object cache ` +
        `by construction; had this been swallowed the slot would have rendered as if ` +
        `the branch held no work at all (#40). ` +
        (err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  }
}

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
  // What the branch was seeded from and what every range below is measured
  // against (#61). Replaces the `sourceBranch` this used to carry: that field's
  // only job was to build `origin/<sourceBranch>`, and re-deriving the anchor
  // here is what would show a chunk member its ancestors' work as its own.
  // Project history still comes from `ProjectAnchorOptions.sourceBranch`.
  readonly base: IssueBranchBase;
  readonly extraReprompt?: string;
  readonly latestReviewerProse?: string;
  // Optional host extension to the built-in coding standards. Its existence is
  // probed in `worktreePath`, because a branch may add the file it asks the
  // implementer (and later the reviewer) to follow (#78).
  readonly codingStandardsPath?: string;
  // What came up beside the agent this sandbox cycle (#44 D8). Absent for a
  // consumer that declares no `inSandbox` container, and an empty array is the
  // same thing — the slot renders to "" either way.
  //
  // NOT left to the consumer's own CLAUDE.md/CONTEXT.md, which is where the
  // temptation is: sandbar is the only party that knows which containers came
  // up THIS attempt, which did not, and where their logs are, and a document
  // that states it goes stale the first time it is wrong. Semantics —
  // credentials, which database, what the fixtures are — stay in the anchor
  // docs, where they already are.
  readonly sandboxStack?: readonly SandboxContainerStatus[];
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
  // The project history the anchor quotes, and the branch the review prose
  // tells the reviewer does not resolve locally. NOT the range's anchor since
  // #61 — that is `base`, which for a chunk member is the chunk tip.
  readonly sourceBranch: string;
  // What the branch was seeded from, and what the commit list and diff below
  // are measured against (#61). Same value the implementer was given.
  readonly base: IssueBranchBase;
  // Optional project standards file that *extends* the built-in coding
  // standards. Absent for hosts that rely on the built-in standards alone.
  readonly codingStandardsPath?: string;
  readonly claudeMdPath: string;
  readonly contextMdPath?: string;
  // Successful reviews earlier in this sandbox cycle (#88). A harness failure
  // adds no entry and consumes no round, so a retry reuses its number and the
  // history remains contiguous. The runner owns this history: it is prompt
  // material, not state-machine input.
  readonly priorRounds: readonly PriorReviewRound[];
};

export type PriorReviewRound = {
  readonly round: number;
  readonly head: string;
  readonly correctness: ParsedVerdict;
  readonly followup?: ParsedVerdict;
};

export type FollowupReviewContext =
  | { readonly mode: "list"; readonly anchor: null }
  | { readonly mode: "verify"; readonly anchor: string };

// A follow-up review is represented by its verdict line in #88's history. A
// harness failure contributes no such entry, while intervening correctness-only
// rounds do, so selecting the newest follow-up entry gives both first-ness and
// the exact last head this pass reviewed without adding runner state (#107).
export function followupReviewContext(
  priorRounds: readonly PriorReviewRound[],
): FollowupReviewContext {
  for (let index = priorRounds.length - 1; index >= 0; index -= 1) {
    const round = priorRounds[index];
    if (round?.followup !== undefined) {
      return { mode: "verify", anchor: round.head };
    }
  }
  return { mode: "list", anchor: null };
}

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
    await buildAttemptSlot(inputs, anchor),
  ];
  return layers.join("\n\n---\n\n");
}

// Both passes review one immutable, gate-green branch snapshot. Build every
// shared layer and git range once so the resumed follow-up cannot gain a second
// issue fetch failure point or observe a different prompt surface.
export async function buildReviewerPrompts(
  inputs: ReviewerPromptInputs,
): Promise<Readonly<Record<"correctness" | "followup", string>>> {
  const [projectAnchor, issueAnchor, slotInputs] = await Promise.all([
    buildProjectAnchor(
      {
        repo: inputs.repo,
        repoDir: inputs.repoDir,
        claudeMdPath: inputs.claudeMdPath,
        contextMdPath: inputs.contextMdPath,
        sourceBranch: inputs.sourceBranch,
      },
      inputs.worktreePath,
    ),
    buildIssueAnchor(inputs.issue.id, inputs.repo),
    buildReviewerSlotInputs(inputs),
  ]);
  const assemble = (slot: string): string =>
    [projectAnchor, issueAnchor, slot].join("\n\n---\n\n");
  return {
    correctness: assemble(renderReviewerSlot(slotInputs)),
    followup: assemble(renderReviewerFollowupSlot(slotInputs)),
  };
}

// `probeWorktree` is the tree the emitted `@refs` will be resolved in — the
// working tree the agent gets. It is a POSITIONAL argument rather than a field
// on `opts` because the prompt builders derive it from the worktree they
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
    // The one read in this module that degrades rather than throwing (#40), and
    // the difference is that this failure is not silent: history is background
    // colour, and "(unavailable)" says outright that it is missing. The slots
    // below have no such marker available — their empty rendering is a claim
    // about the branch, and a false one.
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

async function buildAttemptSlot(
  inputs: PromptInputs,
  anchor: ProjectAnchorOptions,
): Promise<string> {
  const { worktreePath, base } = inputs;

  // Empty is a legitimate answer HERE and only here: attempt 1 has no commits.
  // Which is exactly why the read must not be able to fail quietly — the one
  // slot whose emptiness is unremarkable is the one that hid #40.
  const diff = await readGit(
    ["log", "-p", "--reverse", `${base.ref}..HEAD`],
    worktreePath,
    `the work done so far on ${inputs.issue.branch}, anchored at ${base.ref}`,
  );

  const codingStandardsPath = resolveCodingStandardsPath(
    worktreePath,
    inputs.codingStandardsPath,
  );

  return renderAttemptSlot({
    ...inputs,
    codingStandardsPath,
    claudeMdPath: anchor.claudeMdPath,
    ...(anchor.contextMdPath ? { contextMdPath: anchor.contextMdPath } : {}),
    diff,
  });
}

// Pure renderer for the implementer slot, separated from the git I/O above so
// the prompt's shape is table-testable. Optional sections collapse to "" when
// their input is absent; `section()` supplies the trailing blank line.
export type AttemptSlotRender = PromptInputs & {
  readonly claudeMdPath: string;
  readonly contextMdPath?: string;
  readonly diff: string;
};

export function renderAttemptSlot(inputs: AttemptSlotRender): string {
  const {
    issue,
    attempt,
    maxAttempts,
    base,
    lastFailureTrace,
    extraReprompt,
    latestReviewerProse,
    diff,
  } = inputs;

  const workDone = diff.trim()
    ? `## Work done so far\n\n\`\`\`diff\n${diff.trim()}\n\`\`\``
    : "No commits yet on this branch.";

  // Renders to "" for every issue seeded from the source branch, which is every
  // issue on the default lane. See the template for what a chunk member needs
  // told that the diff above cannot say by itself.
  const chunkBase = base.chunkBranch
    ? render(IMPLEMENTER_CHUNK_BASE_TPL, {
        chunkBranch: base.chunkBranch,
        baseRef: base.ref,
      })
    : "";

  const gateFailure = lastFailureTrace
    ? render(IMPLEMENTER_GATE_FAILURE_TPL, { trace: lastFailureTrace })
    : "";

  const reviewerFeedback = latestReviewerProse
    ? render(IMPLEMENTER_REVIEWER_FEEDBACK_TPL, { prose: latestReviewerProse })
    : "";

  const sandboxStack = renderSandboxStackSlot(inputs.sandboxStack ?? []);

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
    chunkBase: section(chunkBase),
    workDone: section(workDone),
    sandboxStack: section(sandboxStack),
    gateFailure: section(gateFailure),
    reviewerFeedback: section(reviewerFeedback),
    orchestratorNote: section(orchestratorNote),
    escalation: section(escalation),
    codingStandards: CODING_STANDARDS,
    projectStandards: projectStandardsSlot(inputs.codingStandardsPath),
    conventionsRef: conventionsRef(inputs.claudeMdPath, inputs.contextMdPath),
    baseRef: base.ref,
  });
}

// The sandbox-stack slot (#44 D8) — pure, over the resolved subset plus this
// cycle's runtime status.
//
// Renders to "" for an empty list, which is what every consumer that declares
// no `inSandbox` container gets: the feature is opt-in and its prompt cost is
// opt-in with it.
//
// A DOWN container is listed rather than omitted, and that is the whole reason
// the status carries a failure string. An `attempt`-lifecycle sibling that will
// not start is the branch's own bootstrap breaking, and the agent is the one
// entity that can fix it — omitting it would leave the agent to discover a
// missing service by watching a connection refuse, which is the guessing this
// feature exists to end. (An `issue`-lifecycle one never reaches here: it
// throws, and the runner takes a HARD-ERROR and a fresh sandbox.)
//
// The log tail rides along for the same reason and only for a down container:
// for a live one the path is enough, and pasting a tail of a healthy service's
// log into every attempt's prompt is pure noise.
//
// No PORT is named, and its absence is deliberate rather than pending. Since
// #43 readiness is a probe podman runs inside the container, so no port number
// is written down anywhere in `gateStack` for sandbar to read — the template
// says the siblings are on the agent's own loopback, and which port each one
// listens on is the project's documentation to give. Deriving one from a
// healthcheck argv would be a guess, and an address the agent trusts and cannot
// reach is worse than no address at all.
export function renderSandboxStackSlot(
  statuses: readonly SandboxContainerStatus[],
): string {
  if (statuses.length === 0) return "";
  const lines: string[] = [];
  for (const s of statuses) {
    lines.push(
      s.up
        ? `- **${s.name}** — running \`${s.image}\`. Log: \`${s.logPath}\``
        : `- **${s.name}** — **DID NOT START** (\`${s.image}\`). ` +
          `Log: \`${s.logPath}\``,
    );
    if (!s.up && s.failure) {
      lines.push("", "```", s.failure.trim(), "```", "");
    }
  }
  return render(IMPLEMENTER_SANDBOX_STACK_TPL, {
    containers: lines.join("\n").trim(),
  });
}

async function buildReviewerSlotInputs(
  inputs: ReviewerPromptInputs,
): Promise<ReviewerSlotRender> {
  const { worktreePath } = inputs;
  const base = inputs.base.ref;

  const commits = (
    await readGit(
      ["log", `${base}..HEAD`, "--oneline"],
      worktreePath,
      `the commit list for ${inputs.issue.branch}, anchored at ${base}`,
    )
  ).trim();

  // An empty changeset is never a legitimate reviewer prompt (#40). A reviewer
  // is reached only through a COMPLETE that `parsePromise` did not downgrade —
  // which requires accumulated commits — followed by a green gate-1 over a
  // clean tree whose HEAD is still `refs/heads/<branch>`. So an empty list is
  // not "nothing to review"; it is this module and the inner loop disagreeing
  // about what the branch holds, and the only thing a reviewer can do with it
  // is return a verdict uninformed by any code. Refusing is what catches the
  // next wrong base ref even if it is wrong for a reason `origin/` does not
  // cover — the check that would have caught #40 on cycle 1 rather than after
  // 25 minutes of agent time spent reviewing nothing.
  if (commits === "") {
    throw new SandbarError(
      `refusing to launch a reviewer for issue #${inputs.issue.id}: ` +
        `\`${base}..HEAD\` is empty in ${worktreePath}, but a reviewer only runs on ` +
        `committed work that has already passed gate-1. The branch's commits and the ` +
        `range used to render them disagree.`,
    );
  }

  const diff = (
    await readGit(
      ["diff", `${base}...HEAD`],
      worktreePath,
      `the branch diff for ${inputs.issue.branch}, anchored at ${base}`,
    )
  ).trim();

  const followup = followupReviewContext(inputs.priorRounds);
  const changedSinceDiff = followup.mode === "verify"
    ? (
        await readGit(
          ["diff", `${followup.anchor}..HEAD`],
          worktreePath,
          `changes since the last follow-up review for ${inputs.issue.branch}, anchored at ${followup.anchor}`,
        )
      ).trim()
    : undefined;

  const codingStandardsPath = resolveCodingStandardsPath(
    worktreePath,
    inputs.codingStandardsPath,
  );

  return { ...inputs, codingStandardsPath, commits, diff, changedSinceDiff };
}

// Pure renderer for the reviewer slot. Extracted so tests can pin the prompt's
// shape without mocking git. Each invocation stays cold across rounds, while
// the runner supplies the earlier rounds' decisions as explicit prompt data
// (#88); this preserves fresh investigation without reviewer amnesia.
export type ReviewerSlotRender = ReviewerPromptInputs & {
  readonly commits: string;
  readonly diff: string;
  readonly changedSinceDiff?: string;
};

export function renderReviewerSlot(inputs: ReviewerSlotRender): string {
  return renderReviewerTemplate(REVIEWER_TPL, inputs);
}

export function renderReviewerFollowupSlot(inputs: ReviewerSlotRender): string {
  return renderReviewerTemplate(REVIEWER_FOLLOWUP_TPL, inputs);
}

function renderReviewerTemplate(
  template: string,
  inputs: ReviewerSlotRender,
): string {
  const { issue, base, sourceBranch, codingStandardsPath, claudeMdPath, contextMdPath, commits, diff } =
    inputs;

  // Same slot as the implementer's, aimed at the other half of the mistake: an
  // uninformed reviewer would go looking for the chunk's earlier work in this
  // diff and report it missing.
  const chunkBase = base.chunkBranch
    ? render(REVIEWER_CHUNK_BASE_TPL, {
        chunkBranch: base.chunkBranch,
        sourceBranch,
      })
    : "";

  const commitsBlock = commits
    ? `## Commits on this branch\n\n\`\`\`\n${commits}\n\`\`\``
    : "";

  // Named ref, not "the source branch" (#61): for a chunk member that is the
  // chunk tip, and calling it the source branch would tell the reviewer its
  // emptiness was measured against a tree the branch was never cut from.
  const diffBlock = diff
    ? `## Branch diff\n\n\`\`\`diff\n${diff}\n\`\`\``
    : `## Branch diff\n\n(empty — no changes against \`${base.ref}\`)`;

  const priorRounds = inputs.priorRounds.length === 0
    ? ""
    : render(REVIEWER_PRIOR_ROUNDS_TPL, {
        rounds: inputs.priorRounds.map(renderPriorReviewRound).join("\n\n"),
      });

  const followup = followupReviewContext(inputs.priorRounds);
  const followupMode = followup.mode === "list"
    ? "This is the only pass that reviews the whole branch for tests, spec and standards. Anything you do not raise now is not raised later. List every finding you would block on. There is no limit on length."
    : "An earlier pass listed this branch's tests, spec and standards findings; the history above carries them. Review only two things:\n1. The lines changed since that review, in the \"changed since\" diff below, on all three dimensions, exactly as at a listing.\n2. Whether the branch delivers what the issue asks. An unmet requirement blocks wherever it is.\nRaise nothing else. If you request changes, you may add findings outside these two under `### Non-blocking`; they never affect a verdict, now or later.";

  const changedSinceDiff = followup.mode === "verify"
    ? `## Changed since the last follow-up review\n\n${inputs.changedSinceDiff
      ? `\`\`\`diff\n${inputs.changedSinceDiff}\n\`\`\``
      : `(empty — no changes since \`${followup.anchor}\`)`}`
    : "";

  return render(template, {
    branch: issue.branch,
    baseRef: base.ref,
    sourceBranch,
    chunkBase: section(chunkBase),
    issueId: issue.id,
    issueTitle: issue.title,
    commits: section(commitsBlock),
    diff: section(diffBlock),
    priorRounds: section(priorRounds),
    followupMode: section(followupMode),
    changedSinceDiff: section(changedSinceDiff),
    codingStandards: CODING_STANDARDS,
    projectStandards: projectStandardsSlot(codingStandardsPath),
    conventionsRef: conventionsRef(claudeMdPath, contextMdPath),
  });
}

function reviewFindings(pass: ParsedVerdict): string {
  return pass.prose
    .replace(/<verdict>[\s\S]*?<\/verdict>/g, "")
    .trim();
}

function renderPriorReviewPass(name: "correctness" | "followup", pass: ParsedVerdict): string {
  const findings = reviewFindings(pass);
  return `${name}: ${pass.verdict}${findings ? `\n${findings}` : ""}`;
}

function renderPriorReviewRound(round: PriorReviewRound): string {
  return [
    `### Round ${round.round} — head=${round.head}`,
    renderPriorReviewPass("correctness", round.correctness),
    ...(round.followup ? [renderPriorReviewPass("followup", round.followup)] : []),
  ].join("\n");
}

// One spelling shared by both roles: the conventions are the same documents,
// even though each prompt tells its agent when and how to consult them (#78).
function conventionsRef(claudeMdPath: string, contextMdPath?: string): string {
  return contextMdPath
    ? `@${claudeMdPath} (and @${contextMdPath} if it exists)`
    : `@${claudeMdPath}`;
}

// Only emit the host extension when the agent can resolve it in the issue
// worktree. That lets a branch introduce its own standards while keeping a
// configured-but-absent path out of both roles' prompts (#34, #78).
function resolveCodingStandardsPath(
  worktreePath: string,
  configured?: string,
): string | undefined {
  return configured && existsSync(resolve(worktreePath, configured))
    ? configured
    : undefined;
}

function projectStandardsSlot(codingStandardsPath?: string): string {
  return section(
    codingStandardsPath
      ? render(REVIEWER_PROJECT_STANDARDS_TPL, { codingStandardsPath })
      : "",
  );
}
