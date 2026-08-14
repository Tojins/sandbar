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

// A file made visible to the DB sidecar container at startup — the official
// images' `/docker-entrypoint-initdb.d` convention (schema dumps, seed
// fixtures). `hostPath` resolves against the ISSUE WORKTREE (not the
// operator's checkout), so a branch that changes its fixture gates against its
// own version, and the operator's dirty tree can never leak into a gate (the
// same isolation argument as issue #10). Mounted read-only.
export type DbInitMount = {
  // Path relative to the issue worktree root (absolute paths pass through).
  readonly hostPath: string;
  readonly containerPath: string;
};

// Per-issue DB sidecar recipe (#20). Sandbar owns the container LIFECYCLE —
// the --disable-dns network, the pinned IP, naming, teardown — while the
// consumer owns everything engine-specific: which image, its env, its port,
// how to probe readiness, and what env the gate's test-suite needs. There is
// deliberately no engine enum and no built-in Postgres (or any other) preset:
// the engine is repo identity, so `dbSidecar` is a REQUIRED RunConfig field.
export type DbSidecarConfig = {
  // Fully qualified image ref (hosts without unqualified-search registries
  // can't resolve bare short names), e.g. "docker.io/library/mariadb:10.11".
  readonly image: string;
  // Env for the sidecar container itself (POSTGRES_USER=…, MYSQL_DATABASE=…).
  readonly containerEnv: Readonly<Record<string, string>>;
  // The port the server listens on inside the container (5432, 3306). The
  // sidecar is reached by pinned IP on the per-issue network — no host port.
  readonly port: number;
  // Argv exec'd INSIDE the container until it exits 0 (the readiness probe).
  // `podman exec` sessions see the containerEnv above, so a password can be
  // referenced via `sh -c '… $POSTGRES_PASSWORD …'`. Probe the TCP listener
  // the gate will actually connect to, not a unix socket (the official pg
  // image serves init scripts on a socket first — pg_isready flickers green).
  readonly readinessCommand: readonly string[];
  // How long the readiness probe may poll before the sidecar counts as failed.
  // Default: 60s. Raise it when initMounts load a large schema — the probe is
  // what waits out `/docker-entrypoint-initdb.d` processing.
  readonly readinessTimeoutMs?: number;
  // Args appended after the image (the image CMD, not podman flags), e.g.
  // --sql-mode=…. Default: [].
  readonly containerArgs?: readonly string[];
  // Fixture files mounted into the container before it starts. Default: [].
  readonly initMounts?: readonly DbInitMount[];
  // Argv lists exec'd in the container after readiness, in order, each
  // required to exit 0 (fail-loud). This is where engine-specific one-shot
  // setup lives — e.g. "create the test database if absent". Default: [].
  readonly postReadyCommands?: ReadonlyArray<readonly string[]>;
  // Env injected into every gate container, verbatim (DB_USER, DB_PASSWORD,
  // DB_NAME, …). Two keys are RESERVED and always overwritten by sandbar:
  // DB_HOST (the sidecar's pinned IP) and DB_PORT (`port` above) — the
  // consumer's test bootstrap reads those two and derives everything else.
  readonly gateEnv: Readonly<Record<string, string>>;
};

// dbSidecar with every defaultable field made concrete (see resolveDbSidecar).
export type ResolvedDbSidecarConfig = Required<DbSidecarConfig>;

