// Outer-loop budget + exit conditions.
//
// The orchestrator runs cycles of plan → execute → merge → finalise until one
// of four conditions terminates the run:
//
//   (a) plan-empty       — no unblocked work this cycle. Success exit (0).
//   (b) stuck-same-plan  — same plan as previous cycle AND 0 DONEs this cycle.
//   (c) stuck-zero-dones — two consecutive cycles produced 0 DONEs.
//   (d) budget           — issuesAttempted hits state.maxTotalIssues.
//
// (a) is checked at the top of each cycle (after building the plan); the
// orchestrator handles it directly with a clean break. (b)/(c)/(d) are pure
// decisions over the run state plus the just-completed cycle, evaluated by
// applyCycle in that order. remainingBudget is the pre-cycle hook the
// orchestrator uses to trim the plan so no cycle can push issuesAttempted
// past the cap mid-run.

import { DEFAULT_MAX_TOTAL_ISSUES } from "./config.js";

export const MAX_CONSECUTIVE_ZERO_DONE_CYCLES = 2;
// Cap on how many times the same issue can hit silent-noop in one run before
// we escalate to human-attention. Each silent-noop attempt deletes the branch
// and lets the next cycle's planner re-pick the issue (fresh implementation
// against current main). After K such attempts we accept that the integration
// drift won't heal on its own.
export const SILENT_NOOP_RETRY_LIMIT = 2;

export const EXIT_CODE_SUCCESS = 0;
export const EXIT_CODE_STUCK = 2;
export const EXIT_CODE_BUDGET = 3;

export type ExitTag = "stuck-same-plan" | "stuck-zero-dones" | "budget";

export type ExitDecision =
  | { readonly kind: "continue" }
  | {
      readonly kind: "exit";
      readonly tag: ExitTag;
      readonly reason: string;
      readonly exitCode: number;
    };

export type RunState = {
  issuesAttempted: number;
  lastPlanFingerprint: string | null;
  consecutiveZeroDoneCycles: number;
  // Per-issue silent-noop counter. The merger increments this whenever the
  // resolve-loop reports "resolved" but HEAD didn't advance (the agent gave
  // up via `git merge --abort` and returned). Reset across runs by design —
  // a human re-running sandbar implicitly authorises a fresh budget.
  silentNoopAttemptsByIssue: Map<string, number>;
  readonly maxTotalIssues: number;
};

export type CycleOutcome = {
  readonly planFingerprint: string;
  readonly planSize: number;
  readonly doneCount: number;
};

export function newRunState(opts: { maxTotalIssues?: number } = {}): RunState {
  return {
    issuesAttempted: 0,
    lastPlanFingerprint: null,
    consecutiveZeroDoneCycles: 0,
    silentNoopAttemptsByIssue: new Map(),
    maxTotalIssues: opts.maxTotalIssues ?? DEFAULT_MAX_TOTAL_ISSUES,
  };
}

// Stable, order-insensitive fingerprint of a plan's issue ids. Two plans with
// the same set of issues compare equal regardless of input order.
export function planFingerprint(issueIds: readonly string[]): string {
  return [...issueIds]
    .map((s) => Number(s))
    .sort((a, b) => a - b)
    .join(",");
}

// Remaining headroom under the global cap. Used to trim the plan pre-cycle so
// no cycle can enter phase 2 with more issues than the budget allows.
export function remainingBudget(state: RunState): number {
  return Math.max(0, state.maxTotalIssues - state.issuesAttempted);
}

// Update the run state with the just-completed cycle's outcome and decide
// whether to continue or exit. The state mutation is intentional — the
// orchestrator owns one RunState across the run.
export function applyCycle(state: RunState, cycle: CycleOutcome): ExitDecision {
  const previousFingerprint = state.lastPlanFingerprint;

  state.issuesAttempted += cycle.planSize;
  if (cycle.doneCount === 0) {
    state.consecutiveZeroDoneCycles += 1;
  } else {
    state.consecutiveZeroDoneCycles = 0;
  }
  state.lastPlanFingerprint = cycle.planFingerprint;

  // (b) stuck — identical plan to the previous cycle and no progress this one.
  if (
    previousFingerprint !== null &&
    previousFingerprint === cycle.planFingerprint &&
    cycle.doneCount === 0
  ) {
    return {
      kind: "exit",
      tag: "stuck-same-plan",
      reason: `plan ${cycle.planFingerprint} repeated with 0 DONEs`,
      exitCode: EXIT_CODE_STUCK,
    };
  }

  // (c) stuck — two zero-DONE cycles back-to-back regardless of plan equality.
  if (state.consecutiveZeroDoneCycles >= MAX_CONSECUTIVE_ZERO_DONE_CYCLES) {
    return {
      kind: "exit",
      tag: "stuck-zero-dones",
      reason: `${state.consecutiveZeroDoneCycles} consecutive cycles with 0 DONEs`,
      exitCode: EXIT_CODE_STUCK,
    };
  }

  // (d) budget — global cap on phase-2 entries.
  if (state.issuesAttempted >= state.maxTotalIssues) {
    return {
      kind: "exit",
      tag: "budget",
      reason: `issuesAttempted=${state.issuesAttempted} >= maxTotalIssues=${state.maxTotalIssues}`,
      exitCode: EXIT_CODE_BUDGET,
    };
  }

  return { kind: "continue" };
}
