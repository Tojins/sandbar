import type { SandboxHooks } from "./agent-sandbox.js";
import { SandbarError } from "./errors.js";
import { BRANCH_PREFIX } from "./naming.js";

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
// forge-unverified, silent-noop-exhausted, needs-human, review-budget-exhausted)
// parks the issue here; the *reason* is carried in the bot comment, not encoded
// in the label.
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
// fixtures). `hostPath` resolves against the WORKTREE being gated (the issue
// worktree in the inner loop; the merger worktree for gate-2), so a branch
// that changes its fixture gates against its own version. Relative paths are
// the convention, not a jail — `..` and absolute paths are honored, since
// consumer config is trusted. Mounted read-only. Neither path may contain
// `:` (podman `-v` specs are colon-delimited; enforced fail-loud).
export type DbInitMount = {
  // Path relative to the gated worktree root (absolute paths pass through).
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
  // DB_NAME, …). Four keys are RESERVED and always overwritten by sandbar:
  // DB_HOST (the sidecar's pinned IP) and DB_PORT (`port` above), which the
  // consumer's test bootstrap reads to derive everything else, plus CI=true
  // and HOME=/tmp, which the gate's hermeticity/writability depend on.
  readonly gateEnv: Readonly<Record<string, string>>;
};

// dbSidecar with every defaultable field made concrete (see resolveDbSidecar).
export type ResolvedDbSidecarConfig = Required<DbSidecarConfig>;

// How a cycle's merge result reaches the source branch (#22).
//
// `direct` is the default and what sandbar has always done: merge locally, gate
// locally, `git push origin HEAD:<sourceBranch>`. Nothing on the forge ever sees
// the result. That is fine when the source branch is inert — and unsafe when
// something downstream (a deploy workflow on `push: branches: [main]`, a release
// job) trusts it blindly, because sandbar's push matches neither `pull_request`
// nor `push: branches-ignore: [main]`, so CI silently never runs.
//
// `verified` makes the forge the gate: the merge result is pushed to a scratch
// integration branch, sandbar polls that sha's check runs, and only green earns
// the fast-forward onto the source branch. The point is INDEPENDENCE, not
// coverage — CI is a second, differently-authored implementation of "does this
// work", which is the one thing expanding the local gate can never buy.
export type MergeModeConfig =
  | { readonly kind: "direct" }
  | {
      readonly kind: "verified";
      // Scratch ref sandbar force-pushes each cycle's merge result to. Must not
      // be the source branch. Default: "sandbar/integration".
      readonly integrationBranch?: string;
      // Check-run names that must exist and pass before anything lands.
      // REQUIRED and non-empty — this is the floor, and without it verified
      // mode cannot tell "the check hasn't started" from "the check will never
      // run", which is precisely the mis-triggered-workflow case the mode
      // exists to catch. A check NOT named here still sinks the cycle if it
      // fails; naming is about what must be waited for, not what may be
      // ignored. Use the job names as the forge reports them.
      readonly requiredChecks: readonly string[];
      // How long checks may take to conclude before the cycle is parked. Never
      // shortened into a "land anyway" — an unknown verdict is not a green one.
      // Default: 20 minutes.
      readonly checkTimeoutMs?: number;
      // Poll interval while checks are pending. Default: 15s.
      readonly pollIntervalMs?: number;
      // How long a pushed sha may report ZERO check runs before sandbar
      // concludes the forge does not build this ref at all — which is fatal,
      // not a parked cycle (see forge-verify.ts). Widen it if the forge is slow
      // to create runs under load; the run halts rather than lands either way.
      // Default: 2 minutes.
      readonly noChecksGraceMs?: number;
      // Also open a pull request for the integration branch, as a review/audit
      // handle. Landing is a fast-forward push either way (so commit
      // attribution never changes); the forge marks the PR merged once its
      // commits become ancestors of the base. Default: false.
      readonly openPullRequest?: boolean;
    };

