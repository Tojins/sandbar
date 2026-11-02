// Sandbar is hosted by the same external-installation contract as a consumer
// (#149); the checkout supplies source and its neutral development recipe.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnvFile, splitRoleRouting } from "sandbar";

const cwd = "/home/sandbar/sandbar";
const image = "localhost/sandbar-agent:latest";
const podmanSocket = `/run/user/${process.getuid()}/podman/podman.sock`;
const gitDir = "/workspace-git";
const { routing, env: credentials } = splitRoleRouting(
  readEnvFile(new URL("sandbar.env", import.meta.url)),
);
const usesCodex = Object.entries(routing).some(
  ([field, provider]) => field.endsWith("Agent") && provider === "codex",
);

// The gate's test selection (#259 spec 8, #269): every non-test file of
// `src/` is core's or some domain's. What a sanity test may cost is
// AGENTS.md's rule (spec 7).
const src = (...names) => names.map((name) => `src/${name}.ts`);
const tests = (...names) => names.map((name) => `src/${name}.test.ts`);
const coreModules = [
  "errors", "config", "naming", "timing", "events", "repo-ref", "runtime",
  "container-resources", "token-scan",
];
const domains = [
  {
    name: "planning",
    description: "which issues run, in which lanes and chunks",
    paths: src("plan-resolver", "lanes", "chunks", "chunk-follow-up", "chunk-reconcile", "label-sync", "forge-rate-limit"),
    sanity: tests("plan-resolver", "plan-resolver-git", "chunks", "chunk-reconcile-git"),
  },
  {
    name: "inner-loop",
    description: "one issue's sandbox run: its roles, prompts and agents",
    paths: [
      ...src("inner-loop*", "prompt", "prompts", "issue-anchor", "standards-groups", "*-parser",
        "agent-run-end", "agent-providers", "env", "env-file", "codex-auth", "git-ops"),
      "!src/scenario-*", "!src/adjudication-parser.ts",
      "prompts/**",
      "!prompts/scenario-*", "!prompts/adjudicator*", "!prompts/reviewer*", "!prompts/resolve-*",
      "!prompts/landing-pass*", "!prompts/implementer-sandbox-egress.md", "!prompts/janitor-task.md",
      "!prompts/*db-copy*", "!prompts/reflect-*",
    ],
    sanity: tests("inner-loop-machine", "inner-loop", "prompt"),
  },
  {
    name: "verifier",
    description: "the verifier's review, scenarios and adjudication",
    paths: [
      ...src("verifier*", "reviewer-run", "scenario-*", "adjudication-parser"),
      "prompts/scenario-*", "prompts/adjudicator*", "prompts/reviewer*",
    ],
    sanity: tests("verifier", "verifier-run", "scenario-writer-run", "scenario-parser"),
  },
  {
    name: "landing",
    description: "merging onto the source branch, resolving, finalising",
    paths: [
      ...src("merger*", "resolve-loop", "version-conflict", "forge-*", "chunk-land", "chunk-pr",
        "landing-*", "finalize*", "push-result", "origin-lock"),
      "prompts/resolve-*", "prompts/landing-pass*", "sandbar-resolve-hook.mjs",
    ],
    sanity: tests("merger", "chunk-land", "gh-argv", "finalize-git"),
  },
  {
    name: "gate",
    description: "the gate stack, its steps and their test selection",
    paths: [...src("gate*", "sandbox-stack", "stack-source", "stack-change", "standalone-steps"), "Containerfile"],
    sanity: tests("gate-run", "stack-source-git", "stack-change", "standalone-steps-run"),
  },
  {
    name: "sandbox",
    description: "issue clones, containers and images",
    paths: src("agent-sandbox", "containers", "image-*", "ensure-images", "agent-tools", "repo-cache", "preflight"),
    sanity: tests("agent-sandbox-snapshot", "repo-cache-git", "preflight", "containers"),
  },
  {
    name: "config-cli",
    description: "the bin, the library entry and identity",
    paths: [
      ...src("config-digest", "cli", "index", "version", "requires-sandbar", "driver-identity", "canonical-json"),
      "sandbar.config.example.mjs", "package.json",
    ],
    sanity: tests("config", "cli", "cli-resolve-hook"),
  },
  {
    name: "egress",
    description: "the egress allowlist and its proxy",
    paths: [...src("egress*"), "prompts/implementer-sandbox-egress.md"],
    sanity: tests("egress-policy", "egress-proxy-server", "run-egress"),
  },
  {
    name: "daemon",
    description: "the pool, its exits, locks, janitor and deploy",
    paths: [
      ...src("run", "scheduler", "exit-conditions", "restart-request", "disk-space", "cleanup", "lock",
        "keepawake", "deploy-watch", "logs", "janitor*"),
      "prompts/janitor-task.md", "deploy/**",
    ],
    sanity: tests("run-terminal", "run-quota", "scheduler", "janitor-plan", "deploy-unit"),
  },
  {
    name: "events-ui-stats",
    description: "the run's projection, the UI and the scorecard",
    paths: [...src("run-state", "ui-server", "agent-usage", "stats*"), "src/__fixtures__/stats/**", "ui/**"],
    sanity: tests("run-state", "ui-server", "stats", "stats-cli"),
  },
  {
    name: "db-copies",
    description: "the database base import and per-issue copies",
    paths: [...src("db-base", "db-copy", "db-copy-policy"), "prompts/*db-copy*", "prompts/reviewer-db-notice.md"],
    sanity: tests("db-copy-policy", "db-copy", "db-base-fs", "cli-db-base"),
  },
  {
    name: "tooling",
    description: "reflect, replay and the repo's scripts",
    paths: [...src("reflect*", "replay*"), "src/__fixtures__/reflect/**", "scripts/**", "prompts/reflect-*"],
    sanity: tests("reflect-git", "reflect-cli", "reflect-mine", "replay"),
  },
];

