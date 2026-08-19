// Tests for the in-house agent-sandbox module (the @ai-hero/sandcastle
// replacement; provenance only — that package is no longer a dependency).
// Covers the obligations in docs/agent-sandbox/05 §"Test
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
  claudeCode,
  createSandbox,
  defaultImageName,
  parseStreamJsonLine,
  prepareWorktree,
  registerShutdown,
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
function makeLocalProvider(): SandboxProvider & {
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
