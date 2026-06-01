# 04 — Worktree management, mounts & env

Source (v0.7.0 tag): `src/WorktreeManager.ts`, `src/CopyToWorktree.ts`,
`src/mountUtils.ts`, `src/SandboxFactory.ts` (`resolveGitMounts`),
`src/EnvResolver.ts`, `src/mergeProviderEnv.ts`.

## WorktreeManager

All operations shell out to `git` via `execFile` (Effect-wrapped upstream; the
port can use `execFile`/`promisify` directly). **Every git invocation runs with
`env: { ...process.env, LC_ALL: "C" }`** (`execGit`, `WorktreeManager.ts:44-71`).
This is the F7 fix, now baseline: several call sites below match git's stderr
(e.g. the literal `"invalid reference"`) to branch control flow, and under a
localized locale gettext would translate those strings and the match would
silently fail (issue #595). Forcing the C locale keeps git's messages English and
machine-stable. **The port must set `LC_ALL=C` on any git wrapper that branches
on stderr substrings.**

### Path & branch layout (load-bearing)

- Worktrees root: `<repoDir>/.sandcastle/worktrees/` (created `recursive`).
- For an explicit branch, `worktreeName = branch.replace(/\//g, "-")`. So
  `sandcastle/issue-5-add-foo` → dir `sandcastle-issue-5-add-foo`, full path
  `<repoDir>/.sandcastle/worktrees/sandcastle-issue-5-add-foo`.
- **`src/finalize.ts:283` (`worktreePathFor`) hard-codes this exact mapping.**
  The port must keep it identical, or update `finalize.ts` in lockstep.

### `create(repoDir, { branch, baseBranch })` (`WorktreeManager.ts`, `create`)

Sandbar always passes an explicit, already-existing `branch`:

1. `mkdir -p <worktreesDir>`.
2. `worktreeName = branch.replace(/\//g, "-")`, `worktreePath = join(...)`.
3. **Collision check** via `git worktree list --porcelain`: find an entry whose
   branch matches `branch`, else whose path matches `worktreePath`.
   - If found and **managed** (path under `worktreesDir`): reuse it. (ADR-0003:
     reuse-on-collision.) Returns `{ path: normalize(collision.path), branch }`.
     The reuse splits two ways:
     - **Dirty** (`hasUncommittedChanges`): reuse as-is with a `console.warn`, no
       refresh.
     - **Clean**: call `fastForwardFromOrigin(path, branch)` (F6, baseline) —
       `git fetch origin <branch>` then `git merge --ff-only origin/<branch>`, so a
       reused worktree isn't stale after origin moves. It **skips silently** (with
       an explanatory `console.log`) in three cases: (a) HEAD is **not** attached
       to `<branch>` — a mid-rebase worktree paused at an `edit`/`break` has a
       clean tree but detached HEAD, and `--ff-only` there would advance past the
       pause and break `rebase --continue`; (b) the fetch fails (no `origin`,
       offline, branch missing); (c) the branch has **diverged** (`--ff-only`
       refuses, preserving unpushed work). It **never** `reset --hard`s — that
       would destroy accumulated ralph-loop commits ([06 §D](./06-test-derived-gotchas.md)).
       Sandbar largely dodges all this (it pre-seeds via `ensureIssueBranch` and
       disposes the sandbox per cycle), so F6 is **optional** for the port — but
       if implemented, gate it exactly as above. Details:
       [07 §F6](./07-upstream-fixes-since-0.5.12.md).
   - If found but **unmanaged** (main working tree or external worktree): throw
     `Branch '<branch>' is already checked out in worktree at '<path>'...`.
