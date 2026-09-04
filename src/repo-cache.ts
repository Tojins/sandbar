// The disposable state directory, and the bare object cache inside it (#38).
//
// Nothing sandbar keeps locally is authoritative — GitHub Issues is the
// tracker, merged work is on `origin/<sourceBranch>` — so the local state is
// `node_modules`-shaped: reproducible, deletable, gitignored inside the
// operator's REAL checkout at `<hostCwd>/.sandbar/`: the bare cache
// `repo.git` (every git call runs there; `gh` names its own repo with
// `--repo`, #34), the worktrees, `run.lock`/`run.pid`, and logs. Sandbar
// reads the host checkout and clones it once; it never writes to it.
//
// `repo.git` being BARE is not tidiness: it is what makes the three
// genuinely-destructive operations (`branch -D`, `worktree remove --force`,
// force-pushing the scratch integration ref) provably unable to touch the
// operator's repo, because the repo they run in holds nothing of the
// operator's.
//
// Creation: `git clone --bare <hostCwd>`, then `origin` retargeted to the URL
// the host checkout's own `origin` carries — derived, never configured
// (Rejected: a `remoteUrl` knob — it could disagree with `cwd`, and sandbar
// would silently merge the right branches into the wrong repo). Then three
// fixups, each load-bearing:
//   - `remote.origin.fetch` is set EXPLICITLY to
//     `+refs/heads/*:refs/remotes/origin/*`: `clone --bare` sets no refspec,
//     and `--mirror` produces no `refs/remotes/origin/*` at all — the
//     remote-tracking refs sandbar depends on everywhere (branch seeding, the
//     merger detach, ancestry and merged-ness tests).
//   - Local `refs/heads/*` copied in by the clone are DELETED: the cache's
//     branch namespace belongs to sandbar alone, and an imported operator
//     branch matching `sandbar/issue-*` would make preflight hard-refuse the
//     run. The resulting unborn HEAD is fine for every operation sandbar
//     performs (pinned in repo-cache-git.test.ts).
//   - Creation is ATOMIC — prepared under `repo.git.incoming`, stamped, then
//     renamed into place. A half-built cache is a perfectly valid bare repo,
//     so the stamp, not bareness, is the evidence of full preparation. See
//     `ensureRepoCache` and `isPreparedCache`.
//
// Never ask git WHICH repository this is; tell it. Every path in the layout
// lives inside the operator's checkout, so `rev-parse --git-dir` discovery
// walks UP and hands the operator's own repo to the destructive operations —
// the bare-cache safety argument inverted. Probes NAME their target:
// `--git-dir=<path>` for the cache, `--git-common-dir` compared against it
// for a worktree. The persistent source worktree is locked: issue-clone
// cleanup and a human may run cache-wide `worktree prune`, and the lock keeps
// a temporarily unreachable build context registered until it can be reset.

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { SandbarError, isErrno, isExitCode } from "./errors.js";

const exec = promisify(execFile);

// The bare cache's directory name inside <workDir>. `.git`-suffixed so a human
// who opens the state directory can see what it is at a glance.
export const CACHE_DIR_NAME = "repo.git";

// The persistent worktree the base images are built from. A NAME, not a
// branch: it is detached at origin/<sourceBranch>, locked against cache-wide
// pruning, and reset there every run.
export const SOURCE_WORKTREE_NAME = "source";
export const MERGER_WORKTREE_NAME = "merger";
export const RESERVED_WORKTREE_NAMES: ReadonlySet<string> = new Set([
  SOURCE_WORKTREE_NAME,
  MERGER_WORKTREE_NAME,
]);

