# 06 — Test-derived gotchas

Reverse-engineered from sandcastle's own vitest suite at tag `v0.7.0` (the tests
are **not** shipped in the npm package — `files: ["dist"]` — they live co-located
with the source at `github.com/mattpocock/sandcastle/tree/v0.7.0/src/*.test.ts`).
These are the edge cases the tests lock in that are *not* obvious from reading the
implementation, plus the shipped test helpers (`testSandbox.ts`, `testSetup.ts`)
which reveal the intended test contract.

Each item cites the asserting test so it can be re-verified. Ordered by how
likely a reimplementation is to get it wrong. **🔴 = correctness-critical for
sandbar's path; 🟡 = important; ⚪ = good to know.** Test names are stable across
the `0.5.12`→`0.7.0` re-baseline; line numbers are approximate against the
`v0.7.0` source.

---

## Top traps (read these first)

1. 🔴 **`safe.directory` is set on every `run()`, not (reliably) at create time.**
   There are *two* call sites, and they disagree:
   - `createSandbox` only runs `git config --global --add safe.directory` **when
     at least one `onSandboxReady` hook is present** — it's inside the
     `if (sandboxOnReady?.length || hostOnReady?.length)` guard
     (`createSandbox.ts:830-834`). Still true in `0.7.0`.
   - `withSandboxLifecycle` runs it **unconditionally, first thing**, on every
     `run()` (`SandboxLifecycle.ts:231`).

   Because sandbar's `run()` always goes through the lifecycle, the bind-mounted
   worktree (owned by a different UID) is reliably marked safe before any git
   command. **The load-bearing call is the per-`run()` one.** A reimplementation
   that only sets `safe.directory` at container-create time will hit git
   "dubious ownership" failures whenever there are no `onSandboxReady` hooks
   (sandbar's common case). Set it before the first git command in `run()`;
   use `--add` (append, idempotent) with the **container-side** path
   (`/home/agent/workspace`).

2. 🔴 **The idle timer resets on every stdout line — including unparsable ones —
   not on parsed events.** In `0.7.0` the timer is reset at the **end** of `onLine`
   (`resetTimer()` after parsing + the completion-signal scan, `Orchestrator.ts:174`),
   so every stdout line — including ones that parse to `[]` — still resets it. A
   chatty-but-structurally-silent agent (raw TUI noise that parses to `[]`) stays
   alive.
   Tests: *"resets the idle timer on unparsed stdout lines (no structured
   events)"*, *"resets the idle timer on each text/tool_call output"*
   (Orchestrator.test.ts:2518, 2445). If you only reset on parsed events, you'll
   kill healthy agents. Default timeout 600 s; `AgentIdleTimeoutError` carries
   `.timeoutMs`.

