# 02 — Podman provider

Source (v0.7.0 tag): `src/sandboxes/podman.ts`, `src/SandboxProvider.ts`,
`src/mountUtils.ts`, `src/boundedTail.ts`, `src/shutdownRegistry.ts`,
`src/sandboxExec.ts`. Imported by sandbar as
`@ai-hero/sandcastle/sandboxes/podman`.

`podman(options?)` returns a **bind-mount sandbox provider**: an object
`{ tag: "bind-mount", name: "podman", env, sandboxHomedir, create }`
(`createBindMountSandboxProvider`, `SandboxProvider.ts`). All container work
is plain `node:child_process` against the `podman` binary on `PATH` — no Effect,
no podman SDK. This is the most directly portable piece.

## Options (`podman.d.ts`) and sandbar's resolved values

Sandbar calls `podman()` with **no arguments**, so:

| Option | Default | Sandbar value |
| --- | --- | --- |
| `imageName` | `defaultImageName(hostRepoPath)` = `sandcastle:<dir>` | derived |
| `selinuxLabel` | `"z"` | `"z"` |
| `userns` | `"keep-id"` | `"keep-id"` |
| `containerUid` | `1000` | `1000` |
| `containerGid` | `1000` | `1000` |
| `mounts` | `[]` (user mounts) | none |
| `env` | `{}` | none |
| `network` | none | **none** ← agent container is networkless |
| `maxOutputTailChars` | `MAX_TAIL_CHARS` = 64 KiB | default (bounds the retained `exec` tail — see `exec` below) |
| `cpus` | none (`--cpus` omitted) | none |
| `groups` | `[]` (`--group-add`) | none |
| `devices` | `[]` (`--device`) | none |

Fixed: `sandboxHomedir = "/home/agent"`.

The last four (`maxOutputTailChars`, `cpus`, `groups`, `devices`) are `0.6.x`
additions that did not exist in `0.5.12`. Sandbar passes none of them, but
`cpus` is the one with plausible value: a `--cpus` cap is a cheap stability lever
when N agent sandboxes plus N Postgres sidecars run at once. The port's minimum
`PodmanOptions` can omit `groups`/`devices` (irrelevant to sandbar) but **must**
keep `maxOutputTailChars` wired into `exec` (below).

`defaultImageName` (`mountUtils.ts`): take the last path segment of the repo
dir, lowercase, replace `[^a-z0-9_.-]` with `-`, prefix `sandcastle:`. E.g.
`/home/unixuser/sandbar` → `sandcastle:sandbar`.

## `create(createOptions)` — container bring-up

`createOptions` (from `startSandbox` bind-mount,
[01](./01-sandbox-lifecycle.md) step 8) is
`{ worktreePath, hostRepoPath, mounts, env }`, where `mounts` already includes
the worktree→`/home/agent/workspace` mount plus the git mounts.

Sequence (`podman.ts`, `create`):

1. `containerName = "sandcastle-" + randomUUID()`. **Prefix is load-bearing**
   (orphan sweeper).
2. Sandbox-side worktree path = the `sandboxPath` of the mount whose `hostPath`
   equals `createOptions.worktreePath`, else `/home/agent/workspace`.
3. Build volume mounts: `[...createOptions.mounts, ...userMounts].map(m =>
   formatVolumeMount(m, selinuxLabel))`. `formatVolumeMount`
   (`mountUtils.ts`) → `host:sandbox[:ro][,z]`. With label `z` and no
   readonly: `host:sandbox:z`.
4. Resolve `imageName` (above).
5. **Pre-flight, macOS/Windows only**: `checkPodmanMachine()` —
   `podman machine list --format json`, error unless some machine is `Running`.
   Skipped on Linux.
6. **Pre-flight, always**: `checkImageExists(imageName)` —
   `podman image inspect <image>`; on error throws
   `Image '<image>' not found locally. Build it first with
   'podman build -t <image> .'`.
7. `env = { ...createOptions.env, HOME: "/home/agent" }` → `-e KEY=VALUE` args.
8. Compose args and run:
   ```
   podman run -d \
     --name sandcastle-<uuid> \
     --user 1000:1000 \
     --userns=keep-id:uid=1000,gid=1000 \
     [--network <n> ...]        # absent for sandbar
     -w <sandbox-worktree> \
     -e KEY=VALUE ... \
     -v host:sandbox:z ... \
     --entrypoint sleep <image> infinity
   ```
   (userns args present only when `userns` truthy; user args always.) Wrapped in
   a Promise around `execFile`; rejects `podman run failed: <msg>` on error.
9. For each file-mount parent dir (`processFileMountParents`, `mountUtils.ts`):
   `podman exec --user 0:0 <name> sh -c 'mkdir -p "$1" && chown "$2" "$1"' ...`.
   Sandbar has no file mounts, so this is a no-op for us.
10. **Register container teardown** via the shared registry:
    `registerShutdown(removeContainerSync)` (`shutdownRegistry.ts`), where
    `removeContainerSync` = `execFileSync("podman", ["rm","-f",name], {
    stdio:"ignore", timeout:5000 })` (**synchronous**, best-effort). The registry
    installs **one** `exit`/`SIGINT`/`SIGTERM` listener set process-wide and fans
    out to every registered teardown — on a signal it runs them all then
    `process.exit(1)` once; on a plain `exit` it runs them without forcing a code.
    This is the *same* registry `createSandbox` uses for its worktree-preserve
    guidance ([01 step 10](./01-sandbox-lifecycle.md)), so no matter how many
    sandboxes are alive there is exactly one listener per signal. `close()` calls
    the returned unregister.
