// Sandbar's own gate runs the structural checks (#183, #235): the installation
// config, imported as the daemon imports it, has the steps, their `settles`,
// and the read-only `.git` they read through `--git-dir`.
import { describe, expect, it, vi } from "vitest";

import { resolveGateStack, settledRules } from "./config.js";

// The config reads the box's env file through these; nothing here needs it.
vi.mock("sandbar", () => ({
  readEnvFile: () => ({}),
  splitRoleRouting: () => ({ routing: {}, env: {} }),
}));

const { default: config } = await import(
  "../deploy/ansible/installations/sandbar/sandbar.config.mjs"
);
const stack = resolveGateStack(config.gateStack);

describe("sandbar's gate runs the structural checks", () => {
  it("runs the version check after check, settling commit-ritual", () => {
    expect(stack.steps.map((step) => step.name).slice(0, 2)).toEqual(["check", "version"]);
    const version = stack.steps.find((step) => step.name === "version");
    expect(version).toMatchObject({
      command: [
        "node", "scripts/structure/run.mjs", "version",
        "--base", "origin/main", "--git-dir", "/workspace-git",
      ],
      settles: ["commit-ritual"],
    });
    expect([...settledRules(stack)]).toEqual(["commit-ritual"]);
  });

  it("mounts the clone's .git read-only where the version step reads it", () => {
    const version = stack.steps.find((step) => step.name === "version");
    const runner = stack.containers.find((container) => container.name === version?.in);
    expect(runner?.mountWorktree).toBe("/workspace");
    expect(runner?.mounts).toContainEqual(
      { hostPath: ".git", containerPath: "/workspace-git", mode: "ro" },
    );
  });
});
