import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveGateStack } from "./config.js";
import { type Stack, startStack } from "./gate-stack.js";
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
      await exec(RUNTIME, ["pod", "rm", "-f", `sandbar-pod-${STACK_ID}`]).catch(
        () => {},
      );
      await exec(RUNTIME, ["network", "rm", `sandbar-net-${STACK_ID}`]).catch(
        () => {},
      );
    }, 60_000);

    it(
      "runs steps in a held container that sees the worktree, and reports the failing step",
      async () => {
        stack = await startStack({
          stackId: STACK_ID,
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
        ).rejects.toThrow(/did not become ready/);
      },
      180_000,
    );

    it(
      "tcp readiness goes green on a real listener, and issue containers survive gate runs",
      async () => {
        stack = await startStack({
          stackId: STACK_ID,
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
        // Second run: `attempt` containers are recreated, `issue` ones are not —
        // so the database is not paying a 15s bringup per attempt.
        expect((await stack.runGate()).ok).toBe(true);
      },
      240_000,
    );
  },
);
