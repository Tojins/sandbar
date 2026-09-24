// The outdoorpub daemon's installation-owned config: outdoor's public booking
// site, a frontend-only AngularJS/gulp checkout with no backend, database or
// CI of its own. The gate is therefore the checkout's own build script, run
// in the one image that also hosts the agent, and the merge mode is direct
// because there is no check run that could get the last word.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnvFile, splitRoleRouting } from "sandbar";

const cwd = "/home/outdoorpub/outdoorpub";
const sandboxImage = "localhost/sandbar:outdoorpub";

// sandbar.env carries credentials and this installation's role routing as
// SANDBAR_* keys (Tojins/sandbar#137); the routing never reaches a sandbox.
const { routing, env: credentials } = splitRoleRouting(
  readEnvFile(new URL("sandbar.env", import.meta.url)),
);
const usesCodex = Object.entries(routing).some(
  ([field, provider]) => field.endsWith("Agent") && provider === "codex",
);

export default {
  cwd,
  ghOwner: "Tojins",
  ghRepo: "outdoorpub",

  // Whose `ready-for-agent` counts (Tojins/sandbar#136). Every collaborator
  // on this private repo may queue an issue.
  developers: "anyone",

  requiresSandbar: "0.44.12",
  botName: "sandbar",
  botEmail: "sandbar@sda.be",
  uiPort: 7335,

  // The box also hosts outdoor (three slots) and sandbar (two slots); one slot
  // here keeps a busy day at six agent sandboxes on a four-core machine, and
  // this queue is the smallest of the three.
  maxParallelIssues: 1,
  maxConcurrentGates: 1,

  // One image, both roles: the agent sandbox and the gate's runner. It bakes
  // the npm and bower trees under /deps on the Node 22 the checkout pins
  // (see its Containerfile), and its rebuildOn re-resolves it per sandbox so
  // an issue that moves a lockfile gets an agent whose baked /deps match its
  // branch.
  sandboxImage,
  images: [
    {
      tag: sandboxImage,
      containerfile: "Containerfile",
      rebuildOn: ["package.json", "package-lock.json", "bower.json", ".bowerrc"],
    },
  ],

  // The gate is the production build plus lint, exactly what
  // scripts/gate.sh runs on a laptop. The runner has no service of its own;
  // it exists to be exec'd into.
  gateStack: {
    containers: [
      { name: "runner", image: sandboxImage, mountWorktree: "/workspace", hold: true },
    ],
    steps: [
      { name: "gate", in: "runner", command: ["bash", "scripts/gate.sh"], timeoutMs: 600_000 },
    ],
  },

  // Links the worktree's node_modules and bower_components at the baked
  // trees, so the agent's own `gulp` and `eslint` resolve the same install
  // the gate checks against.
  sandboxHooks: {
    sandbox: {
      onSandboxReady: [{ command: "scripts/sandbox-prepare.sh", timeoutMs: 60_000 }],
    },
  },

  // The checkout has no CLAUDE.md; AGENTS.md is its one anchor doc.
  claudeMdPath: "AGENTS.md",

  // The public site has no CI workflow, so nothing could verify a landing:
  // the gate is the whole verdict.
  mergeMode: { kind: "direct" },

  // Merging main is what the operator deploys from, so nothing lands
  // unreviewed unless the issue opts in with the `auto-land` label. The repo
  // carries the `auto-land`, `needs-review` and `land` labels this needs;
  // sandbar creates none of them.
  defaultLane: "review",

  // The codex credential is the ChatGPT subscription `codex login` writes
  // under this installation's own user; it is read only when a role is routed
  // to codex. Only this one of codex's two credentials is declared: with
  // `OPENAI_API_KEY` also visible the CLI prefers the metered key.
  env: {
    ...credentials,
    ...(usesCodex
      ? { CODEX_AUTH_JSON: readFileSync(join(homedir(), ".codex/auth.json"), "utf8") }
      : {}),
  },
  ...routing,
};