3. 🔴 **`run.stdout` = `resultText || rawStdout`, and the fallback is reached
   often.** `resultText` is set only by `result`-type stream events; until then
   it's `""` (falsy) and the raw concatenated stdout is returned. Test: *"falls
   back to stdout when stream has no result line"* — the `<promise>COMPLETE</
   promise>` token is detected from raw stdout when no `result` line fired
   (Orchestrator.test.ts:1377). Sandbar's `promise-parser`/`verdict-parser`
   depend on this: **scan the whole `result||stdout` string for the token**, and
   note the parser passes the token through untouched (it never strips it).

4. 🔴 **The git-worktree case needs TWO mounts, both with `sandboxPath ===
   hostPath`.** Since the workspace is a worktree, `.git` is a *file*
   (`gitdir: …`). `resolveGitMounts` returns `[{.git file}, {parent .git dir}]`
   (`resolve(gitdir, "..", "..")`), each mounted at its identical host path.
   Test: resolveGitVolumeMounts.test.ts:28-66. Mount only the worktree dir and
   the `gitdir:` pointer dangles → every in-container git command fails. The
   identity mapping is *why* it works (the absolute `gitdir:` path resolves the
   same inside the container) — don't remap it.

5. 🔴 **`NO_CONFIG_LOCK_FLAGS` on every `git worktree add`.** Prepend
   `-c branch.autoSetupMerge=false -c push.autoSetupRemote=false`
   (`WorktreeManager.ts`, `NO_CONFIG_LOCK_FLAGS`). Tests: *"does not write upstream tracking config
   even when autoSetupMerge is enabled"*. Sandbar creates per-issue worktrees in
   **parallel** (`Promise.allSettled`); without these, a user's global
   `autoSetupMerge`/`autoSetupRemote` triggers a `.git/config` write during
   `worktree add` that races other parallel adds on `.git/config.lock` →
   intermittent failures. This is the one temp-branch-path lesson that bites our
   explicit-branch path too.

6. 🔴 **`pruneStale` must `realPath` the worktrees dir before the active-set
   check.** `git worktree list --porcelain` canonicalizes paths. If `.sandcastle`
   is a symlink and you compare un-canonicalized joined paths, *every* active
   worktree looks orphaned and gets `rm -rf`'d out from under a running sandbox.
   Test: *"does not remove active worktrees when .sandcastle is a symlink"*
   (regression #470, WorktreeManager.test.ts).

---

## (A) Stream-json parsing (`parseStreamJsonLine`)

Source: `AgentProvider.ts`, `parseStreamJsonLine`. Tests: AgentProvider.test.ts, Orchestrator.test.ts.

- 🟡 **`startsWith("{")` guard runs before `JSON.parse`** — so valid *non-object*
  JSON (`[1,2]`, `42`, `"str"`) and empty lines all return `[]`, not just
  garbage. A bare `try{JSON.parse}` reimplementation would diverge.
  (Orchestrator.test.ts:854.)
- 🔴 **Malformed JSON that starts with `{` is swallowed → `[]`, never thrown.**
  `"{bad json"` parses-fails inside the `catch{}`. Stream lines are routinely
  partial; throwing would abort the run. (AgentProvider.test.ts:351; Orchestrator.test.ts:859.)
- 🟡 **Multiple text blocks concatenate with NO separator** (`texts.join("")`),
  e.g. `["Hello ","world"]` → one `{text:"Hello world"}`. (Orchestrator.test.ts:871.)
- 🟡 **Text buffer flushes *before* each tool_use, preserving interleave order.**
  `[text, tool_use, text]` → `[{text}, {tool_call}, {text}]`. A "collect all
  text then all tools" rewrite reorders events. (Orchestrator.test.ts:1915.)
- ⚪ **Tool allowlist is exactly 4 tools** (`Bash→command`, `WebSearch→query`,
  `WebFetch→url`, `Agent→description`); everything else (`Read`, `Edit`, …) is
  dropped. A `tool_use` with a missing/non-string arg field is dropped too —
  **but accumulated text still survives** (don't early-return `[]`).
  (AgentProvider.test.ts:991, 1005, 1018.) Irrelevant to sandbar (we ignore
  tool_call events) but matters if you mirror the parser.
- 🔴 **`result` event requires `typeof obj.result === "string"`** and is returned
  verbatim including the `<promise>` token. This is the string sandbar parses.
  (AgentProvider.test.ts:56.)
- ⚪ **`session_id` only from `{type:"system", subtype:"init", session_id:<str>}`**
  — all three conditions required. Moot for sandbar (no resume/capture).
- ⚪ **Unknown top-level `type` → `[]`** (forward-compatible; a future claude CLI
  event type is silently ignored, not an error).
- ⚪ **Claude has NO error-event branch.** Unlike codex/pi (which map
  `error`/`agent_error` events to `result` so the error fallback can surface
  them), claude failures must arrive on stderr or as a `result` line to be
  surfaced — otherwise you get the stdout tail (see B below). Don't assume a
  generic error-event handler.

## (B) Run loop, output & errors (`invokeAgent`)

Source: `Orchestrator.ts`, `invokeAgent`.

- 🔴 **Non-zero exit error detail is a three-tier fallback:** `stderr` (if
  `.trim()` non-empty) → else `resultText` (last `result` event, if non-empty) →
  else **last 20 non-empty stdout lines** (`split("\n").filter(l=>l.trim())
  .slice(-20)`). Message: `` `${provider.name} exited with code ${code}:\n${detail}` ``
  (provider name `"claude-code"` is interpolated). A whitespace-only stderr
  counts as empty and falls through. Tests: tier-3 *"falls back to tail of
  stdout…"* (1590), tier-2 *"falls back to resultText…"* (1648), tier-1
  *"preserves stderr…"* asserting stdout does **not** leak when stderr is present
  (1710). This ordering is what surfaces useful diagnostics into sandbar's
  HARD-ERROR / failure traces.
- 🟡 **All timers must be cleared on completion.** Three timer fibers are in play:
  the idle *kill* timer and the idle *warning* interval (60 s, hard-coded
  "minute(s)" wording), plus the **completion-grace** timer that the same
  `resetTimer` arms once a completion signal is seen (F5; see
  [03 §two-phase timeout](./03-claude-agent-provider.md)). All reset on activity
  and are all interrupted in the `Effect.ensuring` block. A port that forgets one
  leaks a fiber/timer per run. The completion-grace timer is what turns a
  signalled-but-pipe-held run into a 60 s graceful finish with commits, instead of
  a 600 s `AgentIdleTimeoutError` that discards them. (Orchestrator.test.ts;
  completion-grace asserted by the *"force-completes after the grace window…"*
  cases.)
- 🟡 **`dangerouslySkipPermissions: true` is hard-coded by the loop**, regardless
  of caller — so the claude command always carries `--dangerously-skip-permissions`.
  **Prompt goes on stdin via `-p -`, never argv** (avoids shell-escaping large
  prompts; only `--model` is shell-escaped). Tests: *"invokes claude with
  stream-json and verbose flags"* (1770), *"buildPrintCommand delivers prompt via
  stdin, not argv"* (AgentProvider.test.ts:31).
- ⚪ **Completion match is a plain substring `includes`** of the `result||stdout`
  value against default `"<promise>COMPLETE</promise>"`. Moot for sandbar
  (`maxIterations:1`, own parser) but explains why the default signal matches
  sandbar's promise contract.

## (C) Commit capture & git setup (`withSandboxLifecycle`)

Source: `SandboxLifecycle.ts`. Tests: SandboxLifecycle.test.ts.

- 🔴 **`baseHead` is captured from the HOST worktree path before work runs**
  (`git rev-parse HEAD`, `cwd: hostWorktreePath ?? sandboxRepoDir`), never from
  inside the container. Test: *"records baseHead from the host worktree, not from
  inside the sandbox"*. For bind-mount these coincide, but capture it host-side
  via the real worktree path — it's the left edge of the rev-list range.
- 🔴 **Explicit-branch capture is `git rev-list "<baseHead>..refs/heads/<branch>"
  --reverse` run in `hostRepoDir`.** Three traps: (1) the ref is **fully
  qualified** `refs/heads/<branch>` — a bare name could resolve a tag or
  remote-tracking ref; (2) it runs against `hostRepoDir` (the bind-mounted
  worktree shares the object DB, so the branch ref is visible there); (3)
  `--reverse` ⇒ **oldest-first** ordering, which sandbar's merger relies on.
  Test: *"no cherry-pick when explicit branch is given"*.
- 🔴 **Zero commits → `[]`, and a missing branch must NOT throw.** The rev-list is
  wrapped in try/catch returning `[]` ("Branch doesn't exist on host (no commits
  produced)"). Test: *"returns empty commits when no work is done"*. A port that
  lets a nonzero git exit propagate turns a legitimate NEEDS-INFO / no-op outcome
  into a hard error.
- 🟡 **Asymmetric error policy:** setup commands and hooks use `execOk` (any
  nonzero exit → `ExecError` `"Command failed (exit N): …"`), but commit
  collection swallows errors → `[]`. Don't unify these. The git-**setup** commands
  additionally go through `execOkWithGitTimeout`, which **retries on exit 126/137
  only** (2×, 250 ms apart) — transient container-`exec` races under parallelism
  (F2; `ExecError` carries `exitCode` to classify). The retry is scoped to
  git-setup: **not** hooks, **not** commit collection, **not** the agent exec; a
  genuine non-transient failure (exit 1) still fails fast. Tests:
  SandboxLifecycle.test.ts retry cases.
- 🟡 **Git identity: read on host first, written `--global` in the sandbox, both
  writes guarded.** Host `git config user.name`/`user.email` (each `.catch(()=>
  "")`) are read *before* sandbox setup, then written as `git config --global`
  inside the container **only if non-empty** (`if (hostGitName)`). Missing host
  identity is skipped silently — never written empty. Values are double-quoted
  with inner `"` escaped to `\"` (a port using arg-arrays/no-shell should drop
  both the quotes and the escaping). Tests: *"sets host git user.name/email as
  global config in the sandbox"*, *"gracefully skips … when host has no git
  config"*.
