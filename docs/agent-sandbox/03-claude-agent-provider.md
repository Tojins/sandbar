# 03 — Claude agent provider & the run loop

Source (v0.7.0 tag): `src/AgentProvider.ts` (`claudeCode`,
`parseStreamJsonLine`), `src/Orchestrator.ts` (`invokeAgent`). This is the
fiddliest part to port — it tracks the `claude` CLI's `--output-format
stream-json` contract.

## `claudeCode(model, options?)` (`AgentProvider.ts`, `claudeCode`)

Returns an `AgentProvider`:

```ts
{
  name: "claude-code",
  env: options?.env ?? {},
  captureSessions: options?.captureSessions ?? true,  // irrelevant on sandbar's path
  buildPrintCommand({ prompt, dangerouslySkipPermissions, resumeSession }),
  buildInteractiveArgs({ prompt, dangerouslySkipPermissions }),  // unused
  parseStreamLine(line),
  parseSessionUsage(content),     // unused on sandbar's path (no capture)
}
```

`ClaudeCodeOptions`: `effort?: "low"|"medium"|"high"|"xhigh"|"max"`, `env?`,
`captureSessions?`, `sessionStorage?`. `AgentCommandOptions` also carries
`resumeSession?`/`forkSession?` (→ `--resume`/`--fork-session`). Sandbar passes
only `model` (`config.modelId`), so no effort flag, no resume/fork, default env,
default capture.

### `buildPrintCommand` — the command line

```ts
command: `claude --print --verbose${skipPerms} --output-format stream-json --model ${shellEscape(model)}${effortFlag}${resumeFlag}${forkFlag} -p -`
stdin: prompt
```

- `skipPerms` = ` --dangerously-skip-permissions` because the orchestrator always
  passes `dangerouslySkipPermissions: true`.
- `effortFlag` = ` --effort <e>` only if `options.effort` set (sandbar: absent).
- `resumeFlag` = ` --resume <id>` only if `resumeSession` set (sandbar: never).
- `forkFlag` = ` --fork-session` only when `resumeSession && forkSession` (sandbar:
  never) — meaningful only alongside `--resume`.
- `shellEscape(s)` = `'` + `s.replace(/'/g, "'\\''")` + `'` (POSIX single-quote
  escaping) — safe because `exec` runs it under `sh -c`.
- The **prompt is piped on stdin** (`-p -`), not passed as argv. This is
  deliberate: it avoids the Linux ~128 KB per-arg limit (`PrintCommand` doc in
  `AgentProvider.d.ts`).

So sandbar's effective command (model `claude-opus-4-8` for example) is:
```
claude --print --verbose --dangerously-skip-permissions \
  --output-format stream-json --model 'claude-opus-4-8' -p -
```
run via `podman exec -i -w /home/agent/workspace <container> sh -c '<command>'`
with the prompt on stdin.

### `parseStreamJsonLine(line)` → `ParsedStreamEvent[]` (`AgentProvider.ts`)

Called per stdout line. Returns `[]` for any line not starting with `{` or not
valid JSON (defensive `try/catch`). Recognised shapes:

- **`type: "assistant"`** with `message.content` array: walk content blocks.
  - `block.type === "text"` (string `text`) → accumulate into a `texts` buffer.
  - `block.type === "tool_use"` with string `name` and defined `input`:
    only if `name` is allowlisted in `TOOL_ARG_FIELDS`
    (`Bash→command`, `WebSearch→query`, `WebFetch→url`, `Agent→description`)
    and the arg field is a string. Flush any buffered text as a `text` event
    first, then emit `{ type:"tool_call", name, args }`. Non-allowlisted tools
    are skipped.
  - Trailing buffered text → a final `text` event.
- **`type: "result"`** with string `result` → `[{ type:"result", result }]`.
  This is the authoritative final assistant text.
- **`type: "system"`, `subtype: "init"`** with string `session_id` →
  `[{ type:"session_id", sessionId }]`.

The `ParsedStreamEvent` union gained a fifth variant in `0.6.x`,
`{ type:"usage", usage }`, but **Claude's `parseStreamJsonLine` never emits it**
(only the codex provider's `turn.completed` does). On sandbar's path it never
appears; the port can ignore the variant.

`text`/`tool_call` events drive the live display only; sandbar discards them.
The **`result` event is what becomes `run.stdout`** when present (see below).

### `parseSessionUsage(content)` (`AgentProvider.ts`)

Scans session JSONL bottom-up for the last `assistant` line with a complete
`message.usage` and returns `{ inputTokens, cacheCreationInputTokens,
cacheReadInputTokens, outputTokens }`. **Never invoked on sandbar's path** (no
session capture), so the port may omit it.

## `invokeAgent(...)` — running one agent pass (`Orchestrator.ts`, `invokeAgent`)