export default {
  cwd,
  ghOwner: "Tojins",
  ghRepo: "sandbar",
  developers: ["Tojins"],
  requiresSandbar: "0.71.2",
  botName: "sandbar",
  botEmail: "demanthomas+sandbar@gmail.com",
  contextMdPath: "AGENTS.md",
  promptExtensions: {
    merger: {
      text: "When a merge conflicts on `version`, the merged value is one patch bump above the higher of the two sides — never either side's own — and `package-lock.json` carries the same value.",
    },
  },
  uiPort: 7334,

  // The box hosts outdoor (three slots) and outdoorpub (one) beside this
  // installation (group_vars/all.yml); three here puts up to seven agent
  // sandboxes on one machine when every queue is busy.
  maxParallelIssues: 3,
  sandboxImage: image,
  sandboxHooks: {
    host: {
      onWorktreeReady: [{ command: "npm ci --no-audit", timeoutMs: 600_000 }],
    },
  },
  gateStack: {
    containers: [
      {
        name: "runner",
        image,
        mountWorktree: "/workspace",
        hold: true,
        mounts: [
          { hostPath: podmanSocket, containerPath: "/run/podman.sock" },
          { hostPath: "/tmp", containerPath: "/tmp", mode: "rw" },
          // The gate's tmpfs over the clone's `.git` (#98) holds at most
          // podman's copy of it from container start; the structural checks
          // read the live one here, read-only, through `--git-dir`.
          { hostPath: ".git", containerPath: gitDir },
        ],
        env: {
          CONTAINER_HOST: "unix:///run/podman.sock",
          SANDBAR_REQUIRE_PODMAN_TESTS: "1",
        },
      },
    ],
    steps: [
      // `tsc` type-checks as it emits, and both suites below read `dist/`
      // (the CLI tests run it), so they run vitest without `npm test`'s
      // rebuild and side by side: the unit suite is CPU-bound, the podman
      // suite mostly waits on podman.
      { name: "build", in: "runner", command: ["npm", "run", "build"] },
      // A suite the selection skips writes no coverage, and `tests-structure`
      // reads its absent file as that (scripts/structure/coverage.mjs), so no
      // earlier gate's file may still be there.
      { name: "clean-coverage", in: "runner", command: ["rm", "-rf", "coverage"] },
      {
        name: "version",
        in: "runner",
        command: [
          "node", "scripts/structure/run.mjs", "version",
          "--base", "origin/main", "--git-dir", gitDir,
        ],
        settles: ["commit-ritual"],
      },
      {
        name: "test",
        in: "runner",
        tests: ["src/**/*.test.ts", "!src/**/*podman.test.ts"],
        command: [
          "npx", "vitest", "run",
          "--coverage.enabled", "--coverage.reportsDirectory=coverage/unit", "{tests}",
        ],
        timeoutMs: 900_000,
      },
      {
        name: "podman-test",
        in: "runner",
        parallel: true,
        tests: [
          "src/**/*podman.test.ts",
          "!src/gate-stack-hostpodman.test.ts",
          "!src/sandbox-stack-podman.test.ts",
          "!src/container-resources-podman.test.ts",
        ],
        command: [
          "npx", "vitest", "run", "--maxWorkers", "8",
          "--coverage.enabled", "--coverage.reportsDirectory=coverage/podman", "{tests}",
        ],
        timeoutMs: 1_800_000,
      },
      {
        name: "tests-structure",
        in: "runner",
        command: [
          "node", "scripts/structure/run.mjs", "missing-tests",
          "--base", "origin/main", "--git-dir", gitDir, "--podman-coverage",
        ],
        timeoutMs: 120_000,
        settles: ["missing-tests"],
      },
    ],
    sanity: tests(
      "config", "cli", "inner-loop-machine", "run-terminal", "cli-resolve-hook", "issue-create-site",
      "replay-boundary", "error-swallow-ratchet", "test-clock", "prompts",
    ),
    core: { paths: src(...coreModules), sanity: tests(...coreModules) },
    domains,
    related: { in: "runner", command: ["node", "scripts/related-tests.mjs", "{changed}"] },
  },
  images: [
    { tag: image, containerfile: "Containerfile", rebuildOn: ["Containerfile"] },
  ],
  env: {
    ...credentials,
    ...(usesCodex
      ? { CODEX_AUTH_JSON: readFileSync(join(homedir(), ".codex/auth.json"), "utf8") }
      : {}),
  },
  ...routing,
};
