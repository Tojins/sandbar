// Outer-loop budget + exit conditions.
//
//   (a) plan-empty        — no unblocked work this cycle. Success exit (0).
//   (b) stuck-same-plan   — same plan as previous cycle AND 0 DONEs this cycle.
//   (c) stuck-zero-dones  — two consecutive cycles produced 0 DONEs.
//   (d) budget            — issuesAttempted hits state.maxTotalIssues.
//   (e) relaunch          — the cycle LANDED merges and the config asks for
//                           relaunch-after-landing (#65).
//   (f) halted            — the run stopped on something it cannot carry on
//                           past (#70): a startup refusal, a merge phase that
//                           threw, durable work the tracker disagrees with, or
//                           an internal failure.
//   (g) iteration-ceiling — MAX_ITERATIONS cycles without any of the above.
//                           Defensive; the conditions above terminate first.
//
// applyCycle owns (b)–(e) and is a judgement about a COMPLETED cycle. (a), (f)
// and (g) are none of them — they fire before a cycle has run, in the middle of
// one, or in place of one — so the orchestrator reaches them itself and there
// is no applyCycle arm to find them in.
//
// (e) before (d) is the one ordering that carries weight: budgets are per-run
// and reset across runs by design, so a cycle that both landed and exhausted
// the budget relaunches rather than stopping. No spin hides in that: (e)
// requires a landing, and a cycle that lands nothing falls through to codes
// that break the launcher's loop. remainingBudget is the pre-cycle hook the
// orchestrator uses to trim the plan so no cycle can push issuesAttempted past
// the cap mid-run.
//
// ALL SEVEN ARE `TerminalExit`s, and `formatExitLine` is the one spelling of
// the line an operator reads (#70). That is why (a), (f) and (g) are here
// despite having no applyCycle arm: before #70 the stops the orchestrator owned
// each announced themselves in their own words — and one of them, the halt, in
// no words at all on stdout — so "did this run stop normally?" could not be
// answered from one place. The constructors below are pure and `EXIT_TAGS` is
// exhaustive over the union, so a tag with no line, or a line with no tag,
// fails exit-conditions.test.ts rather than being noticed six weeks later in a
// log that never mentioned it.

import { DEFAULT_MAX_TOTAL_ISSUES } from "./config.js";

export const MAX_CONSECUTIVE_ZERO_DONE_CYCLES = 2;
// Cap on how many times the same issue can hit silent-noop in one run before
// we escalate to human-attention. Each silent-noop attempt deletes the branch
// and lets the next cycle's planner re-pick the issue (fresh implementation
// against current main). After K such attempts we accept that the integration
// drift won't heal on its own.
export const SILENT_NOOP_RETRY_LIMIT = 2;

export const EXIT_CODE_SUCCESS = 0;
// The code every stop that is not a normal terminal already exited with — a
// startup refusal, a merge-phase halt, an internal failure. Named here (#70)
// only so `haltedExit` can spell it the way its siblings do; no exit path's
// code changes.
export const EXIT_CODE_HALTED = 1;
export const EXIT_CODE_STUCK = 2;
export const EXIT_CODE_BUDGET = 3;
// "Landed work; relaunch me to continue" (#65). A launcher that loops on
// exactly this code closes the staleness window a self-hosted series opens: a
// cycle that lands orchestrator commits leaves the running process driving on
// what it resolved at launch, where judge and judged come from different eras.
//
// What that covers narrowed with #66, in two different ways, and the flag
// survives both — worth keeping straight, because the three objects it used to
// refresh now behave differently from each other. Read the three as a
// description of SANDBAR'S OWN launcher and not as a contract: this flag is
// library config, it requires no pin, and a consumer whose loop is `git pull &&
// npm run build` (README) still refreshes all three. That is why the exit
// `reason` below names the two THIS run re-resolves and leaves the driver to
// whoever wrote the loop.
//
//   - `dist/` no longer moves at all. The driver is an installed release the
//     repo pins, so a landing does not become the driver until a human moves
//     the pin.
//   - IMAGES are still the reason this flag exists. `ensureImages` runs once
//     per run against a source worktree reset to `origin/<sourceBranch>`, so a
//     landed `Containerfile` reaches a series through the relaunch and through
//     nothing else.
//   - the CONFIG is `import()`ed once at launch (cli.ts), so a relaunch does
//     re-read it — but from the operator's CHECKOUT, which nothing refreshes
//     now that the launcher has stopped pulling. A landed `gateStack` change
//     therefore arrives when a human pulls it and not when the run relaunches.
//     That is the deliberate price of #66 (the checkout is the operator's, and
//     a run that moved their refs would be the worse bargain); preflight's
//     `staleConfigWarning` is what keeps it from being silent.
//
// 75 is sysexits' EX_TEMPFAIL ("temporary failure; retry"), which is the
// meaning, and it is clear of the run's own 0/1/2/3 and of the shell's reserved
// 126+. The number is repeated by hand in `scripts/sandbar-launch.mjs`, which
// runs before the package it would import exists; `launcher.test.ts` asserts
// the two spellings equal, and the README's launcher description moves with a
// change here.
export const EXIT_CODE_RELAUNCH = 75;