// Every path sandbar owns, derived from the two knobs a consumer sets.
//
// Threaded as one object rather than as `cwd` + `workDir` (#38). The two
// directories are no longer the same thing, and the field that used to be
// called `cwd` was about to mean "the repo commands run in" in some call sites
// and "the root the worktree paths hang off" in others — which is exactly the
// confusion #34 spent a release removing.
export type RepoLayout = {
  // The operator's checkout. Sandbar READS it (git identity, `copyToWorktree`
  // sources, the one-time clone) and never writes to it — no fetch, no pull,
  // which since #66 is also why nothing refreshes the config file living here.
  // The two soft warnings preflight emits about this directory (ahead of
  // origin, and behind it in the commits touching the config) are the only
  // checks that still look, and they look on purpose — see preflight.ts.
  readonly hostCwd: string;
  // <hostCwd>/<workDir>. Holds everything below, plus the lock and the logs.
  readonly stateDir: string;
  // The bare cache. The `cwd` of every git call sandbar makes, with the
  // documented exception above. NOT of the `gh` calls: since #34 those name
  // `ghOwner`/`ghRepo` with `--repo` and run in no named directory.
  readonly repoDir: string;
  readonly worktreesDir: string;
  readonly sourceWorktree: string;
  readonly logsDir: string;
};

export function repoLayout(hostCwd: string, workDir: string): RepoLayout {
  const stateDir = join(hostCwd, workDir);
  const worktreesDir = join(stateDir, "worktrees");
  return {
    hostCwd,
    stateDir,
    repoDir: join(stateDir, CACHE_DIR_NAME),
    worktreesDir,
    sourceWorktree: join(worktreesDir, SOURCE_WORKTREE_NAME),
    logsDir: join(stateDir, "logs"),
  };
}

// Where a branch's managed worktree lives. Takes the worktrees directory rather
// than (repoDir, workDir): since #38 the repo and the worktrees are not in the
// same tree — the repo is `<stateDir>/repo.git` and the worktrees are
// `<stateDir>/worktrees/` beside it — so composing the path from the repo
// directory would nest every worktree INSIDE the bare cache.
export function worktreePathFor(worktreesDir: string, branch: string): string {
  return join(worktreesDir, branch.replace(/\//g, "-"));
}

async function git(
  cwd: string,
  args: readonly string[],
): Promise<{ stdout: string }> {
  return exec("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
}

async function gitOk(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch (err) {
    if (!isExitCode(err, 1) && !isExitCode(err, 128)) throw err;
    return false;
  }
}

// Two paths naming the same directory. `--absolute-git-dir` and
// `--git-common-dir` are git's own answers and may or may not have gone
// through a symlink, so a string compare alone is not enough on a host whose
// state directory is reached through one.
function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
    return false;
  }
}

// Is `repoDir` a prepared cache?
//
// The obvious probe — `git -C <repoDir> rev-parse --git-dir` — is WRONG here,
// and destructively so. Git discovers a repository by walking UP, and every
// path in the layout sits inside the operator's own checkout, so for a
// `repo.git` that exists but is not a repository (an interrupted
// `rm -rf .sandbar`, a restore that skipped it, a disk-full mid-clone) it
// answers with `<hostCwd>/.git` and exits 0. The cache then reads as present,
// and every call that takes `layout.repoDir` as its cwd — `branch -D`,
// `worktree remove --force`, `fetch`, `push`, the force-pushed integration ref
// — resolves to the operator's repository. The whole safety argument for
// making the cache bare is that those commands run somewhere holding none of
// the operator's refs; a discovering probe hands them the one repo that holds
// all of them.
//
// `--git-dir=<path>` names the directory instead of discovering it: git exits
// 128 rather than climbing. So the question asked is the one meant — "is THIS
// directory a bare repository" — and there is no path comparison to get wrong.
//
// Bare is necessary and not sufficient. A half-built cache is a perfectly
// valid bare repository — that is the whole hazard — so the last thing
// creation does before the rename is stamp `CACHE_MARKER` into the repo's own
// config, and this asks for the stamp. Anything else at that path is treated
// as debris and rebuilt, which costs a local hardlinked clone and discards
// only in-flight issue branches (agent time, never correctness: nothing in the
// state directory is authoritative).
const CACHE_MARKER = "sandbar.cache";

async function isPreparedCache(repoDir: string): Promise<boolean> {
  if (!existsSync(repoDir)) return false;
  try {
    const bare = await exec(
      "git",
      ["--git-dir", repoDir, "rev-parse", "--is-bare-repository"],
      { cwd: repoDir, maxBuffer: 1024 * 1024 },
    );
    if (bare.stdout.trim() !== "true") return false;
    const marked = await exec(
      "git",
      ["--git-dir", repoDir, "config", "--get", CACHE_MARKER],
      { cwd: repoDir, maxBuffer: 1024 * 1024 },
    );
    return marked.stdout.trim() === "1";
  } catch (err) {
    if (!isExitCode(err, 1) && !isExitCode(err, 128)) throw err;
    return false;
  }
}

// Is `dir` a registered linked worktree OF the cache? Same trap, same stakes:
// an unregistered leftover directory discovers upward to the operator's
// checkout, and the caller's recovery path is `reset --hard` + `clean -ffdx`.
// `--git-common-dir` is the worktree's answer to "which repository am I in",
// and it is compared against the cache rather than merely required to exist.
async function isWorktreeOfCache(
  dir: string,
  repoDir: string,
): Promise<boolean> {
  if (!existsSync(dir)) return false;
  try {
    const { stdout } = await git(dir, ["rev-parse", "--git-common-dir"]);
    const common = stdout.trim();
    // Relative, and relative to the worktree — `git rev-parse` says so.
    return common !== "" && samePath(resolve(dir, common), repoDir);
  } catch (err) {
    if (!isExitCode(err, 1) && !isExitCode(err, 128)) throw err;
    return false;
  }
}

function detail(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const s = String((err as { stderr?: unknown }).stderr ?? "").trim();
    if (s) return s;
  }
  return err instanceof Error ? err.message : String(err);
}

