// Tests for the in-house agent-sandbox module (the @ai-hero/sandcastle
// replacement; provenance only — that package is no longer a dependency).
// Covers the obligations in docs/agent-sandbox/05 §"Test
// obligations": the pure stream-json parser, BoundedTail (F1), the shutdown
// registry (F3), worktree-path compatibility with finalize.ts, and an
// integration harness using a LOCAL fake provider (no podman/container) against
// a real temp git repo that exercises createSandbox's lifecycle: per-run
// safe.directory, commit capture, the parsed speech output, env isolation,
// and the two-phase completion timer (F5).

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type RepoLayout,
  ensureRepoCache,
  repoLayout,
  worktreePathFor,
} from "./repo-cache.js";
import {
  BoundedTail,
  CODEX_AUTH_SEED,
  MAX_TAIL_CHARS,
  type AgentProvider,
  type Mount,
  type ProviderCreateOptions,
  type SandboxProvider,
  SANDBOX_REPO_DIR,
  AgentError,
  AgentIdleTimeoutError,
  agentPartialOutput,
  agentPartialUsage,
  claudeCode,
  codex,
  createAgentSpeechAccumulator,
  createSandbox,
  defaultImageName,
  killOnAbort,
  parseCodexJsonLine,
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

  it("classifies malformed JSON that starts with { as transport", () => {
    expect(parseStreamJsonLine("{bad json")).toEqual([]);
  });

  it.each([
    '{"type":"assistant","message":{"content":[null]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":null}]}}',
  ])("propagates a provider-shape fault after parsing valid JSON", (line) => {
    expect(() => parseStreamJsonLine(line)).toThrow(TypeError);
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
      { type: "tool_calls", count: 1 },
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
    // Read is not allowlisted for the informational register, but every
    // verified tool_use shape contributes to the independent counter.
    expect(parseStreamJsonLine(line)).toEqual([
      { type: "tool_calls", count: 1 },
      { type: "text", text: "ab" },
    ]);
  });

  it("drops a tool_use with a non-string arg field", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: 42 } }] },
    });
    expect(parseStreamJsonLine(line)).toEqual([{ type: "tool_calls", count: 1 }]);
  });

  it("parses a result event verbatim, including the promise token", () => {
    const line = JSON.stringify({ type: "result", result: "done <promise>COMPLETE</promise>" });
    expect(parseStreamJsonLine(line)).toEqual([
      { type: "result", result: "done <promise>COMPLETE</promise>" },
    ]);
  });

  it("reads usage beside a Claude result without folding it into speech", () => {
    const events = parseStreamJsonLine(JSON.stringify({
      type: "result",
      result: "done",
      duration_api_ms: 4321,
      modelUsage: {
        "claude-opus-raw": { inputTokens: 1200, cacheReadInputTokens: 900, cacheCreationInputTokens: 25, outputTokens: 80, thinkingTokens: 40, canonicalModel: "claude-opus" },
        "claude-haiku": { inputTokens: 5, cacheReadInputTokens: 10, outputTokens: 10, thinkingTokens: 5 },
      },
    }));
    expect(events).toEqual([
      { type: "result", result: "done" },
      {
        type: "usage",
        usage: {
          inputTokens: 1205,
          cachedInputTokens: 910,
          cacheWriteInputTokens: 25,
          outputTokens: 90,
          apiMs: 4321,
          reasoningTokens: 45,
          resolvedModel: "claude-opus",
          models: 2,
        },
      },
    ]);
  });

  it("uses Claude's complete model ledger instead of its main-loop usage", () => {
    expect(parseStreamJsonLine(JSON.stringify({
      type: "result",
      result: "done",
      usage: { input_tokens: 10 },
      modelUsage: { "claude-haiku-4-5": { inputTokens: 910 } },
    }))).toEqual([
      { type: "result", result: "done" },
      { type: "usage", usage: {
        inputTokens: 910,
        resolvedModel: "claude-haiku-4-5",
      } },
    ]);
  });

  it("reads a fresh Claude continuation ledger", () => {
    expect(parseStreamJsonLine(JSON.stringify({
      type: "result",
      result: "continued",
      duration_api_ms: 1143,
      modelUsage: {
        "claude-opus": {
          inputTokens: 8,
          cacheReadInputTokens: 18700,
          outputTokens: 5,
        },
      },
    }))).toEqual([
      { type: "result", result: "continued" },
      { type: "usage", usage: {
        inputTokens: 8,
        cachedInputTokens: 18700,
        outputTokens: 5,
        apiMs: 1143,
        resolvedModel: "claude-opus",
      } },
    ]);
  });

  it("omits Claude reasoning tokens when no model usage entry reports them", () => {
    expect(parseStreamJsonLine(JSON.stringify({
      type: "result",
      result: "done",
      modelUsage: {
        "older-turn": { outputTokens: 10 },
        malformed: { thinkingTokens: "5" },
      },
    }))).toEqual([
      { type: "result", result: "done" },
      { type: "usage", usage: { outputTokens: 10, resolvedModel: "older-turn", models: 2 } },
    ]);
  });

  it("keeps the result and omits malformed Claude usage fields", () => {
    expect(parseStreamJsonLine(JSON.stringify({
      type: "result",
      result: "done",
      usage: { input_tokens: "1200", output_tokens: null },
      duration_api_ms: "4321",
    }))).toEqual([{ type: "result", result: "done" }]);
  });

  it("reads usage and terminal reason independently of error result speech", () => {
    expect(parseStreamJsonLine(JSON.stringify({
      type: "result", subtype: "error_during_execution", terminal_reason: "blocking_limit",
      errors: ["limit"], modelUsage: { "claude-opus": { inputTokens: 4 } },
    }))).toEqual([{ type: "usage", usage: {
      inputTokens: 4, resolvedModel: "claude-opus", terminalReason: "blocking_limit",
    } }]);
  });

  // #85 reads usage independently of the speech guard; the guard itself is
  // unchanged, so a non-string `result` still contributes no speech.
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
// codex (#72) — line parser and command line
// ---------------------------------------------------------------------------
//
// Fixtures are the real wire format of codex-cli 0.152.0 (its event union is
// `@openai/codex-sdk`'s ThreadEvent), captured from a live `codex exec --json`
// run rather than transcribed from the issue.

