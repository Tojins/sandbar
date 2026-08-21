import { resolve } from "node:path";

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
// trusted. Always SELinux-relabelled (`z`); read-only unless `mode` says
// otherwise. Neither path may contain `:` (podman `-v` specs are
// colon-delimited, with no escape mechanism; enforced fail-loud).
export type StackMount = {
  // Path relative to the gated worktree root (absolute paths pass through).
  readonly hostPath: string;
  readonly containerPath: string;
  // Default "ro", which is the right default for a fixture: a step that writes
  // into its own inputs makes the next run's verdict a function of the last
  // one's. "rw" exists because not every mount is a fixture — the motivating
  // case (#48) is a scratch directory a step writes THROUGH: this repo's own
  // gate identity-mounts the host's `/tmp`, so the fixtures the podman tests
  // build with `mkdtemp` are paths the host's podman can resolve.
  //
  // A podman SOCKET is deliberately NOT such a case, and must not be read as
  // one: a remote client drives it perfectly well under `ro` — measured, not
  // assumed — and widening it would hand a gate step write access to the
  // host's container runtime for no reason anyone had.
  //
  // This exposes the half of podman's `-v` that sandbar was hiding rather than
  // inventing anything: the hiding was the invention. Deliberately NOT a raw
  // `-v` spec string, which would take the colon and empty-`hostPath`
  // validation with it — a mis-specced `-v` is the most-travelled string
  // sandbar builds.
  readonly mode?: "ro" | "rw";
};

// How sandbar decides a container is ready to be used: ONE kind, an argv that
// podman registers as the container's healthcheck and that sandbar's own poll
// loop invokes on demand (#43).
//
// `command` is REQUIRED, and that is a measurement rather than a preference.
// Omitting `--health-cmd` — i.e. falling back to the image's own `HEALTHCHECK`
// — is the only configuration in which podman SCHEDULES the check, and it does
// so with a transient systemd timer named by container id, outside the
// `sandbar-<scope>-*` namespace the orphan sweep can reach. `gate-stack.ts`
// passes `--health-interval=disable` to suppress that, and the flag is ignored
// unless a `--health-cmd` is given. So the fallback would re-import, for that
// one container, a systemd-session dependency and a timer a SIGKILLed run
// leaks forever. Its reach would be small anyway: `podman build` defaults to
// the OCI format, which has no `HEALTHCHECK` field at all, so no image sandbar
// itself builds carries one — and `mariadb:10.11`, the worked example this
// feature was designed against, declares none either (it ships
// `/usr/local/bin/healthcheck.sh` and leaves the instruction out).
//
// Argv, not a shell string, matching `step.command` and `postReadyCommands`.
// A shell probe is spelled `["sh", "-c", "…"]`; the probe runs inside the
// container and sees its env, so a password can be referenced as
// `sh -c '… $PASSWORD …'`.
//
// This replaces the `tcp`, `log` and `exec` kinds, which are rejected by name
// at resolve time with their translation (see `resolveStackContainer`). `exec`
// is subsumed exactly. `log` is subsumed AND fixed — a reused `issue`
// container whose log the host's journal has since vacuumed could never match
// its boot-time pattern again, so it burned the whole readiness budget and
// reddened the gate on a service that was answering the whole time. `tcp` is
// subsumed by an in-container probe, which is strictly better where it applies:
// no publish, and no settle window, because the rootless port forwarder that
// made a bare connect a green-on-red is not in the path.
//
// Known limitation, recorded rather than solved: a genuine `scratch` image with
// no shell and no probe binary can no longer declare readiness, where `tcp`
// could. The escape hatches are a static probe binary in the image, or
// `hold: true` plus a `postReadyCommand`.
//
// Omitting readiness means "running is ready" — right for a held container
// (`hold: true`), wrong for anything with a startup sequence.
export type Readiness = {
  readonly kind: "healthcheck";
  readonly command: readonly string[];
};

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
  // Run a copy of this container beside the AGENT too, in the sandbox's own
  // network namespace (#44). Default false, and the default is what makes the
  // whole feature opt-in per container: declare it nowhere and no sandbox stack
  // is created, so nothing about an existing consumer's cost or topology moves.
  //
  // It exists because an agent that cannot run the application before the gate
  // does writes a test it has never watched fail and a fix it has never watched
  // pass — and the only way to give it one today is to rebuild the whole stack
  // as PROCESSES inside the sandbox image (a consumer really did apt-install
  // mariadb, download a libc-matched mailhog binary and hand-write 163 lines of
  // `pgrep`/`mysqladmin ping`/`setsid` supervision). Every bug in that is a bug
  // podman does not have, and the description of what it takes to run the app
  // already exists right here.
  //
  // Deliberately its own flag rather than the `lifecycle: "issue"` set: that
  // field answers a different question (whose failure a failed bringup is), and
  // the motivating consumer's application server is `attempt`-lifecycle and is
  // precisely what the agent needs to see. Deliberately not a separate
  // `config.sandboxStack` either — that reintroduces the second description of
  // the application this flag exists to delete.
  //
  // The sandbox copy is a SIBLING of the gate's, never the same container: the
  // agent must not be able to reach the stack its verdict is formed in, and
  // that property comes from being a different network namespace rather than
  // from the absence of a runtime. See sandbox-stack.ts.
  readonly inSandbox?: boolean;
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
  //     recreated from it;
  //   - and, for `sandboxImage`, once per agent sandbox, against the issue
  //     worktree the sandbox is about to mount (#46). Same comparison, one
  //     resolution per sandbox rather than per attempt, and a build that fails
  //     leaves the sandbox on the declared tag instead of refusing to start the
  //     container the fix would be written in.
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

