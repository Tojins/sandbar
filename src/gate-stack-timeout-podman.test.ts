// Gate-stack shard: step timeouts and their reaps (#26), the killed-client
// fact that forces the reap, and `podman healthcheck run` itself (#43 — the
// family header's fact 4). The family header — why these run against a real
// podman and why the suite is sharded — is gate-stack-podman.test-util.ts's.

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveGateStack } from "./config.js";
import {
  containerState,
  parseHealthLog,
  type Stack,
  startStack,
} from "./gate-stack.js";
import {
  IMAGE,
  initStackRepo,
  runExit,
} from "./gate-stack-podman.test-util.js";
import { stackContainerNameFor } from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import {
  podmanTestScope,
  removeFixtureContainer,
  runFixtureContainer,
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
const STACK_ID = "podmantest";
const cName = (name: string): string =>
  stackContainerNameFor(SCOPE, STACK_ID, name);

// One file-level sweep; nothing reaps this scope on SIGKILL — the recovery
// command is in `podman-test-scope.test-util.ts`.
afterAll(async () => {
  if (available) await cleanup();
}, 120_000);

describe.runIf(available)("step timeouts and their reaps (#26)", () => {
  let repo: string;
  let stack: Stack | null = null;

  beforeEach(async () => {
    repo = await initStackRepo();
  }, 60_000);

  afterEach(async () => {
    if (stack) await stack.stop();
    stack = null;
    await rm(repo, { recursive: true, force: true });
  }, 60_000);

  // #26. Before this, a step that hung hung the issue, the outer loop and the
  // single-instance lock forever, and the operator's only signal was a run
  // that had printed nothing for hours. A red gate at least spends an attempt
  // and moves.
  it(
    "a step that exceeds its timeout is a red gate naming the step and the bound",
    async () => {
      stack = await startStack({
        stackId: STACK_ID,
        scope: SCOPE,
        worktreePath: repo,
        spec: resolveGateStack({
          containers: [
            { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
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
            { name: "never", in: "runner", command: ["sh", "-c", "echo RAN-ANYWAY"] },
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
  it(
    "the timed-out work is reaped: an issue container is recreated, only the step's container touched",
    async () => {
      stack = await startStack({
        stackId: STACK_ID,
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
              mounts: [{ hostPath: "marker.txt", containerPath: "/fixture/marker.txt" }],
              hold: true,
            },
            { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
          ],
          steps: [
            // Satisfies the #29 reachability rule; also proves the timeout
            // stops the run rather than the run never getting that far.
            { name: "sees-code", in: "runner", command: ["cat", "marker.txt"] },
            { name: "hangs-in-held", in: "held", command: ["sleep", "601"], timeoutMs: 2_000 },
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
      const { stdout } = await exec(RUNTIME, ["exec", cName("held"), "ps", "-eo", "args"]);
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
  it(
    "a timeout in an attempt container removes it, so the runaway cannot outlive the attempt",
    async () => {
      stack = await startStack({
        stackId: STACK_ID,
        scope: SCOPE,
        worktreePath: repo,
        spec: resolveGateStack({
          containers: [
            { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
          ],
          steps: [
            { name: "hangs", in: "runner", command: ["sleep", "607"], timeoutMs: 2_000 },
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

// Killing the client reaps NOTHING (#26): the process keeps running inside the
// container, which is why a timed-out step has to remove the container rather
// than just report. Discovered by running it, not read out of a man page.
//
// The other half of that argument — that `podman exec` EXITS 0 when the client
// is killed with SIGTERM, so node's `timeout:` option reports a hang as
// SUCCESS — is a property of the LOCAL client and lives in
// gate-stack-hostpodman.test.ts (#48). What is left here holds either way.
describe.runIf(available)("podman exec under a killed client", () => {
  const NAME = cName("killprobe");

  beforeEach(async () => {
    await removeFixtureContainer(NAME).catch(() => {});
    await runFixtureContainer(["--name", NAME, IMAGE, "sleep", "infinity"]);
  }, 60_000);

  afterEach(async () => {
    await removeFixtureContainer(NAME).catch(() => {});
  }, 60_000);

  // The kill buys nothing, which is why a timeout has to reap the container
  // rather than just report.
  it.each(["SIGTERM", "SIGKILL"] as const)(
    "the in-container process survives the client dying of %s",
    async (signal) => {
      const marker = `sleep 60${signal === "SIGTERM" ? 2 : 3}`;
      const child = spawn(RUNTIME, ["exec", NAME, ...marker.split(" ")]);
      const closed = new Promise((r) => child.on("close", r));
      await new Promise((r) => setTimeout(r, 800));
      child.kill(signal);
      await closed;
      await new Promise((r) => setTimeout(r, 500));

      const { stdout } = await exec(RUNTIME, ["exec", NAME, "ps", "-eo", "args"]);
      expect(stdout).toContain(marker);

      // Removing the container IS total, which is what `reapTimedOutStep` uses.
      await removeFixtureContainer(NAME);
      await expect(
        exec(RUNTIME, ["exec", NAME, "ps", "-eo", "args"]),
      ).rejects.toThrow();
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// `podman healthcheck run` itself (#43)
// ---------------------------------------------------------------------------
// Everything that made #43 the right shape is a fact about podman rather than
// about sandbar, so it is asserted by running podman. These drive the client
// directly, the way the SIGTERM tests do: `containerRunArgs` proves sandbar
// emits the flags it means to and cannot prove what podman does with them.
//
// The systemd half — that `--health-cmd` plus `--health-interval=disable`
// creates NO transient timer, which is the whole argument for polling
// ourselves — is not here. It has to read the HOST's user session, and the gate
// runner drives podman through a socket from a container that has none, so it
// lives in gate-stack-hostpodman.test.ts with the other local-client facts.
describe.runIf(available)("podman healthcheck run", () => {
  const NAME = cName("hcprobe");

  // Register a probe the same way `containerRunArgs` does — JSON argv,
  // scheduling disabled — and nothing else.
  const runWithProbe = async (
    command: readonly string[],
    extra: readonly string[] = [],
  ): Promise<void> => {
    await removeFixtureContainer(NAME).catch(() => {});
    await runFixtureContainer([
      "--name", NAME,
      "--health-cmd", JSON.stringify(command),
      "--health-interval=disable",
      ...extra,
      IMAGE, "sleep", "infinity",
    ]);
  };

  const healthLog = async (): Promise<ReturnType<typeof parseHealthLog>> => {
    const { stdout } = await exec(RUNTIME, [
      "inspect", "--format", "{{json .State.Health}}", NAME,
    ]);
    return parseHealthLog(stdout);
  };

  afterEach(async () => {
    await removeFixtureContainer(NAME).catch(() => {});
  }, 60_000);

  // The mapping the poll loop reads, and the only part of it sandbar acts on.
  it(
    "exits 0 for a healthy probe and 1 for an unhealthy one",
    async () => {
      await runWithProbe(["true"]);
      expect((await runExit(["healthcheck", "run", NAME])).code).toBe(0);

      await runWithProbe(["false"]);
      expect((await runExit(["healthcheck", "run", NAME])).code).toBe(1);
    },
    120_000,
  );

  // M6. A stopped container cannot be probed, and podman says so with 125 —
  // the same code it uses for "no such container". The poll loop does not try
  // to read death out of that: `throwIfDead` asks the question podman has a
  // purpose-built answer for, and must classify this one as `stopped` (there is
  // still a log to read) rather than `gone` or `unknown`.
  it(
    "exits 125 on a stopped container, which containerState calls `stopped`",
    async () => {
      await runWithProbe(["true"]);
      await exec(RUNTIME, ["stop", "-t", "0", NAME]);
      const r = await runExit(["healthcheck", "run", NAME]);
      expect(r.code).toBe(125);
      expect(await containerState(NAME)).toBe("stopped");
    },
    120_000,
  );

  // Every invocation appends, and podman keeps the last five — which is why the
  // readiness timeout reads the log ONCE at the deadline instead of on every
  // poll, and why the error's window is five and not a number sandbar chose.
  it(
    "appends one entry per invocation, keeping the probe's own output",
    async () => {
      await runWithProbe(["sh", "-c", "echo PROBE-SPOKE >&2; exit 1"]);
      await runExit(["healthcheck", "run", NAME]);
      await runExit(["healthcheck", "run", NAME]);

      const entries = await healthLog();
      expect(entries.length).toBe(2);
      // The output is the whole reason the health log is read at all: the
      // CLIENT prints the single word `unhealthy` and nothing else.
      expect(entries.at(-1)?.output).toContain("PROBE-SPOKE");
    },
    120_000,
  );

  // Stated in the module header because it misleads silently: the number in the
  // health log is NOT the number the probe returned. Asserted directly rather
  // than trusted, since a reader debugging their own probe would otherwise
  // discover it the hard way.
  it(
    "normalises a probe that exits 3 to ExitCode 1",
    async () => {
      await runWithProbe(["sh", "-c", "exit 3"]);
      const r = await runExit(["healthcheck", "run", NAME]);
      expect(r.code).toBe(1);
      expect((await healthLog()).at(-1)?.exitCode).toBe(1);
    },
    120_000,
  );

  // M4, and the reason `--health-timeout` is neither passed nor exposed in
  // config. It does not KILL the probe: it lets it run to completion and then
  // labels the result as having exceeded the bound. A number in a config that
  // looks like a per-probe bound and only retro-labels is #26's green-on-red
  // wearing podman's colours.
  it(
    "`--health-timeout` does not kill the probe — it labels it afterwards",
    async () => {
      await runWithProbe(["sleep", "20"], ["--health-timeout=2s"]);
      const started = Date.now();
      await runExit(["healthcheck", "run", NAME]);
      const elapsed = Date.now() - started;
      // A bound that killed would have returned at ~2s. It returns at ~20.
      expect(elapsed).toBeGreaterThan(15_000);
    },
    120_000,
  );

  // The CONTROL half, and it carries the weight: the test above passes just as
  // happily with `--health-timeout` added back to `healthCheckArgs`, because
  // asserting that podman does not enforce says nothing about who does. This is
  // the assertion that fails if sandbar's own deadline ever stops being the
  // bound — the container's `readinessTimeoutMs`, enforced by `boundedPodman`
  // through the production bringup path.
  it(
    "sandbar's readinessTimeoutMs IS the bound on a probe that never returns",
    async () => {
      const repo = await mkdtemp(join(tmpdir(), "sandbar-hcbound-"));
      try {
        await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
        const started = Date.now();
        await expect(
          startStack({
            stackId: STACK_ID,
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
