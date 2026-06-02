import type { SandboxHooks } from "./agent-sandbox.js";

export type GateCommand = {
  readonly check: { readonly cmd: string; readonly args: readonly string[] };
  readonly test: { readonly cmd: string; readonly args: readonly string[] };
};

// The handoff labels sandbar APPLIES when it parks an issue for a human. These
// are NOT auto-created by sandbar (#8) — a host must define them in its repo,
// and a missing/misconfigured label fails loud at finalize time rather than
// being silently swallowed.
//
// `agentStuck` is the single "the agent gave up, a human needs to take over"
// label. Every agent-failure terminal (merge-conflict, merge-gate-red,
// silent-noop-exhausted, needs-human, review-budget-exhausted) parks the issue
// here; the *reason* is carried in the bot comment, not encoded in the label.
// `ready-for-human` is intentionally NOT in this set — it's reserved for
// human-by-triage.
//
// `ready-for-agent` (the planner queue label) is deliberately NOT configurable:
// it's the protocol entry label, hardcoded in the planner's `gh issue list`
// filter, the merger, and the host's issue-creation workflow. Making it a knob
// in only one of those places would silently desync the queue.
export type LabelConfig = {
  // Agent paused with a question (NEEDS-INFO). Distinct from agentStuck: the
  // agent isn't stuck, it's waiting on a human answer.
  readonly needsInfo: string;
  // The agent gave up; a human needs to take over.
  readonly agentStuck: string;
};

export const DEFAULT_LABELS: LabelConfig = {
  needsInfo: "needs-info",
  agentStuck: "agent-stuck",
};

export type RunConfig = {
  readonly cwd: string;
  readonly workDir: string;

  readonly ghOwner: string;
  readonly ghRepo: string;

  readonly sourceBranch: string;

  readonly gateImage: string;
  readonly containerfilePath: string;
  readonly gateCommands: GateCommand;
  readonly installCommand: { readonly cmd: string; readonly args: readonly string[] };

  readonly modelId: string;
  readonly coauthorTrailer: string;
  readonly botName: string;
  readonly botEmail: string;

  readonly claudeMdPath: string;
  readonly contextMdPath?: string;
  readonly adrDir?: string;
  // Optional. When set, the file *extends* sandbar's built-in coding standards
  // (prompts/coding-standards.md) with project-specific rules; hosts are not
  // required to supply one.
  readonly codingStandardsPath?: string;

  // Authoritative env-file path for BOTH the host-side preflight credential
  // check and the values injected into each sandbox container (its declared
  // keys, with per-key process.env fallback). One knob — no hidden
  // `.sandcastle/.env` second source.
  readonly envFilePath: string;

  readonly maxImplAttempts?: number;
  readonly maxReviewRounds?: number;
  readonly maxTotalIssues?: number;

  // Optional. Overrides any subset of the default label vocabulary; unset keys
  // fall back to DEFAULT_LABELS.
  readonly labels?: Partial<LabelConfig>;

  readonly sandboxHooks: SandboxHooks;
  readonly copyToWorktree: readonly string[];
};

export type ResolvedConfig = Required<
  Omit<RunConfig, "contextMdPath" | "adrDir" | "codingStandardsPath" | "labels">
> & {
  readonly contextMdPath?: string;
  readonly adrDir?: string;
  readonly codingStandardsPath?: string;
  readonly labels: LabelConfig;
};

export const DEFAULT_MAX_IMPL_ATTEMPTS = 8;
// 5, not 3: dogfooding surfaced a review-budget exhaustion on an issue making
// monotonic progress (three rounds, three distinct real findings, each fixed;
// the 4th round was APPROVED). 3 is marginal even for converging work (#8).
export const DEFAULT_MAX_REVIEW_ROUNDS = 5;
export const DEFAULT_MAX_TOTAL_ISSUES = 50;

export function resolveConfig(config: RunConfig): ResolvedConfig {
  return {
    ...config,
    maxImplAttempts: config.maxImplAttempts ?? DEFAULT_MAX_IMPL_ATTEMPTS,
    maxReviewRounds: config.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS,
    maxTotalIssues: config.maxTotalIssues ?? DEFAULT_MAX_TOTAL_ISSUES,
    labels: { ...DEFAULT_LABELS, ...config.labels },
  };
}
