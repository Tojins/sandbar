// Prompt assembly for the inner-loop roles:
// project anchor (shared verbatim by both agents), issue anchor
// (issue-anchor.ts), and a per-attempt slot (implementer: attempt state,
// commit list + diff stat (progressive disclosure, #158), the quality fixer's
// commits since the last attempt (#185), sandbox-stack report #44, the egress
// allowlist note when it is enforced (#202), gate trace,
// the latest verifier rejection — an accepted behavior finding is fixed at
// every same-defect site behind a failing-first test (#181) — and the same
// built-in coding standards the quality pass applies plus a live pre-promise
// diff checklist (#78).
// The quality pass (#187): its lister gets diff
// stat + commits, the exhaustive listing text and, once a quality pass has
// approved a head, a stat of what changed since that head as its only review
// surface, plus every quality report an adjudicator overruled with its
// ruling; its fixer gets the latest CHANGES-REQUESTED report (and an upheld
// ruling); its verify gets that report and a stat of what the fixer changed.
// The verifier's white-box review (#180): diff stat + commits plus every
// earlier white-box round (#88), a defect a round raised counting as addressed
// only once it is gone from every site (#181); the lister's overrule history
// shares that section but not that rule. Its first round reads the whole
// branch; later rounds are anchored at the last reviewed head HEAD still
// contains and read only the change since, with a stat of it, while earlier
// conclusions about unchanged code stand. Every prompt is self-sufficient because no role resumes
// another's session — which is what lets each role sit on its own vendor
// (#121).
// The adjudicator (#167) gets the shared anchors plus one rejected report of
// either pass and its immutable head, deliberately without prior-round
// history or implementer speech so it must re-establish every blocking claim
// from the code.
// The UI and partition checkers (#126/#158) are intentionally smaller: issue
// anchor plus their own decision contracts, with no project standards, diff or
// prior-round history. The anchor condenser (#217) is smaller still: its
// contract and the thread to classify, with no anchor layer at all. The
// partition check is gated on the context budget: a split is asked for only
// when the whole issue plausibly exceeds it and names outcomes that land
// alone; the per-piece estimates it renders are for the human.
//
// The issue anchor uses `--json`, NOT the human-readable `--comments` form —
// that one is TTY-sensitive and, when piped, omits the body. A fetch failure
// throws (SandbarError) instead of degrading to a placeholder. Every role gets
// it only through `buildIssueAnchor`, which reads the condenser's cache in
// `anchorCacheDir` (issue-anchor.ts), so each role sees the condensed thread
// whenever the inner loop's `needs-anchor` step condensed this exact thread.
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

import { SandbarError, isErrno, isExitCode } from "./errors.js";
import type { PromptExtension } from "./config.js";
import type { IssueBranchBase } from "./git-ops.js";
import type { ReviewScope, ReviewPass } from "./inner-loop-machine.js";
import {
  type IssueJson,
  type IssueSource,
  fetchIssueText,
  renderCondenserInput,
} from "./issue-anchor.js";
import { loadTemplate, render } from "./prompts.js";
import type { RepoRef } from "./repo-ref.js";
import type { SandboxContainerStatus } from "./sandbox-stack.js";
import { type ParsedVerdict, stripVerdictTokens } from "./verdict-parser.js";

const exec = promisify(execFile);