4. No collision → `git -c branch.autoSetupMerge=false -c push.autoSetupRemote=false
   worktree add <worktreePath> <branch>`. The `-c` flags prevent a `.git/config`
   write that could race other processes on `.git/config.lock`.
   - If that fails with `invalid reference` (branch doesn't exist), retry with
     `... worktree add -b <branch> <worktreePath> <baseBranch ?? "HEAD">`.
     **Sandbar pre-creates the branch, so the first form succeeds and this fork
     path is not taken.** The `"invalid reference"` substring match is locale-safe
     here because `execGit` forces `LC_ALL=C` (see top of file, F7). The
     reimplementation notes below drop this fallback for sandbar's path anyway.
5. 30 s timeout (`WORKTREE_TIMEOUT_MS`).

> The `else` branch (no explicit `branch`) creates a temp
> `sandcastle/<timestamp>` branch — out of scope.

### `hasUncommittedChanges(worktreePath)`

`git status --porcelain`; true if trimmed output is non-empty
(unstaged, staged, or untracked).

### `remove(worktreePath)`

Derives `repoDir = join(worktreePath, "..", "..", "..")` (relies on the
`.sandcastle/worktrees/<name>` depth), then
`git worktree remove --force <worktreePath>`.

### `pruneStale(repoDir)` (`WorktreeManager.ts`, `pruneStale`)

1. `git worktree prune` (drops metadata for vanished worktrees).
2. Read entries under `.sandcastle/worktrees/` (missing dir → return).
3. `realPath` the worktrees dir (so symlinked repo roots still match git's
   canonicalised `git worktree list --porcelain` output).
4. For each entry dir not in the active-worktree set: `rm -rf`.
5. 30 s timeout. Called best-effort (`catchAll`) at `createSandbox` start.

> Sandbar additionally has its own preflight/orphan cleanup in
> `src/preflight.ts` and `src/containers.ts` — `pruneStale` is sandcastle's
> internal hygiene, complementary to (not a replacement for) sandbar's.

## copyToWorktree (`CopyToWorktree.js`)

`copyToWorktree(paths, hostRepoDir, worktreePath, timeoutMs?)`:

- COW flags by platform (`getCopyOnWriteFlags`): darwin → `["-cR"]` (APFS
  clonefile); else → `["-R", "--reflink=auto"]` (GNU coreutils reflink).
- For each `relativePath`: `src = join(hostRepoDir, relativePath)`. If `src`
  doesn't exist, **skip silently**. `dest = join(worktreePath, relativePath)`.
  Run `cp <cowFlags> <src> <dest>`; on error fall back to `cp -R <src> <dest>`;
  if the fallback also errors → `CopyToWorktreeError`.
- 60 s timeout (`COPY_TO_WORKTREE_TIMEOUT_MS`).

Sandbar passes `config.copyToWorktree` (host-relative anchor paths) here.

## Git mount resolution (`SandboxFactory.ts`, `resolveGitMounts`)

`resolveGitMounts(gitPath)` where `gitPath = <hostRepoDir>/.git`:

- If `.git` is a **directory** (normal repo): one mount
  `{ hostPath: gitPath, sandboxPath: gitPath }`.
- If `.git` is a **file** (worktree case — always, for sandbar): read it, match
  `^gitdir:\s*(.+)$`. The gitdir is like
  `<repo>/.git/worktrees/<name>`. Return **two** mounts: the `.git` file itself,
  and the parent `.git` directory (`resolve(gitdir, "..", "..")`). This lets the
  container resolve the worktree's `gitdir:` pointer back to the real object
  store.
- Unparseable → fall back to mounting the `.git` file as-is.

These mounts are appended after the worktree→`/home/agent/workspace` mount in
`startSandbox` (`startSandbox.ts`). On Linux, `normalizeMounts` and
`patchGitMountsForWindows` are no-ops (the latter is the entire ADR-0006 Windows
workaround — droppable for a Linux-only host).

## Mount formatting (`mountUtils.js`)

- `formatVolumeMount(mount, selinuxLabel)` → `host:sandbox[:ro][,z|Z]`. For
  sandbar: `host:sandbox:z`.
- `SANDBOX_REPO_DIR = "/home/agent/workspace"` (`SandboxFactory.ts`) — the
  mount point for the worktree inside the container.
- `defaultImageName(repoDir)` → `sandcastle:<sanitised-last-segment>`.
- `processFileMountParents` — only relevant for file mounts (sandbar has none).
- `resolveUserMounts` / `resolveSandboxPath` / tilde expansion — only for user
  `mounts` (sandbar passes none).

## Env resolution (`EnvResolver.js`, `mergeProviderEnv.js`)

`resolveEnv(repoDir)`:

1. Parse `<repoDir>/.sandcastle/.env` (`parseEnvFile`): skip blanks and `#`
   comments; split each line on the first `=`; strip matching single/double
   quotes; in double-quoted values, unescape `\n \r \t \\`.
2. For each key declared in that file, take its value, or fall back to
   `process.env[key]` if empty. Only declared keys are included. (Repo-root
   `.env` is **not** consulted.)

`mergeProviderEnv({ resolvedEnv, agentProviderEnv, sandboxProviderEnv })`:
returns `{ ...resolvedEnv, ...sandboxProviderEnv, ...agentProviderEnv }`. Throws
if agent and sandbox provider env share keys. For sandbar both provider envs are
`{}`, so the effective env is just `resolvedEnv` (the parsed `.sandcastle/.env`),
later augmented with `HOME=/home/agent` by the podman provider.

> Sandbar issue #5 notes that `envFilePath` config is currently decorative —
> env never reaches the container. That bug lives at sandbar's boundary
> (how/whether it writes `.sandcastle/.env`), and is orthogonal to this port,
> but the in-house module should keep the same `.sandcastle/.env` contract so a
> fix for #5 lands in one place.

## Reimplementation notes

- `WorktreeManager.create` collapses, for sandbar, to: mkdir, collision-reuse
  check, `git -c ... worktree add <path> <branch>`. The `-b` fork fallback and
  temp-branch mode can be dropped (sandbar always pre-creates the branch).
- Keep `pruneStale` (or rely on sandbar's existing cleanup — but `pruneStale`
  runs *inside* createSandbox before `worktree add`, which is what prevents a
  stale dir from blocking the add; if dropped, ensure sandbar's preflight covers
  the same window).
- Keep the `.sandcastle/worktrees/<branch-dashed>` layout and `SANDBOX_REPO_DIR`
  constant exactly.
- The two-mount git resolution for worktrees is essential — without the parent
  `.git` dir mount, git inside the container can't resolve objects and every
  command fails. Don't simplify it to a single `.git` mount.
- `getCopyOnWriteFlags` / Windows mount patching can be reduced to the Linux
  path (`-R --reflink=auto`, no-op normalize) if the host is Linux-only — which
  it is (`RUNTIME = "podman"`, WSL2/Linux per the repo).
