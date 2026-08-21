// Tests for the in-house agent-sandbox module (the @ai-hero/sandcastle
// replacement; provenance only — that package is no longer a dependency).
// Covers the obligations in docs/agent-sandbox/05 §"Test
// obligations": the pure stream-json parser, BoundedTail (F1), the shutdown
// registry (F3), worktree-path compatibility with finalize.ts, and an
// integration harness using a LOCAL fake provider (no podman/container) against
// a real temp git repo that exercises createSandbox's lifecycle: per-run
// safe.directory, commit capture, the result||stdout fallback, env isolation,
// and the two-phase completion timer (F5).

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  type RepoLayout,
  ensureRepoCache,
  repoLayout,
  worktreePathFor,
} from "./repo-cache.js";
import {
  BoundedTail,
  MAX_TAIL_CHARS,
  type AgentProvider,
  type Mount,
  type ProviderCreateOptions,
  type SandboxProvider,
  SANDBOX_REPO_DIR,
  agentPartialOutput,
  claudeCode,
  createSandbox,
  defaultImageName,
  killOnAbort,
  parseStreamJsonLine,
  prepareWorktree,
  registerShutdown,
  sandboxRemoveArgs,
  sandboxRunArgs,
} from "./agent-sandbox.js";
import { existsSync } from "node:fs";

const execFileP = promisify(execFile);