// Prose templates, loaded once at import (see prompts.ts). The render functions
// below substitute into these in-memory strings and stay pure.
const CODING_STANDARDS = loadTemplate("coding-standards");
const BACKGROUND_TASKS = loadTemplate("background-tasks");
const REVIEWER_TPL = loadTemplate("reviewer");
const REVIEWER_FULL_TPL = loadTemplate("reviewer-full");
const REVIEWER_FULL_HISTORY_TPL = loadTemplate("reviewer-full-history");
const REVIEWER_SINCE_TPL = loadTemplate("reviewer-since");
const REVIEWER_SINCE_HISTORY_TPL = loadTemplate("reviewer-since-history");
const REVIEWER_QUALITY_TPL = loadTemplate("reviewer-quality");
const REVIEWER_QUALITY_LISTING_TPL = loadTemplate("reviewer-quality-listing");
const REVIEWER_QUALITY_LISTING_SINCE_TPL = loadTemplate("reviewer-quality-listing-since");
const REVIEWER_QUALITY_VERIFY_TPL = loadTemplate("reviewer-quality-verify");
const REVIEWER_QUALITY_OVERRULES_TPL = loadTemplate("reviewer-quality-overrules");
const QUALITY_FIXER_TPL = loadTemplate("quality-fixer");
const QUALITY_FIXER_RULING_TPL = loadTemplate("quality-fixer-ruling");
const REVIEWER_PRIOR_ROUNDS_TPL = loadTemplate("reviewer-prior-rounds");
const REVIEWER_PRIOR_ROUNDS_ADDRESSED_TPL = loadTemplate("reviewer-prior-rounds-addressed");
const REVIEWER_PROJECT_STANDARDS_TPL = loadTemplate("reviewer-project-standards");
const IMPLEMENTER_TPL = loadTemplate("implementer");
const UI_CHECK_TPL = loadTemplate("ui-check");
const PARTITION_CHECK_TPL = loadTemplate("partition-check");
const ANCHOR_CONDENSER_TPL = loadTemplate("anchor-condenser");
const IMPLEMENTER_GATE_FAILURE_TPL = loadTemplate("implementer-gate-failure");
const IMPLEMENTER_REVIEWER_FEEDBACK_TPL = loadTemplate("implementer-reviewer-feedback");
const IMPLEMENTER_QUALITY_COMMITS_TPL = loadTemplate("implementer-quality-commits");
const IMPLEMENTER_ESCALATION_TPL = loadTemplate("implementer-escalation");
const IMPLEMENTER_SANDBOX_STACK_TPL = loadTemplate("implementer-sandbox-stack");
const IMPLEMENTER_SANDBOX_GATE_ACCESS_ISOLATED_TPL = loadTemplate(
  "implementer-sandbox-gate-access-isolated",
);
const IMPLEMENTER_SANDBOX_GATE_ACCESS_ATTACHED_TPL = loadTemplate(
  "implementer-sandbox-gate-access-attached",
);
const IMPLEMENTER_CHUNK_BASE_TPL = loadTemplate("implementer-chunk-base");
const IMPLEMENTER_STACK_FILE_TPL = loadTemplate("implementer-stack-file");
const IMPLEMENTER_SANDBOX_EGRESS_TPL = loadTemplate("implementer-sandbox-egress");
const REVIEWER_CHUNK_BASE_TPL = loadTemplate("reviewer-chunk-base");
const ADJUDICATOR_TPL = loadTemplate("adjudicator");

// Attempt at which the implementer prompt starts surfacing the escalation block.
const ESCALATION_ATTEMPT = 6;

// Ceiling on a single git read below. Generous because the thing it bounds is a
// potentially large git report. It is a transport limit, not the agent context
// budget (#158); prompt slots contain only commit lists and stats.
const GIT_READ_MAX_BUFFER = 50 * 1024 * 1024;