// RunConfig is DEVIATIONS-ONLY by design. A consumer should write down two
// kinds of thing and nothing else:
//
//   1. Repo-specific facts that sandbar cannot guess — these are REQUIRED.
//   2. Any knob it genuinely wants different from sandbar's default — every
//      other field is OPTIONAL and falls through to the documented default
//      below (see DEFAULTS / resolveConfig).
//
// Restating a default (e.g. `sourceBranch: "main"`) is pure noise: it reads as
// an intentional choice, silently drifts if the default ever moves, and buries
// the genuinely-deviating knobs. Don't. If the value equals the default, omit
// it.
//
// The required/optional split is the contract: required ⇔ "no sensible default
// exists" (repo identity, gate commands, the sandbox image, the bot identity,
// the sandbox hooks, the DB sidecar recipe). Optional ⇔ "has a de-facto-
// standard value sandbar fills in".
export type RunConfig = {
  // ---- Required: repo-specific facts with no sensible default -------------
  readonly ghOwner: string;
  readonly ghRepo: string;

  // The sandbox/gate image tag and the one-shot gate the host's CI would run.
  readonly gateImage: string;
  readonly gateCommands: GateCommand;

  // Commit/author identity for the bot. `coauthorTrailer` defaults to a
  // `Co-authored-by:` line derived from these two (see resolveConfig), so a
  // host normally supplies only name + email.
  readonly botName: string;
  readonly botEmail: string;

  // Per-sandbox lifecycle hooks (build/setup). Host-specific; no default.
  readonly sandboxHooks: SandboxHooks;

  // Per-issue DB sidecar recipe. Required: the engine, image, credentials,
  // and probes are repo identity — sandbar ships no engine preset (#20).
  readonly dbSidecar: DbSidecarConfig;

  // ---- Optional: tunable, with a documented default ------------------------
  // Where the host repo lives / where sandbar keeps its state. Defaults:
  // cwd = process.cwd(), workDir = ".sandbar".
  readonly cwd?: string;
  readonly workDir?: string;

  // Branch issue worktrees seed from and merges land on. Default: "main".
  readonly sourceBranch?: string;

  // OCI build recipe for `gateImage`. Default: "Containerfile".
  readonly containerfilePath?: string;

  // Model ids passed to the claude agent provider, one per role. There is no
  // single global model knob: every agent role names its own model so the
  // tiering is explicit at the call site. Every role defaults to the version-
  // agnostic "opus" alias, which the claude CLI resolves to the latest Opus —
  // so the defaults don't pin a version and don't need bumping per release.
  // Defaults: implementer/reviewer/merger all "opus".
  readonly implementerModelId?: string;
  readonly reviewerModelId?: string;
  readonly mergerModelId?: string;

  // Trailer appended to merge commits. Default: a `Co-authored-by:` line built
  // from botName/botEmail.
  readonly coauthorTrailer?: string;

  // Anchor docs surfaced to the agent. `claudeMdPath` is always referenced;
  // `contextMdPath`/`adrDir` are referenced only when they exist on disk, so
  // their conventional defaults are safe even for repos that don't have them.
  // Defaults: "CLAUDE.md", "CONTEXT.md", "docs/adr".
  readonly claudeMdPath?: string;
  readonly contextMdPath?: string;
  readonly adrDir?: string;

  // When set, the file *extends* sandbar's built-in coding standards
  // (prompts/coding-standards.md) with project-specific rules. No default:
  // hosts are not required to supply one, and there's no conventional path.
  readonly codingStandardsPath?: string;

  // Authoritative env-file path for BOTH the host-side preflight credential
  // check and the values injected into each sandbox container (its declared
  // keys, with per-key process.env fallback). One knob — no hidden
  // `.sandbar/.env` second source. Default: ".env".
  readonly envFilePath?: string;

  readonly maxImplAttempts?: number;
  readonly maxReviewRounds?: number;
  readonly maxTotalIssues?: number;

  // Overrides any subset of the default label vocabulary; unset keys fall back
  // to DEFAULT_LABELS.
  readonly labels?: Partial<LabelConfig>;

  // Extra host paths copied into each issue worktree. Default: [].
  readonly copyToWorktree?: readonly string[];
};

// After resolution every defaultable field is concrete. Only the two fields
// with no default — `codingStandardsPath` (genuinely optional) — stays
// optional; `labels` is widened from Partial to the fully-populated vocabulary.
export type ResolvedConfig = Required<
  Omit<RunConfig, "codingStandardsPath" | "labels" | "dbSidecar">
