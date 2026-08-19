// Pre-flight invariants for sandbar runs.
//
// Runs UNDER the single-instance lock (#32), and must keep doing so. This
// module is not read-only: it fetches, and `deleteMergedIssueBranches` runs
// `git branch -D` over every `sandbar/issue-*` branch it finds merged. It used
// to run before the lock was taken, which made the one destructive step in
// startup the one step the lock did not cover — two launches on the same
// workdir both reached it, and the loser was not turned away until afterwards.
// (Note the branch CLASSIFICATION below is not part of that argument: a
// concurrent run's in-flight branches map to issues that are still open and
// still `ready-for-agent` — the label flips happen in Phase 4 — so they read as
// `resumable`, not as a spurious `unmerged` refusal.)
//
// Every shell-out here names the repo explicitly (#34). See `runOk` below for
// why the `cwd` parameter is required rather than optional.
//
// Two layers:
//   - checkInvariants(state)  — pure function over a captured RepoState.
//                               Unit-tested with hand-built fixtures.
//   - gatherState() / runPreflight() — I/O wrappers that shell out to git/gh.
//
// Leftover `sandbar/issue-*` branches are classified three ways (#13):
//   - resumable — the branch maps to a still-open `ready-for-agent` issue, i.e.
//                 stranded work from an interrupted run (killed after the issue
//                 agents finished but before/inside the merger). NOT an error:
//                 the planner re-picks the issue and the inner loop continues
//                 from the branch's existing commits (ensureIssueBranch keeps
//                 them), so a killed run just restarts and finishes.
//   - discarded — the branch's upstream is `[gone]` (PR merged+deleted upstream
//                 while local is behind). Local commits would be orphaned.
//   - unmerged  — everything else: maps to a closed/unknown issue, or an open
//                 issue no longer queued. Stays a hard error as before.

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { makeEnvReader } from "./env.js";
import { worktreePathFor } from "./finalize.js";
import { ALL_BRANCH_PREFIXES, issueNumberFromBranch } from "./naming.js";
import { RUNTIME } from "./runtime.js";
import { fetchCandidates } from "./plan-resolver.js";

const exec = promisify(execFile);

export type PreflightConfig = {
  readonly cwd: string;
  readonly workDir: string;
  readonly envFilePath: string;
  readonly sourceBranch: string;
  // Every image the gate stack references that sandbar does NOT build itself
  // (#24 D7). Preflight verifies each is already pulled and REFUSES rather than
  // pulling: a run must not do silent network work at startup, and a missing
  // image discovered mid-cycle fails a container bringup that then has to be
  // triaged as infra-or-branch.
  readonly pulledImages: readonly string[];
};

export type SandbarBranch = {
  readonly name: string;
  readonly mergedIntoMain: boolean;
};

export type RepoState = {
  readonly hasGit: boolean;
  readonly hasGh: boolean;
  readonly hasContainerRuntime: boolean;
  // Referenced-but-not-built images absent from the local store.
  readonly missingImages: readonly string[];
  readonly ghAuthOk: boolean;
  readonly sandboxGhTokenOk: boolean;
  readonly hasAgentCredential: boolean;
  readonly inProgressMarkers: readonly string[];
  readonly currentBranch: string | null;
  readonly expectedBranch: string;
  readonly hasOriginBranch: boolean;
  readonly envFilePath: string;
  readonly unmergedIssueBranches: readonly string[];
  readonly discardedIssueBranches: readonly string[];
  // Stranded branches that map to a still-open `ready-for-agent` issue — not a
  // failure (resumed, not refused). Carried on the state purely so runPreflight
  // can announce them; checkInvariants emits no Invariant for them.
  readonly resumableIssueBranches: readonly string[];
};

export type Invariant = { ok: true } | { ok: false; message: string };

