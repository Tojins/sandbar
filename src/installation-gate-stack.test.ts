// Sandbar's own gate declaration (#269, #259 spec 8): which suite step runs
// each test file, and that every non-test source file is core's or some
// domain's. The config reads the box's credentials through `sandbar`, so the
// test stands in for those two calls.
import { readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { globMatcher } from "./gate-selection.js";

vi.mock("sandbar", () => ({
  readEnvFile: () => ({}),
  splitRoleRouting: (env: Record<string, string>) => ({ routing: {}, env }),
}));

interface Declaration {
  steps: { name: string; tests?: string[] }[];
  core: { paths: string[] };
  domains: { name: string; paths: string[] }[];
}

const { default: config } = await import("../deploy/ansible/installations/sandbar/sandbar.config.mjs") as {
  default: { gateStack: Declaration };
};
const stack = config.gateStack;
const srcFiles = readdirSync(new URL(".", import.meta.url)).map((name) => `src/${name}`);

function stepMatcher(name: string): (path: string) => boolean {
  const tests = stack.steps.find((step) => step.name === name)?.tests;
  if (tests === undefined) throw new Error(`no ${name} step with tests`);
  return globMatcher(tests);
}

describe("sandbar's gate declaration", () => {
  it("runs each test file in one suite step, and the host-only podman tests in neither", () => {
    const unit = stepMatcher("test");
    const podman = stepMatcher("podman-test");
    const hostOnly = ["gate-stack-hostpodman", "sandbox-stack-podman", "container-resources-podman"]
      .map((name) => `src/${name}.test.ts`);
    const steps = (path: string): string[] =>
      [unit(path) ? "test" : undefined, podman(path) ? "podman-test" : undefined]
        .filter((step) => step !== undefined);

    for (const path of srcFiles.filter((file) => file.endsWith(".test.ts"))) {
      const expected = hostOnly.includes(path) ? []
        : path.endsWith("-podman.test.ts") ? ["podman-test"]
        : ["test"];
      expect({ path, steps: steps(path) }).toEqual({ path, steps: expected });
    }
  });

  it("puts every non-test source file in core or some domain", () => {
    const owners = [stack.core.paths, ...stack.domains.map((domain) => domain.paths)].map(globMatcher);
    const orphans = srcFiles
      .filter((file) => file.endsWith(".ts") && !/\.test(-util)?\.ts$/.test(file))
      .filter((file) => !owners.some((owns) => owns(file)));
    expect(orphans).toEqual([]);
  });
});