> & {
  readonly codingStandardsPath?: string;
  readonly labels: LabelConfig;
  readonly dbSidecar: ResolvedDbSidecarConfig;
};

export const DEFAULT_CWD = (): string => process.cwd();
export const DEFAULT_WORK_DIR = ".sandbar";
export const DEFAULT_SOURCE_BRANCH = "main";
export const DEFAULT_CONTAINERFILE_PATH = "Containerfile";
export const DEFAULT_IMPLEMENTER_MODEL_ID = "opus";
export const DEFAULT_REVIEWER_MODEL_ID = "opus";
export const DEFAULT_MERGER_MODEL_ID = "opus";
export const DEFAULT_CLAUDE_MD_PATH = "CLAUDE.md";
export const DEFAULT_CONTEXT_MD_PATH = "CONTEXT.md";
export const DEFAULT_ADR_DIR = "docs/adr";
export const DEFAULT_ENV_FILE_PATH = ".env";
export const DEFAULT_MAX_IMPL_ATTEMPTS = 8;
// 5, not 3: dogfooding surfaced a review-budget exhaustion on an issue making
// monotonic progress (three rounds, three distinct real findings, each fixed;
// the 4th round was APPROVED). 3 is marginal even for converging work (#8).
export const DEFAULT_MAX_REVIEW_ROUNDS = 5;
export const DEFAULT_MAX_TOTAL_ISSUES = 50;
export const DEFAULT_DB_READINESS_TIMEOUT_MS = 60_000;

export function resolveDbSidecar(db: DbSidecarConfig): ResolvedDbSidecarConfig {
  return {
    ...db,
    readinessTimeoutMs: db.readinessTimeoutMs ?? DEFAULT_DB_READINESS_TIMEOUT_MS,
    containerArgs: db.containerArgs ?? [],
    initMounts: db.initMounts ?? [],
    postReadyCommands: db.postReadyCommands ?? [],
  };
}

export function defaultCoauthorTrailer(botName: string, botEmail: string): string {
  return `Co-authored-by: ${botName} <${botEmail}>`;
}

export function resolveConfig(config: RunConfig): ResolvedConfig {
  return {
    ...config,
    cwd: config.cwd ?? DEFAULT_CWD(),
    workDir: config.workDir ?? DEFAULT_WORK_DIR,
    sourceBranch: config.sourceBranch ?? DEFAULT_SOURCE_BRANCH,
    containerfilePath: config.containerfilePath ?? DEFAULT_CONTAINERFILE_PATH,
    implementerModelId: config.implementerModelId ?? DEFAULT_IMPLEMENTER_MODEL_ID,
    reviewerModelId: config.reviewerModelId ?? DEFAULT_REVIEWER_MODEL_ID,
    mergerModelId: config.mergerModelId ?? DEFAULT_MERGER_MODEL_ID,
    coauthorTrailer:
      config.coauthorTrailer ??
      defaultCoauthorTrailer(config.botName, config.botEmail),
    claudeMdPath: config.claudeMdPath ?? DEFAULT_CLAUDE_MD_PATH,
    contextMdPath: config.contextMdPath ?? DEFAULT_CONTEXT_MD_PATH,
    adrDir: config.adrDir ?? DEFAULT_ADR_DIR,
    envFilePath: config.envFilePath ?? DEFAULT_ENV_FILE_PATH,
    maxImplAttempts: config.maxImplAttempts ?? DEFAULT_MAX_IMPL_ATTEMPTS,
    maxReviewRounds: config.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS,
    maxTotalIssues: config.maxTotalIssues ?? DEFAULT_MAX_TOTAL_ISSUES,
    copyToWorktree: config.copyToWorktree ?? [],
    labels: { ...DEFAULT_LABELS, ...config.labels },
    dbSidecar: resolveDbSidecar(config.dbSidecar),
  };
}