describe("parseCodexJsonLine", () => {
  const completed = (item: unknown) =>
    JSON.stringify({ type: "item.completed", item });

  it("classifies non-{ lines, malformed JSON, and unknown events as transport", () => {
    expect(parseCodexJsonLine("")).toEqual([]);
    expect(parseCodexJsonLine("Reading prompt from stdin...")).toEqual([]);
    expect(parseCodexJsonLine("{bad json")).toEqual([]);
    expect(parseCodexJsonLine('{"type":"turn.started"}')).toEqual([]);
    expect(parseCodexJsonLine('{"type":"future.event","text":"x"}')).toEqual([]);
  });

  it("reads an agent message as text", () => {
    expect(
      parseCodexJsonLine(
        completed({
          id: "item_1",
          type: "agent_message",
          text: "<promise>COMPLETE</promise>",
        }),
      ),
    ).toEqual([{ type: "text", text: "<promise>COMPLETE</promise>" }]);
  });

  it("reads thread.started as the session id", () => {
    expect(
      parseCodexJsonLine('{"type":"thread.started","thread_id":"01a05c69-362e"}'),
    ).toEqual([{ type: "session_id", sessionId: "01a05c69-362e" }]);
  });

  it("reads turn.completed usage and does not invent an API duration", () => {
    expect(parseCodexJsonLine(JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 2000,
        cached_input_tokens: 1750,
        cache_write_input_tokens: 25,
        output_tokens: 100,
        reasoning_output_tokens: 60,
      },
    }))).toEqual([{
      type: "usage",
      usage: {
        inputTokens: 250,
        cachedInputTokens: 1750,
        cacheWriteInputTokens: 25,
        outputTokens: 100,
        reasoningTokens: 60,
      },
    }]);
  });

  it("normalizes a resumed Codex turn as its own near-total cache-hit ledger", () => {
    expect(parseCodexJsonLine(JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 15345,
        cached_input_tokens: 15104,
        cache_write_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 0,
      },
    }))).toEqual([{ type: "usage", usage: {
      inputTokens: 241,
      cachedInputTokens: 15104,
      cacheWriteInputTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
    } }]);
  });

  it("drops a turn.completed event whose usage has no numeric fields", () => {
    expect(parseCodexJsonLine(JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: "2000", output_tokens: null },
    }))).toEqual([]);
  });

  it("keeps usage separate from speech, failure, and completion", () => {
    const speech = createAgentSpeechAccumulator();
    speech.ingest(parseCodexJsonLine(JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 12 },
    })));
    // Never speech, so it can neither reach a verdict parser (#41) nor enter
    // the string the completion watch scans (#83) — the one way to get this
    // wrong is to wire `turn.completed` as a completion rather than a
    // measurement.
    expect(speech.accumulated).toBe("");
    expect(speech.spoken).toBe("");
    expect(speech.failure).toBeUndefined();
    expect(speech.usage).toEqual({
      inputTokens: 12,
    });
    expect(speech.toolCalls).toBe(0);
  });

  it("replaces repeated usage measurements instead of summing them", () => {
    const speech = createAgentSpeechAccumulator();
    speech.ingest([
      { type: "usage", usage: { inputTokens: 12, outputTokens: 3 } },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } },
    ]);
    expect(speech.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  // Reasoning is the model's own thinking, not its speech. Folded into the
  // accumulated output it would let an agent that merely CONSIDERED emitting
  // the completion tag end the run by talking about it — and that output is
  // handed verbatim to the promise/verdict parsers.
  it("drops reasoning, so deliberation cannot trip the completion signal", () => {
    expect(
      parseCodexJsonLine(
        completed({
          id: "item_0",
          type: "reasoning",
          text: "I should finish by emitting <promise>COMPLETE</promise>",
        }),
      ),
    ).toEqual([]);
  });

  // Only `turn.failed` is terminal, and the difference decides whether a
  // reconnect reaches a human. `invokeAgent` rejects on a `failure`, so a
  // parser that spent one on a retry notice would turn a websocket blip into
  // HARD-ERROR → NEEDS-HUMAN. These three lines are a live 0.152.0 run with no
  // credential, in the order it printed them.
  it("reads only turn.failed as a failure; retries and notices are transport", () => {
    expect(
      parseCodexJsonLine(
        '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401)"}',
      ),
    ).toEqual([]);
    expect(
      parseCodexJsonLine(
        completed({
          id: "item_0",
          type: "error",
          message: "Falling back from WebSockets to HTTPS transport.",
        }),
      ),
    ).toEqual([]);
    expect(
      parseCodexJsonLine(
        '{"type":"turn.failed","error":{"message":"unexpected status 401"}}',
      ),
    ).toEqual([{ type: "failure", message: "unexpected status 401" }]);
  });

  // The give-up `error` event is shaped identically to the retries above it —
  // same type, same field — so nothing at the line level tells them apart.
  // Reading it would buy the false positive; dropping it costs nothing, since
  // `turn.failed` follows it carrying the same message.
  it("drops the fatal top-level error too, since turn.failed repeats it", () => {
    expect(
      parseCodexJsonLine('{"type":"error","message":"401 Unauthorized"}'),
    ).toEqual([]);
  });

  // The message is the whole of the AgentError a human reads, so a turn.failed
  // carrying no usable message must still say which half of the system failed
  // rather than rejecting with a blank line.
  it("names a failure whose message is missing or the wrong type", () => {
    for (const line of [
      '{"type":"turn.failed"}',
      '{"type":"turn.failed","error":{}}',
      '{"type":"turn.failed","error":{"message":42}}',
      '{"type":"turn.failed","error":{"message":"   "}}',
      '{"type":"turn.failed","error":"401 Unauthorized"}',
    ]) {
      expect(parseCodexJsonLine(line)).toEqual([
        { type: "failure", message: "no message" },
      ]);
    }
  });

  it("reports command execution and web search as informational tool calls", () => {
    expect(
      parseCodexJsonLine(
        completed({
          id: "item_2",
          type: "command_execution",
          command: "bash -lc 'npm test'",
          aggregated_output: "ok",
          exit_code: 0,
          status: "completed",
        }),
      ),
    ).toEqual([
      { type: "tool_call", name: "command_execution", args: "bash -lc 'npm test'" },
      { type: "tool_calls", count: 1 },
    ]);
    expect(
      parseCodexJsonLine(
        completed({ id: "item_3", type: "web_search", query: "podman keep-id" }),
      ),
    ).toEqual([
      { type: "tool_call", name: "web_search", args: "podman keep-id" },
      { type: "tool_calls", count: 1 },
    ]);
  });

  // started/updated arrive before the payload is whole; reading them too would
  // double-count an agent message and truncate a command's output.
  it("reads only item.completed, never item.started or item.updated", () => {
    const item = { id: "item_1", type: "agent_message", text: "hi" };
    expect(
      parseCodexJsonLine(JSON.stringify({ type: "item.started", item })),
    ).toEqual([]);
    expect(
      parseCodexJsonLine(JSON.stringify({ type: "item.updated", item })),
    ).toEqual([]);
  });

  it("ignores items whose payload field is missing or the wrong type", () => {
    expect(parseCodexJsonLine(completed({ id: "x", type: "agent_message" }))).toEqual([]);
    expect(
      parseCodexJsonLine(completed({ id: "x", type: "agent_message", text: 42 })),
    ).toEqual([]);
    expect(parseCodexJsonLine(completed(null))).toEqual([]);
    expect(parseCodexJsonLine('{"type":"thread.started"}')).toEqual([]);
  });
});

