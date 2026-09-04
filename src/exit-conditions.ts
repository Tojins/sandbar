// Exit vocabulary and run-wide budget for the continuous pool (#87).
//
//   (a) plan-empty        — the pool is quiescent, no landing is in flight and
//                           the recomputed plan holds nothing. Success (0).
//   (b) quota             — a provider's subscription window closed (exit 4).
//                           Outranks every other exit: it stops new starts at
//                           once, lands what is already committed, drains the
//                           rest to a terminal, and only then exits (#109).
//   (c) relaunch          — the pool went quiescent AFTER a landing and the
//                           recompute is non-empty (exit 75, #65). That instant
//                           is the old cycle boundary: the last landing closed
//                           a blocker and unblocked its successors.
//   (d) stuck             — MAX_CONSECUTIVE_NO_PROGRESS_WITHOUT_LANDING
//                           no-progress observations in a row: issue terminals
//                           or human-requested landing passes that defer every
//                           request and consume no terminal
//                           (exit 2). The broken-world backstop: a red source
//                           branch or a misconfigured gate stack parks every
//                           issue after an hour of paid tokens, and without
//                           this the only bound is `maxTotalIssues` of quota
//                           discovering the same thing.
//   (e) budget            — starts reached `maxTotalIssues` (exit 3). Counted
//                           at admission, so the cap cannot be overshot; a
//                           silent-noop re-admission (#87) is not a start.
//   (f) halted            — the run stopped on something it cannot carry on
//                           past (#70): a startup refusal, a landing that
//                           threw, durable work the tracker disagrees with, or
//                           an internal failure.
//   (g) iteration-ceiling — `maxRecomputesFor(maxTotalIssues)` recomputes
//                           without any of the above. Defensive; the
//                           conditions above terminate first.
//
// WHO DECIDES WHAT. `decideSchedulerAction` (scheduler.ts) owns (a)–(e) as one
// precedence over a pool snapshot, because each of them is a judgement about
// the pool's state — what is active, what is ongoing, what has landed — and a
// second copy of that precedence in run.ts is #87's own spaghetti coming back.
// (f) and (g) are the orchestrator's: they fire in the middle of a landing or
// in place of a recompute, and no snapshot carries them. The constructors
// below are what both hand to `announceExit`.
//
// THE ONE ORDERING THAT CARRIES WEIGHT. (c) before (e): budgets are per
// process and reset across relaunches by design, so a run that both landed and
// exhausted its budget relaunches rather than stopping. No spin hides in that:
// (c) requires a landing in THIS process, and a process that lands nothing
// falls through to codes that break the launcher's loop. (d) before (c) for
// the same reason in reverse — a relaunch on a red source branch would loop the
// launcher through the same six parks forever.
//
// WHAT A LANDING IS, for (c) and (d) alike: a DONE branch merged onto the
// source branch, a reviewed chunk merged there on a `land` label (#64), or a
// DONE branch landed on its chunk branch (#60). The third counts because on a
// review-lane host it is the ONLY way work ever leaves the pool — every DONE
// waits on a chunk branch for a human's `land` — and a backstop that ignored
// it would call six landed issues "six terminals with zero landings" and exit
// stuck on a run that was working. Only the first two move the source branch,
// so only they trigger the in-process image rebuild; that split is run.ts's.
//
// ALL SEVEN ARE `TerminalExit`s, and `formatExitLine` is the one spelling of
// the line an operator reads (#70). Before #70 the stops the orchestrator owned
// each announced themselves in their own words — and one of them, the halt, in
// no words at all on stdout — so "did this run stop normally?" could not be
// answered from one place. The constructors are pure and `EXIT_TAGS` is
// exhaustive over the union, so a tag with no line, or a line with no tag,
// fails exit-conditions.test.ts rather than being noticed six weeks later in a
// log that never mentioned it.

import { DEFAULT_MAX_TOTAL_ISSUES } from "./config.js";

// Cap on how many times the same issue can hit silent-noop in one run before
// it parks. Each silent-noop attempt reclaims the clone and deletes the local
// branch, and the pool re-admits the issue without spending a start (#87) —
// a fresh implementation against current source. After K such attempts we
// accept that the integration drift will not heal on its own.
export const SILENT_NOOP_RETRY_LIMIT = 2;

// (d)'s threshold. Two full pool widths at the default `maxParallelIssues`:
// enough that one bad issue, or one flaky landing, cannot trip it, and small
// enough that a red source branch is caught after two rounds of parks rather
// than fifty.
export const MAX_CONSECUTIVE_NO_PROGRESS_WITHOUT_LANDING = 6;

