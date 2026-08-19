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
// Since #38 every command here runs in `layout.repoDir`, the bare cache — not
// in the operator's checkout. That is the sharpest edge of the whole change and
// it runs the opposite way to how it looks. While `config.cwd` WAS a dedicated
// operating clone, pointing the branch delete at it was harmless. Now `cwd` is
// the human's real repo, so threading it here would run `git branch -D` in it.
// The cache holds nothing of theirs, which is what makes the delete safe by
// construction rather than by care.
//
// TWO checks were deleted rather than retargeted (#38 item 7). "Not on
// <sourceBranch>" and "an in-progress merge/rebase/cherry-pick was detected"
// existed only because a human might be standing in the directory sandbar was
// about to operate on. Against a bare cache they are vacuous — it has no
// working tree and an unborn HEAD — and pointed at `config.cwd` they would be
// worse than vacuous: they would refuse to start because the OPERATOR is
// mid-rebase in their own repo, on work that has nothing to do with the run.
//
// TWO repositories are compared here, and that is the point of the check #34
// added last: every `gh` call now NAMES `config.ghOwner`/`config.ghRepo`
// instead of letting gh infer one from a directory's git remotes, while every
// `git push` still goes to the cache's `origin` — copied from the operator's
// checkout, declared by nobody. Naming the tracker removed the "which directory
// answers this" question; it could not make the two answers agree, so
// `checkInvariants` refuses a run where they don't.
//
// ONE check deliberately still reads the operator's checkout: the soft warning
// that local `<sourceBranch>` is ahead of `origin/<sourceBranch>`. It was
// nearly useless while `cwd` was a machine-managed clone that is never ahead.
// Against the human's repo it is exactly what it was written for — per-issue
// worktrees seed from origin, so unpushed local work is invisible to every
// agent, and that is both likely and silent.
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
import { promisify } from "node:util";

import type { EnvReader } from "./env.js";
import { ALL_BRANCH_PREFIXES, issueNumberFromBranch } from "./naming.js";
import { type RepoLayout, worktreePathFor } from "./repo-cache.js";
import { RUNTIME } from "./runtime.js";
import { fetchCandidates } from "./plan-resolver.js";
import {
  parseRepoFromRemoteUrl,
  type RepoRef,
  repoSlug,
  sameRepo,
} from "./repo-ref.js";

const exec = promisify(execFile);

