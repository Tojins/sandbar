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

  // Independent consecutive-failure budgets. Quality counts rejections,
  // NO-SIGNAL, dirty trees and off-branch HEADs, then resets when a quality
  // approval leads to a completed review verdict. Gate counts red gate-1 and
  // resets on green. Review counts correctness rejections only. Harness
  // failures spend none; their second occurrence in one inner loop parks it.
  // maxQualityRounds: 4,
  // maxGateRounds: 4,
  // maxReviewRounds: 4,
  // DONE work releases one of these concurrent inner-loop slots immediately.
  // maxParallelIssues: 3,
  // Gate-1 and gate-2 share this run-wide limit. Unset means unlimited.
  // maxConcurrentGates: 1,
  // Refresh origin and the tracker after this many idle milliseconds.
  // pollIntervalMs: 60000,
  // Keep the host awake even while no work is available.
  // keepAwakeWhileIdle: false,

  // Override only the tracker labels whose names differ in this repository.
  // labels: { needsInfo: "needs-info", agentStuck: "agent-stuck" },
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

  // `auto` lets the gate decide. `review` lands connected review-gated issues
  // on a draft chunk pull request. An issue's `auto-land` label overrides the
  // default, unless review-gating reaches it through `## Blocked by`; inherited
  // review-gating wins. Land a chunk by adding the non-configurable `land`
  // label to its draft PR; that label must already exist because sandbar never
  // creates it. A landed chunk member stays open until then: while the chunk is
  // live, do not close a member or retitle its root, because those issues
  // determine the chunk's membership and derived branch name.
  // defaultLane: "auto",

  // Keep host defaults above. The fifteen SANDBAR_* entries documented in
  // sandbar.env.example are this installation's per-role deviations.
  ...routing,
};