// Git otherwise formats --stat to an 80-column terminal and replaces leading
// path components with `...`. The stat is the issue-loop roles' complete file
// index (#158), so every path must remain exact. Repository paths are bounded
// far below this width by the filesystem; spelling both widths also keeps the
// allocation between filename and graph columns independent of ambient config.
const FULL_PATH_DIFF_STAT = "--stat=1000000,1000000";

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
// marker rather than thrown — a partial report the agent can read beats both a
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
    if (isErrno(err, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) {
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
  // Two sources here, and the issue anchor's third (`PromptAnchorOptions`),
  // because they answer three different questions.
  //
  // `repoDir` is the bare cache, where the `git log` runs (#38).
  //
  // `anchorCacheDir` is where the condenser's answers are cached (#217).
  //
  // The tree the emitted `@refs` will be RESOLVED against is deliberately NOT
  // a field here — it is `buildProjectAnchor`'s second argument, so that the
  // two prompt builders can DERIVE it from the worktree they are already
  // given rather than a caller having to remember to supply it. See there.
  readonly repoDir: string;
  readonly anchorCacheDir: string;
  readonly claudeMdPath: string;
  readonly contextMdPath?: string;
  readonly adrDir?: string;
  readonly sourceBranch: string;
};

// The issue anchor's sources. `issueSource` is the tracker (#34):
// `ghIssueSource` names the repository outright rather than letting `gh` infer
// it from a directory's remotes — see issue-anchor.ts. A replay hands its case
// file's issue instead (#195). `repo` is only the name a condensed thread's
// pointer quotes, never fetched from; `anchorCacheDir` holds the condenser's
// answers (#217).
export type IssueAnchorOptions = {
  readonly issueSource: IssueSource;
  readonly repo: RepoRef;
  readonly anchorCacheDir: string;
};

// The implementer's two anchors.
export type PromptAnchorOptions = ProjectAnchorOptions & IssueAnchorOptions;

export type PromptInputs = {
  readonly issue: { readonly id: string; readonly title: string; readonly branch: string };
  readonly attempt: number;
  readonly worktreePath: string;
  readonly lastFailureTrace: string;
  // What the branch was seeded from and what every range below is measured
  // against (#61). Replaces the `sourceBranch` this used to carry: that field's
  // only job was to build `origin/<sourceBranch>`, and re-deriving the anchor
  // here is what would show a chunk member its ancestors' work as its own.
  // Project history still comes from `ProjectAnchorOptions.sourceBranch`.
  readonly base: IssueBranchBase;
  readonly extraReprompt?: string;
  // The latest verifier rejection, as the state machine retains it.
  readonly latestReviewerFeedback?: string;
  // Commits the quality fixer made since this implementer's previous attempt,
  // oldest first, from the host's own collected range (#185) — never parsed
  // back out of commit authors.
  readonly qualityCommits?: readonly string[];
  // Host addition to this role's prompt. A path is probed in `worktreePath`,
  // because a branch may add the file it asks the implementer to follow.
  readonly promptExtension?: PromptExtension;
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
  // Whether the gate step containers contributed any env or mounts to this
  // sandbox (#166). Relevant only when sandboxStack makes the section visible.
  readonly sandboxHasGateAttachments?: boolean;
  // The gate stack file the branch may edit only the container env of (#186).
  // Absent for an inline stack, which no branch reaches.
  readonly stackFile?: string;
  // Whether this sandbox's egress allowlist refuses what it does not list
  // (#202). Report mode refuses nothing, so it says nothing.
  readonly egressEnforced?: boolean;
};

export type ReviewerPromptInputs = {
  readonly issue: { readonly id: string; readonly title: string; readonly branch: string };
  // The anchor layers' sources (#34, #38). `issueSource` is the tracker; `repoDir`
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
  readonly issueSource: IssueSource;
  readonly repo: RepoRef;
  readonly repoDir: string;
  readonly anchorCacheDir: string;
  readonly worktreePath: string;
  // The project history the anchor quotes, and the branch the review prose
  // tells the reviewer does not resolve locally. NOT the range's anchor since
  // #61 — that is `base`, which for a chunk member is the chunk tip.
  readonly sourceBranch: string;
  // What the branch was seeded from, and what the commit list and diff below
  // are measured against (#61). Same value the implementer was given.
  readonly base: IssueBranchBase;
  // This role's host addition (`promptExtensions.reviewer` for the verifier,
  // `promptExtensions.reviewerQuality` for the three quality roles).
  readonly promptExtension?: PromptExtension;
  readonly claudeMdPath: string;
  readonly contextMdPath?: string;
};

export type CorrectnessPromptInputs = ReviewerPromptInputs & {
  // Earlier white-box verdicts in this sandbox cycle (#88). A harness
  // failure adds no entry and consumes no round, so a retry reuses its number
  // and the history remains contiguous. The runner owns this history: it is
  // prompt material, not state-machine input.
  readonly priorRounds: readonly PriorReviewRound[];
  // What this round reads (verifier.ts `reviewScope`): the whole branch, or
  // the change since the last reviewed head (#180).
  readonly scope: ReviewScope;
};

// A quality report an adjudicator overruled, with its ruling (#187). The one
// piece of quality history a later lister is given, so an overruled finding
// does not come back.
export type QualityOverrule = {
  readonly round: number;
  readonly head: string;
  readonly report: string;
  readonly ruling: string;
};

// The quality pass's two read-only modes (#187). A lister reads its scope; a
// verify reads what changed since `anchor`, the head before the fixer, and
// judges the report the fixer was given.
export type QualityReviewMode =
  | {
      readonly kind: "list";
      readonly scope: ReviewScope;
      readonly overrules: readonly QualityOverrule[];
    }
  | {
      readonly kind: "verify";
      readonly anchor: string;
      readonly report: string;
    };

export type QualityReviewPromptInputs = ReviewerPromptInputs & {
  readonly mode: QualityReviewMode;
};

export type QualityFixPromptInputs = ReviewerPromptInputs & {
  // The latest CHANGES-REQUESTED quality report, and an upheld adjudication's
  // reasoning when the previous fixer disputed it (#187).
  readonly report: string;
  readonly ruling: string | null;
};

// An adjudicator OVERRULED ends the issue (#167, #185), so every recorded
// round still stands as the reviewer gave it.
export type PriorReviewRound = {
  readonly round: number;
  readonly head: string;
  readonly correctness: ParsedVerdict;
};

export async function buildPrompt(
  inputs: PromptInputs,
  anchor: PromptAnchorOptions,
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
    await buildIssueAnchor(inputs.issue.id, anchor),
    await buildAttemptSlot(inputs, anchor),
  ];
  return layers.join("\n\n---\n\n");
}

