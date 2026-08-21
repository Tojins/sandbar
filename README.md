# sandbar

Issue-tracker-driven coding agent orchestrator. Plans unblocked issues, runs an inner-loop implementer (and reviewer) per issue inside an isolated sandbox, gates with the project's own **gate stack** — the containers and steps that produce a verdict about a commit — and merges DONE branches into the source branch.

## Releasing

Consumers pin to a `vX.Y.Z` tag, so every version bump **must** be tagged. Don't bump `package.json` by hand — run:

```sh
npm version minor   # or patch / major
```

This is wired (see `package.json` scripts + `.npmrc`) to atomically: gate (`preversion`: check + test) → bump `package.json`/lockfile → commit `chore: bump version to X.Y.Z` → create the lightweight `vX.Y.Z` tag → push commit **and** tag (`postversion`). No separate tag step to forget.

If a version ever lands untagged anyway (e.g. hand-edited inside a feature commit), the `.github/workflows/auto-tag.yml` CI job is a backstop: on every push to `main` it creates the missing `vX.Y.Z` tag from `package.json`.

## Usage

Sandbar ships a `sandbar` bin. Put one `sandbar.config.mjs` at the root of the
repo you want worked on, gitignore `.sandbar/`, and run it:

```sh
npm i -D @offergeist/sandbar
npx sandbar                     # or: sandbar --config path/to/sandbar.config.mjs
```

The config file is an ES module whose **default export** is the `RunConfig`
object — a program, not data, so a computed image tag or a gate stack read from
JSON is fine. Sandbar imports `./sandbar.config.mjs` from the current directory
unless `--config` says otherwise, and **never searches parent directories**.
`--config` is the only flag that carries configuration; everything else lives in
the file.

`cwd` defaults to the directory holding the resolved config file, not to the
directory you launched from. That is the whole point of the bin: there is
nowhere to run it from that operates on the wrong repo.

`run(config)` remains the API — the bin is thin, and a host that wants to embed
sandbar can still `import { run } from "@offergeist/sandbar"` and call it.

### `sandbar gate` — the gate stack on its own

```sh
npx sandbar gate                      # gate the current directory
npx sandbar gate --worktree ../other  # …or some other tree
npx sandbar gate --keep               # leave the stack up to poke at
```

Brings up `gateStack`, runs its steps in order, stops at the first red, and
exits **0** green, **1** red, **2** if it could not reach a verdict at all. No
tracker, no agents, no worktrees, no lock — so it runs on a laptop, in CI, and
beside a live `sandbar` run on the same machine.

**2 is narrower than it sounds, and the difference matters if you branch on it
in CI.** A build that fails or a container that will not start is usually your
branch's doing and is a **red**: any image sandbar builds for this stack is
built from the tree being gated, so a lockfile that won't install fails the gate
as `image:<tag>` — whether the tag was missing entirely or `rebuildOn` sent it
to a per-branch variant — and an `attempt`-lifecycle container that won't come
up fails it as `container:<name>`. 2 is for the cases that are not about the code at all —
a config error, an image sandbar doesn't build that you haven't pulled, a
podman it can't talk to, an `issue`-lifecycle container (your database, your
mail catcher) that never becomes ready. Your `scripts/gate.sh`
becomes this line, and readiness, step timeouts, teardown and log capture stop
having a second implementation that drifts.

Three differences from the gate inside a run, all of them because the standalone
one has no commit to be a verdict about and no orchestrator to report to:

- **It gates the working tree, dirty or not**, and says so when it is dirty.
  Inside a run the gate refuses an uncommitted tree, because a green there
  would certify something the merger cannot land; here you are asking about the
  tree in front of you.
- **Steps stream as they run.** Inside a run they are captured for a trace
  nobody is watching live.
- **`--keep` leaves the stack up**, and the next `sandbar gate` over the same
  worktree then **reuses its `lifecycle: "issue"` containers** — the database
  keeps its schema and its rows, and its `postReadyCommands` are not re-run.
  That reuse is checked, not assumed: change any of those containers' config
  (image, env, args, mounts, readiness, `postReadyCommands`, name), the
  worktree, or sandbar's version, and the stack is rebuilt instead. A stack
  whose bringup never finished is torn down despite the flag, and says so —
  keeping it would let the next invocation adopt a database whose
  `postReadyCommands` never ran and then decline to re-run them. Remove a kept
  stack with the `podman pod rm -f …` line the command prints.

