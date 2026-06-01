# 07 — Changelog: 0.5.12 → 0.7.0

These docs originally reverse-engineered `@ai-hero/sandcastle@0.5.12` (the version
our old `^0.5.7` caret resolved to) and carried this file as a *deviation overlay*:
a list of bugs `0.5.12` had that `0.6.x`/`0.7.0` later fixed, with per-fix port
directives. On **2026-06-01** we bumped the dependency to `^0.7.0` (a clean bump —
`tsc` + the 201-test suite stay green; sandbar's consumed surface is unchanged)
and re-baselined docs [01](./01-sandbox-lifecycle.md)–[06](./06-test-derived-gotchas.md)
to describe `0.7.0` **directly**, against the source at the `v0.7.0` tag.

So this file is no longer a TODO list — every fix below is **already folded into
the baseline docs** and the code sandbar now runs. It survives as a short history:
*why* the baseline looks the way it does, and what we'd have shipped a buggy port
of had we frozen on `0.5.12`. The caret trap that stranded us: `^0.5.7` resolves
`>=0.5.7 <0.6.0`, so npm could never auto-pull `0.6.x`/`0.7.0` — the bump had to
be manual.

Commit hashes are from the upstream release notes
(`gh api repos/mattpocock/sandcastle/releases/tags/v<ver> --jq .body`); the
authoritative description of each behaviour is the `v0.7.0` source cited in the
baseline docs.

## The nine changes, by impact on sandbar's path

🔴 = was a crash/hang/data-loss on our path · 🟡 = robustness under our
parallelism · ⚪ = minor / new knob.

| # | Change | Ver / commit | Folded into | Sev |
| --- | --- | --- | --- | --- |
| F1 | Bounded output tail (`BoundedTail`, no `RangeError`) | 0.6.0 `825aadf` | [02 §exec](./02-podman-provider.md), [06 §E](./06-test-derived-gotchas.md) | 🔴 |
| F2 | Retry transient git-setup exec (126/137) | 0.6.0 `fbad1a4` | [01 §lifecycle](./01-sandbox-lifecycle.md), [06 §C](./06-test-derived-gotchas.md) | 🟡 |
| F3 | One shared SIGINT/SIGTERM/exit registry | 0.6.1 `6165660` | [01 step 10](./01-sandbox-lifecycle.md), [02 §registry](./02-podman-provider.md) | 🟡 |
| F4 | Remove worktree if sandbox start fails | 0.6.0 `a3f1c04` | [01 setup seq](./01-sandbox-lifecycle.md), [06 §H](./06-test-derived-gotchas.md) | 🟡 |
| F5 | `completionTimeoutSeconds` two-phase timer | 0.6.6 `ddc26ba` | [03 §two-phase timeout](./03-claude-agent-provider.md), [06 §B](./06-test-derived-gotchas.md) | 🔴 |
| F6 | `ff-only` refresh of a reused clean worktree | 0.7.0 `c6880a4` | [04 §create reuse](./04-worktree-and-mounts.md) | ⚪ |
| F7 | `LC_ALL=C` on every worktree git invocation | 0.6.1 `46eb483` | [04 §WorktreeManager](./04-worktree-and-mounts.md) | ⚪ |
| F8 | More tunable lifecycle timeouts | 0.6.0 `b233f40` | [01 §default timeouts](./01-sandbox-lifecycle.md) | ⚪ |
| F9 | `cpus` / `groups` / `devices` on `podman()` | 0.6.0 `c878b14`,`15d70ef`,`2318bb4` | [02 §options](./02-podman-provider.md) | ⚪ |

## What each fix was (and where the detail now lives)

### F1 🔴 Bounded output tail — the `RangeError` crash · 0.6.0 `825aadf`
`0.5.12` accumulated `exec` stdout in an unbounded array and `join`-ed it at
`close`; a long agent run overflowed V8's ~512 MB max string length and threw
`RangeError` **inside the `close` handler**, escaping `Promise.allSettled` and
tearing down every sibling issue in the cycle. `0.7.0` keeps a 64 KiB rolling
`BoundedTail` (separator `"\n"` for the line-streamed stdout, `""` for stderr),
retaining the **end** so the trailing `<promise>`/`<verdict>` token survives. The
non-`onLine` branch is still unbounded, but sandbar never uses it. → baseline:
[02 §exec](./02-podman-provider.md), [05 F1](./05-reimplementation-spec.md).

### F2 🟡 Retry transient git-setup exec (126/137) · 0.6.0 `fbad1a4`
Under heavy parallel bring-up the `git config` / `git rev-parse` setup execs could
fail with exit **126** ("cannot exec") or **137** (SIGKILL) from a momentary
container-`exec` race — not a real git error. `0.5.12` surfaced these as spurious
HARD-ERRORs. `0.7.0`'s `execOkWithGitTimeout` retries **only** those exit codes
(`GIT_SETUP_MAX_RETRIES = 2`, 250 ms apart), each attempt still timeout-bounded;
genuine failures (exit 1) and hangs fail fast. Scoped to git-setup execs only.
→ baseline: [01 §lifecycle step 2](./01-sandbox-lifecycle.md), [06 §C](./06-test-derived-gotchas.md).

### F3 🟡 One shared shutdown registry · 0.6.1 `6165660`
`0.5.12` registered `SIGINT`/`SIGTERM`/`exit` listeners *per* `createSandbox` **and
per** `podman()` create; past ~5 concurrent sandboxes that tripped Node's
`MaxListenersExceededWarning`. `0.7.0`'s `shutdownRegistry.ts` installs exactly one
listener per signal process-wide and fans out to a `Set` of teardown callbacks
(container `rm -f`, worktree-preserve guidance); a signal runs them all then
`process.exit(1)` once. `registerShutdown` returns an idempotent unregister that
`close()` calls; the last unregister detaches the listeners. → baseline:
[01 step 10](./01-sandbox-lifecycle.md), [02 §registry](./02-podman-provider.md).

### F4 🟡 Remove the worktree when sandbox start fails · 0.6.0 `a3f1c04`
`0.5.12` created the worktree before the container; a failure in between (commonly
`checkImageExists` when the gate image isn't built) stranded the worktree on disk,
which then collided with sandbar's HARD-ERROR retry. `0.7.0` wraps the
create→`onSandboxReady` span in `Effect.onError(remove worktree)`, with a nested
`onError(close container)` on the hook step — two-level teardown, no orphan.
→ baseline: [01 setup sequence](./01-sandbox-lifecycle.md), [06 §H](./06-test-derived-gotchas.md).

### F5 🔴 `completionTimeoutSeconds` two-phase timer · 0.6.6 `ddc26ba`
When the agent emits `<promise>COMPLETE</promise>` but a spawned child (`gh`/`git`,
an MCP server) holds the exec stdout pipe open, the parent never hits EOF.
`0.5.12` waited the **full 600 s** idle window and failed with
`AgentIdleTimeoutError`, **discarding commits already made**. `0.7.0` scans the
accumulated output as it streams; the first completion-signal match flips to a
short **completion-grace** timer (`DEFAULT_COMPLETION_TIMEOUT_SECONDS = 60`) that,
on expiry, **resolves the run successfully** with `resultText || accumulatedOutput`
and the commits. Resets on each later line; a clean exit wins the race, so healthy
runs add zero latency. Iteration-count-independent, so `maxIterations: 1` did not
dodge it. → baseline: [03 §two-phase timeout](./03-claude-agent-provider.md),
[06 §B](./06-test-derived-gotchas.md).

### F6 ⚪ `ff-only` refresh of a reused clean worktree · 0.7.0 `c6880a4`
On the clean-reuse path, `0.7.0` runs `git fetch origin <branch>` +
`git merge --ff-only origin/<branch>` so a reused worktree isn't stale after origin
moves — but **skips** (with a log) on detached-HEAD (mid-rebase), fetch failure, or
divergence, and **never** `reset --hard`s. Sandbar dodges this (pre-seeds via
`ensureIssueBranch`, disposes the sandbox per cycle), so it's optional for the
port. → baseline: [04 §create reuse](./04-worktree-and-mounts.md).

### F7 ⚪ `LC_ALL=C` on worktree git · 0.6.1 `46eb483`
Several `WorktreeManager` call sites match git's stderr (e.g. `"invalid
reference"`) to branch control flow; under a localized locale gettext translates
those strings and the match silently fails. `0.7.0` runs **every** git invocation
in `execGit` with `LC_ALL: "C"`. → baseline: [04 top](./04-worktree-and-mounts.md).

### F8 ⚪ More tunable lifecycle timeouts · 0.6.0 `b233f40`
`gitSetupMs`, `commitCollectionMs`, and `mergeToHostMs` became overridable via the
`timeouts` option alongside `copyToWorktreeMs`. Not a bug; these are the knobs to
expose first if sandbar ever needs to tune under load. → [01 §default timeouts](./01-sandbox-lifecycle.md).

### F9 ⚪ Resource caps on `podman()` · 0.6.0 `c878b14`/`15d70ef`/`2318bb4`
`cpus` (→ `--cpus`, fractional), `groups` (→ `--group-add`), `devices` (→
`--device`) added to `PodmanOptions`. Not bugs. `cpus` is the only one with
plausible sandbar value (N agent sandboxes + N Postgres sidecars can oversubscribe
CPU); `groups`/`devices` are irrelevant. → [02 §options](./02-podman-provider.md).

## What the re-baseline did NOT change

The consumed-surface behaviours below were identical in `0.5.12` and `0.7.0`, so
the original reverse-engineering carried over unchanged — `parseStreamJsonLine`
(the 4-tool allowlist, `result` event shape, `[]` on non-`{`/malformed; `0.7.0`
adds a Codex-only `usage` variant Claude never emits), the `result || stdout`
fallback, the non-zero-exit three-tier error detail, the
`baseHead..refs/heads/<branch> --reverse` commit capture, the two-mount git
resolution, `NO_CONFIG_LOCK_FLAGS` on `worktree add`, `pruneStale` realpath
safety, the `.sandcastle/.env` precedence rules, and all load-bearing
names/layout in the [README](./README.md). The agent-run loop and stream-json
parser remain the most likely to drift with the `claude` CLI — re-verify those
first if the dependency is bumped again before the port lands (see
[06 §"How to keep these current"](./06-test-derived-gotchas.md)).
