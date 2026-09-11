// The outdoor daemon's installation-owned config (#149). It mirrors the
// RunConfig outdoor commits at its own root (Tojins/outdoor#235 has not yet
// removed that copy) with the installation contract on top: an explicit
// `cwd`, the gate stack read from the clone, and the Claude Code settings
// file supplied from this directory instead of a host hook.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnvFile, splitRoleRouting } from "sandbar";

const cwd = "/home/outdoor/outdoor";
const sandboxImage = "localhost/sandbar:outdoor";

// gate/stack.json is already written in sandbar's gateStack schema, so this is
// a read rather than a translation: scripts/gate.sh, CI and sandbar cannot end
// up checking different things. The keys sandbar has no concept of --
// "anchor", "half", "comment" -- are ignored by its validator.
const stack = JSON.parse(readFileSync(join(cwd, "gate/stack.json"), "utf8"));

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
  ghRepo: "outdoor",

  // Whose `ready-for-agent` counts (Tojins/sandbar#136). Every collaborator
  // on this private repo may queue an issue.
  developers: "anyone",

  // 0.41.14 is the first tagged release with #147's mapped copyToWorktree
  // entries, which `copyToWorktree` below uses.
  requiresSandbar: "0.41.14",
  botName: "sandbar",
  botEmail: "sandbar@sda.be",
  uiPort: 7331,

  // Sized for the Hetzner box (Tojins/outdoor#229): two issues in flight, one
  // gate stack at a time, so the two gate pods never overlap in memory.
  maxParallelIssues: 2,
  maxConcurrentGates: 1,

  sandboxImage,
  gateStack: { containers: stack.containers, steps: stack.steps },

  // The gate images from stack.json, plus the agent's own. The sandbox image
  // is built FROM the php and runner gate images, and the list builds in
  // order, so those tags exist by the time it needs them. Its rebuildOn
  // re-resolves it once per sandbox, so an issue that moves a lockfile gets an
  // agent whose baked /deps match its branch.
  images: [
    ...stack.images,
    {
      tag: sandboxImage,
      containerfile: "Containerfile.sandbar",
      rebuildOn: ["package.json", "package-lock.json", "bower.json", ".bowerrc"],
    },
  ],

  // Claude Code auto-loads CLAUDE.md from the checkout it runs in, so a
  // sandbox agent would otherwise read outdoor's host-machine and prod
  // context. The copied settings file excludes it; claudeMdPath moves the
  // prompt's "Conventions:" anchor onto AGENTS.md. This replaces outdoor's
  // scripts/sandbar-worktree-setup.sh host hook, which wrote the same file.
  claudeMdPath: "AGENTS.md",
  copyToWorktree: [
    {
      from: new URL("files/settings.local.json", import.meta.url),
      to: ".claude/settings.local.json",
    },
  ],

  // Runs in the agent container, after the inSandbox siblings are up and
  // healthy: the worktree deps link, the database prepare and the frontend
  // build+serve (Tojins/outdoor#185, #187). The bound is for a cold composer
  // install plus the build; the default 60s is too tight for it.
  sandboxHooks: {
    sandbox: {
      onSandboxReady: [
        { command: "scripts/sandbox-prepare.sh", timeoutMs: 300_000 },
      ],
    },
  },

  // Project rules on top of sandbar's built-in coding standards, for the
  // roles that write and judge code; resolved inside the worktree.
  promptExtensions: {
    implementer: { path: "CODING_STANDARDS.md" },
    reviewer: { path: "CODING_STANDARDS.md" },
    reviewerQuality: { path: "CODING_STANDARDS.md" },
  },

  // deploy.yml trusts main blindly and tests.yml ignores it, so a direct push
  // would deploy a sha no CI run ever saw. "gate" is the job name in
  // .github/workflows/tests.yml.
  mergeMode: { kind: "verified", requiredChecks: ["gate"] },

  // Merging main deploys to prod, so nothing lands unreviewed unless the issue
  // opts in with the `auto-land` label. The repo carries the `auto-land`,
  // `needs-review` and `land` labels this needs; sandbar creates none of them.
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
