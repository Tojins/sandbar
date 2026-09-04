// Copy this file to `sandbar.config.mjs`, then replace the ALL_CAPS
// placeholders and the gate command for your repository.
//
// Required fields are active. Every optional RunConfig field is commented out
// at its default, so uncommenting one before changing it is a no-op.

const SANDBOX_IMAGE = "localhost/YOUR_PROJECT:sandbar";

export default {
  // Required: the GitHub repository sandbar reads and writes. Preflight checks
  // these against this checkout's `origin` before doing any work.
  ghOwner: "YOUR_GITHUB_OWNER",
  ghRepo: "YOUR_GITHUB_REPO",

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
  // Issue branches seed from, and successful work lands on, this branch.
  // sourceBranch: "main",

  // The default builds only the sandbox image from ./Containerfile. Declare
  // more entries when the gate stack uses additional locally-built images.
  // images: [{ tag: SANDBOX_IMAGE, containerfile: "Containerfile" }],

  // Model names are interpreted by the corresponding role's provider. The two
  // reviewer fields are the final correctness pass and first quality pass.
  // The UI check inherits the implementer's model unless set separately.
  // implementerModelId: "opus",
  // uiCheckModelId: undefined,
  // reviewerModelId: "opus",
  // reviewerQualityModelId: "opus",
  // mergerModelId: "opus",

  // The roles default to claude. The UI check inherits implementerAgent;
  // leaving the quality reviewer unset makes it inherit reviewerAgent.
  // implementerAgent: "claude",
  // uiCheckAgent: undefined,
  // reviewerAgent: "claude",
  // reviewerQualityAgent: undefined,
  // mergerAgent: "claude",

  // Unset passes no effort flag, leaving the choice to the provider/CLI.
  // implementerEffort: undefined,
  // uiCheckEffort: undefined,
  // reviewerEffort: undefined,
  // reviewerQualityEffort: undefined,
  // mergerEffort: undefined,

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

  // Only keys declared here enter agent containers. An empty value inherits
  // that key from the process environment; undeclared host variables stay out.
  // env: {},

  // Independent consecutive-failure budgets. Quality counts rejections, red
  // gates, NO-SIGNAL, dirty trees and off-branch HEADs, then resets when a
  // quality approval leads to a completed review verdict. Harness failures
  // leave both counters unchanged. Review counts correctness rejections only.
  // maxQualityRounds: 4,
  // maxReviewRounds: 4,
  // Stop admitting new issues after this many have started in one process.
  // maxTotalIssues: 50,
  // DONE work releases one of these concurrent inner-loop slots immediately.
  // maxParallelIssues: 3,

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
};
