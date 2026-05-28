# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — compile `src/` → `dist/` via `tsc` (also runs on `prepare`).
- `npm run check` — type-check only (`tsc --noEmit`). No lint tool is configured; this is the only static gate.
- `npm test` — run the Vitest suite (`vitest run`, non-watch).
- `npx vitest run src/plan-resolver.test.ts` — run a single test file. Add `-t "<name>"` to filter by test name.

Node ≥ 20 is required. The package is ESM (`"type": "module"`); imports inside `src/` use the `.js` extension even when the on-disk file is `.ts` (NodeNext resolution).

## What this package is

`@offergeist/sandbar` is a **library**, not a CLI. It exports `run(config: RunConfig)` from `src/index.ts`. A host repo wires it up by supplying its own `Containerfile`, `CODING_STANDARDS.md`, env file, anchor docs (`CLAUDE.md`, `CONTEXT.md`, optional ADR dir), and gate commands. Sandbar then drives an issue-tracker-driven (GitHub Issues via `gh`) coding-agent loop against that host.

## Architecture — the four-phase outer loop

The orchestrator (`src/run.ts`) cycles plan → execute → merge → finalise until an exit condition fires. Each phase has a dedicated module and the dataflow between them is intentionally narrow.

1. **Phase 1 — Plan** (`src/plan-resolver.ts`): purely deterministic. Lists GitHub issues labelled `ready-for-agent`, parses each body's `## Blocked by` section, and selects the top-K unblocked issues (default 3) sorted by issue number. No LLM involvement.

2. **Phase 2 — Inner loop** (`src/inner-loop.ts`): each planned issue runs in parallel (`Promise.allSettled`) inside its own sandcastle sandbox + per-issue Postgres sidecar + podman network. The inner loop is ralph-style — up to `maxImplAttempts` (default 8) attempts in the **same** sandbox so commits accumulate on the issue branch.
   - Per attempt: build 3-layer prompt → run implementer agent → parse `<promise>` token (`promise-parser.ts`) → if `COMPLETE`, run **gate-1** (host's `check` + `test` in a one-shot container, `gate.ts`). On gate-1 green, run the reviewer in the same sandbox, then **gate-2** unconditionally.
   - **Gate-2 is the deciding authority.** `decideAfterGate2(gate2Ok, reviewerCommitCount)` is the pure decision function: green → `DONE`; red with reviewer commits → revert reviewer commits, accept implementer's work as `DONE`; red with no reviewer commits → `HARD-ERROR` (treated as infra flake, retried once with a fresh sandbox via `HARD_ERROR_MAX_RETRIES`).
   - Terminals: `DONE | NEEDS-INFO | NEEDS-HUMAN | HARD-ERROR`.

3. **Phase 3 — Merge** (`src/merger.ts` + `src/resolve-loop.ts`): procedural, direct-to-source-branch. For each DONE branch in ascending issue order: capture `preMergeSha`, `git merge --no-ff`, then either succeed and push, or invoke the **agentic resolve loop** for conflict OR post-merge-gate-red. The resolve loop sees the bodies of all sibling issues in the cycle so it can reason about cross-branch intent collisions. On `<promise>ABANDON</promise>` or budget exhaustion, the merge is reverted to `preMergeSha` and the branch is skipped. A single `git push` at the end.

4. **Phase 4 — Finalise** (`src/finalize.ts`): per-issue branch lifecycle (push/delete worktree + branch), bot-prefixed issue comments, label flips (`ready-for-agent` ↔ `needs-info`/`needs-human`/`ready-for-human`). Pure orchestration via `FinalizeAdapter`; the real adapter shells out to `git`/`gh`.

### Exit conditions (`src/exit-conditions.ts`)

The outer loop terminates on the first of:
- **plan-empty** → success (exit 0)
- **stuck-same-plan** — same plan as previous cycle AND 0 DONEs this cycle (exit 2)
- **stuck-zero-dones** — `MAX_CONSECUTIVE_ZERO_DONE_CYCLES = 2` (exit 2)
- **budget** — `issuesAttempted >= maxTotalIssues` (default 50, exit 3)

`MAX_ITERATIONS = 100` in `run.ts` is a defensive ceiling — the conditions above terminate first.

`SILENT_NOOP_RETRY_LIMIT = 2` caps per-issue retries when the resolve-loop reports `resolved` but HEAD did not advance (the "silent `git merge --abort`" failure mode). Under the cap, the branch is discarded and the issue stays `ready-for-agent` for the next cycle's planner.

## Key design constraints

- **Pure decision functions where possible.** `decideAfterGate2`, `parsePromise`, `resolvePlan`, `applyCycle`, `checkInvariants`, `finalizeOne` are all pure functions over their inputs. I/O wrappers (`fetchCandidates`, `realAdapter`, etc.) are thin shells around them. Add tests against the pure layer; don't mock `gh`/`git` if you can table-test the decision instead.
- **Adapters for I/O boundaries.** `MergerAdapter`, `FinalizeAdapter`, `ResolveAdapter` define the contract; tests use fakes, production uses `realAdapter(...)`. Don't reach for `execFile` from new code if there's an adapter slot.
- **Per-issue isolation.** Every issue gets its own podman network + Postgres sidecar (named `sandcastle-net-<id>` / `sandcastle-pg-<id>`); the gate container joins the network and resolves the sidecar by container name (no host port). `cleanupOrphanContainers` sweeps stale prefixed resources at start and between cycles.
- **Container runtime is podman.** Hard-coded `RUNTIME = "podman"` in `pg-sidecar.ts`; the agent sandbox uses sandcastle's `podman()` provider. The Postgres image is `docker.io/pgvector/pgvector:pg18` (fully qualified because hosts without unqualified-search registries can't resolve a bare short name).
- **Branch naming is load-bearing.** `sandcastle/issue-<n>-<kebab-slug>` — the preflight cleanup, orphan sweeper, and worktree path computation (`worktreePathFor`) all rely on this prefix. Don't change it casually.
- **Issue branches seed from `origin/<sourceBranch>`,** not local. The preflight emits a soft warning when local is ahead of origin because per-issue worktrees won't see unpushed work.
- **Single-instance lock.** `src/lock.ts` uses `proper-lockfile` plus a PID sidecar for stale-PID takeover. Don't try to run two sandbar processes against the same workdir.
- **Promise-token contract.** Agents signal state with a single `<promise>TOKEN</promise>` tag. Implementer: `COMPLETE` | `NEEDS-INFO` (paired with `<questions>`). Resolve-loop: `COMMITTED` | `ABANDON` (paired with `<reason>`). Anything else is a no-signal — the loop re-prompts. The orchestrator gates *between* attempts; the agent never decides "this is green".
- **Logs are append-only and unbuffered** (`src/logs.ts`). Crash-safe by construction; don't introduce in-memory buffering.

## When making changes

- **Strict TypeScript** — `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`. Array/Map lookups are `T | undefined`; handle accordingly.
- **`*.test.ts` files are excluded from `tsc`** (see `tsconfig.json`) but checked by `vitest`. The strict type-checking gate is on production code only.
- **Always import with `.js` extensions** even from `.ts` files — NodeNext resolution.
- Module headers (the long comments at the top of `src/*.ts`) are the authoritative architecture notes per module. Update them when behavior changes; future Claude reads them first.