- ⚪ **10 s per-command timeout on the git-setup phase**
  (`GIT_SETUP_TIMEOUT_MS`); 30 s on commit collection
  (`COMMIT_COLLECTION_TIMEOUT_MS`).
- ⚪ **Out-of-scope but adjacent:** `applyToHost` (isolated only) runs *after*
  work, *before* commit collection. Sandbar is bind-mount, so it's a no-op.

## (D) Worktree management (`WorktreeManager`)

Source: `WorktreeManager.ts`. Tests: WorktreeManager.test.ts.

- 🔴 **Collision detection matches by branch first, then by target path.** The
  path fallback exists to catch **detached-HEAD** state (mid-rebase/merge/
  cherry-pick), where porcelain's `branch` field is `null`. Test: *"reuses
  preserved worktree when branch is mid-rebase (detached HEAD)"*. Branch-only
  matching wrecks a live worktree whose branch went detached.
- 🟡 **Reuse only for *managed* worktrees** (path under `.sandcastle/worktrees/`).
  A branch checked out in the main working tree or an external worktree →
  **throws** `"Branch '…' is already checked out…"`. Test: *"detects collision
  when branch is checked out in the main working tree"*.
- 🔴 **Dirty does NOT block reuse — both clean and dirty reuse the same worktree**
  (ADR-0003). And **"dirty" = `git status --porcelain` non-empty**, which counts
  untracked + staged but **excludes committed-but-unpushed**. Test: *"reuses
  worktree with unpushed commits (not considered dirty)"*. This is exactly
  sandbar's ralph loop: accumulated commits on the issue branch must not count as
  dirty, and a reused worktree must **never** be `reset --hard` (you'd lose
  in-progress work). In `0.7.0` the two paths diverge in what they do on reuse:
  *dirty* → `console.warn` and reuse as-is; *clean* → `fastForwardFromOrigin`
  (F6) which may `git merge --ff-only origin/<branch>` but **skips** on
  detached-HEAD / fetch-failure / divergence and never resets. See
  [04 §create collision-reuse](./04-worktree-and-mounts.md).