1. Build print command via `provider.buildPrintCommand`.
2. `sandbox.exec(printCmd.command, { onLine, cwd: sandboxRepoDir, stdin: printCmd.stdin })`.
3. **`onLine(line)`** (`Orchestrator.ts`, the `exec` `onLine` callback): for each
   `parsed of provider.parseStreamLine(line)`:
   - `text` → `onText(parsed.text)` (display buffer); also `accumulatedOutput += text`.
   - `result` → `resultText = parsed.result` (overwrites; last one wins); also
     `accumulatedOutput += result`.
   - `tool_call` → `onToolCall(name, args)` (display).
   - `session_id` → `sessionId = parsed.sessionId`.
   - (`usage` → `usage = parsed.usage`; never emitted by Claude.)

   Then, **after** parsing the line, scan `accumulatedOutput` for a completion
   signal (flipping to the grace phase on first match) and call `resetTimer()`.
   The reset is at the **end**, so every line — including ones that parse to `[]`
   — keeps the timer alive (see [06 trap #2](./06-test-derived-gotchas.md)).
4. **Two-phase timeout (idle, then completion-grace).** A single resettable timer
   fiber (`resetTimer`) runs in one of two modes, switched by a `completionDetected`
   flag:
   - **Pre-signal (idle) phase** — `Effect.sleep(idleTimeoutMs)` then
     `Deferred.fail(AgentIdleTimeoutError)`. Default `idleTimeoutMs = 600_000`
     (`DEFAULT_IDLE_TIMEOUT_SECONDS = 600`). Reset on every line. A `setInterval`-
     style warning fiber also fires every 60 s (`IDLE_WARNING_INTERVAL_MS`) →
     `onIdleWarning(minutes)`, active only in this phase.
   - **Phase switch.** After parsing each line, the accumulator
     (`accumulatedOutput`, fed by `text` + `result` events) is scanned for any
     `completionSignal`; the first match flips `completionDetected = true` and
     kills the warning fiber.
   - **Post-signal (completion-grace) phase** — `resetTimer` now arms
     `Effect.sleep(completionTimeoutMs)` then **`Deferred.succeed`** with
     `{ result: resultText || accumulatedOutput, sessionId, usage }`. Default
     `completionTimeoutMs = 60_000` (`DEFAULT_COMPLETION_TIMEOUT_SECONDS = 60`).
     Resolving (not failing) hands control back to the orchestrator with the
     buffered output — which still contains the signal — so the run **succeeds
     with commits intact**. The timer still resets on each further line, so
     trailing data (token-usage events, a terminal `result` event) is captured.
   - **Why this exists (the F5 fix, now baseline).** If the agent emits
     `<promise>COMPLETE</promise>` but a child it spawned (`gh`/`git`, an MCP
     server) holds the exec stdout pipe open, the parent never hits EOF. Without
     the grace phase the run would wait the **full 600 s** and fail with
     `AgentIdleTimeoutError`, **discarding the commits already made** — a finished
     attempt becomes NEEDS-HUMAN. This is iteration-count-independent, so
     `maxIterations: 1` does not dodge it. A clean process exit always wins the
     race against the grace timer, so healthy runs add **zero** latency. The port
     must keep both phases and the warning fiber, and clear them all on
     completion (`Effect.ensuring`). See [07 §F5](./07-upstream-fixes-since-0.5.12.md).
5. **Abort**: if a `signal` is provided, a `Deferred.die(signal.reason)` races
   the exec. Sandbar passes no signal.
6. On exec completion:
   - **Non-zero exit** → `AgentError` whose message is
     `"<provider> exited with code <N>:\n<detail>"` where `detail` =
     `stderr` || `resultText` || the last 20 non-empty stdout lines
     (`Orchestrator.ts`, the non-zero-exit branch). The race/timer cleanup runs via `ensuring`.
   - **Zero exit** → return `{ result: resultText || execResult.stdout, sessionId }`.
     I.e. if a `result` stream event was seen, that string is the output;
     otherwise the raw joined stdout.

The orchestrator then sets `lifecycleResult.result.stdout = result` and, after
the lifecycle returns, `allStdout += result.stdout`. So **`run().stdout` is the
`result` event text when present, else the raw stdout** — this is what sandbar
feeds to `promise-parser.ts` / `verdict-parser.ts`.

## Completion signal

`Orchestrator.ts`, `DEFAULT_COMPLETION_SIGNAL`. Default completion signal is the literal string
`"<promise>COMPLETE</promise>"`; the loop stops early if `agentOutput.includes`
it. Sandbar does **not** rely on this (it runs one iteration and parses the
`<promise>` token itself), but the default matches sandbar's promise-token
contract, so a faithful port should keep `"<promise>COMPLETE</promise>"` as the
default completion signal even though it's moot at `maxIterations: 1`.

## Reimplementation notes

- Port `parseStreamJsonLine` verbatim and **unit-test it as a pure function**
  (it already is one). Cover: assistant text blocks (single + multiple,
  buffering across a tool_use), allowlisted vs non-allowlisted tool_use, the
  `result` event, the `system/init` session_id event, partial/non-JSON lines
  (→ `[]`), and the empty-string line.
- The `result || stdout` fallback for `run.stdout` is load-bearing — sandbar's
  parsers assume the agent's final prose is in `stdout`.
- Keep the idle-timeout reset-on-line behaviour; a hung `claude` with no output
  must eventually error rather than block the cycle forever (sandbar's
  HARD-ERROR retry depends on the call returning/throwing).
- The non-zero-exit error detail order (`stderr` → `resultText` → tail of
  stdout) is what surfaces useful diagnostics into sandbar's failure traces;
  preserve it.
- `buildInteractiveArgs`, `parseSessionUsage`, `resumeSession`, `effort`, the
  abort signal, multi-iteration accumulation, and the display/stream-emitter
  callbacks can all be dropped for sandbar's path — but if you keep a thin
  `onLine`/`onText` hook, sandbar's run-log could optionally capture live output.
