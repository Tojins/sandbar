// In-house replacement for the @ai-hero/sandcastle subset sandbar consumes.
//
// Drops the ~72 MB Effect runtime. Reverse-engineered from sandcastle v0.7.0;
// the authoritative behaviour notes live in docs/sandcastle/01-07. This module
// reproduces ONLY sandbar's exercised path: a bind-mount podman provider, an
// explicit pre-existing branch, `maxIterations: 1`, no session capture. The
// public surface matches the five symbols sandbar imported (`createSandbox`,
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
//   F3 — ONE process-wide shutdown listener set fans out to a Set of teardowns;
//        not a listener per sandbox (MaxListenersExceededWarning past ~5).
//   F4 — a failure after worktree create removes the worktree before rethrowing.
//   F5 — two-phase agent timeout: once the completion signal is seen, a short
//        grace timer resolves the run SUCCESSFULLY with the collected commits
//        instead of a 600 s idle error that discards them.
//   F7 — every host git invocation runs under LC_ALL=C (locale-stable stderr).
//
// safe.directory is set per-run() (not just at create time): the bind-mounted
// worktree is owned by a different UID, and sandbar's common case has no hooks.

import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseEnvFile } from "./env-file.js";

// ---------------------------------------------------------------------------
// Constants (copy exactly — matched by sandbar code outside this boundary)
// ---------------------------------------------------------------------------

export const SANDBOX_REPO_DIR = "/home/agent/workspace";
const SANDBOX_HOMEDIR = "/home/agent";
const CONTAINER_NAME_PREFIX = "sandcastle-";

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
// Public types (match the imported sandcastle surface)
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
  cwd?: string;
  hooks?: SandboxHooks;
  copyToWorktree?: string[];
  // Host path to the env file whose declared keys are injected into the
  // sandbox. Defaults to `<cwd>/.sandcastle/.env` (upstream's fixed location)
  // when omitted; sandbar forwards `config.envFilePath` so one knob governs
  // both preflight and the container.
  envFilePath?: string;
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
// BoundedTail (F1) — verbatim from sandcastle's boundedTail.ts
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
// Shutdown registry (F3) — ONE listener set process-wide, verbatim semantics
// ---------------------------------------------------------------------------

const teardownCallbacks = new Set<() => void>();
let listenersInstalled = false;

const runTeardowns = (): void => {
  for (const teardown of teardownCallbacks) {
    try {
      teardown();
    } catch {
      // best-effort
    }
  }
};
const handleExit = (): void => runTeardowns();
const handleSignal = (): void => {
  detachListeners();
  runTeardowns();
  process.exit(1);
};
const attachListeners = (): void => {
  if (listenersInstalled) return;
  listenersInstalled = true;
  process.on("exit", handleExit);
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
};
function detachListeners(): void {
  if (!listenersInstalled) return;
  listenersInstalled = false;
  process.removeListener("exit", handleExit);
  process.removeListener("SIGINT", handleSignal);
  process.removeListener("SIGTERM", handleSignal);
}
export const registerShutdown = (teardown: () => void): (() => void) => {
  teardownCallbacks.add(teardown);
  attachListeners();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    teardownCallbacks.delete(teardown);
    if (teardownCallbacks.size === 0) detachListeners();
  };
};

// ---------------------------------------------------------------------------
// Mount formatting / image naming — verbatim from mountUtils.ts
// ---------------------------------------------------------------------------

