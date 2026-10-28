// Copy this file to `sandbar.config.mjs` and copy `sandbar.env.example` to
// `sandbar.env` beside it, then replace the ALL_CAPS placeholders and the gate
// command for your repository. The env file is required because this config
// reads it when the module loads; keep it gitignored even if every value comes
// from the launching process.
//
// Required fields are active. Optional host fields are commented out at their
// defaults; per-installation role fields live in sandbar.env instead.

import { readEnvFile, splitRoleRouting } from "sandbar";

const SANDBOX_IMAGE = "localhost/YOUR_PROJECT:sandbar";
const { routing, env } = splitRoleRouting(
  readEnvFile(new URL("sandbar.env", import.meta.url)),
);

export default {
  // Required: the GitHub repository sandbar reads and writes. Preflight checks
  // these against this checkout's `origin` before doing any work.
  ghOwner: "YOUR_GITHUB_OWNER",
  ghRepo: "YOUR_GITHUB_REPO",

  // Required: only these forge logins (plus the login behind this run's token)
  // may apply the most recent `ready-for-agent` label. Bots and GitHub Apps may
  // be listed by their recorded login. Use `"anyone"` to admit every labelled
  // issue, matching sandbar's behavior before 0.37.0.
  developers: ["YOUR_GITHUB_LOGIN"],

  // Required: the image used by the implementer and merge-resolution agents.
  sandboxImage: SANDBOX_IMAGE,

  // Required: commit identity for sandbar's merge commits.
  botName: "YOUR_BOT_NAME",
  botEmail: "YOUR_BOT_EMAIL",

  // Required: host and sandbox setup. Add hooks here when the repository needs
  // dependency installation or other preparation before an attempt.
  sandboxHooks: {},

  // Required: the containers and ordered steps that decide whether a commit
  // is good. This one-container stack is the smallest valid shape.
  gateStack: {
    containers: [
      {
        name: "runner",
        image: SANDBOX_IMAGE,
        mountWorktree: "/workspace",
        hold: true,
      },
    ],
    steps: [
      {
        name: "test",
        in: "runner",
        command: [
          "sh",
          "-c",
          "echo 'Replace gateStack.steps with your test command.' >&2; exit 1",
        ],
      },
    ],
  },

  // Undefined makes the CLI use this file's directory; `run(config)` uses
  // process.cwd().
  // cwd: undefined,
  // Sandbar owns this disposable state directory inside cwd.
  // workDir: ".sandbar",
  // The run UI binds this fixed port; use a distinct port for each workdir on
  // the same host.
  // uiPort: 7331,
  // Issue branches seed from, and successful work lands on, this branch.
  // sourceBranch: "main",

  // The default builds only the sandbox image from ./Containerfile. Declare
  // more entries when the gate stack uses additional locally-built images.
  // images: [{ tag: SANDBOX_IMAGE, containerfile: "Containerfile" }],

  // Run one cold UI/prototype classification after sandbox setup and before
  // attempt 1. Disable this in hosts that cannot ship user-visible UI.
  // uiPrototypeCheck: true,

  // Asks for a split only when the whole issue plausibly exceeds maxContextChars.
  // Disable only when issues are partitioned before entering this queue.
  // partitionCheck: true,

  // Condense issue threads longer than this (after sandbar's own traces are
  // dropped): superseded comments become one-line stubs, cached until the
  // thread changes. null turns it off.
  // condenseAboveChars: 20000,

  // Once per admission, beside attempt 1, a cold read-only agent writes hidden
  // Given/When/Then scenarios into the issue's log directory. Nothing waits
  // for it until the verifier, and its failure changes nothing.
  // scenarioWriter: true,

  // Useful-context budget: rendered prompt plus the seed-anchored net diff a
  // role is told to inspect on demand. Oversize work parks for partitioning.
  // maxContextChars: 600000,

  // Undefined derives `Co-authored-by: ...` from botName and botEmail.
  // coauthorTrailer: undefined,

  // Anchor docs are resolved from each role's worktree; the context file and
  // ADR directory are referenced only when they exist.
  // claudeMdPath: "CLAUDE.md",
  // contextMdPath: "CONTEXT.md",
  // adrDir: "docs/adr",

  // Per-role additions are `{ text: "..." }` or `{ path: "RULES.md" }`.
  // promptExtensions: {},

  // Only non-routing keys declared in sandbar.env enter agent containers. An
  // empty value inherits that key from the process environment; undeclared
  // host variables stay out.
  env,

  // Independent budgets. Quality bounds one quality pass — verify rejections
  // and upheld quality adjudications — and running out goes on to gate-1 with
  // the open items recorded. Gate counts red gate-1 plus NO-SIGNAL, dirty
  // trees and off-branch HEADs, and resets on green. Review counts
  // correctness rejections only. Harness failures spend none; their second
  // occurrence in one inner loop parks it.
  // maxQualityRounds: 3,
  // maxGateRounds: 4,
  // maxReviewRounds: 4,
  // DONE work releases one of these concurrent inner-loop slots immediately.
  // maxParallelIssues: 3,
  // Gate-1 and gate-2 share this run-wide limit. Unset means unlimited.
  // maxConcurrentGates: 1,
  // Refresh origin and the tracker after this many idle milliseconds.
  // pollIntervalMs: 60000,
  // Keep admitting this long after a deploy asks for a restart, so several
  // landings share one drain. An idle pool or an urgent request restarts now.
  // restartDeferMs: 7200000,
  // Keep the host awake even while no work is available.
  // keepAwakeWhileIdle: false,

  // Rename the handoff label every park applies, if it differs in this repository.
  // labels: { handoff: "needs-human" },
  // Copy host-only paths into each issue worktree before setup runs.
  // copyToWorktree: [],

  // Set this to the oldest driver version that understands every field you
  // use. Leaving it unset performs no minimum-version check.
  // requiresSandbar: undefined,

  // Direct mode gates locally and pushes the result. Use verified mode when a
  // forge CI verdict must also pass before the source branch moves.
  // mergeMode: { kind: "direct" },
  // Verified mode requires a non-empty list of check-run names exactly as the
  // forge reports them.
  // mergeMode: { kind: "verified", requiredChecks: ["tests"] },

  // Watch the deploy workflow a push to the source branch runs. A red run that
  // deployed a sandbar merge files one `ready-for-human` bug issue mentioning
  // `notifyLogin`, who must not be the token's own login. The `deploy-red`
  // label (or `label`) and `ready-for-human` must already exist.
  // deployWatch: { workflow: "deploy.yml", notifyLogin: "your-login" },

  // Allow sandboxes, gates and resolve containers to reach only GitHub, the
  // model APIs of the providers in use and these hosts; every refused host is
  // recorded as an `egress-refused` event. Entries: a preset ("npm",
  // "packagist"), "host", "*.suffix", "host:port", or
  // { host, ports, private: true } for a name that resolves to a private
  // address. Start in "report" mode to discover the list from the run record.
  // egress: { mode: "report", allow: ["npm", "packagist"] },

  // Import a nightly prod dump into a base datadir for agents' database copies.
  // `sandbar db-base`, run from a timer beside the daemon, imports each new
  // dump with the gate stack's `container` (an inSandbox server with a
  // readiness probe) and swaps `<root>/current` to it; the run complains when
  // the dump is stale or an import failed.
  // databaseCopies: {
  //   dump: "/srv/sandbar-db/drops/you/app-latest.sql.gz",
  //   root: "/srv/sandbar-db/installations/you",
  //   container: "db",
  //   database: "app",
  // },

  // `auto` lets the gate decide. `review` lands connected review-gated issues
  // on a draft chunk pull request. An issue's `auto-land` label overrides the
  // default, unless review-gating reaches it through `## Blocked by`; inherited
  // review-gating wins. Land a chunk by adding the non-configurable `land`
  // label to its draft PR; that label must already exist because sandbar never
  // creates it. A landed chunk member stays open until then. A chunk is every
  // review-gated issue connected through `## Blocked by` in either direction;
  // publish a series without pauses longer than a poll, because a new chunk
  // starts only once two consecutive polls see the same graph.
  // defaultLane: "auto",

  // Keep host defaults above. The eighteen SANDBAR_* entries documented in
  // sandbar.env.example are this installation's per-role deviations.
  ...routing,
};
