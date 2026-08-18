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

`RunConfig` is **deviations-only**. Supply the repo-specific facts sandbar can't guess (required) plus only the knobs you want different from the defaults. Everything else falls through — don't restate a default.

```ts
import { run } from "@offergeist/sandbar";

await run({
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
  // issue's. (A `tcp` readiness port is published loopback-only on an
  // ephemeral host port, since sandbar probes it from the host.)
  gateStack: {
    containers: [
      {
        name: "db",
        image: "docker.io/library/mariadb:10.11",  // must be fully qualified
        lifecycle: "issue",                        // started once per issue
        env: { MYSQL_ALLOW_EMPTY_PASSWORD: "yes", MYSQL_DATABASE: "app" },
        readiness: { kind: "tcp", port: 3306 },
        readinessTimeoutMs: 120_000,               // default 60_000
        // Optional: args (image CMD args), mounts (fixture files mounted
        // read-only, hostPath relative to the GATED WORKTREE),
        // postReadyCommands (one-shot setup exec'd after readiness).
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

  // Everything else is OPTIONAL — see the tables below for the defaults.
  // Omit any line you're happy with.
});
```

### Required fields

| Field | Why it can't default |
| --- | --- |
| `ghOwner`, `ghRepo` | Repo identity. |
| `sandboxImage` | The image the agent (and the merger's resolve agent) runs in. |
| `botName`, `botEmail` | Commit/author identity. |
| `sandboxHooks` | Host-specific build/setup. |
| `gateStack` | The containers and steps that produce a verdict. What it takes to test this repo is repo identity — sandbar ships no preset. |

### Optional fields and their defaults

| Field | Default |
| --- | --- |
| `cwd` | `process.cwd()` |
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
| `envFilePath` | `.env` |
| `copyToWorktree` | `[]` |
| `maxImplAttempts` | `8` |
| `maxReviewRounds` | `5` |
| `maxTotalIssues` | `50` |
| `labels` | `{ needsInfo: "needs-info", agentStuck: "agent-stuck" }` (override any subset) |
| `mergeMode` | `{ kind: "direct" }` — see below |
| `codingStandardsPath` | *(unset)* — no conventional path; see below |

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
  { tag: "localhost/app-runner:gate", containerfile: "gate/Containerfile.runner",
    rebuildOn: ["package-lock.json", "bower.json"] },
]
```

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

Rules: `rebuildOn` paths are repo-relative (no `..`, no leading `/`), they must
exist in your checkout (a path that matches nothing makes the whole declaration
inert, which is the failure above), it cannot be combined with `stdinContext`
(that build has no context, so nothing in the repo can change it) or with an
absolute `containerfile` (the rebuild re-roots the build at the worktree), and
the image must be one a `gateStack` container runs. Declaring it on the agent
sandbox's image alone is rejected: that image is resolved once, when the sandbox
is created, before the branch it would depend on exists — and the agent can
install into its own sandbox, so a stale layer there costs it a command rather
than a verdict.

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
- `.env` (at `envFilePath`) with `GH_TOKEN` and either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`

`verified` mode additionally uses the host's own `gh` auth (not the container's
`GH_TOKEN`) for `gh api .../check-runs`, `gh api .../commits/<sha>/status`,
`gh run view --log-failed` and, with `openPullRequest`, `gh pr list/create/edit/close`.
A token that cannot read Actions surfaces as repeated poll failures, which halt
the run.
- Project anchor docs (`CLAUDE.md`, optional `CONTEXT.md`, optional ADR directory)