It builds only the `config.images` entries a `gateStack` container actually
runs. Your agent sandbox image is never built here — this command creates no
sandbox, so building it would cost a cold CI checkout the whole agent image
before the first gate container started, and let its build failure decide a
gate it has nothing to do with.

It does **not** run `sandboxHooks`. `onWorktreeReady` (your `npm ci`, typically)
fires when *sandbar* creates a worktree; here the tree is yours and already
exists, and reinstalling dependencies in your checkout on every invocation would
be a surprise. A CI job starting from a bare checkout runs its own install line
before `npx sandbar gate`.

Two `sandbar gate` invocations over the **same** worktree collide — they share
one set of podman names, which is what makes the reuse possible — so don't run
two at once against one tree. Different worktrees, and a `sandbar` run on the
same host, are disjoint by construction.

`runGateCommand(config, { worktree, keep })` is the API, and it **returns** that
exit code rather than throwing — including the 2, which is the whole reason
`GATE_EXIT_GREEN`/`GATE_EXIT_RED`/`GATE_EXIT_NO_VERDICT` are exported beside it.

```js
process.exitCode = await runGateCommand(config, { worktree: ".", keep: false });
```

That is the bin, near enough — and **set the code rather than calling
`process.exit(code)`**, which is not a style preference: the steps stream
through `process.stdout.write`, and to a pipe (a CI log, a `| tee`) those writes
are asynchronous, so exiting on the spot truncates the failing step's output —
the diagnosis the exit code is about, lost only on red. Setting the code and
letting node drain cannot. Faults are rendered to stderr on the way out; pass
`out` and `err` sinks to put them somewhere else.

`RunConfig` is **deviations-only**. Supply the repo-specific facts sandbar can't guess (required) plus only the knobs you want different from the defaults. Everything else falls through — don't restate a default.

```js
// sandbar.config.mjs
import { readEnvFile } from "@offergeist/sandbar";

export default {
  // Required — no sensible default exists:
  ghOwner: "your-org",
  ghRepo: "your-repo",
  // The image the AGENT runs in (claude + your toolchain). Built from
  // ./Containerfile unless you override `images` below.
  sandboxImage: "localhost/your-repo-sandbar:latest",
  botName: "your-bot",
  botEmail: "bot@your-org.dev",
  sandboxHooks: { /* per-sandbox build/setup commands */ },

  // What it takes to produce a verdict about a commit. Every container joins
  // one podman pod, so the stack addresses itself as 127.0.0.1 and publishes
  // no fixed ports — a gate run can't collide with your dev stack or another
  // issue's.
  gateStack: {
    containers: [
      {
        name: "db",
        image: "docker.io/library/mariadb:10.11",  // must be fully qualified
        lifecycle: "issue",                        // started once per issue
        env: { MYSQL_ALLOW_EMPTY_PASSWORD: "yes", MYSQL_DATABASE: "app" },
        // Argv podman runs INSIDE the container until it exits 0. Sandbar
        // registers it with `--health-cmd` and polls it on demand, so there
        // is nothing to publish and nothing scheduled.
        readiness: {
          kind: "healthcheck",
          command: ["healthcheck.sh", "--connect", "--innodb_initialized"],
        },
        readinessTimeoutMs: 120_000,               // default 60_000
        // Optional: args (image CMD args), mounts (fixture files, hostPath
        // relative to the GATED WORKTREE, read-only unless the entry says
        // `mode: "rw"`), postReadyCommands (one-shot setup exec'd after
        // readiness). Add `inSandbox: true` to also run this container beside
        // the AGENT, so it can exercise the app before the gate does — see
        // below.
      },
      {
        name: "runner",
        image: "localhost/your-repo-sandbar:latest",
        // Default lifecycle "attempt": recreated every gate run, because it
        // mounts the worktree and runs the branch's code.
        mountWorktree: "/workspace",  // rw; also the working directory
        hold: true,                   // no long-running process of its own
      },
    ],
    steps: [
      // Run in order, stopping at the first red. Each is `podman exec`'d in
      // the named container; its exit code is the verdict. The db is reachable
      // at 127.0.0.1:3306 — one namespace, so the address is knowable here.
      //
      // Every step is time-bounded (default 15 min). Exceeding the bound kills
      // the step, removes the container the work was running in, and reds the
      // gate with a trace naming the step — a hung suite spends an attempt and
      // moves instead of hanging the run and holding the lock forever.
      { name: "check", in: "runner", command: ["npm", "run", "check"] },
      { name: "test", in: "runner", command: ["npm", "test"] },
      { name: "e2e", in: "runner", command: ["npx", "playwright", "test"],
        timeoutMs: 1_800_000 },  // default 900_000
    ],
  },

  // Credentials: a VALUE, not a path. Only the keys declared here cross into a
  // sandbox container, each falling back to `process.env[key]` when the value
  // is empty — so `GH_TOKEN: ""` means "inherit it", and CI needs no file.
  // `readEnvFile` is a convenience; where the file lives (and whether there is
  // one) is entirely yours.
  env: readEnvFile(new URL("sandbar.env", import.meta.url)),

  // Everything else is OPTIONAL — see the tables below for the defaults.
  // Omit any line you're happy with.
};
```

