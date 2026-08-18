import type { SandboxHooks } from "./agent-sandbox.js";
import { SandbarError } from "./errors.js";
import { BRANCH_PREFIX } from "./naming.js";

// The maximum a readiness probe may poll before its container counts as failed.
export const DEFAULT_READINESS_TIMEOUT_MS = 60_000;

// The maximum a gate STEP may run before it is killed and the gate goes red
// (#26), when the step doesn't name its own bound.
//
// The number only has to be "obviously longer than any step a working repo has,
// and finite". 15 minutes clears a full browser suite on a cold cache several
// times over, so a default-bounded step that trips this has hung rather than
// been slow — which matters, because a spurious timeout is a false red that
// costs the issue one of its eight implementation attempts. It also keeps the
// worst case legible: a gate run stops at the first red, so one hung step costs
// one bound, and the whole attempt budget cannot burn more than a couple of
// hours against a wedged suite.
export const DEFAULT_STEP_TIMEOUT_MS = 900_000;

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

// ---------------------------------------------------------------------------
// The gate stack (#24)
//
// A verdict is about a COMMIT, and producing it may take several containers on
// one network namespace plus an ordered list of steps that run in them. The
// consumer declares that stack; sandbar owns only its lifecycle (pod, network,
// naming, bringup order, teardown) and the fact that the steps' exit codes are
// the verdict.
//
// This replaces the single `dbSidecar` + two fixed `gateCommands` of #20/#15.
// The sidecar dissolved into `containers[]` the moment the pod removed the need
// for a pinned IP: with every container sharing one namespace, the address the
// consumer could not know at config time (`DB_HOST`) is the literal
// `127.0.0.1` it writes in the container's own `env`. No reserved keys, no
// `gateEnv` channel, no `port` that exists only to derive `DB_PORT`.
// ---------------------------------------------------------------------------

// A host file or directory made visible inside a stack container. `hostPath`
// resolves against the WORKTREE being gated (the issue worktree in the inner
// loop; the merger worktree for gate-2), so a branch that changes its schema
// fixture gates against its own version. Relative paths are the convention, not
// a jail — `..` and absolute paths are honored, since consumer config is
// trusted. Always mounted read-only, always SELinux-relabelled (`ro,z`).
// Neither path may contain `:` (podman `-v` specs are colon-delimited, with no
// escape mechanism; enforced fail-loud).
export type StackMount = {
  // Path relative to the gated worktree root (absolute paths pass through).
  readonly hostPath: string;
  readonly containerPath: string;
};

// How sandbar decides a container is ready to be used.
//
//   tcp  — connect to the port from the HOST, through a loopback-only,
//          podman-assigned ephemeral publish on the pod. The alternative
//          (exec a probe inside the namespace) needs a shell and a socket tool
//          in an image sandbar does not control — mailhog, pause images and
//          most scratch-based services have neither. The publish is
//          `127.0.0.1::<port>` with podman picking the host side, so two
//          concurrent stacks cannot collide and nothing is reachable off-box.
//   log  — a substring that must appear in the container's log.
//   exec — argv run inside the container until it exits 0 (#20's
//          `readinessCommand`). `podman exec` sessions see the container's own
//          env, so a password can be referenced via `sh -c '… $PASSWORD …'`.
//
// Omitting readiness means "running is ready" — right for a held container
// (`hold: true`), wrong for anything with a startup sequence.
export type Readiness =
  | { readonly kind: "tcp"; readonly port: number }
  | { readonly kind: "log"; readonly pattern: string }
  | { readonly kind: "exec"; readonly argv: readonly string[] };

