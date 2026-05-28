import type { SandboxHooks } from "@ai-hero/sandcastle";

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
  readonly codingStandardsPath: string;

  readonly envFilePath: string;

  readonly maxImplAttempts?: number;
  readonly maxTotalIssues?: number;

  readonly sandboxHooks: SandboxHooks;
  readonly copyToWorktree: readonly string[];
};

export type ResolvedConfig = Required<Omit<RunConfig, "contextMdPath" | "adrDir">> & {
  readonly contextMdPath?: string;
  readonly adrDir?: string;
};

export const DEFAULT_MAX_IMPL_ATTEMPTS = 8;
export const DEFAULT_MAX_TOTAL_ISSUES = 50;

export function resolveConfig(config: RunConfig): ResolvedConfig {
  return {
    ...config,
    maxImplAttempts: config.maxImplAttempts ?? DEFAULT_MAX_IMPL_ATTEMPTS,
    maxTotalIssues: config.maxTotalIssues ?? DEFAULT_MAX_TOTAL_ISSUES,
  };
}