// One cold, pre-attempt classification (#126). It runs in the issue sandbox so
// repository paths named by the issue are readable, but only the issue anchor
// bears on the question. In particular, project standards and branch history
// are deliberately absent rather than optional slots callers could fill.
export async function buildUiCheckPrompt(
  issueId: string,
  anchor: IssueAnchorOptions,
): Promise<string> {
  return [await buildIssueAnchor(issueId, anchor), UI_CHECK_TPL].join("\n\n---\n\n");
}

// The independent fan-out classifier (#158). Like the UI check, it receives
// only the issue anchor and its own decision contract. The budget is a scale
// hint; the role never guesses a numeric diff size.
export async function buildPartitionCheckPrompt(
  issueId: string,
  anchor: IssueAnchorOptions,
  budgetChars: number,
): Promise<string> {
  return [
    await buildIssueAnchor(issueId, anchor),
    render(PARTITION_CHECK_TPL, { budgetChars: String(budgetChars) }),
  ].join("\n\n---\n\n");
}

// The thread condenser (#217): its contract, then the issue it classifies, as
// fetched for the anchor it would condense.
export function buildCondenserPrompt(issueId: string, issue: IssueJson): string {
  return [
    render(ANCHOR_CONDENSER_TPL, { count: String(issue.comments?.length ?? 0) }),
    renderCondenserInput(issueId, issue),
  ].join("\n\n---\n\n");
}

// The context budget covers what the provider receives plus the branch patch
// the role is explicitly told to read on demand (#158). This read is never
// rendered into a prompt. The transport ceiling merely ensures a pathological
// branch still returns an over-budget measurement instead of allocating
// without bound.
export async function measureNetDiffChars(
  worktreePath: string,
  baseRef: string,
): Promise<number> {
  return (await readGit(
    ["diff", `${baseRef}...HEAD`],
    worktreePath,
    `the net diff size anchored at ${baseRef}`,
  )).length;
}

export const contextChars = (prompt: string, netDiffChars: number): number =>
  prompt.length + netDiffChars;

export async function branchIsAheadOfSeed(
  worktreePath: string,
  baseRef: string,
): Promise<boolean> {
  return (await readGit(
    ["rev-list", "--count", `${baseRef}..HEAD`],
    worktreePath,
    `the commit count anchored at ${baseRef}`,
  )).trim() !== "0";
}

// The shared project and issue anchors of a cold branch-reading role, with
// the doc probes derived from the worktree that role reads (#34).
async function buildBranchRoleAnchors(
  inputs: ReviewerPromptInputs,
): Promise<readonly [string, string]> {
  return await Promise.all([
    buildProjectAnchor(
      {
        repoDir: inputs.repoDir,
        claudeMdPath: inputs.claudeMdPath,
        contextMdPath: inputs.contextMdPath,
        sourceBranch: inputs.sourceBranch,
      },
      inputs.worktreePath,
    ),
    buildIssueAnchor(inputs.issue.id, inputs),
  ]);
}

// The verifier's white-box review reads one immutable, gate-green branch
// snapshot: the head the quality fixer left (#185). From its second round on
// it is anchored at the last head an earlier round reviewed (#180).
export async function buildCorrectnessPrompt(
  inputs: CorrectnessPromptInputs,
): Promise<string> {
  const [[projectAnchor, issueAnchor], picture, changedSinceStat] = await Promise.all([
    buildBranchRoleAnchors(inputs),
    readBranchPicture(inputs, "the verifier's white-box review"),
    readChangedSinceStat(inputs, scopeAnchor(inputs.scope)),
  ]);
  return [
    projectAnchor,
    issueAnchor,
    renderReviewerSlot({
      ...inputs,
      ...picture,
      changedSinceStat,
      promptExtension: resolvePromptExtension(inputs.worktreePath, inputs.promptExtension),
    }),
  ].join("\n\n---\n\n");
}

// The sha a quality review's "changed since" stat is anchored at (#187): a
// lister's last approved quality head, a verify's head before the fixer.
// Null for a whole-branch lister.
export function qualityReviewAnchor(mode: QualityReviewMode): string | null {
  return mode.kind === "verify" ? mode.anchor : scopeAnchor(mode.scope);
}

const scopeAnchor = (scope: ReviewScope): string | null =>
  scope.kind === "since" ? scope.sha : null;

