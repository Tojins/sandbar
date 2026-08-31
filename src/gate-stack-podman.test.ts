// Gate-stack shard: gate mechanics, the lifecycle split, bringup blame
// (#24 D5/D9, #36) and both #50 volume layers. The family header — why these
// run against a real podman, the empirical facts index, and why the suite is
// sharded — is gate-stack-podman.test-util.ts's.

import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveGateStack } from "./config.js";
import {
  bringUpContainers,
  CONTAINER_RM_ARGS,
  ContainerBringupError,
  type Stack,
  startStack,
} from "./gate-stack.js";
import {
  IMAGE,
  initStackRepo,
  runExit,
} from "./gate-stack-podman.test-util.js";
import { scopedResourcePrefix, stackContainerNameFor } from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import {
  podmanTestScope,
  removeFixtureContainer,
  runFixtureContainer,
} from "./podman-test-scope.test-util.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

// Every VOLUME-typed mount a container holds, space-separated (#50). Bind
// mounts are excluded by the type test: sandbar builds those by the dozen and
// they are not what leaks. A host-wide `podman volume ls | wc -l` baseline is
// deliberately NOT how this is measured — since #48 these containers are
// siblings of the run's own on one podman, with three issues gating in
// parallel, so that count moves under the assertion for unrelated reasons.
const VOLUMES_OF = (name: string): string[] => [
  "inspect",
  "-f",
  '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}',
  name,
];

// Resolved at COLLECTION time, not in beforeAll — see
// podman-test-availability.test-util.ts for why, and for what
// `SANDBAR_REQUIRE_PODMAN_TESTS=1` (the gate runner's env, #48) changes.
const available = podmanTestsEnabled({
  what: "gate-stack podman tests",
  image: IMAGE,
});

// Per PROCESS, not per file (#47). Two copies of this file running at once
// would otherwise compute identical pod, network and container names, and
// `startStack` force-removes a namesake before creating one — so each would
// tear down the other's live stack mid-test.
//
// `STACK_ID` stays a literal on purpose: the scope already separates the two
// processes, and a readable stack id is what makes leftover debris
// identifiable.
const { scope: SCOPE, cleanup } = podmanTestScope("gate-stack");
const STACK_ID = "podmantest";
const cName = (name: string): string =>
  stackContainerNameFor(SCOPE, STACK_ID, name);

// One file-level sweep, covering every `describe` below rather than only the
// first. Guarded because it shells out to podman and there is none in the gate
// runner — where `available` is false nothing was created, so there is nothing
// to remove. Nothing reaps this scope if the process is SIGKILLed; the
// recovery command is in `podman-test-scope.test-util.ts`.
afterAll(async () => {
  if (available) await cleanup();
}, 120_000);

