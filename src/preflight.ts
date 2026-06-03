// Pre-flight invariants for sandbar runs.
//
// Two layers:
//   - checkInvariants(state)  — pure function over a captured RepoState.
//                               Unit-tested with hand-built fixtures.
//   - gatherState() / runPreflight() — I/O wrappers that shell out to git/gh.

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { makeEnvReader } from "./env.js";
import { worktreePathFor } from "./finalize.js";
import { ALL_BRANCH_PREFIXES } from "./naming.js";
import { PG_IMAGE, RUNTIME as SIDECAR_RUNTIME } from "./pg-sidecar.js";

const exec = promisify(execFile);

export type PreflightConfig = {
  readonly cwd: string;
  readonly workDir: string;
  readonly envFilePath: string;
  readonly sourceBranch: string;
};

export type SandbarBranch = {
  readonly name: string;
  readonly mergedIntoMain: boolean;
};

export type RepoState = {
  readonly hasGit: boolean;
  readonly hasGh: boolean;
  readonly hasContainerRuntime: boolean;
  readonly hasPgImage: boolean;
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
      message: `\`${SIDECAR_RUNTIME}\` is not on PATH. Sandbar uses ${SIDECAR_RUNTIME} for the agent sandbox, gate runner, and pg sidecar. Install it.`,
    });
  }
  if (!s.hasPgImage) {
    out.push({
      ok: false,
      message:
        `Postgres image \`${PG_IMAGE}\` is missing in ${SIDECAR_RUNTIME}. ` +
        `Pull it with \`${SIDECAR_RUNTIME} pull ${PG_IMAGE}\`.`,
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

async function runOk(file: string, args: readonly string[]): Promise<boolean> {
  try {
    await exec(file, [...args]);
    return true;
  } catch {
    return false;
  }
}

async function captureOk(
  file: string,
  args: readonly string[],
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await exec(file, [...args]);
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
  const hasContainerRuntime = which(SIDECAR_RUNTIME);

  const hasPgImage = hasContainerRuntime
    ? await runOk(SIDECAR_RUNTIME, ["image", "exists", PG_IMAGE])
    : false;

  const ghAuthOk = hasGh ? await runOk("gh", ["auth", "status"]) : false;
  const sandboxGhTokenOk = hasGh ? await checkSandboxGhToken(env) : false;
  const hasAgentCredential =
    !!env("CLAUDE_CODE_OAUTH_TOKEN") || !!env("ANTHROPIC_API_KEY");

  const gitDir = (
    await captureOk("git", ["rev-parse", "--git-dir"])
  ).stdout.trim();

  const branchRes = await captureOk("git", [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  const currentBranch = branchRes.ok ? branchRes.stdout.trim() : null;

  const hasOriginBranch = await runOk("git", [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${cfg.sourceBranch}`,
  ]);

  const { unmerged, discarded } = await classifyIssueBranches(cfg.sourceBranch);

  return {
    hasGit,
    hasGh,
    hasContainerRuntime,
    hasPgImage,
    ghAuthOk,
    sandboxGhTokenOk,
    hasAgentCredential,
    inProgressMarkers: gitDir ? inProgressMarkers(gitDir) : [],
    currentBranch,
    expectedBranch: cfg.sourceBranch,
    hasOriginBranch,
    envFilePath: cfg.envFilePath,
    unmergedIssueBranches: unmerged,
    discardedIssueBranches: discarded,
  };
}

async function checkSandboxGhToken(
  env: (key: string) => string | undefined,
): Promise<boolean> {
  const token = env("GH_TOKEN");
  if (!token) return false;
  try {
    await exec("gh", ["api", "user", "--silent"], {
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

async function listIssueBranches(): Promise<readonly string[]> {
  const { ok, stdout } = await captureOk("git", [
    "for-each-ref",
    "--format=%(refname:short)",
    ...ISSUE_BRANCH_REFGLOBS,
  ]);
  if (!ok) return [];
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function isBranchMerged(
  branch: string,
  sourceBranch: string,
): Promise<boolean> {
  // A branch counts as merged if its tip is reachable from local sourceBranch
  // OR origin/sourceBranch. The origin check covers PRs that landed upstream
  // while local is behind.
  const onLocal = await runOk("git", [
    "merge-base",
    "--is-ancestor",
    branch,
    sourceBranch,
  ]);
  if (onLocal) return true;
  return runOk("git", [
    "merge-base",
    "--is-ancestor",
    branch,
    `refs/remotes/origin/${sourceBranch}`,
  ]);
}

async function branchUpstreamTracks(): Promise<ReadonlyMap<string, string>> {
  const { ok, stdout } = await captureOk("git", [
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

async function classifyIssueBranches(_sourceBranch: string): Promise<{
  unmerged: readonly string[];
  discarded: readonly string[];
}> {
  const all = await listIssueBranches();
  const tracks = await branchUpstreamTracks();
  const unmerged: string[] = [];
  const discarded: string[] = [];
  for (const branch of all) {
    // `[gone]` = the branch had an upstream and the remote deleted it (PR
    // closed/merged-and-deleted). If the work isn't on the source branch
    // either, the local commits are about to be orphaned — surface them
    // separately from genuinely-in-flight work so the user knows the loss
    // is intentional.
    if (tracks.get(branch) === "[gone]") discarded.push(branch);
    else unmerged.push(branch);
  }
  return { unmerged, discarded };
}

export async function deleteMergedIssueBranches(
  cfg: { cwd: string; workDir: string; sourceBranch: string },
): Promise<readonly string[]> {
  const all = await listIssueBranches();
  const deleted: string[] = [];
  for (const branch of all) {
    if (!(await isBranchMerged(branch, cfg.sourceBranch))) continue;
    // A leftover worktree (from a crash or a non-merged terminal whose
    // finalize ran before the corresponding fix landed) holds the branch and
    // makes `git branch -D` fail. Remove it best-effort first.
    await runOk("git", [
      "worktree",
      "remove",
      "--force",
      worktreePathFor(cfg.cwd, cfg.workDir, branch),
    ]);
    await runOk("git", ["worktree", "prune"]);
    // Use -D rather than -d: when the branch is merged only into
    // origin/sourceBranch (not local), git's safety check refuses -d even
    // though the commits are demonstrably preserved on a remote ref.
    const ok = await runOk("git", ["branch", "-D", branch]);
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
  await runOk("git", ["fetch", "origin", cfg.sourceBranch, "--quiet"]);

  const deleted = await deleteMergedIssueBranches({
    cwd: cfg.cwd,
    workDir: cfg.workDir,
    sourceBranch: cfg.sourceBranch,
  });
  if (deleted.length > 0) {
    console.log(`Cleaned up merged issue branches: ${deleted.join(", ")}`);
  }
  const state = await gatherState(cfg);
  const results = checkInvariants(state);
  const failures = results.flatMap((r) => (r.ok ? [] : [r.message]));
  if (failures.length > 0) throw new PreflightError(failures);

  // Soft warning: per-issue worktrees seed off origin/sourceBranch. If local
  // is ahead of origin, those issues won't see that work — the merge into
  // local carries it forward but issues that depend on it can fail.
  const ahead = await countCommitsAhead(
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

async function countCommitsAhead(local: string, remote: string): Promise<number> {
  const { ok, stdout } = await captureOk("git", [
    "rev-list",
    "--count",
    `${remote}..${local}`,
  ]);
  if (!ok) return 0;
  const n = parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}