// `git diff --stat <anchor>..HEAD` for an anchored review; null for a
// whole-branch one.
async function readChangedSinceStat(
  inputs: ReviewerPromptInputs,
  anchor: string | null,
): Promise<string | null> {
  if (anchor === null) return null;
  return (await readGit(
    ["diff", FULL_PATH_DIFF_STAT, `${anchor}..HEAD`],
    inputs.worktreePath,
    `the diff stat since ${anchor} for ${inputs.issue.branch}`,
  )).trim();
}

// A quality lister or verify (#187): the whole-branch picture always, plus
// what changed since its anchor when it has one.
export async function buildQualityReviewPrompt(
  inputs: QualityReviewPromptInputs,
): Promise<string> {
  const [[projectAnchor, issueAnchor], picture, changedSinceStat] = await Promise.all([
    buildBranchRoleAnchors(inputs),
    readBranchPicture(inputs, `a quality ${inputs.mode.kind === "list" ? "lister" : "verify"}`),
    readChangedSinceStat(inputs, qualityReviewAnchor(inputs.mode)),
  ]);
  return [
    projectAnchor,
    issueAnchor,
    renderQualityReviewSlot({
      ...inputs,
      ...picture,
      changedSinceStat,
      promptExtension: resolvePromptExtension(inputs.worktreePath, inputs.promptExtension),
    }),
  ].join("\n\n---\n\n");
}

// The quality fixer (#185, #187): the whole-branch picture and the latest
// CHANGES-REQUESTED report as its checklist.
export async function buildQualityFixPrompt(
  inputs: QualityFixPromptInputs,
): Promise<string> {
  const [[projectAnchor, issueAnchor], picture] = await Promise.all([
    buildBranchRoleAnchors(inputs),
    readBranchPicture(inputs, "the quality fixer"),
  ]);
  return [
    projectAnchor,
    issueAnchor,
    renderQualityFixSlot({
      ...inputs,
      ...picture,
      promptExtension: resolvePromptExtension(inputs.worktreePath, inputs.promptExtension),
    }),
  ].join("\n\n---\n\n");
}

export type AdjudicatorPromptInputs = Omit<ReviewerPromptInputs, "promptExtension"> & {
  readonly pass: ReviewPass;
  readonly head: string;
  readonly report: string;
};

// A cold adjudicator gets the project and issue anchors plus exactly one
// rejected report. Prior-round history and implementer speech are absent by
// construction (#167), so neither can prime the independent reread.
export async function buildAdjudicatorPrompt(
  inputs: AdjudicatorPromptInputs,
): Promise<string> {
  const [projectAnchor, issueAnchor] = await buildBranchRoleAnchors(inputs);
  return [
    projectAnchor,
    issueAnchor,
    render(ADJUDICATOR_TPL, {
      pass: inputs.pass,
      head: inputs.head,
      branch: inputs.issue.branch,
      baseRef: inputs.base.ref,
      report: reportProse(inputs.report),
    }),
  ].join("\n\n---\n\n");
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
  opts: Omit<ProjectAnchorOptions, "anchorCacheDir">,
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
    const { stdout } = await exec(
      "git",
      ["log", `origin/${opts.sourceBranch}`, "-n", "10", "--format=%h %s"],
      { cwd: opts.repoDir },
    );
    lines.push(stdout.trim());
  } catch (err) {
    // A missing history ref is background context with an explicit unavailable
    // rendering. Other git and process failures are infrastructure faults.
    if (!isExitCode(err, 128)) throw err;
    lines.push("(unavailable)");
  }
  lines.push("```");
  // Every role that runs tools reads this layer (#189): a background task left
  // running keeps the agent CLI alive after its final answer.
  lines.push("", BACKGROUND_TASKS);
  return lines.join("\n");
}

async function buildIssueAnchor(
  issueId: string,
  anchor: IssueAnchorOptions,
): Promise<string> {
  return `# Issue anchor\n\n${await fetchIssueText(
    issueId,
    anchor.issueSource,
    anchor.repo,
    anchor.anchorCacheDir,
  )}`;
}