// The terminal union as a VALUE, with ExitTag derived from it rather than the
// other way round. That direction is what makes the table in
// exit-conditions.test.ts a real guard: a tag added here with no row there
// fails the set-equality assertion, and a row naming no tag fails to compile.
export const EXIT_TAGS = [
  "plan-empty",
  "relaunch",
  "stuck-same-plan",
  "stuck-zero-dones",
  "budget",
  "halted",
  "iteration-ceiling",
] as const;

export type ExitTag = (typeof EXIT_TAGS)[number];

// One stop, in the three parts every stop has: what it was, why, and what the
// process exits with. Shared by applyCycle's decisions and by the stops the
// orchestrator reaches on its own, because the LINE has to be identical either
// way — which is the whole of #70's second half.
export type TerminalExit = {
  readonly tag: ExitTag;
  readonly reason: string;
  readonly exitCode: number;
};

export type ExitDecision =
  | { readonly kind: "continue" }
  | ({ readonly kind: "exit" } & TerminalExit);

// THE line. Printed on stdout by whatever ends the run and written to
// orchestrator.log beside it — pure, and pinned exactly by a test, because it
// is the string an operator greps for and the one thing #70 promises will be
// there whatever happened.
export function formatExitLine(exit: TerminalExit): string {
  return `Exit (${exit.tag}): ${exit.reason}`;
}

// (a). Success: the queue holds nothing sandbar can act on, which is the state
// a series aims at, not a failure to reach one.
export function planEmptyExit(): TerminalExit {
  return {
    tag: "plan-empty",
    reason: "no unblocked issues to work on, and no chunk waiting to land",
    exitCode: EXIT_CODE_SUCCESS,
  };
}

// (f). `causes` are the short names the run log already uses for the same
// stops (`preflight-failed`, `merger-halted`, `chunk-wrapup-incomplete`, …) —
// this line says THAT the run stopped and which of them stopped it, never the
// complaint itself, which was printed in full at the point it was reached and
// would not survive being folded into one line.
export function haltedExit(causes: readonly string[]): TerminalExit {
  const named = causes.length > 0 ? causes.join(" + ") : "unspecified";
  return {
    tag: "halted",
    reason: `${named} — the complaint is above and in orchestrator.log`,
    exitCode: EXIT_CODE_HALTED,
  };
}

// (g). The exit CODE is deliberately unchanged at success: the ceiling has
// never fired, and #70 is about the run saying what it did, not about
// re-grading an outcome nobody has observed. The line is what changes — a run
// that hits the ceiling used to print "All done.", which is the one thing it is
// not.
export function iterationCeilingExit(maxIterations: number): TerminalExit {
  return {
    tag: "iteration-ceiling",
    reason: `ran ${maxIterations} cycles without an exit condition firing`,
    exitCode: EXIT_CODE_SUCCESS,
  };
}

// (b).
export function stuckSamePlanExit(planFingerprint: string): TerminalExit {
  return {
    tag: "stuck-same-plan",
    reason: `plan ${planFingerprint} repeated with 0 DONEs`,
    exitCode: EXIT_CODE_STUCK,
  };
}