- 🟡 **`remove` derives the repo dir by going up exactly 3 levels** (`join(wt,
  "..","..","..")`) and uses `--force`. If the worktree nesting depth ever
  changes, `remove` targets the wrong repo. `--force` is needed because the tree
  may be dirty / mid-operation.
- 🟡 **`pruneStale` is two-stage and dir-only:** `git worktree prune` first
  (clears metadata for vanished dirs), *then* sweep entries under
  `.sandcastle/worktrees/` that are directories and not in the active set
  (`rm -rf`). Non-dir entries are skipped; a missing worktrees dir is a no-op
  (only `NotFound` is swallowed — other read errors surface). Tests: *"runs git
  worktree prune…"*, *"removes orphaned directories…"*, *"removes orphaned dirs"*.
  Plus the realpath trap (top-trap #6).
- ⚪ **New-branch fallback keys off the literal substring `"invalid reference"`**
  in git's stderr, then `worktree add -b <branch> <path> <baseBranch ?? HEAD>`. In
  `0.7.0` the substring is locale-safe because `execGit` forces `LC_ALL=C` (F7,
  [04 top](./04-worktree-and-mounts.md)). **Sandbar always pre-creates the
  branch**, so it takes the non-`-b` path — but note that if a branch were somehow
  absent, this fallback creates it from local `HEAD`, not `origin/<sourceBranch>`.

## (E) Podman provider (`sandboxes/podman.ts`)

Source: `sandboxes/podman.ts`, `boundedTail.ts`, `mountUtils.ts`. Tests:
podman.test.ts, boundedTail.test.ts, mountUtils.test.ts.

- 🔴 **`exec` joins stdout differently with vs without `onLine`.** Without
  `onLine`: raw `chunk.toString()` pieces concatenated with `""` (verbatim,
  newlines intact) — **still unbounded** (`stdoutChunks.join("")`). With `onLine`
  (sandbar's path): read via `readline`, each line pushed to a **`BoundedTail`**
  (separator `"\n"`) and to `onLine`; the retained stdout is the tail's
  `toString()` — so the **trailing newline is lost, CRLF normalized, and the
  retained string is bounded to 64 KiB keeping the end**. The agent run uses
  `onLine`; **anything you parse byte-exactly (gate output, tokens) should use the
  non-`onLine` raw path** — but never route *large* output through it (it's the
  unbounded branch). (`podman.ts` exec, `boundedTail.ts`.)
  - The bound (F1) is load-bearing: an unbounded `onLine` accumulation throws
    `RangeError: Invalid string length` past V8's ~512 MB cap *inside the `close`
    handler*, escaping `Promise.allSettled` and killing every sibling issue.
    `BoundedTail` keeps the **end** (`slice(len - maxChars)` for an over-long
    single item), so the trailing `<promise>`/`<verdict>` token survives. Test:
    boundedTail.test.ts.
- 🟡 **Exact `podman run` argv order is positionally asserted:**
  `run -d --name <n> --user <uid>:<gid> --userns=keep-id:uid=N,gid=N [--network
  N…] -w <wt> [-e K=V…] [-v VOL…] --entrypoint sleep <image> infinity`. `--user`
  before `--userns`; `infinity` is the **command arg after the image** (sleep's
  duration), not part of `--entrypoint`. Tests: *"passes custom containerUid/Gid"*,
  *"passes --userns=keep-id by default"*.
- 🟡 **`--userns` emits the full `keep-id:uid=1000,gid=1000`**, not bare
  `keep-id` (even though the option default *string* is `"keep-id"`). **`--user
  1000:1000` is always passed**, independent of userns.
- 🟡 **`HOME=/home/agent` is force-injected last** (`{...env, HOME}`), overriding
  any caller/env-file HOME. The image's agent home must be `/home/agent` (git,
  claude resolve config from `$HOME`).
- 🟡 **`-w` = the *sandbox-side* path of the worktree mount** (matched by
  `hostPath === createOptions.worktreePath`), default `/home/agent/workspace`.
- 🟡 **Container teardown is synchronous and registered in the shared registry.**
  `removeContainerSync` = `execFileSync("podman", ["rm","-f",name], {timeout:5000,
  stdio:"ignore"})` (synchronous — an *async* exit handler won't finish during
  `process.exit` → leaked containers) is handed to `registerShutdown`
  (`shutdownRegistry.ts`), which keeps **one** `exit`/`SIGINT`/`SIGTERM` listener
  set process-wide and fans out to a `Set` of teardowns (F3). `close()` calls the
  returned unregister, then does the async `podman rm -f`. The per-instance
  listeners `0.5.12` shipped trip `MaxListenersExceededWarning` past ~5 parallel
  sandboxes — the shared registry is what makes sandbar's fan-out safe. Both the
  sync teardown and the unregister-on-close are load-bearing. Tests:
  podman.test.ts (*"…timeout on signal handler cleanup"*), shutdownRegistry.test.ts
  (*"installs one listener per signal regardless of registration count"*).
- 🟡 **Image pre-flight before run:** `podman image inspect <img>`; on failure the
  exact message is `Image '<img>' not found locally. Build it first with 'podman
  build -t <img> .'`. (macOS/Windows also do `podman machine list` first —
  skippable on Linux.) Fail fast here rather than on an opaque `podman run`.
- ⚪ **`defaultImageName` = `sandcastle:<last-path-segment>`**, lowercased,
  `[^a-z0-9_.-]→-`. `My Repo!` → `sandcastle:my-repo-` (trailing dash is real);
  empty → `sandcastle:local`. Reproduce exactly or your computed tag won't match
  a sandcastle-built image.
- ⚪ **No post-start `chown` for bind mounts** — `--userns=keep-id` maps the host
  UID directly. `mkdir+chown` only fires for file-mount parents (sandbar has
  none). Don't add a defensive `chown -R` (slow/destructive). Test: *"does not run
  chown after container start"*.
- ⚪ **`sudo` is a command-string prefix** (`sudo ${command}`), not a podman flag.

## (F) Mounts & volume formatting (`mountUtils.js`)

- 🟡 **`formatVolumeMount` option order is `ro` then selinux, comma-joined.**
  writable+`z` → `host:sandbox:z`; readonly+`z` → `host:sandbox:ro,z` (never
  `z,ro`); `selinuxLabel:false` → `host:sandbox` with **no trailing colon**
  (asserted: not `host:sandbox:`, not `::`). Sandbar's every mount is
  `host:sandbox:z` — including both git mounts, or SELinux-enforcing hosts deny
  access. Tests: `describe("formatVolumeMount")`.
- 🟡 **On Linux, `normalizeMounts` and `patchGitMountsForWindows` are no-ops** —
  the entire `PARENT_GIT_SANDBOX_DIR` / temp-`.git`-override / `parseGitdirPath`
  apparatus is Windows-only and can be dropped for a Linux host. Test: *"preserves
  sandboxPath === hostPath for git mounts on POSIX"*.
- ⚪ **`gitdir:` parse trims first, requires the `^gitdir:\s*(.+)$` prefix;**
  unrecognized `.git` content falls back to a single mount (no throw).

## (G) Env resolution & copy (`EnvResolver.js`, `mergeProviderEnv.js`, `CopyToWorktree.js`)

- 🔴 **`.sandcastle/.env` value wins over `process.env`, but only when truthy**
  (`sandcastleEnv[key] || process.env[key]`). An **empty value in the file falls
  back to `process.env`** — you *cannot* force-set an empty string via the file.
  Tests: *".sandcastle/.env takes precedence over process.env"*, *"falls back to
  process.env for keys declared…"*.
- 🔴 **Only keys *declared* in `.sandcastle/.env` are read from `process.env`** —
  the resolver iterates the file's keys, never `process.env`. `PATH`/`HOME` never
  leak through. **Do not leak the host environment into the container.** Test:
  *"does NOT pull keys from process.env that are not in .sandcastle/.env"*.
- 🟡 **Repo-root `.env` is completely ignored** — only `<repoDir>/.sandcastle/.env`.
- 🟡 **Falsy resolved values are omitted from the result object** (key absent, not
  `""`). Test: *"handles empty quoted values"* → `toEqual({})`.
- ⚪ **Quote stripping needs matching first/last quotes**; escapes (`\n \r \t \\`)
  are unescaped **only inside double quotes** (`\\` consumed first, so `"a\\nb"`
  → `a\nb` literal). `#`-comments only at line start (no inline-comment
  stripping). Tests: EnvResolver.test.ts quote/escape cases.
- 🟡 **`mergeProviderEnv` precedence: agent > sandbox > resolvedEnv; agent⨯sandbox
  key overlap THROWS** `/overlapping env/i`. Sandbar's agent env is `{}`, so only
  `podman().env` overrides resolved — but keep the throw.
- 🟡 **copyToWorktree: `cp -R --reflink=auto`, fallback plain `cp -R`, and the
  error only carries the *fallback's* stderr/exitCode** (the reflink error is
  discarded). **Missing source paths are silently skipped** (`existsSync` guard) —
  don't let `cp` error on absent files. One 60 s timeout wraps the whole
  sequential loop. Tests: *"succeeds when first cp fails but fallback succeeds"*,
  *"skips missing source paths without error"*.