async function buildAttemptSlot(
  inputs: PromptInputs,
  anchor: ProjectAnchorOptions,
): Promise<string> {
  const { worktreePath, base } = inputs;

  // Empty is a legitimate answer HERE and only here: attempt 1 has no commits.
  // Which is exactly why the read must not be able to fail quietly — the one
  // slot whose emptiness is unremarkable is the one that hid #40.
  const qualityCommits = inputs.qualityCommits ?? [];
  const [commits, stat, qualityCommitLog] = await Promise.all([
    readGit(
      ["log", "--reverse", "--oneline", `${base.ref}..HEAD`],
      worktreePath,
      `the commit list for ${inputs.issue.branch}, anchored at ${base.ref}`,
    ),
    readGit(
      ["diff", FULL_PATH_DIFF_STAT, `${base.ref}...HEAD`],
      worktreePath,
      `the branch diff stat for ${inputs.issue.branch}, anchored at ${base.ref}`,
    ),
    qualityCommits.length === 0
      ? Promise.resolve("")
      : readGit(
          ["log", "--no-walk=unsorted", "--oneline", ...qualityCommits],
          worktreePath,
          `the quality pass's commits on ${inputs.issue.branch}`,
        ),
  ]);

  const promptExtension = resolvePromptExtension(
    worktreePath,
    inputs.promptExtension,
  );

  return renderAttemptSlot({
    ...inputs,
    promptExtension,
    claudeMdPath: anchor.claudeMdPath,
    ...(anchor.contextMdPath ? { contextMdPath: anchor.contextMdPath } : {}),
    commits: commits.trim(),
    stat: stat.trim(),
    qualityCommitLog: qualityCommitLog.trim(),
  });
}

// Pure renderer for the implementer slot, separated from the git I/O above so
// the prompt's shape is table-testable. Optional sections collapse to "" when
// their input is absent; `section()` supplies the trailing blank line.
export type AttemptSlotRender = Omit<PromptInputs, "qualityCommits"> & {
  readonly claudeMdPath: string;
  readonly contextMdPath?: string;
  readonly commits: string;
  readonly stat: string;
  // `git log --oneline` of `PromptInputs.qualityCommits`; "" when the quality
  // fixer committed nothing since the previous attempt.
  readonly qualityCommitLog: string;
};

export function renderAttemptSlot(inputs: AttemptSlotRender): string {
  const {
    issue,
    attempt,
    base,
    lastFailureTrace,
    extraReprompt,
    latestReviewerFeedback,
    commits,
    stat,
    qualityCommitLog,
  } = inputs;

  const workDone = commits
    ? `## Work done so far\n\n### Commits\n\n\`\`\`\n${commits}\n\`\`\`\n\n` +
      `### Diff stat\n\n\`\`\`\n${stat || "(empty)"}\n\`\`\`\n\n` +
      `Inspect the changes in the worktree. Run \`git diff ${base.ref}...HEAD\` ` +
      "to read the full patch, and open every relevant file on demand."
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

  const qualityCommitsSection = qualityCommitLog
    ? render(IMPLEMENTER_QUALITY_COMMITS_TPL, { commits: qualityCommitLog })
    : "";

  const reviewerFeedback = latestReviewerFeedback
    ? render(IMPLEMENTER_REVIEWER_FEEDBACK_TPL, { prose: latestReviewerFeedback })
    : "";

  const sandboxStack = renderSandboxStackSlot(
    inputs.sandboxStack ?? [],
    inputs.sandboxHasGateAttachments ?? false,
  );

  const stackFile = inputs.stackFile === undefined
    ? ""
    : render(IMPLEMENTER_STACK_FILE_TPL, { path: inputs.stackFile });

  const orchestratorNote = extraReprompt
    ? `## Orchestrator note\n\n${extraReprompt}`
    : "";

  const escalation =
    attempt >= ESCALATION_ATTEMPT
      ? render(IMPLEMENTER_ESCALATION_TPL, {
          attempt: String(attempt),
        })
      : "";

  return render(IMPLEMENTER_TPL, {
    attempt: String(attempt),
    issueId: issue.id,
    issueTitle: issue.title,
    branch: issue.branch,
    chunkBase: section(chunkBase),
    workDone: section(workDone),
    qualityCommits: section(qualityCommitsSection),
    sandboxStack: section(sandboxStack),
    stackFile: section(stackFile),
    egress: section(inputs.egressEnforced === true ? IMPLEMENTER_SANDBOX_EGRESS_TPL : ""),
    gateFailure: section(gateFailure),
    reviewerFeedback: section(reviewerFeedback),
    orchestratorNote: section(orchestratorNote),
    escalation: section(escalation),
    codingStandards: CODING_STANDARDS,
    projectStandards: promptExtensionSlot(inputs.promptExtension),
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
  hasGateAttachments = false,
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
    gateAccess: hasGateAttachments
      ? IMPLEMENTER_SANDBOX_GATE_ACCESS_ATTACHED_TPL
      : IMPLEMENTER_SANDBOX_GATE_ACCESS_ISOLATED_TPL,
  });
}