// (c).
export function stuckZeroDonesExit(consecutiveCycles: number): TerminalExit {
  return {
    tag: "stuck-zero-dones",
    reason: `${consecutiveCycles} consecutive cycles with 0 DONEs`,
    exitCode: EXIT_CODE_STUCK,
  };
}

// (d). Reached from TWO places and that is why it is a function: applyCycle
// decides it after a cycle, and the orchestrator decides it again at the top of
// the next one, off `remainingBudget`. Those two used to carry the same reason
// in two hand-written copies and print it in different words (#70).
export function budgetExit(
  issuesAttempted: number,
  maxTotalIssues: number,
): TerminalExit {
  return {
    tag: "budget",
    reason: `issuesAttempted=${issuesAttempted} >= maxTotalIssues=${maxTotalIssues}`,
    exitCode: EXIT_CODE_BUDGET,
  };
}

// (e). What THIS run re-resolves at the next launch, and nothing more. It used
// to say "relaunching so the driver is what it just landed", which #66 made
// false for a pinned launcher: a landing does not become the driver until a
// human moves the pin. But the correction may not go the other way either —
// this flag is library config, and nothing about it requires a pin, so a
// message naming one would be equally false for the consumer README describes
// running `git pull && npm run build` in the same loop. What is true of EVERY
// launcher is the split: images and the config file are this run's to
// re-resolve, and which code does the driving is the launcher's answer,
// whatever shape it has.
export function relaunchExit(landedMerges: number): TerminalExit {
  return {
    tag: "relaunch",
    reason:
      `landed ${landedMerges} merge(s); relaunching so the next run ` +
      "rebuilds its images from origin and re-imports the config file " +
      "(which driver that run uses is the launcher's to decide)",
    exitCode: EXIT_CODE_RELAUNCH,
  };
}

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
  // inputs this run resolved at launch (#65). Which inputs those still are is
  // EXIT_CODE_RELAUNCH's comment above, and since #66 it is not all three of
  // them. Config rather than state, like maxTotalIssues — carried here so
  // applyCycle stays the single owner of the exit ordering.
  readonly relaunchAfterLanding: boolean;
};

export type CycleOutcome = {
  readonly planFingerprint: string;
  readonly planSize: number;
  readonly doneCount: number;
  // Merges the merger pushed to origin this cycle; 0 when the merge phase did
  // not run, did not push, or the cycle was reset (verified mode). REQUIRED
  // rather than defaulted, because the one caller forgetting to thread it
  // would disable relaunch silently — the run would just keep cycling on the
  // inputs it resolved at launch, which is #65's own bug wearing the fix.
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
  // this process is still holding the inputs it resolved before the landing
  // (the images above all; the constant's comment above owns how the three
  // objects came to differ under #66). Checked FIRST (see the header for why
  // it beats the budget): a landing is the one outcome that guarantees
  // progress, so exiting here can never spin the launcher's loop.
  if (state.relaunchAfterLanding && cycle.landedMerges > 0) {
    return { kind: "exit", ...relaunchExit(cycle.landedMerges) };
  }

  // (b) stuck — identical plan to the previous cycle and no progress this one.
  if (
    previousFingerprint !== null &&
    previousFingerprint === cycle.planFingerprint &&
    cycle.doneCount === 0
  ) {
    return { kind: "exit", ...stuckSamePlanExit(cycle.planFingerprint) };
  }

  // (c) stuck — two zero-DONE cycles back-to-back regardless of plan equality.
  if (state.consecutiveZeroDoneCycles >= MAX_CONSECUTIVE_ZERO_DONE_CYCLES) {
    return {
      kind: "exit",
      ...stuckZeroDonesExit(state.consecutiveZeroDoneCycles),
    };
  }

  // (d) budget — global cap on phase-2 entries.
  if (state.issuesAttempted >= state.maxTotalIssues) {
    return {
      kind: "exit",
      ...budgetExit(state.issuesAttempted, state.maxTotalIssues),
    };
  }

  return { kind: "continue" };
}