export const defaultImageName = (repoDir: string): string => {
  const dirName = repoDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sandcastle:${sanitized || "local"}`;
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
// Git mount resolution (worktree → two identity mounts) — SandboxFactory.ts
// ---------------------------------------------------------------------------

const resolveGitMounts = async (gitPath: string): Promise<Mount[]> => {
  let isDir: boolean;
  try {
    isDir = (await stat(gitPath)).isDirectory();
  } catch {
    return [{ hostPath: gitPath, sandboxPath: gitPath }];
  }
  if (isDir) {
    return [{ hostPath: gitPath, sandboxPath: gitPath }];
  }
  const content = (await readFile(gitPath, "utf-8")).trim();
  const match = content.match(/^gitdir:\s*(.+)$/);
  if (!match || match[1] === undefined) {
    return [{ hostPath: gitPath, sandboxPath: gitPath }];
  }
  const parentGitDir = resolve(match[1], "..", "..");
  return [
    { hostPath: gitPath, sandboxPath: gitPath },
    { hostPath: parentGitDir, sandboxPath: parentGitDir },
  ];
};

// ---------------------------------------------------------------------------
// Env resolution
// ---------------------------------------------------------------------------
//
// `envFilePath` is supplied by the caller (sandbar forwards `config.envFilePath`
// — the SAME path preflight checks; see env.ts) rather than being hardcoded to
// `<repo>/.sandcastle/.env` as upstream did. Allowlist semantics are preserved:
// only keys *declared* in the file cross into the container, with each value
// falling back to process.env — host env never leaks wholesale. Parsing is the
// shared `parseEnvFile`. A missing file yields an empty map, but because
// preflight reads this same path it fails loudly first.

const resolveEnv = async (envFilePath: string): Promise<Record<string, string>> => {
  let declared: Record<string, string>;
  try {
    declared = parseEnvFile(await readFile(envFilePath, "utf-8"));
  } catch {
    declared = {};
  }
  const result: Record<string, string> = {};
  for (const key of Object.keys(declared)) {
    const value = declared[key] || process.env[key];
    if (value) result[key] = value;
  }
  return result;
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

const hasUncommittedChanges = async (worktreePath: string): Promise<boolean> => {
  const output = await execGit(["status", "--porcelain"], worktreePath);
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
  baseBranch?: string,
): Promise<{ path: string; branch: string }> =>
  withTimeout(
    (async () => {
      const worktreesDir = join(repoDir, ".sandcastle", "worktrees");
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

const worktreeRemove = (worktreePath: string): Promise<void> => {
  // Up exactly three levels: <repo>/.sandcastle/worktrees/<name>.
  const repoDir = join(worktreePath, "..", "..", "..");
  return execGit(["worktree", "remove", "--force", worktreePath], repoDir).then(
    () => undefined,
  );
};

// Best-effort hygiene run at createSandbox start: prune metadata, then sweep
// orphaned dirs under .sandcastle/worktrees/. realPath-canonicalises the dir so
// a symlinked .sandcastle does not make active worktrees look orphaned (#470).
const pruneStale = (repoDir: string): Promise<void> =>
  withTimeout(
    (async () => {
      await execGit(["worktree", "prune"], repoDir);
      const worktreesDir = join(repoDir, ".sandcastle", "worktrees");
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

export const podman = (options?: PodmanOptions): SandboxProvider => {
  const configuredImageName = options?.imageName;
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
      const containerName = `${CONTAINER_NAME_PREFIX}${randomUUID()}`;
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
      const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const volumeArgs = volumeMounts.flatMap((v) => ["-v", v]);
      const usernsArgs = userns
        ? [`--userns=keep-id:uid=${containerUid},gid=${containerGid}`]
        : [];
      const userArgs = ["--user", `${containerUid}:${containerGid}`];
      const networks = options?.network
        ? Array.isArray(options.network)
          ? options.network
          : [options.network]
        : [];
      const networkArgs = networks.flatMap((n) => ["--network", n]);
      const groupArgs = (options?.groups ?? []).flatMap((g) => [
        "--group-add",
        String(g),
      ]);
      const deviceArgs = (options?.devices ?? []).flatMap((d) => ["--device", d]);
      const cpusArgs = options?.cpus !== undefined ? ["--cpus", String(options.cpus)] : [];

      await new Promise<void>((resolveRun, rejectRun) => {
        execFile(
          "podman",
          [
            "run",
            "-d",
            "--name",
            containerName,
            ...userArgs,
            ...usernsArgs,
            ...networkArgs,
            ...groupArgs,
            ...deviceArgs,
            ...cpusArgs,
            "-w",
            sandboxWorktreePath,
            ...envArgs,
            ...volumeArgs,
            "--entrypoint",
            "sleep",
            imageName,
            "infinity",
          ],
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
// createSandbox — orchestration, lifecycle, commit capture, close
// ---------------------------------------------------------------------------

export const createSandbox = async (
  options: CreateSandboxOptions,
): Promise<Sandbox> => {
  const { branch } = options;
  const hostRepoDir = resolve(options.cwd ?? process.cwd());

  await pruneStale(hostRepoDir).catch(() => {
    // best-effort
  });

  const { path: worktreePath } = await worktreeCreate(
    hostRepoDir,
    branch,
    options.baseBranch,
  );

  let providerHandle: SandboxHandle;
  let sandboxRepoDir: string;
  try {
    if (options.copyToWorktree && options.copyToWorktree.length > 0) {
      await copyToWorktree(options.copyToWorktree, hostRepoDir, worktreePath);
    }
    if (options.hooks?.host?.onWorktreeReady?.length) {
      await runHostHooks(options.hooks.host.onWorktreeReady, worktreePath);
    }

    const resolvedEnv = await resolveEnv(
      options.envFilePath ?? join(hostRepoDir, ".sandcastle", ".env"),
    );
    // mergeProviderEnv: agent env is {} on sandbar's path; provider env layers
    // over resolved (overlap between agent⨯sandbox would throw, but agent={}).
    const env = { ...resolvedEnv, ...options.sandbox.env };

    const gitMounts = await resolveGitMounts(join(hostRepoDir, ".git")).catch(
      () => [] as Mount[],
    );
    const mounts: Mount[] = [
      { hostPath: worktreePath, sandboxPath: SANDBOX_REPO_DIR },
      ...gitMounts,
    ];

    providerHandle = await options.sandbox.create({
      worktreePath,
      hostRepoPath: hostRepoDir,
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
    // F4: any failure after worktree create removes the worktree first.
    await worktreeRemove(worktreePath).catch(() => {});
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
    const [hostGitName, hostGitEmail] = await Promise.all([
      gitOrEmpty(["config", "user.name"], hostRepoDir),
      gitOrEmpty(["config", "user.email"], hostRepoDir),
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

    // baseHead from the HOST worktree before the agent runs — the left edge of
    // the rev-list range.
    const baseHead = (await execGit(["rev-parse", "HEAD"], worktreePath)).trim();

    const { result } = await invokeAgent(
      providerHandle,
      sandboxRepoDir,
      prompt,
      agent,
      idleTimeoutMs,
      completionTimeoutMs,
      completionSignals,
    );

    // Explicit-branch commit capture: fully-qualified ref, host repo dir,
    // --reverse (oldest-first). Missing branch / zero commits → []. Never throw.
    const commits = await withTimeout(
      execGit(
        ["rev-list", `${baseHead}..refs/heads/${branch}`, "--reverse"],
        hostRepoDir,
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
      await worktreeRemove(worktreePath).catch(() => {});
      return { preservedWorktreePath: undefined };
    },
  };
};
