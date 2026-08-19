// The disposable state directory, and the bare object cache inside it (#38).
//
// ---------------------------------------------------------------------------
// What changed and why
// ---------------------------------------------------------------------------
// Sandbar used to operate ON the directory `config.cwd` names: it created the
// issue branches there, added the worktrees there, ran `gh` there, and — via
// preflight's `deleteMergedIssueBranches` — ran `git branch -D` there. That
// forced every consumer to hand sandbar a checkout it did not otherwise want:
// a second clone, machine-managed, that a human must not stand in. Two
// symptoms followed. You had to launch from it (before #34, git and `gh`
// inherited `process.cwd()`), and your credentials had to live in it
// (`envFilePath` resolved against it).
//
// The fix is to stop needing a checkout at all. Nothing sandbar keeps locally
// is authoritative — GitHub Issues is the tracker, branches are pushed at
// finalise, merged work is on `origin/<sourceBranch>` — so the local state is
// `node_modules`-shaped: reproducible, deletable, and therefore allowed to sit
// gitignored inside the operator's REAL checkout:
//
//   <hostCwd>/                     the operator's own checkout. Sandbar reads
//     sandbar.config.mjs           it (git identity, `copyToWorktree`) and
//     .sandbar/                    clones it once. It never writes to it.
//       repo.git/                  <- every git call runs HERE (gh names its
//                                     own repo with --repo, #34)
//       worktrees/source/          <- image build context, at origin/<branch>
//       worktrees/issue-<n>-<slug>/
//       worktrees/merger/
//       run.lock  run.pid  logs/
//
// `repo.git` is a BARE repo: `git worktree add` needs an object store and a ref
// namespace, and the merge phase and preflight's branch classification need the
// objects offline — none of them needs a working tree. Making it bare is not
// tidiness. It is what makes the three genuinely-destructive operations
// (`branch -D`, `worktree remove --force`, force-pushing the scratch
// integration ref) provably unable to touch the operator's repo, because the
// repo they run in holds nothing of the operator's.
//
// ---------------------------------------------------------------------------
// How the cache is created
// ---------------------------------------------------------------------------
// `git clone --bare <hostCwd> <repoDir>`, then `origin` is retargeted to
// whatever URL the host checkout's own `origin` carries. Two consequences,
// both deliberate:
//
//   - No config names the remote. `config.cwd` is a real checkout now, so the
//     remote is derivable, and a derived value cannot drift from the repo the
//     config file sits in. A `remoteUrl` knob could disagree with `cwd`, and
//     the failure would be silent: sandbar would merge the right branches into
//     the wrong repo.
//   - The clone is local, so git hardlinks the objects. A multi-gigabyte repo
//     costs a few hundred milliseconds and no network, and `git gc` in either
//     repo is safe (a hardlink keeps the file alive).
//
// `remote.origin.fetch` is then set EXPLICITLY to
// `+refs/heads/*:refs/remotes/origin/*`. `git clone --bare` sets no fetch
// refspec at all, and `--mirror` (the other obvious spelling) maps the remote's
// heads onto local `refs/heads/*` and produces no `refs/remotes/origin/*`
// whatsoever. Sandbar depends on those remote-tracking refs everywhere:
// issue branches seed from `origin/<sourceBranch>`, the merger worktree is
// detached at it, `branchIsContainedInOrigin` is an ancestry test against it,
// and preflight's merged-ness check falls back to it.
//
// Local `refs/heads/*` copied in by the clone are DELETED. The cache's local
// branch namespace belongs to sandbar alone — `sandbar/issue-*` and nothing
// else — and a copy of the operator's branches there is not merely untidy:
// preflight globs `refs/heads/sandbar/issue-*` and refuses to start on an
// unmerged one, so an operator who happened to have such a branch checked out
// for review would get a hard refusal about a branch sandbar had itself
// imported. It also removes a stale local `<sourceBranch>` from the merged-ness
// test, leaving `origin/<sourceBranch>` — the ref that actually decides — as
// the only answer. The resulting unborn HEAD is fine for every operation
// sandbar performs (pinned in repo-cache-git.test.ts: `worktree add` names its
// commit-ish explicitly in every case).
//
// Creation is ATOMIC — prepared under `repo.git.incoming`, stamped, and only
// then renamed into place — so "the cache is there" and "the cache went
// through every preparation step" cannot come apart. The stamp is what makes
// the second fact checkable: a half-built cache is a perfectly valid bare
// repository, so being one is not evidence of having been prepared. See
// `ensureRepoCache` and `isPreparedCache`.
//
// ---------------------------------------------------------------------------
// Never ask git WHICH repository this is; tell it
// ---------------------------------------------------------------------------
// Every path in the layout lives inside the operator's checkout, so `git
// rev-parse --git-dir` — which discovers by walking UP — answers `0` and
// `<hostCwd>/.git` for any of them that exists but is not a repository. Used
// as an existence probe it reports the cache as present and hands the
// operator's own repo to `branch -D`, `worktree remove --force`, `reset
// --hard` and the force-pushed integration ref: the entire safety argument for
// a bare cache, inverted, in the one state (`rm -rf .sandbar` interrupted) the
// documentation invites. So the probes NAME what they are asking about —
// `--git-dir=<path>` for the cache, `--git-common-dir` compared against it for
// a worktree — and never let discovery pick the answer.

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { SandbarError } from "./errors.js";

const exec = promisify(execFile);

// The bare cache's directory name inside <workDir>. `.git`-suffixed so a human
// who opens the state directory can see what it is at a glance.
export const CACHE_DIR_NAME = "repo.git";

// The persistent worktree the base images are built from. A NAME, not a
// branch: it is detached at origin/<sourceBranch> and reset there every run.
export const SOURCE_WORKTREE_NAME = "source";

// Every path sandbar owns, derived from the two knobs a consumer sets.
//
// Threaded as one object rather than as `cwd` + `workDir` (#38). The two
// directories are no longer the same thing, and the field that used to be
// called `cwd` was about to mean "the repo commands run in" in some call sites
// and "the root the worktree paths hang off" in others — which is exactly the
// confusion #34 spent a release removing.
export type RepoLayout = {
  // The operator's checkout. Sandbar READS it (git identity, `copyToWorktree`
  // sources, the one-time clone) and never writes to it. The soft
  // local-ahead-of-origin warning is the only check that still looks here, and
  // it looks here on purpose — see preflight.ts.
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
  } catch {
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
  } catch {
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
  } catch {
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
  } catch {
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
    await gitOk(repoDir, ["worktree", "remove", "--force", sourceWorktree]);
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