// The URL the host checkout's `origin` points at. Fails loud rather than
// guessing: sandbar pushes branches, merge results and a force-pushed scratch
// ref to this remote, so an unresolvable one must stop the run at startup, not
// at the first push.
async function hostOriginUrl(hostCwd: string): Promise<string> {
  if (!(await gitOk(hostCwd, ["rev-parse", "--git-dir"]))) {
    throw new SandbarError(
      `sandbar's \`cwd\` (${hostCwd}) is not a git repository. It must be a ` +
        "checkout of the repo sandbar works on: sandbar clones its own bare " +
        "cache from it and reads your git identity and `copyToWorktree` " +
        "sources there. When launched through the `sandbar` bin, `cwd` " +
        "defaults to the directory holding the config file.",
    );
  }
  try {
    const { stdout } = await git(hostCwd, ["remote", "get-url", "origin"]);
    const url = stdout.trim();
    if (!url) throw new Error("empty url");
    // A relative filesystem remote (`../other-repo`) is resolved against the
    // HOST CHECKOUT, because that is what it is relative to — copied verbatim
    // onto the cache it would resolve against `<stateDir>/repo.git` instead and
    // name a directory that does not exist. Only the unambiguous `./`/`../`
    // spellings are rewritten: every URL form (`https://…`, `ssh://…`, and
    // scp-style `git@host:org/repo`) is left exactly as the operator wrote it.
    if (url.startsWith("./") || url.startsWith("../")) {
      return resolve(hostCwd, url);
    }
    return url;
  } catch (err) {
    throw new SandbarError(
      `The repository at ${hostCwd} has no \`origin\` remote. Sandbar derives ` +
        "the remote from your checkout rather than taking it as config, so " +
        "the two cannot disagree — add one with `git remote add origin <url>`.",
      { cause: err },
    );
  }
}

