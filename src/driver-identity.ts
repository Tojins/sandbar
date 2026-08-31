// What is driving this run (#69).
//
// A run used to record nothing about the code producing its verdicts. That
// matters because the driver is built from the operator's WORKING TREE:
// `npm run sandbar` is `git pull --ff-only && npm run build && node
// dist/cli.js`, and `build` is `rm -rf dist && tsc` over `src/` — uncommitted
// edits included. The config file is the same story and worse: it is a PROGRAM
// that is `import()`ed (cli.ts), and it carries `gateStack`, so the thing that
// judges every branch is also whatever happened to be on disk. On 2026-08-31 a
// series ran with uncommitted edits to `src/gate-stack.ts` and to
// `sandbar.config.mjs`, and nothing in the logs said so.
//
// This module does not fix that coupling — #66 does. It makes it VISIBLE, which
// is the cheapest possible mitigation and outlives the fix: after #66 this same
// line is how an operator confirms the driver really is the pinned version.
//
// A fact, never a warning. "dirty" does not block a run and is not phrased as
// though it should — an operator iterating deliberately is a supported case,
// and a line that nags is a line that gets ignored.
//
// TWO TREES, because there are two of them and they are not always the same
// repository. The driver's package root (where `dist/` sits) and the directory
// the config file sits in. Running on itself (#39) they are one checkout; for a
// host repo the driver is under `node_modules/` and the config is in the host's
// own checkout.
//
// Which is exactly why every read is guarded by `check-ignore`. `git -C
// node_modules/@offergeist/sandbar rev-parse HEAD` does not fail — it answers
// with the HOST repo's HEAD, a true sha about an entirely different repository,
// and printing that after the words "built from" would be worse than printing
// nothing. So: a directory the enclosing repo IGNORES reports `unknown`, and
// only a directory whose content that repo actually tracks gets to have its
// HEAD named. A non-repository falls out the same way — check-ignore's 128 is
// not "ignored", but the `rev-parse` behind it fails and the state is unknown
// anyway. `driver-identity-git.test.ts` pins the git facts underneath.
//
// DIRTY INCLUDES UNTRACKED, and the argv is imported from `git-ops.ts` rather
// than spelled again: `tsc` compiles everything under `src/`, so an untracked
// `src/*.ts` is in `dist/` and on no commit — the sharpest form of the very
// thing this line exists to show. That import is also what keeps
// `status.showUntrackedFiles=normal` from being re-forgotten in a second place;
// the reason it is load-bearing is `git-ops.ts`'s to state.
//
// The read happens at RUN START, and says so by being one line printed there.
// That is the build's tree in every shape the launcher produces — it builds
// immediately before running, and rebuilds on each relaunch (#65) — but a
// `dist/` from an older build against a tree since changed is NOT detected.
// A build stamp would close that; it would also be a second artefact and a
// second mechanism to keep true, for a coupling #66 removes outright.
//
// Total, by construction: every git call is `.then(ok, fail)`, so nothing here
// rejects and no field can stop a run. Everything degrades to `unknown`. No
// network, and a timeout on each call so a pathological repository costs a
// missing field rather than a stalled startup.

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DIRTY_STATUS_ARGV } from "./git-ops.js";
import { sandbarVersion } from "./version.js";

const execFileAsync = promisify(execFile);

// Local git only, and the whole point is that it is unmissable in a startup
// path. A repository big or busy enough to take longer than this to answer
// `status` costs the field, not the run.
const GIT_TIMEOUT_MS = 10_000;

// `status --porcelain` prints a line per dirty path, and only its emptiness is
// read. Node's 1 MiB default would turn a very dirty tree into `unknown`, which
// is the one answer that tree is definitely not.
const MAX_BUFFER = 16 * 1024 * 1024;

// "Is this directory's content ignored by the repository that encloses it?" —
// the node_modules guard above. `-q` because only the exit code is read.
const IGNORED_HERE_ARGV: readonly string[] = ["check-ignore", "-q", "--", "."];

// One tree's answer. `null` in either field is "could not be determined", which
// is a different claim from `false` and prints differently.
export type TreeState = {
  // The full sha, never abbreviated: the point of the line is attribution
  // months later, and an abbreviation that was unique in August is a lottery
  // ticket in December.
  readonly commit: string | null;
  readonly dirty: boolean | null;
};

export const UNKNOWN_TREE: TreeState = { commit: null, dirty: null };

export type DriverIdentity = {
  readonly version: string;
  // The package root — the directory `dist/` was built into.
  readonly codePath: string;
  readonly code: TreeState;
  // The resolved path of the config FILE (its directory is what `config` is
  // about). Null when `run()` was called programmatically, with no file behind
  // the config at all.
  readonly configPath: string | null;
  readonly config: TreeState;
};

// Injected in tests, and only there. `cwd` NAMES the repository every call runs
// against (#34); nothing here inherits `process.cwd()`.
export type GitExec = (
  cwd: string,
  args: readonly string[],
) => Promise<string>;

const defaultGit: GitExec = async (cwd, args) => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
};

// The package root, resolved the same way `version.ts` resolves
// `../package.json`: one level up from this module, which is `dist/` when the
// bin is running and `src/` when the suite is.
export function driverCodePath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export async function readTreeState(
  dir: string,
  git: GitExec = defaultGit,
): Promise<TreeState> {
  const ignored = await git(dir, IGNORED_HERE_ARGV).then(
    () => true,
    () => false,
  );
  if (ignored) return UNKNOWN_TREE;
  const [commit, dirty] = await Promise.all([
    git(dir, ["rev-parse", "HEAD"]).then(
      (out) => out.trim() || null,
      () => null,
    ),
    git(dir, DIRTY_STATUS_ARGV).then(
      (out) => out.split("\n").some((line) => line.trim().length > 0),
      () => null,
    ),
  ]);
  return { commit, dirty };
}

export type ReadDriverIdentityArgs = {
  readonly configPath: string | null;
  readonly codePath?: string;
  readonly version?: string;
  readonly git?: GitExec;
};

export async function readDriverIdentity(
  args: ReadDriverIdentityArgs,
): Promise<DriverIdentity> {
  const git = args.git ?? defaultGit;
  const codePath = args.codePath ?? driverCodePath();
  const { configPath } = args;
  const [code, config] = await Promise.all([
    readTreeState(codePath, git),
    configPath === null
      ? Promise.resolve(UNKNOWN_TREE)
      : readTreeState(dirname(configPath), git),
  ]);
  return {
    version: args.version ?? sandbarVersion(),
    codePath,
    code,
    configPath,
    config,
  };
}

function formatTreeState(state: TreeState): string {
  const dirty =
    state.dirty === null ? "dirty-unknown" : state.dirty ? "dirty" : "clean";
  return `@${state.commit ?? "unknown"} ${dirty}`;
}

// One line, and one line only. Pure, so what the run prints is table-testable
// without a repository behind it.
export function formatDriverIdentity(id: DriverIdentity): string {
  return [
    `Driver: sandbar ${id.version}`,
    `built from ${id.codePath} ${formatTreeState(id.code)}`,
    id.configPath === null
      ? "config none (run() called with no config file)"
      : `config ${id.configPath} ${formatTreeState(id.config)}`,
  ].join(" · ");
}
