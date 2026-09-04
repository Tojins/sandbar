// Exit vocabulary and run-wide counters for the continuous pool (#87).
import { DEFAULT_MAX_TOTAL_ISSUES } from "./config.js";
export const SILENT_NOOP_RETRY_LIMIT = 2;
export const MAX_CONSECUTIVE_TERMINALS_WITHOUT_LANDING = 6;
export const EXIT_CODE_SUCCESS = 0;
export const EXIT_CODE_HALTED = 1;
export const EXIT_CODE_STUCK = 2;
export const EXIT_CODE_BUDGET = 3;
export const EXIT_CODE_QUOTA = 4;
export const EXIT_CODE_RELAUNCH = 75;
export const EXIT_TAGS = ["plan-empty", "quota", "relaunch", "stuck", "budget", "halted", "iteration-ceiling"] as const;
export type ExitTag = (typeof EXIT_TAGS)[number];
export type TerminalExit = { readonly tag: ExitTag; readonly reason: string; readonly exitCode: number };
export function formatExitLine(exit: TerminalExit): string { return `Exit (${exit.tag}): ${exit.reason}`; }
export const planEmptyExit = (): TerminalExit => ({ tag: "plan-empty", reason: "no unblocked issues to work on, and no chunk waiting to land", exitCode: EXIT_CODE_SUCCESS });
export function quotaExit(args: { provider: "claude" | "codex"; window: string; resetsAt?: number }): TerminalExit {
  const reset = args.resetsAt === undefined ? "an unknown time" : new Date(args.resetsAt * 1000).toISOString();
  return { tag: "quota", reason: `${args.provider} ${args.window} quota window closed; resets at ${reset}`, exitCode: EXIT_CODE_QUOTA };
}
export const haltedExit = (causes: readonly string[]): TerminalExit => ({ tag: "halted", reason: `${causes.length ? causes.join(" + ") : "unspecified"} — the complaint is above and in orchestrator.log`, exitCode: EXIT_CODE_HALTED });
export const iterationCeilingExit = (maximum: number): TerminalExit => ({ tag: "iteration-ceiling", reason: `ran ${maximum} recomputes without an exit condition firing`, exitCode: EXIT_CODE_SUCCESS });
export const budgetExit = (started: number, maximum: number): TerminalExit => ({ tag: "budget", reason: `issuesStarted=${started} >= maxTotalIssues=${maximum}`, exitCode: EXIT_CODE_BUDGET });
export const stuckExit = (terminals: number): TerminalExit => ({ tag: "stuck", reason: `${terminals} consecutive issue terminals with zero landings`, exitCode: EXIT_CODE_STUCK });
export const relaunchExit = (landings: number): TerminalExit => ({ tag: "relaunch", reason: `landed ${landings} merge(s); pool is quiescent and newly-unblocked work remains`, exitCode: EXIT_CODE_RELAUNCH });
export type RunState = { issuesAttempted: number; readonly silentNoopAttemptsByIssue: Map<string, number>; readonly maxTotalIssues: number };
export function newRunState(opts: { maxTotalIssues?: number } = {}): RunState {
  return { issuesAttempted: 0, silentNoopAttemptsByIssue: new Map(), maxTotalIssues: opts.maxTotalIssues ?? DEFAULT_MAX_TOTAL_ISSUES };
}
export const remainingBudget = (state: RunState): number => Math.max(0, state.maxTotalIssues - state.issuesAttempted);