// The commit list and diff stat every branch-reading role is handed (#158).
async function readBranchPicture(
  inputs: ReviewerPromptInputs,
  role: string,
): Promise<{ readonly commits: string; readonly stat: string }> {
  const { worktreePath } = inputs;
  const base = inputs.base.ref;

  const commits = (
    await readGit(
      ["log", `${base}..HEAD`, "--oneline"],
      worktreePath,
      `the commit list for ${inputs.issue.branch}, anchored at ${base}`,
    )
  ).trim();

  // An empty changeset is never a legitimate prompt for these roles (#40).
  // Both are reached only through a COMPLETE that `parsePromise` did not
  // downgrade — which requires accumulated commits — over a clean tree whose
  // HEAD is still `refs/heads/<branch>`. So an empty list is not "nothing to
  // review"; it is this module and the inner loop disagreeing about what the
  // branch holds, and the only thing an agent can do with it is act uninformed
  // by any code. Refusing is what catches the next wrong base ref even if it
  // is wrong for a reason `origin/` does not cover — the check that would have
  // caught #40 on cycle 1 rather than after 25 minutes of agent time spent
  // reviewing nothing.
  if (commits === "") {
    throw new SandbarError(
      `refusing to launch ${role} for issue #${inputs.issue.id}: ` +
        `\`${base}..HEAD\` is empty in ${worktreePath}, but it only runs on ` +
        `committed work the implementer reported COMPLETE. The branch's commits and ` +
        `the range used to render them disagree.`,
    );
  }

  const stat = (
    await readGit(
      ["diff", FULL_PATH_DIFF_STAT, `${base}...HEAD`],
      worktreePath,
      `the branch diff stat for ${inputs.issue.branch}, anchored at ${base}`,
    )
  ).trim();

  return { commits, stat };
}

// Pure renderers for the branch-reading slots. Extracted so tests can pin
// each prompt's shape without mocking git. Each invocation stays cold across
// rounds; the white-box reviewer is handed its earlier rounds' decisions as
// explicit prompt data (#88), which preserves fresh investigation without
// reviewer amnesia, and a quality lister only the overruled quality reports
// (#187).
type BranchSlotRender = Omit<ReviewerPromptInputs, "issueSource" | "repo" | "repoDir" | "worktreePath"> & {
  readonly commits: string;
  readonly stat: string;
};

export type ReviewerSlotRender = BranchSlotRender & {
  readonly priorRounds: readonly PriorReviewRound[];
  readonly scope: ReviewScope;
  // As for a quality review, anchored at the scope's head.
  readonly changedSinceStat: string | null;
};

export type QualityReviewSlotRender = BranchSlotRender & {
  readonly mode: QualityReviewMode;
  // `git diff --stat <anchor>..HEAD`; null exactly when the mode has no
  // anchor (`qualityReviewAnchor`). "" means git said nothing changed, never
  // that nothing was read (#40).
  readonly changedSinceStat: string | null;
};

// The "changed since" section of an anchored review; "" for a whole-branch one.
function renderChangedSince(anchor: string | null, stat: string | null): string {
  if ((anchor === null) !== (stat === null)) {
    throw new Error(
      "review prompt: the changed-since stat must be supplied exactly " +
        "when the review is anchored at a head",
    );
  }
  if (anchor === null) return "";
  return `## Changed since \`${anchor}\`\n\n` +
    (stat ? `\`\`\`\n${stat}\n\`\`\`` : `(empty — no changes since \`${anchor}\`)`);
}

export type QualityFixSlotRender = BranchSlotRender & {
  readonly report: string;
  readonly ruling: string | null;
};

export function renderReviewerSlot(inputs: ReviewerSlotRender): string {
  const priorRounds = inputs.priorRounds.length === 0
    ? ""
    : render(REVIEWER_PRIOR_ROUNDS_TPL, {
        addressed: section(REVIEWER_PRIOR_ROUNDS_ADDRESSED_TPL),
        rounds: inputs.priorRounds.map(renderPriorReviewRound).join("\n\n"),
      });
  const anchor = scopeAnchor(inputs.scope);
  return render(REVIEWER_TPL, {
    ...branchSlotVars(inputs),
    changedSince: section(renderChangedSince(anchor, inputs.changedSinceStat)),
    priorRounds: section(priorRounds),
    reviewSurface: anchor === null
      ? render(REVIEWER_FULL_TPL, { baseRef: inputs.base.ref })
      : render(REVIEWER_SINCE_TPL, { anchor }),
    historyScope: anchor === null
      ? REVIEWER_FULL_HISTORY_TPL
      : render(REVIEWER_SINCE_HISTORY_TPL, { anchor }),
  });
}

