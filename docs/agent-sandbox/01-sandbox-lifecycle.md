# 01 — Sandbox lifecycle (`createSandbox`, `run`, `close`)

Source (v0.7.0 tag): `src/createSandbox.ts`, `src/SandboxFactory.ts`,
`src/SandboxLifecycle.ts`, `src/Orchestrator.ts`, `src/startSandbox.ts`,
`src/shutdownRegistry.ts`.

This is the orchestration heart. It is described here **as sandbar exercises
it**: a bind-mount podman provider, an explicit pre-existing branch, and
`maxIterations: 1`. Branches in the upstream code that sandbar never reaches are
called out as out-of-scope rather than detailed.

## Public types (from `createSandbox.d.ts`)

```ts
interface CreateSandboxOptions {
  branch: string;                 // explicit, required
  baseBranch?: string;            // fork point if branch is new; default HEAD. sandbar: unset
  sandbox: SandboxProvider;       // sandbar: podman()
  cwd?: string;                   // host repo dir; default process.cwd()
  hooks?: SandboxHooks;
  copyToWorktree?: string[];      // host-relative paths copied into the worktree
  timeouts?: Timeouts;            // sandbar: unset (defaults apply)
}

interface SandboxRunOptions {
  agent: AgentProvider;           // sandbar: claudeCode(modelId)
  prompt?: string;                // sandbar: inline prompt
  maxIterations?: number;         // sandbar: 1
  name?: string;                  // sandbar: e.g. "implementer-<id>-attempt-N"
  completionSignal?: string | string[];  // sandbar: unset → default "<promise>COMPLETE</promise>"
  idleTimeoutSeconds?: number;    // sandbar: unset → default 600
  logging?: LoggingOption;        // sandbar: unset → defaults to a file under .sandbar/logs
  signal?: AbortSignal;           // sandbar: unset
}

interface SandboxRunResult {
  iterations: IterationResult[];
  completionSignal?: string;
  stdout: string;                 // ← sandbar reads this
  commits: { sha: string }[];     // ← sandbar reads this
  logFilePath?: string;
}

interface Sandbox {
  branch: string;
  worktreePath: string;           // ← sandbar reads this (host path to worktree)
  run(o: SandboxRunOptions): Promise<SandboxRunResult>;
  interactive(o): Promise<...>;   // sandbar: unused
  close(): Promise<{ preservedWorktreePath?: string }>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

## `createSandbox(options)` — setup sequence

`createSandbox.ts` (`createSandbox`, ~line 707). For sandbar's bind-mount path,
in order. The whole worktree-create-through-`onSandboxReady` block is wrapped in
`Effect.onError(() => WorktreeManager.remove(worktreePath))`, so **any failure
after step 3 removes the worktree before the error propagates** (no orphaned dir
on disk — see the note after step 11):

1. **Resolve cwd** → `hostRepoDir` (`resolveCwd`, defaults `process.cwd()`).
2. **Prune stale worktrees** — `WorktreeManager.pruneStale(hostRepoDir)`,
   best-effort (`catchAll`). Removes orphaned dirs under
   `.sandbar/worktrees/`. See [04](./04-worktree-and-mounts.md).
3. **Create the worktree** — `WorktreeManager.create(hostRepoDir, { branch, baseBranch })`
   → `{ path, branch }`. For an existing branch: `git worktree add <path> <branch>`.
   `path = <hostRepoDir>/.sandbar/worktrees/<branch with "/"→"-">`. 30 s timeout.
4. **Copy anchor files** — if `copyToWorktree` is non-empty and the provider is
   not isolated: `copyToWorktree(paths, hostRepoDir, worktreePath)`. Each path is
   `cp -R --reflink=auto <src> <dest>` (Linux), falling back to `cp -R`; missing
   sources are skipped. 60 s timeout.
5. **`host.onWorktreeReady` hooks** — run sequentially on the host, cwd =
   worktree (`runHostHooks`).
6. **Resolve env** — `resolveEnv(hostRepoDir)` parses `<hostRepoDir>/.sandbar/.env`
   (only declared keys; `process.env` fallback per key), then `mergeProviderEnv`
   layers the sandbox provider's env on top. See [04](./04-worktree-and-mounts.md).
7. **Resolve git mounts** — `resolveGitMounts(<hostRepoDir>/.git)`. Because the
   workspace is a worktree, `.git` is a *file* (`gitdir: <path>`); returns two
   mounts: the `.git` file itself and the parent `.git` directory
   (`SandboxFactory.ts`, `resolveGitMounts`). `patchGitMountsForWindows` is a
   no-op on Linux.
8. **Start the container** — `startSandbox` (bind-mount branch,
   `startSandbox.ts`): builds `rawMounts = [{ worktreeOrRepoPath →
   /home/agent/workspace }, ...gitMounts]`, applies `normalizeMounts` (no-op on
   Linux), and calls `provider.create({ worktreePath, hostRepoPath, mounts, env })`.
   120 s timeout. Returns `{ handle, sandboxLayer, worktreePath }`. See
   [02](./02-podman-provider.md).
9. **`onSandboxReady` hooks** — sandbox-side and host-side run in parallel
   (`concurrency: "unbounded"`). Before them, in the sandbox:
   `git config --global --add safe.directory <sandboxRepoDir>`. Sandbox hooks
   run via `sandbox.exec(cmd, { cwd, sudo })`; host hooks via `runHostHooks`.
   This hook step has its own nested `Effect.onError(() => providerHandle.close())`
   so a hook failure tears down the **container** first, then the outer handler
   removes the worktree — two-level cleanup.
10. **Register shutdown teardown** — `registerShutdown(forceCleanup)`
    (`shutdownRegistry.ts`), where `forceCleanup` prints the "Worktree preserved
    at <path>" guidance. This routes through **one** process-wide
    `SIGINT`/`SIGTERM`/`exit` listener set shared across all live sandboxes
    (rather than a fresh listener per `createSandbox`), so N parallel sandboxes do
    not trip Node's `MaxListenersExceededWarning`. `close()` calls the returned
    unregister. The podman provider registers its own container-removal teardown
    in the **same** shared registry (see [02 §registry](./02-podman-provider.md)).
11. **Return the handle** — `{ branch, worktreePath, run, interactive, close,
    [asyncDispose] }`.

> Out of scope: the `isolated` and `none` provider branches, the test-mode
> `_test.buildSandbox` path, and `createSandboxFromWorktree` (which closes the
> container only and leaves the worktree to its owner).

## `sandbox.run(options)` — the agent invocation

`createSandbox.ts` (the handle's `run`, ~line 226). Critically, this path **reuses**
the worktree + container created above — it does **not** create a new one. It
builds a `reuseFactoryLayer` whose `withSandbox` just runs the work against the
already-built `sandboxLayer`, then calls `orchestrate(...)`.

Two consequences for sandbar's path:

- **No `bindMountHandle`** is threaded through `reuseFactoryLayer`
  (`createSandbox.ts:299-314`). Everything in the orchestrator gated on
  `bindMountHandle` — session resume, session capture, token-usage parsing —
  is therefore skipped. (Upstream comment notwithstanding, `captureSessions`
  defaulting true on Claude has no effect here.)
- **Prompt is inline**, so `skipPromptExpansion` is true: the prompt passes
  through literally with no `!\`cmd\`` expansion and no `{{ARG}}` substitution.

