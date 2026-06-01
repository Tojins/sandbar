// Tests for the in-house agent-sandbox module (the @ai-hero/sandcastle
// replacement). Covers the obligations in docs/sandcastle/05 §"Test
// obligations": the pure stream-json parser, BoundedTail (F1), the shutdown
// registry (F3), worktree-path compatibility with finalize.ts, and an
// integration harness using a LOCAL fake provider (no podman/container) against
// a real temp git repo that exercises createSandbox's lifecycle: per-run
// safe.directory, commit capture, the result||stdout fallback, env isolation,
// and the two-phase completion timer (F5).

import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { worktreePathFor } from "./finalize.js";
import {
  BoundedTail,
  MAX_TAIL_CHARS,
  type AgentProvider,
  type Mount,
  type ProviderCreateOptions,
  type SandboxProvider,
  claudeCode,
  createSandbox,
  defaultImageName,
  parseStreamJsonLine,
  registerShutdown,
} from "./agent-sandbox.js";

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
    expect(defaultImageName("/home/unixuser/sandbar")).toBe("sandcastle:sandbar");
    expect(defaultImageName("/x/My Repo!")).toBe("sandcastle:my-repo-");
    expect(defaultImageName("/")).toBe("sandcastle:local");
  });
});

// ---------------------------------------------------------------------------
// Shutdown registry (F3, obligation 16)
// ---------------------------------------------------------------------------

