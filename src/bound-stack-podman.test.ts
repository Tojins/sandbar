// `BoundStack` against real podman (#186): a running gate stack stays bound to
// the spec it was started for. Whether a changed spec reaches the containers
// is a fact about what podman ends up running, so it is asserted on container
// ids and their environment rather than on `ensure`'s return value.

import { afterAll, describe, it } from "vitest";

import { resolveGateStack } from "./config.js";
import type { Stack } from "./gate-stack.js";
import { gateStackFixture, IMAGE } from "./gate-stack-podman.test-util.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import { podmanTestScope } from "./podman-test-scope.test-util.js";
import { bindStack } from "./stack-source.js";

const available = podmanTestsEnabled({
  what: "bound gate stack podman tests",
  image: IMAGE,
});

const { scope: SCOPE, cleanup } = podmanTestScope("bound-stack");

afterAll(async () => {
  if (available) await cleanup();
}, 120_000);

// Held containers: nothing to wait for at bringup, and the `issue` one is the
// container whose reuse the token decides.
const specWith = (version: string) =>
  resolveGateStack({
    containers: [
      { name: "db", image: IMAGE, lifecycle: "issue", hold: true, env: { STACK_VERSION: version } },
      { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
    ],
    steps: [{ name: "check", in: "runner", command: ["true"] }],
  });

describe.runIf(available)("bindStack against real podman", () => {
  it.concurrent(
    "keeps the issue container for the same spec and recreates it for a changed env",
    async ({ expect, task, onTestFinished }) => {
      const { repo, stackId, idOf, inspectOf, hold } = await gateStackFixture(
        SCOPE,
        task.id,
        onTestFinished,
      );
      const bound = await bindStack(
        { stackId, scope: SCOPE, worktreePath: repo, hideWorktreeGit: false },
        specWith("1"),
      );
      // Registered through the fixture, so the stack stops before the
      // worktree it mounts is removed.
      hold({ stop: () => bound.stop() } as Stack);

      expect((await (await bound.ensure(specWith("1"))).runGate()).ok).toBe(true);
      const dbBefore = await idOf("db");

      // The same spec, rebuilt from scratch: equal by token, so nothing moves.
      await bound.ensure(specWith("1"));
      expect(await idOf("db")).toBe(dbBefore);

      const restarted = await bound.ensure(specWith("2"));
      expect(await idOf("db")).not.toBe(dbBefore);
      // Read from the container's config, not a `podman exec printenv`: over
      // the gate's remote socket an exec of a short-lived process can come
      // back exit 0 with its stdout lost, which reds this test on nothing.
      const env = await inspectOf("db", "{{range .Config.Env}}{{println .}}{{end}}");
      expect(env.split("\n")).toContain("STACK_VERSION=2");
      expect((await restarted.runGate()).ok).toBe(true);
    },
    300_000,
  );
});
