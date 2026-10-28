# CLAUDE.md

Read @AGENTS.md first: its rules apply to every commit (starting with: bump the
version in the same commit). It is shared with the sandbar agents, which get it
as an anchor doc directly.

This file is a **map**. The authoritative design notes are the header comments
at the top of each `src/*.ts` — read the header before changing a module and
update it in the same commit when behavior changes. Rationale lives in the
cited GitHub issue (`#N`) and the commit history.

## Commands

- `npm run build` — compile `src/` → `dist/` (also runs on `prepare`).
- `npm run check` — `tsc --noEmit`; the only static gate (no linter).
- `npm test` — rebuild, then `vitest run`.
- `npx vitest run src/<file>.test.ts [-t "<name>"]` — one file / one test.

Node ≥ 20.6, ESM, NodeNext: imports in `src/` use `.js` even for `.ts` files.

**Bound test runs by killing the process GROUP, not the pid (#25).** Bare
`timeout 90 npx vitest run …` is safe; `timeout --foreground` and Python's
`subprocess.run(timeout=)` are not (use `start_new_session=True` + `os.killpg`).
After an interrupted run, check `ps -ef | grep [f]orks.js`.

## What this is

A library with a thin bin (#38): `run(config)` in `src/index.ts` is the
contract; `src/cli.ts` imports `--config` (default `./sandbar.config.mjs`) and
dispatches `gate` (#45, `src/gate-run.ts`), `ui` (#132), `pulled-images` and
`config-digest` (#190, `src/config-digest.ts`).
`npm run stats` (`src/stats-cli.ts`, #194) is a repo script, not a verb: the
factory scorecard over run records (`stats-record.ts` reads, `stats.ts`
reduces); nothing in the daemon imports it.
`npm run reflect` (`src/reflect-cli.ts`, #182/#207/#208) is another: it mines
that report (`reflect-mine.ts`) into typed clusters and outlier issues, has a
tagger and a synthesizer (`reflect.ts`, cached, sandboxed in `reflectScope`)
turn them into proposals, and writes the report (`reflect-report.ts`) under
`<stateDir>/reflect/`; `--no-agents` stops at the tables.
`scripts/stats-classify.mjs` (#209) classes the `--json --with-prose` report's
quality findings and fixer commits for #183; plain ESM, not shipped.
The config is a **program**, imported not parsed; `src/config.ts` is the one
validation boundary and owns all defaults. Sandbar drives a GitHub-Issues coding
agent loop against a consumer repo, which supplies Containerfiles, anchor docs
and the gate stack (`config.gateStack`, #24).

## Pipeline (`src/run.ts` orchestrates a continuous pool)

1. **Plan** — deterministic, no LLM. `plan-resolver.ts` (queue label, actor
   filter #136, `## Blocked by`), `lanes.ts`, `chunks.ts` (chunks are derived
   components of review-gated issues), `chunk-follow-up.ts` (PR review →
   re-queue members, #95), `chunk-reconcile.ts` (finish already-merged chunks).
2. **Inner loop** — `inner-loop-machine.ts` (pure state machine) +
   `inner-loop.ts` (I/O). One sandbox per issue: partition check (#158), UI
   check (#126), then implementer attempts → quality pass (read-only lister →
   fixer that writes commits → read-only verify, #187) → gate-1 → verifier
   (`verifier.ts`, #180; its white-box review is `reviewer-run.ts`, #41,
   patch-scoped from round 2) → adjudicator on dispute of either pass (#167).
   Budgets `maxQualityRounds`/`maxGateRounds`/`maxReviewRounds`. Read-only
   roles that write park the issue.
3. **Landing** — serialized, in an ephemeral worktree at `origin/<source>`
   (#10): `merger.ts`, `merger-worktree.ts`, `resolve-loop.ts` (#67),
   `version-conflict.ts` (#68), `forge-verify.ts` (`mergeMode`, #22),
   `chunk-land.ts` / `chunk-pr.ts` / `forge-pr.ts` (chunk branches, draft PRs,
   `land` label #64).
4. **Finalise** — `finalize.ts` + `finalize-inputs.ts`: branch publish, bot
   comments, label flips.

Daemon polling and the six exits (`stuck`, `quota`, `credential`, `storage`,
`restart`, `halted`) live in `scheduler.ts`, `exit-conditions.ts`,
`restart-request.ts` (#146), `disk-space.ts` (#169); a GitHub rate limit
holds planning until reset (`forge-rate-limit.ts`) instead of halting.
With `config.deployWatch`, polls and landings also kick the deploy watch
(`deploy-watch.ts`, #198), which never blocks the loop.

## Invariants — where they live

- **Pure decisions + adapters.** Table-test the pure layer; real git/podman
  behavior is asserted by running it (`*-git.test.ts`, `*-podman.test.ts`).
- **Never touch the operator's checkout** (#38): work happens in a bare cache
  + worktrees under `<cwd>/<workDir>` (`repo-cache.ts`, `preflight.ts`). Every
  shell-out names its repo; every `gh` call passes `--repo` (`repo-ref.ts`).
- **Isolation**: per-issue hardlink clones, scoped resource names
  (`naming.ts`, `containers.ts`); `reclaimIssueClone` in `agent-sandbox.ts` is
  the one way to remove a clone. Branch shapes are owned by `naming.ts`.
- **Origin owns issue and chunk branches** (`git-ops.ts`, `chunks.ts`).
- **Locks**: per-workdir `lock.ts` (#32), repo-wide origin lease
  `origin-lock.ts` (#139), host wake lock `keepawake.ts` (#117).
- **Signals and exit** only via `cleanup.ts` (#35).
- **Issue creation** only in `deploy-watch.ts` (#198): a red consumer deploy
  run files one `ready-for-human` bug, deduped by forge markers, no state on
  disk (`issue-create-site.test.ts`).
- **Runtime is podman** (`runtime.ts`); no podman argv ever carries an env
  value — `withRuntimeEnv` writes a 0600 env file (#154).
- **Images**: `image-inputs.ts`, `ensure-images.ts`, `agent-tools.ts` (driver
  appends git + agent CLIs, #75), `image-lifecycle.ts` (#169).
- **Gate stack**: `gate-stack.ts`, `sandbox-stack.ts` (#44); a stack file
  (`gateStack: { path }`) is read from the source tip at gate time by
  `stack-source.ts` (#186), never from the operator's clone. A branch's own
  edit to it applies to its gates only when it is env-only
  (`stack-change.ts`); any other edit parks `NEEDS-STACK-CHANGE` at gate-1
  and is reverted as skip reason `stack-change` at landing. A gate
  verdict is about a clean, on-branch commit (D1, #27, #127).
- **Providers**: `agent-providers.ts` (closed set, credentials), per-role
  agent/model/effort routing (`env.ts`, `env-file.ts`), `codex-auth.ts`.
- **Tokens**: literal-only scanning in `token-scan.ts` (#113); prompt prose in
  `prompts/*.md`, structure in `prompt.ts`/`prompts.ts`. No prompt embeds a
  diff body; ranges anchor at the seed ref (#40, #61).
  **Prompt size** is a budget kept by hand, never enforced or truncated.
  Fixed chars per role (rendered with empty data, #216): project anchor ~1.1k
  (shared by every branch role; incl. 10 commit subjects and
  `background-tasks.md`); implementer attempt slot 6.2k (2.3k of it
  `coding-standards.md`; +2.3k sandbox-stack, +1.2–1.3k gate access when
  configured); quality lister 5.0k, verify 5.3k, fixer 4.8k; verifier
  white-box 4.1k; adjudicator 1.1k + the report; UI check 1.6k and partition
  check 1.5k + the issue anchor; resolve 1.2k + anchor + paths/trace; reflect
  tagger 1.2k + the chunk, synthesizer 2.4k (no anchor). The
  issue anchor (median 5.6k, max 41k measured, #197) has sandbar's traces and
  quoted reviewer prose dropped by `issue-anchor.ts`. Look before you add a
  paragraph to any of these.
- **Event record** `events.ts` is the source of truth (#70/#132); the UI
  (`run-state.ts`, `ui-server.ts`) is a pure projection of it.
- **Timing/usage** are reports, never decision inputs, and absent ≠ 0 (#82):
  `timing.ts`, `agent-usage.ts`.
- **Identity/compat**: `driver-identity.ts` (#69), `requires-sandbar.ts` (#66).

## This repo is an installation (#146)

A commit on `main` is the deploy: the box `ansible-pull`s every five minutes,
builds into `/opt/sandbar/builds/<sha>` and requests restarts. Config and
credentials live in the sandbar user's `~/installation/`; the source is
`deploy/ansible/` (see its README). `mergeMode` stays `direct`. To exercise
unlanded code: `npm run build && node dist/cli.js --config <path>`.

- One coherent deliverable per issue; split into a `## Blocked by` chain only
  when it won't fit `maxContextChars`, never merely because it is large.
- Podman-layer tests run over the host socket; only
  `gate-stack-hostpodman`, `sandbox-stack-podman` and
  `container-resources-podman` tests are host-only.
- Tests must not depend on ambient git config or on `process.cwd()` being a
  repository — name the directory in every git call.

## When making changes

- Strict TS (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`);
  `*.test.ts` is excluded from `tsc` and checked by vitest.
- Update the module header in the same commit as the behavior it describes.
