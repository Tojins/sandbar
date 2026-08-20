// In-house replacement for the @ai-hero/sandcastle subset sandbar consumes.
//
// Drops the ~72 MB Effect runtime. Reverse-engineered from @ai-hero/sandcastle
// v0.7.0 (historical provenance only — that package is no longer a dependency);
// the authoritative behaviour notes live in docs/agent-sandbox/01-07. This
// module reproduces ONLY sandbar's exercised path: a bind-mount podman
// provider, an explicit pre-existing branch, `maxIterations: 1`, no session
// capture. The public surface matches the five symbols sandbar imported
// (`createSandbox`,
// `podman`, `claudeCode`, types `Sandbox`/`SandboxHooks`) so call sites change
// only their import path.
//
// Load-bearing 0.7.0 behaviours that look optional but are NOT (a naive port
// re-introduces a crash/hang on sandbar's parallel `Promise.allSettled` path):
//   F1 — `exec` retains a bounded 64 KiB rolling TAIL (`BoundedTail`), never an
//        unbounded array; an unbounded join throws RangeError inside close() on
//        long runs and tears down the whole cycle.
//   F2 — git-setup execs retry on exit 126/137 only (transient container-exec
//        races under parallelism); genuine failures fail fast.
//   F3 — ONE process-wide shutdown registration fans out to a Set of teardowns;
//        not a listener per sandbox (MaxListenersExceededWarning past ~5).
//        Since #35 that registration is an `onCleanup` entry rather than this
//        module's own SIGINT/SIGTERM handlers, which exited the process out
//        from under the shared async cleanup — see the shutdown registry.
//   F4 — a failure after worktree create removes the worktree before rethrowing.
//   F5 — two-phase agent timeout: once the completion signal is seen, a short
//        grace timer resolves the run SUCCESSFULLY with the collected commits
//        instead of a 600 s idle error that discards them.
//   F7 — every host git invocation runs under LC_ALL=C (locale-stable stderr).
//   F8 — the container runs with `--init`. The entrypoint is `sleep infinity`,
//        which reaps nothing, so without it every process an agent orphans
//        zombies for the lifetime of the issue (#42). See `sandboxRunArgs`.
//
// safe.directory is set per-run() (not just at create time): the bind-mounted
// worktree is owned by a different UID, and sandbar's common case has no hooks.

import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, realpath, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { onCleanup } from "./cleanup.js";
import { resolveSandboxEnv } from "./env.js";
import { RESOURCE_PREFIX } from "./naming.js";
import type { RepoLayout } from "./repo-cache.js";

// ---------------------------------------------------------------------------
// Constants (copy exactly — matched by sandbar code outside this boundary)
// ---------------------------------------------------------------------------

export const SANDBOX_REPO_DIR = "/home/agent/workspace";
const SANDBOX_HOMEDIR = "/home/agent";
const CONTAINER_NAME_PREFIX = RESOURCE_PREFIX;

export const MAX_TAIL_CHARS = 64 * 1024;
export const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 10 * 60;
export const DEFAULT_COMPLETION_TIMEOUT_SECONDS = 60;

const NO_CONFIG_LOCK_FLAGS = [
  "-c",
  "branch.autoSetupMerge=false",
  "-c",
  "push.autoSetupRemote=false",
];

const WORKTREE_TIMEOUT_MS = 30_000;
const COPY_TO_WORKTREE_TIMEOUT_MS = 60_000;
const GIT_SETUP_TIMEOUT_MS = 10_000;
const COMMIT_COLLECTION_TIMEOUT_MS = 30_000;
const HOOK_TIMEOUT_MS = 60_000;
const GIT_SETUP_MAX_RETRIES = 2;
const GIT_SETUP_RETRY_DELAY_MS = 250;
const TRANSIENT_EXEC_EXIT_CODES = new Set([126, 137]);

// ---------------------------------------------------------------------------
// Public types (match the upstream sandbox surface sandbar imported)
// ---------------------------------------------------------------------------

export type SandboxHooks = {
  host?: {
    onWorktreeReady?: ReadonlyArray<{ command: string; timeoutMs?: number }>;
    onSandboxReady?: ReadonlyArray<{ command: string; timeoutMs?: number }>;
  };
  sandbox?: {
    onSandboxReady?: ReadonlyArray<{
      command: string;
      sudo?: boolean;
      timeoutMs?: number;
    }>;
  };
};

export type ParsedStreamEvent =
  | { type: "text"; text: string }
  | { type: "result"; result: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "session_id"; sessionId: string };

export type AgentProvider = {
  readonly name: string;
  readonly env: Record<string, string>;
  buildPrintCommand(o: {
    prompt?: string;
    dangerouslySkipPermissions?: boolean;
  }): { command: string; stdin?: string };
  parseStreamLine(line: string): ParsedStreamEvent[];
};

export type ClaudeCodeOptions = {
  effort?: "low" | "medium" | "high" | "max";
  env?: Record<string, string>;
};

export type Mount = {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly?: boolean;
};

type ExecOptions = {
  stdin?: string;
  cwd?: string;
  sudo?: boolean;
  onLine?: (line: string) => void;
};

type ExecResult = { stdout: string; stderr: string; exitCode: number };

type SandboxHandle = {
  readonly worktreePath: string;
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  close(): Promise<void>;
};

export type ProviderCreateOptions = {
  readonly worktreePath: string;
  readonly hostRepoPath: string;
  readonly mounts: readonly Mount[];
  readonly env: Record<string, string>;
};

export type SandboxProvider = {
  readonly tag: "bind-mount";
  readonly name: string;
  readonly env: Record<string, string>;
  readonly sandboxHomedir: string;
  create(o: ProviderCreateOptions): Promise<SandboxHandle>;
};

export type PodmanOptions = {
  imageName?: string;
  // Prefix for the container name (`<namePrefix><uuid>`). Sandbar passes its
  // run scope's prefix so the orphan sweeper, which force-removes by prefix,
  // can never see a concurrent run's sandbox (#28). Defaults to the bare
  // RESOURCE_PREFIX for standalone use.
  namePrefix?: string;
  selinuxLabel?: string | false;
  userns?: string | false;
  containerUid?: number;
  containerGid?: number;
  network?: string | string[];
  maxOutputTailChars?: number;
  cpus?: number;
  groups?: Array<string | number>;
  devices?: string[];
  env?: Record<string, string>;
};

