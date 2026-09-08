// `captureAgentRun` against REAL child processes (#67).
//
// Everything this function claims is a claim about `child_process`, not about
// podman: that `close` is the point at which a large stdout has arrived and
// `exit` is not, that a SIGTERM'd child is reported as our timeout rather than
// as a signal, that a spawn which never produced a process is a third thing,
// and that writing a prompt to a child that has already gone does not take the
// run down with an uncaught EPIPE. None of that is assertable against a mock —
// the mock would be the thing under test — so these run `node` and `sh`.
//
// The one bound on a test here is vitest's own; every case exits on its own or
// is killed by a timeout this file sets in milliseconds.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildAgentProvider } from "./agent-providers.js";
import {
  buildResolveRunArgv,
  buildResolveExecArgv,
  captureAgentRun,
  parseCapturedAgentRun,
  realAdapter,
  resolveAgentCredentials,
} from "./merger.js";
import { runScope } from "./naming.js";
import { isInfraFailure, parseResolveSignal } from "./resolve-loop.js";
import type { BoundedRuntimeResult } from "./runtime.js";

const opts = (timeoutMs = 30_000) => ({ container: "c-under-test", timeoutMs });

// `node -e` rather than a shell, so the same script runs whatever /bin/sh is.
const node = (script: string): [string, string[]] => [
  process.execPath,
  ["-e", script],
];