// One container in the stack.
//
// `lifecycle` is load-bearing beyond bringup order — it decides whose failure a
// failed bringup is (#24 D5). An `issue` container depends only on its image
// and its env, never on the branch's code, so it failing to start is INFRA:
// HARD-ERROR, retry with a fresh stack. An `attempt` container mounts the
// worktree and runs branch code, so it failing to start is the branch's fault
// like any red test: gate red, with the container's log as the failure trace,
// and the implementer gets another attempt to fix its own bootstrap. Getting
// this backwards means an agent that breaks the service bootstrap burns two
// fresh-stack retries reproducing the same failure and then lands on
// NEEDS-HUMAN with an "environment" trace for a bug it could have fixed.
export type StackContainer = {
  // Becomes `sandbar-<stackId>-<name>`; also what a step's `in` refers to.
  readonly name: string;
  // Fully qualified image ref (hosts without unqualified-search registries
  // can't resolve bare short names), or a tag built by `images[]`.
  readonly image: string;
  // Default: "attempt" — the safe side, since a container wrongly marked
  // `issue` would be reused across attempts with stale branch code in it.
  readonly lifecycle?: "issue" | "attempt";
  readonly env?: Readonly<Record<string, string>>;
  // Args appended AFTER the image ref (the image CMD, not podman flags), e.g.
  // `--sql-mode=…`. Default: []. Mutually exclusive with `hold`.
  readonly args?: readonly string[];
  // Read-only fixture mounts. Default: [].
  readonly mounts?: readonly StackMount[];
  // Absolute container path to bind-mount the gated worktree at, `rw,z`, and
  // the container's working directory. The image must run as root or as the
  // host uid — `--userns=keep-id` cannot be combined with `--pod`, so a
  // container running as an arbitrary non-root uid maps to a subuid and its
  // writes to the worktree fail with EACCES. Checked empirically at startup
  // (see ensure-images.ts) rather than left to fail mid-gate.
  readonly mountWorktree?: string;
  // "The steps consume the worktree THROUGH me" — this container mounts the
  // branch's code and serves it to steps that run somewhere else (an app the
  // playwright container drives over 127.0.0.1). It exists because the property
  // the gate actually needs — the steps can see the code under test — is not
  // structurally decidable (#29): a container that mounts the worktree and is
  // never stepped into is either that app, or a stale mount left on a database
  // by a refactor, and the config says exactly the same thing in both cases.
  // The sound half of the rule is checked for free (some stepped-into container
  // mounts the worktree); this is how the other shape says so out loud, and is
  // needed ONLY by a stack that has no stepped-into mount at all.
  readonly servesWorktree?: boolean;
  // The image has no long-running process of its own: hold it open with
  // `sleep infinity` so steps can `podman exec` into it. This is what makes a
  // one-shot task runner an ordinary container rather than a special case.
  readonly hold?: boolean;
  readonly readiness?: Readiness;
  // How long `readiness` may poll before this container counts as failed.
  // Default: 60s. Raise it when mounts load a large schema or the container
  // builds an app on startup — the probe is what waits those out.
  readonly readinessTimeoutMs?: number;
  // Argv lists exec'd in the container after readiness, in order, each required
  // to exit 0 (fail-loud). One-shot setup that genuinely cannot be a step,
  // because steps run per gate run and this runs once per container. Default: [].
  readonly postReadyCommands?: ReadonlyArray<readonly string[]>;
};

// One gate step: argv `podman exec`'d in a named container. The full list runs
// in order on every gate run and stops at the first red — its exit code is the
// verdict, its output is the failure trace.
export type GateStep = {
  readonly name: string;
  // The `name` of a container declared in the same stack.
  readonly in: string;
  readonly command: readonly string[];
  // How long this step may run before it is killed and the gate goes red (#26).
  // Default: 15 minutes. A lint step and a browser suite do not want the same
  // bound and the consumer is the only one who knows which is which, so this is
  // per step — but it is not optional in the resolved shape, because an
  // unbounded step hangs the inner loop, the outer loop and the single-instance
  // lock forever, with no HARD-ERROR and no teardown.
  //
  // Milliseconds, matching `readinessTimeoutMs` in the same config object.
  // #26 proposed `timeoutSeconds`; two units inside one `gateStack` literal is
  // a footgun worth more than the ergonomic win of writing 900 instead of
  // 900_000.
  readonly timeoutMs?: number;
};

// An image sandbar builds before the run, if it isn't already present.
export type BuiltImage = {
  readonly tag: string;
  readonly containerfile: string;
  // Build with NO context: `podman build -t <tag> - < <containerfile>`. For a
  // Containerfile that only pulls from a registry, this skips tarring the repo.
  readonly stdinContext?: boolean;
  // `--build-arg k=v` pairs. The intended use is uid alignment for an image
  // that must run as the host user (`AGENT_UID: String(process.getuid?.() ?? 0)`);
  // sandbar injects no magic ARG name, it passes exactly what is declared.
  readonly buildArgs?: Readonly<Record<string, string>>;

  // Repo-relative paths this image is a FUNCTION OF (#37) — a lockfile, a
  // manifest, a patch directory. Sandbar hashes them (plus the Containerfile's
  // own bytes, since an image is also a function of its recipe) and treats the
  // hash as the real cache key:
  //
  //   - at startup, the tag is rebuilt when its recorded hash no longer matches
  //     the build context, instead of being reused because the NAME exists;
  //   - before every gate run, the gated worktree's hash is compared against
  //     the base image's. A branch that changed one of these paths gets its own
  //     image, built from that worktree, and the stack's containers are
  //     recreated from it.
  //
  // Undeclared, an image that bakes dependencies is pinned to the source branch
  // for the whole run, so a branch that adds a dependency reds the gate with a
  // module-not-found nobody can reproduce and a branch that removes one greens
  // against a dependency it deleted. Both are silent.
  //
  // Declare only what the image actually bakes. Every path listed is hashed on
  // every gate run and a change forces a rebuild, so listing a source directory
  // buys nothing the worktree mount doesn't already give and costs a build per
  // attempt.
  readonly rebuildOn?: readonly string[];

  // Deadline for this entry's `podman build`, in milliseconds. Default 45
  // minutes. It exists because a `rebuildOn` build runs INSIDE a gate run from
  // a recipe the implementer agent wrote, while the run holds the
  // single-instance lock — an unbounded one is a run that never ends. Per entry
  // for the same reason `step.timeoutMs` is per step: a `FROM alpine` and a 6GB
  // browser image do not want the same ceiling.
  readonly buildTimeoutMs?: number;
};