describe("codex command line", () => {
  it("delivers the prompt on stdin with --json and the bypass flag", () => {
    const cmd = codex("gpt-5.6-sol").buildPrintCommand({
      prompt: "hello",
      dangerouslySkipPermissions: true,
    });
    expect(cmd.command).toBe(
      `${CODEX_AUTH_SEED} codex exec --json --dangerously-bypass-approvals-and-sandbox --model 'gpt-5.6-sol'`,
    );
    expect(cmd.stdin).toBe("hello");
    expect(cmd.command).not.toContain("hello");
  });

  // NO positional argument, on either form, and that is the difference between
  // the two subcommands rather than a style choice. `codex exec [PROMPT]`
  // documents `-` as "read stdin", but `codex exec resume [SESSION_ID]
  // [PROMPT]` binds the FIRST positional to the session id — so a `-` written
  // for the prompt is swallowed as a thread NAME. Omitted, both fall through
  // to the same documented stdin read (verified against 0.152.0).
  it("passes no positional, so resume cannot read the prompt as a session id", () => {
    for (const opts of [undefined, { continueSession: true }]) {
      const cmd = codex("m", opts).buildPrintCommand({ prompt: "p" }).command;
      expect(cmd.trimEnd().endsWith("--model 'm'")).toBe(true);
      expect(cmd).not.toMatch(/(^| )-( |$)/);
    }
  });

  it("continueSession becomes an exec-resume-last command; absent by default", () => {
    expect(
      codex("m", { continueSession: true }).buildPrintCommand({ prompt: "nudge" })
        .command,
    ).toContain("codex exec resume --last --json");
    expect(codex("m").buildPrintCommand({ prompt: "p" }).command).toContain(
      "codex exec --json",
    );
    expect(codex("m").buildPrintCommand({ prompt: "p" }).command).not.toContain(
      "resume",
    );
  });

  it("shell-escapes the model and omits the bypass flag when not requested", () => {
    const cmd = codex("a'b").buildPrintCommand({ prompt: "p" });
    expect(cmd.command).toContain("--model 'a'\\''b'");
    expect(cmd.command).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

});

// ---------------------------------------------------------------------------
// codex ChatGPT-subscription seeding (#73)
// ---------------------------------------------------------------------------
//
// Two halves, deliberately split. The argv half is this module's decision —
// that the guard runs ahead of every codex invocation and carries no secret —
// and is asserted on the string. The rest is what `sh` defines, so it is
// asserted by RUNNING the snippet against a real temp $HOME, in the spirit of
// the `*-git.test.ts` files: only-if-missing, the mode, the $CODEX_HOME
// override, and the refusal to fall through to codex when the write fails.

describe("codex auth seeding — argv", () => {
  it("runs the guard ahead of codex exec, on both the fresh and resume forms", () => {
    for (const opts of [undefined, { continueSession: true }]) {
      const cmd = codex("m", opts).buildPrintCommand({ prompt: "p" }).command;
      expect(cmd.startsWith(`${CODEX_AUTH_SEED} codex exec`)).toBe(true);
    }
  });

  // The credential is in the container's environment already, so the command
  // REFERENCES it. Interpolating the host-side value here would put a refresh
  // token in the `podman exec` argv, readable from any `ps` on the host — and
  // the provider is built with a model id and nothing else, which is what makes
  // that impossible rather than merely avoided.
  it("names the variable, and has no way to carry the value", () => {
    expect(CODEX_AUTH_SEED).toContain('"$CODEX_AUTH_JSON"');
    expect(codex.length).toBe(2);
  });
});

describe("codex auth seeding — what sh does with it", () => {
  const AUTH = '{"OPENAI_API_KEY":null,"tokens":{"refresh_token":"r"},"auth_mode":"chatgpt"}';
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "asb-codexauth-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  // `printf ran` stands in for `codex exec`: it is what the seed falls through
  // to, so its output is the evidence that the guard did not swallow the run.
  const runSeed = async (
    env: Record<string, string | undefined>,
  ): Promise<{ stdout: string; code: number; stderr: string }> => {
    try {
      const { stdout, stderr } = await execFileP(
        "sh",
        ["-c", `${CODEX_AUTH_SEED} printf ran`],
        { env: { PATH: process.env["PATH"] ?? "", HOME: home, ...env } as NodeJS.ProcessEnv },
      );
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
    }
  };

  it("writes the value to $HOME/.codex/auth.json, 0600, then runs codex", async () => {
    const r = await runSeed({ CODEX_AUTH_JSON: AUTH });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("ran");
    const authPath = join(home, ".codex", "auth.json");
    expect(await readFile(authPath, "utf8")).toBe(AUTH);
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, ".codex"))).mode & 0o777).toBe(0o700);
  });

  // The load-bearing one. codex refreshes tokens in place, and the sandbox
  // outlives the attempt that seeded it — a second attempt that re-seeded would
  // roll the credential back to a token the refresh may have rotated away.
  it("never overwrites a file already there, so an in-container refresh survives", async () => {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "auth.json"), "refreshed");
    const r = await runSeed({ CODEX_AUTH_JSON: AUTH });
    expect(r.code).toBe(0);
    expect(await readFile(join(home, ".codex", "auth.json"), "utf8")).toBe("refreshed");
  });

  it("is inert when the key is undeclared, and when it is declared empty", async () => {
    for (const env of [{}, { CODEX_AUTH_JSON: "" }]) {
      const r = await runSeed(env);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("ran");
      expect(existsSync(join(home, ".codex"))).toBe(false);
    }
  });

  // codex's own resolution order: a config that declares CODEX_HOME would
  // otherwise be handed a file in a directory the CLI never reads.
  it("follows $CODEX_HOME when one is set", async () => {
    const elsewhere = join(home, "state", "codex");
    const r = await runSeed({ CODEX_AUTH_JSON: AUTH, CODEX_HOME: elsewhere });
    expect(r.code).toBe(0);
    expect(await readFile(join(elsewhere, "auth.json"), "utf8")).toBe(AUTH);
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  // A write that failed must not fall through to `codex exec`: unauthenticated,
  // codex spends the idle budget on retries and reports a 401 as a `turn.failed`
  // — an answer-shaped account of a filesystem problem. Non-zero puts it on
  // invokeAgent's infra path with the real cause on stderr (#67).
  it("exits non-zero without running codex when the seed cannot be written", async () => {
    const blocked = join(home, "not-a-dir");
    await writeFile(blocked, "");
    const r = await runSeed({ CODEX_AUTH_JSON: AUTH, CODEX_HOME: blocked });
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain("ran");
    expect(r.stderr).toContain("CODEX_AUTH_JSON");
    // Never the credential itself: this text reaches an AgentError and a
    // NEEDS-HUMAN trace a human reads.
    expect(r.stderr).not.toContain("refresh_token");
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

  it("continueSession adds --continue before the stdin prompt; absent by default", () => {
    const cmd = claudeCode("m", { continueSession: true }).buildPrintCommand({
      prompt: "nudge",
      dangerouslySkipPermissions: true,
    });
    expect(cmd.command).toContain(" --continue -p -");
    expect(cmd.stdin).toBe("nudge");
    expect(claudeCode("m").buildPrintCommand({ prompt: "p" }).command).not.toContain(
      "--continue",
    );
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
      const run = await sandbox.run({ agent, prompt: "go", completionSignal: [] });

      expect(run.stdout).toContain("<promise>COMPLETE</promise>");
      expect(run.commits).toHaveLength(1);
      expect(typeof run.maxGapMs).toBe("number");
      expect(run.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
      await sandbox.syncBranchToCache();
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

  it("preserves a clean clone when the caller requests an evidence handoff", async () => {
    const branch = "sandbar/issue-98-reviewer-commit";
    await git(["branch", branch], dir);
    const sandbox = await createSandbox({
      env: {},
      branch,
      sandbox: makeLocalProvider(),
      layout: layoutFor(dir),
    });
    const path = sandbox.worktreePath;

    sandbox.preserveWorktree();
    const closed = await sandbox.close();

    expect(closed).toEqual({ preservedWorktreePath: path });
    expect(existsSync(path)).toBe(true);
    await rm(path, { recursive: true, force: true });
  });

  it("pins a stranded HEAD and restores the issue branch when reusing a clean clone", async () => {
    const branch = "sandbar/issue-98-stranded-head";
    await git(["branch", branch], dir);
    const sandbox = await createSandbox({
      env: {},
      branch,
      sandbox: makeLocalProvider(),
      layout: layoutFor(dir),
    });
    const path = sandbox.worktreePath;
    await git(["checkout", "--detach"], path);
    const stranded = (await git(["rev-parse", "HEAD"], path)).stdout.trim();

    const closed = await sandbox.close();

    expect(closed).toEqual({ preservedWorktreePath: path });
    await prepareWorktree({ branch, layout: layoutFor(dir), copyToWorktree: [] });
    expect((await git(["symbolic-ref", "HEAD"], path)).stdout.trim()).toBe(
      `refs/heads/${branch}`,
    );
    expect(
      (await git(["rev-parse", `refs/sandbar/stranded/${stranded}`], path)).stdout.trim(),
    ).toBe(stranded);
    await rm(path, { recursive: true, force: true });
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
        completionSignal: [],
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
        completionSignal: [],
      });
      expect(rescued.commits).toHaveLength(1);
      await sandbox.syncBranchToCache();
      const tip = await git(
        ["log", "-1", "--format=%H", "sandbar/issue-9-rescue"],
        dir,
      );
      expect(rescued.commits[0]!.sha).toBe(tip.stdout.trim());
    } finally {
      await sandbox.close();
    }
  });

  it("returns no speech when raw stdout has no parsed events", async () => {
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
      const run = await sandbox.run({ agent, prompt: "go", completionSignal: [] });
      expect(run.stdout).toBe("");
      expect(run.commits).toEqual([]);
    } finally {
      await sandbox.close();
    }
  });

  // #72 — a stream that is well-formed, exits 0, and carries no speech at all:
  // codex's shape for a turn that ended on tool calls. The transport is not an
  // answer, so a provider returns nothing rather than its own
  // JSONL — transport cannot stand in for the reviewer's verdict token.
  const toolCallOnly = JSON.stringify({
    type: "item.completed",
    item: { id: "item_1", type: "command_execution", command: "ls" },
  });

  it("returns nothing when a run's lines carried no speech (#72)", async () => {
    await git(["branch", "sandbar/issue-4-codex-quiet"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-4-codex-quiet",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      const agent: AgentProvider = {
        name: "codex",
        env: {},
        buildPrintCommand: () => ({
          command: `printf '%s\\n' ${JSON.stringify(toolCallOnly)}`,
          stdin: "",
        }),
        parseStreamLine: parseCodexJsonLine,
      };
      const run = await sandbox.run({ agent, prompt: "go", completionSignal: [] });
      expect(run.stdout).toBe("");
      expect(run.stdout).not.toContain("command_execution");
    } finally {
      await sandbox.close();
    }
  });

  // The guard, not the credential path: a dead key makes codex print
  // `turn.failed` and exit 1, which the non-zero branch above already catches.
  // This is the residual — an exit code is not a contract the CLI states — and
  // the two readings are not symmetrical. Read as an answer, a silent terminal
  // failure has no promise tag: a nudge, a spent attempt, ×8 ×3 issues, each
  // parked with empty transcripts. Read as infra it is a HARD-ERROR on a run
  // that said nothing anyway (#67's rule).
  it("rejects a run that reported a failed turn and said nothing (#72)", async () => {
    await git(["branch", "sandbar/issue-7-codex-fail"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-7-codex-fail",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      const failed = JSON.stringify({
        type: "turn.failed",
        error: { message: "401 Unauthorized" },
      });
      const agent: AgentProvider = {
        name: "codex",
        env: {},
        buildPrintCommand: () => ({
          command: `printf '%s\\n' ${JSON.stringify(failed)}`,
          stdin: "",
        }),
        parseStreamLine: parseCodexJsonLine,
      };
      const err = await sandbox
        .run({ agent, prompt: "go", completionSignal: [] })
        .then(() => null)
        .catch((e: unknown) => e);
      // AgentError, not SandbarError: inner-loop.ts lets a SandbarError out to
      // the top-level handler and converts everything else to HARD-ERROR.
      expect(err).toBeInstanceOf(AgentError);
      // The cause reaches the NEEDS-HUMAN trace, and the partial output stays
      // empty — which is what keeps the REVIEWER path unchanged: no verdict
      // token in "", so #41 classifies it harness-failed and the round is not
      // consumed.
      expect((err as Error).message).toContain("401 Unauthorized");
      expect(agentPartialOutput(err)).toBe("");
    } finally {
      await sandbox.close();
    }
  });

  // The path a dead key ACTUALLY takes, live: codex prints its retries, then
  // `turn.failed`, then exits 1, with a dozen timestamped
  // `ERROR codex_api::endpoint…` lines on stderr. Both halves are here, so the
  // assertion is about which one a human is handed — the give-up cause leads
  // the detail, and the tracing does not bury it.
  it("leads the non-zero-exit detail with the reported cause, not stderr (#72)", async () => {
    await git(["branch", "sandbar/issue-10-exit1"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-10-exit1",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      const failed = JSON.stringify({
        type: "turn.failed",
        error: { message: "unexpected status 401 Unauthorized" },
      });
      const agent: AgentProvider = {
        name: "codex",
        env: {},
        buildPrintCommand: () => ({
          command:
            `printf '%s\\n' ${JSON.stringify(failed)}; ` +
            `printf '%s\\n' 'ERROR codex_api::endpoint::responses_websocket: failed to connect' >&2; ` +
            `exit 1`,
          stdin: "",
        }),
        parseStreamLine: parseCodexJsonLine,
      };
      const err = await sandbox
        .run({ agent, prompt: "go", completionSignal: [] })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentError);
      const message = (err as Error).message;
      expect(message).toContain("exited with code 1");
      expect(message).toContain("unexpected status 401 Unauthorized");
      expect(message).not.toContain("responses_websocket");
    } finally {
      await sandbox.close();
    }
  });

  // A provider that reports nothing in-band is untouched by that ordering:
  // claudeCode never emits `failure`, so stderr still leads for it.
  it("still leads with stderr for a provider that reports no failure (#72)", async () => {
    await git(["branch", "sandbar/issue-11-stderr"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-11-stderr",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      const agent = scriptedAgent(`printf '%s\\n' 'boom on stderr' >&2; exit 1`);
      const err = await sandbox
        .run({ agent, prompt: "go", completionSignal: [] })
        .then(() => null)
        .catch((e: unknown) => e);
      expect((err as Error).message).toContain("boom on stderr");
    } finally {
      await sandbox.close();
    }
  });

  // The other side of that guard, and the reason the parser reads only
  // `turn.failed`: a codex run that reconnects and downgrades its transport and
  // then works is ORDINARY inside a container, and this is the stream it prints
  // while doing it. Rejecting here would escalate a websocket blip to
  // HARD-ERROR → NEEDS-HUMAN, where the pre-#72 behaviour was a cheap
  // same-session nudge. Exit 0, no speech, no rejection — "" and on with the
  // attempt.
  it("does not reject a run whose only errors were recoverable notices (#72)", async () => {
    await git(["branch", "sandbar/issue-9-reconnect"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-9-reconnect",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      const retry = JSON.stringify({
        type: "error",
        message: "Reconnecting... 2/5 (unexpected status 401)",
      });
      const downgrade = JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_0",
          type: "error",
          message: "Falling back from WebSockets to HTTPS transport.",
        },
      });
      const agent: AgentProvider = {
        name: "codex",
        env: {},
        buildPrintCommand: () => ({
          command: `printf '%s\\n%s\\n' ${JSON.stringify(retry)} ${JSON.stringify(downgrade)}`,
          stdin: "",
        }),
        parseStreamLine: parseCodexJsonLine,
      };
      const run = await sandbox.run({ agent, prompt: "go", completionSignal: [] });
      expect(run.stdout).toBe("");
    } finally {
      await sandbox.close();
    }
  });

  // Guarded on speech, not on the failure alone: an agent that said its piece
  // and then hit a failure on the way out keeps what it said. Same rule #41
  // already applies to a non-zero exit carrying partial output.
  it("keeps the agent's speech when a failure follows it (#72)", async () => {
    await git(["branch", "sandbar/issue-8-late-fail"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-8-late-fail",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      const spoke = JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "<verdict>APPROVED</verdict>" },
      });
      const failed = JSON.stringify({ type: "turn.failed", error: { message: "boom" } });
      const agent: AgentProvider = {
        name: "codex",
        env: {},
        buildPrintCommand: () => ({
          command: `printf '%s\\n%s\\n' ${JSON.stringify(spoke)} ${JSON.stringify(failed)}`,
          stdin: "",
        }),
        parseStreamLine: parseCodexJsonLine,
      };
      const run = await sandbox.run({ agent, prompt: "go", completionSignal: [] });
      expect(run.stdout).toBe("<verdict>APPROVED</verdict>");
      expect(run.stdout).not.toContain("boom");
    } finally {
      await sandbox.close();
    }
  });

  // The two settle paths used to disagree about the same run: the completion
  // grace timer returns parsed speech, while a clean exit used to return the
  // terminal result or raw stream. A provider with no terminal result
  // event — which codex is on every run — therefore got its parsed speech only
  // when the timer happened to fire.
  it("returns assembled text, not the raw stream, when there is no result event (#72)", async () => {
    await git(["branch", "sandbar/issue-6-no-result"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-6-no-result",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      const line = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "the agent spoke" }] },
      });
      const agent = scriptedAgent(`printf '%s\\n' ${JSON.stringify(line)}`);
      const run = await sandbox.run({ agent, prompt: "go", completionSignal: [] });
      expect(run.stdout).toBe("the agent spoke");
      expect(run.stdout).not.toContain("assistant");
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
      await sandbox.run({ agent, prompt: "go", completionSignal: [] });
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

  it("classifies an unset host git identity and still marks safe.directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "asb-no-identity-"));
    const isolatedGlobal = join(root, "empty.gitconfig");
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    const previousSystem = process.env.GIT_CONFIG_SYSTEM;
    await writeFile(isolatedGlobal, "");
    try {
      await git(["init", "-b", "main"], root);
      await writeFile(join(root, "README.md"), "seed\n");
      await git(["add", "."], root);
      await git(
        ["-c", "user.name=Fixture", "-c", "user.email=fixture@test.com", "commit", "-m", "seed"],
        root,
      );
      const branch = "sandbar/issue-83-no-identity";
      await git(["branch", branch], root);
      process.env.GIT_CONFIG_GLOBAL = isolatedGlobal;
      process.env.GIT_CONFIG_SYSTEM = "/dev/null";

      const sandbox = await createSandbox({
        env: {},
        branch,
        sandbox: makeLocalProvider(),
        layout: layoutFor(root),
      });
      try {
        await sandbox.run({
          agent: scriptedAgent(`printf '%s\\n' 'ok'`),
          prompt: "go",
          completionSignal: [],
        });
        const configEnv = {
          cwd: root,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: isolatedGlobal,
            GIT_CONFIG_SYSTEM: "/dev/null",
          },
        };
        const safe = await execFileP(
          "git",
          ["config", "--global", "--get-all", "safe.directory"],
          configEnv,
        );
        expect(safe.stdout).toContain(sandbox.worktreePath);
        await expect(
          execFileP("git", ["config", "--global", "user.name"], configEnv),
        ).rejects.toMatchObject({ code: 1 });
        await expect(
          execFileP("git", ["config", "--global", "user.email"], configEnv),
        ).rejects.toMatchObject({ code: 1 });
      } finally {
        await sandbox.close();
      }
    } finally {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      if (previousSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = previousSystem;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects via the completion-grace timer when the pipe is held open (F5)", async () => {
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
      const err = await sandbox.run({
        agent,
        prompt: "go",
        completionSignal: ["<promise>COMPLETE</promise>"],
        completionTimeoutSeconds: 0.2,
        idleTimeoutSeconds: 30,
      }).then(() => null, (e: unknown) => e);
      const elapsed = Date.now() - start;
      expect(err).toBeInstanceOf(AgentError);
      expect((err as Error).message).toContain("without exiting");
      expect(agentPartialOutput(err)).toContain("<promise>COMPLETE</promise>");
      expect(elapsed).toBeLessThan(5000);
    } finally {
      await sandbox.close();
    }
  }, 15_000);

  it("an empty completion-signal list never enters the grace phase (#83)", async () => {
    await git(["branch", "sandbar/issue-83-no-grace"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-83-no-grace",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      const agent = scriptedAgent(
        `printf '%s\\n' '${JSON.stringify({ type: "result", result: "<promise>COMPLETE</promise>" })}' && ` +
          `sleep 30`,
      );
      const err = await sandbox.run({
        agent,
        prompt: "go",
        completionSignal: [],
        completionTimeoutSeconds: 0.2,
        idleTimeoutSeconds: 0.6,
      }).then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(AgentIdleTimeoutError);
      expect((err as Error).message).toContain("idle");
      expect((err as Error).message).not.toContain("without exiting");
      expect(agentPartialOutput(err)).toContain("<promise>COMPLETE</promise>");
    } finally {
      await sandbox.close();
    }
  }, 15_000);

  it("rejects one run when its provider parser throws, preserving prior speech", async () => {
    await git(["branch", "sandbar/issue-83-parser"], dir);
    const provider = makeLocalProvider();
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-83-parser",
      sandbox: provider,
      layout: layoutFor(dir),
    });
    try {
      const agent: AgentProvider = {
        name: "claude-code",
        env: {},
        buildPrintCommand: () => ({
          command:
            `printf '%s\\n%s\\n' ` +
            `${JSON.stringify(JSON.stringify({ type: "speech" }))} ` +
            `${JSON.stringify(JSON.stringify({ type: "broken" }))}`,
          stdin: "",
        }),
        parseStreamLine: (line) => {
          const parsed = JSON.parse(line) as { type: string };
          if (parsed.type === "broken") throw new TypeError("invalid provider shape");
          return [{ type: "text", text: "partial agent speech" }];
        },
      };
      const err = await sandbox
        .run({ agent, prompt: "go", completionSignal: [] })
        .then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(AgentError);
      expect((err as Error).message).toContain(
        "claude-code stream parse failed on a JSON line: invalid provider shape",
      );
      expect(agentPartialOutput(err)).toBe("partial agent speech");
    } finally {
      await sandbox.close();
    }
  });

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
        })}' '${JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          modelUsage: { "claude-opus": { inputTokens: 12 } },
        })}' && sleep 30`,
      );
      const err = await sandbox
        .run({ agent, prompt: "go", completionSignal: [], idleTimeoutSeconds: 0.4 })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("idle");
      expect(agentPartialOutput(err)).toContain("partial review findings");
      expect(agentPartialUsage(err).usage).toEqual({
        inputTokens: 12,
        resolvedModel: "claude-opus",
      });

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
        .run({ agent, prompt: "go", completionSignal: [], idleTimeoutSeconds: 0.4 })
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

  it("replaces an unmarked leftover at the issue's managed path", async () => {
    const branch = "sandbar/issue-83-stale-sweep";
    const layout = layoutFor(dir);
    await git(["branch", branch], dir);
    await mkdir(layout.worktreesDir, { recursive: true });
    const target = worktreePathFor(layout.worktreesDir, branch);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "stale"), "garbage");
      const worktreePath = await prepareWorktree({
        branch,
        layout,
        copyToWorktree: [],
      });

      expect(worktreePath).toBe(worktreePathFor(layout.worktreesDir, branch));
      expect((await stat(worktreePath)).isDirectory()).toBe(true);
      expect(existsSync(join(worktreePath, "stale"))).toBe(false);
  });

  it("reuses a clean worktree when its local issue branch is absent from origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "asb-local-branch-"));
    const origin = join(root, "origin.git");
    const checkout = join(root, "checkout");
    try {
      await git(["init", "--bare", origin], root);
      await git(["clone", origin, checkout], root);
      await git(["config", "user.name", "Test Host"], checkout);
      await git(["config", "user.email", "host@test.com"], checkout);
      await writeFile(join(checkout, "README.md"), "seed\n");
      await git(["add", "."], checkout);
      await git(["commit", "-m", "seed"], checkout);
      await git(["push", "-u", "origin", "HEAD:main"], checkout);
      const branch = "sandbar/issue-83-local-only";
      await git(["branch", branch], checkout);

      const first = await prepareWorktree({
        branch,
        layout: layoutFor(checkout),
        copyToWorktree: [],
      });
      const reused = await prepareWorktree({
        branch,
        layout: layoutFor(checkout),
        copyToWorktree: [],
      });
      expect(reused).toBe(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks out the cache seed when origin still carries an older issue branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "asb-explicit-seed-"));
    const origin = join(root, "origin.git");
    const checkout = join(root, "checkout");
    try {
      await git(["init", "--bare", origin], root);
      await git(["clone", origin, checkout], root);
      await git(["config", "user.name", "Test Host"], checkout);
      await git(["config", "user.email", "host@test.com"], checkout);
      await writeFile(join(checkout, "content.txt"), "old\n");
      await git(["add", "."], checkout);
      await git(["commit", "-m", "old source"], checkout);
      await git(["push", "-u", "origin", "HEAD:main"], checkout);
      const branch = "sandbar/issue-83-explicit-seed";
      await git(["push", "origin", `HEAD:refs/heads/${branch}`], checkout);

      await writeFile(join(checkout, "content.txt"), "new seed\n");
      await git(["commit", "-am", "new source"], checkout);
      await git(["branch", branch], checkout);
      const seededTip = (await git(["rev-parse", branch], checkout)).stdout.trim();

      const worktreePath = await prepareWorktree({
        branch,
        layout: layoutFor(checkout),
        copyToWorktree: [],
      });

      expect((await git(["rev-parse", "HEAD"], worktreePath)).stdout.trim()).toBe(
        seededTip,
      );
      expect(await readFile(join(worktreePath, "content.txt"), "utf8")).toBe(
        "new seed\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces an unmarked clone left before its initial checkout completed", async () => {
    const branch = "sandbar/issue-83-incomplete-checkout";
    const layout = layoutFor(dir);
    await git(["branch", branch], dir);
    const clone = worktreePathFor(layout.worktreesDir, branch);
    await git(["clone", "--local", "--no-checkout", dir, clone], dir);
    expect((await stat(join(clone, ".git"))).isDirectory()).toBe(true);

    await prepareWorktree({ branch, layout, copyToWorktree: [] });

    expect((await git(["symbolic-ref", "HEAD"], clone)).stdout.trim()).toBe(
      `refs/heads/${branch}`,
    );
    expect(
      (await git(["config", "--get", "sandbar.issueBranch"], clone)).stdout.trim(),
    ).toBe(branch);
  });

  it("recovers reuse when the preserved clone lost its issue ref", async () => {
    const branch = "sandbar/issue-98-missing-private-ref";
    const layout = layoutFor(dir);
    await git(["branch", branch], dir);
    const clone = await prepareWorktree({ branch, layout, copyToWorktree: [] });
    const cacheTip = (await git(["rev-parse", branch], dir)).stdout.trim();
    await git(["checkout", "--detach"], clone);
    await git(["branch", "-D", branch], clone);

    await prepareWorktree({ branch, layout, copyToWorktree: [] });

    expect((await git(["symbolic-ref", "HEAD"], clone)).stdout.trim()).toBe(
      `refs/heads/${branch}`,
    );
    expect((await git(["rev-parse", branch], clone)).stdout.trim()).toBe(cacheTip);
  });

  it("sweeps an unmarked orphan outside the branch being prepared", async () => {
    const branch = "sandbar/issue-83-general-sweep";
    const layout = layoutFor(dir);
    await git(["branch", branch], dir);
    const orphan = join(layout.worktreesDir, "abandoned-clone");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "leftover"), "garbage");

    await prepareWorktree({ branch, layout, copyToWorktree: [] });

    expect(existsSync(orphan)).toBe(false);
  });

  it("sweeps a marked clone after its cache branch was removed", async () => {
    const branch = "sandbar/issue-83-marked-sweep";
    const layout = layoutFor(dir);
    await git(["branch", branch], dir);
    const orphan = join(layout.worktreesDir, "sandbar-issue-999-old-title");
    await git(["clone", "--local", "--no-checkout", dir, orphan], dir);
    await git(
      ["config", "sandbar.issueBranch", "sandbar/issue-999-old-title"],
      orphan,
    );

    await prepareWorktree({ branch, layout, copyToWorktree: [] });

    expect(existsSync(orphan)).toBe(false);
  });

  it("prunes a legacy cache worktree registration after removing its directory", async () => {
    const branch = "sandbar/issue-83-prune-migration";
    const legacyBranch = "sandbar/issue-999-legacy-worktree";
    const layout = layoutFor(dir);
    await git(["branch", branch], dir);
    await git(["branch", legacyBranch], dir);
    const legacyPath = worktreePathFor(layout.worktreesDir, legacyBranch);
    await git(["worktree", "add", legacyPath, legacyBranch], dir);

    await prepareWorktree({ branch, layout, copyToWorktree: [] });

    expect(existsSync(legacyPath)).toBe(false);
    expect((await git(["worktree", "list", "--porcelain"], dir)).stdout).not.toContain(
      legacyPath,
    );
    await expect(git(["branch", "-D", legacyBranch], dir)).resolves.toBeDefined();
  });

  it("refreshes prompt base refs when reusing an issue clone", async () => {
    const root = await mkdtemp(join(tmpdir(), "asb-refresh-reuse-"));
    const origin = join(root, "origin.git");
    const checkout = join(root, "checkout");
    try {
      await git(["init", "--bare", origin], root);
      await git(["clone", origin, checkout], root);
      await git(["config", "user.name", "Test Host"], checkout);
      await git(["config", "user.email", "host@test.com"], checkout);
      await writeFile(join(checkout, "content.txt"), "first\n");
      await git(["add", "."], checkout);
      await git(["commit", "-m", "first"], checkout);
      await git(["push", "-u", "origin", "HEAD:main"], checkout);
      const branch = "sandbar/issue-83-refresh-reuse";
      await git(["branch", branch], checkout);
      const layout = layoutFor(checkout);
      const clone = await prepareWorktree({ branch, layout, copyToWorktree: [] });
      const oldBase = (await git(["rev-parse", "origin/main"], clone)).stdout.trim();

      await writeFile(join(checkout, "content.txt"), "second\n");
      await git(["commit", "-am", "second"], checkout);
      await git(["push", "origin", "HEAD:main"], checkout);
      const newBase = (await git(["rev-parse", "origin/main"], checkout)).stdout.trim();
      expect(newBase).not.toBe(oldBase);

      await prepareWorktree({ branch, layout, copyToWorktree: [] });

      expect((await git(["rev-parse", "origin/main"], clone)).stdout.trim()).toBe(
        newBase,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects reuse when the cache's refreshed forge origin cannot be fetched", async () => {
    const root = await mkdtemp(join(tmpdir(), "asb-fetch-failure-"));
    const origin = join(root, "origin.git");
    const checkout = join(root, "checkout");
    try {
      await git(["init", "--bare", origin], root);
      await git(["clone", origin, checkout], root);
      await git(["config", "user.name", "Test Host"], checkout);
      await git(["config", "user.email", "host@test.com"], checkout);
      await writeFile(join(checkout, "README.md"), "seed\n");
      await git(["add", "."], checkout);
      await git(["commit", "-m", "seed"], checkout);
      await git(["push", "-u", "origin", "HEAD:main"], checkout);

      const branch = "sandbar/issue-83-fetch-failure";
      await git(["branch", branch], checkout);
      await git(["push", "origin", `${branch}:${branch}`], checkout);
      await prepareWorktree({
        branch,
        layout: layoutFor(checkout),
        copyToWorktree: [],
      });

      await git(["remote", "set-url", "origin", join(root, "missing.git")], checkout);
      await expect(
        prepareWorktree({
          branch,
          layout: layoutFor(checkout),
          copyToWorktree: [],
        }),
      ).rejects.toThrow("Could not fetch origin/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects reuse when the local issue branch diverged from origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "asb-diverged-branch-"));
    const origin = join(root, "origin.git");
    const checkout = join(root, "checkout");
    const other = join(root, "other");
    try {
      await git(["init", "--bare", origin], root);
      await git(["clone", origin, checkout], root);
      await git(["config", "user.name", "Test Host"], checkout);
      await git(["config", "user.email", "host@test.com"], checkout);
      await writeFile(join(checkout, "README.md"), "seed\n");
      await git(["add", "."], checkout);
      await git(["commit", "-m", "seed"], checkout);
      await git(["push", "-u", "origin", "HEAD:main"], checkout);

      const branch = "sandbar/issue-83-diverged";
      await git(["branch", branch], checkout);
      await git(["push", "origin", `${branch}:${branch}`], checkout);
      const worktreePath = await prepareWorktree({
        branch,
        layout: layoutFor(checkout),
        copyToWorktree: [],
      });
      await writeFile(join(worktreePath, "local.txt"), "local\n");
      await git(["add", "."], worktreePath);
      await git(["commit", "-m", "local"], worktreePath);

      await git(["clone", origin, other], root);
      await git(["config", "user.name", "Other Host"], other);
      await git(["config", "user.email", "other@test.com"], other);
      await git(["checkout", branch], other);
      await writeFile(join(other, "remote.txt"), "remote\n");
      await git(["add", "."], other);
      await git(["commit", "-m", "remote"], other);
      await git(["push", "origin", branch], other);

      await expect(
        prepareWorktree({
          branch,
          layout: layoutFor(checkout),
          copyToWorktree: [],
        }),
      ).rejects.toThrow("could not fast-forward to origin");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  // #44 D6. The sandbox stack's siblings attach to this container, so they
  // cannot exist earlier — and `onSandboxReady` is exactly where a consumer
  // runs the migration that wants the database. Ordered the other way, the one
  // hook that most wants the stack is the one hook that cannot see it.
  it("runs beforeSandboxReady after the container exists and before the sandbox-ready hooks", async () => {
    await git(["branch", "sandbar/issue-44-order"], dir);
    const orderLog = join(dir, "order-44.log");
    const provider = makeLocalProvider();
    // One shared file, because the two events happen on opposite sides of the
    // boundary: an in-process callback and a host hook shelling out. Comparing
    // them any other way would be comparing two clocks.
    const sandbox = await createSandbox({
      env: {},
      branch: "sandbar/issue-44-order",
      sandbox: provider,
      layout: layoutFor(dir),
      beforeSandboxReady: async (containerName) => {
        await appendFile(orderLog, `before:${containerName}\n`);
      },
      hooks: {
        host: {
          onSandboxReady: [{ command: `printf 'hook\\n' >> ${orderLog}` }],
        },
      },
    });
    try {
      // The name is the anchor the siblings would join, so it has to be the
      // real container's rather than a placeholder.
      expect((await readFile(orderLog, "utf8")).trim().split("\n")).toEqual([
        "before:fake-sandbox-container",
        "hook",
      ]);
    } finally {
      await sandbox.close();
    }
  });

  // The container is created by then and only this module has a handle to it,
  // so a throw that escaped without closing it would leak a container per
  // issue — and the outer catch below knows about the worktree, not the
  // container.
  it("tears the container down when beforeSandboxReady throws", async () => {
    await git(["branch", "sandbar/issue-44-teardown"], dir);
    const worktreePath = await prepareWorktree({
      branch: "sandbar/issue-44-teardown",
      layout: layoutFor(dir),
    });
    let closed = false;
    const provider: SandboxProvider = {
      tag: "bind-mount",
      name: "podman",
      env: {},
      sandboxHomedir: "/home/agent",
      create: async (opts: ProviderCreateOptions) => ({
        worktreePath: opts.worktreePath,
        containerName: "fake-sandbox-container",
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        close: async () => {
          closed = true;
        },
      }),
    };
    await expect(
      createSandbox({
        env: {},
        branch: "sandbar/issue-44-teardown",
        sandbox: provider,
        layout: layoutFor(dir),
        preparedWorktreePath: worktreePath,
        beforeSandboxReady: async () => {
          throw new Error("issue-lifecycle sibling would not start");
        },
      }),
    ).rejects.toThrow("issue-lifecycle sibling would not start");
    expect(closed).toBe(true);
    // Caller-owned, so it survives — the same rule the bringup case below pins.
    expect(existsSync(worktreePath)).toBe(true);
    await rm(worktreePath, { recursive: true, force: true });
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

    await rm(worktreePath, { recursive: true, force: true });
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
    await rm(worktreePath, { recursive: true, force: true });
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
describe("issue clone isolation (#98)", () => {
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

  it("does not mount a plain parent repository's git directory", async () => {
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
    expect(extra).toEqual([]);
  });

  it("does not mount the bare cache", async () => {
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
    expect(extra).toEqual([]);
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
    groups: [],
    devices: [],
    cpus: undefined,
  };

  it("runs the sandbox under --init, so pid 1 reaps what the agent orphans", () => {
    expect(sandboxRunArgs(base)).toContain("--init");
  });

  // #50. `sandboxImage` is the CONSUMER's image and is free to declare a
  // builtin `VOLUME`; podman's default would then provision an anonymous
  // volume per sandbox that nothing ever reads and that outlives the container
  // as one permanently consumed lock out of the host's 2048.
  it("provisions no anonymous volume for the image's VOLUME directives", () => {
    const args = sandboxRunArgs(base);
    expect(args).toContain("--image-volume=ignore");
    // An option of `run`, not an argument of `sleep` — everything after the
    // image name belongs to the entrypoint, where it would be a silent no-op
    // that `toContain` still accepts.
    expect(args.indexOf("--image-volume=ignore")).toBeLessThan(
      args.indexOf(base.imageName),
    );
  });

  it("keeps --init an option of run, not an argument of the entrypoint", () => {
    // `podman run ... --entrypoint sleep <image> infinity`: everything after the
    // image name belongs to `sleep`, so an --init appended there would be a
    // silent no-op that `toContain` alone would still accept.
    const args = sandboxRunArgs(base);
    expect(args.indexOf("--init")).toBeLessThan(args.indexOf(base.imageName));
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

  // #44: the sandbox anchors the sandbox stack's network namespace, and since
  // #43 that costs it no `-p` at all — every readiness probe runs inside its
  // own container, so the chain publishes exactly what the gate's pod does.
  // Asserted rather than assumed: a publish here would forward a host port into
  // the namespace the agent shares with its siblings, which is a hole in the
  // isolation the whole feature rests on.
  it("publishes nothing on the sandbox stack's behalf", () => {
    expect(sandboxRunArgs(base)).not.toContain("-p");
  });

  // The other half of the anchor's tax
  // (#44): podman refuses to remove a container others are attached to, so a
  // plain `rm -f` leaks the WHOLE chain on any path where a sibling outlived
  // its stack — a `stop` that threw, a SIGKILL between the two removals.
  it("removes the sandbox with its dependants, so an anchor is always removable", () => {
    expect(sandboxRemoveArgs("sandbar-w0011223-abc")).toEqual([
      "rm",
      "-f",
      "-v",
      "--depend",
      "sandbar-w0011223-abc",
    ]);
  });

  // #50. The flag that matters is on `run`, not here: with
  // `--image-volume=ignore` there is no anonymous volume left for this `-v` to
  // reap, and this argv only ever names a container this same process created,
  // so it can never meet a pre-upgrade one either. It is asserted so that a
  // later reader cannot take a missing `-v` at one removal and a present one at
  // another as a statement about either.
  it("carries -v, so no container removal is the odd one out", () => {
    expect(sandboxRemoveArgs("c")).toContain("-v");
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
      "--image-volume=ignore",
      "-w",
      SANDBOX_REPO_DIR,
      "--entrypoint",
      "sleep",
      base.imageName,
      "infinity",
    ]);
  });
});
