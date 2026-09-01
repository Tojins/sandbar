// In-house replacement for the @ai-hero/sandcastle subset sandbar consumes
// (drops the ~72 MB Effect runtime; authoritative behaviour notes live in
// docs/agent-sandbox/01-07). Reproduces ONLY sandbar's exercised path: a
// bind-mount podman provider, an explicit pre-existing branch,
// `maxIterations: 1`, no session capture. The public surface is the five
// symbols sandbar imports (`createSandbox`, `podman`, `claudeCode`, types
// `Sandbox`/`SandboxHooks`) — plus `codex` since #72, the second
// implementation of `AgentProvider`, which is the seam a role's CLI is chosen
// at. Everything downstream of that seam — the completion-signal watch, the
// idle timeout, commit collection, the bounded tail — consumes parsed events
// and git, never a CLI, so a provider is argv plus a line parser and nothing
// else. `agent-providers.ts` owns which NAME resolves to which of them. #73
// leans on exactly that: codex's ChatGPT-subscription credential is a FILE, and
// a provider that owns its argv can materialise one in-container from a
// `config.env` VALUE — so the seam absorbs a file-shaped credential without
// sandbar learning a path or mounting anything (`CODEX_AUTH_SEED`).
//
// A provider's parser answers in three registers and the difference between
// them is load-bearing: `text`/`result` is the agent's SPEECH and is the only
// thing a run returns, `failure` is the provider naming a TERMINAL fault of its
// own, and everything else — including a recoverable one it merely reports — is
// transport. The third register is the one that is easy to get wrong: a CLI
// that narrates its own retries (`codex exec` does, over the same wire shape it
// uses for the fatal case) will hand a naive parser a `failure` for a
// reconnect, and `invokeAgent` rejects on a failure, so a blip would arrive at
// a human as NEEDS-HUMAN. See `ParsedStreamEvent` and `parseCodexJsonLine`.
//
// Load-bearing behaviours that look optional but are NOT (a naive port
// re-introduces a crash/hang on sandbar's parallel `Promise.allSettled` path):
//   F1 — `exec` retains a bounded 64 KiB rolling TAIL (`BoundedTail`), never
//        an unbounded array (RangeError inside close() on long runs).
//   F2 — git-setup execs retry on exit 126/137 only; genuine failures fail fast.
//   F3 — ONE process-wide shutdown registration (an `onCleanup` entry, #35)
//        fans out to a Set of teardowns; not a listener per sandbox.
//   F4 — a failure after worktree create removes the worktree before rethrowing.
//   F5 — two-phase agent timeout: once the completion signal is seen, a grace
//        timer resolves the run SUCCESSFULLY with the collected commits
//        instead of an idle error that discards them.
//   F7 — every host git invocation runs under LC_ALL=C (locale-stable stderr).
//   F8 — the container runs with `--init`: the entrypoint is `sleep infinity`,
//        which reaps nothing (#42). See `sandboxRunArgs`.
//   F9 — a run that FAILS still carries out whatever the agent had emitted
//        (`agentPartialOutput`), and both timeout paths kill the exec they
//        stop waiting for (#41). See invokeAgent.
//
// safe.directory is set per-run() (not just at create time): the bind-mounted
// worktree is owned by a different UID, and sandbar's common case has no hooks.
//
// This container is also the ANCHOR of the sandbox stack's network namespace
// (#44): joiners attach with `--network container:<name>`, so its name is
// public (`containerName`) and its removal is `--depend`-aware. It publishes
// no host ports on their behalf (#43). An anchor chain, not a pod, because a
// pod cannot carry keep-id and the agent CLI refuses to run as root.

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
  | { type: "session_id"; sessionId: string }
  // The provider naming a TERMINAL fault of its own (#72) — its turn ended
  // without reaching an answer. Never folded into the run's output (it is not
  // the agent's speech, and #41 turns on that distinction) and never emitted
  // for a fault the provider is still recovering from: `invokeAgent` rejects on
  // one, which is the HARD-ERROR path, so a parser that spent it on a reconnect
  // notice would escalate a blip to a human.
  //
  // What it buys, for a provider that reports faults in-band: the CAUSE, in the
  // provider's own words, ahead of whatever its stderr happens to hold — and,
  // where a CLI's exit code does not answer the question, #67's rule that an
  // attempt which captured no answer is an infra failure rather than an answer.
  | { type: "failure"; message: string };

