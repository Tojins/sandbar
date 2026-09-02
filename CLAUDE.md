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
produce a verdict about a commit. Coding standards for the implementer and
reviewer ship built-in (`prompts/coding-standards.md`); a host may extend them via
`config.codingStandardsPath`. Sandbar then drives a GitHub-Issues-driven
coding-agent loop against that host.

**The config file is a PROGRAM, not data** — imported, never parsed, so computed
values and top-level await survive. Exactly one configuration flag (`--config`),
no search up the directory tree, `.mjs`, and the default export is the object,
not a factory. Rationale in `src/cli.ts` and `src/config.ts` headers.

## Architecture — the four-phase outer loop

The orchestrator (`src/run.ts`) cycles plan → execute → merge → finalise until
an exit condition fires.

1. **Plan** (`src/plan-resolver.ts` + `src/chunk-reconcile.ts`) — purely
   deterministic, no LLM: lists issues labelled `ready-for-agent`, parses
   `## Blocked by` sections, selects the top-K unblocked issues (default 3) by
   number. Each candidate also gets a **lane** (`src/lanes.ts`, #57) and, when
   review-gated, a `chunk` target (#61) that tells phase 2 what to seed from
   and phase 3 where to land. Ahead of the plan proper two passes make the
   tracker agree with the forge and with git: the **chunk-review scan**
   (`src/chunk-follow-up.ts`, #63) turns each changes-requested review on a
   chunk PR into an issue in that chunk, and the **reconciler**
   (`src/chunk-reconcile.ts`, #64) finishes off any chunk branch already
   contained in `origin/<sourceBranch>` — hand-merged, or landed by a run that
   died before closing the members. The plan is rebuilt after either acts. All
   inert under the default lane, `auto`; the blocker, chunk, follow-up and
   wrap-up criteria are the `plan-resolver.ts`, `chunks.ts`,
   `chunk-follow-up.ts` and `chunk-land.ts` headers to state.

2. **Inner loop** (`src/inner-loop.ts` + `src/inner-loop-machine.ts`) — each
   planned issue runs in parallel in its own agent sandbox + per-issue gate
   stack, ralph-style: up to `maxImplAttempts` (default 8) attempts in the
   **same** sandbox so commits accumulate on the issue branch. All transitions
   live in the pure state machine; `inner-loop.ts` is I/O glue. Two budgets,
   impl attempts and `maxReviewRounds` (default 8, equal to `maxImplAttempts`),
   and they are NOT independent (#71): a round is never spent without an
   attempt, so the budget is at most the min of the two — exactly that on the
   green-gate loop where every attempt ends in a verdict, and more attempts
   than rounds wherever one ends without one (a red gate, a re-prompt, a
   reviewer harness failure). Equal is what makes both
   exhaust on the same attempt and park the issue with the terminal carrying
   the latest review; `DEFAULT_MAX_REVIEW_ROUNDS`'s comment in `src/config.ts`
   owns the number and the two dogfooding exhaustions behind it (#8, #66). The
   reviewer is strictly advisory and read-only. One review round is up to two
   sequential calls in the same provider session (#19): correctness first on
   `reviewerModelId`, then — only after approval — tests/spec/standards on
   `reviewerFollowupModelId`; the state machine receives their single aggregate
   result and spends one round. `src/reviewer-run.ts` owns what a failed
   reviewer invocation means (#41). Terminals: `DONE | NEEDS-INFO |
   NEEDS-UI-PROTOTYPE (#21) | NEEDS-HUMAN | NEEDS-HUMAN-REVIEW | HARD-ERROR`
   (infra-only).

3. **Merge** (`src/merger.ts` + `src/resolve-loop.ts` + `src/merger-worktree.ts`
   + `src/forge-verify.ts` + `src/chunk-land.ts`) — procedural, in a dedicated
   ephemeral worktree detached at `origin/<sourceBranch>` (never the operator's
   checkout, #10). Per DONE branch in issue order: `git merge --no-ff`, with
   the agentic resolve loop on conflict or post-merge-gate-red.
   `config.mergeMode` (#22): `direct` (default) or `verified` (CI gets the last
   word); the check-reading safety argument — its invariant: no unknown verdict
   ever lands — is in the `src/forge-verify.ts` and `src/merger.ts` headers. An
   issue carrying a `chunk` lands on its chunk branch instead (#60) and each
   pushed chunk gets a **draft PR** per cycle (#62): `src/chunk-pr.ts` is the
   prose, `src/forge-pr.ts` the `gh pr` create-or-update both PR kinds share. A
   **`land` label on that PR** (#64) makes the next cycle merge
   `origin/<chunk>` in the SAME source pass, ahead of the auto lane's branches,
   so one gate-2 and one landing cover both; the wrap-up then closes the
   members on the branch, drops `in-chunk`, takes `land` back off the PR,
   closes it and deletes the branch. `src/chunk-land.ts` owns the label, the
   selection, the wrap-up and — as `chunkForgeWrites` — the one spelling of the
   `gh`/`git` writes it makes, which the merge phase and the plan-time
   reconciler both build their adapter from.

4. **Finalise** (`src/finalize.ts` + `src/finalize-inputs.ts`) — per-issue
   branch lifecycle, bot comments, label flips (`ready-for-agent` ↔
   `labels.needsInfo`/`labels.agentStuck`, plus `in-chunk` for a chunk-landed
   member, are the only labels sandbar applies — `land` (#64) it only ever
   REMOVES, from a pull request a human labelled).
   Runs in **two passes straddling the merge** (#30): Phase-2 terminals are
   finalised before Phase 3 so a merge-phase throw cannot discard them.

### Exit conditions (`src/exit-conditions.ts`)

First of: **plan-empty** (exit 0) · **relaunch** (#65, exit 75 after any cycle
that landed merges, when `config.relaunchAfterLanding`) · **stuck-same-plan**
(exit 2) · **stuck-zero-dones** (exit 2) · **budget** (`maxTotalIssues`,
default 50, exit 3) · **halted** (exit 1) · **iteration-ceiling**.

All seven are one type, `TerminalExit`, and the run ends with exactly one
`Exit (<tag>): <reason>` on stdout whichever fired (#70) — `formatExitLine` is
the only spelling of it, `EXIT_TAGS` is exhaustive over the union, and a table
test asserts every tag has a line. `applyCycle` owns only the four that judge a
completed cycle; plan-empty, halted and the ceiling are the orchestrator's own
and used to announce themselves in four different ways, the halt in none at all.

## Key invariants — where the details live

- **Pure decision functions + adapters.** The SM, parsers, planners and
  finalize logic are pure; I/O goes through `MergerAdapter`/`FinalizeAdapter`/
  `ResolveAdapter` etc. Table-test the pure layer; don't mock `gh`/`git` if the
  decision can be tested directly. Real-adapter argv is table-tested through
  exec seams; what git/podman themselves define is asserted by *running* them
  (`*-git.test.ts`, `*-podman.test.ts` — self-skip when the runtime is
  missing, fail instead under `SANDBAR_REQUIRE_PODMAN_TESTS=1`).
- **The repo sandbar operates on is not the repo the human stands in (#38).**
  `config.cwd` is the operator's real checkout; sandbar works only inside
  `<cwd>/<workDir>` — a **bare** object cache plus worktrees, threaded as one
  `RepoLayout` — so destructive git ops provably cannot reach the operator's
  refs. Nothing in the state directory is authoritative: `rm -rf .sandbar`
  costs agent time, never correctness. One hazard: `run.lock` lives there, so
  a `git clean -x` in the checkout during a run deletes the lock out from
  under it — never clean while a run is in flight. `src/repo-cache.ts` and
  `src/preflight.ts` headers.
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
  before the lock. `src/gate-stack.ts`'s header is authoritative for the rest:
  lifecycles, readiness, wedge detection, bounded podman calls, timeouts, one
  pod per stack.
- **The sandbox stack (#44).** `inSandbox: true` gate containers get a second
  copy beside the agent, in a netns chain off the sandbox container (a pod
  cannot host keep-id). Logs are followed to read-only files at
  `/sandbar/logs/<name>.log`; there is no restart. `src/sandbox-stack.ts`.
- **An image that bakes dependencies is a function of the branch (#37, #46).**
  `images[].rebuildOn` + fingerprint labels; an unbuildable image is a gate
  red, not a HARD-ERROR. `src/image-inputs.ts`, `src/ensure-images.ts` headers.
- **`sandbar gate` (#45)** is the one standalone runner for the same stack; it
  deliberately suspends D1, the lock, preflight and `sandboxHooks`.
  `src/gate-run.ts` header.
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
  every enumeration uses. Issue branches seed from origin, never local —
  `origin/<sourceBranch>`, or the chunk tip for a chained chunk member (#61) —
  and both prompt builders receive the same base `ensureIssueBranch` used.
  The seeding fallback guard and the re-rooting argument are
  `src/git-ops.ts`'s.
- **A chunk is derived, never declared (#54 §2, #58).** A chunk is a connected
  component of the *review-gated* issues under the `## Blocked by` graph,
  rooted at its parentless member; an issue straddling two chunks is blocked,
  never a reason to merge them. `src/chunks.ts` is the pure derivation and its
  header owns the argument; `IN_CHUNK_LABEL` and `LAND_LABEL` (#59, #64) live
  there too. **Origin owns the chunk branch** — every landing bases on
  `origin/<chunk>`, preflight fetches that namespace to reason about it, and
  the branch is deleted THERE when the chunk lands. What a chunk branch
  carries is `PlanResolution.landedChunks`, the only answer the whole
  candidate graph can give: the `in-chunk` members, which is the set a landing
  closes (#64) and whose tips a follow-up is blocked by (#63) — never the whole
  component, since a member that has never been worked has no commits
  anywhere. It also carries the ORDER those closes must go in, for the reason
  the `land` bullet below states.
- **The chunk's review surface is a DRAFT pull request (#62).** One per chunk,
  created or updated after every landing push; sandbar never re-drafts a PR a
  human made ready. `src/chunk-pr.ts` owns the prose and what it may claim.
- **A changes-requested review on that PR becomes an ISSUE in the same chunk
  (#63).** One issue per review, bodied with the review's unresolved threads and
  `## Blocked by` the chunk's tips — which is what joins it to the chunk (#58),
  gates it (#57) and holds it behind the code the review is about (#59, #61).
  The idempotence record is a LEDGER COMMENT on the PR, never the follow-up
  issue's own state, and sandbar never resolves a thread;
  `src/chunk-follow-up.ts`'s header owns both arguments and what the planner
  has to supply the scan.
- **`land` on the chunk PR is what lands it (#64).** A label rather than an
  approval, so approve-now-land-later stays available, and on the PR because
  that is where the reviewer is standing. It is a QUEUE: a merge the resolve
  loop could not save takes the label off and says why, while anything that
  says nothing ABOUT the chunk — a push race, an unreachable forge, an origin
  that could not be asked — leaves it on for the next run. That last one is why
  `fetchChunkRef` answers in three states (`ChunkRefLookup`), buying "origin
  has no such branch" apart from "origin could not be asked" with an
  `ls-remote` probe. A request for a chunk PHASE A JUST GREW is DEFERRED rather
  than honoured or parked (#61 plans a layer per cycle): landing it would put
  commits a review never covered on the source branch, so the label stays and
  the next quiet cycle lands it. Members are closed EXPLICITLY (a `Closes #N` trailer only
  fires on GitHub's own merge of that PR, and sandbar composes the merge
  locally), in `LandedChunk.closeOrder` — dependents first, ROOT LAST — and the
  loop stops at the first failure: the reconciler finds a kept branch by its
  NAME, which is re-derived from the open issues every cycle, so a closed root
  re-roots the chunk and leaves that branch matching nothing. The chunk branch
  is deleted only once every close worked — a kept branch is what makes
  `src/chunk-reconcile.ts` retry the remainder next cycle, and therefore what
  `run.ts` halts on (`chunkResidue` splits a wrap-up's leftovers on exactly
  that question, `unnamed` included; only the merge-phase report halts, since
  the reconciler IS the retry). The reconciler is also the answer to a
  hand-merged PR: it runs at plan time, tests containment in
  `origin/<sourceBranch>` rather than intent, and does the identical wrap-up
  without the merge. `src/chunk-land.ts`'s header owns the rest.
- **Single-instance lock per workdir**, taken *before* preflight, with a
  `run.pid` sidecar for stale-PID takeover (#32). `src/lock.ts`.
- **One cleanup registry owns signals and the exit (#35).** No module but
  `src/cleanup.ts` may trap a signal or exit on one. Anything created in a
  loop registers with `registerDisposable` and withdraws itself when its
  idempotence latch flips (#55).
- **Credentials are a value, not a path (#38).** `config.env` is an allowlist
  record (empty value ⇒ inherit from `process.env`); `readEnvFile` is the
  opt-in loader. `src/env.ts`. A credential whose vendor interface is a FILE is
  not an exception (#73): codex's ChatGPT subscription IS
  `codex login`'s `~/.codex/auth.json`, so `CODEX_AUTH_JSON` carries that file's
  CONTENT — the config is a program and reads its own host copy — and the
  provider writes it into the sandbox's `$HOME` **only if absent**, because
  codex refreshes tokens in place and a re-seed would restore one the refresh
  rotated away. Not a bind mount: that would be a writable channel from a
  sandbox back onto the host's credential, with three parallel sandboxes as
  concurrent writers on one file.
- **A role names its CLI as well as its model (#19, #72, #74).**
  `implementerAgent` / `reviewerAgent` / `mergerAgent`, all defaulting to
  `claude`, beside model ids
  that are per call: the reviewer has correctness and follow-up ids under its
  one provider because sessions cannot cross vendor CLIs. The tiering knob and
  the vendor knob are independent, and
  every provider takes whatever id its role's field holds — which is why a role
  routed off claude must NAME its model (`assertRoleModelIdNamed`), the default
  being a claude alias and a half-moved config otherwise asking codex for
  "opus" on every attempt. `AgentProvider`
  (`src/agent-sandbox.ts`) was already the whole seam — argv plus a line parser,
  with the completion watch, the idle timeout and commit collection reading
  parsed events and git — so `codex` is a second implementation of it and
  nothing downstream knows which ran. `src/agent-providers.ts` owns the
  NAME→factory map, each provider's credential and `requiredAgentProviders`;
  its header owns why the set is CLOSED at what the driver can build (a config
  is a program, so a name nothing implements is #66's silent failure).
  Preflight refuses per routed provider across all three roles. The resolve
  invocation uses the same provider boundary for argv, credential env and
  parsed output while keeping its raw streams verbatim in attempt logs. A
  provider's parser answers in THREE registers and the rule no new one may break
  is that they stay apart: `text`/`result` is the agent's SPEECH and the only
  thing a run returns (#41 — "completed with output" is what `reviewer-run.ts`
  reads as a verdict, so codex's `reasoning` is dropped and `parsedOutputOnly`
  keeps raw JSONL out); `failure` is the provider naming a TERMINAL fault of its
  own; everything else — including a fault it is still recovering from — is
  transport. That last distinction is the sharp one, because `invokeAgent`
  rejects on a `failure`: codex narrates its reconnects and a transport
  downgrade over the same wire shape it uses for the fatal case, so only
  `turn.failed` may be read, and a parser that spent a `failure` on a retry
  would escalate a websocket blip to NEEDS-HUMAN. What the register buys is the
  CAUSE leading the `AgentError` detail — a dead key exits 1 with the give-up
  reason buried under a dozen tracing lines — and, since no CLI documents its
  exit codes, #67's rule for a terminal failure under an exit-0 process: infra,
  not an answer (read as an answer it is a nudge, an attempt, and eight more of
  them). **The branch owns the environment; the run owns the tools (#75).**
  After resolving the declared sandbox image or a per-branch variant, the
  driver appends exactly the routed CLIs at pins owned by
  `AGENT_PROVIDER_PACKAGES`; an old branch recipe can therefore change its
  dependencies but cannot remove this run's agent. The merger uses the same
  augmented declared image, while gate containers keep the unaugmented base
  because they run no agent. Both pins move with the driver, and codex's is
  specifically co-versioned with its load-bearing `parsedOutputOnly` parser.
  `PROVIDER_CREDENTIALS` is ANY-OF per provider, which is
  what let #73 add codex's subscription as data; what a second accepted key
  needed beyond data is `billingPrecedenceWarnings`, because a CLI handed both a
  metered key and a subscription picks the metered one ITSELF (both vendors do)
  and the only symptom is a bill. A warning, never a refusal — both configs run,
  and sandbar cannot know which account the operator meant to spend.
- **Token contracts.** Implementer: `<promise>COMPLETE|NEEDS-INFO|
  NEEDS-UI-PROTOTYPE</promise>`; resolve loop: `COMMITTED|ABANDON`; anything
  else re-prompts. Reviewer: `<verdict>APPROVED|CHANGES-REQUESTED</verdict>`,
  defaulting to CHANGES-REQUESTED only for a run that produced output (#41).
  The orchestrator gates between attempts; agents never decide "green".
- **Prompt prose lives in `prompts/*.md`**, loaded by `src/prompts.ts`; TS
  keeps only structure. Every git range a prompt renders anchors at the issue
  branch's SEED REF, never a bare branch name (#40, #61) — `src/prompt.ts`.
- **Logs are append-only and unbuffered** (`src/logs.ts`), and **from the
  moment sandbar holds the lock there is a record (#70)**. `startRunLogger`
  runs immediately after `acquireLock` — not fifteen steps later, after
  preflight and the image builds — so every startup refusal lands in
  `run-<stamp>/orchestrator.log` instead of only on a terminal; `run.ts` names
  the three exits deliberately left outside it — a refused config and a missing
  `GH_TOKEN`, both decided before the lock is won, and losing the lock, whose
  answer is the other run's log. The
  invariant `logs.ts`'s header owns: every line reporting an OUTCOME or a
  REFUSAL exists in the log, and the terminal may additionally render it. Two
  streams, not one tee — the log keeps the per-attempt gate/reviewer trace
  stdout must never carry, and stdout keeps titled renderings that would make
  the log unreadable.
- **The resolve loop leaves a trace, and a container that never ran halts
  (#67).** Every attempt's stdout AND stderr go to
  `cycle-N/resolve-<key>-attempt-<k>.log`, keyed like the gate artefact beside
  it, and the merger log line carries the container, the exit code, the
  duration and which of timeout / clean exit / signal ended it. An attempt that
  captured NO agent speech is an infra failure, not an answer: the loop throws
  rather than re-prompting, so an image that is gone or a refused socket cannot launder
  itself into "the agent tried and failed" and spend the budget doing it. The
  ONE exception is the ten-minute `RESOLVE_AGENT_TIMEOUT_MS`, which ran the
  whole budget in the container and is a spent attempt named as one. What a
  human reads afterwards — the abandon comment on the issue, or on the parked
  chunk's PR — carries the conflicted paths, the per-attempt outcome and the
  log paths. `src/resolve-loop.ts`'s header owns the argument.
- **The version collision is settled before the agent is asked (#68).** Every
  commit here moves `version` in `package.json` and its two mirrors in
  `package-lock.json` (AGENTS.md), so two branches landing in one cycle conflict
  there BY CONSTRUCTION. `resolveVersionCollision` in `src/merger.ts` resolves
  it mechanically ahead of `runResolveLoop`, at `max(ours, theirs)` bumped once
  — a value neither side carries — and commits the merge itself when nothing
  else was conflicted, so the clean path's `npmInstall` still owns lockfile
  consistency. `src/version-conflict.ts` is the pure derivation and its header
  owns the scope: PER FILE, root `package.json`/`package-lock.json` only, and
  only when every hunk is a lone version line AND the two reconstructed sides
  differ at nothing but the paths npm mirrors — the second check is what keeps
  a dependency's identically-shaped `"version"` line out of it. Anything else
  reaches the agent untouched, and `prompts/resolve-conflict.md` states the same
  `max + 1` rule for when it does.
- **A run opens by naming what is driving it (#69).** One line on stdout and in
  `orchestrator.log`: version, the tree `dist/` was built from, the config
  file's path, and whether either tree is dirty. Two trees because there are
  two, and since #66 they differ in kind: the driver is an installed release
  (gitignored, so it reports `unknown` and its VERSION is the identification),
  while the config is still the operator's working-tree file and is the one that
  can be dirty. A fact, never a warning, never a refusal, and every field
  degrades to `unknown`. `src/driver-identity.ts` owns the two-tree argument and
  the `check-ignore` guard that keeps a driver under `node_modules` from being
  attributed to the host repo's HEAD; `run(config, { configPath })` is how the
  bin tells it which file it loaded.
- **A config declares the oldest driver that can read it (#66).**
  `requiresSandbar`, a plain `X.Y.Z` minimum; a driver below it refuses the run
  naming both versions, inside `resolveConfig` and ahead of every other field.
  The failure it closes is silent by construction — the config is imported, not
  parsed, so a field written for a newer sandbar is spread through and never
  looked at — and an unknown-key allowlist is the wrong instrument for it: the
  config is a PROGRAM and may carry extra data. Optional, because requiring it
  would break every config already written. `src/requires-sandbar.ts` owns the
  argument, including why an unidentifiable driver fails the check.

## This repo runs itself (#39)

`sandbar.config.mjs` at the root is the host-side surface, `Containerfile`
builds the one image, `sandbar.env` (gitignored) holds credentials, `sandbar.pin`
names the release that drives a run, and `npm run sandbar`
(`scripts/sandbar-launch.mjs`) is the launcher — a loop (#65): install the pin,
run it, and around again only on exit 75.

- **The driver is PINNED, not built from the checkout (#66).** The launcher
  installs the tag `sandbar.pin` names into `.sandbar/driver/` and runs that, so
  a series is driven by a release somebody chose and an operator may hold local
  commits and uncommitted edits while it runs. It does not pull. An install that
  fails stops the loop rather than falling back to what is on disk, and a
  matching stamp is skipped, so a relaunch runs a byte-identical driver. The
  price is that an orchestrator or PROMPT change takes effect only when the pin
  moves — which is how every consumer already experiences sandbar; iterate
  unlanded code with `npm run build && node dist/cli.js` by hand. The pin
  therefore LAGS the checkout always: `auto-tag.yml` tags package.json's version
  at the pushed head and the merger lands a whole pass in one push, so the
  version being written here is not installable and may never be tagged at all.
  Moving it is its own later commit; `launcher.test.ts` asserts the pin is
  strictly older than package.json's version and satisfies the config's
  `requiresSandbar`. `scripts/sandbar-launch.mjs`'s header owns the four
  decisions, `sandbar.pin`'s the lag rule.
- **What still comes from the checkout is the CONFIG** (and `sandbar.env` beside
  it, and the launcher). It must: the config resolves against the process cwd
  and `sandbar.env` against its own `import.meta.url`. So "driven by a pinned
  commit" is true of the orchestrator and its prompts and NOT of `gateStack`;
  `requiresSandbar` is the guard on the version seam that creates, and #69's
  opening line is what shows a dirty one. `npm run driver` installs the pin
  without starting a series — which the hand paths need, since the config
  imports `readEnvFile` from the driver rather than from `./dist/`.
- **Nothing refreshes that checkout, and that is the price of #66.** The
  launcher's `git pull` is gone — which is what lets a series run while the
  operator holds local commits — so a landed `gateStack` change starts judging
  branches when a human pulls it, NOT one relaunch later; `relaunchAfterLanding`
  survives for the images, not for the config (`exit-conditions.ts`,
  `config.ts`). Unreported that is silent for an unbounded number of relaunches,
  so preflight's `staleConfigWarning` counts the commits the checkout is behind
  `origin/<sourceBranch>` that touch the config FILE — narrower than "behind" on
  purpose, since after every landing a checkout is behind and a warning that
  always fires is one nobody reads. Counted in the CACHE, whose origin refs
  preflight has just fetched: an operator who has not pulled has not fetched
  either, so their own `origin/<sourceBranch>` would answer for the run before
  the landing. `preflight.ts`'s header owns both halves.

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
- **`mergeMode` stays `direct` (#39)** — personal project; tests run on host
  machines, not hosted CI.
- **Serialize issues touching `run.ts`/`inner-loop`/`merger`** (blocked-by
  chains, not parallel). #66 softened the blast radius — a merged regression is
  not the driver until the pin moves — but a queued chain still lands slice N+1
  on top of slice N without either having driven anything, and the gate stack
  judging both is this checkout's config either way.
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