export type ResolvedMergeMode =
  | { readonly kind: "direct" }
  | {
      readonly kind: "verified";
      readonly integrationBranch: string;
      readonly requiredChecks: readonly string[];
      readonly checkTimeoutMs: number;
      readonly pollIntervalMs: number;
      readonly noChecksGraceMs: number;
      readonly openPullRequest: boolean;
    };

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

  // How the merge result lands on the source branch. Default: {kind:"direct"}.
  // Turn on `verified` when anything downstream of the source branch trusts it
  // without re-checking (a deploy on push, a release job).
  readonly mergeMode?: MergeModeConfig;
};

// After resolution every defaultable field is concrete. `codingStandardsPath`
// is the only one that stays optional (genuinely absent on most hosts). The
// other three are re-declared rather than merely `Required<>`d because
// resolution changes their TYPE, not just their presence: `labels` widens from
// Partial to the fully-populated vocabulary, `dbSidecar` and `mergeMode` become
// their resolved-and-validated forms.
export type ResolvedConfig = Required<
  Omit<
    RunConfig,
    "codingStandardsPath" | "labels" | "dbSidecar" | "mergeMode"
  >
> & {
  readonly codingStandardsPath?: string;
  readonly labels: LabelConfig;
  readonly dbSidecar: ResolvedDbSidecarConfig;
  readonly mergeMode: ResolvedMergeMode;
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
export const DEFAULT_INTEGRATION_BRANCH = "sandbar/integration";
// 20 minutes. Covers a queued runner plus a browser suite; a repo whose CI is
// genuinely slower should raise it rather than have sandbar park good cycles.
export const DEFAULT_CHECK_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_CHECK_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_NO_CHECKS_GRACE_MS = 120_000;

// Non-negative, finite, real number. `> 0` alone lets NaN and Infinity through:
// NaN fails every comparison, so `elapsed >= NaN` is never true and the check
// poll would spin forever holding the single-instance lock; Infinity does the
// same by construction. A host computing a timeout from `Number(process.env.X)`
// on an unset var produces exactly NaN, so this is the likely typo, not an
// exotic one.
function requirePositiveMs(label: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SandbarError(
      `config.mergeMode: ${label} must be a positive, finite number of ` +
        `milliseconds (got ${String(value)}).`,
    );
  }
  return value;
}

