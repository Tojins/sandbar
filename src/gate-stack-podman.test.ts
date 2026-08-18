import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveGateStack } from "./config.js";
import {
  type LogWatcher,
  logFollowArgs,
  scanChunk,
  type Stack,
  startStack,
  watchLog,
} from "./gate-stack.js";
import {
  networkNameFor,
  podNameFor,
  runScope,
  stackContainerNameFor,
} from "./naming.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

// Behaviour PODMAN defines, asserted by running podman — the same argument as
// forge-verify-git.test.ts makes for git. The pure argv builders in
// gate-stack.test.ts prove sandbar emits the flags it means to; they cannot
// prove those flags produce a stack that works, and the two facts this file
// pins were both discovered empirically rather than read out of a man page:
//
//   1. a bare TCP connect to a pod's published port SUCCEEDS with nothing
//      listening inside — the rootless port forwarder accepts first and asks
//      the backend after — so a connect-only readiness probe is a green-on-red;
//   2. a container running as root inside a pod writes files owned by the
//      INVOKING user, which is the only reason dropping `--userns=keep-id`
//      (impossible alongside `--pod`) is survivable.
//
// Any local image with a shell will do. mariadb is chosen because it also
// serves a real TCP listener for the positive half of (1), and because
// `id -u` in it is 0.
const IMAGE = "docker.io/library/mariadb:10.11";

