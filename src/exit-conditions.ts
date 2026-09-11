// Exit vocabulary for the daemon pool (#87, #133, #146).
//
// An empty plan is an idle state, never a terminal. The lifetime admission
// budget and its defensive recompute ceiling disappeared with that finite-run
// model. Provider closure exits (quota or credential) use 4, stuck after six
// consecutive issue terminals without a landing uses 2, halted covers faults
// sandbar cannot safely continue past (1), and a restart the box asked for uses
// 75. Scheduler decisions own restart/provider-closure/stuck precedence;
// run.ts constructs halted exits at the failure boundary.
//
// 75 is the one code an installation unit turns back into a start
// (`RestartForceExitStatus=`, #146), so it has to be a code nothing else in
// this system can produce: 1, 2 and 4 are the deliberate stops a human
// inspects, and an unhandled Node throw is 1. EX_TEMPFAIL is the sysexits name
// for exactly this claim — nothing is wrong, ask again — and sandbar spelled
// the retired per-landing relaunch (#65) with it for the same reason.
//
// A landing for the stuck counter is a source merge, a reviewed chunk merged
// onto source, or a DONE member landed on its chunk branch. The last matters on
// review-lane hosts, where it is the ordinary durable progress. Unchanged land
// deferrals do not count: the daemon suppresses an immediate retry and lets the
// poll timer provide the next observation instead.
//
// All five are `TerminalExit`s. `run.ts` writes that value as one exit event;
// the UI renders it and service supervision reads only the process code (#132).
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
export const EXIT_CODE_RESTART = 75;

// The terminal union as a VALUE, with ExitTag derived from it rather than the
// other way round. That direction is what makes the table in
// exit-conditions.test.ts a real guard: a tag added here with no row there
// fails the set-equality assertion, and a row naming no tag fails to compile.
export const EXIT_TAGS = [
  "quota",
  "credential",
  "stuck",
  "halted",
  "restart",
] as const;

export type ExitTag = (typeof EXIT_TAGS)[number];

// One stop, in the three parts every stop has: what it was, why, and what the
// process exits with. Shared by scheduler decisions and orchestrator stops so
// every terminal path produces the same event shape.
export type TerminalExit = {
  readonly tag: ExitTag;
  readonly reason: string;
  readonly exitCode: number;
};

// Built from whichever measurement closed the provider: a QUOTA terminal,
// the merger's resolve loop, or — when the issue that closed it never returned
// a terminal at all — the run's own provider state.
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

export function credentialExit(args: {
  provider: "codex";
  detail: string;
}): TerminalExit {
  const detail = args.detail.trim();
  return {
    tag: "credential",
    reason: `${args.provider} refused its credential: ${detail}` +
      (/[.!?]$/.test(detail) ? " " : ". ") +
      "Log in again on the host and restart.",
    exitCode: EXIT_CODE_QUOTA,
  };
}

// `causes` are the short names the event record uses for the same
// stops (`preflight-failed`, `merger-halted`, `chunk-wrapup-incomplete`, …) —
// this line says THAT the run stopped and which of them stopped it, never the
// complaint itself, which was printed in full at the point it was reached and
// would not survive being folded into one line.
export function haltedExit(causes: readonly string[]): TerminalExit {
  const named = causes.length > 0 ? causes.join(" + ") : "unspecified";
  return {
    tag: "halted",
    reason: `${named} — see the complaint event for details`,
    exitCode: EXIT_CODE_HALTED,
  };
}

// The drain the box asked for, finished (#146). The detail is what the request
// file carried — the commit the converging play applied — so the record names
// which deploy this process stepped aside for, not merely that it did.
export function restartExit(detail: string): TerminalExit {
  return {
    tag: "restart",
    reason: `restart requested by the deployment of ${detail}; drained and ` +
      "exiting for the unit to start the built driver",
    exitCode: EXIT_CODE_RESTART,
  };
}

export function stuckExit(terminals: number): TerminalExit {
  return {
    tag: "stuck",
    reason: `${terminals} consecutive issue terminals with zero landings`,
    exitCode: EXIT_CODE_STUCK,
  };
}