export type RunOptions = {
  readonly agent: AgentProvider;
  readonly prompt?: string;
  readonly maxIterations?: number;
  readonly name?: string;
  readonly completionSignal?: string | string[];
  readonly idleTimeoutSeconds?: number;
  readonly completionTimeoutSeconds?: number;
};

export type SandboxRunResult = {
  readonly stdout: string;
  readonly commits: { sha: string }[];
  readonly iterations: unknown[];
  readonly completionSignal?: string;
};

export interface Sandbox {
  readonly branch: string;
  readonly worktreePath: string;
  run(o: RunOptions): Promise<SandboxRunResult>;
  close(): Promise<{ preservedWorktreePath?: string }>;
}

export type CreateSandboxOptions = {
  branch: string;
  baseBranch?: string;
  sandbox: SandboxProvider;
  // Every path this module needs, as one object (#38). `repoDir` is the bare
  // cache every git call runs in; `worktreesDir` is where the managed worktree
  // goes, which is BESIDE the cache and not inside it; `hostCwd` is the
  // operator's checkout, read for the git identity and for `copyToWorktree`
  // sources and written to never. Required rather than defaulted for the
  // reason #34 made every other cwd required: an omitted path is invisible at
  // the call site and wrong only on the hosts that configure one.
  layout: RepoLayout;
  hooks?: SandboxHooks;
  copyToWorktree?: string[];
  // The declared credential record (`config.env`). Its keys are the allowlist
  // that crosses into the container, each falling back to `process.env[key]`
  // when empty — see env.ts. A VALUE since #38: sandbar names no env file, and
  // there is no hidden `<cwd>/.sandbar/.env` second source to fall through to.
  env: Record<string, string>;
  // Worktree already created by prepareWorktree(). When set, createSandbox
  // skips prune/create/copyToWorktree/onWorktreeReady (all done by
  // prepareWorktree) and only brings up the container. Lets the caller learn
  // the worktree path BEFORE parallelizing container bringup against other
  // work that needs it (the gate stack's worktree-relative mounts and
  // mountWorktree, #20/#24). Ownership stays with the caller: createSandbox
  // never removes a prepared worktree on bringup failure (the stack may be
  // concurrently bind-mounting from it), and passing copyToWorktree alongside
  // is a loud error — the copy
  // belongs in prepareWorktree, silently skipping it would be worse.
  preparedWorktreePath?: string;
};

export type PrepareWorktreeOptions = {
  branch: string;
  baseBranch?: string;
  layout: RepoLayout;
  copyToWorktree?: string[];
  // Only host.onWorktreeReady runs here; sandbox-side hooks need the
  // container and stay in createSandbox.
  hooks?: SandboxHooks;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AgentError extends Error {}

export class AgentIdleTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(message: string, timeoutMs: number) {
    super(message);
    this.timeoutMs = timeoutMs;
  }
}

class WorktreeError extends Error {}

class ExecError extends Error {
  readonly command: string;
  readonly exitCode: number;
  constructor(command: string, exitCode: number, stderr: string) {
    super(`Command failed (exit ${exitCode}): ${command}\n${stderr}`);
    this.command = command;
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// BoundedTail (F1) — verbatim from the upstream boundedTail.ts
// ---------------------------------------------------------------------------

export class BoundedTail {
  private items: string[] = [];
  private totalChars = 0;
  private readonly maxChars: number;
  private readonly separator: string;

  constructor(maxChars = MAX_TAIL_CHARS, separator = "") {
    this.maxChars = maxChars;
    this.separator = separator;
  }

  push(item: string): void {
    const bounded =
      item.length > this.maxChars ? item.slice(item.length - this.maxChars) : item;
    this.totalChars += bounded.length + (this.items.length > 0 ? this.separator.length : 0);
    this.items.push(bounded);
    while (this.totalChars > this.maxChars && this.items.length > 1) {
      const dropped = this.items.shift() as string;
      this.totalChars -= dropped.length + this.separator.length;
    }
  }

  toString(): string {
    return this.items.join(this.separator);
  }
}

// ---------------------------------------------------------------------------
// Stream-json parsing + claudeCode agent — verbatim from AgentProvider.ts
// ---------------------------------------------------------------------------

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

const TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Agent: "description",
};

export const parseStreamJsonLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    // JSON.parse yields `any`; the upstream parser is intentionally untyped.
    const obj = JSON.parse(line) as any;
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      const events: ParsedStreamEvent[] = [];
      const texts: string[] = [];
      for (const block of obj.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          block.input !== undefined
        ) {
          const argField = TOOL_ARG_FIELDS[block.name];
          if (argField === undefined) continue;
          const argValue = block.input[argField];
          if (typeof argValue !== "string") continue;
          if (texts.length > 0) {
            events.push({ type: "text", text: texts.join("") });
            texts.length = 0;
          }
          events.push({ type: "tool_call", name: block.name, args: argValue });
        }
      }
      if (texts.length > 0) {
        events.push({ type: "text", text: texts.join("") });
      }
      return events;
    }
    if (obj.type === "result" && typeof obj.result === "string") {
      return [{ type: "result", result: obj.result }];
    }
    if (
      obj.type === "system" &&
      obj.subtype === "init" &&
      typeof obj.session_id === "string"
    ) {
      return [{ type: "session_id", sessionId: obj.session_id }];
    }
  } catch {
    // Stream lines are routinely partial; swallow → [], never throw.
  }
  return [];
};

export const claudeCode = (
  model: string,
  options?: ClaudeCodeOptions,
): AgentProvider => ({
  name: "claude-code",
  env: options?.env ?? {},
  buildPrintCommand({ prompt, dangerouslySkipPermissions }) {
    const skipPerms = dangerouslySkipPermissions
      ? " --dangerously-skip-permissions"
      : "";
    const effortFlag = options?.effort ? ` --effort ${options.effort}` : "";
    return {
      command: `claude --print --verbose${skipPerms} --output-format stream-json --model ${shellEscape(model)}${effortFlag} -p -`,
      stdin: prompt,
    };
  },
  parseStreamLine(line) {
    return parseStreamJsonLine(line);
  },
});