export type AgentProvider = {
  readonly name: string;
  readonly env: Record<string, string>;
  buildPrintCommand(o: {
    prompt?: string;
    dangerouslySkipPermissions?: boolean;
  }): { command: string; stdin?: string };
  parseStreamLine(line: string): ParsedStreamEvent[];
  // When true, `parseStreamLine` is the ONLY source of a run's output: a run
  // whose lines yielded no `text`/`result` event returns "" rather than the raw
  // stream (#72). Absent, the raw stream is the last-resort fallback, which is
  // what a provider that does not emit machine-readable lines at all needs.
  //
  // This is not a formatting preference, it is #41's evidence rule. "Completed
  // with output" is what `reviewer-run.ts` reads as a verdict, so the string a
  // run returns must be the agent's own SPEECH or nothing — and a provider's
  // transport is not speech. A codex turn that ends on tool calls alone, or on
  // reconnect notices it recovered from, is a well-formed JSONL stream under a
  // successful process containing not one word the model said; returned as
  // "output" it would be read as a review and default to CHANGES-REQUESTED, a
  // verdict about code no model ever looked at, charged to the issue's rounds.
  readonly parsedOutputOnly?: boolean;
};

// One implementation of the provider parser's three-register reduction.
// Both the live sandbox invocation and the merger's run-to-completion capture
// feed this accumulator, so speech, terminal failures and raw transport cannot
// drift into different meanings on the two agent paths (#74).
export type AgentSpeechAccumulator = {
  ingest(events: readonly ParsedStreamEvent[]): void;
  readonly accumulated: string;
  readonly spoken: string;
  readonly failure: string | undefined;
  output(rawFallback: string): string;
};

export function createAgentSpeechAccumulator(
  agent: AgentProvider,
): AgentSpeechAccumulator {
  let result = "";
  let accumulated = "";
  let failure: string | undefined;
  return {
    ingest(events) {
      for (const event of events) {
        if (event.type === "text") accumulated += event.text;
        else if (event.type === "result") {
          result = event.result;
          accumulated += event.result;
        } else if (event.type === "failure") failure = event.message;
      }
    },
    get accumulated() {
      return accumulated;
    },
    get spoken() {
      return result || accumulated;
    },
    get failure() {
      return failure;
    },
    output(rawFallback) {
      const spoken = result || accumulated;
      if (spoken) return spoken;
      return agent.parsedOutputOnly === true ? "" : rawFallback;
    },
  };
}

export type ClaudeCodeOptions = {
  effort?: "low" | "medium" | "high" | "max";
  env?: Record<string, string>;
  // `--continue`: resume the most recent conversation for the sandbox cwd
  // instead of starting a fresh one. Sound inside an agent sandbox precisely
  // because it is NOT sound in general: the container's $HOME persists for the
  // life of the issue and only sandbar's own runs write conversations there,
  // so "most recent" is exactly the run that just returned. The promise nudge
  // (inner-loop.ts) is the consumer.
  continueSession?: boolean;
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
  // Kills the exec CLIENT when aborted (#41). Be precise about what that
  // reaps: the host-side `podman exec` process, its pipes and the readline
  // interface reading them — nothing more. The process INSIDE the container is
  // podman's, and gate-stack.ts's `reapKilledStep` records the same finding
  // from the other side: killing the client reaps nothing in the container, and
  // the only total handle podman offers is the container itself. Here that
  // handle belongs to the issue, not to one agent run, so the in-container
  // process outlives an abort and dies with the sandbox at `close()`. What the
  // abort buys is that sandbar stops holding a process, three fds and a growing
  // output buffer for a run whose result it has already discarded.
  signal?: AbortSignal;
};

type ExecResult = { stdout: string; stderr: string; exitCode: number };

