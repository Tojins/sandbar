# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — compile `src/` → `dist/` via `tsc` (also runs on `prepare`).
- `npm run check` — type-check only (`tsc --noEmit`). No lint tool is configured; this is the only static gate.
- `npm test` — run the Vitest suite (`vitest run`, non-watch).
- `npx vitest run src/plan-resolver.test.ts` — run a single test file. Add `-t "<name>"` to filter by test name.

Node ≥ 20 is required. The package is ESM (`"type": "module"`); imports inside `src/` use the `.js` extension even when the on-disk file is `.ts` (NodeNext resolution).

## What this package is

`@offergeist/sandbar` is a **library**, not a CLI. It exports `run(config: RunConfig)` from `src/index.ts`. A host repo wires it up by supplying its own `Containerfile`, env file, anchor docs (`CLAUDE.md`, `CONTEXT.md`, optional ADR dir), and gate commands. The reviewer's coding standards ship built-in (`prompts/coding-standards.md`); a host may optionally extend them with its own `CODING_STANDARDS.md` (`config.codingStandardsPath`) but is not required to. Sandbar then drives an issue-tracker-driven (GitHub Issues via `gh`) coding-agent loop against that host.

## Architecture — the four-phase outer loop

The orchestrator (`src/run.ts`) cycles plan → execute → merge → finalise until an exit condition fires. Each phase has a dedicated module and the dataflow between them is intentionally narrow.

1. **Phase 1 — Plan** (`src/plan-resolver.ts`): purely deterministic. Lists GitHub issues labelled `ready-for-agent`, parses each body's `## Blocked by` section, and selects the top-K unblocked issues (default 3) sorted by issue number. No LLM involvement.