## (H) createSandbox ordering, lifecycle reuse & hooks (`createSandbox.ts`)

- 🔴 **The container is created ONCE and reused across all `run()` calls;
  `close()` calls the provider's `close()` once and is idempotent.** Tests:
  *"provider's create() is called exactly once across multiple .run() calls"*,
  *"close() is idempotent"*. Sandbar's ralph loop (multiple `run()`s in one
  sandbox so commits accumulate) depends on this — do **not** respawn the
  container per run, and keep the worktree alive between runs (uncommitted state
  persists: *"state persists between runs"*).
- 🟡 **Setup order is locked in:** resolveCwd → `pruneStale` (errors swallowed) →
  `WorktreeManager.create` → `copyToWorktree` → **`host.onWorktreeReady`** (files
  present, container NOT yet up) → start container → **`onSandboxReady`** →
  `registerShutdown` → return. The `create`→`onSandboxReady` span is wrapped in
  `Effect.onError(() => WorktreeManager.remove(worktreePath))` (F4), with a nested
  `onError(() => providerHandle.close())` around the hook step — so a failure tears
  the container down first, then the worktree, leaving no orphaned dir (the trigger
  is usually `checkImageExists` failing when the gate image isn't built).
- 🟡 **`onSandboxReady` hooks run with `concurrency: "unbounded"` — ALL in
  parallel** (sandbox-side via `sandbox.exec(cmd, {cwd, sudo})`, host-side via
  `runHostHooks`). Hooks with ordering dependencies must be chained into one
  command string, not listed as separate entries. `host.onWorktreeReady` hooks,
  by contrast, run **sequentially**. Test: *"onSandboxReady hooks execute once at
  creation time"* (asserts side effect, not order — consistent with parallel).
- 🟡 **`close()` order: provider `close()` first, then dirty check, then worktree
  removal.** Clean → removed, `preservedWorktreePath: undefined`; dirty →
  preserved (`preservedWorktreePath: worktreePath`), not removed. Idempotent via a
  `closed` flag. Sandbar ignores the return, but a faithful port keeps the
  preserve-on-dirty so its orphan sweeper / next `pruneStale` cleans up.

---

## Shipped test helpers (the intended test contract)

`testSetup.ts` and `testSandbox.ts` (re-exported for downstream tests) reveal how
sandcastle tests the very code we're porting — directly reusable patterns for
`agent-sandbox.test.ts`:

- 🔴 **Per-worker `GIT_CONFIG_GLOBAL` isolation.** `testSetup.ts` (a vitest
  `setupFiles` entry) gives each forked worker its own temp `.gitconfig` and sets
  `process.env.GIT_CONFIG_GLOBAL`. Because the code under test calls `git config
  --global` (safe.directory, identity), and vitest forks workers in parallel,
  sharing one global config races on `.gitconfig.lock` → intermittent "could not
  lock config file". **Our `agent-sandbox.test.ts` must do the same** (the
  existing sandbar suite may already need this once it exercises real git config).
  It also seeds `user.email=test@test.com` / `name=Test` so identity-propagation
  tests have a known host identity.
- ⚪ **The local fake sandbox** (`makeLocalSandboxLayer`) runs commands via
  `spawn("sh", ["-c", command], { cwd })` against a temp dir, and **replicates the
  exact `onLine` stdout-join quirk** (`join(onLine ? "\n" : "")`). It also creates
  an isolated git env per layer. This is the model for a fake `Sandbox` in tests
  that need a real filesystem/git but no container — and confirms the `onLine`
  join behavior (trap E) is part of the contract, not an accident.

## How to keep these current

Current baseline is `v0.7.0`. If the pinned version is bumped again before the
port lands, re-pull the matching tag's source + co-located tests (cloning the tag
is easiest, since `0.7.0`+ ships bundled `dist` chunks that don't read cleanly):
```
git clone --depth 1 --branch v<VERSION> https://github.com/mattpocock/sandcastle /tmp/sc
ls /tmp/sc/src/*.test.ts
# or, just the test paths without a clone:
gh api repos/mattpocock/sandcastle/git/trees/v<VERSION>?recursive=1 \
  --jq '.tree[].path | select(test("\\.(test|spec)\\."))'
```
The agent-run loop (E/B) and stream-json parser (A) are the most likely to drift
with the `claude` CLI contract — re-verify those first.