type SandboxHandle = {
  readonly worktreePath: string;
  // The podman container's name. Carried out of the provider since #44,
  // because the sandbox stack's siblings join THIS container's network
  // namespace (`--network container:<name>`) and there is no other way to
  // learn it — the name is a uuid the provider mints.
  readonly containerName: string;
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
  // The anchor the sandbox stack's siblings attach to (#44). See SandboxHandle.
  readonly containerName: string;
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
  // Run after the container exists and BEFORE the sandbox-ready hooks (#44).
  // The one caller starts the sandbox stack's siblings, which attach to this
  // container's network namespace and so cannot be created any earlier, and
  // which an `onSandboxReady` hook may well want to talk to.
  //
  // A callback rather than a return-then-continue split, because the container
  // has to be torn down if this throws and only this module knows how: the
  // caller has no handle yet. It is passed the container's name for the same
  // reason `containerName` is public at all.
  beforeSandboxReady?: (containerName: string) => Promise<void>;
  // Extra bind mounts, appended after the worktree and the git common dir
  // (#44). The one caller is the sandbox stack's log directory — a host
  // directory the followers write each sibling's `podman logs -f` into, mounted
  // read-only so the agent can read its neighbours' logs without being handed
  // anything that can write to them. Read-only is not incidental: the whole
  // isolation argument is that the agent cannot reach the stack its verdict is
  // formed in, and a writable log mount is a channel out of the sandbox into
  // the host's run-log tree.
  extraMounts?: readonly Mount[];
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

// What the agent had emitted when a run failed (#41).
//
// Every rejection out of `invokeAgent` discards the speech accumulator, so
// from a caller's side EVERY failure looks identical to a run that emitted nothing —
// which is exactly the distinction #41 needs to make: a reviewer that produced
// no bytes at all is a harness fault, while one that produced a review and then
// failed to exit cleanly has already said something about the code. Told apart
// only by the bytes, so the bytes have to survive the throw.
//
// A WeakMap rather than a field, because the generic `.catch` in invokeAgent
// forwards errors this module did not construct (a podman exec failure, an
// EPIPE on stdin) and those must carry the output too. Nothing is mutated and
// no property name can collide with one the thrown error already has.
const AGENT_PARTIAL_OUTPUT = new WeakMap<object, string>();

const withPartialOutput = (err: unknown, partial: string): unknown => {
  if (partial !== "" && typeof err === "object" && err !== null) {
    AGENT_PARTIAL_OUTPUT.set(err, partial);
  }
  return err;
};

// "" when the run emitted nothing, or when the error came from somewhere other
// than an agent run. Callers read it as evidence, so an absent record and an
// empty one mean the same thing on purpose.
export const agentPartialOutput = (err: unknown): string => {
  if (typeof err !== "object" || err === null) return "";
  return AGENT_PARTIAL_OUTPUT.get(err) ?? "";
};

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
    const continueFlag = options?.continueSession ? " --continue" : "";
    return {
      command: `claude --print --verbose${skipPerms} --output-format stream-json --model ${shellEscape(model)}${effortFlag}${continueFlag} -p -`,
      stdin: prompt,
    };
  },
  parseStreamLine(line) {
    return parseStreamJsonLine(line);
  },
});

