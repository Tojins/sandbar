// Exit vocabulary for the daemon pool (#87, #133).
//
// An empty plan is an idle state, never a terminal. Relaunch, the lifetime
// admission budget, and its defensive recompute ceiling disappeared with that
// finite-run model. Three exits remain: quota (4), stuck after six consecutive
// issue terminals without a landing (2), and halted for faults sandbar cannot
// safely continue past (1). Scheduler decisions own quota/stuck precedence;
// run.ts constructs halted exits at the failure boundary.
//
// A landing for the stuck counter is a source merge, a reviewed chunk merged
// onto source, or a DONE member landed on its chunk branch. The last matters on
// review-lane hosts, where it is the ordinary durable progress. Unchanged land
// deferrals do not count: the daemon suppresses an immediate retry and lets the
// poll timer provide the next observation instead.
//
// `formatExitLine` remains the single operator-facing spelling (#70), and
// `EXIT_TAGS` is exhaustive over the union so its table test moves with it.

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

// The code every stop that is not a normal terminal already exited with — a
// startup refusal, a landing halt, an internal failure. Named here (#70) only
// so `haltedExit` can spell it the way its siblings do.
export const EXIT_CODE_HALTED = 1;
export const EXIT_CODE_STUCK = 2;
export const EXIT_CODE_QUOTA = 4;

// The terminal union as a VALUE, with ExitTag derived from it rather than the
// other way round. That direction is what makes the table in
// exit-conditions.test.ts a real guard: a tag added here with no row there
// fails the set-equality assertion, and a row naming no tag fails to compile.
export const EXIT_TAGS = [
  "quota",
  "stuck",
  "halted",
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

// (d).
export function stuckExit(terminals: number): TerminalExit {
  return {
    tag: "stuck",
    reason: `${terminals} consecutive issue terminals with zero landings`,
    exitCode: EXIT_CODE_STUCK,
  };
}