// A `StackMount` with its `mode` decided, so `mountSpec` re-decides nothing.
export type ResolvedStackMount = {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly mode: "ro" | "rw";
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
  readonly mounts: readonly ResolvedStackMount[];
  readonly mountWorktree: string | null;
  readonly servesWorktree: boolean;
  readonly inSandbox: boolean;
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
  // The operator's own checkout, and the directory inside it that sandbar
  // owns. Sandbar does not OPERATE on `cwd` (#38): it clones a bare cache at
  // `<cwd>/<workDir>/repo.git` and every GIT call runs there, so the branch
  // deletes, worktree removals and force-pushes cannot reach the operator's
  // repo. (`gh` calls run in no particular directory since #34 — they name the
  // repository with `--repo` instead of letting a directory's remotes decide.) What sandbar still reads from `cwd` is the git identity,
  // the `copyToWorktree` sources, and the URL of its own `origin` — which is
  // why `cwd` must be a real checkout of the repo, with an `origin` remote.
  //
  // `<workDir>` is `node_modules`-shaped: gitignore it, and `rm -rf` it
  // whenever you like — nothing in it is authoritative. Do not clean it while
  // a run is in flight; the single-instance lock lives there.
  //
  // Defaults: workDir = ".sandbar"; cwd = process.cwd() for a programmatic
  // caller, or the directory holding the config file when launched through the
  // `sandbar` bin, which is what makes "you must launch from the repo"
  // unreachable rather than merely fixed.
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

  // The credentials, as a VALUE rather than a path (#38). Sandbar names no
  // file: where a host keeps its secrets is a property of that host's
  // environment, and `.env` at a repo root is already spoken for by compose,
  // Vite, Next and Laravel. `readEnvFile` (exported from the package root) is
  // the one-liner for hosts that do want a file:
  //
  //   env: readEnvFile(new URL("sandbar.env", import.meta.url)),
  //
  // Allowlist semantics, unchanged from the file this replaced: only keys
  // declared HERE cross into a sandbox container, each falling back to
  // `process.env[key]` when the value is empty — so `{ GH_TOKEN: "" }` means
  // "inherit it", and CI needs no file at all. The host's environment never
  // leaks wholesale. Default: {}.
  readonly env?: Record<string, string>;

  readonly maxImplAttempts?: number;
  readonly maxReviewRounds?: number;
  readonly maxTotalIssues?: number;

  // Overrides any subset of the default label vocabulary; unset keys fall back
  // to DEFAULT_LABELS.
  readonly labels?: Partial<LabelConfig>;

  // Extra host paths copied into each issue worktree. Relative entries resolve
  // against `cwd` — the OPERATOR'S checkout, since #38 (the cache is bare and
  // has no files to copy from). State it rather than discover it: the feature
  // exists for host-only files that are not in git, which is arguably the
  // intent, but it makes issue-worktree content a function of the operator's
  // uncommitted state — the class of bug #10 was. A consumer who wants it
  // stable points at absolute paths outside the checkout. Default: [].
  readonly copyToWorktree?: readonly string[];

  // How the merge result lands on the source branch. Default: {kind:"direct"}.
  // Turn on `verified` when anything downstream of the source branch trusts it
  // without re-checking (a deploy on push, a release job).
  readonly mergeMode?: MergeModeConfig;

  // Exit with EXIT_CODE_RELAUNCH (75) after any cycle in which the merger
  // landed merges, instead of continuing on the launch-time build (#65). For a
  // repo whose launcher is a pull → build → run LOOP that continues on exactly
  // that code — the shape a self-hosted repo needs, because there the landed
  // commits ARE the orchestrator, its gate-stack config and its Containerfile,
  // and a run that keeps cycling drives slice N+1 of a queued series with a
  // driver from before slice N. Judge and judged from different eras is the
  // #37 genus of silent false verdict, arriving through the launcher.
  //
  // EXPLICIT config, not detection, and that is a decision: deriving
  // self-hostedness (is `dist/cli.js` inside the operated repo?) false-
  // positives for every consumer running the package from `node_modules`,
  // whose non-looping launcher would then stop after the first landing cycle.
  // A flag the host sets is one line and cannot misfire. Default: false.
  readonly relaunchAfterLanding?: boolean;
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

// `config.env` is the one field #38 turned from a path into a value, so it is
// also the one field that stopped being validated by a parser. `readEnvFile`
// guaranteed a `Record<string, string>`; a config file writing
// `env: "GH_TOKEN=x"` now type-checks nowhere (the config is a program, not a
// schema) and reaches `Object.keys`, which yields "0", "1", "2"… — a dozen
// single-character variables exported into every sandbox while the credential
// check reports GH_TOKEN missing. Rejected at resolve time, before the lock,
// like every other shape mistake in this file.
export function resolveEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (env === undefined) return {};
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new SandbarError(
      "config.env must be an object mapping variable names to values " +
        `(got ${Array.isArray(env) ? "an array" : typeof env}). It is the ` +
        "record itself, not a path to a file — use `readEnvFile(<path>)` to " +
        "build one from a dotenv file.",
    );
  }
  const out: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (typeof value !== "string") {
      throw new SandbarError(
        `config.env['${key}'] must be a string (got ${value === null ? "null" : typeof value}). ` +
          'Use "" to inherit the value from this process\'s environment.',
      );
    }
    // The allowlist is exported into a container as environment variables, so
    // a key that is not a valid variable name cannot be set and would be
    // dropped silently by the runtime rather than by sandbar.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new SandbarError(
        `config.env has the key '${key}', which is not a usable environment ` +
          "variable name (letters, digits and underscore, not starting with a digit).",
      );
    }
    out[key] = value;
  }
  return out;
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

  // There is deliberately no rule here about two containers declaring the same
  // readiness "port" any more (#43). It existed because a `tcp` probe forced
  // the pod to publish one host port per distinct container port, so two
  // containers on 3306 shared one forwarded socket and whichever one bound it
  // marked BOTH ready. Nothing is published now and every probe runs inside its
  // own container, so the rule has nothing left to be about.

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