export function checkInvariants(s: RepoState): readonly Invariant[] {
  const out: Invariant[] = [];

  if (!s.hasGit) out.push({ ok: false, message: "`git` is not on PATH." });
  if (!s.hasGh) {
    out.push({ ok: false, message: "`gh` is not on PATH. Install GitHub CLI." });
  }
  if (!s.hasContainerRuntime) {
    out.push({
      ok: false,
      message: `\`${RUNTIME}\` is not on PATH. Sandbar uses ${RUNTIME} for the agent sandbox and the gate stack. Install it.`,
    });
  }
  if (s.missingImages.length > 0) {
    const list = s.missingImages
      .map((i) => `  ${RUNTIME} pull ${i}`)
      .join("\n");
    out.push({
      ok: false,
      message:
        `${s.missingImages.length} gate-stack image(s) referenced by ` +
        `config.gateStack are missing in ${RUNTIME}. Sandbar builds only what ` +
        `config.images lists and refuses to pull the rest, so pull them:\n${list}`,
    });
  }
  if (!s.ghAuthOk) {
    out.push({
      ok: false,
      message: "`gh auth status` failed. Run `gh auth login` and retry.",
    });
  }
  if (!s.sandboxGhTokenOk) {
    out.push({
      ok: false,
      message:
        `GH_TOKEN in ${s.envFilePath} is missing, empty, or rejected by GitHub. ` +
        "The agent's sandbox uses this token (no hosts.yml is mounted), so it must be a valid " +
        `fine-grained PAT with the scopes documented in the .env.example. ` +
        `Regenerate at https://github.com/settings/personal-access-tokens and update ${s.envFilePath}.`,
    });
  }
  if (!s.hasAgentCredential) {
    out.push({
      ok: false,
      message:
        `No agent credential in ${s.envFilePath}. Set one of:\n` +
        "  - CLAUDE_CODE_OAUTH_TOKEN  (Pro/Max/Team/Enterprise subscription; generate with `claude setup-token`)\n" +
        "  - ANTHROPIC_API_KEY        (pay-as-you-go API; takes precedence if both are set)",
    });
  }
  if (s.inProgressMarkers.length > 0) {
    out.push({
      ok: false,
      message: `In-progress git operation detected: ${s.inProgressMarkers.join(
        ", ",
      )}. Resolve before launching sandbar.`,
    });
  }
  if (s.currentBranch !== s.expectedBranch) {
    out.push({
      ok: false,
      message: `Not on \`${s.expectedBranch}\` (current branch: ${
        s.currentBranch ?? "unknown"
      }). Switch to ${s.expectedBranch} with \`git switch ${s.expectedBranch}\`.`,
    });
  }
  if (!s.hasOriginBranch) {
    out.push({
      ok: false,
      message:
        `\`origin/${s.expectedBranch}\` does not exist after fetch. Configure the \`origin\` remote.`,
    });
  }
  if (s.unmergedIssueBranches.length > 0) {
    const list = s.unmergedIssueBranches.map((b) => `  - ${b}`).join("\n");
    out.push({
      ok: false,
      message:
        `Unmerged \`sandbar/issue-*\` branches found:\n${list}\n` +
        "Merge them, push them for review, or delete with `git branch -D <name>`.",
    });
  }
  if (s.discardedIssueBranches.length > 0) {
    const list = s.discardedIssueBranches
      .map((b) => `  - ${b}`)
      .join("\n");
    out.push({
      ok: false,
      message:
        `Discarded \`sandbar/issue-*\` branches (remote deleted, local commits would be lost):\n${list}\n` +
        "Confirm the loss with `git branch -D <name>`.",
    });
  }

  if (out.length === 0) out.push({ ok: true });
  return out;
}