// Create the bare cache if it is absent, and keep its remote in step with the
// host checkout's on every run. Idempotent, and self-healing after a
// `rm -rf .sandbar`: nothing in here is authoritative, so re-creating it costs
// a local clone and a fetch.
export async function ensureRepoCache(layout: RepoLayout): Promise<void> {
  const { hostCwd, repoDir, stateDir } = layout;
  const url = await hostOriginUrl(hostCwd);

  if (!(await isPreparedCache(repoDir))) {
    await mkdir(stateDir, { recursive: true });
    console.log(
      `Creating sandbar's object cache at ${repoDir} (one-time; cloned from ` +
        `${hostCwd}, so it is local and hardlinked)...`,
    );
    // Built under a scratch name and moved into place only once it is FULLY
    // prepared, so that "the directory is there" and "the directory has been
    // through every preparation step" are the same fact.
    //
    // Preparing in place made them different facts, and the gap was permanent
    // rather than transient: a run killed between the clone and the
    // head-deletion below leaves a structurally valid bare repo carrying the
    // operator's branches, and every later run sees a cache and never revisits
    // the steps that were skipped. An imported `sandbar/issue-42-*` is then a
    // hard preflight refusal, on every run, naming a branch in a repo the
    // operator does not know exists — which is verbatim the failure deleting
    // the heads exists to prevent. SIGTERM is the likely path and not an
    // exotic one: sandbar's cleanup traps exit the process without killing the
    // child, so the clone runs to completion while nothing after it does.
    //
    // A fixed scratch name is safe because the single-instance lock is already
    // held (run.ts acquires it before preflight), and it is preferable to a
    // unique one: a crash leaves at most one to overwrite rather than one per
    // crash.
    const incoming = `${repoDir}.incoming`;
    await rm(incoming, { recursive: true, force: true });
    try {
      await git(hostCwd, ["clone", "--bare", "--quiet", hostCwd, incoming]);
    } catch (err) {
      throw new SandbarError(
        `Failed to clone sandbar's object cache from ${hostCwd} into ` +
          `${repoDir}: ${detail(err)}`,
        { cause: err },
      );
    }
    // The clone copies the operator's local branches into refs/heads/*. Drop
    // them: this namespace is sandbar's, and an imported `sandbar/issue-*`
    // would make preflight refuse to start over a branch sandbar created here
    // itself out of the operator's checkout.
    try {
      const { stdout } = await git(incoming, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/",
      ]);
      for (const ref of stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
        await git(incoming, ["update-ref", "-d", ref]);
      }
    } catch (err) {
      throw new SandbarError(
        `Failed to clear the imported local branches from ${repoDir}: ${detail(err)}`,
        { cause: err },
      );
    }
    try {
      await setRemote(incoming, url);
    } catch (err) {
      throw new SandbarError(
        `Failed to point sandbar's object cache at ${url}: ${detail(err)}`,
        { cause: err },
      );
    }
    // Populate refs/remotes/origin/* once. The objects are already here from
    // the local clone, so this is a ref negotiation rather than a download —
    // but it is what turns `origin/<sourceBranch>` into a real ref, which
    // everything downstream reads.
    try {
      await git(incoming, ["fetch", "origin", "--prune", "--quiet"]);
    } catch (err) {
      throw new SandbarError(
        `Failed the initial fetch of ${url} into sandbar's object cache: ${detail(err)}`,
        { cause: err },
      );
    }
    // The stamp `isPreparedCache` looks for. Written last, so it can only be
    // read on a cache that made it through every step above.
    try {
      await git(incoming, ["config", CACHE_MARKER, "1"]);
    } catch (err) {
      throw new SandbarError(
        `Failed to mark sandbar's object cache as prepared: ${detail(err)}`,
        { cause: err },
      );
    }
    // Only now is there anything worth keeping. Removing whatever was at
    // `repoDir` is safe by construction: reaching here means it was not a
    // prepared cache, and it is inside the disposable state directory.
    try {
      await rm(repoDir, { recursive: true, force: true });
      await rename(incoming, repoDir);
    } catch (err) {
      throw new SandbarError(
        `Failed to move sandbar's prepared object cache into place at ` +
          `${repoDir}: ${detail(err)}`,
        { cause: err },
      );
    }
  }

  // Every run, not just on creation: an operator who retargets their own
  // `origin` must not end up with a cache still pushing at the old one, and a
  // cache created by an older sandbar may carry no refspec at all.
  try {
    await setRemote(repoDir, url);
  } catch (err) {
    throw new SandbarError(
      `Failed to point sandbar's object cache at ${url}: ${detail(err)}`,
      { cause: err },
    );
  }
}