// ---------------------------------------------------------------------------
// Shutdown registry (F3) — ONE registration process-wide, into the SHARED
// cleanup registry
// ---------------------------------------------------------------------------
//
// F3 itself is unchanged: one process-wide registration fans out to a Set of
// teardowns, never one listener per sandbox (MaxListenersExceededWarning past
// ~5). What moved is WHERE that registration goes (#35).
//
// This module used to install its own SIGINT/SIGTERM handlers whose last act
// was a synchronous `process.exit(1)`. cleanup.ts installs sandbar's handlers
// first — `installCleanupTraps()` runs in `run()` before any sandbox exists —
// and node runs listeners in registration order, so on Ctrl-C the shared
// handler went first, started the ASYNC `runCleanup()` and returned at its
// first await; this handler then ran and exited the process out from under it.
// Everything the shared registry holds was skipped: the per-issue pods,
// networks and containers, the merger worktree, the run log's terminal write,
// the lock release. And the failure was quiet precisely because the competing
// handler did its own job first — the one resource class it could see was the
// one class that survived.
//
// So there is no signal handler here. The teardowns go into `onCleanup`, whose
// handler owns the exit and its code. Registered ONCE, lazily: that registry
// never forgets an action, so an entry per sandbox would grow without limit —
// ensure-images.ts's build reaper is the same shape for the same reason.
//
// `process.on("exit")` stays. It is synchronous and last-resort by nature, and
// it is what covers a bare `process.exit` from elsewhere in the run, which
// runs no cleanup action at all. Teardowns are therefore DRAINED rather than
// iterated: a signal now reaches them twice — once through `runCleanup`, then
// again through the `exit` event that `runCleanup`'s own `process.exit` fires
// — and running them twice would `podman rm -f` a container that is already
// gone and print the worktree-preserved notice to the operator twice.
//
// The dependency this creates is on `installCleanupTraps()` having run, which
// `run()` does before the first sandbox. Deliberately NOT called from here:
// those traps also catch uncaughtException/unhandledRejection and exit the
// process, which is entry-point policy, and this module is imported by tests.

const teardownCallbacks = new Set<() => void>();
let exitHookInstalled = false;
let cleanupRegistered = false;

const runTeardowns = (): void => {
  // Drained, not iterated — see the note above on arriving twice.
  for (const teardown of [...teardownCallbacks]) {
    teardownCallbacks.delete(teardown);
    try {
      teardown();
    } catch {
      // best-effort
    }
  }
};
const handleExit = (): void => runTeardowns();
const installHooks = (): void => {
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    onCleanup(runTeardowns);
  }
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", handleExit);
};
function removeExitHook(): void {
  if (!exitHookInstalled) return;
  exitHookInstalled = false;
  process.removeListener("exit", handleExit);
}
export const registerShutdown = (teardown: () => void): (() => void) => {
  teardownCallbacks.add(teardown);
  installHooks();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    teardownCallbacks.delete(teardown);
    // The `onCleanup` entry cannot be withdrawn and is not withdrawn: it fans
    // out over a set that is empty by then, which costs nothing.
    if (teardownCallbacks.size === 0) removeExitHook();
  };
};

// ---------------------------------------------------------------------------
// Mount formatting / image naming — verbatim from mountUtils.ts
// ---------------------------------------------------------------------------

export const defaultImageName = (repoDir: string): string => {
  const dirName = repoDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sandbar:${sanitized || "local"}`;
};

const formatVolumeMount = (
  mount: Mount,
  selinuxLabel: string | false,
): string => {
  const base = `${mount.hostPath}:${mount.sandboxPath}`;
  const options = [mount.readonly ? "ro" : undefined, selinuxLabel || undefined]
    .filter((o): o is string => o !== undefined)
    .join(",");
  return options ? `${base}:${options}` : base;
};

// ---------------------------------------------------------------------------
// Git mount resolution
// ---------------------------------------------------------------------------
//
// A linked worktree's `.git` is a FILE holding an absolute gitlink into the
// repo's common directory, so in-container git can only follow it if that
// directory is mounted at its own absolute host path. The worktree itself is
// already mounted (at SANDBOX_REPO_DIR), so the common dir is the only extra.
//
// ASK GIT (#38 item 6). This used to derive the path structurally — `<repo>/
// .git`, or the gitlink's target up two levels — which hardcoded the non-bare
// layout and stopped being true the moment the repo became `repo.git`. There is
// a command whose entire job is this question, it answers it for a bare repo, a
// normal repo and a linked worktree of either, and the mount SHAPE (identity,
// at the same absolute path) was already right. Only the discovery was wrong.
//
// `--git-common-dir` may answer relatively (a plain `.git` in a normal
// checkout), so it is resolved against the worktree before being used as a
// mount source — an unresolved relative path would be a podman error, not a
// wrong mount, but the failure would name the worktree rather than the repo.
const resolveGitMounts = async (worktreePath: string): Promise<Mount[]> => {
  const commonDir = (
    await execGit(["rev-parse", "--git-common-dir"], worktreePath)
  ).trim();
  // Unreachable against a working git, and deliberately not softened to `[]`:
  // an empty answer means the container gets no repo mount, which is the same
  // silent "not a git repository" the swallow at the call site used to produce.
  if (!commonDir) {
    throw new WorktreeError(
      `git rev-parse --git-common-dir returned nothing for ${worktreePath}`,
    );
  }
  const abs = resolve(worktreePath, commonDir);
  return [{ hostPath: abs, sandboxPath: abs }];
};

// ---------------------------------------------------------------------------
// Host git + small async helpers
// ---------------------------------------------------------------------------

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(onTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// Host-side git, LC_ALL=C (F7). Resolves trimmed-nothing stdout; rejects
// WorktreeError carrying stderr on non-zero exit.
const execGit = (args: string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, LC_ALL: "C" }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new WorktreeError(stderr?.trim() || error.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });

const gitOrEmpty = (args: string[], cwd: string): Promise<string> =>
  execGit(args, cwd)
    .then((s) => s.trim())
    .catch(() => "");

// ---------------------------------------------------------------------------
// WorktreeManager — verbatim semantics from WorktreeManager.ts (no Effect)
// ---------------------------------------------------------------------------

type WorktreeEntry = { path: string; branch: string | null };

const normalizePath = (p: string): string => p.replace(/\\/g, "/");

const listWorktrees = async (repoDir: string): Promise<WorktreeEntry[]> => {
  const output = await execGit(["worktree", "list", "--porcelain"], repoDir);
  const entries: WorktreeEntry[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (currentPath !== null) {
        entries.push({ path: currentPath, branch: currentBranch });
      }
      currentPath = line.slice("worktree ".length).trim();
      currentBranch = null;
    } else if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch refs/heads/".length).trim();
    }
  }
  if (currentPath !== null) {
    entries.push({ path: currentPath, branch: currentBranch });
  }
  return entries;
};