export const EXIT_CODE_SUCCESS = 0;
// The code every stop that is not a normal terminal already exited with — a
// startup refusal, a landing halt, an internal failure. Named here (#70) only
// so `haltedExit` can spell it the way its siblings do.
export const EXIT_CODE_HALTED = 1;
export const EXIT_CODE_STUCK = 2;
export const EXIT_CODE_BUDGET = 3;
export const EXIT_CODE_QUOTA = 4;
// "Landed work and went quiet; relaunch me to continue" (#65). Unconditional
// since #87 — there is no `relaunchAfterLanding` — because on quiescence there
// is nothing to disrupt, and a host whose queue keeps the pool busy gets one
// long process anyway. What a relaunch re-resolves narrowed with #66 and #87:
// the driver is a pinned release that a landing does not move, images are now
// rebuilt IN PROCESS after every source-branch landing, and the CONFIG is the
// one object a running process cannot refresh — it is `import()`ed once at
// launch, from the operator's checkout. The relaunch exists for that last one.
//
// 75 is sysexits' EX_TEMPFAIL ("temporary failure; retry"), which is the
// meaning, and it is clear of the run's own 0/1/2/3/4 and of the shell's
// reserved 126+. The number is repeated by hand in `scripts/sandbar-launch.mjs`,
// which runs before the package it would import exists; `launcher.test.ts`
// asserts the two spellings equal, and the README's launcher contract moves
// with a change here.
export const EXIT_CODE_RELAUNCH = 75;

// The terminal union as a VALUE, with ExitTag derived from it rather than the
// other way round. That direction is what makes the table in
// exit-conditions.test.ts a real guard: a tag added here with no row there
// fails the set-equality assertion, and a row naming no tag fails to compile.
export const EXIT_TAGS = [
  "plan-empty",
  "quota",
  "relaunch",
  "stuck",
  "budget",
  "halted",
  "iteration-ceiling",
] as const;

export type ExitTag = (typeof EXIT_TAGS)[number];

// One stop, in the three parts every stop has: what it was, why, and what the
// process exits with. Shared by the scheduler's decisions and by the stops the
// orchestrator reaches on its own, because the LINE has to be identical either
// way — which is the whole of #70's second half.
export type TerminalExit = {
  readonly tag: ExitTag;
  readonly reason: string;
  readonly exitCode: number;
};

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

// (b). Built from whichever measurement closed the provider: a QUOTA terminal,
// the merger's resolve loop, or — when the issue that closed it never returned
// a terminal at all — the run's own quota state.
export function quotaExit(args: {
  provider: "claude" | "codex";
  window: string;
  resetsAt?: number;
}): TerminalExit {
  const reset = args.resetsAt === undefined
    ? "an unknown time"
    : new Date(args.resetsAt * 1000).toISOString();
  return {
    tag: "quota",
    reason: `${args.provider} ${args.window} quota window closed; resets at ${reset}`,
    exitCode: EXIT_CODE_QUOTA,
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
export function iterationCeilingExit(maxRecomputes: number): TerminalExit {
  return {
    tag: "iteration-ceiling",
    reason: `ran ${maxRecomputes} recomputes without an exit condition firing`,
    exitCode: EXIT_CODE_SUCCESS,
  };
}

// (e). `started` is the pool's admission count, which is what the cap bounds.
export function budgetExit(started: number, maximum: number): TerminalExit {
  return {
    tag: "budget",
    reason: `issuesStarted=${started} >= maxTotalIssues=${maximum}`,
    exitCode: EXIT_CODE_BUDGET,
  };
}

// (d).
export function stuckExit(terminals: number): TerminalExit {
  return {
    tag: "stuck",
    reason: `${terminals} consecutive terminal or requested-landing passes with zero landings`,
    exitCode: EXIT_CODE_STUCK,
  };
}

// (c). Counts LANDINGS in the header's sense, not merges: a chunk-branch
// landing is one of them. What the next run re-resolves is named — the config
// file — and nothing is claimed about the driver, which is the launcher's to
// decide (#66).
export function relaunchExit(landings: number): TerminalExit {
  return {
    tag: "relaunch",
    reason:
      `${landings} landing(s) this run; pool is quiescent and newly-unblocked ` +
      "work remains, so relaunching to re-import the config file " +
      "(which driver that run uses is the launcher's to decide)",
    exitCode: EXIT_CODE_RELAUNCH,
  };
}

export type RunState = {
  // Admissions so far. Incremented when an issue enters the pool — never for a
  // silent-noop re-admission — so `maxTotalIssues` cannot be overshot and
  // needs no pre-cycle trim.
  issuesAttempted: number;
  // Per-issue silent-noop counter. The merger increments this whenever the
  // resolve loop reports "resolved" but HEAD did not advance (the agent gave
  // up via `git merge --abort` and returned). Reset across runs by design —
  // a human re-running sandbar implicitly authorises a fresh budget.
  readonly silentNoopAttemptsByIssue: Map<string, number>;
  readonly maxTotalIssues: number;
};

export function newRunState(opts: { maxTotalIssues?: number } = {}): RunState {
  return {
    issuesAttempted: 0,
    silentNoopAttemptsByIssue: new Map(),
    maxTotalIssues: opts.maxTotalIssues ?? DEFAULT_MAX_TOTAL_ISSUES,
  };
}

// Remaining headroom under the global cap: the most NEW starts the next
// admission may make.
export function remainingBudget(state: RunState): number {
  return Math.max(0, state.maxTotalIssues - state.issuesAttempted);
}
