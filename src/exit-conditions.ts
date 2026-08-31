// Outer-loop budget + exit conditions.
//
//   (a) plan-empty       — no unblocked work this cycle. Success exit (0).
//   (b) stuck-same-plan  — same plan as previous cycle AND 0 DONEs this cycle.
//   (c) stuck-zero-dones — two consecutive cycles produced 0 DONEs.
//   (d) budget           — issuesAttempted hits state.maxTotalIssues.
//   (e) relaunch         — the cycle LANDED merges and the config asks for
//                          relaunch-after-landing (#65).
//
// (a) is checked at the top of each cycle; the orchestrator handles it
// directly. applyCycle evaluates (e) first, then (b)/(c)/(d). (e) before (d)
// is the one ordering that carries weight: budgets are per-run and reset
// across runs by design, so a cycle that both landed and exhausted the budget
// relaunches rather than stopping. No spin hides in that: (e) requires a
// landing, and a cycle that lands nothing falls through to codes that break
// the launcher's loop. remainingBudget is the pre-cycle hook the orchestrator
// uses to trim the plan so no cycle can push issuesAttempted past the cap
// mid-run.

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
// "Landed work; relaunch me to continue" (#65). A launcher that loops on
// exactly this code closes the staleness window a self-hosted series opens: a
// cycle that lands orchestrator commits leaves the running process driving on
// what it resolved at launch, where judge and judged come from different eras.
//
// What that covers narrowed with #66 and the flag survives it, which is worth
// keeping straight: `dist/` no longer moves at all — the driver is an installed
// release the repo pins, so a landing does not become the driver until a human
// moves the pin — while the CONFIG (the gate stack!) is `import()`ed once at
// launch and `ensureImages` runs once per run, so a landed change to either
// still reaches a series only through the relaunch.
//
// 75 is sysexits' EX_TEMPFAIL ("temporary failure; retry"), which is the
// meaning, and it is clear of the run's own 0/1/2/3 and of the shell's reserved
// 126+. The number is repeated by hand in `scripts/sandbar-launch.mjs`, which
// runs before the package it would import exists; `launcher.test.ts` asserts
// the two spellings equal, and the README's launcher description moves with a
// change here.
export const EXIT_CODE_RELAUNCH = 75;

export type ExitTag =
  | "stuck-same-plan"
  | "stuck-zero-dones"
  | "budget"
  | "relaunch";

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
  // Exit (e) after any cycle that lands merges, instead of continuing on the
  // launch-time build (#65). Config rather than state, like maxTotalIssues —
  // carried here so applyCycle stays the single owner of the exit ordering.
  readonly relaunchAfterLanding: boolean;
};

export type CycleOutcome = {
  readonly planFingerprint: string;
  readonly planSize: number;
  readonly doneCount: number;
  // Merges the merger pushed to origin this cycle; 0 when the merge phase did
  // not run, did not push, or the cycle was reset (verified mode). REQUIRED
  // rather than defaulted, because the one caller forgetting to thread it
  // would disable relaunch silently — the run would just keep driving on the
  // stale build, which is #65's own bug wearing the fix.
  readonly landedMerges: number;
};

export function newRunState(
  opts: { maxTotalIssues?: number; relaunchAfterLanding?: boolean } = {},
): RunState {
  return {
    issuesAttempted: 0,
    lastPlanFingerprint: null,
    consecutiveZeroDoneCycles: 0,
    silentNoopAttemptsByIssue: new Map(),
    maxTotalIssues: opts.maxTotalIssues ?? DEFAULT_MAX_TOTAL_ISSUES,
    relaunchAfterLanding: opts.relaunchAfterLanding ?? false,
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

  // (e) relaunch — the cycle landed merges, so the source branch has moved and
  // this process is now driving with a `dist/`, a config and a Containerfile
  // from before the landing. Checked FIRST (see the header for why it beats
  // the budget): a landing is the one outcome that guarantees progress, so
  // exiting here can never spin the launcher's loop.
  if (state.relaunchAfterLanding && cycle.landedMerges > 0) {
    return {
      kind: "exit",
      tag: "relaunch",
      reason:
        `landed ${cycle.landedMerges} merge(s); relaunching so the driver ` +
        "is what it just landed",
      exitCode: EXIT_CODE_RELAUNCH,
    };
  }

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