describe("captureAgentRun (#67)", () => {
  it("captures stdout, stderr and the exit code of a process that ran", async () => {
    const [file, args] = node(
      `process.stdout.write("said something"); process.stderr.write("complained"); process.exit(3);`,
    );
    const run = await captureAgentRun(file, args, "", opts());
    expect(run.stdout).toBe("said something");
    // stderr used to be piped to nobody: on the failure #67 is about, it is
    // the whole of the diagnosis.
    expect(run.stderr).toBe("complained");
    expect(run.end).toBe("exit");
    expect(run.exitCode).toBe(3);
    expect(run.signal).toBeNull();
    expect(run.container).toBe("c-under-test");
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  // A real agent transcript is far larger than a pipe buffer and arrives in
  // chunks. This pins that none of it is dropped — which matters more since
  // #67 than it did before, because an EMPTY capture now halts the run: a
  // capture that truncated all the way down would report a working agent as a
  // container that never started. (It does not, by itself, prove the `close`
  // rather than `exit` settle: that race is timing-dependent and does not
  // reproduce on demand. The settle is on `close` because node documents
  // `exit` as able to precede the stdio streams closing, not because this case
  // catches it.)
  it("captures a transcript far larger than the pipe buffer, whole", async () => {
    // No explicit `process.exit`: that discards a pipe write the runtime has
    // not flushed yet, which would be the CHILD truncating rather than us.
    const [file, args] = node(
      `process.stdout.write("x".repeat(4 * 1024 * 1024));`,
    );
    const run = await captureAgentRun(file, args, "", opts());
    expect(run.stdout).toHaveLength(4 * 1024 * 1024);
    expect(run.end).toBe("exit");
  });

  it("reads the prompt from stdin", async () => {
    const [file, args] = node(
      `let b=""; process.stdin.on("data",c=>b+=c); process.stdin.on("end",()=>process.stdout.write("got:"+b));`,
    );
    const run = await captureAgentRun(file, args, "the prompt", opts());
    expect(run.stdout).toBe("got:the prompt");
  });

  // The case in the run that filed #67: attempt 1 killed at the ten-minute
  // budget. It has to come back as OUR timeout and not as "killed by SIGTERM",
  // because the signal is ours and the elapsed budget is the fact.
  it("reports the timeout as a timeout, not as the signal it sent", async () => {
    const [file, args] = node(`setTimeout(() => {}, 60_000);`);
    const run = await captureAgentRun(file, args, "", opts(150));
    expect(run.end).toBe("timeout");
    expect(run.stdout).toBe("");
    expect(run.durationMs).toBeGreaterThanOrEqual(100);
  });

  // Whatever the agent managed to print before the budget ran out is still
  // captured — a timeout is a spent attempt, and what it printed is the only
  // record of what it was doing.
  it("keeps the output a timed-out process had already produced", async () => {
    const [file, args] = node(
      `process.stdout.write("partway through"); setTimeout(() => {}, 60_000);`,
    );
    const run = await captureAgentRun(file, args, "", opts(300));
    expect(run.end).toBe("timeout");
    expect(run.stdout).toBe("partway through");
  });

  it("reports a signal that was not ours as a signal", async () => {
    const [file, args] = node(`process.kill(process.pid, "SIGKILL");`);
    const run = await captureAgentRun(file, args, "", opts());
    expect(run.end).toBe("signal");
    expect(run.signal).toBe("SIGKILL");
    expect(run.exitCode).toBeNull();
  });

  // A runtime that is not installed at all. Distinct from every other end,
  // because there is no exit status to report and no output to wait for.
  it("reports a binary that does not exist as a spawn-error, with the reason", async () => {
    const run = await captureAgentRun(
      "sandbar-no-such-binary-67",
      [],
      "prompt",
      opts(),
    );
    expect(run.end).toBe("spawn-error");
    expect(run.detail).toContain("ENOENT");
    expect(run.stdout).toBe("");
  });

  // The EPIPE guard, exercised rather than asserted: a child that exits before
  // reading its prompt makes the stdin write fail, and an unhandled 'error' on
  // that stream is an uncaught exception out of a promise executor — which
  // would take the whole run down past every structured handler run.ts has.
  it("survives writing a prompt to a child that has already gone", async () => {
    const [file, args] = node(`process.exit(9);`);
    const run = await captureAgentRun(
      file,
      args,
      "x".repeat(2_000_000),
      opts(),
    );
    expect(run.end).toBe("exit");
    expect(run.exitCode).toBe(9);
  });
});

describe("parseCapturedAgentRun (#74)", () => {
  const captured = (stdout: string) => ({
    stdout,
    stderr: "raw stderr",
    end: "exit" as const,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    container: "resolve-1",
  });

  it("takes resolve promises from codex agent speech, not raw JSONL", () => {
    const raw = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "<promise>ABANDON</promise>" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "<promise>COMMITTED</promise>" },
      }),
    ].join("\n");
    const run = parseCapturedAgentRun(captured(raw), buildAgentProvider("codex", "m"));
    expect(run.stdout).toBe(raw);
    expect(parseResolveSignal(run.output ?? "")).toEqual({ kind: "COMMITTED" });
  });

  it("carries a failed Claude quota capture to the attempt sink", () => {
    const raw = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected", rateLimitType: "five_hour", resetsAt: 123,
        unifiedWindows: { five_hour: { utilization: 1, resetsAt: 123 } },
      },
    });
    const run = parseCapturedAgentRun(
      { ...captured(raw), exitCode: 1 },
      buildAgentProvider("claude", "m"),
    );
    expect(run).toMatchObject({
      verdict: "quota",
      rateLimit: { status: "rejected", window: "five_hour", resetsAt: 123 },
    });
  });

  it("carries usage and all four Codex tool item types beside resolve speech", () => {
    const raw = [
      ...["command_execution", "file_change", "mcp_tool_call", "web_search"].map(
        (type) => JSON.stringify({ type: "item.completed", item: { type } }),
      ),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 20,
          cached_input_tokens: 12,
          cache_write_input_tokens: 0,
          output_tokens: 4,
          reasoning_output_tokens: 2,
        },
      }),
    ].join("\n");
    const run = parseCapturedAgentRun(captured(raw), buildAgentProvider("codex", "m"));
    expect(run.usage).toEqual({
      inputTokens: 8,
      cachedInputTokens: 12,
      cacheWriteInputTokens: 0,
      outputTokens: 4,
      reasoningTokens: 2,
    });
    expect(run.toolCalls).toBe(4);
    // Exec's terminal ledger is cumulative; per-turn depth is available only
    // from the live sandbox's rollout side channel.
    expect(run.peakContext).toBeUndefined();
    expect(run.output).toBe("");
  });

  it("takes the default claude promise from its parsed result event", () => {
    const raw = [
      JSON.stringify({
        type: "user",
        message: { content: "<promise>ABANDON</promise>" },
      }),
      JSON.stringify({
        type: "result",
        result: "<promise>COMMITTED</promise>",
      }),
    ].join("\n");
    const run = parseCapturedAgentRun(captured(raw), buildAgentProvider("claude", "m"));
    expect(run.stdout).toBe(raw);
    expect(parseResolveSignal(run.output)).toEqual({ kind: "COMMITTED" });
  });

  it("never reads a promise from a non-speech claude frame", () => {
    const raw = JSON.stringify({
      type: "user",
      message: { content: "<promise>ABANDON</promise>" },
    });
    const run = parseCapturedAgentRun(captured(raw), buildAgentProvider("claude", "m"));
    expect(run.stdout).toBe(raw);
    expect(run.output).toBe("");
    expect(isInfraFailure(run)).toBe(true);
  });

  it("treats a terminal provider failure without speech as infra", () => {
    const raw = JSON.stringify({
      type: "turn.failed",
      error: { message: "pool spent" },
    });
    const run = parseCapturedAgentRun(captured(raw), buildAgentProvider("codex", "m"));
    expect(run.output).toBe("");
    expect(run.detail).toBe("pool spent");
    expect(isInfraFailure(run)).toBe(true);
  });

  it("retains the permanent Codex credential classification for the resolve loop", () => {
    const detail = "Your access token could not be refreshed. Please log out and sign in again.";
    const run = parseCapturedAgentRun(captured(JSON.stringify({
      type: "turn.failed",
      error: { message: detail },
    })), buildAgentProvider("codex", "m"));
    expect(run).toMatchObject({
      cause: "credential",
      verdict: "credential",
      detail,
    });
  });

  it("does not promote raw stderr into the merger's narrow detail", () => {
    const run = parseCapturedAgentRun(
      { ...captured(""), exitCode: 125, stderr: "unbounded runtime stderr" },
      buildAgentProvider("codex", "m"),
    );
    expect(run.cause).toBe("provider-failure");
    expect(run.detail).toBeUndefined();
    expect(run.stderr).toBe("unbounded runtime stderr");
  });

  it("keeps a spawn error ahead of an in-band provider failure", () => {
    const raw = JSON.stringify({ type: "turn.failed", error: { message: "provider" } });
    const run = parseCapturedAgentRun(
      { ...captured(raw), end: "spawn-error", exitCode: null, detail: "ENOENT" },
      buildAgentProvider("codex", "m"),
    );
    expect(run.cause).toBe("spawn-error");
    expect(run.detail).toBe("ENOENT");
  });

  it("keeps agent speech when a terminal failure follows it", () => {
    const raw = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "partial answer" },
      }),
      JSON.stringify({
        type: "turn.failed",
        error: { message: "terminal fault" },
      }),
    ].join("\n");
    const run = parseCapturedAgentRun(captured(raw), buildAgentProvider("codex", "m"));
    expect(run.output).toBe("partial answer");
    expect(run.detail).toBe("terminal fault");
    expect(isInfraFailure(run)).toBe(false);
  });

  it("carries a parser shape error as infra data so capture can be logged", () => {
    const provider = buildAgentProvider("claude", "m");
    const run = parseCapturedAgentRun(
      captured(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: null }] },
      })),
      provider,
    );
    expect(run.cause).toBe("parse-error");
    expect(run.verdict).toBe("infra");
    expect(run.detail).toContain("stream parse failed");
    expect(run.stdout).toContain("tool_use");
  });

  it("stops ingesting after the first parser shape error", () => {
    const raw = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: null }] },
      }),
      JSON.stringify({ type: "result", result: "must not become speech" }),
    ].join("\n");
    const run = parseCapturedAgentRun(captured(raw), buildAgentProvider("claude", "m"));
    expect(run.cause).toBe("parse-error");
    expect(run.output).toBe("");
  });
});