2. **Phase 2 — Inner loop** (`src/inner-loop.ts` + `src/inner-loop-machine.ts`): each planned issue runs in parallel (`Promise.allSettled`) inside its own agent sandbox + per-issue Postgres sidecar + podman network. The inner loop is ralph-style — up to `maxImplAttempts` (default 8) attempts in the **same** sandbox so commits accumulate on the issue branch.
   - All transitions live in a pure state machine (`inner-loop-machine.ts`); `inner-loop.ts` is I/O glue that executes the action the SM emits and feeds the result back as an event.
   - Per attempt: build 3-layer prompt → run implementer agent → parse `<promise>` token (`promise-parser.ts`) → if `COMPLETE`, run **gate-1** (host's `check` + `test` in a one-shot container, `gate.ts`). On gate-1 green, run the **reviewer** — strictly advisory, never commits — which emits `<verdict>APPROVED|CHANGES-REQUESTED</verdict>` (parsed by `verdict-parser.ts`). On `APPROVED` → `DONE`. On `CHANGES-REQUESTED`, the prose is stashed and the loop runs another implementer attempt with the prose surfaced in its prompt.
   - **Two orthogonal budgets.** Each implementer pass consumes one of `maxImplAttempts`; each reviewer pass consumes one of `maxReviewRounds` (default 3). Exhausting impl attempts → `NEEDS-HUMAN` (last gate trace). Exhausting review rounds → `NEEDS-HUMAN-REVIEW` (latest reviewer prose).
   - **HARD-ERROR is for infra failures only.** The SM never emits it; the runner wraps unhandled exceptions (setup, container) as HARD-ERROR so the outer-layer `decideAfterTerminal` can retry with a fresh sandbox (up to `HARD_ERROR_MAX_RETRIES = 2`).
   - Terminals: `DONE | NEEDS-INFO | NEEDS-HUMAN | NEEDS-HUMAN-REVIEW | HARD-ERROR`.

3. **Phase 3 — Merge** (`src/merger.ts` + `src/resolve-loop.ts` + `src/merger-worktree.ts`): procedural, direct-to-source-branch. Runs in a **dedicated ephemeral worktree** detached at `origin/<sourceBranch>` (`createMergerWorktree`), never the operator's primary checkout — so uncommitted operator edits can't be swept into a merge commit (issue #10). For each DONE branch in ascending issue order: capture `preMergeSha`, `git merge --no-ff`, then either succeed and push, or invoke the **agentic resolve loop** for conflict OR post-merge-gate-red. The resolve loop sees the bodies of all sibling issues in the cycle so it can reason about cross-branch intent collisions. On `<promise>ABANDON</promise>` or budget exhaustion, the merge is reverted to `preMergeSha` and the branch is skipped. A single `git push origin HEAD:<sourceBranch>` at the end; the operator's local branch fast-forwards on their next pull.

4. **Phase 4 — Finalise** (`src/finalize.ts`): per-issue branch lifecycle (push/delete worktree + branch), bot-prefixed issue comments, label flips (`ready-for-agent` ↔ `needs-info`/`needs-human`/`ready-for-human`). Pure orchestration via `FinalizeAdapter`; the real adapter shells out to `git`/`gh`. The `review-budget-exhausted` input pushes the branch and posts the **latest reviewer prose only** (not the per-round transcript — that stays in the run-log for offline diagnosis).

### Exit conditions (`src/exit-conditions.ts`)

The outer loop terminates on the first of:
- **plan-empty** → success (exit 0)
- **stuck-same-plan** — same plan as previous cycle AND 0 DONEs this cycle (exit 2)
- **stuck-zero-dones** — `MAX_CONSECUTIVE_ZERO_DONE_CYCLES = 2` (exit 2)
- **budget** — `issuesAttempted >= maxTotalIssues` (default 50, exit 3)

`MAX_ITERATIONS = 100` in `run.ts` is a defensive ceiling — the conditions above terminate first.

`SILENT_NOOP_RETRY_LIMIT = 2` caps per-issue retries when the resolve-loop reports `resolved` but HEAD did not advance (the "silent `git merge --abort`" failure mode). Under the cap, the branch is discarded and the issue stays `ready-for-agent` for the next cycle's planner.

## Key design constraints

- **Pure decision functions where possible.** The inner-loop state machine (`step`, `decideAfterTerminal`), `parsePromise`, `parseVerdict`, `renderReviewerSlot`, `resolvePlan`, `applyCycle`, `checkInvariants`, `finalizeOne` are all pure functions over their inputs. I/O wrappers (`fetchCandidates`, `realAdapter`, etc.) are thin shells around them. Add tests against the pure layer; don't mock `gh`/`git` if you can table-test the decision instead.
- **Adapters for I/O boundaries.** `MergerAdapter`, `FinalizeAdapter`, `ResolveAdapter` define the contract; tests use fakes, production uses `realAdapter(...)`. Don't reach for `execFile` from new code if there's an adapter slot.
- **Per-issue isolation.** Every issue gets its own podman network + Postgres sidecar (named `sandbar-net-<id>` / `sandbar-pg-<id>`); the gate container joins the network and resolves the sidecar by container name (no host port). `cleanupOrphanContainers` sweeps stale prefixed resources at start and between cycles. The naming prefixes are centralized in `src/naming.ts`, which also lists the legacy `sandcastle-*`/`sandcastle/*` prefixes the sweep/clean paths still recognize during the transition window.
- **Container runtime is podman.** Hard-coded `RUNTIME = "podman"` in `pg-sidecar.ts`; the agent sandbox uses the in-house `podman()` provider (`src/agent-sandbox.ts`). The Postgres image is `docker.io/pgvector/pgvector:pg18` (fully qualified because hosts without unqualified-search registries can't resolve a bare short name).
- **Branch naming is load-bearing.** `sandbar/issue-<n>-<kebab-slug>` (prefix in `src/naming.ts`) — the preflight cleanup, orphan sweeper, and worktree path computation (`worktreePathFor`) all rely on this prefix. Don't change it casually.
- **Issue branches seed from `origin/<sourceBranch>`,** not local. The preflight emits a soft warning when local is ahead of origin because per-issue worktrees won't see unpushed work.
- **Single-instance lock.** `src/lock.ts` uses `proper-lockfile` plus a PID sidecar for stale-PID takeover. Don't try to run two sandbar processes against the same workdir.
- **Promise-token contract.** Agents signal state with a single `<promise>TOKEN</promise>` tag. Implementer: `COMPLETE` | `NEEDS-INFO` (paired with `<questions>`). Resolve-loop: `COMMITTED` | `ABANDON` (paired with `<reason>`). Anything else is a no-signal — the loop re-prompts. The orchestrator gates *between* attempts; the agent never decides "this is green".
- **Verdict-token contract.** The reviewer emits a single `<verdict>APPROVED|CHANGES-REQUESTED</verdict>` tag (parsed by `verdict-parser.ts`). Missing or malformed token defaults to `CHANGES-REQUESTED` — convergence relies on the bar being sharp, i.e. on the coding standards (the built-in `prompts/coding-standards.md`, plus any project `CODING_STANDARDS.md` that extends them) being precise enough to be deterministic, not on round-trip retries. The reviewer is read-only: prompt instructs it not to modify the branch, commit, push, or run gates.
- **Prompt prose lives in `prompts/*.md`, not in code.** `src/prompts.ts` loads templates and does `{{placeholder}}` substitution; `prompt.ts` and `resolve-loop.ts` load them into module-level consts at import and fill the placeholders. Keep substantive instructional prose in the markdown files; only structural scaffolding (headings, code-fence wrapping, data interpolation, which optional block to include) stays in TS. The `prompts/` dir sits beside `src/`/`dist/` so the same `../prompts` path resolves from both, and is shipped via package.json `files`.
- **Logs are append-only and unbuffered** (`src/logs.ts`). Crash-safe by construction; don't introduce in-memory buffering.

## When making changes

- **Strict TypeScript** — `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`. Array/Map lookups are `T | undefined`; handle accordingly.
- **`*.test.ts` files are excluded from `tsc`** (see `tsconfig.json`) but checked by `vitest`. The strict type-checking gate is on production code only.
- **Always import with `.js` extensions** even from `.ts` files — NodeNext resolution.
- Module headers (the long comments at the top of `src/*.ts`) are the authoritative architecture notes per module. Update them when behavior changes; future Claude reads them first.