### Orchestrator loop (`Orchestrator.ts`, `orchestrate`)

With `iterations = 1` the loop body runs once:

1. Resolve `completionSignals` — default `["<promise>COMPLETE</promise>"]` when
   `completionSignal` is unset.
2. `factory.withSandbox(...)` → for the reuse layer, just runs the work with the
   existing sandbox. Inside, wrap in `withSandboxLifecycle` (below).
3. The work:
   - `fullPrompt = prompt` (skipPromptExpansion true).
   - `invokeAgent(...)` runs the agent (see
     [03](./03-claude-agent-provider.md)) and returns `{ result, sessionId }`
     where `result = resultText || stdout`.
   - Completion check: `matchedSignal = completionSignals.find(s =>
     agentOutput.includes(s))`. Sandbar ignores this (parses stdout itself).
   - Returns `{ completionSignal, stdout: agentOutput, sessionId, ... }`.
4. After the iteration: `allCommits.push(...lifecycleResult.commits)`,
   `allStdout += result.stdout`. If a completion signal matched, return early;
   otherwise loop. With one iteration it returns
   `{ iterations, completionSignal, stdout: allStdout, commits: allCommits, ... }`.

### Lifecycle wrapper & commit capture (`SandboxLifecycle.ts`, `withSandboxLifecycle`)

`withSandboxLifecycle` is where commits are captured — the behaviour sandbar
depends on most. For an **explicit branch** (sandbar always), `branch` is
truthy ⇒ `hostCurrentBranch = null` ⇒ the temp-branch / merge-to-host path is
skipped entirely. Sequence:

1. Read host git identity: `git config user.name` / `user.email` in `hostRepoDir`
   (each defaulting to `""` on failure).
