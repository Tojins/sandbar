import type { SandboxHooks } from "./agent-sandbox.js";

export type GateCommand = {
  readonly check: { readonly cmd: string; readonly args: readonly string[] };
  readonly test: { readonly cmd: string; readonly args: readonly string[] };
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

  readonly sandboxHooks: SandboxHooks;
  readonly copyToWorktree: readonly string[];
};

export type ResolvedConfig = Required<
  Omit<RunConfig, "contextMdPath" | "adrDir" | "codingStandardsPath">
> & {
  readonly contextMdPath?: string;
  readonly adrDir?: string;
  readonly codingStandardsPath?: string;
};

export const DEFAULT_MAX_IMPL_ATTEMPTS = 8;
export const DEFAULT_MAX_REVIEW_ROUNDS = 3;
export const DEFAULT_MAX_TOTAL_ISSUES = 50;

export function resolveConfig(config: RunConfig): ResolvedConfig {
  return {
    ...config,
    maxImplAttempts: config.maxImplAttempts ?? DEFAULT_MAX_IMPL_ATTEMPTS,
    maxReviewRounds: config.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS,
    maxTotalIssues: config.maxTotalIssues ?? DEFAULT_MAX_TOTAL_ISSUES,
  };
}