// `git clone --bare` sets no fetch refspec at all, so it is set explicitly —
// see the module header for why `--mirror` is not the answer.
async function setRemote(repoDir: string, url: string): Promise<void> {
  await git(repoDir, ["remote", "set-url", "origin", url]);
  await git(repoDir, [
    "config",
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
}

// The persistent worktree the declared images are built from (#38 item 4).
//
// `ensureImages` runs before any issue worktree exists, so its build context
// used to be `config.cwd` — the operator's checkout, whatever happened to be
// checked out in it, uncommitted edits and all. That is a latent instance of
// the same bug #37 fixed one level down: the image is a claim about a tree, and
// the tree was not a commit. Here it becomes exactly `origin/<sourceBranch>`.
//
// Reset rather than recreated, and `clean -ffdx` rather than `-ffd`: the
// fingerprint recorded on the image says "built from this tree", so anything
// left in the directory — including ignored files — would be tarred into the
// build context and make that claim false.
export async function ensureSourceWorktree(
  layout: RepoLayout,
  sourceBranch: string,
): Promise<string> {
  const { repoDir, sourceWorktree } = layout;
  const target = `origin/${sourceBranch}`;

  const registered = await isWorktreeOfCache(sourceWorktree, repoDir);

  if (!registered) {
    // A leftover directory with no worktree registration (a killed run, a
    // partially-removed state dir) blocks `worktree add`. Clear both sides,
    // then the directory itself: `worktree remove` declines to touch a path it
    // has no registration for, and `worktree add` refuses a non-empty one. It
    // is inside the disposable state directory and, by the probe above, holds
    // no repository of its own.
    // A locked registration requires two --force flags. The path may be gone
    // while its locked registration remains; replacement is safe because this
    // managed path is reserved exclusively for the source build context.
    await gitOk(repoDir, ["worktree", "remove", "--force", "--force", sourceWorktree]);
    await gitOk(repoDir, ["worktree", "prune"]);
    await rm(sourceWorktree, { recursive: true, force: true });
    try {
      await git(repoDir, [
        "worktree",
        "add",
        "--detach",
        sourceWorktree,
        target,
      ]);
      // Protect the persistent build context from pruneStaleIssueClones's
      // cache-wide prune and from an equivalent command run by hand.
      await git(repoDir, ["worktree", "lock", sourceWorktree]);
    } catch (err) {
      throw new SandbarError(
        `Failed to create the source worktree at ${sourceWorktree} ` +
          `(${target}), which is the build context for config.images: ${detail(err)}`,
        { cause: err },
      );
    }
    return sourceWorktree;
  }

  try {
    // Idempotent and best-effort on reuse: an already-locked worktree makes
    // `git worktree lock` fail, but the invariant is already satisfied.
    await gitOk(repoDir, ["worktree", "lock", sourceWorktree]);
    await git(sourceWorktree, ["reset", "--hard", "-q", target]);
    await git(sourceWorktree, ["clean", "-ffdx", "-q"]);
  } catch (err) {
    throw new SandbarError(
      `Failed to reset the source worktree at ${sourceWorktree} to ${target}: ${detail(err)}`,
      { cause: err },
    );
  }
  return sourceWorktree;
}