describe.runIf(available)(
  "gate stack against real podman",
  () => {
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

    // This test's readiness declaration is incidental — what it pins is the
    // lifecycle split, which the socket preserves perfectly and which no
    // `ok`-only assertion can see. It has been through two readiness kinds for
    // that reason: #48 moved the tcp half of the original away (a host-side
    // probe a gate runner cannot reach) and left an `exec` probe behind, and
    // #43 retired `exec` in turn.
    it(
      "issue containers keep their id and their state across gate runs",
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
                readiness: {
                  kind: "healthcheck",
                  command: ["mariadb", "-h", "127.0.0.1", "-uroot", "-e", "SELECT 1"],
                },
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
                // A probe that would PASS, deliberately: what fails here is the
                // container, and `podman healthcheck run` against a container
                // that is not running exits 125 whatever the command is. That
                // keeps the assertion about D5's blame mapping rather than
                // about a probe verdict.
                readiness: { kind: "healthcheck", command: ["true"] },
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

    // Since #44 this bringup serves two stacks, and its errors are the only
    // thing either one says about a container that would not start: the gate's
    // become a red or a HARD-ERROR, the sandbox's go verbatim into the
    // implementer's prompt, directly under a paragraph telling the agent the
    // gate's stack is a namespace it cannot reach. Hardcoded, every one of them
    // reads there as a red gate that never ran.
    //
    // The netns attachment is the sandbox's own topology, and nothing about it
    // needs a local client: since #43 no probe runs on the host at all, and
    // this container dies before readiness is even asked. So it runs in the
    // gate, every attempt, rather than joining the host-only set.
    it(
      "a bringup failure names the stack it was told it belongs to",
      async () => {
        const anchor = `${scopedResourcePrefix(SCOPE)}labelanchor`;
        await removeFixtureContainer("--depend", anchor).catch(() => {});
        await runFixtureContainer([
          "--name",
          anchor,
          "--entrypoint",
          "sleep",
          IMAGE,
          "infinity",
        ]);
        const spec = resolveGateStack({
          containers: [
            { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
            {
              name: "dead",
              image: IMAGE,
              args: ["sh", "-c", "echo sibling-died >&2; exit 1"],
            },
          ],
          steps: [{ name: "ok", in: "runner", command: ["true"] }],
        });
        const dead = spec.containers.filter((c) => c.name === "dead");
        try {
          await expect(
            bringUpContainers(dead, {
              attach: { kind: "netns", anchorContainerName: anchor },
              label: "sandbox stack",
              worktreePath: repo,
              nameOf: (c) => cName(c.name),
            }),
          ).rejects.toThrow(/^sandbox stack: .*exited during startup/);
        } finally {
          // `--depend` takes the joiner with it, which is the removal order
          // this topology forces everywhere else too.
          await removeFixtureContainer("--depend", anchor).catch(() => {});
        }
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

        // The CLASS is the load-bearing half, not just the prose:
        // `inner-loop.ts` rethrows a bare SandbarError PAST HARD-ERROR, which
        // would drop the issue for the cycle with no terminal, no comment and
        // no label flip — the opposite of the fresh-stack retry this throw
        // exists to trigger.
        await expect(stack.runGate()).rejects.toThrow(ContainerBringupError);
        await expect(stack.runGate()).rejects.toThrow(/no longer running/);
      },
      180_000,
    );

    // #36. The same mapping for the other way a container stops existing, which
    // `inspect` alone cannot see: it exits 125 both for a container that is
    // GONE and for a podman that is merely unwell, so the removed case was read
    // as "could not answer" and waved through — and the gate then reddened
    // AGAINST THE BRANCH on the first step to exec into it.
    it(
      "an issue container that is REMOVED between gate runs throws instead of reddening",
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
            // The step does not touch `svc` at all: the assert is a property of
            // the stack, checked before any step runs, not a step failure that
            // happens to mention it.
            steps: [{ name: "ok", in: "runner", command: ["true"] }],
          }),
        });
        expect((await stack.runGate()).ok).toBe(true);

        await removeFixtureContainer(cName("svc"));

        // Not `.ok === false`: reddening is precisely the bug — and pre-fix
        // this was not even a red, it was a fully GREEN gate, because no step
        // in this stack execs into `svc`. And the prose has to say REMOVED:
        // "no longer running" sends the operator to `podman logs` for a
        // container that answers "no container with name or ID ... found".
        await expect(stack.runGate()).rejects.toThrow(ContainerBringupError);
        await expect(stack.runGate()).rejects.toThrow(/no longer exists/);
      },
      180_000,
    );

    // The empirical claim the fix above rests on, pinned rather than trusted:
    // `container exists` answers 0 for a container in ANY state and 1 for one
    // that is not there, which is the distinction `inspect` refuses to draw.
    // Podman's wording for the two 125s differs per subcommand (`no such
    // object` from inspect, `no container with name or ID ... found` from
    // exec), so matching on stderr instead would be fragile in a way this is
    // not.
    it(
      "`container exists` separates gone from flaked where `inspect` cannot",
      async () => {
        const name = cName("svc");
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

        const inspect = ["inspect", "--format", "{{.State.Running}}", name];
        const exists = ["container", "exists", name];

        expect(await runExit(inspect)).toEqual({ code: 0, stdout: "true" });
        expect((await runExit(exists)).code).toBe(0);

        await exec(RUNTIME, ["stop", "-t", "0", name]);
        // Stopped: inspect answers cleanly, so `exists` is never consulted.
        expect(await runExit(inspect)).toEqual({ code: 0, stdout: "false" });
        expect((await runExit(exists)).code).toBe(0);

        await removeFixtureContainer(name);
        // Removed: inspect's 125 is the exit code a broken podman also gives.
        expect((await runExit(inspect)).code).toBe(125);
        expect((await runExit(exists)).code).toBe(1);
      },
      180_000,
    );

    // #50, layer 1. Podman's default `--image-volume=bind` provisions an
    // ANONYMOUS volume per container for every builtin `VOLUME` in the image,
    // and `mariadb` — this file's image — declares `/var/lib/mysql`. Each one
    // holds a lock out of the host's single pool of 2048 until it is removed,
    // and sandbar's removals did not take it: 2000 of them stopped a real host
    // from creating any podman object at all, in unrelated projects too.
    //
    // Asserted WHILE THE STACK IS UP, which is what makes it race-free and
    // needs no baseline: the question is whether the volume was ever created,
    // not whether something later reaped it. The control that keeps it from
    // being vacuous — that this image really does declare a `VOLUME`, so an
    // empty list means the flag worked rather than that there was nothing to
    // suppress — is the layer-2 test at the bottom of this file, which creates
    // the same image WITHOUT the flag and finds one.
    it(
      "creates no anonymous volume for the image's VOLUME directives",
      async () => {
        stack = await startStack({
          stackId: STACK_ID,
          scope: SCOPE,
          worktreePath: repo,
          spec: resolveGateStack({
            containers: [
              { name: "db", image: IMAGE, lifecycle: "issue", hold: true },
              { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
            ],
            steps: [{ name: "ok", in: "runner", command: ["true"] }],
          }),
        });
        expect((await stack.runGate()).ok).toBe(true);

        // Both containers: `issue` and `attempt` differ in lifetime, and the
        // `attempt` one is the expensive half — it is RECREATED on every gate
        // run, so pre-fix each attempt bought another volume that nothing
        // would ever read.
        for (const name of ["db", "runner"]) {
          const { code, stdout } = await runExit(VOLUMES_OF(cName(name)));
          expect({ name, code, stdout }).toEqual({ name, code: 0, stdout: "" });
        }
      },
      300_000,
    );
  },
);

