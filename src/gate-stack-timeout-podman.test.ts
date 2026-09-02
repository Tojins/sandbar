// Gate-stack slice: step timeouts and their reaps (#26), plus sandbar's own
// bound on a healthcheck probe (#43). The family header — why these run against
// a real podman and why tests run concurrently — is the test util's.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, it } from "vitest";

import { resolveGateStack } from "./config.js";
import { type Stack, startStack } from "./gate-stack.js";
import { gateStackFixture, IMAGE } from "./gate-stack-podman.test-util.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import {
  podmanTestScope,
  podmanTestStackId,
} from "./podman-test-scope.test-util.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

// See podman-test-availability.test-util.ts for the collection-time rule and
// what `SANDBAR_REQUIRE_PODMAN_TESTS=1` changes.
const available = podmanTestsEnabled({
  what: "gate-stack timeout podman tests",
  image: IMAGE,
});

// Per PROCESS, not per file (#47) — see gate-stack-podman.test.ts.
const { scope: SCOPE, cleanup } = podmanTestScope("gate-stack-timeout");

// One file-level sweep; nothing reaps this scope on SIGKILL — the recovery
// command is in `podman-test-scope.test-util.ts`.
afterAll(async () => {
  if (available) await cleanup();
}, 120_000);

describe.runIf(available)("step timeouts and their reaps (#26)", () => {
  // #26. Before this, a step that hung hung the issue, the outer loop and the
  // single-instance lock forever, and the operator's only signal was a run
  // that had printed nothing for hours. A red gate at least spends an attempt
  // and moves.
  it.concurrent(
    "a step that exceeds its timeout is a red gate naming the step and the bound",
    async ({ expect, task, onTestFinished }) => {
      let stack: Stack | null = null;
      const { repo, stackId, cName } = await gateStackFixture(
        SCOPE,
        task.id,
        onTestFinished,
        () => stack,
      );

      stack = await startStack({
        stackId: stackId,
        scope: SCOPE,
        worktreePath: repo,
        spec: resolveGateStack({
          containers: [
            {
              name: "runner",
              image: IMAGE,
              mountWorktree: "/work",
              hold: true,
            },
          ],
          steps: [
            {
              name: "hangs",
              in: "runner",
              // Prints, then never returns: a suite whose reporter never
              // exits, which is the shape that actually happens.
              command: ["sh", "-c", "echo about-to-hang; sleep 600"],
              timeoutMs: 3_000,
            },
            {
              name: "never",
              in: "runner",
              command: ["sh", "-c", "echo RAN-ANYWAY"],
            },
          ],
        }),
      });

      const started = Date.now();
      const red = await stack.runGate();
      // The bound is real, not just reported: the call returned near it.
      expect(Date.now() - started).toBeLessThan(60_000);
      expect(red.ok).toBe(false);
      expect(red.failedStep).toBe("hangs");
      // A killed process has no exit code, and `1` would be indistinguishable
      // from a suite that ran and failed.
      expect(red.exitCode).toBe(124);
      expect(red.stdout).toContain("was still running after 3000ms");
      // Stops at the first red like any other failure.
      expect(`${red.stdout}${red.stderr}`).not.toContain("RAN-ANYWAY");
      // D9, and it matters most here: a hang's own output is usually empty,
      // so the container logs are the whole diagnosis. They are collected
      // BEFORE the reap below removes the container.
      expect(red.containerLogs).toContain("--- container runner (last");
    },
    180_000,
  );

  // The note #26 makes about killing the step: the `podman exec` CLIENT dying
  // does nothing to the process in the container (pinned below), so without
  // a reap the timed-out work keeps running — burning CPU beside the next
  // attempt and skewing whatever the next gate run measures.
  it.concurrent(
    "the timed-out work is reaped: an issue container is recreated, only the step's container touched",
    async ({ expect, task, onTestFinished }) => {
      let stack: Stack | null = null;
      const { repo, stackId, cName } = await gateStackFixture(
        SCOPE,
        task.id,
        onTestFinished,
        () => stack,
      );

      stack = await startStack({
        stackId: stackId,
        scope: SCOPE,
        worktreePath: repo,
        spec: resolveGateStack({
          containers: [
            // `issue` + `hold` is the one shape that may legally be stepped
            // into and survive attempts, so it is where a runaway would
            // otherwise live for the whole issue.
            {
              name: "held",
              image: IMAGE,
              lifecycle: "issue",
              mounts: [
                {
                  hostPath: "marker.txt",
                  containerPath: "/fixture/marker.txt",
                },
              ],
              hold: true,
            },
            {
              name: "runner",
              image: IMAGE,
              mountWorktree: "/work",
              hold: true,
            },
          ],
          steps: [
            // Satisfies the #29 reachability rule; also proves the timeout
            // stops the run rather than the run never getting that far.
            { name: "sees-code", in: "runner", command: ["cat", "marker.txt"] },
            {
              name: "hangs-in-held",
              in: "held",
              command: ["sleep", "601"],
              timeoutMs: 2_000,
            },
          ],
        }),
      });

      const idOf = async (name: string): Promise<string | null> =>
        await exec(RUNTIME, ["inspect", "--format", "{{.Id}}", cName(name)])
          .then((r) => r.stdout.trim())
          .catch(() => null);
      const heldBefore = await idOf("held");
      expect(heldBefore).not.toBeNull();

      expect((await stack.runGate()).failedStep).toBe("hangs-in-held");

      // Recreated, not merely restarted and not left with the runaway in it:
      // a new id is what proves the reap happened, and `assertIssueContainersAlive`
      // would otherwise find it missing on the next gate run and report an
      // infrastructure failure this reap had caused.
      const heldAfter = await idOf("held");
      expect(heldAfter).not.toBeNull();
      expect(heldAfter).not.toBe(heldBefore);
      const { stdout } = await exec(RUNTIME, [
        "exec",
        cName("held"),
        "ps",
        "-eo",
        "args",
      ]);
      expect(stdout).not.toContain("sleep 601");
      // Only the step's own container is touched: the reap is not a stack
      // teardown, so the bystander is still there. (Its id is NOT compared —
      // every gate run recreates attempt containers anyway, so a change
      // proves nothing either way.)
      expect(await idOf("runner")).not.toBeNull();

      // …and the stack still works, which is the point of recreating rather
      // than leaving a hole where the container was.
      const after = await stack.runGate();
      expect(after.failedStep).toBe("hangs-in-held");
    },
    240_000,
  );
  // The other half of the reap, and the common one: a hung suite lives in the
  // `attempt` container. Nothing asserted this — the test above times out in
  // the `issue` container — so the removal was unverified by any test.
  it.concurrent(
    "a timeout in an attempt container removes it, so the runaway cannot outlive the attempt",
    async ({ expect, task, onTestFinished }) => {
      let stack: Stack | null = null;
      const { repo, stackId, cName } = await gateStackFixture(
        SCOPE,
        task.id,
        onTestFinished,
        () => stack,
      );

      stack = await startStack({
        stackId: stackId,
        scope: SCOPE,
        worktreePath: repo,
        spec: resolveGateStack({
          containers: [
            {
              name: "runner",
              image: IMAGE,
              mountWorktree: "/work",
              hold: true,
            },
          ],
          steps: [
            {
              name: "hangs",
              in: "runner",
              command: ["sleep", "607"],
              timeoutMs: 2_000,
            },
          ],
        }),
      });

      expect((await stack.runGate()).failedStep).toBe("hangs");

      // Gone, taking `sleep 607` with it. Left alive, that process would burn
      // CPU beside the next attempt's agent run and every gate it triggers.
      await expect(
        exec(RUNTIME, ["inspect", "--format", "{{.Id}}", cName("runner")]),
      ).rejects.toThrow();

      // …and the stack still gates: the next run recreates it, which is why
      // an `attempt` container needs no recreate here.
      expect((await stack.runGate()).failedStep).toBe("hangs");
    },
    240_000,
  );
});