function which(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// `cwd` is REQUIRED and first, not an optional trailing option (#34). Every
// command this module runs — the fetch, the `git branch -D`, the worktree
// removals, the classification's for-each-ref/merge-base — is a statement
// about, or a mutation of, the repo the run is about. Left to inherit
// `process.cwd()` they described whichever directory the host process happened
// to be launched from, which coincides with `config.cwd` only because
// `DEFAULT_CWD()` is `process.cwd()`. A host that sets `config.cwd` — which the
// config explicitly supports — got a preflight that inspected and DELETED
// branches in one repo while the run's lock, worktrees, scope and merges
// belonged to another. That also quietly qualified #32: the destructive delete
// was under *a* lock, just not the one covering the repo it deleted from.
//
// Making the parameter required rather than optional is the whole point. An
// omitted `{ cwd }` is invisible at the call site and fails only on the hosts
// that configure a cwd, i.e. never in the author's own checkout; a missing
// positional argument is a type error.
async function runOk(
  cwd: string,
  file: string,
  args: readonly string[],
): Promise<boolean> {
  try {
    await exec(file, [...args], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function captureOk(
  cwd: string,
  file: string,
  args: readonly string[],
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await exec(file, [...args], { cwd });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function inProgressMarkers(gitDir: string): readonly string[] {
  const candidates = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
  ];
  return candidates.filter((m) => existsSync(`${gitDir}/${m}`));
}

export async function gatherState(cfg: PreflightConfig): Promise<RepoState> {
  const env = makeEnvReader(cfg.envFilePath);
  const hasGit = which("git");
  const hasGh = which("gh");
  const hasContainerRuntime = which(RUNTIME);

  const missingImages: string[] = [];
  if (hasContainerRuntime) {
    for (const image of cfg.pulledImages) {
      if (!(await runOk(cfg.cwd, RUNTIME, ["image", "exists", image]))) {
        missingImages.push(image);
      }
    }
  }

  const ghAuthOk = hasGh ? await runOk(cfg.cwd, "gh", ["auth", "status"]) : false;
  const sandboxGhTokenOk = hasGh
    ? await checkSandboxGhToken(cfg.cwd, env)
    : false;
  const hasAgentCredential =
    !!env("CLAUDE_CODE_OAUTH_TOKEN") || !!env("ANTHROPIC_API_KEY");

  // `--git-dir` prints a path relative to the command's cwd for the ordinary
  // case (`.git`), so the marker probe has to resolve it against that same cwd
  // — reading `.git/MERGE_HEAD` from `process.cwd()` is the very confusion this
  // parameter exists to end.
  const gitDir = (
    await captureOk(cfg.cwd, "git", ["rev-parse", "--git-dir"])
  ).stdout.trim();

  const branchRes = await captureOk(cfg.cwd, "git", [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  const currentBranch = branchRes.ok ? branchRes.stdout.trim() : null;

  const hasOriginBranch = await runOk(cfg.cwd, "git", [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${cfg.sourceBranch}`,
  ]);

  const openReadyIssues = await fetchOpenReadyIssueNumbers(cfg.cwd);
  const { unmerged, discarded, resumable } = await classifyIssueBranches(
    cfg.cwd,
    openReadyIssues,
  );

  return {
    hasGit,
    hasGh,
    hasContainerRuntime,
    missingImages,
    ghAuthOk,
    sandboxGhTokenOk,
    hasAgentCredential,
    inProgressMarkers: gitDir ? inProgressMarkers(resolve(cfg.cwd, gitDir)) : [],
    currentBranch,
    expectedBranch: cfg.sourceBranch,
    hasOriginBranch,
    envFilePath: cfg.envFilePath,
    unmergedIssueBranches: unmerged,
    discardedIssueBranches: discarded,
    resumableIssueBranches: resumable,
  };
}

// The set of issue numbers currently in the planner queue (open +
// `ready-for-agent`). Reuses the planner's own candidate query so the resume
// classification can never desync from what the next cycle actually picks up.
// Fail-closed to an empty set: a gh hiccup just means no branch is treated as
// resumable (they fall back to the existing hard error), and the ghAuthOk /
// sandboxGhTokenOk invariants report the real problem.
async function fetchOpenReadyIssueNumbers(
  cwd: string,
): Promise<ReadonlySet<number>> {
  try {
    const candidates = await fetchCandidates(cwd);
    return new Set(candidates.map((c) => c.number));
  } catch {
    return new Set();
  }
}

async function checkSandboxGhToken(
  cwd: string,
  env: (key: string) => string | undefined,
): Promise<boolean> {
  const token = env("GH_TOKEN");
  if (!token) return false;
  try {
    await exec("gh", ["api", "user", "--silent"], {
      cwd,
      env: { ...process.env, GH_TOKEN: token, GH_HOST: "github.com" },
    });
    return true;
  } catch {
    return false;
  }
}

// Glob patterns for every recognized issue-branch prefix (current + legacy).
const ISSUE_BRANCH_REFGLOBS = ALL_BRANCH_PREFIXES.map(
  (p) => `refs/heads/${p}issue-*`,
);

async function listIssueBranches(cwd: string): Promise<readonly string[]> {
  const { ok, stdout } = await captureOk(cwd, "git", [
    "for-each-ref",
    "--format=%(refname:short)",
    ...ISSUE_BRANCH_REFGLOBS,
  ]);
  if (!ok) return [];
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function isBranchMerged(
  cwd: string,
  branch: string,
  sourceBranch: string,
): Promise<boolean> {
  // A branch counts as merged if its tip is reachable from local sourceBranch
  // OR origin/sourceBranch. The origin check covers PRs that landed upstream
  // while local is behind.
  const onLocal = await runOk(cwd, "git", [
    "merge-base",
    "--is-ancestor",
    branch,
    sourceBranch,
  ]);
  if (onLocal) return true;
  return runOk(cwd, "git", [
    "merge-base",
    "--is-ancestor",
    branch,
    `refs/remotes/origin/${sourceBranch}`,
  ]);
}

async function branchUpstreamTracks(
  cwd: string,
): Promise<ReadonlyMap<string, string>> {
  const { ok, stdout } = await captureOk(cwd, "git", [
    "for-each-ref",
    "--format=%(refname:short)\t%(upstream:track)",
    ...ISSUE_BRANCH_REFGLOBS,
  ]);
  const out = new Map<string, string>();
  if (!ok) return out;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [name = "", track = ""] = trimmed.split("\t");
    if (!name) continue;
    out.set(name, track);
  }
  return out;
}

async function classifyIssueBranches(
  cwd: string,
  openReadyIssues: ReadonlySet<number>,
): Promise<{
  unmerged: readonly string[];
  discarded: readonly string[];
  resumable: readonly string[];
}> {
  const all = await listIssueBranches(cwd);
  const tracks = await branchUpstreamTracks(cwd);
  const unmerged: string[] = [];
  const discarded: string[] = [];
  const resumable: string[] = [];
  for (const branch of all) {
    // `[gone]` = the branch had an upstream and the remote deleted it (PR
    // closed/merged-and-deleted). If the work isn't on the source branch
    // either, the local commits are about to be orphaned — surface them
    // separately from genuinely-in-flight work so the user knows the loss
    // is intentional. (Resume branches are seeded `--no-track`, so they never
    // carry an upstream and can't land here.)
    if (tracks.get(branch) === "[gone]") {
      discarded.push(branch);
      continue;
    }
    // Stranded work from an interrupted run: the branch belongs to an issue the
    // planner is still queued to work. Resume it rather than refusing to start
    // (#13) — the next cycle re-picks the issue and the inner loop continues
    // from this branch's accumulated commits.
    const issueNum = issueNumberFromBranch(branch);
    if (issueNum !== null && openReadyIssues.has(issueNum)) {
      resumable.push(branch);
    } else {
      unmerged.push(branch);
    }
  }
  return { unmerged, discarded, resumable };
}

export async function deleteMergedIssueBranches(
  cfg: { cwd: string; workDir: string; sourceBranch: string },
): Promise<readonly string[]> {
  const all = await listIssueBranches(cfg.cwd);
  const deleted: string[] = [];
  for (const branch of all) {
    if (!(await isBranchMerged(cfg.cwd, branch, cfg.sourceBranch))) continue;
    // A leftover worktree (from a crash or a non-merged terminal whose
    // finalize ran before the corresponding fix landed) holds the branch and
    // makes `git branch -D` fail. Remove it best-effort first.
    await runOk(cfg.cwd, "git", [
      "worktree",
      "remove",
      "--force",
      worktreePathFor(cfg.cwd, cfg.workDir, branch),
    ]);
    await runOk(cfg.cwd, "git", ["worktree", "prune"]);
    // Use -D rather than -d: when the branch is merged only into
    // origin/sourceBranch (not local), git's safety check refuses -d even
    // though the commits are demonstrably preserved on a remote ref.
    const ok = await runOk(cfg.cwd, "git", ["branch", "-D", branch]);
    if (ok) deleted.push(branch);
  }
  return deleted;
}

export class PreflightError extends Error {
  readonly failures: readonly string[];
  constructor(failures: readonly string[]) {
    super(`Pre-flight checks failed:\n\n${failures.join("\n\n")}`);
    this.name = "PreflightError";
    this.failures = failures;
  }
}

export async function runPreflight(cfg: PreflightConfig): Promise<void> {
  // Fetch before the cleanup pass so that merged-on-origin branches can be
  // reaped even when the user hasn't pulled local sourceBranch recently.
  await runOk(cfg.cwd, "git", ["fetch", "origin", cfg.sourceBranch, "--quiet"]);

  const deleted = await deleteMergedIssueBranches({
    cwd: cfg.cwd,
    workDir: cfg.workDir,
    sourceBranch: cfg.sourceBranch,
  });
  if (deleted.length > 0) {
    console.log(`Cleaned up merged issue branches: ${deleted.join(", ")}`);
  }
  const state = await gatherState(cfg);
  if (state.resumableIssueBranches.length > 0) {
    console.log(
      `Resuming ${state.resumableIssueBranches.length} stranded issue ` +
        `branch(es) from an interrupted run: ` +
        `${state.resumableIssueBranches.join(", ")}. The planner will re-pick ` +
        "the matching open `ready-for-agent` issue(s) and the inner loop " +
        "continues from each branch's existing commits.",
    );
  }
  const results = checkInvariants(state);
  const failures = results.flatMap((r) => (r.ok ? [] : [r.message]));
  if (failures.length > 0) throw new PreflightError(failures);

  // Soft warning: per-issue worktrees seed off origin/sourceBranch. If local
  // is ahead of origin, those issues won't see that work — the merge into
  // local carries it forward but issues that depend on it can fail.
  const ahead = await countCommitsAhead(
    cfg.cwd,
    cfg.sourceBranch,
    `origin/${cfg.sourceBranch}`,
  );
  if (ahead > 0) {
    console.warn(
      `WARNING: local ${cfg.sourceBranch} is ${ahead} commit(s) ahead of origin/${cfg.sourceBranch}. ` +
        "Per-issue worktrees seed from origin, so issues that depend on " +
        "unpushed work will fail or merge oddly. Push or rebase first if " +
        "those commits matter for the work sandbar is about to do.",
    );
  }
}

async function countCommitsAhead(
  cwd: string,
  local: string,
  remote: string,
): Promise<number> {
  const { ok, stdout } = await captureOk(cwd, "git", [
    "rev-list",
    "--count",
    `${remote}..${local}`,
  ]);
  if (!ok) return 0;
  const n = parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}
