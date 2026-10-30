// Sandbar's own gate runs the structural checks (#183, #235, #236): the
// installation config, imported as the daemon imports it, has the steps, their
// `settles`, the read-only `.git` they read through `--git-dir`, and the
// coverage the `missing-tests` check reads.
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PODMAN_COVERAGE, UNIT_COVERAGE } from "../scripts/structure/coverage.mjs";
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
  });

  it("runs the missing-tests check last, settling missing-tests", () => {
    expect(stack.steps.at(-1)).toMatchObject({
      name: "tests-structure",
      command: [
        "node", "scripts/structure/run.mjs", "missing-tests",
        "--base", "origin/main", "--git-dir", "/workspace-git", "--podman-coverage",
      ],
      timeoutMs: 1_500_000,
      settles: ["missing-tests"],
    });
    expect([...settledRules(stack)]).toEqual(["commit-ritual", "missing-tests"]);
  });

  it.each([
    ["test", ["npm", "test", "--", "--exclude", "**/*-podman.test.ts"], UNIT_COVERAGE],
    ["podman-test", ["npm", "test", "--", "podman.test.ts"], PODMAN_COVERAGE],
  ])("the %s step runs its suite writing the %s the missing-tests check reads", (name, suite, file) => {
    const command = stack.steps.find((step) => step.name === name)?.command ?? [];
    expect(command.slice(0, suite.length)).toEqual(suite);
    expect(command.slice(-2)).toEqual(["--coverage.enabled", `--coverage.reportsDirectory=${dirname(file)}`]);
  });

  it("mounts the clone's .git read-only where the structural steps read it", () => {
    for (const name of ["version", "tests-structure"]) {
      const step = stack.steps.find((candidate) => candidate.name === name);
      const runner = stack.containers.find((container) => container.name === step?.in);
      expect(runner?.mountWorktree).toBe("/workspace");
      expect(runner?.mounts).toContainEqual(
        { hostPath: ".git", containerPath: "/workspace-git", mode: "ro" },
      );
    }
  });
});