// #50, layer 2 — and the control for layer 1, since it is what proves this
// image declares a builtin `VOLUME` at all.
//
// Past `--image-volume=ignore` no container sandbar creates carries an
// anonymous volume, so `-v` on the removals can only ever fire against one a
// PRE-UPGRADE sandbar left behind — which `bringUpContainers`' pre-create
// removal of a stale namesake and the orphan sweep both really do meet. That
// population cannot be produced by sandbar any more, so the fixture is created
// with a hand-written `podman run` at podman's DEFAULT, deliberately bypassing
// `runFixtureContainer`: it is the pre-upgrade container, not a fixture.
describe.runIf(available)("removing a pre-upgrade container's volume", () => {
  const NAME = cName("volprobe");

  afterEach(async () => {
    await removeFixtureContainer(NAME).catch(() => {});
  }, 60_000);

  it(
    "takes the anonymous volume with the container",
    async () => {
      await exec(RUNTIME, [
        "run",
        "-d",
        "--name",
        NAME,
        "--entrypoint",
        "sleep",
        IMAGE,
        "infinity",
      ]);

      // The control half. If this ever comes back empty the layer-1 assertion
      // above has quietly stopped meaning anything, and the failure belongs
      // here rather than there.
      const { code, stdout } = await runExit(VOLUMES_OF(NAME));
      expect(code).toBe(0);
      const volumes = stdout.split(" ").filter(Boolean);
      expect(volumes.length).toBeGreaterThan(0);
      for (const v of volumes) {
        expect({ v, code: (await runExit(["volume", "exists", v])).code }).toEqual(
          { v, code: 0 },
        );
      }

      // Sandbar's own removal argv, not a hand-written one: the `-v` is the
      // whole subject, and a literal here would pass with the production
      // builder reverted.
      await exec(RUNTIME, CONTAINER_RM_ARGS(NAME));
      for (const v of volumes) {
        expect({ v, code: (await runExit(["volume", "exists", v])).code }).toEqual(
          { v, code: 1 },
        );
      }
    },
    300_000,
  );
});