// ---------------------------------------------------------------------------
// codex — the second provider (#72)
// ---------------------------------------------------------------------------
//
// `codex exec --json` streams one JSON object per line on STDOUT while the
// agent works; its tracing (`ERROR codex_api::…`) goes to stderr and never
// reaches this parser. Verified against codex-cli 0.152.0, whose event union is
// `@openai/codex-sdk`'s `ThreadEvent`.
//
// Only `agent_message` becomes `text`, and that is the load-bearing choice:
// Parsed accumulated speech is what the completion-signal watcher scans and
// what the `<promise>`/`<verdict>` parsers are handed, so it must hold the agent's
// SPEECH and nothing else. `reasoning` is therefore dropped outright — it is a
// summary of the model's own thinking, and folding it in would let a model that
// merely CONSIDERED emitting the completion tag end the run by talking about
// it.
//
// Errors arrive in THREE shapes and only ONE of them is terminal, which is the
// distinction the `failure` register lives or dies on — `invokeAgent` rejects
// on a failure, so anything spent on a recoverable notice escalates a blip to a
// human. Captured from a live 0.152.0 run with no credential:
//
//   {"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 …)"}
//   {"type":"item.completed","item":{"type":"error","message":
//     "Falling back from WebSockets to HTTPS transport. …"}}
//   {"type":"turn.failed","error":{"message":"unexpected status 401 …"}}
//
// The first two are the agent CARRYING ON: five reconnects, a transport
// downgrade, five more. The SDK says so of the second — `ErrorItem` is
// "a non-fatal error surfaced as an item" — and the first is emitted for both
// the retries and the give-up, identically shaped, so it cannot be read either.
// A websocket→HTTPS fallback is entirely ordinary inside a container.
//
// `turn.failed` is the terminal one, arrives once, and carries the give-up
// cause verbatim. It is the only `failure`, and the rest are transport: dropped
// rather than degraded to text, because the accumulator holds the agent's
// claim and a 401 read as a review defaults to CHANGES-REQUESTED (#41).
//
// That run exits 1, so a dead key lands on `invokeAgent`'s existing non-zero
// path and is loud already. What the register buys is the CAUSE on that path —
// it leads the detail, ahead of stderr's dozen `ERROR codex_api::…` retry lines
// — and, since no CLI documents its exit codes as a contract, the guard for a
// turn that fails under an exit-0 process: infra, not an answer.
//
// A SPENT SUBSCRIPTION arrives here too, and it is worth knowing which shape it
// takes (#73). When the plan's 5-hour or weekly cap is reached, `codex exec`
// ends the turn — a `turn.failed` like any other, so the cap's own words become
// the `AgentError` and the HARD-ERROR reason, verbatim, and reach a human on
// stdout as `<issue>: HARD-ERROR (…)` per retry. Nothing here classifies it:
// sandbar has no rate-limit vocabulary and inventing one would mean matching
// another vendor's prose. What the run does with it is #67's rule unchanged —
// two fresh sandboxes, then NEEDS-HUMAN — which for an exhausted pool is a
// whole cycle of bringups that could not have worked. Naming the shape is the
// pre-work for ever treating it differently; parking issues nothing is wrong
// with is the cost until then.
//
// The turn's give-up cause, never empty: the string becomes the whole of an
// `AgentError` message and so the NEEDS-HUMAN trace a person reads, and "the
// turn failed" with a blank cause at least says which half of the system to
// look at. `unknown` because it is another process's wire format (`ThreadError`
// promises a `message`, and nothing here takes that on trust).
const codexErrorMessage = (err: unknown): string => {
  if (err !== null && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return "no message";
};

export const parseCodexJsonLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    // As in parseStreamJsonLine: the wire format is another process's, so it is
    // read as `any` and every field is checked before it is believed.
    const obj = JSON.parse(line) as any;
    if (obj.type === "thread.started" && typeof obj.thread_id === "string") {
      // Claude-shaped, and knowingly approximate: a codex THREAD is the unit
      // `resume --last` reopens, which is what a session id is used for here.
      return [{ type: "session_id", sessionId: obj.thread_id }];
    }
    // The one terminal shape (see above). The top-level `error` event and the
    // `error` ITEM fall through to [] — they are what the CLI says while it is
    // still trying.
    if (obj.type === "turn.failed") {
      return [{ type: "failure", message: codexErrorMessage(obj.error) }];
    }
    // Items are reported started → updated → completed; only the completed form
    // is read, so a command's `aggregated_output` and an agent message's text
    // are whole rather than a prefix that arrives again later.
    if (obj.type === "item.completed" && obj.item !== null && typeof obj.item === "object") {
      const item = obj.item;
      if (item.type === "agent_message" && typeof item.text === "string") {
        return [{ type: "text", text: item.text }];
      }
      // tool_call is informational (ignored on sandbar's path). Named after the
      // codex item rather than mapped onto a Claude tool: the two vocabularies
      // are not the same and a false equivalence would only mislead a reader.
      if (item.type === "command_execution" && typeof item.command === "string") {
        return [{ type: "tool_call", name: "command_execution", args: item.command }];
      }
      if (item.type === "web_search" && typeof item.query === "string") {
        return [{ type: "tool_call", name: "web_search", args: item.query }];
      }
    }
  } catch {
    // Stream lines are routinely partial; swallow → [], never throw.
  }
  return [];
};

