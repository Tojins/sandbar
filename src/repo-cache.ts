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
//       repo.git/                  <- every git and gh call runs HERE
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

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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
  // The bare cache. The `cwd` of every git and gh call sandbar makes, with the
  // documented exception above.
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

  const exists =
    existsSync(repoDir) && (await gitOk(repoDir, ["rev-parse", "--git-dir"]));

  if (!exists) {
    await mkdir(stateDir, { recursive: true });
    console.log(
      `Creating sandbar's object cache at ${repoDir} (one-time; cloned from ` +
        `${hostCwd}, so it is local and hardlinked)...`,
    );
    try {
      await git(hostCwd, ["clone", "--bare", "--quiet", hostCwd, repoDir]);
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
      const { stdout } = await git(repoDir, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/",
      ]);
      for (const ref of stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
        await git(repoDir, ["update-ref", "-d", ref]);
      }
    } catch (err) {
      throw new SandbarError(
        `Failed to clear the imported local branches from ${repoDir}: ${detail(err)}`,
        { cause: err },
      );
    }
  }

  // Every run, not just on creation: an operator who retargets their own
  // `origin` must not end up with a cache still pushing at the old one, and a
  // cache created by an older sandbar may carry no refspec at all.
  try {
    await git(repoDir, ["remote", "set-url", "origin", url]);
    await git(repoDir, [
      "config",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
  } catch (err) {
    throw new SandbarError(
      `Failed to point sandbar's object cache at ${url}: ${detail(err)}`,
      { cause: err },
    );
  }

  if (!exists) {
    // Populate refs/remotes/origin/* once. The objects are already here from
    // the local clone, so this is a ref negotiation rather than a download —
    // but it is what turns `origin/<sourceBranch>` into a real ref, which
    // everything downstream reads.
    try {
      await git(repoDir, ["fetch", "origin", "--prune", "--quiet"]);
    } catch (err) {
      throw new SandbarError(
        `Failed the initial fetch of ${url} into sandbar's object cache: ${detail(err)}`,
        { cause: err },
      );
    }
  }
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

  const registered =
    existsSync(sourceWorktree) &&
    (await gitOk(sourceWorktree, ["rev-parse", "--git-dir"]));

  if (!registered) {
    // A leftover directory with no worktree registration (a killed run, a
    // partially-removed state dir) blocks `worktree add`. Clear both sides.
    await gitOk(repoDir, ["worktree", "remove", "--force", sourceWorktree]);
    await gitOk(repoDir, ["worktree", "prune"]);
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
