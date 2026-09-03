// Pre-flight invariants for sandbar runs.
//
// Runs UNDER the single-instance lock (#32), and must keep doing so. This
// module is not read-only: it fetches, and `deleteMergedSandbarBranches` runs
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
// TWO checks deliberately still read the operator's checkout, both soft
// warnings, and they are the same comparison run in opposite directions.
//
// AHEAD of `origin/<sourceBranch>`: nearly useless while `cwd` was a
// machine-managed clone that is never ahead. Against the human's repo it is
// exactly what it was written for — per-issue worktrees seed from origin, so
// unpushed local work is invisible to every agent, and that is both likely and
// silent.
//
// BEHIND it, in the commits that touch the CONFIG FILE (#66). The config is the
// one input a run still takes from the checkout — it resolves against the
// process cwd, and `gateStack` is inside it — and since #66 pinned the driver
// there is no longer a `git pull` anywhere in the launcher to refresh it. So a
// gate-stack change that landed on origin reaches a series when the operator
// pulls it and at no other moment, and untreated that is silent for as many
// relaunches as the series runs. Two things make the check answer rather than
// merely look like it does, and `readConfigStaleness` owns both: it counts in
// the CACHE, which the fetch above has just made current, because the operator
// who has not pulled has not fetched either and their own `origin/<branch>` is
// a ref from before the landing; and it counts only the commits touching the
// config file, because "the checkout is behind" is true after every landing a
// series makes and a warning that always fires is one nobody reads.
//
// A THIRD soft warning joined those two with #73, and it reads no repository at
// all — it is about `config.env`. The credential check itself is any-of and
// refuses only a provider with NO key (`uncredentialledProviders`); what it
// cannot see is a provider given TWO that bill differently, where the CLI picks
// the metered one by itself and a subscription is paid for and never spent.
// `billingPrecedenceWarnings` (agent-providers.ts) owns the rule; this module
// owns only when it is printed — before the invariant throw, beside the
// origin-URL warning and for the same reason.
//
// Two layers:
//   - checkInvariants(state)  — pure function over a captured RepoState.
//                               Unit-tested with hand-built fixtures.
//   - gatherState() / runPreflight() — I/O wrappers that shell out to git/gh.
//
// HOST STATE is what this module is for, and `missingMountSources` (#51) is the
// same class as the `missingImages` check beside it. Nothing used to verify
// that a gate-stack container's `mounts[].hostPath` exists before the run: a
// missing one fails `podman run` at bringup, and a gate container is
// `attempt`-lifecycle, so #24 D5 charges that failure to the BRANCH. The
// implementer is then handed a gate red about a statfs source it can neither
// see nor fix, on every attempt, for every issue in the cycle — the whole
// budget spent onto `agent-stuck` with an "environment" trace. #48 made it
// reachable rather than theoretical: this repo's own gate mounts
// `/run/user/<uid>/podman/podman.sock`, which exists only while that user's
// `podman.socket` unit is active.
//
// Two limits on it, both deliberate and both stated here so neither reads as an
// oversight:
//   - Only ABSOLUTE `hostPath`s are checked. A relative one resolves against
//     the worktree being gated, which does not exist when preflight runs. See
//     `absoluteMountSources` for why resolving them anyway would be worse than
//     the gap.
//   - It NARROWS the window rather than closing it. A source that exists here
//     and goes away mid-run — `podman.socket` stopped, a tmpfs unmounted — is
//     still a bringup failure, still a gate red, still misattributed. That is
//     not an argument for a second stat between attempts: it would cost a call
//     per container per gate run to shrink a window that the common case, a
//     config typo, does not have at all. Preflight catches the state that is
//     wrong BEFORE the run starts, which is the one an operator can act on
//     from the message.
// The agent sandbox needs no equivalent, and that is settled rather than open:
// its mounts are entirely sandbar-derived (the worktree plus whatever
// `resolveGitMounts` answers) and `config.ts` exposes no mount surface for it,
// so `gateStack.containers[].mounts[]` is the whole class of consumer-supplied
// host paths and this check is complete at that scope.
//
// Leftover `sandbar/issue-*` branches are classified four ways (#13):
//   - resumable — the branch maps to a still-open `ready-for-agent` issue, i.e.
//                 stranded work from an interrupted run (killed after the issue
//                 agents finished but before/inside the merger). NOT an error:
//                 the planner re-picks the issue and the inner loop continues
//                 from the branch's commits, so a killed run just restarts and
//                 finishes.
//   - parked    — the branch maps to an issue that is still OPEN but not
//                 `ready-for-agent`: parked by finalise (`needs-info`,
//                 `agent-stuck`) or held back by a human with a label of their
//                 own. NOT an error either, and the branch is KEPT: a preflight
//                 that refused over it forced the operator to destroy exactly
//                 the branch finalise's parking comment told them to push a fix
//                 on and re-queue. Announced every run so a branch the operator
//                 has actually abandoned is not silent.
// Both are measured against ORIGIN'S copy of the branch before the run goes on
// (#112, `syncIssueBranchWithOrigin` in git-ops.ts): the parking comment says
// "push a fix on the branch", so origin is where the fix is, and the cache's
// copy was a stale tip that one run built eight commits over. A branch behind
// origin is fast-forwarded here and announced; one that has DIVERGED refuses the
// run naming both tips, because which side wins is the operator's call and this
// terminal is where they are standing. `ensureIssueBranch` runs the same sync
// at every plan for the label re-applied mid-run, which no preflight sees.
//   - discarded — the branch's upstream is `[gone]` (PR merged+deleted upstream
//                 while local is behind). Local commits would be orphaned.
//   - unmerged  — everything else: maps to a CLOSED issue, or one the tracker
//                 could not be asked about. Nothing will ever re-queue it, so
//                 it stays a hard error.
// The open/closed fact comes from `fetchIssueStates`, the same strongly
// consistent GraphQL batch the planner uses for its CLOSED guard (#16), and it
// fails CLOSED like the two label listings beside it: an unanswerable tracker
// turns a parked branch back into an `unmerged` refusal, never into a silent
// pass.
// `sandbar/chunk-*` branches (#58) are listed by the same globs — one shape
// each of `SANDBAR_BRANCH_REFGLOBS` — but take none of those four: see
// `classifySandbarBranches`. They are still DELETED once merged, which is the
// one thing that is true of a chunk branch whatever else its lifecycle does.
//
// CHUNKS, both sides of the wire (#60). Now that chunk branches are real, this
// module has to be right about them in three ref spaces and it treats each as its
// own question:
//   - LOCAL `refs/heads/sandbar/chunk-*` — recognized and passed over, as
//     above. A chunk branch is unmerged for as long as its review takes, which
//     is the entire point of the review lane, so neither `unmerged` nor
//     `resumable` is anything but noise. Nothing sandbar does creates one of
//     these (the merger pushes from a detached HEAD), but a human or an older
//     run can, and being wrong about it would refuse the run.
//   - ORIGIN `refs/remotes/origin/sandbar/chunk-*` — fetched at the top of
//     `runPreflight` and read for one purpose: to verify that a leftover issue
//     branch belonging to a git-derived chunk member is a duplicate of work already
//     published on a chunk branch, and can therefore be deleted. Origin is
//     where a chunk branch actually lives; the local remote-tracking ref is a
//     cache of it and is treated as one.
//   - ORIGIN `refs/remotes/origin/sandbar/member-*` — fetched and pruned beside
//     chunk refs; containment is the membership fact used for safe local reap.
// The member's own issue branch is the third piece and is neither of the three
// classifications either — see `classifySandbarBranches`.