export type GateStackConfig = {
  readonly containers: readonly StackContainer[];
  readonly steps: readonly GateStep[];
};

// Every defaultable field made concrete. Optional fields become `| null` rather
// than staying optional so no consumer of the resolved shape has to re-decide
// what absence means.
export type ResolvedStackContainer = {
  readonly name: string;
  readonly image: string;
  readonly lifecycle: "issue" | "attempt";
  readonly env: Readonly<Record<string, string>>;
  readonly args: readonly string[];
  readonly mounts: readonly StackMount[];
  readonly mountWorktree: string | null;
  readonly servesWorktree: boolean;
  readonly hold: boolean;
  readonly readiness: Readiness | null;
  readonly readinessTimeoutMs: number;
  readonly postReadyCommands: ReadonlyArray<readonly string[]>;
};

export type ResolvedGateStep = {
  readonly name: string;
  readonly in: string;
  readonly command: readonly string[];
  readonly timeoutMs: number;
};

export type ResolvedGateStack = {
  readonly containers: readonly ResolvedStackContainer[];
  readonly steps: readonly ResolvedGateStep[];
};

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
// exists" (repo identity, the sandbox image, the gate stack, the bot identity,
// the sandbox hooks). Optional ⇔ "has a de-facto-standard value sandbar fills
// in".
export type RunConfig = {
  // ---- Required: repo-specific facts with no sensible default -------------
  readonly ghOwner: string;
  readonly ghRepo: string;

  // The image the AGENT runs in — the one with claude, git and the repo's
  // toolchain installed. Also the image the merger's resolve agent runs in.
  //
  // Explicit and required since #24: the sandbox provider previously fell
  // through to `defaultImageName(hostRepoPath)` = `sandbar:<repo-dir-name>`,
  // which happened to equal the configured `gateImage` only because someone had
  // written the two to match. Renaming the repo directory broke it silently.
  readonly sandboxImage: string;

  // The containers and steps that produce a verdict about a commit (#24). No
  // default: what it takes to test this repo is repo identity.
  readonly gateStack: GateStackConfig;

  // Commit/author identity for the bot. `coauthorTrailer` defaults to a
  // `Co-authored-by:` line derived from these two (see resolveConfig), so a
  // host normally supplies only name + email.
  readonly botName: string;
  readonly botEmail: string;

  // Per-sandbox lifecycle hooks (build/setup). Host-specific; no default.
  readonly sandboxHooks: SandboxHooks;

  // ---- Optional: tunable, with a documented default ------------------------
  // Where the host repo lives / where sandbar keeps its state. Defaults:
  // cwd = process.cwd(), workDir = ".sandbar".
  readonly cwd?: string;
  readonly workDir?: string;

  // Branch issue worktrees seed from and merges land on. Default: "main".
  readonly sourceBranch?: string;

  // Images sandbar builds before the run (skipped when the tag already exists).
  // Default: the single `{ tag: sandboxImage, containerfile: "Containerfile" }`
  // that a one-image repo would have written itself. Every OTHER image the
  // stack references must already be pulled — preflight refuses rather than
  // pulls, so no run does silent network work at startup.
  readonly images?: readonly BuiltImage[];

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
// Partial to the fully-populated vocabulary, `gateStack` and `mergeMode` become
// their resolved-and-validated forms.
export type ResolvedConfig = Required<
  Omit<
    RunConfig,
    "codingStandardsPath" | "labels" | "gateStack" | "mergeMode"
  >
> & {
  readonly codingStandardsPath?: string;
  readonly labels: LabelConfig;
  readonly gateStack: ResolvedGateStack;
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

// Podman container-name grammar, and also what makes `sandbar-<id>-<name>`
// parseable back into its parts by a human reading `podman ps`.
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

// Every validation below is a config mistake that would otherwise surface as an
// opaque podman error minutes into a run, or — worse — as a gate that reports a
// verdict about the wrong thing. They are checked at resolve time, before the
// lock is taken, so a typo costs a second rather than a cycle.
export function resolveGateStack(stack: GateStackConfig): ResolvedGateStack {
  if (stack.containers.length === 0) {
    throw new SandbarError(
      "config.gateStack: containers must not be empty — a stack with no " +
        "containers has nowhere to run a step.",
    );
  }
  if (stack.steps.length === 0) {
    throw new SandbarError(
      "config.gateStack: steps must not be empty — a gate that runs no steps " +
        "would report success for every commit.",
    );
  }

  const seen = new Set<string>();
  const containers = stack.containers.map((c) => resolveStackContainer(c, seen));

  // A stack where nothing mounts the worktree gates the same bytes on every
  // attempt: it can go green while the branch under test is broken, which is
  // the one failure mode the whole gate exists to prevent.
  if (!containers.some((c) => c.mountWorktree !== null)) {
    throw new SandbarError(
      "config.gateStack: no container declares `mountWorktree`, so no step can " +
        "see the code under test. The gate would return the same verdict for " +
        "every commit.",
    );
  }

  // Two containers cannot both bind the same port inside one network namespace,
  // so a repeated tcp readiness port is always a config error. It has to be
  // rejected rather than tolerated: the pod publishes ONE host port per distinct
  // container port, so both containers would probe the same forwarded socket and
  // whichever one actually listens marks BOTH ready — handing the other to a
  // step, or to a dependant, mid-initialisation. That is exactly the green-on-red
  // TCP_SETTLE_MS was added to close, re-entering through config.
  const tcpPorts = new Map<number, string>();
  for (const c of containers) {
    if (c.readiness?.kind !== "tcp") continue;
    const prior = tcpPorts.get(c.readiness.port);
    if (prior !== undefined) {
      throw new SandbarError(
        `config.gateStack: containers '${prior}' and '${c.name}' both declare ` +
          `tcp readiness on port ${c.readiness.port}. Pod members share one ` +
          "network namespace, so only one of them can be listening — and a " +
          "single publish would report both ready as soon as either binds.",
      );
    }
    tcpPorts.set(c.readiness.port, c.name);
  }

  const byName = new Set(containers.map((c) => c.name));
  const stepNames = new Set<string>();
  const steps: ResolvedGateStep[] = [];
  for (const step of stack.steps) {
    const stepName = step.name.trim();
    if (!stepName) {
      throw new SandbarError("config.gateStack: every step needs a name.");
    }
    // Compared trimmed, because the uniqueness rule exists so the failing step
    // is identifiable in the trace, and "test" and "test " render identically
    // there. Container names get this for free from CONTAINER_NAME_RE.
    if (stepNames.has(stepName)) {
      throw new SandbarError(
        `config.gateStack: duplicate step name '${step.name}'. Step names ` +
          "identify the failing step in the trace, so they must be unique.",
      );
    }
    stepNames.add(stepName);
    if (!byName.has(step.in)) {
      throw new SandbarError(
        `config.gateStack: step '${step.name}' runs in '${step.in}', which is ` +
          `not a declared container (have: ${[...byName].join(", ")}).`,
      );
    }
    if (step.command.length === 0) {
      throw new SandbarError(
        `config.gateStack: step '${step.name}' has an empty command.`,
      );
    }
    // The bound is a `setTimeout` sandbar owns (gate-stack.ts, `boundedPodman`),
    // so 0, a negative, and NaN all fire on the next tick rather than meaning
    // "no bound" — every step would be killed instantly and the gate would red
    // on a suite that never got to run a test, every attempt, until the budget
    // died. Infinity is the mirror: a bound that can never fire. NaN is the one
    // that actually reaches here, from a misparsed env var.
    const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new SandbarError(
        `config.gateStack: step '${step.name}' has a non-positive or ` +
          `non-finite timeoutMs (${String(timeoutMs)}). A non-positive or NaN ` +
          "bound fires immediately, killing every step before it can run; an " +
          "infinite one never fires, and an unbounded step hangs the run " +
          "holding the single-instance lock.",
      );
    }
    steps.push({
      name: step.name,
      in: step.in,
      command: step.command,
      timeoutMs,
    });
  }

  // The check above only asks whether SOMETHING mounts the worktree, which a
  // stack can satisfy while every step runs somewhere that cannot see the
  // branch (#29) — the same verdict for every commit, green included, which is
  // verbatim what that check claims to prevent.
  //
  // The property actually wanted is "the steps can see the code under test",
  // and it is not structurally decidable: a worktree-mounting container that no
  // step enters is either an app serving the branch to a playwright container
  // over 127.0.0.1, or a stale mount a refactor left on a database, and the
  // config is byte-identical in both cases. Readiness doesn't separate them
  // either — a realistic database declares `readiness` too. So the SOUND half
  // is checked (some stepped-into container mounts it, which every ordinary
  // stack satisfies for free) and the other shape has to say so out loud.
  //
  // A throw rather than a warning because the failure mode is silent and
  // GREEN: a warning scrolls past at startup and the gate merges broken code
  // for as long as nobody re-reads it.
  const steppedInto = new Set(stack.steps.map((step) => step.in));
  const mounting = containers.filter((c) => c.mountWorktree !== null);
  if (!mounting.some((c) => steppedInto.has(c.name) || c.servesWorktree)) {
    const names = mounting.map((c) => `'${c.name}'`).join(", ");
    throw new SandbarError(
      `config.gateStack: ${names} mount the worktree but no step runs in ` +
        `${mounting.length === 1 ? "it" : "any of them"}, and none declares ` +
        "`servesWorktree`. Every step runs in a container that cannot see the " +
        "code under test, so the gate would return the same verdict for every " +
        "commit. Either run a step in a container that mounts the worktree, " +
        "or — if one of these serves the branch's code to the steps over " +
        "127.0.0.1 — mark it `servesWorktree: true`.",
    );
  }

  // Checked AFTER the reachability rule above, and deliberately: #29's own
  // reproducer trips both, and the reachability error is the one that explains
  // the reported symptom. Fixing the lifecycle first would only hand the
  // consumer a config that throws the other error on the next run.
  //
  // D5 defines `issue` as "depends only on its image and its env, never on the
  // branch's code" — that is the whole reason its bringup failure is classed
  // infra and spends two HARD-ERROR retries on a fresh stack. A container that
  // runs its image's own entrypoint over a mounted worktree runs branch code at
  // bringup by construction, so a branch that breaks its startup is blamed on
  // the environment and lands NEEDS-HUMAN with an "environment" trace.
  //
  // Scoped to un-held containers, because that is exactly as far as the
  // argument reaches: under `hold` the entrypoint is `sleep infinity` and
  // NOTHING of the branch's executes at bringup, so `issue` is honest there —
  // and it is the one place a per-issue setup can live, since
  // `postReadyCommands` run once per container and an `attempt` container is
  // recreated every gate run. That shape does re-open the misblame window
  // through its own `postReadyCommands`, which is the consumer's argv and the
  // consumer's call; it is not something a validator can decide.
  for (const c of containers) {
    if (c.mountWorktree === null || c.lifecycle !== "issue" || c.hold) continue;
    throw new SandbarError(
      `config.gateStack: container '${c.name}' is lifecycle 'issue', mounts ` +
        "the worktree and runs its own entrypoint. An `issue` container is " +
        "reused across attempts because it depends only on its image and its " +
        "env — so a failure to start it is infra, and costs two HARD-ERROR " +
        "retries on a fresh stack before the issue lands on NEEDS-HUMAN with " +
        "an 'environment' trace. Booting the branch's code breaks that: use " +
        "lifecycle 'attempt', `mounts` if this container only needs fixture " +
        "files from the worktree, or `hold` if it has no process of its own.",
    );
  }

  return { containers, steps };
}

function resolveStackContainer(
  c: StackContainer,
  seen: Set<string>,
): ResolvedStackContainer {
  if (!CONTAINER_NAME_RE.test(c.name)) {
    throw new SandbarError(
      `config.gateStack: container name '${c.name}' is not a valid podman name ` +
        "(alphanumeric first character, then alphanumerics, '_', '.' or '-').",
    );
  }
  if (seen.has(c.name)) {
    throw new SandbarError(
      `config.gateStack: duplicate container name '${c.name}'. Names become ` +
        "container names and are what a step's `in` refers to.",
    );
  }
  seen.add(c.name);

  if (!c.image.trim()) {
    throw new SandbarError(
      `config.gateStack: container '${c.name}' has no image.`,
    );
  }
  const hold = c.hold ?? false;
  // `hold` replaces the entrypoint with `sleep infinity`; `args` would be
  // appended after `infinity` and silently ignored, so the consumer's CMD
  // arguments would vanish rather than fail.
  if (hold && (c.args?.length ?? 0) > 0) {
    throw new SandbarError(
      `config.gateStack: container '${c.name}' sets both 'hold' and 'args'. ` +
        "'hold' overrides the entrypoint with `sleep infinity`, so 'args' would " +
        "never reach the image.",
    );
  }
  if (c.mountWorktree !== undefined) {
    if (!c.mountWorktree.startsWith("/")) {
      throw new SandbarError(
        `config.gateStack: container '${c.name}' has a relative mountWorktree ` +
          `('${c.mountWorktree}'). It is a path inside the container and must be ` +
          "absolute.",
      );
    }
    // Same colon rule as `mounts` below, and it belongs here MORE: every valid
    // stack has at least one mountWorktree (a stack where nothing mounts the
    // worktree is rejected outright), so this is the most-travelled `-v` spec
    // sandbar builds. It was the one left unchecked.
    if (c.mountWorktree.includes(":")) {
      throw new SandbarError(
        `config.gateStack: container '${c.name}' has a mountWorktree ` +
          `containing ":" ('${c.mountWorktree}'). podman -v specs are ` +
          "colon-delimited and offer no escape, so this would re-split into a " +
          "different path and mount options.",
      );
    }
    if (c.mountWorktree === "/") {
      throw new SandbarError(
        `config.gateStack: container '${c.name}' mounts the worktree at '/', ` +
          "which would shadow the image's entire filesystem.",
      );
    }
  } else if (c.servesWorktree === true) {
    // Nothing to serve. Left unchecked it would be a false answer to the one
    // question the #29 rule asks, which is worse than no answer.
    throw new SandbarError(
      `config.gateStack: container '${c.name}' sets 'servesWorktree' but does ` +
        "not set 'mountWorktree', so it cannot see the code under test and " +
        "has nothing to serve to the steps.",
    );
  }
  // `hold` replaces the entrypoint with `sleep infinity`, so the container runs
  // nothing OF ITS OWN — but sandbar execs `postReadyCommands` into it after
  // readiness, and one that backgrounds a daemon leaves a held container
  // genuinely serving. That is the only route for an image whose ENTRYPOINT is
  // not a shell, so the rule is the narrow, decidable one: held AND nothing
  // exec'd after readiness is a container that provably runs nothing, and its
  // claim to serve the steps is false rather than merely unlikely.
  if (
    c.servesWorktree === true &&
    hold &&
    (c.postReadyCommands?.length ?? 0) === 0
  ) {
    throw new SandbarError(
      `config.gateStack: container '${c.name}' sets 'servesWorktree' with ` +
        "'hold' and no 'postReadyCommands'. 'hold' overrides the entrypoint " +
        "with `sleep infinity`, so nothing in this container ever runs and it " +
        "can serve nothing. Either run a step in it (then it is stepped into " +
        "and needs no declaration at all), or start the server from a " +
        "'postReadyCommands' entry.",
    );
  }
  for (const m of c.mounts ?? []) {
    // podman's `-v` spec is colon-delimited with no escape mechanism, so a
    // colon anywhere would re-split the spec into different paths + options.
    if (m.hostPath.includes(":") || m.containerPath.includes(":")) {
      throw new SandbarError(
        `config.gateStack: container '${c.name}' has a mount path containing ` +
          `":" (${m.hostPath} -> ${m.containerPath}). podman -v specs are ` +
          "colon-delimited and offer no escape.",
      );
    }
    // An empty hostPath resolves to the worktree ROOT, so the whole tree gets
    // bind-mounted read-only somewhere nobody asked for — silently, since
    // podman is perfectly happy to do it.
    if (!m.hostPath.trim()) {
      throw new SandbarError(
        `config.gateStack: container '${c.name}' has a mount with an empty ` +
          `hostPath (-> ${m.containerPath}). It is resolved against the ` +
          "worktree, and empty resolves to the worktree root.",
      );
    }
    // The mirror of the mountWorktree rule: podman rejects a relative
    // destination at container-create time, which for an `attempt` container
    // arrives as a gate red blamed on the branch.
    if (!m.containerPath.startsWith("/")) {
      throw new SandbarError(
        `config.gateStack: container '${c.name}' has a mount with a relative ` +
          `containerPath ('${m.containerPath}'). It is a path inside the ` +
          "container and must be absolute.",
      );
    }
  }
  const readiness = c.readiness ?? null;
  if (readiness?.kind === "tcp") {
    if (
      !Number.isInteger(readiness.port) ||
      readiness.port < 1 ||
      readiness.port > 65535
    ) {
      throw new SandbarError(
        `config.gateStack: container '${c.name}' has an out-of-range tcp ` +
          `readiness port (${readiness.port}).`,
      );
    }
  }
  if (readiness?.kind === "exec" && readiness.argv.length === 0) {
    throw new SandbarError(
      `config.gateStack: container '${c.name}' has an empty exec readiness argv.`,
    );
  }
  if (readiness?.kind === "log" && !readiness.pattern) {
    throw new SandbarError(
      `config.gateStack: container '${c.name}' has an empty log readiness pattern.`,
    );
  }
  for (const command of c.postReadyCommands ?? []) {
    // Checked like `step.command` and `readiness.exec.argv`, which it sits
    // beside: an empty argv reaches podman as a bare `exec <container>` and
    // fails as a bringup error — two wasted HARD-ERROR retries for an
    // `issue` container, a branch-blamed gate red for an `attempt` one.
    if (command.length === 0) {
      throw new SandbarError(
        `config.gateStack: container '${c.name}' has an empty postReadyCommand.`,
      );
    }
  }
  // The one env key sandbar owns is applied AFTER the consumer's, so a
  // consumer-set CI would be silently discarded. Some runners genuinely change
  // behaviour on it, so say so rather than quietly winning.
  for (const key of Object.keys(c.env ?? {})) {
    if (key === "CI") {
      throw new SandbarError(
        `config.gateStack: container '${c.name}' sets the reserved env key ` +
          "'CI'. sandbar sets CI=true for every stack container and step, and " +
          "a value here would be silently overridden.",
      );
    }
  }
  const readinessTimeoutMs = c.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  if (!Number.isFinite(readinessTimeoutMs) || readinessTimeoutMs <= 0) {
    throw new SandbarError(
      `config.gateStack: container '${c.name}' has a non-positive or ` +
        `non-finite readinessTimeoutMs (${String(readinessTimeoutMs)}). NaN — ` +
        "the shape `Number(process.env.X)` produces on an unset var — would " +
        "make the readiness poll spin forever holding the run's lock.",
    );
  }

  return {
    name: c.name,
    image: c.image,
    lifecycle: c.lifecycle ?? "attempt",
    env: c.env ?? {},
    args: c.args ?? [],
    mounts: c.mounts ?? [],
    mountWorktree: c.mountWorktree ?? null,
    servesWorktree: c.servesWorktree ?? false,
    hold,
    readiness,
    readinessTimeoutMs,
    postReadyCommands: c.postReadyCommands ?? [],
  };
}

// The `rebuildOn` paths of one image entry, validated and deduplicated.
//
// They are joined against a worktree root and hashed, so every rejection here
// is a path that would either escape that root or name nothing. Deduplicated
// rather than rejected on repeats: the same file listed twice is a harmless
// copy-paste, and hashing it twice would make the fingerprint depend on how
// many times it was written down.
function resolveRebuildOn(img: BuiltImage): readonly string[] {
  const paths = img.rebuildOn ?? [];
  if (paths.length === 0) return [];
  if (img.stdinContext) {
    throw new SandbarError(
      `config.images: entry '${img.tag}' sets both \`stdinContext\` and ` +
        "`rebuildOn`. A stdin-context build has no context at all, so nothing " +
        "in the repo can enter the image and no path can change it. Drop one.",
    );
  }
  // The per-branch rebuild re-roots the build at the gated worktree
  // (`<worktree>/<containerfile>`), which an absolute path cannot express: it
  // would rebuild from the host checkout and answer the same wrong question
  // the whole feature exists to stop answering.
  if (img.containerfile.startsWith("/")) {
    throw new SandbarError(
      `config.images: entry '${img.tag}' declares \`rebuildOn\` but its ` +
        `containerfile ('${img.containerfile}') is absolute. A per-branch ` +
        "rebuild builds it from the gated worktree, so the path has to be " +
        "relative to the repo root.",
    );
  }
  // `dirname` of the containerfile, normalised to "" for the repo root — which
  // is what `buildArgv` passes podman as the context.
  const slash = img.containerfile.lastIndexOf("/");
  const context = slash === -1 ? "" : img.containerfile.slice(0, slash);
  const out: string[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path) {
      throw new SandbarError(
        `config.images: entry '${img.tag}' has an empty \`rebuildOn\` path.`,
      );
    }
    if (path.startsWith("/")) {
      throw new SandbarError(
        `config.images: entry '${img.tag}' has an absolute \`rebuildOn\` path ` +
          `('${path}'). These are repo-relative — they are resolved against ` +
          "the host checkout and against each gated worktree in turn, and an " +
          "absolute path would name the same file both times.",
      );
    }
    const segments = path.split("/");
    if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
      throw new SandbarError(
        `config.images: entry '${img.tag}' has a \`rebuildOn\` path with a ` +
          `'.', '..' or empty segment ('${path}'). It is resolved against a ` +
          "worktree root and must stay inside it; write the plain relative " +
          "path (`package-lock.json`, `packages/api/bun.lock`).",
      );
    }
    // The build context is the containerfile's OWN directory (see
    // `buildArgv`), so a declared path outside it cannot be `COPY`d and the
    // image cannot be a function of it. Unchecked, that config passes
    // everything else here, changes its fingerprint on every edit, pays a
    // variant build per gate run, and produces an image byte-identical to the
    // base — the gate still pinned to the source branch, which is #37 exactly.
    // A silent no-op wearing the fix.
    if (context && !`${path}/`.startsWith(`${context}/`)) {
      throw new SandbarError(
        `config.images: entry '${img.tag}' declares \`rebuildOn\` path ` +
          `'${path}', which is outside its build context ('${context}/'). ` +
          "The context is the containerfile's own directory, so that path " +
          "cannot be COPYd into the image and the image cannot be a function " +
          "of it — sandbar would rebuild on every change and produce the same " +
          "image. Move the containerfile up to the directory that holds the " +
          "inputs, or list inputs from inside its own.",
      );
    }
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

export function resolveImages(
  images: readonly BuiltImage[] | undefined,
  sandboxImage: string,
): readonly BuiltImage[] {
  const declared = images ?? [
    { tag: sandboxImage, containerfile: DEFAULT_CONTAINERFILE_PATH },
  ];
  const seen = new Set<string>();
  const resolved: BuiltImage[] = [];
  for (const img of declared) {
    if (!img.tag.trim()) {
      throw new SandbarError("config.images: every entry needs a tag.");
    }
    if (seen.has(img.tag)) {
      throw new SandbarError(
        `config.images: duplicate tag '${img.tag}'. The second build would ` +
          "overwrite the first, so only one of the two Containerfiles would " +
          "ever be the image that runs.",
      );
    }
    seen.add(img.tag);
    if (!img.containerfile.trim()) {
      throw new SandbarError(
        `config.images: entry '${img.tag}' has no containerfile.`,
      );
    }
    // Same rule and same reason as `step.timeoutMs` (#26): the deadline is a
    // `setTimeout` sandbar owns, so 0 and NaN fire on the next tick — every
    // build killed before it starts — and Infinity never fires at all.
    if (img.buildTimeoutMs !== undefined) {
      if (!Number.isFinite(img.buildTimeoutMs) || img.buildTimeoutMs <= 0) {
        throw new SandbarError(
          `config.images: entry '${img.tag}' has a non-positive, NaN or ` +
            `infinite buildTimeoutMs (${img.buildTimeoutMs}). A build deadline ` +
            "must be a positive, finite number of milliseconds.",
        );
      }
    }
    resolved.push({ ...img, rebuildOn: resolveRebuildOn(img) });
  }
  // A consumer listing images at all must still build the sandbox image: it is
  // what the agent and the merger's resolve agent run in, and its absence is a
  // hard failure at the first `createSandbox`, long after the run started.
  if (!seen.has(sandboxImage)) {
    throw new SandbarError(
      `config.images: no entry builds sandboxImage '${sandboxImage}'. The agent ` +
        "sandbox and the merger's resolve agent both run in it; sandbar builds " +
        "only what `images` lists.",
    );
  }
  return resolved;
}

// `rebuildOn` on an image no gate-stack container runs is inert, and inertness
// is exactly the failure mode #37 is about: the operator has written down what
// the image is a function of, and sandbar would silently never act on it.
//
// The agent sandbox is deliberately NOT counted as a use. Its image is resolved
// once, when the sandbox is created, and the branch it would be a function of
// does not exist yet at that point — the agent writes it during the run. It is
// also an environment the agent controls and can install into, so a stale baked
// dependency there costs it a command, not a false verdict. Rebuilding it
// mid-cycle would mean disposing the sandbox the attempts accumulate in.
export function checkRebuildOnIsUsed(
  images: readonly BuiltImage[],
  gateStack: ResolvedGateStack,
): void {
  const gated = new Set(gateStack.containers.map((c) => c.image));
  for (const img of images) {
    if ((img.rebuildOn ?? []).length === 0) continue;
    if (gated.has(img.tag)) continue;
    throw new SandbarError(
      `config.images: entry '${img.tag}' declares \`rebuildOn\`, but no ` +
        "`gateStack.containers` entry runs that image, so nothing would ever " +
        "act on it. `rebuildOn` governs the per-branch rebuild of gate " +
        "images; the agent sandbox's image is resolved once, before the branch " +
        "it would depend on exists.",
    );
  }
}

export function defaultCoauthorTrailer(botName: string, botEmail: string): string {
  return `Co-authored-by: ${botName} <${botEmail}>`;
}

export function resolveConfig(config: RunConfig): ResolvedConfig {
  // Trimmed HERE, not just where it is compared. `resolveMergeMode` tests
  // `integrationBranch === sourceBranch.trim()`, so trimming only in the guard
  // made the guard describe a value that never existed: `" main "` would pass
  // the must-differ check against `"main"` and then reach every git and gh call
  // with the spaces still on it.
  const sourceBranch = (config.sourceBranch ?? DEFAULT_SOURCE_BRANCH).trim();
  const gateStack = resolveGateStack(config.gateStack);
  const images = resolveImages(config.images, config.sandboxImage);
  checkRebuildOnIsUsed(images, gateStack);
  return {
    ...config,
    cwd: config.cwd ?? DEFAULT_CWD(),
    workDir: config.workDir ?? DEFAULT_WORK_DIR,
    sourceBranch,
    images,
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
    gateStack,
    mergeMode: resolveMergeMode(config.mergeMode, sourceBranch),
  };
}
