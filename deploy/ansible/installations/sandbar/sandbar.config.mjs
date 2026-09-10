// Sandbar is hosted by the same external-installation contract as a consumer
// (#149); the checkout supplies source and its neutral development recipe.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnvFile, splitRoleRouting } from "sandbar";

const cwd = "/home/sandbar/sandbar";
const image = "localhost/sandbar-agent:latest";
const podmanSocket = `/run/user/${process.getuid()}/podman/podman.sock`;
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
  requiresSandbar: "0.40.0",
  botName: "sandbar",
  botEmail: "demanthomas+sandbar@gmail.com",
  contextMdPath: "AGENTS.md",
  promptExtensions: {
    merger: {
      text: "When a merge conflicts on `version`, the merged value is one patch bump above the higher of the two sides — never either side's own — and `package-lock.json` carries the same value.",
    },
  },
  uiPort: 7334,
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
        name: "test",
        in: "runner",
        command: ["npm", "test", "--", "--exclude", "**/*-podman.test.ts"],
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
        ],
        timeoutMs: 1_800_000,
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
