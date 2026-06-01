# Sandcastle reverse-engineering specs

These documents reverse-engineer the parts of `@ai-hero/sandcastle` (pinned
`0.7.0`, the latest) that sandbar actually consumes. They exist to support
[issue #6](https://github.com/Tojins/sandbar/issues/6): replacing the dependency
with a minimal in-house module that drops the Effect runtime (~72 MB of
`node_modules`) while preserving behaviour byte-for-byte on the path sandbar
exercises.

Everything here was traced from the **source tree at tag `v0.7.0`**
(`github.com/mattpocock/sandcastle`, `src/*.ts`) — not the compiled `dist/`,
which `0.7.0` ships as bundled/minified chunks. Line references are to that
source. If the dependency is bumped again before the port lands, re-verify
against the new tag — the agent-run loop in particular tracks an evolving
`claude` CLI contract.

> **Re-baselined `0.5.12` → `0.7.0` (2026-06-01).** These docs originally
> reverse-engineered `0.5.12` (the version our old `^0.5.7` caret resolved to)
> and carried a separate "deviation" overlay for bugs upstream had since fixed.
> We bumped the dependency to `^0.7.0` (a clean bump — `check` + the 201-test
> suite stay green; our consumed surface is unchanged), so docs 01–06 now
> describe `0.7.0` **directly** — the former 🔴/🟡 deviations (the `RangeError`
> crash, the 10-minute idle hang, the per-sandbox signal handlers, the
> transient-`exec` HARD-ERRORs) are part of the baseline the code already
> implements. [07](./07-upstream-fixes-since-0.5.12.md) is now a short changelog
> of what those fixes were, for posterity. "Byte-for-byte" (below) means
> sandbar's observable behaviour, traced against this bug-fixed baseline.

## What sandbar uses

Five symbols, imported in `src/inner-loop.ts` and `src/config.ts`:

| Symbol | Import | Sandbar call site |
| --- | --- | --- |
| `createSandbox(options)` | `@ai-hero/sandcastle` | `inner-loop.ts:145` |
| `podman(options?)` | `@ai-hero/sandcastle/sandboxes/podman` | `inner-loop.ts:146` (called **with no args**) |
| `claudeCode(model, options?)` | `@ai-hero/sandcastle` | `inner-loop.ts:300,354` |
| `sandbox.run(options)` → `{ stdout, commits }` | (method on the handle) | implementer + reviewer passes |
| types `Sandbox`, `SandboxHooks` | `@ai-hero/sandcastle` | `inner-loop.ts:16-18`, `config.ts:1` |

Of the `Sandbox` handle, sandbar uses only `run()`, `worktreePath`, and
`close()`. It never calls `interactive()` or `[Symbol.asyncDispose]`.

### The exact shape of sandbar's usage

- **Always bind-mount + podman.** `podman()` is called with no options, so:
  default image name (`sandcastle:<repo-dir>`), `--userns=keep-id`, uid/gid
  1000, SELinux label `z`, **no `--network`**. The agent container therefore
  cannot reach the per-issue Postgres sidecar — only the gate container
  (`src/gate.ts`) joins `sandcastle-net-<id>`. Reproduce this: the agent
  sandbox stays networkless.
- **Always an explicit, pre-existing branch.** Sandbar runs
  `ensureIssueBranch(issue.branch, sourceBranch)` (seeding from
  `origin/<sourceBranch>`) *before* `createSandbox`, and passes `branch` but no
  `baseBranch`. So the worktree-create path is "branch already exists →
  `git worktree add <path> <branch>`", never the `-b` fork path.
- **`maxIterations: 1`, always.** Every `run()` call passes `maxIterations: 1`,
  so the orchestrator's iteration loop runs exactly once. The completion-signal
  machinery, multi-iteration accumulation, and `resumeSession` are all dead code
  on our path — sandbar parses `run.stdout` itself with `promise-parser.ts` /
  `verdict-parser.ts`.
- **No session capture.** `createSandbox().run()` never threads a
  `bindMountHandle` into the lifecycle, so session capture / resume / token-usage
  parsing never fire on our path (see [01](./01-sandbox-lifecycle.md)).
- **Hooks are a passthrough.** `config.sandboxHooks` comes from the *host repo's*
  sandbar config and is handed straight to `createSandbox({ hooks })`
  (`run.ts:242`). The in-house module must honour the full `SandboxHooks` shape
  even though sandbar itself constructs none.

## What sandbar does NOT use (safe to drop)

The entire Effect runtime; the `@effect/cli` CLI (`cli.js`, `main.js`,
`interactive.js`, `run.js`); the docker / vercel / daytona / no-sandbox / isolated
providers; `createWorktree` as a public API; session store/transfer
(`SessionStore.js`, `SessionPaths.js`); structured output (`Output.js`,
`extractStructuredOutput.js`); the clack/Display UI layer (`Display.js`,
`AgentStreamEmitter.js`, `TextDeltaBuffer.js`); prompt arg substitution and
preprocessing (`PromptArgumentSubstitution.js`, `PromptPreprocessor.js`,
`PromptResolver.js`); the `codex` / `opencode` / `pi` agents; Windows git-mount
patching (`patchGitMountsForWindows`, ADR-0006 — Linux is a no-op); the
temp-branch / merge-to-host cherry-pick path in the lifecycle (only reached when
`branch` is omitted, which sandbar never does).

## Document index

1. [Sandbox lifecycle](./01-sandbox-lifecycle.md) — `createSandbox`, the `run()`
   flow, commit capture, hooks, `close()`. The orchestration heart.
2. [Podman provider](./02-podman-provider.md) — container create / exec / cp /
   close, signal handlers, image & machine pre-flight, mount formatting.
3. [Claude agent provider](./03-claude-agent-provider.md) — the `claude` command
   line, stream-json parsing, idle timeout, completion signal, error extraction.
4. [Worktree & mounts](./04-worktree-and-mounts.md) — `WorktreeManager`,
   `copyToWorktree`, git-mount resolution, env resolution.
5. [Reimplementation spec](./05-reimplementation-spec.md) — the actionable target
   for `src/agent-sandbox.ts`: public surface, the reduced control flow for
   sandbar's path, load-bearing constants, and test obligations.
6. [Test-derived gotchas](./06-test-derived-gotchas.md) — edge cases reverse-
   engineered from sandcastle's own vitest suite (co-located with the source at
   the `v0.7.0` tag, not shipped in the npm package) plus the shipped test
   helpers. Start with its "Top traps" list — these are the correctness landmines
   the implementation-only read in docs 01–05 does not reveal.