describe("registerShutdown", () => {
  it("installs a bounded, constant number of process listeners regardless of count", () => {
    const before = process.listenerCount("SIGINT");
    const unregs = Array.from({ length: 8 }, () => registerShutdown(() => {}));
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    for (const u of unregs) u();
    // Last unregister detaches the shared listener again.
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Worktree path compatibility with finalize.ts (obligation 3)
// ---------------------------------------------------------------------------

describe("worktree path layout", () => {
  it("matches finalize.ts:worktreePathFor for a slashed branch", () => {
    const repo = "/repo";
    const branch = "sandcastle/issue-5-add-foo";
    expect(worktreePathFor(repo, ".sandcastle", branch)).toBe(
      join(repo, ".sandcastle", "worktrees", "sandcastle-issue-5-add-foo"),
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: createSandbox lifecycle via a LOCAL fake provider
// ---------------------------------------------------------------------------

// A fake provider whose handle runs commands locally (`sh -c`) against the host
// worktree path — the model sandcastle's own test suite uses. It replicates the
// onLine readline join and captures the env it was handed.
function makeLocalProvider(): SandboxProvider & {
  capturedEnv?: Record<string, string>;
} {
  const provider: SandboxProvider & { capturedEnv?: Record<string, string> } = {
    tag: "bind-mount",
    name: "podman",
    env: {},
    sandboxHomedir: "/home/agent",
    create: async (opts: ProviderCreateOptions) => {
      provider.capturedEnv = opts.env;
      // sandboxRepoDir resolves to this handle.worktreePath; point it at the
      // real host worktree so local git runs in the right place.
      const worktreePath = opts.worktreePath;
      return {
        worktreePath,
        exec: (command, execOpts) =>
          new Promise((resolveExec, rejectExec) => {
            const proc = spawn("sh", ["-c", command], {
              cwd: execOpts?.cwd ?? worktreePath,
              env: { ...process.env },
              stdio: [
                execOpts?.stdin !== undefined ? "pipe" : "ignore",
                "pipe",
                "pipe",
              ],
            });
            if (execOpts?.stdin !== undefined && proc.stdin) {
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
        close: async () => {},
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
    await git(["branch", "sandcastle/issue-1-demo"], dir);
  });
  afterAll(async () => {
    for (const d of cleanups) await rm(d, { recursive: true, force: true });
  });

  it("creates a managed worktree under .sandcastle/worktrees and captures a commit", async () => {
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      branch: "sandcastle/issue-1-demo",
      sandbox: provider,
      cwd: dir,
    });
    try {
      expect(sandbox.worktreePath).toBe(
        join(dir, ".sandcastle", "worktrees", "sandcastle-issue-1-demo"),
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
      const log = await git(["log", "-1", "--format=%H", "sandcastle/issue-1-demo"], dir);
      expect(log.stdout.trim()).toBe(run.commits[0]!.sha);
    } finally {
      await sandbox.close();
    }
  });

  it("falls back to raw stdout when no result event is emitted, and reports zero commits for a no-op", async () => {
    await git(["branch", "sandcastle/issue-2-noop"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      branch: "sandcastle/issue-2-noop",
      sandbox: provider,
      cwd: dir,
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
    await git(["branch", "sandcastle/issue-3-id"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      branch: "sandcastle/issue-3-id",
      sandbox: provider,
      cwd: dir,
    });
    try {
      const agent = scriptedAgent(`printf '%s\\n' 'ok'`);
      await sandbox.run({ agent, prompt: "go", maxIterations: 1 });
      // The run() lifecycle wrote these into GIT_CONFIG_GLOBAL.
      const name = await execFileP("git", ["config", "--global", "user.name"]);
      expect(name.stdout.trim()).toBe("Test Host");
      const safe = await execFileP("git", [
        "config",
        "--global",
        "--get-all",
        "safe.directory",
      ]);
      expect(safe.stdout).toContain(sandbox.worktreePath);
    } finally {
      await sandbox.close();
    }
  });

  it("resolves the run via the completion-grace timer when the pipe is held open (F5)", async () => {
    await git(["branch", "sandcastle/issue-4-grace"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      branch: "sandcastle/issue-4-grace",
      sandbox: provider,
      cwd: dir,
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

  it("only forwards env keys declared in .sandcastle/.env (no host leakage)", async () => {
    await mkdir(join(dir, ".sandcastle"), { recursive: true });
    await writeFile(join(dir, ".sandcastle", ".env"), "DECLARED=\nLITERAL=fixed\n");
    await git(["branch", "sandcastle/issue-5-env"], dir);

    process.env.DECLARED = "from-host";
    process.env.UNDECLARED = "should-not-leak";
    try {
      const provider = makeLocalProvider();
      const sandbox = await createSandbox({
        branch: "sandcastle/issue-5-env",
        sandbox: provider,
        cwd: dir,
      });
      await sandbox.close();
      const env = provider.capturedEnv ?? {};
      expect(env.DECLARED).toBe("from-host"); // empty in file → process.env fallback
      expect(env.LITERAL).toBe("fixed");
      expect(env.UNDECLARED).toBeUndefined(); // host env does not leak
      expect("PATH" in env).toBe(false);
    } finally {
      delete process.env.DECLARED;
      delete process.env.UNDECLARED;
    }
  });

  it("loads env from config.envFilePath, not the fixed .sandcastle/.env (issue #5)", async () => {
    // A populated custom file (e.g. the v0.2.0 `.sandbar/.env` rename) must be
    // honoured even when `.sandcastle/.env` is absent or holds a stale value.
    await mkdir(join(dir, ".sandbar"), { recursive: true });
    await writeFile(join(dir, ".sandbar", ".env"), "GH_TOKEN=from-sandbar\n");
    await mkdir(join(dir, ".sandcastle"), { recursive: true });
    await writeFile(join(dir, ".sandcastle", ".env"), "GH_TOKEN=stale-default\n");
    await git(["branch", "sandcastle/issue-5-path"], dir);

    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      branch: "sandcastle/issue-5-path",
      sandbox: provider,
      cwd: dir,
      envFilePath: join(dir, ".sandbar", ".env"),
    });
    await sandbox.close();
    const env = provider.capturedEnv ?? {};
    expect(env.GH_TOKEN).toBe("from-sandbar"); // honoured the override
    expect(env.GH_TOKEN).not.toBe("stale-default"); // ignored the fixed path
  });
});