// Sandbar owns this bound; the deleted siblings pinned podman quirks.
describe.runIf(available)("sandbar healthcheck timeout", () => {
  // The CONTROL half, and it carries the weight: the test above passes just as
  // happily with `--health-timeout` added back to `healthCheckArgs`, because
  // asserting that podman does not enforce says nothing about who does. This is
  // the assertion that fails if sandbar's own deadline ever stops being the
  // bound — the container's `readinessTimeoutMs`, enforced by `boundedPodman`
  // through the production bringup path.
  it.concurrent(
    "sandbar's readinessTimeoutMs IS the bound on a probe that never returns",
    async ({ expect, task, onTestFinished }) => {
      const stackId = podmanTestStackId("podmantest", task.id);
      const repo = await mkdtemp(join(tmpdir(), "sandbar-hcbound-"));
      try {
        await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
        const started = Date.now();
        await expect(
          startStack({
            stackId: stackId,
            scope: SCOPE,
            worktreePath: repo,
            spec: resolveGateStack({
              containers: [
                {
                  name: "runner",
                  image: IMAGE,
                  mountWorktree: "/work",
                  hold: true,
                  // `issue`, so the probe runs during `startStack` rather than
                  // inside a `runGate` this test never reaches. Legal on a
                  // worktree-mounting container only because it is held —
                  // `sleep infinity` runs none of the branch's code.
                  lifecycle: "issue",
                  // Never returns. Podman would let it run forever.
                  readiness: { kind: "healthcheck", command: ["sleep", "600"] },
                  readinessTimeoutMs: 5_000,
                },
              ],
              steps: [{ name: "ok", in: "runner", command: ["true"] }],
            }),
          }),
          // And it SAYS the probe was killed. A probe sandbar kills records
          // nothing in the health log — the client dies before podman writes an
          // entry — so this is the one fact only the client knows, and without
          // it the operator reads "did not become ready" over a health block
          // that describes some earlier, faster failure or nothing at all.
        ).rejects.toThrow(/did not become ready[\s\S]*was killed/);
        // Generous, because bringup also pulls/creates the pod — the claim is
        // that the wait ENDS, not that it ends to the millisecond. Without
        // sandbar's own kill it would not end at all.
        expect(Date.now() - started).toBeLessThan(120_000);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