// Branch first, then target-path fallback (catches detached-HEAD reuse).
const findCollidingWorktree = (
  existing: WorktreeEntry[],
  branch: string,
  worktreePath: string,
): WorktreeEntry | undefined =>
  existing.find((wt) => wt.branch === branch) ??
  existing.find((wt) => normalizePath(wt.path) === normalizePath(worktreePath));

// `-c status.showUntrackedFiles=normal`: a bare `git status --porcelain` honours
// that setting, and a repo (or user) that sets it to `no` would make this report
// a worktree holding a forgotten `git add` as clean — so the worktree gets
// DELETED on close with the agent's uncommitted work in it. Same reasoning as
// `dirtyWorktreePaths` in git-ops.ts; see the long comment there.
const hasUncommittedChanges = async (worktreePath: string): Promise<boolean> => {
  const output = await execGit(
    ["-c", "status.showUntrackedFiles=normal", "status", "--porcelain"],
    worktreePath,
  );
  return output.trim().length > 0;
};

// Clean-reuse refresh: ff-only from origin, gated (on-branch, fetch-ok,
// strictly-behind); never reset --hard. Optional on sandbar's path.
const fastForwardFromOrigin = async (
  worktreePath: string,
  branch: string,
): Promise<void> => {
  const headRef = await gitOrEmpty(["symbolic-ref", "--quiet", "HEAD"], worktreePath);
  if (headRef !== `refs/heads/${branch}`) {
    console.log(
      `Reusing worktree at ${worktreePath} (branch '${branch}') — HEAD is not on '${branch}', skipping origin refresh`,
    );
    return;
  }
  try {
    await execGit([...NO_CONFIG_LOCK_FLAGS, "fetch", "origin", branch], worktreePath);
  } catch {
    console.log(
      `Could not fetch from origin (reusing worktree at ${worktreePath} as-is, branch '${branch}')`,
    );
    return;
  }
  const before = await gitOrEmpty(["rev-parse", "HEAD"], worktreePath);
  try {
    await execGit(
      [...NO_CONFIG_LOCK_FLAGS, "merge", "--ff-only", `origin/${branch}`],
      worktreePath,
    );
  } catch {
    console.log(
      `Branch '${branch}' has diverged from origin (reusing worktree at ${worktreePath} as-is)`,
    );
    return;
  }
  const after = await gitOrEmpty(["rev-parse", "HEAD"], worktreePath);
  if (before && after && before !== after) {
    console.log(
      `Fast-forwarded worktree at ${worktreePath} (branch '${branch}') to origin/${branch}`,
    );
  }
};