// The ChatGPT-subscription credential, materialised in-container (#73).
//
// codex has no env-var analogue of `CLAUDE_CODE_OAUTH_TOKEN`: `codex login`
// writes `$CODEX_HOME/auth.json` (default `$HOME/.codex/auth.json`) and THAT
// FILE is the whole credential — access token, refresh token,
// `auth_mode: "chatgpt"`. Seeding it into a container is OpenAI's own
// documented CI/CD route. Sandbar still names no file and mounts nothing: the
// content arrives as a `config.env` value (`CODEX_AUTH_JSON`), exactly like
// every other credential (#38), and this snippet is what turns that value back
// into the file codex reads.
//
// The value is referenced, never interpolated. The secret is already in the
// container's environment, so `$CODEX_AUTH_JSON` costs nothing; the host-side
// value spliced into this string would put a refresh token in the `podman exec`
// argv, where any process on the host can read it out of `ps`.
//
// ONLY IF MISSING, and that is the load-bearing half. codex refreshes tokens in
// place and writes them back to this file — so on a later attempt in the same
// sandbox (the container, and `$HOME` with it, lives for the whole issue) a
// re-seed would roll the credential back to a token the refresh may already
// have rotated away. Per-issue copies of one host file are sound for the same
// reason the other direction is not: a container lives hours and the refresh
// cycle is days, so the host's copy only has to be fresh when the series
// starts. (What it costs is stated where the operator can act on it — the
// `CODEX_AUTH_JSON` note in `agent-providers.ts` — since parallel sandboxes are
// concurrent holders of one credential, and an in-container refresh can leave
// the host's copy stale enough that a LATER series needs `codex login` again.)
//
// A seed that FAILS exits non-zero rather than falling through to `codex exec`.
// Unauthenticated, codex would spend the run's idle budget on retries and end
// in a `turn.failed` about a 401 — an answer-shaped report of a filesystem
// problem. Exiting here puts it on `invokeAgent`'s non-zero path with the
// mkdir/write error on stderr, which is where infra belongs (#67).
//
// `${CODEX_HOME:-$HOME/.codex}` because that is codex's own resolution order: a
// config that declares `CODEX_HOME` would otherwise be handed a seeded file in
// a directory the CLI never reads.
export const CODEX_AUTH_SEED = [
  'if [ -n "${CODEX_AUTH_JSON:-}" ]; then',
  'codex_home="${CODEX_HOME:-$HOME/.codex}";',
  '[ -f "$codex_home/auth.json" ] ||',
  "(umask 077 && mkdir -p \"$codex_home\" && printf '%s' \"$CODEX_AUTH_JSON\" > \"$codex_home/auth.json\") ||",
  '{ echo "sandbar: could not seed $codex_home/auth.json from CODEX_AUTH_JSON" >&2; exit 1; };',
  "fi;",
].join(" ");

export type CodexOptions = {
  env?: Record<string, string>;
  // `codex exec resume --last` — the `--continue` analogue, sound for exactly
  // the reason ClaudeCodeOptions.continueSession gives: the container's $HOME
  // (and so `$CODEX_HOME`) persists for the life of the issue and only
  // sandbar's own runs write threads there, so "last" is the run that just
  // returned. The promise nudge (inner-loop.ts) is the consumer.
  continueSession?: boolean;
};