2. "Setting up sandbox" task:
   - `git config --global --add safe.directory <sandboxRepoDir>` (bind mount is
     owned by a different UID; avoids "dubious ownership").
   - Propagate identity into the sandbox: `git config --global user.name/email`
     when non-empty (quotes escaped).
   - `resolvedBranch = git rev-parse --abbrev-ref HEAD` (in the sandbox,
     `cwd = sandboxRepoDir`).
   - Run `onSandboxReady` hooks again (per-iteration; harmless at 1 iteration).
   - Each git setup command goes through `execOkWithGitTimeout`: a 10 s
     per-attempt timeout (`GIT_SETUP_TIMEOUT_MS`) **then** `Effect.retry` that
     re-runs **only** on a transient exec failure — `ExecError` with exit code
     `126` ("cannot exec") or `137` (SIGKILL), the symptoms of a momentary
     container-`exec` race under heavy parallel bring-up. `GIT_SETUP_MAX_RETRIES =
     2` retries, `GIT_SETUP_RETRY_DELAY_MS = 250` ms apart. A genuine git error
     (exit 1) or a hung exec still fails fast — and is **not** retried. This retry
     is scoped to the git-setup execs alone, never commit collection or the agent
     exec. (`SandboxLifecycle.ts:37-82`.)
3. `targetBranch = branch ?? resolvedBranch` (= the explicit branch).
4. **`baseHead`** = `git rev-parse HEAD` in `hostWorktreePath` (the host-side
   worktree). This is the baseline captured *before* the agent runs.
5. Run the caller's `work(ctx)` → the agent.
6. `applyToHost` — bind-mount: no-op (filesystem already shared).
7. **Collect commits** (explicit-branch branch, `SandboxLifecycle.ts:498-527`):
   ```
   git rev-list "<baseHead>..refs/heads/<targetBranch>" --reverse   (cwd: hostRepoDir)
   ```
   Split stdout on `\n` → `commits = [{ sha }, ...]` in chronological order.
   Empty / branch-missing → `[]`. 30 s timeout (`COMMIT_COLLECTION_TIMEOUT_MS`).
   Because the worktree is bind-mounted, commits the agent makes are immediately
   visible on the branch ref in the host repo.

Returns `{ result, branch: targetBranch, commits }`.

> Out of scope: the `hostCurrentBranch !== null` block
> (`SandboxLifecycle.ts:404-497`) — temp-branch detach, `git merge` to the host
> branch, `git branch -D`, then `git rev-list baseHead..HEAD`. Only reached when
> `createSandbox` is called without an explicit branch. Sandbar never does.

## `close()` — teardown (`createSandbox.ts`, `doClose` ~line 892)

1. Idempotent (`closed` guard).
2. `providerHandle.close()` → `podman rm -f <container>` (see
   [02](./02-podman-provider.md)).
3. Check dirty: `WorktreeManager.hasUncommittedChanges(worktreePath)`
   (`git status --porcelain`). If dirty → **preserve** the worktree and return
   `{ preservedWorktreePath: worktreePath }`.
4. If clean → `WorktreeManager.remove(worktreePath)`
   (`git worktree remove --force <path>`), return `{ preservedWorktreePath:
   undefined }`.
5. The handle's outer `close` first calls the `unregisterShutdown` returned by
   `registerShutdown` at step 10 — removing this sandbox's teardown from the
   shared registry (and, once the last sandbox unregisters, detaching the process
   listeners entirely).

Sandbar calls `close()` in a `finally` and ignores the result
(`inner-loop.ts` `runSandboxCycle` finally block), so the preserve-on-dirty
behaviour is invisible to it in practice — but a faithful port should keep it
(a dirty worktree left behind is then cleaned by sandbar's orphan sweeper / the
next `pruneStale`).

## Default timeouts (all overridable via `timeouts`, sandbar uses defaults)

| Step | Constant | Default |
| --- | --- | --- |
| Worktree create / prune | `WORKTREE_TIMEOUT_MS` | 30 s |
| Copy to worktree | `COPY_TO_WORKTREE_TIMEOUT_MS` | 60 s |
| Container start | `CONTAINER_START_TIMEOUT_MS` | 120 s |
| Git setup (per cmd) | `GIT_SETUP_TIMEOUT_MS` | 10 s |
| Commit collection | `COMMIT_COLLECTION_TIMEOUT_MS` | 30 s |
| Hook (per cmd) | `HOOK_TIMEOUT_MS` | 60 s |
| Agent idle | `idleTimeoutSeconds` | 600 s |