// A whole-branch lister gets the exhaustive listing text; a scoped lister the
// same text aimed at what changed since the last approved quality head, plus
// the overrule history; a verify the report under check (#187).
export function renderQualityReviewSlot(inputs: QualityReviewSlotRender): string {
  const { mode } = inputs;
  const anchor = qualityReviewAnchor(mode);
  const changedSince = renderChangedSince(anchor, inputs.changedSinceStat);
  const qualityMode = mode.kind === "verify"
    ? render(REVIEWER_QUALITY_VERIFY_TPL, {
        anchor: mode.anchor,
        report: reportProse(mode.report),
      })
    : anchor === null
      ? REVIEWER_QUALITY_LISTING_TPL
      : render(REVIEWER_QUALITY_LISTING_SINCE_TPL, { anchor });
  const priorRounds = mode.kind === "verify" || mode.overrules.length === 0
    ? ""
    : render(REVIEWER_PRIOR_ROUNDS_TPL, {
        addressed: "",
        rounds: mode.overrules.map(renderQualityOverrule).join("\n\n"),
      }) + `\n\n${REVIEWER_QUALITY_OVERRULES_TPL}`;
  return render(REVIEWER_QUALITY_TPL, {
    ...branchSlotVars(inputs),
    priorRounds: section(priorRounds),
    changedSince: section(changedSince),
    qualityMode: section(qualityMode),
  });
}

export function renderQualityFixSlot(inputs: QualityFixSlotRender): string {
  return render(QUALITY_FIXER_TPL, {
    ...branchSlotVars(inputs),
    report: reportProse(inputs.report),
    ruling: inputs.ruling === null
      ? ""
      : section(render(QUALITY_FIXER_RULING_TPL, { reasoning: inputs.ruling })),
  });
}

// A report quoted to another role, without the verdict token that ended it.
function reportProse(report: string): string {
  return stripVerdictTokens(report).trim() || "(no report prose)";
}

function renderQualityOverrule(overrule: QualityOverrule): string {
  return `### Round ${overrule.round} — head=${overrule.head}\n` +
    `quality: OVERRULED\n${reportProse(overrule.report)}\n\n` +
    `Adjudicator's ruling:\n${overrule.ruling}`;
}

function branchSlotVars(inputs: BranchSlotRender): Record<string, string> {
  const { issue, base, sourceBranch, promptExtension, claudeMdPath, contextMdPath, commits, stat } =
    inputs;

  // Same slot as the implementer's, aimed at the other half of the mistake: an
  // uninformed reader would go looking for the chunk's earlier work in this
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
  // chunk tip, and calling it the source branch would tell the reader its
  // emptiness was measured against a tree the branch was never cut from.
  const diffStatBlock = stat
    ? `## Branch diff stat\n\n\`\`\`\n${stat}\n\`\`\`\n\n` +
      `Read the full patch with \`git diff ${base.ref}...HEAD\` and inspect files in the worktree.`
    : `## Branch diff stat\n\n(empty — no changes against \`${base.ref}\`)`;

  return {
    branch: issue.branch,
    baseRef: base.ref,
    sourceBranch,
    chunkBase: section(chunkBase),
    issueId: issue.id,
    issueTitle: issue.title,
    commits: section(commitsBlock),
    diffStat: section(diffStatBlock),
    codingStandards: CODING_STANDARDS,
    projectStandards: promptExtensionSlot(promptExtension),
    conventionsRef: conventionsRef(claudeMdPath, contextMdPath),
  };
}

function renderPriorReviewRound(round: PriorReviewRound): string {
  const findings = stripVerdictTokens(round.correctness.prose).trim();
  return `### Round ${round.round} — head=${round.head}\n` +
    `correctness: ${round.correctness.verdict}${findings ? `\n${findings}` : ""}`;
}

// One spelling shared by both roles: the conventions are the same documents,
// even though each prompt tells its agent when and how to consult them (#78).
function conventionsRef(claudeMdPath: string, contextMdPath?: string): string {
  return contextMdPath
    ? `@${claudeMdPath} (and @${contextMdPath} if it exists)`
    : `@${claudeMdPath}`;
}

// Only emit a path extension when the agent can resolve it in its worktree.
// Text was fixed when config loaded and always survives unchanged (#34, #91).
export function resolvePromptExtension(
  worktreePath: string,
  configured?: PromptExtension,
): PromptExtension | undefined {
  if (!configured || "text" in configured) return configured;
  return existsSync(resolve(worktreePath, configured.path)) ? configured : undefined;
}

export function promptExtensionSlot(extension?: PromptExtension): string {
  return section(
    extension
      ? "path" in extension
        ? render(REVIEWER_PROJECT_STANDARDS_TPL, {
            promptExtensionPath: extension.path,
          })
        : `### Project prompt extension\n\n${extension.text}`
      : "",
  );
}