export type PreflightConfig = {
  readonly layout: RepoLayout;
  // `config.ghOwner`/`config.ghRepo`. Every `gh` call sandbar makes names this
  // repository outright (#34) — including `fetchCandidates` below, which is why
  // preflight needs it. It is also one half of the agreement checked here.
  readonly repo: RepoRef;
  // The resolved `config.env`, already merged with the host environment per
  // declared key (#38). Preflight no longer knows where the values came from,
  // which is the point: sandbar names no file.
  readonly env: EnvReader;
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
  readonly sourceBranch: string;
  readonly hasOriginBranch: boolean;
  readonly unmergedIssueBranches: readonly string[];
  readonly discardedIssueBranches: readonly string[];
  // Stranded branches that map to a still-open `ready-for-agent` issue — not a
  // failure (resumed, not refused). Carried on the state purely so runPreflight
  // can announce them; checkInvariants emits no Invariant for them.
  readonly resumableIssueBranches: readonly string[];
  // The configured tracker, and what the cache's `origin` actually points at
  // (#34). `originRepo` is null when there is no readable origin URL or when it
  // is not a shape `parseRepoFromRemoteUrl` will commit to — see below, and see
  // repo-ref.ts for why refusing to guess is the whole point.
  readonly configuredRepo: RepoRef;
  readonly originUrl: string | null;
  readonly originRepo: RepoRef | null;
  // The host in that URL, and the host `gh` will actually talk to. `--repo` is
  // `[HOST/]OWNER/REPO` and sandbar passes the two-part form, so every tracker
  // call goes to gh's DEFAULT host — `GH_HOST` when set, github.com otherwise.
  // `originHost` is null when the URL's pre-path half is not confidently a
  // hostname (an `insteadOf` alias), which is the only case this is not
  // compared.
  readonly originHost: string | null;
  readonly ghHost: string;
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
        "GH_TOKEN is missing, empty, or rejected by GitHub. Sandbar reads it " +
        "from `config.env` (falling back to the host environment for a key " +
        "declared with an empty value). The agent's sandbox uses this token — " +
        "no hosts.yml is mounted — so it must be a valid fine-grained PAT. " +
        "Regenerate at https://github.com/settings/personal-access-tokens and " +
        "update whatever `config.env` is built from.",
    });
  }
  if (!s.hasAgentCredential) {
    out.push({
      ok: false,
      message:
        "No agent credential in `config.env`. Declare one of:\n" +
        "  - CLAUDE_CODE_OAUTH_TOKEN  (Pro/Max/Team/Enterprise subscription; generate with `claude setup-token`)\n" +
        "  - ANTHROPIC_API_KEY        (pay-as-you-go API; takes precedence if both are set)",
    });
  }
  if (!s.hasOriginBranch) {
    out.push({
      ok: false,
      message:
        `\`origin/${s.sourceBranch}\` does not exist in sandbar's object cache ` +
        "after fetch. Either the branch does not exist on the `origin` your " +
        "checkout points at, or the fetch itself failed — sandbar's cache is " +
        "a fresh clone and carries none of your checkout's repo-local git " +
        "config, so a deploy key or credential helper set with plain " +
        "`git config` (rather than `--global`) does not reach it. `git -C " +
        "<workDir>/repo.git fetch origin` will say which.",
    });
  }
  // Every `gh` call names `config.ghOwner`/`config.ghRepo`; every `git push`
  // goes to the cache's `origin`, which is copied from the operator's checkout
  // and which nothing declares. Naming the repo (#34) made the tracker half a
  // function of the config file instead of a directory, but it cannot make the
  // two halves AGREE — so they are compared, once, here.
  //
  // A mismatch is fatal rather than a warning because every one of its symptoms
  // is silent and lands somewhere real: the planner queues issues from the
  // configured repo, the agents' work is pushed to origin's, the merger closes
  // the configured repo's issues for commits that landed in the other, and
  // `mergeMode: "verified"` polls checks for a sha the configured repo has
  // never seen — which reports as `sha-never-built`, i.e. as a CI problem.
  // The host half of the same question, and it is a separate check because a
  // matching `owner/name` on a DIFFERENT host is the worse failure: it passes
  // the comparison below while pointing every tracker call at an unrelated
  // repository that happens to share a name. `gh`'s flag is
  // `[HOST/]OWNER/REPO`; `repoSlug` emits the two-part form, so the host is
  // gh's default and `ghOwner`/`ghRepo` have nowhere to carry one. Refusing is
  // the honest answer — the alternative was already silently broken before
  // #34's fix (`gh issue list` followed the remote's host while
  // `gh api graphql` went to the default one, which is this issue's own bug),
  // and it names `GH_HOST`, which is how gh itself is pointed at an enterprise
  // instance.
  if (s.originHost !== null && s.originHost !== s.ghHost) {
    out.push({
      ok: false,
      message:
        `this repository's \`origin\` is on ${s.originHost} (${s.originUrl}) ` +
        `but \`gh\` will talk to ${s.ghHost}. Sandbar passes ` +
        "`--repo <owner>/<name>`, which uses gh's default host, and there is " +
        "no host field in the config to carry another. Set `GH_HOST=" +
        `${s.originHost}\` in sandbar's environment if that is the instance ` +
        "you mean, or point `config.cwd` at a checkout whose `origin` is on " +
        `${s.ghHost}.`,
    });
  }
  if (s.originRepo && !sameRepo(s.originRepo, s.configuredRepo)) {
    out.push({
      ok: false,
      message:
        `config names ${repoSlug(s.configuredRepo)} (ghOwner/ghRepo) but this ` +
        `repository's \`origin\` is ${repoSlug(s.originRepo)} ` +
        `(${s.originUrl}). Sandbar reads and writes issues in the configured ` +
        "repo and pushes branches and merges to `origin`, so these must be " +
        "the same repository. Fix whichever is wrong: change ghOwner/ghRepo, " +
        "or point `config.cwd` at a checkout of that repo.",
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
// about, or a mutation of, a specific repo, and left to inherit
// `process.cwd()` they described whichever directory the host process happened
// to be launched from. An omitted `{ cwd }` is invisible at the call site and
// fails only on the hosts that configure one, i.e. never in the author's own
// checkout; a missing positional argument is a type error.
//
// Since #38 the value every caller passes is `layout.repoDir` — the bare cache
// — with the single, commented exception of the local-ahead warning. Keeping
// the parameter required is what makes that exception legible: it is one call
// site that names a different directory on purpose, not one that forgot.
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

export async function gatherState(cfg: PreflightConfig): Promise<RepoState> {
  const repoDir = cfg.layout.repoDir;
  const env = cfg.env;
  const hasGit = which("git");
  const hasGh = which("gh");
  const hasContainerRuntime = which(RUNTIME);

  const missingImages: string[] = [];
  if (hasContainerRuntime) {
    for (const image of cfg.pulledImages) {
      if (!(await runOk(repoDir, RUNTIME, ["image", "exists", image]))) {
        missingImages.push(image);
      }
    }
  }

  const ghAuthOk = hasGh ? await runOk(repoDir, "gh", ["auth", "status"]) : false;
  const sandboxGhTokenOk = hasGh
    ? await checkSandboxGhToken(repoDir, env)
    : false;
  const hasAgentCredential =
    !!env("CLAUDE_CODE_OAUTH_TOKEN") || !!env("ANTHROPIC_API_KEY");

  const hasOriginBranch = await runOk(repoDir, "git", [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${cfg.sourceBranch}`,
  ]);

  const originUrl = await readOriginUrl(repoDir);
  const parsedOrigin = originUrl === null ? null : parseRepoFromRemoteUrl(originUrl);
  const openReadyIssues = await fetchOpenReadyIssueNumbers(cfg.repo);
  const { unmerged, discarded, resumable } = await classifyIssueBranches(
    repoDir,
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
    sourceBranch: cfg.sourceBranch,
    hasOriginBranch,
    unmergedIssueBranches: unmerged,
    discardedIssueBranches: discarded,
    resumableIssueBranches: resumable,
    configuredRepo: cfg.repo,
    originUrl,
    originRepo: parsedOrigin?.repo ?? null,
    originHost: parsedOrigin?.host ?? null,
    // What `gh` resolves an unqualified `--repo owner/name` against. gh reads
    // `GH_HOST` from its own environment, which is this process's — the
    // sandbox's env record is a different thing and does not apply here.
    ghHost: (process.env["GH_HOST"] ?? "").trim().toLowerCase() || "github.com",
  };
}

// The cache's `origin` URL, or null when there isn't one to read. Null is not
// an error here: a cache with no usable origin already fails the
// `origin/<sourceBranch>` invariant, with a message that says considerably more
// about why.
async function readOriginUrl(cwd: string): Promise<string | null> {
  const { ok, stdout } = await captureOk(cwd, "git", [
    "remote",
    "get-url",
    "origin",
  ]);
  if (!ok) return null;
  const url = stdout.trim();
  return url === "" ? null : url;
}

// The set of issue numbers currently in the planner queue (open +
// `ready-for-agent`). Reuses the planner's own candidate query so the resume
// classification can never desync from what the next cycle actually picks up.
// Fail-closed to an empty set: a gh hiccup just means no branch is treated as
// resumable (they fall back to the existing hard error), and the ghAuthOk /
// sandboxGhTokenOk invariants report the real problem.
async function fetchOpenReadyIssueNumbers(
  repo: RepoRef,
): Promise<ReadonlySet<number>> {
  try {
    const candidates = await fetchCandidates(repo);
    return new Set(candidates.map((c) => c.number));
  } catch {
    return new Set();
  }
}

async function checkSandboxGhToken(
  cwd: string,
  env: EnvReader,
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

// The destructive step, and the reason every other call site in this module
// had to be retargeted first (#38 item 3): it runs `git branch -D` in
// `layout.repoDir`. Against the operator's own checkout that would be a
// sandbar bug that destroys a human's branches; against a bare cache holding
// only sandbar's own refs it cannot be.
export async function deleteMergedIssueBranches(
  cfg: { layout: RepoLayout; sourceBranch: string },
): Promise<readonly string[]> {
  const repoDir = cfg.layout.repoDir;
  const all = await listIssueBranches(repoDir);
  const deleted: string[] = [];
  for (const branch of all) {
    if (!(await isBranchMerged(repoDir, branch, cfg.sourceBranch))) continue;
    // A leftover worktree (from a crash or a non-merged terminal whose
    // finalize ran before the corresponding fix landed) holds the branch and
    // makes `git branch -D` fail. Remove it best-effort first.
    await runOk(repoDir, "git", [
      "worktree",
      "remove",
      "--force",
      worktreePathFor(cfg.layout.worktreesDir, branch),
    ]);
    await runOk(repoDir, "git", ["worktree", "prune"]);
    // Use -D rather than -d: when the branch is merged only into
    // origin/sourceBranch (not local), git's safety check refuses -d even
    // though the commits are demonstrably preserved on a remote ref.
    const ok = await runOk(repoDir, "git", ["branch", "-D", branch]);
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
  // reaped even when the cache has not seen origin recently. Into the CACHE:
  // sandbar never fetches into the operator's checkout, so a run can neither
  // move their refs nor be blamed for doing so.
  await runOk(cfg.layout.repoDir, "git", [
    "fetch",
    "origin",
    cfg.sourceBranch,
    "--quiet",
  ]);

  const deleted = await deleteMergedIssueBranches({
    layout: cfg.layout,
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
  // The other half of the #34 agreement check, and it is emitted BEFORE the
  // throw on purpose: the run most likely to be failing preflight for other
  // reasons is a first run, where the operator is debugging exactly the remote
  // and credential setup this line is about. Suppressing it there — which is
  // what putting it after the throw did — hides the one message that says
  // sandbar could not read their origin.
  //
  // The rest of the #34 agreement check. `parseRepoFromRemoteUrl`
  // returns null rather than guessing at a URL it cannot read as
  // `<owner>/<repo>` — a filesystem-path remote, most likely a local mirror —
  // because a wrong parse here REFUSES a working configuration, which is worse
  // than the silent split the check exists to catch. Saying so is the honest
  // remainder: the two halves may well disagree and sandbar cannot tell.
  if (state.originUrl !== null && state.originRepo === null) {
    console.warn(
      `WARNING: could not read an <owner>/<repo> out of this repository's ` +
        `\`origin\` (${state.originUrl}), so it cannot be checked against the ` +
        `configured ${repoSlug(state.configuredRepo)}. Issues are read and ` +
        "written in the configured repo; branches and merges are pushed to " +
        "`origin`. If those are not the same repository, sandbar will close " +
        "issues for work that landed somewhere else.",
    );
  }

  const results = checkInvariants(state);
  const failures = results.flatMap((r) => (r.ok ? [] : [r.message]));
  if (failures.length > 0) throw new PreflightError(failures);

  // The one check that reads the OPERATOR'S checkout, on purpose (#38 item 10).
  // Per-issue worktrees seed off origin/<sourceBranch>, so commits sitting
  // unpushed in the human's repo are invisible to every agent in the run. While
  // `cwd` was a machine-managed operating clone this could essentially never
  // fire; against a real working checkout it is both likely and silent, which
  // is what a soft warning is for. Fails quiet in both directions — a checkout
  // with no local `<sourceBranch>` at all just reports 0.
  const ahead = await countCommitsAhead(
    cfg.layout.hostCwd,
    cfg.sourceBranch,
    `origin/${cfg.sourceBranch}`,
  );
  if (ahead > 0) {
    console.warn(
      `WARNING: ${cfg.layout.hostCwd} has local ${cfg.sourceBranch} ${ahead} commit(s) ahead of origin/${cfg.sourceBranch}. ` +
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