describe("resolve provider invocation (#74)", () => {
  const values: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
    ANTHROPIC_API_KEY: "anthropic-key",
    CODEX_AUTH_JSON: "codex-auth",
    OPENAI_API_KEY: "openai-key",
    GH_TOKEN: "github-key",
  };

  it.each([
    [
      "claude",
      ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
      ["CODEX_AUTH_JSON", "OPENAI_API_KEY"],
    ],
    [
      "codex",
      ["OPENAI_API_KEY"],
      ["CODEX_AUTH_JSON", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    ],
  ] as const)(
    "routes only %s credentials into the resolve argv",
    (provider, present, absent) => {
      const credentials = resolveAgentCredentials(provider, (key) => values[key]);
      const argv = buildResolveRunArgv({
        container: "resolve-1",
        cwd: "/worktree",
        extraMounts: ["/git-common"],
        image: "sandbox-image",
        credentials,
        botName: "sandbar-bot",
        botEmail: "bot@example.test",
      });
      const joined = argv.join(" ");
      for (const key of present) {
        expect(joined).toContain(`${key}=${values[key]}`);
      }
      for (const key of absent) expect(joined).not.toContain(`${key}=`);
      expect(joined).toContain("GH_TOKEN=github-key");
      expect(argv.slice(-4)).toEqual([
        "--entrypoint",
        "sleep",
        "sandbox-image",
        "infinity",
      ]);
      expect(argv).toContain("/git-common:/git-common");
    },
  );

  it("pins the complete resolve-container argv", () => {
    const argv = buildResolveRunArgv({
      container: "resolve-1",
      cwd: "/worktree",
      extraMounts: ["/git-common"],
      image: "sandbox-image",
      credentials: {},
      botName: "sandbar-bot",
      botEmail: "bot@example.test",
    });
    expect(argv).toEqual([
      "run", "-d", "--image-volume=ignore",
      "--name", "resolve-1",
      "--userns=keep-id", "--user", "1000:1000",
      "-v", "/worktree:/workspace", "-v", "/git-common:/git-common",
      "-w", "/workspace", "-e", "HOME=/tmp",
      "--label", "sandbar=true",
      "-e", "GIT_AUTHOR_NAME=sandbar-bot",
      "-e", "GIT_AUTHOR_EMAIL=bot@example.test",
      "-e", "GIT_COMMITTER_NAME=sandbar-bot",
      "-e", "GIT_COMMITTER_EMAIL=bot@example.test",
      "--entrypoint", "sleep", "sandbox-image", "infinity",
    ]);
    expect(argv).not.toContain("--init");
    // #141 runs the agent through exec while this PID 1 keeps its cgroup live,
    // then the adapter measures and explicitly removes the container.
    expect(argv).not.toContain("--rm");
    expect(buildResolveExecArgv("resolve-1", "agent --print")).toEqual([
      "exec", "-i", "resolve-1", "/bin/sh", "-c", "agent --print",
    ]);
  });

  it("mounts the shared Codex credential read-write without putting it in env", () => {
    const argv = buildResolveRunArgv({
      container: "resolve-1",
      cwd: "/worktree",
      extraMounts: [],
      codexAuthMount: {
        hostPath: "/state/codex-auth.json",
        sandboxPath: "/home/agent/.codex/auth.json",
      },
      image: "sandbox-image",
      credentials: {},
      botName: "sandbar-bot",
      botEmail: "bot@example.test",
    });
    expect(argv).toContain("/state/codex-auth.json:/home/agent/.codex/auth.json:z");
    expect(argv).toContain("CODEX_HOME=/home/agent/.codex");
    expect(argv.join(" ")).not.toContain("CODEX_AUTH_JSON=");
  });

  it("forwards the shared credential through the real adapter into Podman argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbar-resolve-auth-"));
    const argvLog = join(root, "podman-argv.json");
    const originalPath = process.env["PATH"];
    const podman = join(root, "podman");
    await writeFile(podman, [
      `#!${process.execPath}`,
      'const { appendFileSync } = require("node:fs");',
      'const args = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");`,
      'if (args[0] === "run") process.stdout.write("container-id\\n");',
      'if (args[0] === "exec") process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"<promise>ABANDON</promise>"}}) + "\\n");',
      'if (args[0] === "inspect") process.stdout.write("\\nfalse\\n");',
      'if (args[0] === "stats") process.stdout.write("2048 / 4096\\n");',
    ].join("\n"), { mode: 0o755 });
    process.env["PATH"] = `${root}:${originalPath ?? ""}`;

    const codexAuthMount = {
      hostPath: join(root, "codex-auth.json"),
      sandboxPath: "/var/lib/codex/auth.json",
    };
    try {
      const adapter = realAdapter({
        cwd: root,
        cacheDir: join(root, "repo.git"),
        scope: runScope(root),
        repo: { owner: "acme", name: "app" },
        sourceBranch: "main",
        botName: "sandbar-bot",
        botEmail: "bot@example.test",
        coauthorTrailer: "Co-authored-by: Sandbar <bot@example.test>",
        mergerAgent: "codex",
        mergerModelId: "gpt-5.6-sol",
        sandboxImage: "sandbox-image",
        env: (key) => key === "CODEX_AUTH_JSON" ? "secret-json" : undefined,
        codexAuthMount,
        runStackGate: async () => { throw new Error("not called"); },
      });

      const run = await adapter.runResolveAgent("resolve this", 1);
      expect(run.output).toBe("<promise>ABANDON</promise>");
      const calls = (await readFile(argvLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const argv = calls.find((args) => args[0] === "run")!;
      expect(argv).toContain(
        `${codexAuthMount.hostPath}:${codexAuthMount.sandboxPath}:z`,
      );
      expect(argv).toContain("CODEX_HOME=/var/lib/codex");
      expect(argv?.join(" ")).not.toContain("CODEX_AUTH_JSON=");
      expect(calls.map((args) => args[0])).toEqual([
        "run", "exec", "inspect", "stats", "rm",
      ]);
      expect(run).toMatchObject({ peakMemoryBytes: 2048, oomKilled: false });
    } finally {
      if (originalPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["exit", 0, null],
    ["exit", 7, null],
    ["timeout", null, "SIGTERM"],
    ["signal", null, "SIGKILL"],
    ["spawn-error", null, null],
  ] as const)(
    "measures a live resolve cgroup before explicit removal after %s",
    async (end, exitCode, signal) => {
      const order: string[] = [];
      const runtimeResult = (stdout = ""): BoundedRuntimeResult => ({
        stdout,
        stderr: "",
        exitCode: 0,
        timedOut: false,
        maxBufferExceeded: false,
        errorMessage: "",
      });
      const podman = vi.fn(async (args: readonly string[]) => {
        order.push(args[0] ?? "");
        if (args[0] === "inspect") {
          return runtimeResult("\ntrue\n");
        }
        if (args[0] === "stats") return runtimeResult("8192 / 16384\n");
        return runtimeResult();
      });
      const captureResolveProcess = vi.fn(async (
        _file: string,
        args: readonly string[],
      ) => {
        order.push(args[0] ?? "");
        if (args[0] === "run") {
          return {
            stdout: "container-id\n", stderr: "", end: "exit" as const,
            exitCode: 0, signal: null, durationMs: 1, container: "resolve-test",
          };
        }
        return {
          stdout: JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "<promise>ABANDON</promise>" },
          }),
          stderr: "",
          end,
          exitCode,
          signal,
          durationMs: 2,
          container: "resolve-test",
        };
      });
      const adapter = realAdapter({
        cwd: "/worktree",
        cacheDir: "/cache.git",
        scope: runScope("/worktree"),
        repo: { owner: "acme", name: "app" },
        sourceBranch: "main",
        botName: "sandbar-bot",
        botEmail: "bot@example.test",
        coauthorTrailer: "Co-authored-by: Sandbar <bot@example.test>",
        mergerAgent: "codex",
        mergerModelId: "gpt-5.6-sol",
        sandboxImage: "sandbox-image",
        env: () => undefined,
        runStackGate: async () => { throw new Error("not called"); },
        podman,
        captureResolveProcess,
      });

      const run = await adapter.runResolveAgent("resolve this", 1);
      expect(run).toMatchObject({ peakMemoryBytes: 8192, oomKilled: true });
      expect(order).toEqual(["run", "exec", "inspect", "stats", "rm"]);
      expect(order.indexOf("inspect")).toBeLessThan(order.indexOf("rm"));
    },
  );

  it("removes the resolve container and preserves a thrown capture failure", async () => {
    const primary = new Error("capture seam failed");
    const order: string[] = [];
    const runtimeResult = (stdout = ""): BoundedRuntimeResult => ({
      stdout,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      maxBufferExceeded: false,
      errorMessage: "",
    });
    const podman = vi.fn(async (args: readonly string[]) => {
      order.push(args[0] ?? "");
      if (args[0] === "inspect") return runtimeResult("\nfalse\n");
      if (args[0] === "stats") return runtimeResult("1024 / 2048\n");
      return runtimeResult();
    });
    const captureResolveProcess = vi.fn(async (
      _file: string,
      args: readonly string[],
    ) => {
      order.push(args[0] ?? "");
      if (args[0] === "exec") throw primary;
      return {
        stdout: "container-id\n", stderr: "", end: "exit" as const,
        exitCode: 0, signal: null, durationMs: 1, container: "resolve-test",
      };
    });
    const adapter = realAdapter({
      cwd: "/worktree",
      cacheDir: "/cache.git",
      scope: runScope("/worktree"),
      repo: { owner: "acme", name: "app" },
      sourceBranch: "main",
      botName: "sandbar-bot",
      botEmail: "bot@example.test",
      coauthorTrailer: "Co-authored-by: Sandbar <bot@example.test>",
      mergerAgent: "codex",
      mergerModelId: "gpt-5.6-sol",
      sandboxImage: "sandbox-image",
      env: () => undefined,
      runStackGate: async () => { throw new Error("not called"); },
      podman,
      captureResolveProcess,
    });

    await expect(adapter.runResolveAgent("resolve this", 1)).rejects.toBe(primary);
    expect(order).toEqual(["run", "exec", "inspect", "stats", "rm"]);
  });
});
