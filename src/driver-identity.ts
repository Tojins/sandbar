// What is driving this run (#69).
//
// The opening run event attributes both executable code and configuration.
// They are separate inputs: a normal daemon uses an exact-tag package installed
// under its private installation directory and a config beside that install,
// while local/ad-hoc use may run a build and config from development trees.
// The version identifies installed code whose tree cannot be attributed; a
// commit and dirty state identify a development build. The config gets its own
// tree state because a dirty config program changes the gate and orchestration
// contract just as surely as dirty driver code does.
//
// A fact, never a warning or refusal. Dirty local iteration is supported, but
// the event must make it visible months later. Every field degrades to
// `unknown`, and all git calls are local and time-bounded, so attribution can
// never prevent a run.
//
// Each tree read is guarded by `check-ignore`. Running `git -C
// node_modules/sandbar rev-parse HEAD` otherwise returns the enclosing
// consumer's HEAD, a true sha for the wrong code. Ignored package content and
// ordinary non-repository installation directories therefore report unknown.
// Dirty includes untracked paths via `DIRTY_STATUS_ARGV`, because an untracked
// `src/*.ts` can be compiled into the code being executed.

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
