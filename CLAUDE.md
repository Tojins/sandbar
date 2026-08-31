# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read @AGENTS.md first. It holds the working rules that apply to every commit made
here (starting with: bump the version in the same commit), and it is shared with
the sandbar agents — `sandbar.config.mjs` names it as an anchor doc, so they get
an `@ref` to it directly rather than through this import.

This file is the architecture **map**. The authoritative design notes per module
are the long header comments at the top of `src/*.ts` — read the header before
changing a module, and update it when behavior changes. The full rationale for
each decision lives in the GitHub issue it cites (`#N`) and the commit history;
none of it is restated here.

## Commands

- `npm run build` — compile `src/` → `dist/` via `tsc` (also runs on `prepare`).
- `npm run check` — type-check only (`tsc --noEmit`). No lint tool is configured; this is the only static gate.
- `npm test` — run the Vitest suite (`vitest run`, non-watch).
- `npx vitest run src/plan-resolver.test.ts` — run a single test file. Add `-t "<name>"` to filter by test name.

Node ≥ 20 is required. The package is ESM (`"type": "module"`); imports inside
`src/` use the `.js` extension even when the on-disk file is `.ts` (NodeNext).

**Whatever bounds a test run must kill the process GROUP, not the pid (#25).**
Vitest forks a process per test file; a stuck worker killed only at the top of
the tree reparents to init and silently burns a full core. Bare
`timeout 90 npx vitest run <file>` is safe (GNU timeout signals the group);
`timeout --foreground` and Python's `subprocess.run(..., timeout=N)` are not —
from Python use `start_new_session=True` + `os.killpg`. After any interrupted
run, check `ps -ef | grep [f]orks.js` for leftovers.

## What this package is

`@offergeist/sandbar` is a **library with a thin bin** (#38): `run(config)` is
the contract (`src/index.ts`), and `src/cli.ts` resolves `--config` (default
`./sandbar.config.mjs`) and hands the default export to `run()`. The bin also
dispatches one subcommand, `sandbar gate` → `runGateCommand` (#45), exported
from the package root beside `run`.

A host repo supplies one committed `sandbar.config.mjs` at its root, its own
`Containerfile`(s), anchor docs (`CLAUDE.md`, `CONTEXT.md`, optional ADR dir),
and a **gate stack** (`config.gateStack`, #24) — the containers and steps that
produce a verdict about a commit. Reviewer coding standards ship built-in
(`prompts/coding-standards.md`); a host may extend them via
`config.codingStandardsPath`. Sandbar then drives a GitHub-Issues-driven
coding-agent loop against that host.

**The config file is a PROGRAM, not data** — imported, never parsed, so computed
values and top-level await survive. Exactly one configuration flag (`--config`),
no search up the directory tree, `.mjs`, and the default export is the object,
not a factory. Rationale in `src/cli.ts` and `src/config.ts` headers.

## Architecture — the four-phase outer loop

The orchestrator (`src/run.ts`) cycles plan → execute → merge → finalise until
an exit condition fires.

1. **Plan** (`src/plan-resolver.ts`) — purely deterministic, no LLM: lists
   issues labelled `ready-for-agent`, parses `## Blocked by` sections, selects
   the top-K unblocked issues (default 3) by number. Each candidate also gets a
   **lane** (`src/lanes.ts`, #57): `auto-land` label else `config.defaultLane`,
   with review-gating inherited downward along the same `## Blocked by` edges,
   transitively — an `auto-land` contradicted by inheritance loses and sandbar
   says so on the issue. A blocker counts as satisfied when it is CLOSED, or
   (#59) when it carries `in-chunk` and sits in the *same* chunk as its
   dependent — cross-chunk edges stay strict. That second clause is why the
   planner also lists the `in-chunk` issues back in (`fetchChunkMembers`) and
   drops them by label: out of the graph, a chunk re-roots around its surviving
   members and a descendant of a landed issue reads as auto. A review-gated
   issue plans iff it is its chunk's ROOT (#60) — the only member whose issue
   branch, seeded from `origin/<sourceBranch>`, agrees with the base its chunk
   branch is created at; chained members and issues with no chunk stay held
   (`heldForReview`) until #61. Each planned issue carries its `chunk` target,
   which is how phase 3 knows where to land it. All inert under the default
   lane, `auto`.

2. **Inner loop** (`src/inner-loop.ts` + `src/inner-loop-machine.ts`) — each
   planned issue runs in parallel in its own agent sandbox + per-issue gate
   stack, ralph-style: up to `maxImplAttempts` (default 8) attempts in the
   **same** sandbox so commits accumulate on the issue branch. All transitions
   live in the pure state machine; `inner-loop.ts` is I/O glue. Per attempt:
   build prompt → implementer → parse `<promise>` → on `COMPLETE` with a clean
   tree on the issue branch, run gate-1 → on green, run the reviewer (strictly
   advisory, read-only) → `APPROVED` ⇒ DONE, `CHANGES-REQUESTED` ⇒ another
   attempt with the prose surfaced. Two orthogonal budgets: impl attempts and
   `maxReviewRounds` (default 5). HARD-ERROR is infra-only — the SM never emits
   it; the runner wraps setup/container throws so `decideAfterTerminal` can
   retry with a fresh sandbox. A reviewer that produced no review is not a
   verdict (#41) — `src/reviewer-run.ts` header owns that policy. Terminals:
   `DONE | NEEDS-INFO | NEEDS-UI-PROTOTYPE (#21) | NEEDS-HUMAN |
   NEEDS-HUMAN-REVIEW | HARD-ERROR`.

3. **Merge** (`src/merger.ts` + `src/resolve-loop.ts` + `src/merger-worktree.ts`
   + `src/forge-verify.ts`) — procedural, in a dedicated ephemeral worktree
   detached at `origin/<sourceBranch>` (never the operator's checkout, #10).
   Per DONE branch in issue order: `git merge --no-ff`, and on conflict or
   post-merge-gate-red, the agentic resolve loop (which sees all sibling issue
   bodies). `config.mergeMode` (#22): `direct` (default) pushes at the end;
   `verified` gives CI the last word via a scratch `integrationBranch` — the
   whole check-reading safety argument (pagination, settling, skipped ≠ pass,
   commit statuses, `requiredChecks`, parked vs fatal, `MergerError.partial`)
   is in `src/forge-verify.ts` and `src/merger.ts` headers. Its invariant: no
   unknown verdict ever lands. **Two targets since #60**: an issue carrying a
   `chunk` is merged onto `sandbar/chunk-<root>-<slug>` (created at
   `origin/<sourceBranch>` when origin has none) and that branch is pushed —
   directly, in both merge modes, because the forge gates what reaches the
   *source* branch and a chunk branch reaches a human. Chunk groups land first
   and the worktree returns to its entry sha, so the source pass and the
   `landed` argument about what a partial may claim are untouched. Each pushed
   chunk then gets its **draft PR** (#62), created-or-updated per cycle:
   `src/chunk-pr.ts` is the prose, `src/forge-pr.ts` the one `gh pr`
   create-or-update both PR kinds share.

4. **Finalise** (`src/finalize.ts` + `src/finalize-inputs.ts`) — per-issue
   branch lifecycle, bot comments, label flips (`ready-for-agent` ↔
   `labels.needsInfo`/`labels.agentStuck`, plus `in-chunk` for a chunk-landed
   member, are the only labels sandbar applies).
   Runs in **two passes straddling the merge** (#30): Phase-2 terminals are
   finalised before Phase 3 so a merge-phase throw cannot discard them.

### Exit conditions (`src/exit-conditions.ts`)

First of: **plan-empty** (exit 0) · **relaunch** (#65, exit 75 after any cycle
that landed merges, when `config.relaunchAfterLanding`) · **stuck-same-plan**
(exit 2) · **stuck-zero-dones** (exit 2) · **budget** (`maxTotalIssues`,
default 50, exit 3).

## Key invariants — where the details live

- **Pure decision functions + adapters.** The SM, parsers, planners and
  finalize logic are pure; I/O goes through `MergerAdapter`/`FinalizeAdapter`/
  `ResolveAdapter` etc. Table-test the pure layer; don't mock `gh`/`git` if the
  decision can be tested directly. Real-adapter argv is table-tested through
  exec seams (`forge-verify.test.ts`, `gate-stack.test.ts`, `gh-argv.test.ts`);
  what git/podman themselves define is asserted by *running* them
  (`*-git.test.ts`, `*-podman.test.ts` — these self-skip at collection time
  when the runtime is missing, and fail instead under
  `SANDBAR_REQUIRE_PODMAN_TESTS=1`).
- **The repo sandbar operates on is not the repo the human stands in (#38).**
  `config.cwd` is the operator's real checkout; sandbar works only inside
  `<cwd>/<workDir>`: a **bare** object cache (`repo.git`) plus worktrees,
  threaded as one `RepoLayout`. Nothing in the state directory is
  authoritative — `rm -rf .sandbar` costs agent time, never correctness. The
  bare cache is a safety property: destructive ops (`branch -D`,
  `worktree remove --force`, the force-pushed integration ref) provably cannot
  reach the operator's refs. One hazard: `run.lock` lives in the state dir, so
  a `git clean -x` in the checkout during a run deletes the lock out from under
  it and replays #28's scope collision — never clean while a run is in flight.
  Details: `src/repo-cache.ts` and `src/preflight.ts` headers.
- **Every shell-out names its repo; nothing inherits `process.cwd()` (#34),**
  and every `gh` call passes `--repo` (`src/repo-ref.ts`). Preflight verifies
  the configured tracker and the git remote agree on host and `owner/name`.
- **Per-issue podman isolation inside a per-run scope (#28).** All resource
  names carry `w`+8-hex of the *realpath'd* locked workdir; the orphan sweep
  only ever touches its own scope, and unattributable debris is reported, never
  removed. `src/containers.ts` and `src/naming.ts` headers. Image **tags** are
  the one class the scope does not partition — on a shared host, give each
  workdir its own tags.
- **Runtime is podman**, hard-coded (`src/runtime.ts`). The agent sandbox runs
  under `--init` (#42), and every container gets `--image-volume=ignore` (#50)
  — see `src/agent-sandbox.ts` and `src/containers.ts` headers.
- **The gate stack is config-driven (#24)** and `resolveGateStack` validates it
  before the lock. `src/gate-stack.ts`'s header is authoritative for all of it:
  lifecycle = whose failure a bringup is (D5), a red gate carries every
  container's log tail (D9), worktree-mounting images must run as root or the
  host uid (D3), healthcheck-based readiness with sandbar owning the schedule
  (#43), mid-issue wedge detection (#49, #36), every podman call bounded
  (`boundedPodman`, #26 — node's `timeout:` option is a green-on-red trap),
  per-step `timeoutMs`, one pod per stack, mount-source preflight (#51).
- **The sandbox stack (#44).** `inSandbox: true` gate containers get a second
  copy beside the agent, in a netns chain off the sandbox container (a pod
  cannot host keep-id). Logs are followed to read-only files at
  `/sandbar/logs/<name>.log`; there is no restart. `src/sandbox-stack.ts`.
- **An image that bakes dependencies is a function of the branch (#37, #46).**
  `images[].rebuildOn` + fingerprint labels; the gate re-resolves per **gate
  run** (content-addressed, scoped variant tags), the sandbox once per
  **sandbox** with fallback to the declared tag on build failure. An
  unbuildable image is a gate red, not a HARD-ERROR. `src/image-inputs.ts`,
  `src/ensure-images.ts` headers.
- **`sandbar gate` (#45)** is the one standalone runner for the same stack.
  Exit 0 green / 1 red / 2 no-verdict; it suspends D1, the lock, preflight and
  `sandboxHooks` deliberately, derives its own scope, and checks reuse via a
  pod label. `src/gate-run.ts` header.
- **A gate verdict is about a commit.** The tree must be clean and ≡ HEAD
  (D1, #24) and HEAD must be `refs/heads/<branch>` (#27) — both re-checked
  after every implementer attempt; `sandbar gate` is the only caller allowed to
  suspend D1. Corollary for consumers: gate steps and sandbox siblings must
  write only into gitignored paths. `src/git-ops.ts`,
  `src/inner-loop-machine.ts`.
- **Branch naming is load-bearing.** Two shapes under one prefix,
  `sandbar/issue-<n>-<kebab-slug>` and `sandbar/chunk-<root>-<kebab-slug>`
  (#58) — preflight cleanup, orphan sweep and worktree paths all key off them,
  so `src/naming.ts` owns both builders, both parsers and the one refglob list
  every enumeration uses. Issue branches seed from `origin/<sourceBranch>`,
  never local.
- **A chunk is derived, never declared (#54 §2, #58).** `src/chunks.ts` is a
  pure function: a chunk is a connected component of the *review-gated* issues
  under the `## Blocked by` graph, rooted at its parentless member. Chunks are
  never merged to accommodate an issue that straddles two — that issue is
  blocked instead. The walk is topological because the two-chunk rule makes the
  answer order-dependent; the header owns that argument. `IN_CHUNK_LABEL`
  (#59) lives here too — the label a member carries once its branch has landed
  on the chunk branch, OPEN and out of the queue; finalise applies it (#60),
  never before the chunk branch carrying the commits is on origin. The
  derivation itself still creates nothing: the planner turns `chunkOf` into a
  blocker criterion and a `PlannedIssue.chunk` target, and the merge phase is
  what makes a branch. **Origin owns the chunk branch** — it is the review
  artifact and the recovery point, so every landing bases on `origin/<chunk>`
  and preflight fetches that namespace to reason about it.
- **The chunk's review surface is a DRAFT pull request (#62).** One per chunk,
  created or updated after every landing push, listing everything the branch
  carries — the members landing now plus `ChunkTarget.landed`, the planner's
  snapshot of the members already holding `in-chunk` (only the plan has the
  graph that knows them). Draft is the mechanism (#54 Q14): it disables the
  merge button and leaves review intact. Sandbar re-titles and re-bodies, and
  never re-drafts a PR a human made ready — that override is #64's to
  reconcile. `src/chunk-pr.ts` owns the prose and what it may claim.
- **Single-instance lock per workdir**, taken *before* preflight, with a
  `run.pid` sidecar for stale-PID takeover (#32). `src/lock.ts`.
- **One cleanup registry owns signals and the exit (#35).** No module but
  `src/cleanup.ts` may trap a signal or exit on one. `onCleanup` never forgets
  an action — which is what makes registering a teardown *before* its resource
  exists safe, and what makes a per-resource entry a leak: anything created in
  a loop (gate stack, sandbox stack, merger worktree, a `sandbar gate` call)
  registers with `registerDisposable` and withdraws itself when its idempotence
  latch flips (#55).
- **Credentials are a value, not a path (#38).** `config.env` is an allowlist
  record (empty value ⇒ inherit from `process.env`); `readEnvFile` is the
  opt-in loader. `src/env.ts`.
- **Token contracts.** Implementer: `<promise>COMPLETE|NEEDS-INFO|
  NEEDS-UI-PROTOTYPE</promise>`; resolve loop: `COMMITTED|ABANDON`; anything
  else re-prompts. Reviewer: `<verdict>APPROVED|CHANGES-REQUESTED</verdict>`,
  defaulting to CHANGES-REQUESTED only for a run that produced output (#41).
  The orchestrator gates between attempts; agents never decide "green".
- **Prompt prose lives in `prompts/*.md`**, loaded by `src/prompts.ts`; TS
  keeps only structure. Every git range a prompt renders anchors at
  `origin/<sourceBranch>`, never the bare branch name (#40) — `src/prompt.ts`.
- **Logs are append-only and unbuffered** (`src/logs.ts`).

## This repo runs itself (#39)

`sandbar.config.mjs` at the root is the host-side surface, `Containerfile`
builds the one image, `sandbar.env` (gitignored) holds credentials, and
`npm run sandbar` is the launcher — a loop (#65): pull, build, run, and around
again only on exit 75.

- **One image, both roles** (agent sandbox and gate pod member): it defines an
  `agent` user at uid 1000 and keeps default `USER` root — `checkWorktreeImageUids`
  refuses the run if that changes. glibc, pinned to the host's node major,
  because `node_modules` is installed on the host by the `onWorktreeReady` hook
  and shared through the bind mount.
- **The gate runs the podman-layer tests over the host's socket (#48)** —
  `CONTAINER_HOST` plus a read-only socket mount; test containers are scoped
  siblings of the run's own (#47). What a human still runs by hand is exactly
  two host-only files: `gate-stack-hostpodman.test.ts` (local-client and
  systemd-session facts) and `sandbox-stack-podman.test.ts` (keep-id anchor
  chain, #44).
- **`mergeMode` stays `direct`; hosted CI was built and removed on purpose**
  (#39) — personal project, tests belong on host machines.
- **Serialize issues touching `run.ts`/`inner-loop`/`merger`** (blocked-by
  chains, not parallel): the orchestrator driving a cycle is whatever `dist/`
  held at launch, so a merged regression mis-drives the very next cycle.
- **The suite must not depend on ambient git config** (the gate runner has no
  global identity) **nor on `process.cwd()` being a repository** (`/workspace/.git`
  is a broken gitlink inside gate containers — name the directory in every git
  call a test makes).

## When making changes

- **Strict TypeScript** — `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`. Array/Map lookups are `T | undefined`.
- **`*.test.ts` is excluded from `tsc`** (checked by vitest instead); the
  strict gate covers production code only.
- **Always import with `.js` extensions**, even from `.ts` files.
- **Module headers are the authoritative architecture notes.** Read the header
  first; update it in the same commit as the behavior it describes.