import { execFile, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

import {
  type AgentProviderName,
  billingPrecedenceWarnings,
  PROVIDER_CREDENTIALS,
} from "./agent-providers.js";
import type { ResolvedStackContainer } from "./config.js";
import type { EnvReader } from "./env.js";
import {
  ORIGIN_CHUNK_BRANCH_FETCH_REFSPECS,
  ORIGIN_MEMBER_BRANCH_FETCH_REFSPECS,
  ORIGIN_CHUNK_BRANCH_REFGLOBS,
  SANDBAR_BRANCH_REFGLOBS,
  issueNumberFromBranch,
  rootIssueFromChunkBranch,
} from "./naming.js";
import { type RepoLayout, worktreePathFor } from "./repo-cache.js";
import {
  describeIssueBranchOriginSync,
  issueBranchDeletedOnOriginMessage,
  issueBranchDivergedMessage,
  syncIssueBranchWithOrigin,
} from "./git-ops.js";
import { RUNTIME } from "./runtime.js";
import {
  fetchCandidates,
  fetchIssueStates,
  readChunkMembers,
} from "./plan-resolver.js";
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
  // Every ABSOLUTE `mounts[].hostPath` the gate stack declares, paired with the
  // container that declares it (#51). Built by `absoluteMountSources` below —
  // `run.ts` calls it rather than deriving the list itself, so the rule about
  // which paths are checkable lives beside the check that depends on it.
  readonly mountSources: readonly DeclaredMount[];
  // The file this run's config was imported from, as the bin resolved it
  // (#69's `RunOptions.configPath`), or `null` for a programmatic host that
  // passed an object and no file. Read for one soft warning and nothing else —
  // see `staleConfigWarning` (#66).
  readonly configPath: string | null;
  // Every agent provider this run will invoke (#72), from
  // `requiredAgentProviders`. Preflight checks a credential for each, so a
  // role routed away from claude refuses HERE rather than as an implementer
  // attempt dying in-container a cycle later.
  readonly agentProviders: readonly AgentProviderName[];
};

// A gate-stack mount source, carrying the container that declared it. A stack
// with several containers otherwise leaves the operator grepping their config
// for a path that appears in one of them.
export type DeclaredMount = {
  readonly container: string;
  readonly hostPath: string;
};