// Sandbar always passes an explicit, pre-existing branch. Collision → reuse if
// managed (else throw); no collision → `worktree add <path> <branch>` with the
// config-lock flags. The `-b` fork fallback is kept for the (unreached) case of
// a missing branch.
const worktreeCreate = (
  repoDir: string,
  branch: string,
  worktreesDir: string,
  baseBranch?: string,
): Promise<{ path: string; branch: string }> =>
  withTimeout(
    (async () => {
      const worktreeName = branch.replace(/\//g, "-");
      const worktreePath = join(worktreesDir, worktreeName);

      const existing = await listWorktrees(repoDir);
      const collision = findCollidingWorktree(existing, branch, worktreePath);
      if (collision) {
        const managed = normalizePath(collision.path).startsWith(
          normalizePath(worktreesDir),
        );
        if (managed) {
          const dirty = await hasUncommittedChanges(collision.path);
          if (dirty) {
            console.warn(
              `Reusing worktree at ${collision.path} (branch '${branch}') — worktree has uncommitted changes`,
            );
          } else {
            await fastForwardFromOrigin(collision.path, branch);
          }
          return { path: collision.path, branch };
        }
        throw new WorktreeError(
          `Branch '${branch}' is already checked out in worktree at '${collision.path}'. Use a different branch name, or wait for the other run to finish.`,
        );
      }

      try {
        await execGit(
          [...NO_CONFIG_LOCK_FLAGS, "worktree", "add", worktreePath, branch],
          repoDir,
        );
      } catch (e) {
        if (e instanceof WorktreeError && e.message.includes("invalid reference")) {
          await execGit(
            [
              ...NO_CONFIG_LOCK_FLAGS,
              "worktree",
              "add",
              "-b",
              branch,
              worktreePath,
              baseBranch ?? "HEAD",
            ],
            repoDir,
          );
        } else {
          throw e;
        }
      }
      return { path: worktreePath, branch };
    })(),
    WORKTREE_TIMEOUT_MS,
    () =>
      new WorktreeError(
        `Worktree creation timed out after ${WORKTREE_TIMEOUT_MS}ms`,
      ),
  );

// The repo is NAMED, not derived from the path (#38). It used to walk three
// levels up from the worktree — `<repo>/<workDir>/worktrees/<name>` — which was
// sound only while the repo was the worktrees' grandparent AND `workDir` was a
// single path segment, neither of which survives the split: three levels up
// from `<hostCwd>/.sandbar/worktrees/<name>` is now the OPERATOR'S checkout, a
// repo the worktree is not registered in. Every caller swallows this failure,
// so the whole class of bug would have been a silent worktree leak.
const worktreeRemove = (
  repoDir: string,
  worktreePath: string,
): Promise<void> =>
  execGit(["worktree", "remove", "--force", worktreePath], repoDir).then(
    () => undefined,
  );

// Best-effort hygiene run at createSandbox start: prune metadata, then sweep
// orphaned dirs under the worktrees directory. realPath-canonicalises the dir
// so a symlinked workDir does not make active worktrees look orphaned (#470).
// Takes the directory rather than composing it from `repoDir` + `workDir`,
// which stopped being the same place in #38.
const pruneStale = (repoDir: string, worktreesDir: string): Promise<void> =>
  withTimeout(
    (async () => {
      await execGit(["worktree", "prune"], repoDir);
      let entries: string[];
      try {
        entries = await readdir(worktreesDir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new WorktreeError((e as Error).message);
      }
      const realWorktreesDir = await realpath(worktreesDir).catch(() => worktreesDir);
      const worktreeList = await execGit(
        ["worktree", "list", "--porcelain"],
        repoDir,
      );
      const activePaths = new Set(
        worktreeList
          .split("\n")
          .filter((l) => l.startsWith("worktree "))
          .map((l) => l.slice("worktree ".length).trim())
          .map(normalizePath),
      );
      for (const entry of entries) {
        const entryPath = join(realWorktreesDir, entry);
        let isDir = false;
        try {
          isDir = (await stat(entryPath)).isDirectory();
        } catch {
          isDir = false;
        }
        if (isDir && !activePaths.has(normalizePath(entryPath))) {
          await rm(entryPath, { recursive: true, force: true }).catch((err) => {
            throw new WorktreeError(`Failed to remove ${entryPath}: ${err.message}`);
          });
        }
      }
    })(),
    WORKTREE_TIMEOUT_MS,
    () => new WorktreeError(`Worktree prune timed out after ${WORKTREE_TIMEOUT_MS}ms`),
  );

// ---------------------------------------------------------------------------
// copyToWorktree — Linux COW with plain `cp -R` fallback; skip missing sources
// ---------------------------------------------------------------------------

const getCopyOnWriteFlags = (): string[] =>
  process.platform === "darwin" ? ["-cR"] : ["-R", "--reflink=auto"];

const copyToWorktree = (
  paths: readonly string[],
  hostRepoDir: string,
  worktreePath: string,
): Promise<void> =>
  withTimeout(
    (async () => {
      const cowFlags = getCopyOnWriteFlags();
      for (const relativePath of paths) {
        const src = join(hostRepoDir, relativePath);
        if (!existsSync(src)) continue;
        const dest = join(worktreePath, relativePath);
        await new Promise<void>((resolveCp, rejectCp) => {
          execFile("cp", [...cowFlags, src, dest], (error) => {
            if (!error) return resolveCp();
            execFile("cp", ["-R", src, dest], (fallbackError, _o, stderr) => {
              if (fallbackError) {
                rejectCp(
                  new Error(
                    `Failed to copy ${relativePath} to worktree: ${stderr || fallbackError.message}`,
                  ),
                );
              } else {
                resolveCp();
              }
            });
          });
        });
      }
    })(),
    COPY_TO_WORKTREE_TIMEOUT_MS,
    () =>
      new Error(`copyToWorktree timed out after ${COPY_TO_WORKTREE_TIMEOUT_MS}ms`),
  );

const runHostHooks = async (
  hooks: ReadonlyArray<{ command: string; timeoutMs?: number }>,
  cwd: string,
): Promise<void> => {
  for (const hook of hooks) {
    const ms = hook.timeoutMs ?? HOOK_TIMEOUT_MS;
    await withTimeout(
      new Promise<void>((resolveHook, rejectHook) => {
        execFile(
          "sh",
          ["-c", hook.command],
          { cwd, env: process.env },
          (error, _o, stderr) => {
            if (error) {
              rejectHook(
                new ExecError(
                  hook.command,
                  typeof error.code === "number" ? error.code : 1,
                  stderr || error.message,
                ),
              );
            } else {
              resolveHook();
            }
          },
        );
      }),
      ms,
      () => new Error(`Host hook '${hook.command}' timed out after ${ms}ms`),
    );
  }
};

// ---------------------------------------------------------------------------
// podman provider — port of sandboxes/podman.ts (bind-mount only)
// ---------------------------------------------------------------------------

const checkImageExists = (imageName: string): Promise<void> =>
  new Promise((resolveImg, rejectImg) => {
    execFile("podman", ["image", "inspect", imageName], (error) => {
      if (error) {
        rejectImg(
          new Error(
            `Image '${imageName}' not found locally. Build it first with 'podman build -t ${imageName} .'`,
          ),
        );
      } else {
        resolveImg();
      }
    });
  });

// ---------------------------------------------------------------------------
// The sandbox container's `podman run` argv
// ---------------------------------------------------------------------------

// Pure and exported so the flags are table-testable. The provider itself needs
// a real podman and a real image, so the suite drives a fake provider instead —
// which meant every flag below was, until #42, asserted by nothing at all.
//
// `--init` is why that gap mattered. The entrypoint is `sleep infinity`, so
// pid 1 is `sleep`, which never calls wait(): anything an agent orphans inside
// the sandbox — a test runner's browser, a build's worker, any child whose
// parent exits first — is reparented to pid 1 and stays `Z` for the lifetime of
// the issue. Nothing reaps them, so the count only grows, and each one holds a
// pid slot against the container's pids limit (2048 by default); ahead of that
// ceiling, `ps` is the tool an agent reaches for to diagnose its own sandbox
// and it is full of corpses that mean nothing. `--init` puts podman's catatonit
// at pid 1 and moves `sleep` to pid 2, which reaps them.
//
// Unconditional, with no config surface: no sandbox wants to leak zombies, and
// a consumer cannot fix this from its own image, because pid 1 is sandbar's
// choice and a container's pid 1 cannot be delegated after the fact. The
// alternative — an entrypoint shell that traps and reaps — reimplements
// catatonit in bash and would have to be baked into every consumer image. A
// host whose podman ships no catatonit fails the `podman run` outright, naming
// the missing binary, which is loud at sandbox creation rather than silent.
export function sandboxRunArgs(opts: {
  readonly containerName: string;
  readonly imageName: string;
  readonly workdir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly volumeMounts: readonly string[];
  readonly userns: string | false;
  readonly containerUid: number;
  readonly containerGid: number;
  readonly networks: readonly string[];
  readonly groups: ReadonlyArray<string | number>;
  readonly devices: readonly string[];
  readonly cpus: number | undefined;
}): string[] {
  return [
    "run",
    "-d",
    "--name",
    opts.containerName,
    "--init",
    "--user",
    `${opts.containerUid}:${opts.containerGid}`,
    ...(opts.userns
      ? [`--userns=keep-id:uid=${opts.containerUid},gid=${opts.containerGid}`]
      : []),
    ...opts.networks.flatMap((n) => ["--network", n]),
    ...opts.groups.flatMap((g) => ["--group-add", String(g)]),
    ...opts.devices.flatMap((d) => ["--device", d]),
    ...(opts.cpus !== undefined ? ["--cpus", String(opts.cpus)] : []),
    "-w",
    opts.workdir,
    ...Object.entries(opts.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...opts.volumeMounts.flatMap((v) => ["-v", v]),
    "--entrypoint",
    "sleep",
    opts.imageName,
    "infinity",
  ];
}

export const podman = (options?: PodmanOptions): SandboxProvider => {
  const configuredImageName = options?.imageName;
  const namePrefix = options?.namePrefix ?? CONTAINER_NAME_PREFIX;
  const selinuxLabel = options?.selinuxLabel ?? "z";
  const userns = options?.userns ?? "keep-id";
  const containerUid = options?.containerUid ?? 1000;
  const containerGid = options?.containerGid ?? 1000;
  const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;

  return {
    tag: "bind-mount",
    name: "podman",
    env: options?.env ?? {},
    sandboxHomedir: SANDBOX_HOMEDIR,
    create: async (createOptions) => {
      const containerName = `${namePrefix}${randomUUID()}`;
      const sandboxWorktreePath =
        createOptions.mounts.find((m) => m.hostPath === createOptions.worktreePath)
          ?.sandboxPath ?? SANDBOX_REPO_DIR;
      const volumeMounts = createOptions.mounts.map((m) =>
        formatVolumeMount(m, selinuxLabel),
      );
      const imageName =
        configuredImageName ?? defaultImageName(createOptions.hostRepoPath);

      await checkImageExists(imageName);

      const env = { ...createOptions.env, HOME: SANDBOX_HOMEDIR };
      const networks = options?.network
        ? Array.isArray(options.network)
          ? options.network
          : [options.network]
        : [];

      await new Promise<void>((resolveRun, rejectRun) => {
        execFile(
          "podman",
          sandboxRunArgs({
            containerName,
            imageName,
            workdir: sandboxWorktreePath,
            env,
            volumeMounts,
            userns,
            containerUid,
            containerGid,
            networks,
            groups: options?.groups ?? [],
            devices: options?.devices ?? [],
            cpus: options?.cpus,
          }),
          (error) => {
            if (error) rejectRun(new Error(`podman run failed: ${error.message}`));
            else resolveRun();
          },
        );
      });

      const removeContainerSync = (): void => {
        try {
          execFileSync("podman", ["rm", "-f", containerName], {
            stdio: "ignore",
            timeout: 5000,
          });
        } catch {
          // best-effort
        }
      };
      const unregisterShutdown = registerShutdown(removeContainerSync);

      const handle: SandboxHandle = {
        worktreePath: sandboxWorktreePath,
        exec: (command, opts) => {
          const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
          const args = ["exec"];
          if (opts?.stdin !== undefined) args.push("-i");
          if (opts?.cwd) args.push("-w", opts.cwd);
          args.push(containerName, "sh", "-c", effectiveCommand);
          return new Promise<ExecResult>((resolveExec, rejectExec) => {
            const proc = spawn("podman", args, {
              stdio: [opts?.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
            });
            if (opts?.stdin !== undefined && proc.stdin) {
              // Unlistened, a write to a child that already exited raises an
              // UNCAUGHT EPIPE and kills the run rather than failing this one
              // exec. EPIPE only means podman went away before reading stdin —
              // its exit code is the real verdict and the close handler below
              // reports it. Any other write error is genuine and rejects.
              proc.stdin.on("error", (error: NodeJS.ErrnoException) => {
                if (error.code !== "EPIPE") {
                  rejectExec(
                    new Error(`podman exec stdin failed: ${error.message}`),
                  );
                }
              });
              proc.stdin.write(opts.stdin);
              proc.stdin.end();
            }
            proc.on("error", (error) => {
              rejectExec(new Error(`podman exec failed: ${error.message}`));
            });
            // stdout/stderr are always piped above, so they are non-null here.
            const stdout = proc.stdout as NonNullable<typeof proc.stdout>;
            const stderr = proc.stderr as NonNullable<typeof proc.stderr>;
            if (opts?.onLine) {
              const onLine = opts.onLine;
              const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
              const stderrTail = new BoundedTail(maxOutputTailChars, "");
              const rl = createInterface({ input: stdout });
              rl.on("line", (line) => {
                stdoutTail.push(line);
                onLine(line);
              });
              stderr.on("data", (chunk) => {
                stderrTail.push(chunk.toString());
              });
              proc.on("close", (code) => {
                resolveExec({
                  stdout: stdoutTail.toString(),
                  stderr: stderrTail.toString(),
                  exitCode: code ?? 0,
                });
              });
            } else {
              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];
              stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString()));
              stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
              proc.on("close", (code) => {
                resolveExec({
                  stdout: stdoutChunks.join(""),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                });
              });
            }
          });
        },
        close: async () => {
          unregisterShutdown();
          await new Promise<void>((resolveClose, rejectClose) => {
            execFile("podman", ["rm", "-f", containerName], (error) => {
              if (error) rejectClose(new Error(`podman rm failed: ${error.message}`));
              else resolveClose();
            });
          });
        },
      };
      return handle;
    },
  };
};

// ---------------------------------------------------------------------------
// Sandbox-side exec helpers (git setup with 126/137 retry)
// ---------------------------------------------------------------------------

const sandboxExecOk = async (
  handle: SandboxHandle,
  command: string,
  opts?: ExecOptions,
): Promise<ExecResult> => {
  const r = await handle.exec(command, opts);
  if (r.exitCode !== 0) throw new ExecError(command, r.exitCode, r.stderr);
  return r;
};

const isTransientExecError = (err: unknown): boolean =>
  err instanceof ExecError && TRANSIENT_EXEC_EXIT_CODES.has(err.exitCode);

// Each attempt is timeout-bounded; retry only transient container-exec races
// (126/137). Genuine git errors (exit 1) and hangs fail fast.
const sandboxGitSetup = async (
  handle: SandboxHandle,
  command: string,
  opts?: ExecOptions,
): Promise<ExecResult> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= GIT_SETUP_MAX_RETRIES; attempt++) {
    try {
      return await withTimeout(
        sandboxExecOk(handle, command, opts),
        GIT_SETUP_TIMEOUT_MS,
        () => new Error(`Git command timed out after ${GIT_SETUP_TIMEOUT_MS}ms: ${command}`),
      );
    } catch (err) {
      if (isTransientExecError(err) && attempt < GIT_SETUP_MAX_RETRIES) {
        lastErr = err;
        await delay(GIT_SETUP_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
};

// ---------------------------------------------------------------------------
// Agent run loop — two-phase timeout (F5), error tiering (gotcha B)
// ---------------------------------------------------------------------------

const invokeAgent = (
  handle: SandboxHandle,
  sandboxRepoDir: string,
  prompt: string | undefined,
  agent: AgentProvider,
  idleTimeoutMs: number,
  completionTimeoutMs: number,
  completionSignals: string[],
): Promise<{ result: string }> =>
  new Promise((resolveRun, rejectRun) => {
    let resultText = "";
    let accumulatedOutput = "";
    let completionDetected = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const settleResolve = (val: { result: string }): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      resolveRun(val);
    };
    const settleReject = (err: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      rejectRun(err);
    };

    // Two-phase: pre-signal → idle kill timer; post-signal → completion-grace
    // timer that resolves SUCCESSFULLY with the collected output (the agent has
    // signalled but a child may be holding the stdout pipe open past EOF).
    const resetTimer = (): void => {
      clearTimer();
      if (completionDetected) {
        timer = setTimeout(() => {
          settleResolve({ result: resultText || accumulatedOutput });
        }, completionTimeoutMs);
      } else {
        timer = setTimeout(() => {
          settleReject(
            new AgentIdleTimeoutError(
              `Agent idle for ${idleTimeoutMs / 1000} seconds — no output received.`,
              idleTimeoutMs,
            ),
          );
        }, idleTimeoutMs);
      }
    };

    resetTimer();

    const printCmd = agent.buildPrintCommand({
      prompt,
      dangerouslySkipPermissions: true,
    });

    handle
      .exec(printCmd.command, {
        cwd: sandboxRepoDir,
        stdin: printCmd.stdin,
        onLine: (line) => {
          for (const parsed of agent.parseStreamLine(line)) {
            if (parsed.type === "text") {
              accumulatedOutput += parsed.text;
            } else if (parsed.type === "result") {
              resultText = parsed.result;
              accumulatedOutput += parsed.result;
            }
            // tool_call / session_id are ignored on sandbar's path.
          }
          if (
            !completionDetected &&
            completionSignals.some((sig) => accumulatedOutput.includes(sig))
          ) {
            completionDetected = true;
          }
          resetTimer();
        },
      })
      .then((execResult) => {
        if (execResult.exitCode !== 0) {
          // Three-tier detail: stderr → resultText → last 20 stdout lines.
          let detail = execResult.stderr;
          if (!detail.trim()) detail = resultText;
          if (!detail.trim()) {
            detail = execResult.stdout
              .split("\n")
              .filter((l) => l.trim())
              .slice(-20)
              .join("\n");
          }
          settleReject(
            new AgentError(`${agent.name} exited with code ${execResult.exitCode}:\n${detail}`),
          );
          return;
        }
        settleResolve({ result: resultText || execResult.stdout });
      })
      .catch((err) => settleReject(err));
  });

// ---------------------------------------------------------------------------
// prepareWorktree / createSandbox — orchestration, lifecycle, commit capture
// ---------------------------------------------------------------------------

// Worktree-only setup: prune stale entries, create (or reuse) the branch's
// managed worktree, copy host paths in, run host.onWorktreeReady hooks.
// Returns the worktree path. Split out of createSandbox (#20) so callers can
// know the path — with its files on disk — before container bringup, and hand
// it to work that must bind-mount from it (the gate stack's mounts, #24).
// A failure after creation removes the worktree before rethrowing (F4).
export const prepareWorktree = async (
  options: PrepareWorktreeOptions,
): Promise<string> => {
  const { repoDir, worktreesDir, hostCwd } = options.layout;

  await pruneStale(repoDir, worktreesDir).catch(() => {
    // best-effort
  });

  const { path: worktreePath } = await worktreeCreate(
    repoDir,
    options.branch,
    worktreesDir,
    options.baseBranch,
  );

  try {
    if (options.copyToWorktree && options.copyToWorktree.length > 0) {
      // Resolved against the OPERATOR'S checkout, not the cache — the cache is
      // bare and has no files to copy. `copyToWorktree` exists for host-only
      // paths that are not in git, so this is the intent; the consequence,
      // stated in config.ts, is that issue-worktree content becomes a function
      // of the operator's uncommitted state (#38 item 11).
      await copyToWorktree(options.copyToWorktree, hostCwd, worktreePath);
    }
    if (options.hooks?.host?.onWorktreeReady?.length) {
      await runHostHooks(options.hooks.host.onWorktreeReady, worktreePath);
    }
  } catch (e) {
    await worktreeRemove(repoDir, worktreePath).catch(() => {});
    throw e;
  }
  return worktreePath;
};

export const createSandbox = async (
  options: CreateSandboxOptions,
): Promise<Sandbox> => {
  const { branch } = options;
  const { repoDir, hostCwd } = options.layout;

  const prepared = options.preparedWorktreePath !== undefined;
  if (prepared && options.copyToWorktree && options.copyToWorktree.length > 0) {
    throw new Error(
      "createSandbox: copyToWorktree is ignored when preparedWorktreePath is set — pass it to prepareWorktree instead.",
    );
  }
  const worktreePath =
    options.preparedWorktreePath ??
    (await prepareWorktree({
      branch,
      baseBranch: options.baseBranch,
      layout: options.layout,
      copyToWorktree: options.copyToWorktree,
      hooks: options.hooks,
    }));

  let providerHandle: SandboxHandle;
  let sandboxRepoDir: string;
  try {
    const resolvedEnv = resolveSandboxEnv(options.env);
    // mergeProviderEnv: agent env is {} on sandbar's path; provider env layers
    // over resolved (overlap between agent⨯sandbox would throw, but agent={}).
    const env = { ...resolvedEnv, ...options.sandbox.env };

    // NOT swallowed to `[]` (#38). It used to be, back when the mount was
    // often redundant — a plain checkout's `.git` sits inside the worktree the
    // container already mounts. Against the bare cache it is essential: without
    // it in-container git cannot follow the worktree's gitlink, so every agent
    // command fails with "not a git repository" and the attempt produces
    // nothing, silently, for the whole budget. A genuine failure here is infra,
    // so it belongs on the HARD-ERROR path with the rest of bringup.
    const gitMounts = await resolveGitMounts(worktreePath);
    const mounts: Mount[] = [
      { hostPath: worktreePath, sandboxPath: SANDBOX_REPO_DIR },
      ...gitMounts,
    ];

    providerHandle = await options.sandbox.create({
      worktreePath,
      hostRepoPath: hostCwd,
      mounts,
      env,
    });
    sandboxRepoDir = providerHandle.worktreePath;

    // onSandboxReady (parallel) — only when hooks present; tear the container
    // down first on failure (the outer catch then removes the worktree).
    const sandboxOnReady = options.hooks?.sandbox?.onSandboxReady;
    const hostOnReady = options.hooks?.host?.onSandboxReady;
    if (sandboxOnReady?.length || hostOnReady?.length) {
      try {
        await sandboxExecOk(
          providerHandle,
          `git config --global --add safe.directory "${sandboxRepoDir}"`,
        );
        const effects: Promise<unknown>[] = (sandboxOnReady ?? []).map((hook) =>
          sandboxExecOk(providerHandle, hook.command, {
            cwd: sandboxRepoDir,
            sudo: hook.sudo,
          }),
        );
        if (hostOnReady?.length) {
          effects.push(runHostHooks(hostOnReady, worktreePath));
        }
        await Promise.all(effects);
      } catch (e) {
        await providerHandle.close().catch(() => {});
        throw e;
      }
    }
  } catch (e) {
    // F4: a failure after worktree create removes the worktree first — but
    // only when createSandbox created it. A prepared worktree belongs to the
    // caller, who may be concurrently bind-mounting from it (the gate stack's
    // mounts); deleting it here would corrupt that bringup's error into a
    // bogus missing-mount-source failure (#20).
    if (!prepared) await worktreeRemove(repoDir, worktreePath).catch(() => {});
    throw e;
  }

  const forceCleanup = (): void => {
    console.error(`\nWorktree preserved at ${worktreePath}`);
    console.error(`  To review: cd ${worktreePath}`);
    console.error(`  To clean up: git worktree remove --force ${worktreePath}`);
  };
  const unregisterShutdown = registerShutdown(forceCleanup);

  let closed = false;

  const runOneIteration = async (
    agent: AgentProvider,
    prompt: string | undefined,
    idleTimeoutMs: number,
    completionTimeoutMs: number,
    completionSignals: string[],
  ): Promise<{ result: string; commits: { sha: string }[] }> => {
    // Read host git identity, then propagate into the sandbox. safe.directory
    // is set per-run (load-bearing: bind mount is owned by a different UID and
    // sandbar's common case has no onSandboxReady hooks).
    // From the OPERATOR'S checkout (#38): a repo-local `user.email` is
    // configured there, and the bare cache — cloned, not configured — carries
    // none of it. Reading the cache would silently substitute the global
    // identity for a repo-local one.
    const [hostGitName, hostGitEmail] = await Promise.all([
      gitOrEmpty(["config", "user.name"], hostCwd),
      gitOrEmpty(["config", "user.email"], hostCwd),
    ]);

    await sandboxGitSetup(
      providerHandle,
      `git config --global --add safe.directory "${sandboxRepoDir}"`,
    );
    if (hostGitName) {
      await sandboxGitSetup(
        providerHandle,
        `git config --global user.name "${hostGitName.replace(/"/g, '\\"')}"`,
      );
    }
    if (hostGitEmail) {
      await sandboxGitSetup(
        providerHandle,
        `git config --global user.email "${hostGitEmail.replace(/"/g, '\\"')}"`,
      );
    }

    // Left edge of the rev-list range, read before the agent runs. Taken from
    // the BRANCH REF, not from the worktree's HEAD, so that both edges name the
    // same thing and `commits` means exactly "what `refs/heads/<branch>` gained
    // this iteration".
    //
    // With HEAD on the branch — every ordinary iteration — the two are the same
    // commit and this is a no-op. They diverge only when HEAD has wandered off
    // (#27), and there the HEAD-based read is actively wrong: the correction
    // sandbar prompts for is `git branch -f <branch> HEAD && git checkout
    // <branch>`, which moves the branch forward to the detached sha WITHOUT
    // creating a commit. Anchor the range at HEAD and `rev-list <detached>..
    // <branch>` is empty, so an agent that rescues its work exactly as
    // instructed is told it "made no commits this run" and has to burn another
    // attempt — the very message #27's check exists to stop sending. Anchored at
    // the branch, the rescued commits are counted, which is what every consumer
    // of this list already assumes it is looking at.
    //
    // Falls back to the worktree HEAD if the ref is unreadable; ensureIssueBranch
    // has created it by now, so this is belt-and-braces rather than a real path.
    const baseHead = (
      await execGit(["rev-parse", "--verify", `refs/heads/${branch}`], repoDir)
        .catch(() => execGit(["rev-parse", "HEAD"], worktreePath))
    ).trim();

    const { result } = await invokeAgent(
      providerHandle,
      sandboxRepoDir,
      prompt,
      agent,
      idleTimeoutMs,
      completionTimeoutMs,
      completionSignals,
    );

    // Explicit-branch commit capture: fully-qualified ref, the cache repo,
    // --reverse (oldest-first). Missing branch / zero commits → []. Never throw.
    const commits = await withTimeout(
      execGit(
        ["rev-list", `${baseHead}..refs/heads/${branch}`, "--reverse"],
        repoDir,
      )
        .then((out) => {
          const trimmed = out.trim();
          if (!trimmed) return [] as { sha: string }[];
          return trimmed.split("\n").map((sha) => ({ sha }));
        })
        .catch(() => [] as { sha: string }[]),
      COMMIT_COLLECTION_TIMEOUT_MS,
      () =>
        new Error(`Commit collection timed out after ${COMMIT_COLLECTION_TIMEOUT_MS}ms`),
    );

    return { result, commits };
  };

  return {
    branch,
    worktreePath,
    async run(o) {
      const iterations = o.maxIterations ?? 1;
      const completionSignals =
        o.completionSignal === undefined
          ? [DEFAULT_COMPLETION_SIGNAL]
          : Array.isArray(o.completionSignal)
            ? o.completionSignal
            : [o.completionSignal];
      const idleTimeoutMs =
        (o.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS) * 1000;
      const completionTimeoutMs =
        (o.completionTimeoutSeconds ?? DEFAULT_COMPLETION_TIMEOUT_SECONDS) * 1000;

      const allCommits: { sha: string }[] = [];
      let allStdout = "";
      let matchedSignal: string | undefined;

      for (let i = 1; i <= iterations; i++) {
        const { result, commits } = await runOneIteration(
          o.agent,
          o.prompt,
          idleTimeoutMs,
          completionTimeoutMs,
          completionSignals,
        );
        allCommits.push(...commits);
        allStdout += result;
        const found = completionSignals.find((s) => result.includes(s));
        if (found !== undefined) {
          matchedSignal = found;
          break;
        }
      }

      return {
        stdout: allStdout,
        commits: allCommits,
        iterations: [],
        completionSignal: matchedSignal,
      };
    },
    async close() {
      if (closed) return { preservedWorktreePath: undefined };
      closed = true;
      unregisterShutdown();
      await providerHandle.close();
      const dirty = await hasUncommittedChanges(worktreePath).catch(() => false);
      if (dirty) {
        return { preservedWorktreePath: worktreePath };
      }
      await worktreeRemove(repoDir, worktreePath).catch(() => {});
      return { preservedWorktreePath: undefined };
    },
  };
};