11. Return the **handle** (below).

## The handle

`podman.ts`, the `handle` object. The methods sandbar's path relies on:

### `exec(command, opts?)` → `{ stdout, stderr, exitCode }`

`podman.ts`, handle `exec` (~line 306). This is what the agent run and all git
setup go through.

- `effectiveCommand = opts.sudo ? "sudo " + command : command`.
- args: `["exec"]` + `["-i"]` if `opts.stdin !== undefined` +
  `["-w", opts.cwd]` if `opts.cwd` + `[name, "sh", "-c", effectiveCommand]`.
- Spawns `podman` with `spawn`. stdio: `[stdin?"pipe":"ignore", "pipe", "pipe"]`.
  If `opts.stdin` set, write it and `end()`.
- **Line streaming (the `onLine` branch — sandbar's path)**: stdout is read via
  `readline.createInterface`; each line is pushed to a **`BoundedTail`** and also
  passed live to `onLine(line)`. `boundedTail.ts` keeps a rolling tail bounded by
  `maxOutputTailChars` (default 64 KiB); `toString()` joins the retained items.
  The stdout tail is constructed with separator `"\n"` (`new BoundedTail(max,
  "\n")`), stderr with separator `""`. On `close`, stdout = `stdoutTail.toString()`,
  stderr = `stderrTail.toString()`.
  - **This is the F1 fix, now the baseline.** The bound is what stops a long agent
    run from overflowing V8's ~512 MB max string length: an unbounded
    `chunks.join()` would throw `RangeError: Invalid string length` *inside the
    `close` handler*, which bypasses the `run()` promise and `Promise.allSettled`
    and would tear down every sibling issue in the cycle. The port must keep this
    bound. `BoundedTail` keeps the **end** of the stream (a single item longer
    than `maxChars` is truncated to its own tail via `slice(len - maxChars)`), so
    the trailing `<promise>`/`<verdict>` token sandbar parses always survives.
  - ⚠️ The `onLine` vs not join *shape* still differs: with `onLine`, lines are
    re-joined with `"\n"` (trailing newline lost, CRLF normalised); the agent run
    uses `onLine`. Anything parsed byte-exactly should use the non-`onLine` path.
- **Non-`onLine` branch**: stdout/stderr chunks collected raw and joined `""` —
  **still unbounded** (`stdoutChunks.join("")`). Sandbar never hits this path (the
  agent run always supplies `onLine`), so it's harmless here, but don't route
  large output through a no-`onLine` exec.
- `proc.on("error")` → reject `podman exec failed: <msg>`.
- `proc.on("close", code)` → resolve `{ stdout, stderr, exitCode: code ?? 0 }`.

Note: the command runs under `sh -c`, so the whole command string is one shell
invocation. The agent provider relies on this (it builds a single command
string and pipes the prompt to stdin — see [03](./03-claude-agent-provider.md)).

### `close()`

`podman.ts`, handle `close` (~line 440). Call the `unregisterShutdown` returned
at create-step 10 (drops this container's teardown from the shared registry; the
last unregister detaches the process listeners), then `podman rm -f <name>`
(Promise around `execFile`; rejects on error).

### Other handle methods (present but unused on sandbar's path)

- `interactiveExec(args, opts)` — `podman exec -it|-i [-w cwd] <name> <args...>`
  wired to host stdio. Used by `interactive()` only.
- `copyFileIn(host, sandbox)` / `copyFileOut(sandbox, host)` — `podman cp`.
  Used by session capture / isolated providers only.
- `worktreePath` — the sandbox-side worktree path.

## `sandboxExec.js` helpers

Thin wrappers used elsewhere in sandcastle (not by the provider itself):
`execHost(cmd, cwd)` (host `exec`, 10 MB buffer, throws on non-zero) and
`execOk(handle, cmd, opts)` (sandbox exec, throws `Sandbox command failed (exit
N)` on non-zero). The in-house module can fold equivalents inline.

## Reimplementation notes

- This file is ~90% portable as-is: strip the `createBindMountSandboxProvider`
  indirection and return the handle directly.
- Keep the `sandcastle-` container-name prefix, or update `containers.ts`
  `NAME_PREFIX` and `merger.ts:435` together.
- Keep the shutdown-registry cleanup — it's what prevents leaked containers on
  crash. Note sandbar *already* has its own orphan sweeper (`containers.ts`) as a
  backstop, but the in-process handlers are the fast path. Port the registry
  faithfully: **one** module-scope listener set per signal fanning out to a `Set`
  of teardown callbacks (`shutdownRegistry.ts`), *not* a listener per `podman()`
  create / per `createSandbox` — the per-instance version `0.5.12` shipped trips
  `MaxListenersExceededWarning` past ~5 concurrent sandboxes, and sandbar fans out
  in parallel. Keep the **synchronous** `execFileSync(... timeout:5000)` teardown
  (an async handler won't finish during `process.exit`), and have a signal run
  all teardowns then `process.exit(1)` exactly once.
- The `--userns=keep-id:uid=1000,gid=1000` + `--user 1000:1000` combination is
  what makes bind-mounted files writable by the agent without chown. The host
  `Containerfile` must define the `agent` user at uid/gid 1000 to match.
- `exec`'s `onLine`-vs-not join difference (`\n` join vs raw `""`) is subtle but
  the agent loop depends on `onLine`; preserve it.