// One that podman will not be able to resolve, with what the stat actually
// said. The detail is carried rather than assumed because ENOENT is not the
// only way this fails: an EACCES traversing a parent means sandbar cannot tell
// whether the path exists, and podman — running as the same user — will not do
// better, so refusing is still right while "does not exist" would be a lie.
export type MissingMountSource = DeclaredMount & {
  readonly detail: string;
};

// The subset of the stack's mount sources preflight can decide anything about.
//
// A RELATIVE `hostPath` resolves against the worktree being GATED — the issue
// worktree in the inner loop, the merger worktree for gate-2 — and none of
// those exist when preflight runs, so those paths are a bringup concern by
// construction. Do not close that gap by resolving them against
// `worktrees/source` instead: a branch is free to add, move or delete its own
// fixtures, so a preflight built on the source tree would refuse runs over
// paths that are correct for the tree that will actually be gated — turning a
// misattributed gate red into a run that cannot start at all.
//
// Kind (a socket where a directory was meant) and readability by the
// container's uid are both deliberately out of scope: real, and neither
// decidable from the host side without guessing at the userns mapping.
//
// `isAbsolute` rather than a `startsWith("/")` lookalike, because this has to
// select exactly the paths `mountSpec` will NOT resolve against the worktree.
// The two answering the same question is the whole basis for checking one set
// and not the other.
//
// One behaviour change a consumer could feel: an absolute source that a
// `onWorktreeReady` hook creates during the run did not have to exist at
// startup and now does. That is the accepted cost of the check — a path the
// consumer's own config names is the consumer's to have ready — and it is the
// only shape of working config this refuses.
export function absoluteMountSources(
  containers: readonly ResolvedStackContainer[],
): readonly DeclaredMount[] {
  const out: DeclaredMount[] = [];
  for (const c of containers) {
    for (const m of c.mounts) {
      if (isAbsolute(m.hostPath)) {
        out.push({ container: c.name, hostPath: m.hostPath });
      }
    }
  }
  return out;
}

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
  // Declared gate-stack mount sources podman will not be able to resolve (#51).
  readonly missingMountSources: readonly MissingMountSource[];
  readonly ghAuthOk: boolean;
  readonly sandboxGhTokenOk: boolean;
  // Providers this run will invoke that have no credential declared for them
  // (#72). Empty is the passing state. A LIST rather than a boolean because
  // the roles can name two vendors and an operator who has declared one of
  // them should be told which one is missing, not asked to guess.
  readonly uncredentialledProviders: readonly AgentProviderName[];
  readonly sourceBranch: string;
  readonly hasOriginBranch: boolean;
  readonly unmergedIssueBranches: readonly string[];
  readonly discardedIssueBranches: readonly string[];
  // Stranded branches that map to a still-open `ready-for-agent` issue — not a
  // failure (resumed, not refused). Carried on the state purely so runPreflight
  // can announce them; checkInvariants emits no Invariant for them.
  readonly resumableIssueBranches: readonly string[];
  // Branches of OPEN issues that are not currently queued — the resume copy a
  // re-queue continues from (see the header). Same treatment as resumable:
  // announced by runPreflight, no Invariant.
  readonly parkedIssueBranches: readonly string[];
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
  // Host state, exactly like the image check above, and refused for the same
  // reason (#51): left to bringup, a mount source podman cannot resolve fails
  // an `attempt`-lifecycle container, which #24 D5 reports as a gate RED. The
  // implementer is then asked to fix host state it cannot see from inside its
  // sandbox, on every attempt, for every issue in the cycle.
  if (s.missingMountSources.length > 0) {
    const list = s.missingMountSources
      .map((m) => `  ${m.hostPath}  (container '${m.container}': ${m.detail})`)
      .join("\n");
    out.push({
      ok: false,
      message:
        `${s.missingMountSources.length} gate-stack mount source(s) declared ` +
        "by config.gateStack cannot be read on this host:\n" +
        list +
        "\nEach is a `-v` source podman resolves when the container starts, " +
        "and a bringup failure there is charged to the branch under test " +
        "rather than to the host — so left to the gate this arrives as a red " +
        "no agent can act on. Create the path, or correct it in " +
        "`config.gateStack`.",
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
  for (const provider of s.uncredentialledProviders) {
    const keys = PROVIDER_CREDENTIALS[provider]
      .map((c) => `  - ${c.key}  (${c.note})`)
      .join("\n");
    // The provider is present only because at least one role resolved to it.
    // Name every routing knob so an operator can find the one responsible even
    // when the merger is the sole role routed away from the default (#74).
    const why =
      `A role is routed to ${provider} by \`implementerAgent\`, ` +
      "`reviewerAgent`, or `mergerAgent`.";
    out.push({
      ok: false,
      message:
        `No ${provider} credential in \`config.env\`. ${why}\nDeclare one of:\n${keys}`,
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

export async function gatherState(
  cfg: PreflightConfig,
  // Git-derived chunk members (#93). Optional so a caller that has the set already
  // — `runPreflight`, which needs the same set for the delete pass — pays for
  // the query once instead of twice; omitted, it is fetched here.
  knownChunkMemberIssues?: ReadonlySet<number>,
): Promise<RepoState> {
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

  const missingMountSources = await findMissingMountSources(cfg.mountSources);

  const ghAuthOk = hasGh ? await runOk(repoDir, "gh", ["auth", "status"]) : false;
  const sandboxGhTokenOk = hasGh
    ? await checkSandboxGhToken(repoDir, env)
    : false;
  const uncredentialledProviders = cfg.agentProviders.filter(
    (provider) => !PROVIDER_CREDENTIALS[provider].some((c) => !!env(c.key)),
  );

  const hasOriginBranch = await runOk(repoDir, "git", [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${cfg.sourceBranch}`,
  ]);

  const originUrl = await readOriginUrl(repoDir);
  const parsedOrigin = originUrl === null ? null : parseRepoFromRemoteUrl(originUrl);
  const openReadyIssues = await fetchOpenReadyIssueNumbers(cfg.repo);
  const chunkMemberIssues =
    knownChunkMemberIssues ??
    (await fetchChunkMemberIssueNumbers(repoDir));
  const branches = await listSandbarBranches(repoDir);
  const upstreamTracks = await branchUpstreamTracks(repoDir);
  const undecided = branches.flatMap((branch) => {
    const number = issueNumberFromBranch(branch);
    return number === null ||
      openReadyIssues.has(number) ||
      chunkMemberIssues.has(number)
      ? []
      : [number];
  });
  const openIssues = await fetchOpenIssueNumbers(cfg.repo, undecided);
  const { unmerged, discarded, resumable, parked } = classifySandbarBranches({
    branches,
    upstreamTracks,
    openReadyIssues,
    chunkMemberIssues,
    openIssues,
  });

  return {
    hasGit,
    hasGh,
    hasContainerRuntime,
    missingImages,
    missingMountSources,
    ghAuthOk,
    sandboxGhTokenOk,
    uncredentialledProviders,
    sourceBranch: cfg.sourceBranch,
    hasOriginBranch,
    unmergedIssueBranches: unmerged,
    discardedIssueBranches: discarded,
    resumableIssueBranches: resumable,
    parkedIssueBranches: parked,
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

// Stat every absolute mount source the stack declares. `stat` rather than
// `lstat` on purpose: podman resolves the `-v` source through symlinks, so a
// link whose target is gone is a bringup failure and must read as one here.
async function findMissingMountSources(
  mounts: readonly DeclaredMount[],
): Promise<readonly MissingMountSource[]> {
  const out: MissingMountSource[] = [];
  for (const m of mounts) {
    try {
      await stat(m.hostPath);
    } catch (err) {
      out.push({ ...m, detail: statDetail(err) });
    }
  }
  return out;
}

// What to tell the operator the stat said. ENOENT — a path that was never
// created, or a `podman.socket` whose unit is not running — is the case worth
// spelling out in words; anything else keeps node's own code rather than being
// flattened into a claim about existence that sandbar has not established.
function statDetail(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return "no such file or directory";
  if (typeof code === "string") return code;
  return err instanceof Error ? err.message : String(err);
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

// Which of `numbers` are OPEN on the tracker, through the planner's own
// strongly consistent batch lookup (#16). Fail-closed to an empty set like the
// sibling lookups above: a branch the tracker cannot vouch for as open is
// classified `unmerged` and refused, which is what it was before this lookup
// existed.
async function fetchOpenIssueNumbers(
  repo: RepoRef,
  numbers: readonly number[],
): Promise<ReadonlySet<number>> {
  if (numbers.length === 0) return new Set();
  try {
    const facts = await fetchIssueStates(numbers, repo);
    return new Set(
      [...facts].flatMap(([n, f]) => (f.state === "OPEN" ? [n] : [])),
    );
  } catch {
    return new Set();
  }
}

// The issues already landed on a chunk branch (#60), through the planner's own
// query for the same reason as above. Fail-closed the same way, and the failure
// costs the same nothing: a leftover member branch is then classified as it
// would have been before chunks existed — a hard `unmerged` error — rather than
// silently reaped on a query that did not answer.
async function fetchChunkMemberIssueNumbers(
  repoDir: string,
): Promise<ReadonlySet<number>> {
  try {
    const members = await readChunkMembers(repoDir);
    return new Set([...members.values()].flatMap((ns) => [...ns]));
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

// Every branch sandbar can have created, both shapes and every recognized
// prefix (current + legacy). The globs live in `naming.ts` (#58) so this
// module cannot come to know about one shape and not the other.
async function listSandbarBranches(cwd: string): Promise<readonly string[]> {
  const { ok, stdout } = await captureOk(cwd, "git", [
    "for-each-ref",
    "--format=%(refname:short)",
    ...SANDBAR_BRANCH_REFGLOBS,
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

// Origin's chunk branches, as remote-tracking refs (#60). Fetched by
// `runPreflight` before anything reads them — a chunk branch is authoritative
// on origin and merely cached here, so a cache that has never seen one answers
// "no" and nothing is reaped on the strength of it.
async function listOriginChunkBranches(cwd: string): Promise<readonly string[]> {
  const { ok, stdout } = await captureOk(cwd, "git", [
    "for-each-ref",
    "--format=%(refname)",
    ...ORIGIN_CHUNK_BRANCH_REFGLOBS,
  ]);
  if (!ok) return [];
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

// True for an ISSUE branch whose issue has landed on a chunk branch and whose
// commits are demonstrably on one of origin's (#60). Both halves are load-
// bearing: the member-ref namespace says which branches to consider, and
// ancestry says the work survives the delete. A chunk branch itself never qualifies —
// `issueNumberFromBranch` returns null for the other shape — which is what
// stops this reaping the very branch it checks containment against.
async function isChunkMemberBranchLanded(
  cwd: string,
  branch: string,
  chunkMemberIssues: ReadonlySet<number>,
  originChunkRefs: readonly string[],
): Promise<boolean> {
  const issueNum = issueNumberFromBranch(branch);
  if (issueNum === null || !chunkMemberIssues.has(issueNum)) return false;
  for (const ref of originChunkRefs) {
    if (await runOk(cwd, "git", ["merge-base", "--is-ancestor", branch, ref])) {
      return true;
    }
  }
  return false;
}

async function branchUpstreamTracks(
  cwd: string,
): Promise<ReadonlyMap<string, string>> {
  const { ok, stdout } = await captureOk(cwd, "git", [
    "for-each-ref",
    "--format=%(refname:short)\t%(upstream:track)",
    ...SANDBAR_BRANCH_REFGLOBS,
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

// Pure: every git and tracker fact is handed in, so the four-way split is
// table-tested directly rather than through a fixture repo and a live `gh`.
export type BranchClassificationInputs = {
  readonly branches: readonly string[];
  // `%(upstream:track)` per branch — `[gone]` is the one value read.
  readonly upstreamTracks: ReadonlyMap<string, string>;
  readonly openReadyIssues: ReadonlySet<number>;
  readonly chunkMemberIssues: ReadonlySet<number>;
  // Issues the tracker confirmed OPEN. Need only cover the numbers the two
  // sets above do not already decide; a number absent here reads as closed.
  readonly openIssues: ReadonlySet<number>;
};

export type BranchClassification = {
  readonly unmerged: readonly string[];
  readonly discarded: readonly string[];
  readonly resumable: readonly string[];
  readonly parked: readonly string[];
};

export function classifySandbarBranches(
  inputs: BranchClassificationInputs,
): BranchClassification {
  const {
    branches,
    upstreamTracks: tracks,
    openReadyIssues,
    chunkMemberIssues,
  } = inputs;
  const unmerged: string[] = [];
  const discarded: string[] = [];
  const resumable: string[] = [];
  const parked: string[] = [];
  for (const branch of branches) {
    // A CHUNK branch (#58) is none of the three. It is unmerged for as long as
    // the human reviewing it takes, which is the entire point of the review
    // lane — classifying it `unmerged` would turn every open review into a
    // hard refusal to start, i.e. the loop stopping precisely because it is
    // waiting for the review it was told to wait for. It is not `resumable`
    // either: the issue number in it is a chunk ROOT, and resuming means
    // handing a branch to one issue's inner loop, which is not what a chunk
    // branch holds. So it is recognized and left alone here; the only thing
    // preflight does to one is delete it once merged, below — which since #64
    // is the ordinary end of a chunk's life rather than a rarity, so every
    // chunk that ever lands reaches it. What retires the chunk on ORIGIN is
    // the landing's own wrap-up or the plan-time reconciler
    // (`chunk-reconcile.ts`); this is only the local copy.
    if (rootIssueFromChunkBranch(branch) !== null) continue;
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
    const issueNum = issueNumberFromBranch(branch);
    // The issue branch of a LANDED chunk member (#60), and it is none of the
    // three either. A contained member ref says the chunk branch carries these
    // commits, so this branch is a duplicate of published
    // work: calling it `unmerged` would refuse the run over a branch that has
    // nothing left to lose, and it is the opposite of `resumable` — the planner
    // drops a member named by chunk history, so nothing will ever pick it up
    // again. The delete pass reaps it once it can VERIFY containment; until
    // then it is simply not the operator's problem. It
    // only exists at all if a run died between the chunk push and local issue-
    // branch deletion, or if that delete failed.
    if (issueNum !== null && chunkMemberIssues.has(issueNum)) continue;
    // Stranded work from an interrupted run: the branch belongs to an issue the
    // planner is still queued to work. Resume it rather than refusing to start
    // (#13) — the next cycle re-picks the issue and the inner loop continues
    // from this branch's accumulated commits.
    if (issueNum !== null && openReadyIssues.has(issueNum)) {
      resumable.push(branch);
      continue;
    }
    // The resume copy of an issue that is open but not queued — parked by
    // finalise or held by a human. Kept and announced; the header owns why a
    // refusal here destroys the very branch the parking comment points at.
    if (issueNum !== null && inputs.openIssues.has(issueNum)) {
      parked.push(branch);
      continue;
    }
    unmerged.push(branch);
  }
  return { unmerged, discarded, resumable, parked };
}

// The destructive step, and the reason every other call site in this module
// had to be retargeted first (#38 item 3): it runs `git branch -D` in
// `layout.repoDir`. Against the operator's own checkout that would be a
// sandbar bug that destroys a human's branches; against a bare cache holding
// only sandbar's own refs it cannot be.
//
// Both branch shapes (#58), and that needs no lifecycle argument either way: a
// branch whose commits are reachable from the source branch has said everything
// it had to say, whether one issue wrote it or a whole chunk did.
//
// SECOND ground, for issue branches only (#60): the origin member ref is
// contained by a chunk branch. Such a
// branch is published work under a different name, and nothing will ever pick
// it up again — the planner drops git-derived members — so left alone it
// accumulates one dead local ref per member a chunk ever landed. The remote
// ref selects the issue and containment verifies its work; both are
// required, because `-D` on a guess is the one thing this file
// must never do. Chunk branches are excluded from that ground by construction:
// every one of them is trivially reachable from itself.
export async function deleteMergedSandbarBranches(
  cfg: {
    layout: RepoLayout;
    sourceBranch: string;
    // Git-derived chunk member issues. Absent ⇒ empty ⇒ the second ground never
    // fires, which is exactly the pre-#60 behaviour: a caller that does not
    // know about chunks reaps one branch fewer, never one branch more.
    chunkMemberIssues?: ReadonlySet<number>;
  },
): Promise<readonly string[]> {
  const repoDir = cfg.layout.repoDir;
  const all = await listSandbarBranches(repoDir);
  const chunkMemberIssues = cfg.chunkMemberIssues ?? new Set<number>();
  const originChunkRefs =
    chunkMemberIssues.size > 0 ? await listOriginChunkBranches(repoDir) : [];
  const deleted: string[] = [];
  for (const branch of all) {
    const landedInChunk = await isChunkMemberBranchLanded(
      repoDir,
      branch,
      chunkMemberIssues,
      originChunkRefs,
    );
    if (!landedInChunk && !(await isBranchMerged(repoDir, branch, cfg.sourceBranch))) {
      continue;
    }
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

// Run `syncIssueBranchWithOrigin` over the branches preflight keeps (#112).
// `lines` is what runPreflight prints — one per branch that moved, was
// dropped, was kept ahead, or whose origin could not be asked; `refusals` are
// the failures it adds to the invariants' (a diverged branch, or one deleted
// on origin while the cache holds more than origin had); `abandoned` are the
// branches the sync dropped, which the announcements must no longer list.
// Exported for the git-backed test; the decision per branch is git-ops.ts's
// and tested there.
export async function syncKeptIssueBranches(
  repoDir: string,
  branches: readonly string[],
): Promise<{
  readonly lines: readonly string[];
  readonly refusals: readonly string[];
  readonly abandoned: readonly string[];
}> {
  const lines: string[] = [];
  const refusals: string[] = [];
  const abandoned: string[] = [];
  for (const branch of branches) {
    const sync = await syncIssueBranchWithOrigin(repoDir, branch);
    if (sync.kind === "diverged") {
      refusals.push(issueBranchDivergedMessage(repoDir, branch, sync.local, sync.origin));
    } else if (sync.kind === "origin-deleted") {
      refusals.push(issueBranchDeletedOnOriginMessage(repoDir, branch, sync));
    } else if (sync.kind === "abandoned") {
      abandoned.push(branch);
    }
    const line = describeIssueBranchOriginSync(branch, sync);
    if (line !== null) lines.push(line);
  }
  return { lines, refusals, abandoned };
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
  // And origin's chunk branches (#60), which answer a different question: a
  // chunk branch lives on origin and is only cached here, so it is what says
  // whether a leftover member's issue branch is a duplicate of published work
  // or the last copy of it. Wildcard refspecs, so a repo that has never had a
  // chunk fetches nothing and succeeds; `--prune` scoped to those same
  // destinations, so a chunk branch deleted on origin stops answering for one
  // here rather than lingering as a cached yes.
  await runOk(cfg.layout.repoDir, "git", [
    "fetch",
    "origin",
    "--prune",
    ...ORIGIN_CHUNK_BRANCH_FETCH_REFSPECS,
    ...ORIGIN_MEMBER_BRANCH_FETCH_REFSPECS,
    "--quiet",
  ]);

  // One query, two readers (#60): the delete pass uses it to decide which
  // leftover branches are duplicates of published work, and `gatherState` uses
  // it to decide which are none of its three classifications. Asking twice
  // would also let the two disagree if a label moved in between.
  const chunkMemberIssues = await fetchChunkMemberIssueNumbers(
    cfg.layout.repoDir,
  );

  const deleted = await deleteMergedSandbarBranches({
    layout: cfg.layout,
    sourceBranch: cfg.sourceBranch,
    chunkMemberIssues,
  });
  if (deleted.length > 0) {
    console.log(`Cleaned up merged issue branches: ${deleted.join(", ")}`);
  }
  const state = await gatherState(cfg, chunkMemberIssues);
  // The branches this run keeps are brought level with origin's copy first
  // (#112), so the two announcements below describe the tips the run will
  // actually resume from, and a diverged one is refused alongside the
  // invariants rather than one cycle in.
  const synced = await syncKeptIssueBranches(cfg.layout.repoDir, [
    ...state.resumableIssueBranches,
    ...state.parkedIssueBranches,
  ]);
  for (const line of synced.lines) console.log(line);
  const kept = (branches: readonly string[]) =>
    branches.filter((b) => !synced.abandoned.includes(b));
  const resumable = kept(state.resumableIssueBranches);
  const parked = kept(state.parkedIssueBranches);
  if (resumable.length > 0) {
    console.log(
      `Resuming ${resumable.length} stranded issue ` +
        `branch(es) from an interrupted run: ` +
        `${resumable.join(", ")}. The planner will re-pick ` +
        "the matching open `ready-for-agent` issue(s) and the inner loop " +
        "continues from each branch's commits.",
    );
  }
  if (parked.length > 0) {
    console.log(
      `Keeping ${parked.length} parked issue branch(es): ` +
        `${parked.join(", ")}. Each maps to an open issue ` +
        "that is not `ready-for-agent`; re-applying the label resumes from " +
        "the branch's commits, brought level with origin's copy wherever " +
        "origin is ahead. Deleting the branch on origin is what abandons them.",
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

  // Also before the throw, and for the same reason the line above it is (#73):
  // this is about the credentials an operator is standing in the middle of
  // configuring, and the run where it is most worth reading is a first codex
  // run — which is exactly the run most likely to be failing preflight for some
  // other reason. Soft, because both keys work: what it costs is a bill, and
  // sandbar cannot know which of the two the operator meant to spend.
  for (const warning of billingPrecedenceWarnings(cfg.agentProviders, cfg.env)) {
    console.warn(warning);
  }

  const results = checkInvariants(state);
  const failures = [
    ...results.flatMap((r) => (r.ok ? [] : [r.message])),
    ...synced.refusals,
  ];
  if (failures.length > 0) throw new PreflightError(failures);

  // The FIRST of the two soft checks that read the OPERATOR'S checkout, on
  // purpose (#38 item 10). Per-issue worktrees seed off origin/<sourceBranch>,
  // so commits sitting unpushed in the human's repo are invisible to every
  // agent in the run. While `cwd` was a machine-managed operating clone this
  // could essentially never fire; against a real working checkout it is both
  // likely and silent, which is what a soft warning is for. Fails quiet in both
  // directions — a checkout with no local `<sourceBranch>` at all reports 0.
  const ahead = await countCommits(
    cfg.layout.hostCwd,
    `origin/${cfg.sourceBranch}`,
    cfg.sourceBranch,
  );
  if (ahead > 0) {
    console.warn(
      `WARNING: ${cfg.layout.hostCwd} has local ${cfg.sourceBranch} ${ahead} commit(s) ahead of origin/${cfg.sourceBranch}. ` +
        "Per-issue worktrees seed from origin, so issues that depend on " +
        "unpushed work will fail or merge oddly. Push or rebase first if " +
        "those commits matter for the work sandbar is about to do.",
    );
  }

  // The second, which is the same read run the other way (#66).
  const staleConfig = staleConfigWarning(
    await readConfigStaleness({
      layout: cfg.layout,
      sourceBranch: cfg.sourceBranch,
      configPath: cfg.configPath,
    }),
  );
  if (staleConfig !== null) console.warn(staleConfig);
}

// What the checkout's copy of the config file is missing, against origin (#66).
export type ConfigStaleness = {
  // Absolute, as the bin resolved it; `null` for a programmatic host that
  // passed a config object and no file, where there is nothing to name and
  // nothing to pull.
  readonly configPath: string | null;
  readonly sourceBranch: string;
  readonly hostCwd: string;
  // Commits in `<the checkout's sourceBranch>..origin/<sourceBranch>`, and the
  // subset of those that touch `configPath`. Both 0 whenever git will not
  // answer — see `readConfigStaleness` for every way that happens.
  readonly behind: number;
  readonly touchingConfig: number;
};

// The checkout supplies the COMMIT, the cache supplies ORIGIN, and that split
// is the whole reason this is not two lines (#66). The operator's own
// `origin/<sourceBranch>` is as old as their last fetch, and the operator this
// check exists for is precisely the one who has not fetched — reading their
// remote-tracking ref would answer "0 behind" in exactly the case the warning
// is about. Preflight has just fetched the bare cache, so the cache is asked
// instead, about the sha the checkout's branch actually points at.
//
// The commit it asks about is the checkout's `<sourceBranch>`, NOT its checked
// out HEAD, and that narrowing is deliberate rather than an oversight: the file
// the run imported did come off whatever branch the operator is standing on, so
// one sitting on a feature branch that already carries the landed config change
// is warned about `main` anyway. Deliberate because `<sourceBranch>` is the
// branch this run's verdicts are about, it is the ref the ahead-warning above
// asks about too, and the alternative — a detached HEAD, a branch that exists
// nowhere on origin — has no upstream to be behind. A soft warning that
// occasionally fires on an operator who is already current is a cheaper error
// than one that reads their branch and goes quiet.
//
// Every failure answers 0 rather than throwing, and each is a real state: a
// `--config` outside the repository has no path in this history to ask about; a
// checkout with no local `<sourceBranch>` has no commit to compare; and a local
// sha the cache has never seen is an UNPUSHED commit, which is the
// ahead-warning's business above and not this one's.
export async function readConfigStaleness(args: {
  readonly layout: RepoLayout;
  readonly sourceBranch: string;
  readonly configPath: string | null;
}): Promise<ConfigStaleness> {
  const { hostCwd, repoDir } = args.layout;
  const nothing: ConfigStaleness = {
    configPath: args.configPath,
    sourceBranch: args.sourceBranch,
    hostCwd,
    behind: 0,
    touchingConfig: 0,
  };
  if (args.configPath === null) return nothing;
  // Against the WORK TREE ROOT, not against `hostCwd`: the pathspec is spent in
  // the cache, where paths are repo-relative, and `config.cwd` is only usually
  // the repository's root — a host whose config sits one directory down would
  // otherwise be asked about a path no commit has ever contained, and be told
  // nothing forever.
  const top = await captureOk(hostCwd, "git", ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return nothing;
  // BOTH sides realpath'd before they are compared, because they arrive
  // resolved to different degrees: `--show-toplevel` answers with symlinks
  // already resolved, while `configPath` is whatever the bin's `resolve()` made
  // of argv (cli.ts). A checkout reached through a symlinked parent — a
  // `~/work` pointing at a volume, say — would otherwise make `rel` start with
  // `..` and take this warning permanently quiet, which is the one failure a
  // soft check cannot afford. The config's DIRECTORY is what is resolved, not
  // the file: this asks a question about history, and a path history knows
  // about is not required to exist on disk. Neither call has to succeed either
  // — a path that will not resolve falls back to itself, and the guard below
  // still answers "nothing".
  const rel = relative(
    realpathOr(top.stdout.trim()),
    join(realpathOr(dirname(args.configPath)), basename(args.configPath)),
  );
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return nothing;

  const local = await captureOk(hostCwd, "git", [
    "rev-parse",
    "--verify",
    "--quiet",
    `${args.sourceBranch}^{commit}`,
  ]);
  if (!local.ok) return nothing;
  const base = local.stdout.trim();
  const tip = `origin/${args.sourceBranch}`;
  const behind = await countCommits(repoDir, base, tip);
  return {
    ...nothing,
    behind,
    touchingConfig:
      behind === 0 ? 0 : await countCommits(repoDir, base, tip, rel),
  };
}

// Pure, and it warns about the CONFIG being behind rather than about the
// checkout being behind (#66). Since the self-hosted launcher stopped pulling,
// a checkout is behind origin after every landing its own series makes, so
// warning on that alone would fire on nearly every relaunch and be tuned out by
// the second day. What the checkout still supplies to a run is one file, so the
// question worth asking the operator is whether the commits they are missing
// touch THAT file.
export function staleConfigWarning(s: ConfigStaleness): string | null {
  if (s.configPath === null || s.touchingConfig === 0) return null;
  return (
    `WARNING: local ${s.sourceBranch} in ${s.hostCwd} is ${s.behind} ` +
    `commit(s) behind origin/${s.sourceBranch}, and ${s.touchingConfig} of ` +
    `them change ${s.configPath}. Sandbar imported that file from this ` +
    "checkout and nothing in a run refreshes it, so this run's gate stack — " +
    "the thing that judges every branch — is the version saved here, not the " +
    "one on origin. Pull, then relaunch, if the landed change was meant to " +
    "apply to this series."
  );
}

// A path resolved through its symlinks, or itself when it will not resolve.
// The one caller is a soft warning, and a path that cannot be resolved is not
// a reason to have an opinion about it.
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Commits in `base..tip`, optionally narrowed to one path. 0 for anything git
// will not answer — an unknown ref, a pathspec outside the repository — which
// is what keeps both callers soft.
async function countCommits(
  cwd: string,
  base: string,
  tip: string,
  path?: string,
): Promise<number> {
  const { ok, stdout } = await captureOk(cwd, "git", [
    "rev-list",
    "--count",
    `${base}..${tip}`,
    ...(path === undefined ? [] : ["--", path]),
  ]);
  if (!ok) return 0;
  const n = parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}