// Per-worker global git config isolation: the code under test runs
// `git config --global` (safe.directory, identity). Without this, parallel
// vitest workers race on ~/.gitconfig.lock and pollute the real config.
let gitConfigDir: string;
beforeAll(async () => {
  gitConfigDir = await mkdtemp(join(tmpdir(), "asb-gitcfg-"));
  process.env.GIT_CONFIG_GLOBAL = join(gitConfigDir, ".gitconfig");
});
afterAll(async () => {
  await rm(gitConfigDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseStreamJsonLine (obligation 1)
// ---------------------------------------------------------------------------

describe("parseStreamJsonLine", () => {
  it("returns [] for non-{ lines, empty, and non-object JSON", () => {
    expect(parseStreamJsonLine("")).toEqual([]);
    expect(parseStreamJsonLine("hello")).toEqual([]);
    expect(parseStreamJsonLine("[1,2]")).toEqual([]);
    expect(parseStreamJsonLine("42")).toEqual([]);
    expect(parseStreamJsonLine('"str"')).toEqual([]);
  });

  it("swallows malformed JSON that starts with { → []", () => {
    expect(parseStreamJsonLine("{bad json")).toEqual([]);
  });

  it("concatenates multiple text blocks with NO separator", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] },
    });
    expect(parseStreamJsonLine(line)).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("flushes buffered text before each allowlisted tool_use, preserving order", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "before" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "after" },
        ],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { type: "text", text: "before" },
      { type: "tool_call", name: "Bash", args: "ls" },
      { type: "text", text: "after" },
    ]);
  });

  it("drops non-allowlisted tools but keeps surrounding text", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "a" },
          { type: "tool_use", name: "Read", input: { path: "x" } },
          { type: "text", text: "b" },
        ],
      },
    });
    // Read is not allowlisted; the two text blocks merge (no flush happened).
    expect(parseStreamJsonLine(line)).toEqual([{ type: "text", text: "ab" }]);
  });

  it("drops a tool_use with a non-string arg field", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: 42 } }] },
    });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  it("parses a result event verbatim, including the promise token", () => {
    const line = JSON.stringify({ type: "result", result: "done <promise>COMPLETE</promise>" });
    expect(parseStreamJsonLine(line)).toEqual([
      { type: "result", result: "done <promise>COMPLETE</promise>" },
    ]);
  });

  it("requires result to be a string", () => {
    expect(parseStreamJsonLine(JSON.stringify({ type: "result", result: 1 }))).toEqual([]);
  });

  it("parses session_id only from system/init with a string session_id", () => {
    const ok = JSON.stringify({ type: "system", subtype: "init", session_id: "abc" });
    expect(parseStreamJsonLine(ok)).toEqual([{ type: "session_id", sessionId: "abc" }]);
    const wrongSubtype = JSON.stringify({ type: "system", subtype: "other", session_id: "abc" });
    expect(parseStreamJsonLine(wrongSubtype)).toEqual([]);
  });

  it("returns [] for an unknown top-level type", () => {
    expect(parseStreamJsonLine(JSON.stringify({ type: "future_event" }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BoundedTail (F1, obligation 13)
// ---------------------------------------------------------------------------

describe("BoundedTail", () => {
  it("keeps the END of the stream within the byte budget", () => {
    const tail = new BoundedTail(10, "");
    for (const ch of ["aaaa", "bbbb", "cccc", "dddd"]) tail.push(ch);
    const out = tail.toString();
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith("dddd")).toBe(true);
  });

  it("truncates a single over-long item to its own tail", () => {
    const tail = new BoundedTail(5, "");
    tail.push("0123456789");
    expect(tail.toString()).toBe("56789");
  });

  it("joins with the configured separator", () => {
    const tail = new BoundedTail(MAX_TAIL_CHARS, "\n");
    tail.push("a");
    tail.push("b");
    expect(tail.toString()).toBe("a\nb");
  });

  it("preserves a trailing token in the last lines of a huge stream", () => {
    const tail = new BoundedTail(1024, "\n");
    for (let i = 0; i < 10_000; i++) tail.push(`noise line ${i} ${"x".repeat(50)}`);
    tail.push("<promise>COMPLETE</promise>");
    expect(tail.toString()).toContain("<promise>COMPLETE</promise>");
    expect(tail.toString().length).toBeLessThanOrEqual(1024 + 64);
  });
});

// ---------------------------------------------------------------------------
// claudeCode command line
// ---------------------------------------------------------------------------

describe("claudeCode", () => {
  it("delivers the prompt on stdin (-p -), not argv, with stream-json + verbose", () => {
    const agent = claudeCode("claude-opus-4-8");
    const cmd = agent.buildPrintCommand({ prompt: "hello", dangerouslySkipPermissions: true });
    expect(cmd.command).toBe(
      "claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model 'claude-opus-4-8' -p -",
    );
    expect(cmd.stdin).toBe("hello");
    expect(cmd.command).not.toContain("hello");
  });

  it("shell-escapes the model and omits the skip-perms flag when not requested", () => {
    const cmd = claudeCode("a'b").buildPrintCommand({ prompt: "p" });
    expect(cmd.command).toContain("--model 'a'\\''b'");
    expect(cmd.command).not.toContain("--dangerously-skip-permissions");
  });
});

// ---------------------------------------------------------------------------
// defaultImageName
// ---------------------------------------------------------------------------

describe("defaultImageName", () => {
  it("lowercases the last path segment and sanitizes", () => {
    expect(defaultImageName("/home/unixuser/sandbar")).toBe("sandbar:sandbar");
    expect(defaultImageName("/x/My Repo!")).toBe("sandbar:my-repo-");
    expect(defaultImageName("/")).toBe("sandbar:local");
  });
});

// ---------------------------------------------------------------------------
// Shutdown registry (F3, obligation 16)
// ---------------------------------------------------------------------------

describe("killOnAbort (#41)", () => {
  const fakeChild = () => {
    const killed: string[] = [];
    let onClose: (() => void) | null = null;
    return {
      killed,
      close: () => onClose?.(),
      child: {
        kill: (sig: NodeJS.Signals) => killed.push(sig),
        on: (_e: "close", listener: () => void) => {
          onClose = listener;
        },
      },
    };
  };

  it("kills the child with SIGKILL when the signal aborts", () => {
    const f = fakeChild();
    const ac = new AbortController();
    killOnAbort(f.child, ac.signal);
    expect(f.killed).toEqual([]);
    ac.abort();
    expect(f.killed).toEqual(["SIGKILL"]);
  });

  it("kills immediately when handed an already-aborted signal", () => {
    const f = fakeChild();
    const ac = new AbortController();
    ac.abort();
    killOnAbort(f.child, ac.signal);
    expect(f.killed).toEqual(["SIGKILL"]);
  });

  it("drops the listener on close, so a later abort cannot kill a reused pid", () => {
    const f = fakeChild();
    const ac = new AbortController();
    killOnAbort(f.child, ac.signal);
    f.close();
    ac.abort();
    expect(f.killed).toEqual([]);
  });

  it("is a no-op without a signal — every exec but the agent's passes none", () => {
    const f = fakeChild();
    expect(() => killOnAbort(f.child, undefined)).not.toThrow();
    expect(f.killed).toEqual([]);
  });
});

describe("registerShutdown", () => {
  it("installs a bounded, constant number of process listeners regardless of count", () => {
    const before = process.listenerCount("exit");
    const unregs = Array.from({ length: 8 }, () => registerShutdown(() => {}));
    expect(process.listenerCount("exit")).toBe(before + 1);
    for (const u of unregs) u();
    // Last unregister detaches the shared listener again.
    expect(process.listenerCount("exit")).toBe(before);
  });

  // #35: this module's own SIGINT/SIGTERM handlers ended in a synchronous
  // `process.exit(1)`, which ran AFTER cleanup.ts's handler had started the
  // async `runCleanup()` and killed it mid-await. The teardowns belong in the
  // shared registry; the trap that owns the exit is cleanup.ts's alone.
  it("installs no signal listener of its own", () => {
    const before = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };
    const unreg = registerShutdown(() => {});
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
    unreg();
  });
});

// ---------------------------------------------------------------------------
// Worktree path compatibility with finalize.ts (obligation 3)
// ---------------------------------------------------------------------------

describe("worktree path layout", () => {
  it("matches repo-cache.ts:worktreePathFor for a slashed branch", () => {
    const layout = repoLayout("/repo", ".sandbar");
    const branch = "sandbar/issue-5-add-foo";
    expect(worktreePathFor(layout.worktreesDir, branch)).toBe(
      join("/repo", ".sandbar", "worktrees", "sandbar-issue-5-add-foo"),
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: createSandbox lifecycle via a LOCAL fake provider
// ---------------------------------------------------------------------------

// A fake provider whose handle runs commands locally (`sh -c`) against the host
// worktree path — the model the upstream test suite used. It replicates the
// onLine readline join and captures the env it was handed.
//
// Its `close()` KILLS whatever it still has running (#25). The real provider's
// close removes a container, which takes every process inside it; this one had
// no equivalent and simply resolved, so a test whose command outlives the
// `run()` that started it handed the child to init. That is not hypothetical
// here: the F5 grace test resolves on a 0.2s completion timer while its command
// is deliberately still in `sleep 30`, so every `npm test` leaked two processes
// (the `sh` and its `sleep`) for 30s on a clean run.
//
// `detached: true` is the load-bearing half. Killing the `sh` pid alone leaves
// its `sleep` child reparented to init — the leak, minus one process. Detached,
// `sh` is a process-group leader, and `process.kill(-pid)` reaches the whole
// group. Same reason a `timeout`-wrapped vitest run has to kill the group: the
// pid is never the whole of what was started.
// `live` is a parameter so a caller can watch the children this provider
// spawned: #41's idle timeout is supposed to kill the exec it stops waiting
// for, and "the run rejected" is true whether or not it did.
function makeLocalProvider(live: Set<ChildProcess> = new Set()): SandboxProvider & {
  capturedEnv?: Record<string, string>;
  capturedMounts?: readonly Mount[];
} {
  const provider: SandboxProvider & {
    capturedEnv?: Record<string, string>;
    capturedMounts?: readonly Mount[];
  } = {
    tag: "bind-mount",
    name: "podman",
    env: {},
    sandboxHomedir: "/home/agent",
    create: async (opts: ProviderCreateOptions) => {
      provider.capturedEnv = opts.env;
      provider.capturedMounts = opts.mounts;
      // sandboxRepoDir resolves to this handle.worktreePath; point it at the
      // real host worktree so local git runs in the right place.
      const worktreePath = opts.worktreePath;
      return {
        worktreePath,
        // The name the sandbox stack's siblings would attach to (#44). A
        // constant here: this provider starts no container, and the only thing
        // that reads it is `Sandbox.containerName`.
        containerName: "fake-sandbox-container",
        exec: (command, execOpts) =>
          new Promise((resolveExec, rejectExec) => {
            const proc = spawn("sh", ["-c", command], {
              cwd: execOpts?.cwd ?? worktreePath,
              env: { ...process.env },
              detached: true,
              stdio: [
                execOpts?.stdin !== undefined ? "pipe" : "ignore",
                "pipe",
                "pipe",
              ],
            });
            live.add(proc);
            // The same wiring the podman provider uses, for the same reason.
            killOnAbort(proc, execOpts?.signal);
            proc.on("close", () => live.delete(proc));
            proc.on("error", () => live.delete(proc));
            if (execOpts?.stdin !== undefined && proc.stdin) {
              // Same guard the real provider needs: `sh -c` can exit before
              // reading stdin, and an unlistened EPIPE surfaces as an uncaught
              // exception that fails the whole vitest run rather than any
              // assertion. It showed up as a run that reported every test
              // passing and still exited 1.
              proc.stdin.on("error", () => {
                /* child gone; its exit code is the reporting path */
              });
              proc.stdin.write(execOpts.stdin);
              proc.stdin.end();
            }
            proc.on("error", rejectExec);
            const stderrChunks: string[] = [];
            proc.stderr!.on("data", (c) => stderrChunks.push(c.toString()));
            if (execOpts?.onLine) {
              const stdoutLines: string[] = [];
              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutLines.push(line);
                execOpts.onLine!(line);
              });
              proc.on("close", (code) =>
                resolveExec({
                  stdout: stdoutLines.join("\n"),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                }),
              );
            } else {
              const stdoutChunks: string[] = [];
              proc.stdout!.on("data", (c) => stdoutChunks.push(c.toString()));
              proc.on("close", (code) =>
                resolveExec({
                  stdout: stdoutChunks.join(""),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                }),
              );
            }
          }),
        close: async () => {
          for (const proc of live) {
            // Negative pid = the process group, which `detached: true` above is
            // what makes exist. Swallowing is right: the group is already gone
            // whenever the child exited between the `close` handler and here.
            if (proc.pid !== undefined) {
              try {
                process.kill(-proc.pid, "SIGKILL");
              } catch {
                /* already reaped */
              }
            }
          }
          live.clear();
        },
      };
    },
  };
  return provider;
}

// A scriptable agent: buildPrintCommand returns a shell command that emits the
// given stream-json lines (and optionally makes a commit / sleeps first).
function scriptedAgent(shellScript: string): AgentProvider {
  return {
    name: "claude-code",
    env: {},
    buildPrintCommand() {
      return { command: shellScript, stdin: "" };
    },
    parseStreamLine: parseStreamJsonLine,
  };
}

const git = (args: string[], cwd: string) =>
  execFileP("git", args, { cwd, env: { ...process.env, LC_ALL: "C" } });

// These fixtures are a plain (non-bare) repo standing in for BOTH roles: the
// operator's checkout and sandbar's cache. That is deliberate — it keeps the
// non-bare branch of `--git-common-dir` under test, and none of what these
// cases assert (worktree placement, commit capture, env, hook ordering) is a
// statement about bareness. `repo-cache-git.test.ts` covers the real split.
const layoutFor = (dir: string): RepoLayout => ({
  hostCwd: dir,
  stateDir: join(dir, ".sandbar"),
  repoDir: dir,
  worktreesDir: join(dir, ".sandbar", "worktrees"),
  sourceWorktree: join(dir, ".sandbar", "worktrees", "source"),
  logsDir: join(dir, ".sandbar", "logs"),
});

describe("createSandbox integration (local provider)", () => {
  let dir: string;
  const cleanups: string[] = [];

  beforeAll(async () => {
    // A real git repo with an issue branch already created (sandbar pre-seeds).
    dir = await mkdtemp(join(tmpdir(), "asb-repo-"));
    cleanups.push(dir);
    await git(["init", "-b", "main"], dir);
    await git(["config", "user.name", "Test Host"], dir);
    await git(["config", "user.email", "host@test.com"], dir);
    await writeFile(join(dir, "README.md"), "seed\n");
    await git(["add", "."], dir);
    await git(["commit", "-m", "seed"], dir);
    await git(["branch", "sandbar/issue-1-demo"], dir);
  });
  afterAll(async () => {
    for (const d of cleanups) await rm(d, { recursive: true, force: true });
  });

  it("creates a managed worktree under .sandbar/worktrees and captures a commit", async () => {
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-1-demo",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      expect(sandbox.worktreePath).toBe(
        join(dir, ".sandbar", "worktrees", "sandbar-issue-1-demo"),
      );

      // The "agent" makes one commit on the branch, then emits a result line.
      const agent = scriptedAgent(
        `git commit --allow-empty -m "agent work" >/dev/null 2>&1 && ` +
          `printf '%s\\n' '${JSON.stringify({ type: "result", result: "done <promise>COMPLETE</promise>" })}'`,
      );
      const run = await sandbox.run({ agent, prompt: "go", maxIterations: 1 });

      expect(run.stdout).toContain("<promise>COMPLETE</promise>");
      expect(run.commits).toHaveLength(1);
      expect(run.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
      // The captured commit is the one the agent made on the branch.
      const log = await git(["log", "-1", "--format=%H", "sandbar/issue-1-demo"], dir);
      expect(log.stdout.trim()).toBe(run.commits[0]!.sha);
    } finally {
      await sandbox.close();
    }
  });

  it("honors a custom workDir for the worktree root, matching worktreePathFor (#7)", async () => {
    await git(["branch", "sandbar/issue-7-workdir"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-7-workdir",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      // The sandbox must place the worktree where finalize.ts:worktreePathFor
      // expects it — otherwise finalize's worktree-remove misses and the
      // branch-delete is blocked by the still-registered worktree.
      const expected = worktreePathFor(
        layoutFor(dir).worktreesDir,
        "sandbar/issue-7-workdir",
      );
      expect(sandbox.worktreePath).toBe(expected);
      expect(sandbox.worktreePath).toContain(join(".sandbar", "worktrees"));
    } finally {
      await sandbox.close();
    }
  });

  // #27 follow-up. The commit range is anchored at `refs/heads/<branch>`, not at
  // the worktree's HEAD. With HEAD on the branch the two are the same commit and
  // nothing changes; they diverge only when HEAD has wandered off, and there the
  // HEAD anchor is actively wrong. The correction sandbar prompts for is
  // `git branch -f <branch> HEAD && git checkout <branch>` — which moves the
  // branch forward WITHOUT creating a commit. Anchored at HEAD, `rev-list
  // <detached>..<branch>` is empty, so an agent that rescues its work exactly as
  // instructed is told it "made no commits this run" (promise-parser's
  // zero-commit guard) and burns another attempt — the very message the #27
  // check exists to stop sending.
  it("counts commits the branch GAINED, so an off-branch rescue is not invisible", async () => {
    await git(["branch", "sandbar/issue-9-rescue"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-9-rescue",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      // Attempt 1: the agent detaches and commits there. Nothing reaches the
      // branch, so nothing is counted — that is correct and is what #27 detects.
      const stray = await sandbox.run({
        agent: scriptedAgent(
          `git checkout --detach >/dev/null 2>&1 && ` +
            `git commit --allow-empty -m "stranded" >/dev/null 2>&1 && ` +
            `printf '%s\n' '${JSON.stringify({ type: "result", result: "x" })}'`,
        ),
        prompt: "go",
        maxIterations: 1,
      });
      expect(stray.commits).toEqual([]);

      // Attempt 2: the agent follows the re-prompt verbatim. It creates no new
      // commit — it moves the ref — and the rescued commit must still be counted.
      const rescued = await sandbox.run({
        agent: scriptedAgent(
          `git branch -f sandbar/issue-9-rescue HEAD >/dev/null 2>&1 && ` +
            `git checkout sandbar/issue-9-rescue >/dev/null 2>&1 && ` +
            `printf '%s\n' '${JSON.stringify({ type: "result", result: "y" })}'`,
        ),
        prompt: "go",
        maxIterations: 1,
      });
      expect(rescued.commits).toHaveLength(1);
      const tip = await git(
        ["log", "-1", "--format=%H", "sandbar/issue-9-rescue"],
        dir,
      );
      expect(rescued.commits[0]!.sha).toBe(tip.stdout.trim());
    } finally {
      await sandbox.close();
    }
  });

  it("falls back to raw stdout when no result event is emitted, and reports zero commits for a no-op", async () => {
    await git(["branch", "sandbar/issue-2-noop"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-2-noop",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      // No result line, no commit — just raw text on stdout.
      const agent = scriptedAgent(`printf '%s\\n' 'raw output line with <promise>COMPLETE</promise>'`);
      const run = await sandbox.run({ agent, prompt: "go", maxIterations: 1 });
      expect(run.stdout).toContain("raw output line with <promise>COMPLETE</promise>");
      expect(run.commits).toEqual([]);
    } finally {
      await sandbox.close();
    }
  });

  it("propagates host git identity and marks safe.directory in the sandbox global config", async () => {
    await git(["branch", "sandbar/issue-3-id"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-3-id",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      const agent = scriptedAgent(`printf '%s\\n' 'ok'`);
      await sandbox.run({ agent, prompt: "go", maxIterations: 1 });
      // The run() lifecycle wrote these into GIT_CONFIG_GLOBAL. Both reads
      // NAME the directory they run in, and that is not tidiness (#25): even
      // `git config --global` discovers a repository from its working
      // directory, and a BROKEN gitlink there is a fatal 128 rather than a
      // shrug. The gate runner mounts the worktree at /workspace and nothing
      // else, so /workspace/.git points at a `.sandbar/repo.git/worktrees/...`
      // path no container can see — an ambient-cwd git call therefore passes on
      // a developer's host and fatals in the gate, which is the same trap as
      // the ambient git-identity one CLAUDE.md already records, one directory
      // over. `gitConfigDir` is a plain temp dir, so these answers can only
      // have come from the global file this suite points at.
      const at = { cwd: gitConfigDir };
      const name = await execFileP(
        "git",
        ["config", "--global", "user.name"],
        at,
      );
      expect(name.stdout.trim()).toBe("Test Host");
      const safe = await execFileP(
        "git",
        ["config", "--global", "--get-all", "safe.directory"],
        at,
      );
      expect(safe.stdout).toContain(sandbox.worktreePath);
    } finally {
      await sandbox.close();
    }
  });

  it("resolves the run via the completion-grace timer when the pipe is held open (F5)", async () => {
    await git(["branch", "sandbar/issue-4-grace"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-4-grace",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      // Emit the completion signal, commit, then hold the pipe open (sleep) so
      // the exec never reaches EOF. The grace timer must resolve with commits.
      const agent = scriptedAgent(
        `git commit --allow-empty -m "graced" >/dev/null 2>&1 && ` +
          `printf '%s\\n' '${JSON.stringify({ type: "result", result: "<promise>COMPLETE</promise>" })}' && ` +
          `sleep 30`,
      );
      const start = Date.now();
      const run = await sandbox.run({
        agent,
        prompt: "go",
        maxIterations: 1,
        completionTimeoutSeconds: 0.2,
        idleTimeoutSeconds: 30,
      });
      const elapsed = Date.now() - start;
      expect(run.stdout).toContain("<promise>COMPLETE</promise>");
      expect(run.commits).toHaveLength(1);
      expect(elapsed).toBeLessThan(5000); // resolved on the grace timer, not the 30s idle
    } finally {
      await sandbox.close();
    }
  }, 15_000);

  it("the idle timeout carries out what the agent emitted, and kills the exec (#41)", async () => {
    await git(["branch", "sandbar/issue-41-idle"], dir);
    const live = new Set<ChildProcess>();
    const provider = makeLocalProvider(live);
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-41-idle",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      // A reviewer that says something and then goes quiet. The observed #41
      // run emitted nothing at all, but the interesting assertion is the
      // opposite case: those bytes are the ONLY thing that tells a caller
      // "the agent produced no review" apart from "the agent produced a
      // review and the run died", and the two are handled differently.
      const agent = scriptedAgent(
        `printf '%s\\n' '${JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "partial review findings" }] },
        })}' && sleep 30`,
      );
      const err = await sandbox
        .run({ agent, prompt: "go", maxIterations: 1, idleTimeoutSeconds: 0.4 })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("idle");
      expect(agentPartialOutput(err)).toContain("partial review findings");

      // And the half the message never covered: the run stopped waiting for the
      // exec, so the exec is stopped. Before this, `sleep 30` (in production, a
      // `podman exec` client and a live agent session) outlived the rejection
      // with nothing left to collect it — the sandbox is per-issue, so nothing
      // would have until the issue ended.
      const killed = await Promise.race([
        new Promise<boolean>((r) => {
          const t = setInterval(() => {
            // `signalCode`, not an empty `live`: node fires 'close' only once
            // the child's STDIO has closed, and the `sleep` this command
            // orphans holds that pipe for its full 30s. Which is the local
            // shape of the production point — killing a client does not reap
            // what it started, and the provider's group kill at `close()` is
            // what finally takes the orphan (see makeLocalProvider's header).
            if ([...live].some((c) => c.signalCode === "SIGKILL")) {
              clearInterval(t);
              r(true);
            }
          }, 20);
        }),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
      ]);
      expect(killed).toBe(true);
    } finally {
      await sandbox.close();
    }
  }, 15_000);

  it("a run that emits NOTHING before the idle timeout carries out nothing (#41)", async () => {
    await git(["branch", "sandbar/issue-41-silent"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-41-silent",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      // The observed shape: not one byte, not even the stream's init event.
      const agent = scriptedAgent("sleep 30");
      const err = await sandbox
        .run({ agent, prompt: "go", maxIterations: 1, idleTimeoutSeconds: 0.4 })
        .then(
          () => null,
          (e: unknown) => e,
        );
      // "" and not the error's own message: reviewer-run.ts reads this as
      // evidence, and a harness message counted as evidence is the whole bug.
      expect(agentPartialOutput(err)).toBe("");
    } finally {
      await sandbox.close();
    }
  }, 15_000);

  // The allowlist is the whole security property of `config.env`, and #38
  // changed only where the record comes from — a value in the config instead of
  // a file sandbar named. Declared-and-empty still means "inherit this one key";
  // undeclared still means nothing crosses.
  it("only forwards env keys declared in config.env (no host leakage)", async () => {
    await git(["branch", "sandbar/issue-5-env"], dir);

    process.env.DECLARED = "from-host";
    process.env.UNDECLARED = "should-not-leak";
    try {
      const provider = makeLocalProvider();
      const sandbox = await createSandbox({
        env: { DECLARED: "", LITERAL: "fixed" },
        branch: "sandbar/issue-5-env",
        sandbox: provider,
        layout: layoutFor(dir),
      });
      await sandbox.close();
      const env = provider.capturedEnv ?? {};
      expect(env.DECLARED).toBe("from-host"); // empty in config → process.env fallback
      expect(env.LITERAL).toBe("fixed");
      expect(env.UNDECLARED).toBeUndefined(); // host env does not leak
      expect("PATH" in env).toBe(false);
    } finally {
      delete process.env.DECLARED;
      delete process.env.UNDECLARED;
    }
  });

  // #5 became structural in #38: there is no path to get wrong and no fixed
  // `.sandbar/.env` to fall through to, so a stale file at the old location is
  // just a file. What is still worth pinning is that the record the caller
  // passes is the ONLY source.
  it("takes the declared record, with no fixed .sandbar/.env fallback (issue #5, #38)", async () => {
    await mkdir(join(dir, ".sandbar"), { recursive: true });
    await writeFile(join(dir, ".sandbar", ".env"), "GH_TOKEN=stale-default\n");
    await git(["branch", "sandbar/issue-5-path"], dir);

    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      branch: "sandbar/issue-5-path",
      sandbox: provider,
      layout: layoutFor(dir),
      env: { GH_TOKEN: "from-config" },
    });
    await sandbox.close();
    const env = provider.capturedEnv ?? {};
    expect(env.GH_TOKEN).toBe("from-config");
    expect(env.GH_TOKEN).not.toBe("stale-default");
  });
});

// ---------------------------------------------------------------------------
// prepareWorktree / preparedWorktreePath split (#20)
// ---------------------------------------------------------------------------

describe("prepareWorktree + createSandbox prepared mode (#20)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "asb-prep-"));
    await git(["init", "-b", "main"], dir);
    await git(["config", "user.name", "Test Host"], dir);
    await git(["config", "user.email", "host@test.com"], dir);
    await writeFile(join(dir, "README.md"), "seed\n");
    await writeFile(join(dir, "fixture.txt"), "copy me\n");
    await git(["add", "."], dir);
    await git(["commit", "-m", "seed"], dir);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs copy + onWorktreeReady exactly once — createSandbox must not repeat worktree-side setup", async () => {
    await git(["branch", "sandbar/issue-20-prep"], dir);
    const hookLog = join(dir, "hook.log");
    const hooks = {
      host: {
        onWorktreeReady: [{ command: `echo ran >> ${hookLog}` }],
      },
    };

    const worktreePath = await prepareWorktree({
      branch: "sandbar/issue-20-prep",
      layout: layoutFor(dir),
      copyToWorktree: ["fixture.txt"],
      hooks,
    });
    expect(worktreePath).toBe(
      join(dir, ".sandbar", "worktrees", "sandbar-issue-20-prep"),
    );
    expect(existsSync(join(worktreePath, "fixture.txt"))).toBe(true);

    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-20-prep",
      sandbox: provider,
      layout: layoutFor(dir),
      hooks,
      preparedWorktreePath: worktreePath,
    });
    try {
      expect(sandbox.worktreePath).toBe(worktreePath);
      const log = await execFileP("cat", [hookLog]);
      // One line: prepareWorktree ran the hook; createSandbox skipped it.
      expect(log.stdout.trim().split("\n")).toHaveLength(1);
    } finally {
      await sandbox.close();
    }
  });

  it("a container bringup failure leaves the caller-owned prepared worktree in place", async () => {
    await git(["branch", "sandbar/issue-20-keep"], dir);
    const worktreePath = await prepareWorktree({
      branch: "sandbar/issue-20-keep",
      layout: layoutFor(dir),
    });

    const failingProvider: SandboxProvider = {
      tag: "bind-mount",
      name: "podman",
      env: {},
      sandboxHomedir: "/home/agent",
      create: async () => {
        throw new Error("bringup boom");
      },
    };
    await expect(
      createSandbox({
        env: {},
        branch: "sandbar/issue-20-keep",
        sandbox: failingProvider,
        layout: layoutFor(dir),
        preparedWorktreePath: worktreePath,
      }),
    ).rejects.toThrow("bringup boom");
    // The worktree survives: the concurrent db sidecar may be bind-mounting
    // initMounts from it, and the caller (not createSandbox) owns it.
    expect(existsSync(worktreePath)).toBe(true);

    await git(["worktree", "remove", "--force", worktreePath], dir);
  });

  it("rejects copyToWorktree alongside preparedWorktreePath instead of silently skipping it", async () => {
    await git(["branch", "sandbar/issue-20-guard"], dir);
    const worktreePath = await prepareWorktree({
      branch: "sandbar/issue-20-guard",
      layout: layoutFor(dir),
    });
    try {
      await expect(
        createSandbox({
          env: {},
          branch: "sandbar/issue-20-guard",
          sandbox: makeLocalProvider(),
          layout: layoutFor(dir),
          copyToWorktree: ["fixture.txt"],
          preparedWorktreePath: worktreePath,
        }),
      ).rejects.toThrow(/copyToWorktree is ignored/);
    } finally {
      await git(["worktree", "remove", "--force", worktreePath], dir);
    }
  });

  it("removes the worktree when a host onWorktreeReady hook fails (F4)", async () => {
    await git(["branch", "sandbar/issue-20-f4"], dir);
    await expect(
      prepareWorktree({
        branch: "sandbar/issue-20-f4",
        layout: layoutFor(dir),
        hooks: { host: { onWorktreeReady: [{ command: "exit 1" }] } },
      }),
    ).rejects.toThrow();
    expect(
      existsSync(join(dir, ".sandbar", "worktrees", "sandbar-issue-20-f4")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Git mount discovery (#38 item 6)
// ---------------------------------------------------------------------------
//
// A linked worktree's `.git` is a file holding an absolute gitlink into the
// repo's common directory; in-container git can only follow it if that
// directory is mounted at its own absolute host path. The old discovery was
// structural — `<repo>/.git`, or the gitlink's target up two levels — which
// hardcoded the non-bare layout. Asked of git instead, the same question has
// one answer for a plain repo and for a bare cache, and BOTH are asserted
// because a fix that only handles the new shape breaks every embedding host
// that still hands sandbar an ordinary checkout.
describe("git mounts follow --git-common-dir, bare or not (#38)", () => {
  const cleanups: string[] = [];
  afterAll(async () => {
    for (const d of cleanups) await rm(d, { recursive: true, force: true });
  });

  const mountsFor = async (
    layout: RepoLayout,
    branch: string,
  ): Promise<readonly Mount[]> => {
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      branch,
      sandbox: provider,
      layout,
      env: {},
    });
    await sandbox.close();
    return provider.capturedMounts ?? [];
  };

  it("mounts the plain repo's .git directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asb-mounts-plain-"));
    cleanups.push(dir);
    await git(["init", "-b", "main"], dir);
    await git(["config", "user.name", "T"], dir);
    await git(["config", "user.email", "t@t"], dir);
    await writeFile(join(dir, "README.md"), "seed\n");
    await git(["add", "."], dir);
    await git(["commit", "-m", "seed"], dir);
    await git(["branch", "sandbar/issue-1-plain"], dir);

    const mounts = await mountsFor(layoutFor(dir), "sandbar/issue-1-plain");

    const extra = mounts.filter((m) => m.sandboxPath !== SANDBOX_REPO_DIR);
    expect(extra).toHaveLength(1);
    expect(extra[0]!.hostPath).toBe(join(dir, ".git"));
    // Identity: the gitlink inside the worktree names an absolute host path,
    // so the mount has to appear at that same path inside the container.
    expect(extra[0]!.sandboxPath).toBe(extra[0]!.hostPath);
  });

  it("mounts the bare cache itself for a worktree of it", async () => {
    const root = await mkdtemp(join(tmpdir(), "asb-mounts-bare-"));
    cleanups.push(root);
    const origin = join(root, "origin.git");
    const checkout = join(root, "checkout");
    await execFileP("git", ["init", "--bare", "-q", "-b", "main", origin]);
    await execFileP("git", ["clone", "-q", origin, checkout], { cwd: root });
    await git(["config", "user.name", "T"], checkout);
    await git(["config", "user.email", "t@t"], checkout);
    await writeFile(join(checkout, "README.md"), "seed\n");
    await git(["add", "."], checkout);
    await git(["commit", "-m", "seed"], checkout);
    await git(["push", "-q", "origin", "main"], checkout);

    const layout = repoLayout(checkout, ".sandbar");
    await ensureRepoCache(layout);
    await git(
      ["branch", "--no-track", "sandbar/issue-1-bare", "refs/remotes/origin/main"],
      layout.repoDir,
    );

    const mounts = await mountsFor(layout, "sandbar/issue-1-bare");

    const extra = mounts.filter((m) => m.sandboxPath !== SANDBOX_REPO_DIR);
    expect(extra).toHaveLength(1);
    // The cache directory itself — there is no `.git` inside it, which is
    // exactly what the structural discovery got wrong.
    expect(extra[0]!.hostPath).toBe(layout.repoDir);
    expect(extra[0]!.sandboxPath).toBe(layout.repoDir);
  });
});

// ---------------------------------------------------------------------------
// sandboxRunArgs (#42)
// ---------------------------------------------------------------------------

// The provider's own `podman run` needs a real podman and a real image, so the
// integration tests above drive a fake provider — which left this argv asserted
// by nothing. What podman *does* with `--init` is pinned separately, against
// real podman, in agent-sandbox-podman.test.ts.
describe("sandboxRunArgs (#42)", () => {
  const base = {
    containerName: "sandbar-w0011223-abc",
    imageName: "localhost/sandbar:latest",
    workdir: SANDBOX_REPO_DIR,
    env: {},
    volumeMounts: [],
    userns: "keep-id" as const,
    containerUid: 1000,
    containerGid: 1000,
    networks: [],
    publishPorts: [],
    groups: [],
    devices: [],
    cpus: undefined,
  };

  it("runs the sandbox under --init, so pid 1 reaps what the agent orphans", () => {
    expect(sandboxRunArgs(base)).toContain("--init");
  });

  it("keeps --init an option of run, not an argument of the entrypoint", () => {
    // `podman run ... --entrypoint sleep <image> infinity`: everything after the
    // image name belongs to `sleep`, so an --init appended there would be a
    // silent no-op that `toContain` alone would still accept.
    const args = sandboxRunArgs(base);
    expect(args.indexOf("--init")).toBeLessThan(args.indexOf(base.imageName));
  });

  it("still ends at the sleep entrypoint", () => {
    expect(sandboxRunArgs(base).slice(-4)).toEqual([
      "--entrypoint",
      "sleep",
      base.imageName,
      "infinity",
    ]);
  });

  it("carries the identity, workdir, env and mounts it was given", () => {
    const args = sandboxRunArgs({
      ...base,
      env: { HOME: "/home/agent", GH_TOKEN: "t" },
      volumeMounts: ["/host/wt:/home/agent/workspace:rw,z"],
      networks: ["sandbar-w0011223-net-1"],
      groups: [44, "video"],
      devices: ["/dev/fuse"],
      cpus: 2,
    });
    expect(args.slice(0, 4)).toEqual(["run", "-d", "--name", base.containerName]);
    expect(args).toEqual(
      expect.arrayContaining([
        "--user",
        "1000:1000",
        "--userns=keep-id:uid=1000,gid=1000",
        "--network",
        "sandbar-w0011223-net-1",
        "--group-add",
        "44",
        "--group-add",
        "video",
        "--device",
        "/dev/fuse",
        "--cpus",
        "2",
        "-w",
        SANDBOX_REPO_DIR,
        "-e",
        "HOME=/home/agent",
        "-e",
        "GH_TOKEN=t",
        "-v",
        "/host/wt:/home/agent/workspace:rw,z",
      ]),
    );
  });

  it("omits --userns when the provider was configured without one", () => {
    const args = sandboxRunArgs({ ...base, userns: false });
    expect(args.some((a) => a.startsWith("--userns"))).toBe(false);
    // The uid mapping is a separate flag and must survive.
    expect(args).toContain("--user");
    // ...and the reaper is not conditional on any of it.
    expect(args).toContain("--init");
  });

  // #44: the sandbox is the anchor of the sandbox stack's network namespace,
  // and podman refuses `-p` on a `--network container:` joiner — so a sibling's
  // `tcp` readiness port can only be published HERE. Loopback-only with podman
  // choosing the host side, so two concurrent sandboxes cannot collide and
  // nothing an agent's stack runs is reachable off-box.
  it("publishes the sandbox stack's probe ports loopback-only", () => {
    const args = sandboxRunArgs({ ...base, publishPorts: [3306, 1025] });
    const published = args.filter((a, i) => i > 0 && args[i - 1] === "-p");
    expect(published).toEqual(["127.0.0.1::3306", "127.0.0.1::1025"]);
    // Before the image ref, or they are arguments to `sleep`.
    expect(args.indexOf("-p")).toBeLessThan(args.indexOf(base.imageName));
  });

  // The mirror of the publish above, and the other half of the anchor's tax
  // (#44): podman refuses to remove a container others are attached to, so a
  // plain `rm -f` leaks the WHOLE chain on any path where a sibling outlived
  // its stack — a `stop` that threw, a SIGKILL between the two removals.
  it("removes the sandbox with its dependants, so an anchor is always removable", () => {
    expect(sandboxRemoveArgs("sandbar-w0011223-abc")).toEqual([
      "rm",
      "-f",
      "--depend",
      "sandbar-w0011223-abc",
    ]);
  });

  it("emits no empty optional flags", () => {
    expect(sandboxRunArgs(base)).toEqual([
      "run",
      "-d",
      "--name",
      base.containerName,
      "--init",
      "--user",
      "1000:1000",
      "--userns=keep-id:uid=1000,gid=1000",
      "-w",
      SANDBOX_REPO_DIR,
      "--entrypoint",
      "sleep",
      base.imageName,
      "infinity",
    ]);
  });
});