7. [Changelog: 0.5.12 → 0.7.0](./07-upstream-fixes-since-0.5.12.md) — a short
   history of the nine fixes that landed between our old `0.5.12` baseline and the
   current `0.7.0` one (F1 `RangeError`, F5 idle hang, F3 shared signal handler,
   F2 transient-`exec` retry, F4 worktree cleanup, F6/F7 worktree git, F8/F9 new
   knobs), each with its commit. These are already folded into docs 01–06; this is
   reference for *why* the baseline looks the way it does.

> Docs 01–05 describe **what the code does**; doc 06 captures **what the tests
> prove it must do** — the boundary conditions and ordering guarantees a
> reimplementation will silently get wrong otherwise. Read 06 alongside the
> matching section of 01–05.

## Load-bearing names (do not change casually)

These strings are matched by sandbar code *outside* the sandcastle boundary, so
the replacement must preserve them (or update every matcher in lockstep — see
[05](./05-reimplementation-spec.md)):

- Worktree dir layout: `<repoDir>/.sandcastle/worktrees/<branch-with-slashes-as-dashes>`
  — `src/finalize.ts:283` (`worktreePathFor`) mirrors `WorktreeManager.create`.
- Container name prefix `sandcastle-` and network prefix `sandcastle-net-` —
  `src/containers.ts:17-18` (`NAME_PREFIX`, `NETWORK_PREFIX`), `merger.ts:435`.
- Branch prefix `sandcastle/issue-<n>-<slug>` — `plan-resolver.ts:74`,
  `preflight.ts`, orphan sweeper.
- Sandbox mount point `/home/agent/workspace` (`SANDBOX_REPO_DIR`) and home
  `/home/agent`.