export const codex = (model: string, options?: CodexOptions): AgentProvider => ({
  name: "codex",
  env: options?.env ?? {},
  parsedOutputOnly: true,
  buildPrintCommand({ prompt, dangerouslySkipPermissions }) {
    // Wanted on its own merits, not merely as the `--dangerously-skip-permissions`
    // analogue: codex's own sandbox is Landlock, which does not generally work
    // inside a container, and podman is already the isolation boundary here.
    const bypass = dangerouslySkipPermissions
      ? " --dangerously-bypass-approvals-and-sandbox"
      : "";
    const resume = options?.continueSession ? " resume --last" : "";
    // NO positional argument, and that is the difference between the two
    // subcommands rather than a style choice. `codex exec [PROMPT]` documents
    // `-` as "read stdin", but `codex exec resume [SESSION_ID] [PROMPT]` binds
    // the FIRST positional to the session id — so a `-` written for the prompt
    // is swallowed as a thread NAME, and only `--last` overriding it keeps the
    // nudge working by accident. Omitted, both forms fall through to the same
    // documented stdin read (verified against 0.152.0: both print "Reading
    // prompt from stdin…", and an empty stdin is REFUSED rather than sent as
    // an empty prompt).
    // The seed runs ahead of every invocation rather than at bringup, and it is
    // unconditional here rather than switched host-side: the condition is
    // "`CODEX_AUTH_JSON` is in this container's environment", which the shell
    // can ask directly and which no argument threaded down from the config
    // could answer more accurately. With the key undeclared the guard is one
    // `test` that falls through to the same `codex exec` as before.
    return {
      command: `${CODEX_AUTH_SEED} codex exec${resume} --json${bypass} --model ${shellEscape(model)}`,
      stdin: prompt,
    };
  },
  parseStreamLine(line) {
    return parseCodexJsonLine(line);
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
// This Set deliberately does NOT migrate to `cleanup.ts`'s `registerDisposable`
// (#55): it is drained from `process.on("exit")` too, where nothing can be
// awaited, which is why these teardowns are synchronous where a disposable's
// are async. The reason is recorded at `registerDisposable`'s own definition as
// well — along with the other thing this entry decides. Registered lazily, it
// lands INSIDE the cycle loop and after the gate stack's own registration, so a
// disposable registry that collapsed its members into one entry at the position
// of the first of them would drain this one first and remove the netns anchor
// out from under the sandbox stack's joiners.
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
    // No anonymous volume for the image's builtin `VOLUME` directives (#50).
    // The consumer's own `sandboxImage` is free to declare one, and podman's
    // default (`--image-volume=bind`) would provision a fresh volume per
    // sandbox that nothing ever reads and that outlives the container as one
    // consumed lock out of the host's 2048. See gate-stack.ts's header.
    "--image-volume=ignore",
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

// The sandbox container's removal argv (#44), pure and exported for the same
// reason `sandboxRunArgs` is: the provider needs a real podman and a real
// image, so the suite drives a fake one and anything left inline in it is
// asserted by nothing.
//
// `--depend` is the whole content. This container is the ANCHOR of the sandbox
// stack's netns chain, and podman REFUSES to remove a container other
// containers depend on — so with a sibling still alive a plain `rm -f` fails
// and leaks the chain rather than half of it. The ordinary path removes the
// siblings first (sandbox-stack.ts's `stop`, ordered ahead of `close()` by the
// inner loop and, on a signal, by the cleanup registry's LIFO order); this is
// what covers the paths that ordering cannot — a `stop` that threw, a SIGKILL
// between the two removals. A no-op with no dependants, which is every consumer
// that declares no `inSandbox` container.
//
// `-v` is consistency rather than a fix (#50). `sandboxRunArgs` passes
// `--image-volume=ignore`, so a container this code created carries no
// anonymous volume for `-v` to reap — and unlike the gate stack's pre-create
// removal, this argv only ever names a container from this same process, so it
// can never meet a pre-upgrade one. It is carried anyway because a `-v` present
// at some removals and absent at others reads as a decision. It cannot reach a
// named volume; sandbar declares none, and every mount here is a host bind
// mount.
export function sandboxRemoveArgs(containerName: string): string[] {
  return ["rm", "-f", "-v", "--depend", containerName];
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

      const removeArgs = sandboxRemoveArgs(containerName);
      const removeContainerSync = (): void => {
        try {
          execFileSync("podman", removeArgs, {
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
        containerName,
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
            killOnAbort(proc, opts?.signal);
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
            execFile("podman", removeArgs, (error) => {
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

// Wiring for ExecOptions.signal, extracted from the podman provider so it can
// be asserted at all: that provider needs a real podman and a real image, so
// anything left inline in it is covered by nothing — the same argument that put
// `sandboxRunArgs` out here (#42).
//
// SIGKILL, not SIGTERM: the client is a relay with nothing to flush, and the
// caller has already stopped reading it. The listener comes off on close, so an
// AbortSignal that outlives one exec — invokeAgent's per-run controller does
// not, but a future caller's might — cannot accumulate one listener per exec.
//
// Note the exec promise still RESOLVES afterwards, reporting `code ?? 0` for a
// signalled death. That is not a claim that the exec succeeded and nothing reads
// it as one: the only caller that aborts settles its own promise first, so the
// resolution is discarded by construction rather than by inspection.
export type KillableChild = {
  kill(signal: NodeJS.Signals): unknown;
  on(event: "close", listener: () => void): unknown;
};

export const killOnAbort = (
  child: KillableChild,
  signal: AbortSignal | undefined,
): void => {
  if (!signal) return;
  const onAbort = (): void => {
    child.kill("SIGKILL");
  };
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  child.on("close", () => signal.removeEventListener("abort", onAbort));
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
    const speech = createAgentSpeechAccumulator(agent);
    let completionDetected = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    // Both timers stop waiting for the exec; this is how they also stop it
    // (#41). One controller per agent run, so the listener it installs on the
    // exec cannot outlive the run that made it.
    const abort = new AbortController();

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
      // F9 — the collected output rides out with the failure. Without it a
      // caller cannot tell "the agent never produced a byte" from "the agent
      // produced a full review and then died", and #41 turns on that
      // distinction. Read back with `agentPartialOutput`.
      rejectRun(withPartialOutput(err, speech.spoken));
    };

    // Two-phase: pre-signal → idle kill timer; post-signal → completion-grace
    // timer that resolves SUCCESSFULLY with the collected output (the agent has
    // signalled but a child may be holding the stdout pipe open past EOF).
    const resetTimer = (): void => {
      // Nothing is waiting any more, so nothing should be armed: `onLine` still
      // fires after a settle (readline flushes its trailing partial line as the
      // killed exec's stdout closes), and re-arming there would leave one
      // `idleTimeoutMs` timer pending with no path left to clear it — up to ten
      // minutes of an event loop held open on the exit-0 path, which returns
      // rather than calling process.exit. The same "stop what you stopped
      // waiting for" thought as the abort below.
      if (settled) return;
      clearTimer();
      if (completionDetected) {
        timer = setTimeout(() => {
          // Settle FIRST, then abort: the abort makes the exec resolve, and
          // settling first is what makes that resolution a no-op instead of a
          // race with this one. The agent has already emitted its completion
          // signal and whatever is still holding the pipe open is producing
          // output nobody will read, so there is nothing here worth waiting on.
          settleResolve({ result: speech.spoken });
          abort.abort();
        }, completionTimeoutMs);
      } else {
        timer = setTimeout(() => {
          settleReject(
            new AgentIdleTimeoutError(
              `Agent idle for ${idleTimeoutMs / 1000} seconds — no output received.`,
              idleTimeoutMs,
            ),
          );
          // The "idle kill timer" (#41): it used to reject and nothing else,
          // leaving a `podman exec` client, its pipes and this closure's
          // growing output buffer alive for the rest of the ISSUE — the sandbox
          // is per-issue, so nothing else was going to collect them. See
          // ExecOptions.signal for what this does and does not reap.
          abort.abort();
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
        signal: abort.signal,
        onLine: (line) => {
          speech.ingest(agent.parseStreamLine(line));
          if (
            !completionDetected &&
            completionSignals.some((sig) => speech.accumulated.includes(sig))
          ) {
            completionDetected = true;
          }
          resetTimer();
        },
      })
      .then((execResult) => {
        if (execResult.exitCode !== 0) {
          // Four-tier detail: the reported failure → stderr → parsed speech →
          // last 20 stdout lines. The reported failure leads because it is the
          // provider naming its own give-up cause, and this is the path a codex
          // credential failure actually takes (it exits 1) — whose stderr is a
          // dozen timestamped `ERROR codex_api::…` retry lines that bury the
          // one sentence a human needs. A provider that reports nothing in-band
          // is unaffected: claudeCode never emits `failure`, so stderr still
          // leads for it, exactly as before #72.
          let detail = speech.failure ?? "";
          if (!detail.trim()) detail = execResult.stderr;
          if (!detail.trim()) detail = speech.spoken;
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
        // Parsed accumulated speech sits between the two for #72. The grace
        // path above already settles on the accumulator's speech, so
        // without it the two settle paths disagreed about the same run: a
        // provider that emits assistant text but no terminal `result` event
        // returned its PARSED speech when the completion timer fired and the
        // raw stream when the exec merely exited. Codex is that provider on
        // every run — it has no `result` event — and for it the raw stream is
        // not a degraded answer but a wrong one (see `parsedOutputOnly`).
        const spoken = speech.spoken;
        // A process that exited 0 having ANNOUNCED a terminal failure, and said
        // nothing else, did not answer — #67's rule for the resolve loop, held
        // here: an attempt that captured no answer is an infra failure, not an
        // answer, and must not launder itself into "the agent tried and failed"
        // and spend the budget doing it.
        //
        // This is a guard, not the codex credential path — that one exits 1 and
        // is caught above (verified: 0.152.0 with no key prints `turn.failed`
        // and exits 1). It is here because an exit code is not a contract the
        // CLI states, and the two ways of being wrong are not symmetrical. Read
        // as an answer, a silent terminal failure is an implementer attempt
        // with no promise tag: a nudge, a spent attempt, and eight more of them
        // across every issue in the plan, parking each with empty transcripts.
        // Read as infra it is a HARD-ERROR on a run that had nothing to say
        // anyway — two fresh sandboxes, then NEEDS-HUMAN quoting the cause.
        //
        // Guarded on `spoken`, so an agent that reviewed the code and then hit
        // a failure on the way out keeps its review. That is #41's own rule for
        // the non-zero-exit path (`agentPartialOutput`), and the reason it is
        // the same rule: what the agent said is evidence whatever happened to
        // the process afterwards.
        if (!spoken && speech.failure !== undefined) {
          settleReject(
            new AgentError(
              `${agent.name} reported a failed turn and produced no output:\n${speech.failure}`,
            ),
          );
          return;
        }
        settleResolve({
          result: speech.output(execResult.stdout),
        });
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
      ...(options.extraMounts ?? []),
    ];

    providerHandle = await options.sandbox.create({
      worktreePath,
      hostRepoPath: hostCwd,
      mounts,
      env,
    });
    sandboxRepoDir = providerHandle.worktreePath;

    // Everything between the container existing and the sandbox being handed
    // over. It shares ONE catch, whose whole job is to tear the container down
    // before rethrowing — the outer catch below removes the worktree but knows
    // nothing about the container, so anything that throws outside this block
    // and after `create` leaks it.
    const sandboxOnReady = options.hooks?.sandbox?.onSandboxReady;
    const hostOnReady = options.hooks?.host?.onSandboxReady;
    try {
      // BEFORE the hooks, deliberately (#44 D6). The sandbox stack's siblings
      // attach to this container, so they cannot exist earlier — and an
      // `onSandboxReady` hook is exactly the place a consumer runs migrations
      // or seeds fixtures, which is work that wants the database it is talking
      // to to be up. Ordered the other way, the one hook that most wants the
      // stack is the one hook that cannot see it.
      if (options.beforeSandboxReady) {
        await options.beforeSandboxReady(providerHandle.containerName);
      }
      // Only when hooks are present: `safe.directory` is set per-run anyway
      // (see runOneIteration), so this exec is not worth paying for on the
      // common path that declares none.
      if (sandboxOnReady?.length || hostOnReady?.length) {
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
      }
    } catch (e) {
      await providerHandle.close().catch(() => {});
      throw e;
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
    containerName: providerHandle.containerName,
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