// The three readiness kinds #43 retired, and what each becomes. Rejected BY
// NAME rather than falling into the generic unknown-kind arm below, because a
// consumer upgrading across this change has a working config in front of them
// and the only useful error is the replacement line — not "unknown kind".
//
// The `log` translation deliberately does not pretend to be mechanical: the
// whole point of retiring it is that the log was never the right question, and
// a pattern lifted verbatim into a `sh -c` would be a different wrong probe.
const RETIRED_READINESS: Readonly<Record<string, string>> = {
  tcp:
    '{ kind: "tcp", port: 3306 } becomes ' +
    '{ kind: "healthcheck", command: ["nc", "-z", "127.0.0.1", "3306"] } — ' +
    "any in-container probe of the port will do. Nothing is published any " +
    "more, and an in-namespace connect needs no settle window because the " +
    "rootless port forwarder is not in the path.",
  log:
    '{ kind: "log", pattern: "port: 3306" } becomes ' +
    '{ kind: "healthcheck", command: ["sh", "-c", "… a real probe …"] }. ' +
    "This one is NOT a mechanical translation: a reused container whose log " +
    "the host journal has vacuumed can never match its boot-time pattern " +
    "again, so write the check the pattern was standing in for — for " +
    "mariadb, `healthcheck.sh --connect --innodb_initialized`, which rejects " +
    "the temporary init server the log pattern was there to see past.",
  exec:
    '{ kind: "exec", argv: [...] } becomes ' +
    "{ kind: \"healthcheck\", command: [...] } — the same argv, the same " +
    "semantics, run through podman's healthcheck machinery instead of a bare " +
    "`podman exec`.",
};