### What sandbar puts in your repo

```
your-repo/
  sandbar.config.mjs   <- committed; the whole host-side surface
  sandbar.env          <- gitignored, if you use a file at all
  .sandbar/            <- gitignored; node_modules-shaped, `rm -rf` at will
    repo.git/            bare object cache; re-created if you delete it
    worktrees/           source/ (image build context), issue-<n>-<slug>/, merger/
    run.lock  run.pid  logs/
```

Nothing in `.sandbar/` is authoritative: the tracker is GitHub Issues, branches
are pushed at finalise, merged work is on `origin/<sourceBranch>`. Deleting it
costs agent time, never correctness. **Do not clean it while a run is in
flight** — the single-instance lock lives there, and removing it lets a second
run collide with the first.

Sandbar never writes to your checkout. Every git and `gh` call — including
`git branch -D` and the worktree removals — runs in `.sandbar/repo.git`, which
holds only sandbar's own refs. What it *reads* from your checkout is your git
identity, your `copyToWorktree` sources, and the URL of your `origin` (which is
why no config names the remote: it cannot drift from the repo the config file
sits in).

### Required fields

| Field | Why it can't default |
| --- | --- |
| `ghOwner`, `ghRepo` | Repo identity. Every `gh` call names this repository, so it — not `cwd`'s `origin` — decides which tracker sandbar reads and writes. Each must be a single GitHub name (no slashes). Preflight refuses to start if it disagrees with `origin`. |
| `sandboxImage` | The image the agent (and the merger's resolve agent) runs in. |
| `botName`, `botEmail` | Commit/author identity. |
| `sandboxHooks` | Host-specific build/setup. |
| `gateStack` | The containers and steps that produce a verdict. What it takes to test this repo is repo identity — sandbar ships no preset. |

### Optional fields and their defaults

| Field | Default |
| --- | --- |
| `cwd` | the config file's directory (bin), or `process.cwd()` (API) |
| `workDir` | `.sandbar` |
| `sourceBranch` | `main` |
| `images` | `[{ tag: sandboxImage, containerfile: "Containerfile" }]` — see below |
| `implementerModelId` | `opus` |
| `reviewerModelId` | `opus` |
| `mergerModelId` | `opus` |
| `coauthorTrailer` | `Co-authored-by: <botName> <<botEmail>>` |
| `claudeMdPath` | `CLAUDE.md` |
| `contextMdPath` | `CONTEXT.md` (referenced only if the file exists) |
| `adrDir` | `docs/adr` (referenced only if the dir exists) |
| `env` | `{}` |
| `copyToWorktree` | `[]` |
| `maxImplAttempts` | `8` |
| `maxReviewRounds` | `5` |
| `maxTotalIssues` | `50` |
| `labels` | `{ needsInfo: "needs-info", agentStuck: "agent-stuck" }` (override any subset) |
| `mergeMode` | `{ kind: "direct" }` — see below |
| `codingStandardsPath` | *(unset)* — no conventional path; see below |

`cwd` is resolved to an absolute path, and it must be a checkout of
`ghOwner`/`ghRepo`, with an `origin` remote — sandbar pushes branches and merges
to that `origin` while reading and writing issues in the configured repo, so
preflight compares the two and refuses the run when they name different
repositories. It also compares the **host**: `gh` is given `--repo
<owner>/<name>`, which uses gh's default host, so an `origin` on a GitHub
Enterprise instance needs `GH_HOST` set in sandbar's environment and is refused
without it. A remote sandbar cannot read an `<owner>/<repo>` out of — a local
mirror path, say — is reported as a warning rather than refused, since guessing
at it would reject working setups. The paths above are not all interpreted in the same
place, so:

- `claudeMdPath`, `contextMdPath`, `adrDir` and `codingStandardsPath` stay
  relative in the prompt, because the agent resolves them from the repo root
  inside its own sandbox — i.e. against the **issue worktree**. Sandbar's
  host-side "does this file exist" check is rooted at that same worktree, so a
  doc the branch itself adds is referenced from the attempt that adds it, and
  the reviewer of a commit that introduces a `CODING_STANDARDS.md` is pointed
  at it.
- `copyToWorktree` entries resolve against `cwd`, your own checkout, because
  the cache is bare and has nothing to copy. That is the feature's intent
  (host-only files that are not in git), but it does make issue-worktree
  content a function of your uncommitted state; point at absolute paths outside
  the checkout if you want it stable.
- `gateStack` mount `hostPath`s resolve against the issue worktree, not `cwd`.

### `mergeMode` — who gets to say the merge result is good

`direct` (the default) is what sandbar has always done: merge locally, run the
post-merge gate locally, `git push origin HEAD:<sourceBranch>`. Nothing on the
forge ever sees the result.

Switch to `verified` when anything downstream of the source branch trusts it
without re-checking — typically a deploy workflow on `push: branches: [main]`.
A direct push matches neither `pull_request` nor `push: branches-ignore:
[main]`, so CI silently never runs and the deploy ships an unverified sha.

```ts
mergeMode: {
  kind: "verified",
  requiredChecks: ["tests"],                // REQUIRED, non-empty — see below
  integrationBranch: "sandbar/integration", // default; must start with `sandbar/`
  checkTimeoutMs: 20 * 60_000,              // default
  pollIntervalMs: 15_000,                   // default
  noChecksGraceMs: 120_000,                 // default
  openPullRequest: false,                   // default
}
```

Per cycle, once the local merges + gate are green, sandbar force-pushes the
merge result to `integrationBranch`, polls that sha's check runs, and only a
green verdict earns the fast-forward onto `sourceBranch`. A red forge goes to
the resolve loop with the failing jobs' logs; checks that never conclude park
the cycle. Sandbar never lands on an unknown verdict — including a check that
nobody named and that hasn't finished yet, which holds the verdict up exactly
like a required one. Cost is one CI run per cycle when it passes first time and
at most three otherwise (a re-merge after `sourceBranch` moves spends a round
too, with no agent involved) — not one per implementer attempt.

**`requiredChecks` is mandatory.** Name the check runs (as the forge reports
them) that must exist *and* pass. It is the floor, not a filter: a check you
did not name still sinks the cycle if it fails. Without it, sandbar cannot tell
a check that hasn't started from one that will never run — which is exactly the
mis-triggered-workflow case verified mode exists to catch — so resolving the
config fails rather than quietly weakening to "nothing was failing when I
looked".

Some failures are deliberately **fatal** rather than parked, because they are
properties of the repo rather than of the code under test, and would otherwise
recur every cycle while converting the backlog into `agent-stuck`:

- the forge reporting no checks at all for the pushed sha (widen
  `noChecksGraceMs` if your forge is merely slow to create runs);
- a name in `requiredChecks` that never appears while every other check on the
  sha concludes — almost always a name that doesn't match what the forge
  publishes, e.g. `test` where the job reports as `test (20.x)`, or the
  workflow's name rather than the job's;
- a rejected push to the integration branch;
- a fast-forward the forge refuses when `sourceBranch` turns out not to have
  moved (branch protection, a pre-receive hook, or a token without push
  access);
- an unreachable or unreadable forge across several consecutive polls.

All of them halt the run loudly, after finalising the tracker state already
applied in that cycle. If `sourceBranch` genuinely moves during the CI wait, the
new tip is merged in and the result is re-verified — a green verdict is never
carried over to a result the forge has not seen.

`integrationBranch` must start with `sandbar/`. It is a scratch ref, force-pushed
on every verification round, so it has to live in a namespace sandbar owns —
pointing it at a branch anyone else uses would destroy that branch on the first
cycle. Sandbar never deletes it; it simply gets overwritten each cycle. The other
values are validated at startup too: every `*Ms` knob must be positive and
finite, `pollIntervalMs` may not exceed `checkTimeoutMs`, and `noChecksGraceMs`
must be less than it (otherwise the timeout always fires first and the no-checks
halt becomes unreachable).

`openPullRequest: true` adds a pull request — head `integrationBranch`, base
`sourceBranch` — as a review/audit handle. Landing is a fast-forward push either way, so commit
attribution is identical with it on or off; the forge marks the PR merged once
its commits become ancestors of the base. Note that a repo whose CI triggers on
both `pull_request` and `push` will run the suite twice per round with this on.

The point of `verified` is **independence, not coverage**: CI is a second,
differently-authored implementation of "does this work", which is the one thing
expanding the local gate can never buy. Coverage gaps should still be closed in
`gateStack.steps` — that is cheaper and faster than a CI round-trip.

### `images` — what sandbar builds

By default sandbar builds one image: `sandboxImage`, from `./Containerfile`.
List `images` explicitly when the stack needs more than one:

```ts
images: [
  { tag: "localhost/your-repo-sandbar:latest", containerfile: "Containerfile" },
  // No build context at all — right for a Containerfile that only pulls from a
  // registry and installs packages; tarring the repo up for it is pure latency.
  { tag: "localhost/app-php:gate", containerfile: "gate/Containerfile.php", stdinContext: true },
  // buildArgs are passed through verbatim; sandbar injects no magic ARG name.
  { tag: "localhost/app-runner:gate", containerfile: "gate/Containerfile.runner",
    buildArgs: { AGENT_UID: String(process.getuid?.() ?? 0) } },
]
```

An entry is skipped when its tag already exists, so warm runs pay one
`image exists` per entry. The list must include `sandboxImage`. Every *other*
image the stack references must already be pulled — preflight refuses with the
exact `podman pull` command rather than pulling it, so no run does silent
network work at startup.

### `rebuildOn` — images that are a function of the branch

If a gate image bakes dependencies (a `node_modules` layer, a browser, vendored
packages) so a gate attempt installs nothing, that image is a **function of the
branch**. The tag alone cannot express that: it exists, so it is reused, and an
issue branch that changes the lockfile gets gated against dependencies built
from the source branch. Both directions are silent false verdicts — a branch
that *adds* a dependency reds with a module-not-found nobody can reproduce (and
can burn its whole attempt budget onto `agent-stuck` for it), and a branch that
*removes* one greens against a dependency it deleted.

Declare what the image is built from and sandbar owns the rest:

```ts
images: [
  { tag: "localhost/app-runner:gate", containerfile: "Containerfile.runner",
    rebuildOn: ["package-lock.json", "bower.json"] },
]
```

Note the containerfile is at the repo root here, and that is not incidental:
sandbar builds with the containerfile's **own directory** as the context, so a
`rebuildOn` path outside it could never be `COPY`d and the image could not be a
function of it. That config is rejected rather than accepted-and-ignored — it
would rebuild on every change and produce a byte-identical image, which is the
silent no-op this whole feature exists to remove.

Sandbar hashes those paths — plus the Containerfile's own bytes and the entry's
`buildArgs` — and uses the hash, not the tag, as the cache key:

- at startup the tag is rebuilt when the hash no longer matches your checkout,
  instead of being reused because the name exists (the hash is recorded as an
  image label, so no state file is involved);
- before **every** gate run, including gate-2 on the merge result, the gated
  worktree is hashed. One that matches uses the base image; one that differs
  gets its own content-addressed tag, built from that worktree, and the stack's
  containers — `issue`-lifecycle ones included — are recreated from it.

Per-gate-run rather than per-issue on purpose: the branch grows under the loop,
so an implementer that adds a dependency in attempt 2 must be gated against an
image that has it. The common cases stay free — a gate run that changed nothing
rebuilds nothing, two issues that make the same change share one build, and a
rebuild that *is* needed hits podman's layer cache above the changed `COPY`,
which is the work your CI does anyway. The per-branch tags are removed at the
end of the run.

An image that will not build from the branch is a **red gate** naming the image
and carrying the build's output, not an infrastructure failure: a lockfile that
does not install is the branch's to fix, and routing it to a retry would
reproduce it twice and then park the issue with a trace blaming the environment.
The same applies to a variant whose recipe the branch changed such that it no
longer runs as root or as your uid — the D3 check is re-asked for every image
sandbar builds from a branch, not just the declared ones.

An image that will not build in time is the same: `images[].buildTimeoutMs`
(default 45 minutes) bounds it, because since this feature the recipe and its
inputs are written by the implementer agent and the build runs inside a gate
run while sandbar holds its single-instance lock.

Rules: `rebuildOn` paths are repo-relative (no `..`, no leading `/`), they must
sit inside the containerfile's own directory (the build context), they must
exist in your checkout (a path that matches nothing makes the whole declaration
inert, which is the failure above), it cannot be combined with `stdinContext`
(that build has no context, so nothing in the repo can change it) or with an
absolute `containerfile` (the rebuild re-roots the build at the worktree), and
the image must be one something actually runs — a `gateStack` container's, or
`sandboxImage`. An entry sandbar builds and nothing ever runs is rejected: the
declaration would be inert, which is this feature's own failure mode.

### `rebuildOn` on `sandboxImage`

The agent's sandbox has the same problem the gate does. An image that bakes
dependencies so the agent starts working immediately is a function of the
branch, and an issue that moves the lockfile gets a sandbox built from the
source branch's — which reads, from inside, as a bug in the code the agent was
asked to fix. Declaring `rebuildOn` on the `sandboxImage` entry closes it:

```ts
sandboxImage: "localhost/app:sandbar",
images: [
  { tag: "localhost/app:sandbar", containerfile: "Containerfile.sandbar",
    rebuildOn: ["package-lock.json", "bower.json"] },
]
```

Sandbar prepares the issue worktree **before** it creates the sandbox container
(the gate stack's mounts need the files on disk), so the branch's inputs are
there in time to be hashed, and the sandbox starts on an image built from them.
Two things differ from the gate's version:

- it resolves **once per sandbox**, not per attempt. The attempts of an issue
  accumulate in one container, so re-resolving mid-issue would mean throwing
  that container away — and an agent can install into its own sandbox with one
  command. What the branch adds *during* the run still reaches the gate, which
  is where verdicts come from;
- a build that fails leaves the sandbox on the **declared** tag, with a line on
  the console and in the run log, rather than refusing to start. The sandbox is
  where the fix gets written and the branch outlives the cycle, so a throw would
  wedge the issue instead of failing it — every later sandbox for that branch,
  including the ones meant to repair it, would fail before the agent's first
  turn. The agent then works a commit behind its own branch, and can install
  for itself.

  Read that line, because how much else you will hear depends on your config.
  If a `gateStack` container runs the **same tag**, the gate resolves the entry
  itself and reds with the same build output, against the branch — the line is
  advance warning. If the entry is the **sandbox's alone**, as in the example
  above, nothing else resolves it: the gate's verdict is computed from images
  that built fine, so it can go green and the fallback line is the only report
  you will get. Sandbar says which case you are in.

The rebuild lands in the issue's critical path, before the agent's first turn,
and the sandbox image is usually the largest one — so it costs what your layer
cache says it costs, and only for an entry that declares `rebuildOn`.

### `readiness` — one kind, evaluated inside the container

```ts
readiness: { kind: "healthcheck", command: ["nc", "-z", "127.0.0.1", "3306"] }
```

Sandbar registers `command` as the container's healthcheck (`--health-cmd`, argv
rather than a shell string) with podman's own scheduling **disabled**, and then
invokes it from its own poll loop — bounded by `readinessTimeoutMs`, which is
the only bound there is. Podman's `--health-timeout` is deliberately not exposed:
it does not kill a slow probe, it lets it run to completion and labels the result
afterwards, so a config field spelled like a per-probe bound would be a lie.
Scheduling is disabled because a real interval makes podman create a **transient
systemd timer** — needing a user session the host may not have, and named by
container id, outside everything sandbar's cleanup can sweep.

`command` is required; there is no fallback to the image's own `HEALTHCHECK`.
Omitting `--health-cmd` is the one configuration in which podman schedules that
timer anyway, and the fallback would buy almost nothing: `podman build` defaults
to the OCI format, which has no `HEALTHCHECK` field at all, so no image sandbar
builds carries one.

A readiness failure reports the last five entries of `.State.Health.Log` — what
the *probe* said — above the container's own log tail.

> **Upgrading from `tcp` / `log` / `exec`.** All three are rejected at resolve
> time, before the lock, with the replacement in the message. `exec` translates
> exactly (same argv). `tcp` becomes any in-container probe of the port — and is
> better there, with no publish and no settle window, because the rootless port
> forwarder that made a bare connect meaningless is not in the path. `log` is
> **not** a mechanical translation: write the check the pattern stood in for. A
> reused `issue` container whose log the host journal has since vacuumed can
> never match its boot-time pattern again, which is the failure retiring it
> fixes.
>
> The one thing lost: a `scratch` image with no shell and no probe binary can no
> longer declare readiness. Bake a static probe binary, or use `hold: true` plus
> a `postReadyCommand`.

### Three constraints the gate stack imposes on your images and steps

**A worktree-mounting image must run as root, or as your uid.** Stack containers
run inside a pod, and podman refuses `--userns=keep-id` alongside `--pod`; inside
the pod's userns, uid 1000 maps to a subuid rather than to you, so writes into
the mounted worktree fail with EACCES. Container root under rootless podman maps
to the invoking user, so files still land owned by you. Sandbar checks this
before the run by running each such image (`podman run --rm --entrypoint id <img> -u`)
and refuses with both remedies named: drop the `USER` directive, or align the
image to your uid at build time via `buildArgs`.

**The steps have to be able to see the code under test.** A gate whose steps all
run in containers that never mount the worktree returns the same verdict for
every commit — green included — which is the one failure the gate exists to
prevent. Sandbar therefore requires that **at least one container mounting the
worktree is stepped into**. Ordinary stacks (a runner that mounts the tree and
holds, with every step `in` it) satisfy this for free.

The exception is a stack that serves the branch's code over loopback: an app
container that mounts the worktree and runs it, with every step in a playwright
container that needs no mount of its own. That shape is correct and fails the
check, and no rule can tell it apart from the broken one — a stale mount left on
a database by a refactor produces byte-identical config, and a realistic database
declares `readiness` too. So it says so:

```ts
{ name: "app", image: "…", mountWorktree: "/app", servesWorktree: true }
```

`servesWorktree` is needed **only** by a stack with no stepped-into mount at all.
It is rejected where it is decidably false: on a container that mounts nothing
(it has nothing to serve), and on one that sets `hold` with no
`postReadyCommands` (`sleep infinity` plus nothing exec'd after it means the
container never runs anything). A held container *with* a `postReadyCommands`
entry that backgrounds a daemon is accepted — that is the only route for an
image whose `ENTRYPOINT` is not a shell.

> **Note.** A container that mounts the worktree and boots its own entrypoint
> may not be `lifecycle: "issue"`. An `issue` container is reused across attempts
> precisely because it depends only on its image and its env, which is why a
> failure to start it is treated as infrastructure: two HARD-ERROR retries on a
> fresh stack, then `NEEDS-HUMAN` with an "environment" trace. Booting the
> branch's code breaks that — a branch that breaks its own startup gets blamed on
> the environment. Use `mounts` when such a container only needs fixture files
> from the worktree.
>
> `hold` is the exception, and is allowed: the entrypoint becomes `sleep
> infinity`, so nothing of the branch's runs at bringup. It is also the only home
> for per-issue setup, since `postReadyCommands` run once per *container* and an
> `attempt` container is recreated on every gate run. Such a container's own
> `postReadyCommands` do re-open the misblame window if they build branch code;
> that is your argv and your call, not something sandbar can decide for you.

### `inSandbox` — letting the agent run the app before the gate does

An implementer that can't run your application writes a test it has never
watched fail and a fix it has never watched pass. Mark a gate-stack container
`inSandbox: true` and sandbar runs a **second copy of it beside the agent**, in
the agent container's own network namespace:

```ts
{ name: "db", image: "docker.io/library/mariadb:10.11", lifecycle: "issue",
  readiness: { kind: "healthcheck",
               command: ["healthcheck.sh", "--connect", "--innodb_initialized"] },
  inSandbox: true }
```

The agent then reaches it on `127.0.0.1` exactly as a gate step does — one
namespace, so the address is the same one your `gateStack` steps already use —
and you delete the database, the mail catcher and the web server from your
sandbox image along with whatever start-and-wait script was supervising them.
One description of what it takes to run the app, not two. Sandbar names no port
in the agent's prompt, because since the readiness probe moved inside the
container there is no port written down in the config for it to read; say which
port is which in your own anchor docs, beside the credentials.

- **Opt-in per container.** Declare it nowhere and nothing changes: no extra
  container, no prompt section, no cost.
- **It is a different namespace from the gate's**, deliberately. The agent must
  not be able to reach the stack its verdict is formed in, and that comes from
  the topology rather than from the absence of a container runtime inside the
  sandbox. There is no podman in there, and there is not meant to be.
- **The gate is authoritative.** Sandbox siblings run the image your config
  names, resolved once when the sandbox is created; the gate re-resolves
  `rebuildOn` images per gate run. (The agent's own container is in between:
  since #46 its image is resolved against the branch, but once per sandbox
  rather than per attempt.) So a suite that passes in the sandbox can still red
  the gate — most often right after the branch changed a lockfile. The agent is
  told this in its prompt.
- **Nothing restarts a sibling.** A service that reads configuration at *boot*
  keeps what it booted with for the rest of the issue, however the agent edits
  the file. Mounted interpreted code is unaffected; a config change is not.
- **Your `onSandboxReady` hooks run after the siblings are up**, so that is the
  place to run a migration or load fixtures against them. (`onWorktreeReady`
  still runs before anything is started — it is where `npm ci` belongs.)
- **The agent can read their logs.** Each sibling's `podman logs -f` is followed
  into a file on the host and mounted read-only at `/sandbar/logs/<name>.log`.
  Those files also land in the run log tree, and they are not rotated or
  capped — a service that logs every request writes for as long as the issue
  runs. A container that failed to come up is followed too, with the bringup
  error written in ahead of it: the usual failure is a service that started and
  then missed its readiness check, and it keeps logging.
- **A sibling that will not start is reported, not fatal** — for an `attempt`
  container. The sandbox comes up degraded and the agent gets that container's
  log tail in its prompt, because the agent is the one party that can fix its
  own app's bootstrap. An `issue` container failing is still infrastructure: the
  issue retries with a fresh sandbox.
- **`inSandbox` with `hold` and no `postReadyCommands` is rejected** — the same
  decidable emptiness `servesWorktree` is checked for. `sleep infinity` plus
  nothing exec'd after it would advertise a service that does not exist.
- **Cost.** At the default plan size, three issues run at once, so N `inSandbox`
  containers means 3N extra containers per cycle. That is the price of the
  isolation.

Note the sandbox siblings share the issue worktree with the gate and keep
writing while a gate run is in progress, so the rule below applies to them too —
and give them cache paths of their own if they compile anything.

**A gate step must write only into gitignored paths.** The gate is a verdict
about a *commit*, so sandbar refuses to run it against a worktree with
uncommitted changes — including untracked files. Ignored build artifacts are
exempt (that is what lets `node_modules` survive between attempts), but a step
that writes anywhere else reports its own exhaust as uncommitted work. The
implementer is asked to commit and gets another attempt; if it comes back with
the *same* dirty set — which is what happens when the files are not the agent's
to remove — the issue stops immediately as `NEEDS-HUMAN`, naming the paths,
rather than spending the rest of its budget on it.

> **Note.** Between the merge and gate-2 the merge phase runs
> `npm install --no-audit --no-fund` in its own ephemeral worktree. If that
> rewrites `package-lock.json` (merging two branches that both changed
> dependencies usually does), the update is committed into the merge result —
> otherwise the clean-tree rule above would refuse the very merge sandbar just
> made. Non-npm projects are unaffected; the install failing is a skip, not a
> hard error.

The host project also supplies on disk:
- A `Containerfile` for the sandbox image (or whatever `images` names)
- Optionally, a `CODING_STANDARDS.md` (`codingStandardsPath`) — the reviewer ships with built-in default coding standards (`prompts/coding-standards.md`); this file *extends* them and is not required
- `GH_TOKEN` and either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, reachable through `config.env` — as literal values, as keys declared empty so they inherit from the launching environment, or read from a file of your choosing with `readEnvFile`

`verified` mode additionally uses the host's own `gh` auth (not the container's
`GH_TOKEN`) for `gh api .../check-runs`, `gh api .../commits/<sha>/status`,
`gh run view --log-failed` and, with `openPullRequest`, `gh pr list/create/edit/close`.
A token that cannot read Actions surfaces as repeated poll failures, which halt
the run.
- Project anchor docs (`CLAUDE.md`, optional `CONTEXT.md`, optional ADR directory)
