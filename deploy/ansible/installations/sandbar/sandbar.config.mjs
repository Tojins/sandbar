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

export default {
  cwd,
  ghOwner: "Tojins",
  ghRepo: "sandbar",
  developers: ["Tojins"],
  requiresSandbar: "0.60.12",
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
      { name: "check", in: "runner", command: ["npm", "run", "check"] },
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
        command: [
          "npm", "test", "--", "--exclude", "**/*-podman.test.ts",
          "--coverage.enabled", "--coverage.reportsDirectory=coverage/unit",
        ],
        timeoutMs: 900_000,
      },
      {
        name: "podman-test",
        in: "runner",
        command: [
          "npm", "test", "--", "podman.test.ts",
          "--exclude", "src/gate-stack-hostpodman.test.ts",
          "--exclude", "src/sandbox-stack-podman.test.ts",
          "--exclude", "src/container-resources-podman.test.ts",
          "--maxWorkers", "8",
          "--coverage.enabled", "--coverage.reportsDirectory=coverage/podman",
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
        timeoutMs: 1_500_000,
        settles: ["missing-tests"],
      },
    ],
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