// Rejected at resolve time, before the lock: a readiness mistake otherwise
// surfaces as a container that never comes ready, minutes in, after a full
// readiness budget.
function checkReadiness(containerName: string, readiness: Readiness): void {
  // Read through a widened view. Consumer config is a PROGRAM, not a
  // type-checked call site, so the retired kinds arrive as values the
  // `Readiness` type says cannot exist — which is exactly the case that needs
  // the good message.
  const kind = (readiness as { readonly kind?: unknown }).kind;
  // `Object.hasOwn`, not `kind in`: `in` walks the prototype chain, so a
  // config declaring `kind: "toString"` would match and interpolate a function
  // into the message.
  const retired =
    typeof kind === "string" && Object.hasOwn(RETIRED_READINESS, kind)
      ? RETIRED_READINESS[kind]
      : undefined;
  if (retired !== undefined) {
    throw new SandbarError(
      `config.gateStack: container '${containerName}' declares the retired ` +
        `'${kind as string}' readiness kind (#43). Podman evaluates the probe ` +
        `inside the container now, so there is one kind: ${retired}`,
    );
  }
  if (kind !== "healthcheck") {
    throw new SandbarError(
      `config.gateStack: container '${containerName}' has an unknown ` +
        `readiness kind (${JSON.stringify(kind)}). The only kind is ` +
        '"healthcheck".',
    );
  }
  // Checked like `step.command` and `postReadyCommands`, which it sits beside:
  // an empty argv reaches podman as `--health-cmd '[]'`, which registers a
  // check that can never pass and spends the whole readiness budget.
  if (!Array.isArray(readiness.command) || readiness.command.length === 0) {
    throw new SandbarError(
      `config.gateStack: container '${containerName}' has an empty ` +
        "healthcheck readiness command.",
    );
  }
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
  // The same decidable-emptiness rule, asked of the sandbox copy (#44 D2). A
  // held container runs `sleep infinity` and nothing else, so held with nothing
  // exec'd after readiness is a container that provably serves the agent
  // nothing — and the sandbox slot in the implementer's prompt would then name
  // a neighbour behind which there is no process, which is worse than leaving
  // it off the list. Separate from the `servesWorktree` rule above rather than
  // folded into it because the two describe different consumers: that one is
  // about the gate's steps reaching the code, this one is about the agent
  // reaching a service, and a container can legitimately be one without being
  // the other.
  if (
    c.inSandbox === true &&
    hold &&
    (c.postReadyCommands?.length ?? 0) === 0
  ) {
    throw new SandbarError(
      `config.gateStack: container '${c.name}' sets 'inSandbox' with 'hold' ` +
        "and no 'postReadyCommands'. 'hold' overrides the entrypoint with " +
        "`sleep infinity`, so the sandbox copy would run nothing at all and " +
        "the agent would be told about a service that does not exist. Either " +
        "drop 'inSandbox', or start the service from a 'postReadyCommands' " +
        "entry.",
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
    // A typo'd mode is checked here rather than left to podman, for the same
    // reason every other mount mistake is: podman would reject the `-v` spec
    // at container-create time, which on an `attempt` container is a gate RED
    // blamed on the branch, minutes into a run, over a config string.
    if (m.mode !== undefined && m.mode !== "ro" && m.mode !== "rw") {
      throw new SandbarError(
        `config.gateStack: container '${c.name}' has a mount with an unknown ` +
          `mode ('${String(m.mode)}' for ${m.hostPath} -> ${m.containerPath}). ` +
          'Use "ro" (the default) or "rw".',
      );
    }
  }
  const readiness = c.readiness ?? null;
  if (readiness !== null) checkReadiness(c.name, readiness);
  for (const command of c.postReadyCommands ?? []) {
    // Checked like `step.command` and `readiness.command`, which it sits
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
    mounts: (c.mounts ?? []).map((m) => ({
      hostPath: m.hostPath,
      containerPath: m.containerPath,
      mode: m.mode ?? "ro",
    })),
    mountWorktree: c.mountWorktree ?? null,
    servesWorktree: c.servesWorktree ?? false,
    inSandbox: c.inSandbox ?? false,
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
  // would rebuild from the source worktree and answer the same wrong question
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
          "the source worktree and against each gated worktree in turn, and " +
          "an absolute path would name the same file both times.",
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

// `rebuildOn` on an image nothing runs is inert, and inertness is exactly the
// failure mode #37 is about: the operator has written down what the image is a
// function of, and sandbar would silently never act on it.
//
// The agent sandbox IS a use since #46. #37 excluded it on the grounds that its
// image is "resolved once, when the sandbox is created, and the branch it would
// be a function of does not exist yet" — a true statement about the wrong
// moment, since the issue worktree is prepared before the sandbox is created
// and the branch's files are on disk in time. It is resolved once per sandbox
// rather than once per attempt, and a failed build falls back to the declared
// tag rather than wedging the container the fix would be written in;
// `resolveSandboxImage` in ensure-images.ts carries both halves of that
// argument.
export function checkRebuildOnIsUsed(
  images: readonly BuiltImage[],
  gateStack: ResolvedGateStack,
  sandboxImage: string,
): void {
  const used = new Set(gateStack.containers.map((c) => c.image));
  used.add(sandboxImage);
  for (const img of images) {
    if ((img.rebuildOn ?? []).length === 0) continue;
    if (used.has(img.tag)) continue;
    throw new SandbarError(
      `config.images: entry '${img.tag}' declares \`rebuildOn\`, but nothing ` +
        "runs that image — it is neither `sandboxImage` nor the image of any " +
        "`gateStack.containers` entry — so nothing would ever act on it.",
    );
  }
}

export function defaultCoauthorTrailer(botName: string, botEmail: string): string {
  return `Co-authored-by: ${botName} <${botEmail}>`;
}

// One half of an `owner/name`, trimmed and checked against what GitHub itself
// allows in a name. Rejects rather than repairs: a `ghOwner` carrying a slash
// is a config the operator has to look at, not one to guess the intent of.
function requireRepoPart(field: string, raw: unknown): string {
  if (typeof raw !== "string") {
    throw new SandbarError(`config.${field} is required and must be a string.`);
  }
  const value = raw.trim();
  if (value === "") {
    throw new SandbarError(`config.${field} must not be empty.`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new SandbarError(
      `config.${field} must be a single GitHub name (letters, digits, ".", "_", "-"), ` +
        `got ${JSON.stringify(raw)}. It is one half of the \`--repo <owner>/<name>\` ` +
        "every tracker call passes, so a slash or a space in it addresses a different repository.",
    );
  }
  return value;
}

export function resolveConfig(config: RunConfig): ResolvedConfig {
  // Trimmed HERE, not just where it is compared. `resolveMergeMode` tests
  // `integrationBranch === sourceBranch.trim()`, so trimming only in the guard
  // made the guard describe a value that never existed: `" main "` would pass
  // the must-differ check against `"main"` and then reach every git call with
  // the spaces still on it.
  const sourceBranch = (config.sourceBranch ?? DEFAULT_SOURCE_BRANCH).trim();
  // Validated since #34, and trimmed for the same reason `sourceBranch` is.
  // These two used to reach only `fetchIssueStates`'s GraphQL variables and
  // `forge-verify`'s `--repo`; they now compose the `--repo` on EVERY tracker
  // call and one side of preflight's origin-agreement check. So a value with a
  // stray space produces `--repo "acme /app"` on every call, and a mismatch
  // message that reads identically to a correctly-spelled wrong repo. A slash
  // is the other likely slip — `ghOwner: "acme/app"` builds a three-part
  // `--repo` that gh reads as `HOST/OWNER/REPO` and sends somewhere else
  // entirely.
  const ghOwner = requireRepoPart("ghOwner", config.ghOwner);
  const ghRepo = requireRepoPart("ghRepo", config.ghRepo);
  const gateStack = resolveGateStack(config.gateStack);
  const images = resolveImages(config.images, config.sandboxImage);
  checkRebuildOnIsUsed(images, gateStack, config.sandboxImage);
  // Resolved to absolute HERE, not left as the host wrote it (#34). Since every
  // git call now runs with `cwd` as its process cwd, a RELATIVE `cwd` is
  // double-rooted the moment a path derived from it is passed as an argument:
  // `worktreePathFor("sub/repo", …)` yields `sub/repo/.sandbar/…`, which the
  // child then resolves against `<launch>/sub/repo`. Reproduced against real
  // git: `worktree add` cheerfully creates
  // `sub/repo/sub/repo/.sandbar/worktrees/merger` and lists it as such.
  // Preflight's own `worktree remove` happens to survive the same doubling —
  // git falls back to a suffix match against the worktree list — which is
  // exactly why this is fixed at the source rather than per call site:
  // `merger-worktree.ts`'s `worktree add` has no such fallback, and podman
  // rejects a relative `-v` source outright ("names must match …"), so
  // `merger.ts`'s `-v ${cwd}:/workspace` would fail every resolve-loop attempt.
  // The assertion below is only that the string comes out absolute; the git and
  // podman behaviour it protects against is theirs to define, not ours to fake.
  //
  // NOT `realpathSync`: this only has to make the string absolute and
  // self-consistent. run.ts still canonicalises separately for the podman scope,
  // because THAT has to partition the host identically to proper-lockfile, which
  // resolves symlinks — two different jobs.
  const cwd = resolve(config.cwd ?? DEFAULT_CWD());
  return {
    ...config,
    ghOwner,
    ghRepo,
    cwd,
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
    // No resolution to do since #38: this is the record itself, not a path
    // that had to be rooted somewhere (`resolve(cwd, …)`, #34). The empty
    // default is a real configuration — a host that supplies every credential
    // through the process environment still has to DECLARE the keys, because
    // the fallback is per declared key and never a wholesale leak.
    env: resolveEnv(config.env),
    maxImplAttempts: config.maxImplAttempts ?? DEFAULT_MAX_IMPL_ATTEMPTS,
    maxReviewRounds: config.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS,
    maxTotalIssues: config.maxTotalIssues ?? DEFAULT_MAX_TOTAL_ISSUES,
    copyToWorktree: config.copyToWorktree ?? [],
    labels: { ...DEFAULT_LABELS, ...config.labels },
    gateStack,
    mergeMode: resolveMergeMode(config.mergeMode, sourceBranch),
    relaunchAfterLanding: config.relaunchAfterLanding ?? false,
  };
}
