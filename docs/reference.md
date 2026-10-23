# Sandbar manual

How to configure and run sandbar. For what it does, see the [README](../README.md).

- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Running](#running)
- [The issue loop](#the-issue-loop)
- [Images](#images)
- [Gate stack](#gate-stack)
- [`sandbar gate`](#sandbar-gate)
- [Releasing](#releasing)
- [Design principles](#design-principles)

## Quick start

```sh
npm i -D sandbar
cp node_modules/sandbar/sandbar.config.example.mjs sandbar.config.mjs
cp node_modules/sandbar/sandbar.env.example sandbar.env
echo -e "sandbar.config.mjs\nsandbar.env\n.sandbar/" >> .gitignore
# fill in the required fields and GH_TOKEN, then:
npx sandbar
```

`npx sandbar` imports `./sandbar.config.mjs`; `--config <path>` names another
file. Sandbar never searches parent directories. `cwd` defaults to the
directory of the config file, not the one you launched from.

The bin is thin: `import { run } from "sandbar"` and `run(config)` does the
same thing.

### What the host repo supplies

- The required config fields below.
- A `Containerfile` for the sandbox image, or whatever `images` names.
- `GH_TOKEN` and a credential for every agent provider you route to, in
  `config.env`.
- Anchor docs: `CLAUDE.md`, and optionally `CONTEXT.md` and an ADR directory.
- Optionally, files named by `{ path }` entries in `promptExtensions`.

### What sandbar keeps on disk

```
your-repo/
  sandbar.config.mjs   gitignored
  sandbar.env          gitignored
  .sandbar/            gitignored, disposable
    repo.git/            bare object cache
    worktrees/           source/, issue-<n>-<slug>/, merger/
    run.lock  run.pid  logs/
```

Nothing in `.sandbar/` is authoritative, so deleting it costs time, not
work. **Don't delete it while a run is in flight**: the lock lives there.

Sandbar never writes to your checkout. It reads only your git identity, your
`copyToWorktree` sources and your `origin` URL.

## Configuration

The config file is an ES module whose default export is the `RunConfig`. It is
a program, so computed values are fine. List only what differs from the
defaults.

### Required fields

| Field | Meaning |
| --- | --- |
| `ghOwner`, `ghRepo` | The GitHub repository. Must match `origin`. |
| `developers` | Logins whose `ready-for-agent` label is honored (plus the token's own login), or `"anyone"`. |
| `sandboxImage` | Image the implementer and resolve agents run in. |
| `botName`, `botEmail` | Commit author. |
| `sandboxHooks` | Per-sandbox setup commands, e.g. `onWorktreeReady: npm ci`. |
| `gateStack` | Containers and steps that decide whether a commit is green. See [Gate stack](#gate-stack). |

### Optional fields

| Field | Default | Meaning |
| --- | --- | --- |
| `cwd` | config file's directory | Repository to work on. |
| `workDir` | `.sandbar` | State directory inside `cwd`. |
| `sourceBranch` | `main` | Branch issues seed from and land on. |
| `uiPort` | `7331` | Port of the run UI. Use one per workdir. |
| `images` | sandbox image from `./Containerfile` | See [Images](#images). |
| `defaultLane` | `auto` | `auto` lands after the gate; `review` lands on a chunk branch with a draft PR. |
| `mergeMode` | `{ kind: "direct" }` | `{ kind: "verified", requiredChecks: [...] }` also waits for forge CI. |
| `maxParallelIssues` | `3` | Issues worked at once. |
| `maxConcurrentGates` | unlimited | Gate runs at once. |
| `pollIntervalMs` | `60000` | Idle poll interval. |
| `keepAwakeWhileIdle` | `false` | Hold the wake lock while idle too. |
| `partitionCheck` | `true` | Ask whether an issue is too big before starting it. |
| `uiPrototypeCheck` | `true` | Ask whether an issue needs a UI prototype first. |
| `maxContextChars` | `600000` | Context budget per role (prompt plus diff). |
| `maxQualityRounds` | `3` | See [Budgets](#budgets). |
| `maxGateRounds` | `4` | See [Budgets](#budgets). |
| `maxReviewRounds` | `4` | See [Budgets](#budgets). |
| `labels` | `needs-info`, `agent-stuck` | Rename the tracker labels. |
| `copyToWorktree` | `[]` | Host-only files copied into each issue worktree. |
| `claudeMdPath`, `contextMdPath`, `adrDir` | `CLAUDE.md`, `CONTEXT.md`, `docs/adr` | Anchor docs. |
| `promptExtensions` | `{}` | Per-role `{ text }` or `{ path }` additions. |
| `coauthorTrailer` | from bot name/email | `Co-authored-by` line. |
| `requiresSandbar` | none | Oldest driver version this config needs. |

`ready-for-agent`, `auto-land` and `land` are fixed label names. `land` must
exist in the repo; sandbar never creates it.

### Credentials and role routing

`sandbar.env` holds two kinds of keys. `splitRoleRouting` separates them:

```js
import { readEnvFile, splitRoleRouting } from "sandbar";
const { routing, env } = splitRoleRouting(
  readEnvFile(new URL("sandbar.env", import.meta.url)),
);
export default { /* ... */ env, ...routing };
```

- **Credentials** (`GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` or
  `ANTHROPIC_API_KEY`, ...) go into `env` and are the only host variables that
  reach agent containers. An empty value inherits from the launching shell.
- **Routing** keys `SANDBAR_<ROLE>_AGENT`, `_MODEL_ID` and `_EFFORT` choose the
  agent CLI, model and effort per role. Roles: `IMPLEMENTER`, `UI_CHECK`,
  `REVIEWER`, `REVIEWER_QUALITY`, `ADJUDICATOR`, `MERGER`. They never enter a
  sandbox. Defaults are claude, `opus`, no effort flag.

[`sandbar.env.example`](../sandbar.env.example) lists every key.

### Example config

```js
export default {
  ghOwner: "your-org",
  ghRepo: "your-repo",
  developers: ["your-github-login"],
  sandboxImage: "localhost/your-repo-sandbar:latest",
  botName: "your-bot",
  botEmail: "bot@your-org.dev",
  sandboxHooks: {},
  gateStack: {
    containers: [
      {
        name: "db",
        image: "docker.io/library/mariadb:10.11",
        lifecycle: "issue",
        env: { MYSQL_ALLOW_EMPTY_PASSWORD: "yes", MYSQL_DATABASE: "app" },
        readiness: {
          kind: "healthcheck",
          command: ["healthcheck.sh", "--connect", "--innodb_initialized"],
        },
        readinessTimeoutMs: 120_000,
      },
      {
        name: "runner",
        image: "localhost/your-repo-sandbar:latest",
        mountWorktree: "/workspace",
        hold: true,
      },
    ],
    steps: [
      { name: "check", in: "runner", command: ["npm", "run", "check"] },
      { name: "test", in: "runner", command: ["npm", "test"] },
      { name: "e2e", in: "runner", command: ["npx", "playwright", "test"], timeoutMs: 1_800_000 },
    ],
  },
  env,
  ...routing,
};
```

## Running

### Local

```sh
npx sandbar
```

Sandbar runs as a daemon. It keeps `maxParallelIssues` issues in flight,
replans when a slot frees up, and polls every `pollIntervalMs` when the queue
is empty. Stop it with a signal; restart it to reload the config.

### Exit codes

| Code | Name | Cause |
| --- | --- | --- |
| 75 | restart | A deploy asked it to step aside. A supervisor should restart it. |
| 4 | quota / credential | A provider closed for this process. |
| 3 | storage | Podman storage stayed below its free-space floor. |
| 2 | stuck | Six issues in a row finished without anything landing. |
| 1 | halted | Lost the origin lock, or a fault it can't continue past. |

Before exiting with 2, 3 or 4 sandbar lands committed work and lets running
issues finish. A GitHub rate limit pauses planning; it doesn't exit.

### Restart requests

Writing a `restart-requested` file beside the config file makes a running
daemon stop taking new issues, land what is committed, and exit 75 once idle.

### Unattended hosts

[`deploy/ansible/`](../deploy/ansible/README.md) sets up a dedicated Linux box:
one user, consumer clone, rootless podman and systemd unit per project. The
consumer repo needs no sandbar dependency; config and credentials live in a
private installation directory on the host.

## The issue loop

### Pre-checks

Before the first attempt, two read-only agents classify the issue:

- **Partition check** (`partitionCheck`): if the issue won't fit
  `maxContextChars`, it parks as `NEEDS-PARTITION` under `needs-info` and asks
  for a `## Blocked by` chain.
- **UI check** (`uiPrototypeCheck`): if the issue needs a UI prototype first,
  it parks for a human.

`maxContextChars` is checked again before each review, against the prompt plus
the branch's diff.

### Rounds

Each round after the implementer reports done:

1. **Quality review.** A read-only violations lister checks tests and coding
   standards. If it finds violations, a fixer commits fixes and a read-only
   verify checks them. The fixer can dispute the list; an adjudicator rules.
2. **Automatic tests** (gate-1): the gate stack, run once on the result.
3. **Correctness review**, only if the tests are green. The implementer can
   dispute a rejection; an adjudicator rules.

Red tests and rejections go back to the implementer. Quality findings never
do. The implementer doesn't see the coding standards; the quality roles do.

Role routing: the quality roles use `reviewerQuality*` and
`promptExtensions.reviewerQuality`; the adjudicator defaults to the
correctness reviewer's routing.

### Budgets

| Budget | Counts | Resets | When spent |
| --- | --- | --- | --- |
| `maxQualityRounds` | verify rejections, upheld quality disputes | each quality review | goes on to the tests; open items are logged |
| `maxGateRounds` | red tests, and attempts with no usable commit (no signal, dirty tree, off-branch HEAD) | on green tests | issue parks as stuck |
| `maxReviewRounds` | correctness rejections | — | issue parks as stuck |

A reviewer that crashes spends no budget. A second crash in one issue stops it.

## Images

### Defaults

Sandbar builds `sandboxImage` from `./Containerfile` and adds a layer with a
uid-1000 `agent` user, git, and the agent CLIs the config routes to. Don't
install `claude-code` or `codex` yourself.

The base image needs `/bin/sh`, CA certificates, and git or a package manager
(apt, apk or dnf). Gate containers use the image without the agent layer.

### More than one image

```js
images: [
  { tag: "localhost/app-sandbar:latest", containerfile: "Containerfile" },
  { tag: "localhost/app-dev:latest", containerfile: "Dockerfile", target: "dev" },
  { tag: "localhost/app-prod:latest", containerfile: "docker/Dockerfile", context: "." },
  { tag: "localhost/app-php:gate", containerfile: "gate/Containerfile.php", stdinContext: true },
  { tag: "localhost/app-runner:gate", containerfile: "gate/Containerfile.runner",
    buildArgs: { AGENT_UID: String(process.getuid?.() ?? 0) } },
]
```

| Key | Meaning |
| --- | --- |
| `tag` | Image name. Skipped if it already exists (unless `rebuildOn` says otherwise). |
| `containerfile` | Path to the Containerfile. |
| `context` | Build context, repo-relative. Defaults to the Containerfile's directory. |
| `target` | Multi-stage build target. |
| `stdinContext` | Build with no context. |
| `buildArgs` | Passed through as-is. |
| `rebuildOn` | Files the image is built from. See below. |
| `buildTimeoutMs` | Default 45 minutes. |

The list must include `sandboxImage`. Any other image the stack uses must
already be pulled; preflight prints the `podman pull` command if it isn't.

### `rebuildOn`

Use `rebuildOn` when an image bakes in dependencies, so that a branch that
changes the lockfile is tested against its own dependencies:

```js
{ tag: "localhost/app-runner:gate", containerfile: "docker/Dockerfile",
  context: ".", target: "dev", rebuildOn: ["package-lock.json"] }
```

Sandbar hashes the listed files, the Containerfile, `buildArgs`, `target` and
`context`, and rebuilds when the hash changes:

| Where | When it's checked |
| --- | --- |
| Gate images | Before every gate run, including after a merge. A changed branch gets its own tag. |
| `sandboxImage` | Once per sandbox, before the agent starts. |

A gate image that won't build from the branch fails the tests, with the build
output. A sandbox image that won't build falls back to the declared tag and
logs a warning.

Rules:

- Paths are repo-relative and must exist and sit inside the build context.
- Not allowed with `stdinContext` or an absolute `containerfile`.
- The image must be one something runs (a gate container or `sandboxImage`).
- `.dockerignore` isn't read; don't exclude a declared input.

## Gate stack

All containers join one podman pod, reach each other on `127.0.0.1`, and
publish no ports. Steps run in order and stop at the first failure.

### Containers

| Key | Meaning |
| --- | --- |
| `name` | Container name; steps refer to it. |
| `image` | Fully qualified image. |
| `lifecycle` | `attempt` (default): recreated every gate run. `issue`: started once per issue and reused. |
| `env`, `args` | Container environment and command arguments. |
| `mountWorktree` | Mount the worktree read-write at this path; also the working directory. |
| `mounts` | Extra mounts; `hostPath` is relative to the worktree, read-only unless `mode: "rw"`. |
| `hold` | Run `sleep infinity` instead of the entrypoint. |
| `readiness` | `{ kind: "healthcheck", command: [...] }`, run inside the container. |
| `readinessTimeoutMs` | Default `60000`. |
| `postReadyCommands` | One-shot setup run after readiness. |
| `servesWorktree` | See rules below. |
| `inSandbox` | Also run a copy beside the agent. See below. |

### Steps

| Key | Meaning |
| --- | --- |
| `name` | Step name in logs. |
| `in` | Container to `podman exec` in. |
| `command` | Argv. Exit 0 is green. |
| `timeoutMs` | Default `900000` (15 min). A timeout fails the step. |

### Readiness

The command is registered as a podman healthcheck and polled by sandbar until
it succeeds or `readinessTimeoutMs` passes. On `issue` containers it is
checked again before every gate run, so a wedged service is treated as an
infrastructure problem rather than a red test. `tcp`, `log` and `exec` kinds
are no longer accepted; write an in-container probe instead.

### Rules

- **Worktree-mounting images run as root or as your uid.** Otherwise writes to
  the worktree fail. Preflight checks this.
- **At least one stepped-into container mounts the worktree.** Otherwise every
  commit gets the same verdict. If your stack serves the app from one container
  and tests it from another, mark the app container `servesWorktree: true`.
- **Steps write only to gitignored paths.** The gate refuses a dirty tree; a
  step that leaves files behind makes the issue park as `NEEDS-HUMAN`.
- **A container that boots the worktree's code can't be `lifecycle: "issue"`**
  unless it uses `hold`. Use `mounts` if it only needs fixture files.
- After a merge, sandbar runs `npm install` and commits any lockfile change
  before testing the merge.

### `inSandbox`

`inSandbox: true` runs a second copy of a gate container beside the agent, so
the agent can run the app while it works:

```js
{ name: "db", image: "docker.io/library/mariadb:10.11", lifecycle: "issue",
  readiness: { kind: "healthcheck", command: ["healthcheck.sh", "--connect"] },
  inSandbox: true }
```

- The agent reaches it on `127.0.0.1`, as the gate steps do. Name the ports in
  your anchor docs.
- It is separate from the gate's copy; the gate's result is what counts.
- It is started once per sandbox and never restarted.
- `onSandboxReady` hooks run after it is up; use them for migrations or
  fixtures.
- Its log is at `/sandbar/logs/<name>.log` in the sandbox.
- An `attempt` container that fails to start is reported to the agent; an
  `issue` container that fails retries the issue.
- Cost: one extra container per `inSandbox` entry per active issue.

## `sandbar gate`

Runs the gate stack on its own: no tracker, agents or lock. Use it locally or
in CI.

```sh
npx sandbar gate                      # gate the current directory
npx sandbar gate --worktree ../other  # gate another tree
npx sandbar gate --keep               # leave the stack up
```

| Exit | Meaning |
| --- | --- |
| 0 | Green. |
| 1 | Red, including an image that won't build from the tree. |
| 2 | No verdict: config error, missing pulled image, podman unreachable, or an `issue` container that never became ready. |

Differences from the gate inside a run:

- It tests the working tree even if it is dirty, and says so.
- Steps stream to the terminal.
- `--keep` leaves the stack up, and the next run on the same tree reuses its
  `issue` containers unless their config, the tree or sandbar's version
  changed. Remove it with the `podman pod rm -f` line it prints.
- It builds only images a gate container runs, and doesn't run `sandboxHooks`.
  In CI, install dependencies first.
- Don't run two at once on the same tree.

From code:

```js
import { runGateCommand } from "sandbar";
process.exitCode = await runGateCommand(config, { worktree: ".", keep: false });
```

It returns the exit code (`GATE_EXIT_GREEN`, `GATE_EXIT_RED`,
`GATE_EXIT_NO_VERDICT`) instead of throwing. Set `process.exitCode` rather than
calling `process.exit()`, or piped step output gets cut off.

## Releasing

Consumers pin to `vX.Y.Z` tags. Every commit bumps the version (see
[AGENTS.md](../AGENTS.md)). On every push to `main`,
`.github/workflows/auto-tag.yml` creates the matching tag if it is missing.

## Design principles

From #131.

- Separate planning from implementation, and review the plan, not just the
  diff.
- Give the agent a deterministic check it can run.
- Treat the context window as the main resource: fresh sessions per task,
  subagents for exploration.
- Keep instruction files short and point into docs.
- Isolate work in worktrees, and review with a fresh context.
- Run long loops with an external stop condition.
