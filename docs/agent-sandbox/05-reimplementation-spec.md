# 05 — Reimplementation spec: `src/agent-sandbox.ts`

The actionable target for [issue #6](https://github.com/Tojins/sandbar/issues/6).
This distils docs [01](./01-sandbox-lifecycle.md)–[04](./04-worktree-and-mounts.md)
into the minimal module that replaces `@ai-hero/sandcastle` on sandbar's path,
with no Effect runtime.

## Public surface (drop-in for the five symbols)

Match the signatures sandbar imports so call sites change only their import
path (`@ai-hero/sandcastle` → `./agent-sandbox.js`).

```ts
// types
export type SandboxHooks = {
  host?: {
    onWorktreeReady?: ReadonlyArray<{ command: string; timeoutMs?: number }>;
    onSandboxReady?: ReadonlyArray<{ command: string; timeoutMs?: number }>;
  };
  sandbox?: {
    onSandboxReady?: ReadonlyArray<{ command: string; sudo?: boolean; timeoutMs?: number }>;
  };
};

export interface Sandbox {
  readonly branch: string;
  readonly worktreePath: string;
  run(o: RunOptions): Promise<{ stdout: string; commits: { sha: string }[] }>;
  close(): Promise<{ preservedWorktreePath?: string }>;
}

// providers
export function podman(options?: PodmanOptions): SandboxProvider;
export function claudeCode(model: string, options?: ClaudeCodeOptions): AgentProvider;

// factory
export function createSandbox(options: {
  branch: string;
  baseBranch?: string;
  sandbox: SandboxProvider;
  cwd?: string;
  hooks?: SandboxHooks;
  copyToWorktree?: string[];
}): Promise<Sandbox>;
```

`RunOptions` needs only what sandbar passes: `{ agent, prompt, maxIterations?,
name? }`. `interactive()`, `[Symbol.asyncDispose]`, `promptFile`, `promptArgs`,
`completionSignal`, `idleTimeoutSeconds`, `logging`, `signal` can be omitted (or
kept as optional no-ops) — sandbar uses none of them. Keep the `SandboxRunResult`
return type wider only if you want to preserve the full shape; sandbar reads only
`stdout` and `commits`.

## Reduced control flow (sandbar's path only)

The general sandcastle code fans out across providers, branch strategies,
isolated/bind-mount, Windows, sessions, and iterations. Sandbar collapses all of
that. The in-house module only needs:

### `createSandbox`

```
hostRepoDir = resolve(cwd ?? process.cwd())
pruneStale(hostRepoDir)                         // best-effort
worktreePath = worktreeCreate(hostRepoDir, branch)   // git worktree add <path> <branch>
if copyToWorktree.length: copyToWorktree(...)        // cp -R --reflink=auto, skip missing
runHostHooks(hooks.host?.onWorktreeReady, cwd=worktreePath)
env = parseDotSandbarEnv(hostRepoDir)                // .sandbar/.env + process.env fallback
gitMounts = resolveGitMounts(hostRepoDir/.git)       // worktree → [.git file, parent .git dir]
handle = podmanProvider.create({                     // podman run -d ... sleep infinity
  worktreePath, mounts: [worktree→/home/agent/workspace, ...gitMounts], env })
// onSandboxReady:
sandboxExec(handle, `git config --global --add safe.directory /home/agent/workspace`)
runInParallel(hooks.sandbox?.onSandboxReady via handle.exec, hooks.host?.onSandboxReady via host)
unregister = registerShutdown(preserveMsg)           // SHARED registry (one listener set), not per-instance
return { branch, worktreePath, run, close }
// NB: wrap worktreeCreate…onSandboxReady so any failure runs `git worktree remove --force` (F4)
```

### `run`

```
// git identity propagation (once, before agent):
[name,email] = host `git config user.name|email` (default "")
sandboxExec(`git config --global --add safe.directory /home/agent/workspace`)
if name:  sandboxExec(`git config --global user.name  "..."`)
if email: sandboxExec(`git config --global user.email "..."`)
baseHead = host `git rev-parse HEAD` in worktreePath

// agent:
cmd = agent.buildPrintCommand({ prompt, dangerouslySkipPermissions: true })
exec = handle.exec(cmd.command, { cwd: "/home/agent/workspace", stdin: cmd.stdin, onLine })
  onLine(line): for parsed of agent.parseStreamLine(line):
                  if result → resultText = parsed.result; accumulated += result
                  if text   → accumulated += text
                  (tool_call/session_id → ignore, or feed run-log)
                if !completionDetected && accumulated.includes(signal):
                  completionDetected = true                 // flip to grace phase
                resetTimer()
  timer (two-phase):
    pre-signal  → after 600s: throw (agent idle)
    post-signal → after 60s:  RESOLVE successfully { stdout: resultText||accumulated, commits } (F5)
    resets on every line in both phases; a clean process exit wins the race
if exec.exitCode != 0: throw AgentError(stderr || resultText || tail(stdout,20))
stdout = resultText || exec.stdout    // exec.stdout is the bounded 64 KiB tail (F1)

// commit capture:
out = host `git rev-list "<baseHead>..refs/heads/<branch>" --reverse` in hostRepoDir
commits = out.trim() ? out.split("\n").map(sha => ({sha})) : []
return { stdout, commits }
```

### `close`

```
unregister()                                     // drop this sandbox from the shared shutdown registry
handle.close()                                   // podman rm -f <name>
if host `git status --porcelain` in worktreePath is non-empty:
  return { preservedWorktreePath: worktreePath } // leave it for review/sweeper
git worktree remove --force <worktreePath>
return { preservedWorktreePath: undefined }
```

## Load-bearing constants (copy exactly)

| Constant | Value |
| --- | --- |
| Sandbox mount point | `/home/agent/workspace` |
| Sandbox home | `/home/agent` |
| Container name | `sandbar-<randomUUID>` |
| Worktree root | `<repoDir>/.sandbar/worktrees/` |
| Worktree dir name | `branch.replace(/\//g, "-")` |
| Worktree-add flags | `-c branch.autoSetupMerge=false -c push.autoSetupRemote=false` |
| Default image | `sandbar:<sanitised repo dir name>` |
| podman run flags | `--user 1000:1000 --userns=keep-id:uid=1000,gid=1000 -w <wt> -e... -v host:sandbox:z --entrypoint sleep <img> infinity` |
| Default completion signal | `<promise>COMPLETE</promise>` |
| Default idle timeout | 600 s (`DEFAULT_IDLE_TIMEOUT_SECONDS`) |
| Default completion-grace timeout | 60 s (`DEFAULT_COMPLETION_TIMEOUT_SECONDS`) |
| Output tail bound | 64 KiB (`MAX_TAIL_CHARS`), keep the **end** |
| Git-setup retry | 2 retries, 250 ms apart, on exit 126/137 only |
| Claude command | `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model '<m>' -p -` (prompt on stdin) |

## What to drop vs. keep

**Drop:** Effect & all `@effect/*`; the docker/vercel/daytona/no-sandbox/isolated
providers; `createWorktree`, `interactive`, CLI; sessions (store/transfer/usage);
structured output; clack Display / stream emitter / TextDeltaBuffer; prompt
arg-substitution & preprocessing; codex/opencode/pi; Windows git-mount patching;
the temp-branch merge-to-host path; the `-b` worktree fork fallback;
`resumeSession`/`effort`/abort-signal plumbing.

**Keep:** podman provider (create/exec/cp/close + shared shutdown registry);
worktree create/remove/prune/dirty-check; copyToWorktree (Linux COW); the
two-mount git resolution for worktrees; `.sandbar/.env` resolution; git
identity propagation; `baseHead..refs/heads/<branch>` commit capture; the claude
stream-json command + `parseStreamJsonLine`; the two-phase idle/completion
timeout; the `result || stdout` fallback; the non-zero-exit error-detail
ordering.

## Load-bearing 0.7.0 behaviours (the bug-fixed baseline — don't regress them)

The pseudocode above already reflects `0.7.0`. These are the behaviours that look
optional but are **not** — they were the bugs the `0.5.12`→`0.7.0` re-baseline
fixed, on sandbar's exact path (parallel podman + `Promise.allSettled`). A naïve
port that simplifies them re-introduces a crash/hang. Commit refs + the full
history in [07](./07-upstream-fixes-since-0.5.12.md):

- 🔴 **F1 — bounded output tail in `exec`.** The retained stdout/stderr must be a
  64 KiB rolling **tail** (`BoundedTail`, keep the *end*), not an unbounded array.
  An unbounded `join` throws `RangeError` inside the `close` handler on long runs
  and **takes down the whole `Promise.allSettled` cycle**.
- 🔴 **F5 — two-phase timeout in `run`.** Beyond the 600 s idle timer, watch the
  stream for the completion signal; once seen, switch to a ~60 s completion-grace
  timer that **resolves the run successfully with the collected commits** on
  expiry (instead of a 10-minute `AgentIdleTimeoutError` that discards commits
  when a `gh`/`git` child holds the pipe open).
- 🟡 **F2 — retry git-setup on exit 126/137.** Carry `exitCode` on the exec
  error; retry only the `run`-phase git-setup commands (2×, 250 ms apart) on
  126/137 (transient container-exec races under parallelism). Not commit
  collection, not the agent exec.
- 🟡 **F3 — one shared signal handler.** Register `exit`/`SIGINT`/`SIGTERM` once
  at module scope with a `Set` of teardown callbacks (`registerShutdown`); do not
  add a listener set per `createSandbox`/`podman()` (trips
  `MaxListenersExceededWarning` past ~5 parallel sandboxes). Keep the synchronous
  `execFileSync` teardown on `exit`.
- 🟡 **F4 — remove the worktree if sandbox start fails.** Wrap `createSandbox` so
  a failure after `worktreeCreate` runs `git worktree remove --force` before
  rethrowing (common trigger: missing gate image).
- ⚪ **F6 / F7.** F6 (ff-only refresh of a reused clean worktree) is **optional** —
  sandbar dodges it; if added, gate it exactly (clean, on-branch, strictly-behind;
  never `reset --hard`). F7 (`LC_ALL=C` on git wrappers) is **already baseline**
  in `execGit` and cheap to keep even though the spec drops the `-b` fallback.

## Test obligations (per issue #6)

1. **`parseStreamJsonLine` (pure)** — table: assistant text (single/multi block,
   buffering across a tool_use), allowlisted vs non-allowlisted tool_use, the
   `result` event, `system/init` session_id, non-JSON / non-`{` / empty lines
   (→ `[]`).
2. **Commit capture** — in a temp git repo with a worktree on a branch: make N
   commits, assert `git rev-list baseHead..refs/heads/<branch> --reverse` yields
   exactly those SHAs in order and excludes the base; zero-commit → `[]`.
3. **Worktree path** — assert `branch.replace(/\//g,"-")` under
   `.sandbar/worktrees/` matches `finalize.ts:worktreePathFor` for a sample
   branch (guards the byte-for-byte compatibility AC).
4. **Existing inner-loop suite** — unchanged, using a fake `Sandbox`. The
   `Sandbox` contract (`run` → `{ stdout, commits }`, `worktreePath`, `close`)
   is preserved, so these must stay green with no edits beyond the import path.

Additional cases the upstream tests prove are necessary (see
[06](./06-test-derived-gotchas.md) for the asserting test names):

5. **`safe.directory` per-run** — assert it is configured before the first git
   command in `run()`, *independent of whether hooks are present* (top-trap #1).
6. **Idle timer resets on unparsed lines** — a stream of non-JSON noise within
   the window must NOT trip the idle timeout (top-trap #2).
7. **`result || stdout` fallback** — a run with no `result` event still returns
   the raw stdout (so the promise token is found there); a `result` event
   overrides it (top-trap #3).
8. **Non-zero-exit error tiering** — stderr → resultText → stdout-tail, with the
   provider name and exit code in the message (gotcha B).
9. **Worktree reuse** — a second `createSandbox` on the same branch reuses the
   worktree even when dirty / carrying unpushed commits, and unpushed commits do
   NOT count as dirty (gotcha D); detached-HEAD collision matches by path.
10. **`pruneStale` symlink safety** — with `.sandbar` symlinked, an active
    worktree is not swept (top-trap #6).
11. **env isolation** — only keys declared in `.sandbar/.env` are pulled from
    `process.env`; the host environment does not leak (gotcha G).
12. **Test harness** — add per-worker `GIT_CONFIG_GLOBAL` isolation (doc 06,
    "shipped test helpers") so parallel vitest workers don't race on
    `.gitconfig.lock` when the code under test runs `git config --global`.

Tests for the load-bearing `0.7.0` baseline behaviours (history in doc
[07](./07-upstream-fixes-since-0.5.12.md)):

13. **F1 bounded tail** — an `onLine` stream far larger than the tail bound
    returns without throwing, and a `<promise>COMPLETE</promise>` in the final
    lines is still present in the returned `stdout` (tail keeps the end).
14. **F5 completion timer** — a stream that emits the completion signal and then
    goes silent with no EOF resolves with the collected commits and does **not**
    throw `AgentIdleTimeoutError`; a stream that never emits the signal and goes
    silent still throws after the idle window.
15. **F2 git-setup retry** — a git-setup exec that fails 126/137 then succeeds is
    retried and the run proceeds; a non-transient nonzero exit (e.g. 1) still
    fails fast without retry, and commit collection is **not** retried.
16. **F3 shared signal handler** — creating N sandboxes registers a bounded,
    constant number of process listeners (not O(N)); `close()` deregisters its
    entry from the shared registry.
17. **F4 worktree cleanup on failed start** — a `createSandbox` whose container
    start throws (e.g. image-not-found) leaves no worktree dir behind.

## Compatibility decision (resolved: renamed in lockstep)

The acceptance criteria allowed either:

- **(A) byte-compatible** — keep the upstream library's legacy `sandcastle/`
  branch prefix, `sandcastle-` container prefix, and `.sandcastle/worktrees/`
  layout, so `preflight.ts`, `containers.ts`, `finalize.ts`, `merger.ts` need no
  changes.
- **(B) rename in lockstep** — drop the `sandcastle` name and rename to
  `sandbar` (`sandbar/` branch prefix, `sandbar-` container prefix,
  `.sandbar/worktrees/` layout).

**(B) was taken.** The prefixes are now centralized in `src/naming.ts`
(`BRANCH_PREFIX`, `RESOURCE_PREFIX`), and `containers.ts`, `merger.ts:435`,
`plan-resolver.ts:74`, `preflight.ts` globs, and `finalize.ts:worktreePathFor`
were updated together. During the transition window the cleanup paths still
recognize the legacy `sandcastle-*` / `sandcastle/*` prefixes so artifacts left
on existing repos get swept rather than orphaned.