// Resolved at COLLECTION time, not in beforeAll: vitest evaluates `runIf` while
// building the suite, so a flag set in a hook arrives too late and silently
// skips everything — a test file that always passes by never running.
const available = ((): boolean => {
  if (process.env["SANDBAR_SKIP_PODMAN_TESTS"] === "1") return false;
  try {
    execFileSync(RUNTIME, ["image", "exists", IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    console.warn(
      `skipping gate-stack podman tests: ${RUNTIME} or ${IMAGE} unavailable ` +
        `(\`${RUNTIME} pull ${IMAGE}\` to enable them)`,
    );
    return false;
  }
})();

const STACK_ID = "podmantest";
// Any stable string: the scope only has to be disjoint from a real run's.
const SCOPE = runScope("/gate-stack-podman.test");
const cName = (name: string): string =>
  stackContainerNameFor(SCOPE, STACK_ID, name);

describe.runIf(available)(
  "gate stack against real podman",
  () => {
    let repo: string;
    let stack: Stack | null = null;

    const git = (...args: string[]) => exec("git", args, { cwd: repo });

    beforeEach(async () => {
      repo = await mkdtemp(join(tmpdir(), "sandbar-stack-"));
      await git("init", "-q", "-b", "main");
      await git("config", "user.email", "t@t");
      await git("config", "user.name", "t");
      await writeFile(join(repo, ".gitignore"), "out/\n");
      await writeFile(join(repo, "marker.txt"), "v1\n");
      await git("add", "-A");
      await git("commit", "-qm", "init");
    }, 60_000);

    afterEach(async () => {
      if (stack) await stack.stop();
      stack = null;
      await rm(repo, { recursive: true, force: true });
    }, 60_000);

    afterAll(async () => {
      // Belt and braces: a test that threw before assigning `stack` would leak
      // the pod, and the pod's infra container is invisible to a name sweep.
      await exec(RUNTIME, ["pod", "rm", "-f", podNameFor(SCOPE, STACK_ID)]).catch(
        () => {},
      );
      await exec(RUNTIME, ["network", "rm", networkNameFor(SCOPE, STACK_ID)]).catch(
        () => {},
      );
    }, 60_000);

    it(
      "runs steps in a held container that sees the worktree, and reports the failing step",
      async () => {
        stack = await startStack({
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
              },
            ],
            steps: [
              { name: "read-marker", in: "runner", command: ["cat", "marker.txt"] },
              { name: "env", in: "runner", command: ["sh", "-c", "test \"$CI\" = true"] },
            ],
          }),
        });

        const green = await stack.runGate();
        expect(green.ok).toBe(true);
        expect(green.failedStep).toBeNull();
        // The step ran against the committed tree, and `-w` put it there.
        expect(green.stdout).toContain("v1");
        // Steps are labelled in the output so a multi-step trace is readable.
        expect(green.stdout).toContain("== read-marker (runner)");
      },
      180_000,
    );

    it(
      "a red step stops the run, names itself, and carries the container logs",
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
              { name: "boom", in: "runner", command: ["sh", "-c", "echo nope >&2; exit 3"] },
              // Must NOT run: later steps read what earlier ones build, so
              // running them buries the real failure under derived ones.
              { name: "never", in: "runner", command: ["sh", "-c", "echo RAN-ANYWAY"] },
            ],
          }),
        });

        const red = await stack.runGate();
        expect(red.ok).toBe(false);
        expect(red.failedStep).toBe("boom");
        expect(red.exitCode).toBe(3);
        expect(red.stderr).toContain("nope");
        expect(`${red.stdout}${red.stderr}`).not.toContain("RAN-ANYWAY");
        // #24 D9: every container's log tail rides along, because the answer to
        // "why did the browser step 500" is in a container the step never ran in.
        // In its OWN field, so the cascade collapse never reads a service log as
        // test output.
        expect(red.containerLogs).toContain("--- container runner (last");
        expect(red.stderr).not.toContain("--- container runner");
      },
      180_000,
    );

    it(
      "refuses to gate a dirty worktree instead of reporting a verdict about it",
      async () => {
        stack = await startStack({
          stackId: STACK_ID,
          scope: SCOPE,
          worktreePath: repo,
          spec: resolveGateStack({
            containers: [
              { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
            ],
            steps: [{ name: "ok", in: "runner", command: ["true"] }],
          }),
        });
        expect((await stack.runGate()).ok).toBe(true);

        await writeFile(join(repo, "forgotten.ts"), "export const x = 1;\n");
        const refused = await stack.runGate();
        expect(refused.ok).toBe(false);
        expect(refused.failedStep).toBe("worktree-clean");
        expect(refused.stderr).toContain("forgotten.ts");
        // The forgotten file is REPORTED, never deleted — the whole reason the
        // design asserts rather than running `git clean -fd`.
        await expect(
          exec("cat", [join(repo, "forgotten.ts")]),
        ).resolves.toBeTruthy();

        // Ignored artifacts do not block the gate, which is what lets build
        // output survive between attempts.
        await rm(join(repo, "forgotten.ts"));
        await exec("mkdir", ["-p", join(repo, "out")]);
        await writeFile(join(repo, "out/build.js"), "x\n");
        expect((await stack.runGate()).ok).toBe(true);
      },
      180_000,
    );

    it(
      "a container running as root in the pod writes worktree files owned by the host user",
      async () => {
        // The load-bearing consequence of dropping --userns=keep-id (which
        // podman refuses alongside --pod). If this ever regresses, every file a
        // gate step writes lands owned by a subuid the operator cannot delete.
        stack = await startStack({
          stackId: STACK_ID,
          scope: SCOPE,
          worktreePath: repo,
          spec: resolveGateStack({
            containers: [
              { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
            ],
            steps: [
              { name: "write", in: "runner", command: ["sh", "-c", "mkdir -p out && touch out/made"] },
            ],
          }),
        });
        expect((await stack.runGate()).ok).toBe(true);

        const { stdout } = await exec("stat", ["-c", "%u", join(repo, "out/made")]);
        expect(Number(stdout.trim())).toBe(process.getuid?.() ?? 0);
      },
      180_000,
    );

    // The green-on-red this design would have shipped with a naive probe.
    it(
      "tcp readiness does NOT go green on a published port with nothing listening",
      async () => {
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
                  lifecycle: "issue",
                  mountWorktree: "/work",
                  hold: true,
                  // Published on the pod, so `connect` SUCCEEDS at the host —
                  // and nothing in the pod is listening on it.
                  readiness: { kind: "tcp", port: 9999 },
                  readinessTimeoutMs: 4_000,
                },
              ],
              steps: [{ name: "ok", in: "runner", command: ["true"] }],
            }),
          }),
          // Pinned to the container AND the probe: "did not become ready" alone
          // would also be satisfied by some other container failing bringup for
          // some other reason, which is not what this test is about.
        ).rejects.toThrow(/'runner'[\s\S]*did not become ready[\s\S]*tcp port 9999/);
      },
      180_000,
    );

    it(
      "tcp readiness goes green on a real listener, and issue containers survive gate runs",
      async () => {
        stack = await startStack({
          stackId: STACK_ID,
          scope: SCOPE,
          worktreePath: repo,
          spec: resolveGateStack({
            containers: [
              {
                name: "db",
                image: IMAGE,
                lifecycle: "issue",
                env: { MYSQL_ALLOW_EMPTY_PASSWORD: "yes", MYSQL_DATABASE: "app" },
                readiness: { kind: "tcp", port: 3306 },
                readinessTimeoutMs: 120_000,
              },
              { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
            ],
            // The whole point of one namespace: the consumer writes 127.0.0.1
            // as a literal, because with a pod it is an address it can know at
            // config time. No pinned IP, no reserved DB_HOST key.
            steps: [
              {
                name: "query",
                in: "runner",
                command: ["mariadb", "-h", "127.0.0.1", "-uroot", "-e", "SELECT 1"],
              },
            ],
          }),
        });

        expect((await stack.runGate()).ok).toBe(true);

        // `ok` twice proves nothing about the lifecycle split: a re-created
        // mariadb answers SELECT 1 just as well, and a REUSED attempt container
        // still execs fine. Both regressions — the 15s-per-attempt bringup, and
        // gating an earlier attempt's source — pass an ok-only assertion. So
        // observe identity and state directly.
        const idOf = async (name: string): Promise<string> =>
          (
            await exec(RUNTIME, [
              "inspect",
              "--format",
              "{{.Id}}",
              cName(name),
            ])
          ).stdout.trim();

        const dbIdBefore = await idOf("db");
        const runnerIdBefore = await idOf("runner");

        // State written into the issue container must survive to the next gate
        // run. A recreated database would answer the SELECT with an error.
        await exec(RUNTIME, [
          "exec",
          cName("runner"),
          "mariadb",
          "-h",
          "127.0.0.1",
          "-uroot",
          "app",
          "-e",
          "CREATE TABLE persisted (id INT)",
        ]);

        expect((await stack.runGate()).ok).toBe(true);

        expect(await idOf("db")).toBe(dbIdBefore);
        // …and the attempt container is a DIFFERENT container, or it would be
        // gating whatever source it started with.
        expect(await idOf("runner")).not.toBe(runnerIdBefore);

        const { stdout } = await exec(RUNTIME, [
          "exec",
          cName("runner"),
          "mariadb",
          "-h",
          "127.0.0.1",
          "-uroot",
          "app",
          "-e",
          "SHOW TABLES",
        ]);
        expect(stdout).toContain("persisted");
      },
      240_000,
    );

    // #24 D5, the half with no coverage at all: an `attempt` container runs the
    // branch's code, so failing to bring it up is a verdict about the BRANCH,
    // not infrastructure. Getting this backwards sends an agent-broken service
    // bootstrap through two fresh-stack retries that reproduce it exactly, then
    // lands NEEDS-HUMAN with an "environment" trace.
    it(
      "an attempt container that will not come up is a gate red, not a throw",
      async () => {
        stack = await startStack({
          stackId: STACK_ID,
          scope: SCOPE,
          worktreePath: repo,
          spec: resolveGateStack({
            containers: [
              { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
              {
                name: "broken",
                image: IMAGE,
                // Dies immediately, the way a branch that breaks its own
                // service bootstrap does.
                args: ["sh", "-c", "echo bootstrap-failed >&2; exit 1"],
                readiness: { kind: "tcp", port: 9999 },
                readinessTimeoutMs: 4_000,
              },
            ],
            steps: [{ name: "ok", in: "runner", command: ["true"] }],
          }),
        });

        const red = await stack.runGate();
        expect(red.ok).toBe(false);
        expect(red.failedStep).toBe(`container:${cName("broken")}`);
        // The container's own log is the trace — without it the agent is told
        // only that something failed to start.
        expect(red.containerLogs).toContain("bootstrap-failed");
      },
      180_000,
    );

    // D9's actual claim: the answer is in a container the failing step never
    // touched. Asserted on a single-container stack it is vacuous.
    it(
      "a red gate carries the logs of containers the failing step never ran in",
      async () => {
        stack = await startStack({
          stackId: STACK_ID,
          scope: SCOPE,
          worktreePath: repo,
          spec: resolveGateStack({
            containers: [
              {
                name: "backend",
                image: IMAGE,
                lifecycle: "issue",
                // Written by the container's MAIN process — `podman logs` shows
                // that, not the output of `podman exec`, so a postReadyCommand
                // would not have appeared here.
                args: [
                  "sh",
                  "-c",
                  "echo BACKEND-IS-ANGRY >&2; sleep infinity",
                ],
              },
              { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
            ],
            steps: [
              { name: "browser", in: "runner", command: ["sh", "-c", "exit 1"] },
            ],
          }),
        });

        const red = await stack.runGate();
        expect(red.ok).toBe(false);
        expect(red.failedStep).toBe("browser");
        // The step ran in `runner`; the diagnosis is in `backend`.
        expect(red.containerLogs).toContain("--- container backend (last");
        expect(red.containerLogs).toContain("BACKEND-IS-ANGRY");
      },
      180_000,
    );

    // A container with no readiness declared was never inspected at all, so a
    // dead one passed bringup and its failure was charged to the branch by
    // every step that talked to it.
    it(
      "a readiness-less container that dies at startup fails bringup",
      async () => {
        await expect(
          startStack({
            stackId: STACK_ID,
            scope: SCOPE,
            worktreePath: repo,
            spec: resolveGateStack({
              containers: [
                { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
                {
                  name: "mail",
                  image: IMAGE,
                  lifecycle: "issue",
                  args: ["sh", "-c", "echo mail-died >&2; exit 1"],
                },
              ],
              steps: [{ name: "ok", in: "runner", command: ["true"] }],
            }),
          }),
        ).rejects.toThrow(/exited during startup/);
      },
      180_000,
    );

    // The other half of the lifecycle blame mapping, which held only for as
    // long as the first attempt: an issue container that dies MID-RUN is still
    // infrastructure, so it must throw (→ HARD-ERROR → fresh stack) rather than
    // red the gate and hand the implementer a database it never touched.
    it(
      "an issue container that dies between gate runs throws instead of reddening",
      async () => {
        stack = await startStack({
          stackId: STACK_ID,
          scope: SCOPE,
          worktreePath: repo,
          spec: resolveGateStack({
            containers: [
              { name: "svc", image: IMAGE, lifecycle: "issue", hold: true },
              { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
            ],
            steps: [{ name: "ok", in: "runner", command: ["true"] }],
          }),
        });
        expect((await stack.runGate()).ok).toBe(true);

        await exec(RUNTIME, ["stop", "-t", "0", cName("svc")]);

        await expect(stack.runGate()).rejects.toThrow(/no longer running/);
      },
      180_000,
    );

    // #31. `log` readiness had no end-to-end coverage at all — this is that,
    // not a regression test for the buffer wall it fixes: reproducing that
    // needs 50MB of log, which journald would rate-limit (dropping the pattern
    // line and failing for an unrelated reason) and which no test should write
    // to an operator's journal. What actually removes the wall — that the
    // reader retains a bounded carry rather than the stream — is pinned in
    // gate-stack.test.ts, where it costs nothing.
    it(
      "log readiness goes green on a pattern printed after startup, under a noisy log",
      async () => {
        stack = await startStack({
          stackId: STACK_ID,
          scope: SCOPE,
          worktreePath: repo,
          spec: resolveGateStack({
            containers: [
              { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
              {
                name: "svc",
                image: IMAGE,
                lifecycle: "issue",
                // Chatty first, pattern last: the shape of a frontend dev
                // server printing a build, which is exactly the container
                // someone gives a `log` readiness to.
                args: [
                  "sh",
                  "-c",
                  "i=0; while [ $i -lt 4000 ]; do echo \"building chunk $i\"; i=$((i+1)); done; " +
                    "sleep 2; echo SERVICE-READY; sleep 300",
                ],
                readiness: { kind: "log", pattern: "SERVICE-READY" },
                readinessTimeoutMs: 60_000,
              },
            ],
            steps: [{ name: "ok", in: "runner", command: ["true"] }],
          }),
        });
        expect((await stack.runGate()).ok).toBe(true);
      },
      180_000,
    );

    // The half of #31 that misdirected the operator: a pattern that genuinely
    // never appears must say so. Under the old read this same message was
    // produced by a log that had merely outgrown node's buffer.
    it(
      "log readiness that never matches times out naming the pattern",
      async () => {
        await expect(
          startStack({
            stackId: STACK_ID,
            scope: SCOPE,
            worktreePath: repo,
            spec: resolveGateStack({
              containers: [
                { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
                {
                  name: "svc",
                  image: IMAGE,
                  lifecycle: "issue",
                  args: ["sh", "-c", "echo starting-up; sleep 300"],
                  readiness: { kind: "log", pattern: "NEVER-PRINTED" },
                  readinessTimeoutMs: 3_000,
                },
              ],
              steps: [{ name: "ok", in: "runner", command: ["true"] }],
            }),
          }),
        ).rejects.toThrow(/NEVER-PRINTED.*pattern not in log yet/s);
      },
      180_000,
    );

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
      "the timed-out work is reaped: an attempt container is removed, an issue one recreated",
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

        // …and the stack still works, which is the point of recreating rather
        // than leaving a hole where the container was.
        const after = await stack.runGate();
        expect(after.failedStep).toBe("hangs-in-held");
      },
      240_000,
    );
  },
);

// Why `boundedPodman` does its own timing instead of passing node's `timeout:`
// option (#26). Both facts below are about PODMAN, not about node, and both
// were discovered by running it — which is the only reason the option looks
// safe in a diff.
describe.runIf(available)("podman exec under a killed client", () => {
  const NAME = cName("killprobe");

  beforeEach(async () => {
    await exec(RUNTIME, ["rm", "-f", "-t", "0", NAME]).catch(() => {});
    await exec(RUNTIME, ["run", "-d", "--name", NAME, IMAGE, "sleep", "infinity"]);
  }, 60_000);

  afterEach(async () => {
    await exec(RUNTIME, ["rm", "-f", "-t", "0", NAME]).catch(() => {});
  }, 60_000);

  // The green-on-red this whole mechanism exists to avoid. Node's `timeout:`
  // kills the child with SIGTERM; `podman exec` EXITS 0 on SIGTERM; node
  // reports an error only for a non-zero code or a non-null signal — so the
  // call RESOLVES. A hung test suite would have been a GREEN gate, a hung
  // `exec` readiness probe a container reported ready, a hung postReadyCommand
  // a database reported seeded.
  it(
    "node's `timeout:` option reports a hung `podman exec` as SUCCESS",
    async () => {
      const r = await exec(RUNTIME, ["exec", NAME, "sleep", "600"], {
        timeout: 1_500,
      });
      // Not a rejection. This is the assertion.
      expect(r.stdout).toBe("");
    },
    60_000,
  );

  // …and the kill bought nothing either way, which is why a timeout has to
  // reap the container rather than just report.
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
      await exec(RUNTIME, ["rm", "-f", "-t", "0", NAME]);
      await expect(
        exec(RUNTIME, ["exec", NAME, "ps", "-eo", "args"]),
      ).rejects.toThrow();
    },
    60_000,
  );
});

// The follower itself (#31), against real podman. The end-to-end log-readiness
// tests above are coverage, not regression tests: on this host the log driver
// is whatever podman is configured with — journald buffers per line, so nothing
// ever splits — and their logs are three orders of magnitude under MAX_BUFFER.
// Mutation-tested: both of them pass with the carry removed AND with the
// pre-#31 full re-read restored. These do not. The driver is pinned explicitly
// because the split is the entire point.
describe.runIf(available)("watchLog", () => {
  // Scoped like every other resource in this file. A bare `sandbar-` name would
  // be unattributable debris (#28): an interrupted run leaves a container that
  // `findUnattributableResources` reports at every future sandbar startup and
  // that the sweep deliberately refuses to remove.
  const NAME = cName("logsplit");
  let watcher: LogWatcher | null = null;

  const runSplitter = async (script: string): Promise<void> => {
    await exec(RUNTIME, ["rm", "-f", "-t", "0", NAME]).catch(() => {});
    await exec(RUNTIME, [
      "run", "-d",
      // journald buffers per line and would never split, so the fact under
      // test would silently not be exercised on this host.
      "--log-driver", "k8s-file",
      "--name", NAME,
      IMAGE, "sh", "-c", script,
    ]);
  };

  // Poll the way waitForReady does, so what is asserted is the loop that runs
  // in production rather than a bespoke one.
  const pollUntil = async (
    w: LogWatcher,
    budgetMs: number,
  ): Promise<{ ready: boolean; detail: string }> => {
    const deadline = Date.now() + budgetMs;
    let last = { ready: false, detail: "" };
    while (Date.now() < deadline) {
      last = w.poll();
      if (last.ready) return last;
      await new Promise((r) => setTimeout(r, 250));
    }
    return last;
  };

  afterEach(async () => {
    watcher?.stop();
    watcher = null;
    await exec(RUNTIME, ["rm", "-f", "-t", "0", NAME]).catch(() => {});
  }, 60_000);

  // Fails without the carry: neither chunk contains the pattern.
  it(
    "goes ready on a pattern split across two chunks",
    async () => {
      await runSplitter('printf "boot: PAR"; sleep 2; printf "TIAL-READY\\n"; sleep 60');
      watcher = watchLog(NAME, "PARTIAL-READY");
      expect((await pollUntil(watcher, 20_000)).ready).toBe(true);
    },
    60_000,
  );

  // Fails without the StringDecoder: the split falls INSIDE the three bytes of
  // U+2713, and decoding each chunk on its own replaces both halves with U+FFFD
  // before the carry can help. `✓ Ready in` is what Next.js prints, which is
  // exactly the container a `log` readiness is for.
  it(
    "goes ready on a pattern split inside a multi-byte character",
    async () => {
      await runSplitter(
        'printf "boot \\342\\234"; sleep 2; printf "\\223 Ready in 1s\\n"; sleep 60',
      );
      watcher = watchLog(NAME, "✓ Ready in");
      expect((await pollUntil(watcher, 20_000)).ready).toBe(true);
    },
    60_000,
  );

  // The other half of #31: a genuine podman failure must say what podman said.
  // The old probe flattened this to "logs unavailable", which reads as "the
  // pattern never appeared".
  it(
    "reports podman's own words when the container does not exist",
    async () => {
      watcher = watchLog(cName("never-created"), "READY");
      const r = await pollUntil(watcher, 5_000);
      expect(r.ready).toBe(false);
      // Restarted rather than latched, and each death is counted and quoted.
      expect(watcher.deathNote()).toMatch(/log follower died \d+x/);
      expect(watcher.deathNote()).toContain("no such container");
    },
    60_000,
  );

  // The bound on an unbounded stream is this kill, so it is asserted rather
  // than assumed: an orphaned follower outlives the run.
  it(
    "stop() leaves no follower behind",
    async () => {
      await runSplitter("echo quiet; sleep 60");
      const w = watchLog(NAME, "NEVER");
      await pollUntil(w, 1_500);
      w.stop();
      await new Promise((r) => setTimeout(r, 500));
      const { stdout } = await exec("ps", ["-eo", "args"]).catch(() => ({
        stdout: "",
      }));
      expect(stdout).not.toContain(`logs -f ${NAME}`);
    },
    60_000,
  );
});

// The reason scanChunk carries bytes between chunks, asserted against podman
// rather than argued from a man page: a followed log delivers an unterminated
// partial line as its own chunk, so the two halves of a readiness pattern can
// arrive seconds apart. The host's own log driver decides this — journald
// buffers per line and would never split — so the driver is pinned explicitly
// here. Without the carry the container never goes ready and the operator is
// told the pattern never appeared.
describe.runIf(available)("podman logs -f chunking", () => {
  // Scoped like every other resource in this file. A bare `sandbar-` name is
  // unattributable debris (#28): an interrupted run leaves a container that
  // findUnattributableResources reports at every future sandbar startup and
  // that the sweep deliberately refuses to remove.
  const NAME = cName("chunking");

  afterEach(async () => {
    await exec(RUNTIME, ["rm", "-f", "-t", "0", NAME]).catch(() => {});
  });

  it(
    "delivers an unterminated partial line as its own chunk",
    async () => {
      await exec(RUNTIME, ["rm", "-f", "-t", "0", NAME]).catch(() => {});
      await exec(RUNTIME, [
        "run",
        "-d",
        "--log-driver",
        "k8s-file",
        "--name",
        NAME,
        IMAGE,
        "sh",
        "-c",
        // 6s, not 3: if the follower attaches after the second write both
        // halves arrive in one chunk and the assertion below fails for a
        // scheduling reason rather than a real one.
        'printf PAR; sleep 6; printf "TIAL-READY\n"; sleep 60',
      ]);

      const chunks = await new Promise<string[]>((resolveChunks, rejectChunks) => {
        const seen: string[] = [];
        const ch = spawn(RUNTIME, logFollowArgs(NAME));
        const done = setTimeout(() => {
          ch.kill("SIGKILL");
          resolveChunks(seen);
        }, 11_000);
        ch.stdout.on("data", (b: Buffer) => seen.push(b.toString("utf8")));
        ch.on("error", (err) => {
          clearTimeout(done);
          rejectChunks(err);
        });
      });

      // Two chunks, neither containing the pattern; concatenated they do.
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.some((c) => c.includes("PARTIAL-READY"))).toBe(false);
      expect(chunks.join("")).toContain("PARTIAL-READY");

      // And that is precisely what scanChunk is for.
      let carry = "";
      let found = false;
      for (const c of chunks) {
        const r = scanChunk(carry, c, "PARTIAL-READY");
        carry = r.carry;
        found = found || r.found;
      }
      expect(found).toBe(true);
    },
    60_000,
  );
});