export function resolveMergeMode(
  mode: MergeModeConfig | undefined,
  sourceBranch: string,
): ResolvedMergeMode {
  if (!mode || mode.kind === "direct") return { kind: "direct" };
  const integrationBranch = (
    mode.integrationBranch ?? DEFAULT_INTEGRATION_BRANCH
  ).trim();
  // Same ref for both would make the "push somewhere safe, verify, then
  // fast-forward" sequence a direct push to the source branch with extra steps
  // — i.e. exactly the hole verified mode exists to close, silently.
  if (integrationBranch === sourceBranch.trim()) {
    throw new SandbarError(
      `config.mergeMode: integrationBranch must differ from sourceBranch ` +
        `(both are '${sourceBranch}'). The integration branch is a scratch ref ` +
        `sandbar force-pushes unverified merge results to.`,
    );
  }
  // An empty or refs/-prefixed value produces a ref nothing triggers CI for, and
  // the symptom (a whole cycle's work parked, or now a fatal) would arrive long
  // after the typo. `sandbar/issue-*` is reserved: the preflight cleanup deletes
  // branches matching it.
  if (integrationBranch === "") {
    throw new SandbarError(
      `config.mergeMode: integrationBranch must not be empty.`,
    );
  }
  if (integrationBranch.startsWith("refs/")) {
    throw new SandbarError(
      `config.mergeMode: integrationBranch must be a plain branch name, not a ` +
        `full ref (got '${integrationBranch}'). Sandbar pushes it as ` +
        `refs/heads/<name>.`,
    );
  }
  if (integrationBranch.startsWith(`${BRANCH_PREFIX}issue-`)) {
    throw new SandbarError(
      `config.mergeMode: integrationBranch must not match '${BRANCH_PREFIX}issue-*' ` +
        `(got '${integrationBranch}') — sandbar's preflight cleanup deletes ` +
        `branches under that prefix.`,
    );
  }
  // Confined to sandbar's own namespace, because this ref is FORCE-PUSHED every
  // round with an unverified merge result. The lease is no protection: it is
  // read from ls-remote milliseconds before the push, so it only catches a
  // change inside that window — by design, since the ref is sandbar's to
  // clobber. Point it at a branch someone else uses (`integrationBranch: "main"`
  // with `sourceBranch: "develop"` is the shape) and cycle 1 destroys that
  // branch. Requiring the prefix makes "is this ref mine to overwrite?" a
  // question config can actually answer.
  if (!integrationBranch.startsWith(BRANCH_PREFIX)) {
    throw new SandbarError(
      `config.mergeMode: integrationBranch must start with '${BRANCH_PREFIX}' ` +
        `(got '${integrationBranch}'). Sandbar force-pushes this ref on every ` +
        `verification round, so it must live in a namespace sandbar owns — ` +
        `otherwise a name collision silently overwrites a real branch.`,
    );
  }
  // Verified mode's whole claim is that an unknown verdict never lands, and
  // nothing else can distinguish a check that is merely late from one that will
  // never be reported. Refusing to resolve is the only honest option: a default
  // of [] would silently reduce "verified" to "nothing visible was failing at
  // the moment I looked".
  const requiredChecks = mode.requiredChecks.map((c) => c.trim());
  if (requiredChecks.length === 0 || requiredChecks.some((c) => c === "")) {
    throw new SandbarError(
      `config.mergeMode: verified mode requires a non-empty requiredChecks — ` +
        `the check-run names (as the forge reports them) that must exist and ` +
        `pass before anything lands. Without them sandbar cannot tell a check ` +
        `that hasn't started from one that will never run, which is the exact ` +
        `failure verified mode exists to catch.`,
    );
  }
  const checkTimeoutMs = requirePositiveMs(
    "checkTimeoutMs",
    mode.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
  );
  const pollIntervalMs = requirePositiveMs(
    "pollIntervalMs",
    mode.pollIntervalMs ?? DEFAULT_CHECK_POLL_INTERVAL_MS,
  );
  const noChecksGraceMs = requirePositiveMs(
    "noChecksGraceMs",
    mode.noChecksGraceMs ?? DEFAULT_NO_CHECKS_GRACE_MS,
  );
  if (noChecksGraceMs >= checkTimeoutMs) {
    throw new SandbarError(
      `config.mergeMode: noChecksGraceMs (${noChecksGraceMs}) must be less than ` +
        `checkTimeoutMs (${checkTimeoutMs}) — otherwise the wait always times out ` +
        `first and the "the forge does not build this ref" halt becomes ` +
        `unreachable, quietly degrading a loud configuration failure into a ` +
        `parked cycle every run.`,
    );
  }
  if (pollIntervalMs > checkTimeoutMs) {
    throw new SandbarError(
      `config.mergeMode: pollIntervalMs (${pollIntervalMs}) must not exceed ` +
        `checkTimeoutMs (${checkTimeoutMs}) — the wait would overshoot the ` +
        `timeout by a full interval before ever re-reading the checks.`,
    );
  }
  return {
    kind: "verified",
    integrationBranch,
    requiredChecks,
    checkTimeoutMs,
    pollIntervalMs,
    noChecksGraceMs,
    openPullRequest: mode.openPullRequest ?? false,
  };
}

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
  const sourceBranch = config.sourceBranch ?? DEFAULT_SOURCE_BRANCH;
  return {
    ...config,
    cwd: config.cwd ?? DEFAULT_CWD(),
    workDir: config.workDir ?? DEFAULT_WORK_DIR,
    sourceBranch,
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
    mergeMode: resolveMergeMode(config.mergeMode, sourceBranch),
  };
}
