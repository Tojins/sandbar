// Gate-stack slice: the #49 pre-gate health check (a RUNNING container that
// still works) and #43 healthcheck readiness end to end. The family header —
// why these run against real podman and concurrently — is the test util's.

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, it } from "vitest";

import { resolveGateStack } from "./config.js";
import {
  ContainerBringupError,
  type Stack,
  startStack,
} from "./gate-stack.js";
import {
  buildVariantImage,
  IMAGE,
  initStackRepo,
} from "./gate-stack-podman.test-util.js";
import { stackContainerNameFor } from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import {
  podmanTestScope,
  podmanTestStackId,
  removeFixtureContainer,
} from "./podman-test-scope.test-util.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

// See podman-test-availability.test-util.ts for the collection-time rule and
// what `SANDBAR_REQUIRE_PODMAN_TESTS=1` changes.
const available = podmanTestsEnabled({
  what: "gate-stack health podman tests",
  image: IMAGE,
});

// Per PROCESS, not per file (#47) — see gate-stack-podman.test.ts.
const { scope: SCOPE, testImageTag, cleanup } = podmanTestScope(
  "gate-stack-health",
);

// One file-level sweep; nothing reaps this scope on SIGKILL — the recovery
// command is in `podman-test-scope.test-util.ts`.
afterAll(async () => {
  if (available) await cleanup();
}, 120_000);

// #49: the pre-gate check asks whether a RUNNING container still works.
// Only a real podman can produce the state this is about — a container that
// is running and unhealthy — which is why these are here rather than beside
// the classification tests in gate-stack.test.ts. The probe is flipped by a
// file the test writes into the worktree's IGNORED `out/` directory, so it
// never dirties the tree and never trips D1's refusal one function up.
//
// Healthy while `out/wedge` is absent, and it SPEAKS when it is not: the
// client prints the single word `unhealthy`, so a message that carries what
// the probe saw can only have come from `.State.Health.Log`.
describe.runIf(available)(
  "pre-gate health of a running issue container (#49)",
  () => {

    const WEDGE = "out/wedge";
    const WEDGE_PROBE = [
      "sh",
      "-c",
      `if [ -f /work/${WEDGE} ]; then echo PROBE-SAW-WEDGE; exit 1; fi`,
    ];
    const wedgeSpec = (readinessTimeoutMs: number) =>
      resolveGateStack({
        containers: [
          {
            name: "svc",
            image: IMAGE,
            lifecycle: "issue",
            // Held, which is what makes `issue` legal on a worktree-mounting
            // container: `sleep infinity` runs none of the branch's code.
            hold: true,
            mountWorktree: "/work",
            readiness: { kind: "healthcheck", command: WEDGE_PROBE },
            readinessTimeoutMs,
          },
          { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
        ],
        steps: [
          { name: "sees-code", in: "runner", command: ["cat", "marker.txt"] },
        ],
      });

    const inspectOf = async (
      cName: (name: string) => string,
      name: string,
      field: string,
    ): Promise<string> =>
      (
        await exec(RUNTIME, ["inspect", "--format", field, cName(name)])
      ).stdout.trim();
    const idOf = (cName: (name: string) => string, name: string) =>
      inspectOf(cName, name, "{{.Id}}");
    const wedge = async (repo: string): Promise<void> => {
      await mkdir(join(repo, "out"), { recursive: true });
      await writeFile(join(repo, WEDGE), "x\n");
    };

    // The CONTROL, and it carries real weight: an `ok`-only assertion passes
    // with an eager recreate present, and a recreate of a healthy `issue`
    // container would throw away the schema and rows the lifecycle exists to
    // keep.
    it.concurrent(
      "a running, healthy issue container is left exactly where it is",
      async ({ expect, task, onTestFinished }) => {
      const repo = await initStackRepo();
      let stack: Stack | null = null;
      const stackId = podmanTestStackId("podmantest", task.id);
      const cName = (name: string): string =>
        stackContainerNameFor(SCOPE, stackId, name);
      onTestFinished(async () => {
        if (stack) await stack.stop();
        await rm(repo, { recursive: true, force: true });
      }, 120_000);

        stack = await startStack({
          stackId: stackId,
          scope: SCOPE,
          worktreePath: repo,
          spec: wedgeSpec(10_000),
        });
        expect((await stack.runGate()).ok).toBe(true);
        const before = await idOf(cName, "svc");

        // The argv podman was handed is the consumer's declared `command`
        // verbatim, stored as `["CMD", …]` — no `CMD-SHELL` wrapper and no
        // re-split by a shell, which is the whole reason `readiness.command` is
        // argv like `step.command` and `postReadyCommands`.
        const registered = JSON.parse(
          await inspectOf(cName, "svc", "{{json .Config.Healthcheck}}"),
        ) as { Test?: string[] };
        expect(registered.Test).toEqual(["CMD", ...WEDGE_PROBE]);

        expect((await stack.runGate()).ok).toBe(true);
        expect(await idOf(cName, "svc")).toBe(before);
      },
      240_000,
    );

    // A healthcheck is not a liveness check: it can be TRANSIENTLY false — a
    // database mid-GC, a service reloading config, a probe that flakes under
    // load. One shot at the top of a gate run turns any of those into a
    // HARD-ERROR, two fresh stacks and an issue parked with an "environment"
    // trace, which is D5 running backwards introduced by the check meant to
    // prevent it. So this is the assertion that fails if one-shot escalation
    // ever creeps back: unhealthy when the gate run starts, healthy before the
    // deadline, and nothing recreated.
    it.concurrent(
      "waits out a transiently unhealthy issue container instead of escalating",
      async ({ expect, task, onTestFinished }) => {
      const repo = await initStackRepo();
      let stack: Stack | null = null;
      const stackId = podmanTestStackId("podmantest", task.id);
      const cName = (name: string): string =>
        stackContainerNameFor(SCOPE, stackId, name);
      onTestFinished(async () => {
        if (stack) await stack.stop();
        await rm(repo, { recursive: true, force: true });
      }, 120_000);

        stack = await startStack({
          stackId: stackId,
          scope: SCOPE,
          worktreePath: repo,
          spec: wedgeSpec(30_000),
        });
        expect((await stack.runGate()).ok).toBe(true);
        const before = await idOf(cName, "svc");

        await wedge(repo);
        const started = Date.now();
        const gate = stack.runGate();
        const unwedge = setTimeout(() => {
          void rm(join(repo, WEDGE)).catch(() => {});
        }, 3_000);
        try {
          expect((await gate).ok).toBe(true);
        } finally {
          clearTimeout(unwedge);
        }
        // It WAITED. Without this the test passes just as happily with the
        // whole check deleted, since a gate that never looks is also green.
        expect(Date.now() - started).toBeGreaterThan(2_500);
        expect(await idOf(cName, "svc")).toBe(before);
      },
      240_000,
    );

    // The escalation, and the two halves of D4 that `rejects.toThrow` alone
    // cannot see: the container is RECREATED before anything is thrown, and it
    // comes back on the image the branch put it on rather than the declared one
    // — the same one-word #37 regression `reapKilledStep`'s own test pins, at
    // the one other bringup that neither precedes nor follows a `running.map`
    // update.
    it.concurrent(
      "a persistently unhealthy issue container is recreated on its running image, then throws",
      async ({ expect, task, onTestFinished }) => {
      const repo = await initStackRepo();
      let stack: Stack | null = null;
      const stackId = podmanTestStackId("podmantest", task.id);
      const cName = (name: string): string =>
        stackContainerNameFor(SCOPE, stackId, name);
      onTestFinished(async () => {
        if (stack) await stack.stop();
        await rm(repo, { recursive: true, force: true });
      }, 120_000);

        // A built image, not a `podman tag` alias — see `buildVariantImage`.
        // Since #45 an alias is not a changed image: the staleness check
        // settles a difference in the reference STRING by comparing image IDs
        // before believing it, so re-tagging identical bytes correctly
        // recreates nothing and `svc` would still be on the declared `IMAGE`
        // when the assertion below reads it back.
        const ALIAS = testImageTag("health-image");
        await buildVariantImage(ALIAS);
        stack = await startStack({
          stackId: stackId,
          scope: SCOPE,
          worktreePath: repo,
          images: async () => new Map([[IMAGE, ALIAS]]),
          spec: wedgeSpec(4_000),
        });
        expect((await stack.runGate()).ok).toBe(true);
        const before = await idOf(cName, "svc");
        expect(await inspectOf(cName, "svc", "{{.ImageName}}")).toBe(ALIAS);

        await wedge(repo);
        let caught: unknown = null;
        try {
          await stack.runGate();
        } catch (err) {
          caught = err;
        }

        // A throw, not a red: the container depends only on image and env, so
        // this is infrastructure and the fresh-stack retry is what it wants.
        // The CLASS matters as much as the prose — `inner-loop.ts` rethrows a
        // bare SandbarError past HARD-ERROR.
        expect(caught).toBeInstanceOf(ContainerBringupError);
        const e = caught as ContainerBringupError;
        // The whole sequence, because none of it is recoverable afterwards.
        expect(e.message).toMatch(/was healthy when it came up/);
        expect(e.message).toMatch(/did not recover within 4000ms/);
        expect(e.message).toMatch(/did not come back when sandbar recreated it/);
        // What the OLD container's probe said, read at the deadline BEFORE the
        // recreate removed it — that container is gone by the time anyone reads
        // this, so nothing else can ever recover it.
        expect(e.message).toMatch(/last probe: [\s\S]*PROBE-SAW-WEDGE/);
        // And the FRESH container's own record, from `.State.Health.Log`. Both
        // are the probe talking: the client prints only the word `unhealthy`,
        // so neither can have come from it.
        expect(e.healthLog).toContain("PROBE-SAW-WEDGE");
        expect(e.message).toContain("Container log tail:");
        // …and exactly one of each block: `reason` exists so re-raising does
        // not nest a second copy inside the first.
        expect(e.message.match(/Container log tail:/g)?.length).toBe(1);

        // D4 happened, and it happened on the RUNNING variant. `rejects` alone
        // passes with the recreate deleted; an id-only assertion passes with
        // the image regression present.
        expect(await idOf(cName, "svc")).not.toBe(before);
        expect(await inspectOf(cName, "svc", "{{.ImageName}}")).toBe(ALIAS);
      },
      300_000,
    );

    // The state question decides FIRST, and this is what pins the order.
    // `podman healthcheck run` cannot classify death — stopped, removed and a
    // podman that is merely unwell all arrive as 125 with different prose — so
    // a probed container that STOPPED must still produce #36's message rather
    // than a health one, which would send its reader to debug a probe against a
    // container that is not running.
    it.concurrent(
      "a stopped issue container reports its state, not its health, even when probed",
      async ({ expect, task, onTestFinished }) => {
      const repo = await initStackRepo();
      let stack: Stack | null = null;
      const stackId = podmanTestStackId("podmantest", task.id);
      const cName = (name: string): string =>
        stackContainerNameFor(SCOPE, stackId, name);
      onTestFinished(async () => {
        if (stack) await stack.stop();
        await rm(repo, { recursive: true, force: true });
      }, 120_000);

        stack = await startStack({
          stackId: stackId,
          scope: SCOPE,
          worktreePath: repo,
          spec: wedgeSpec(10_000),
        });
        expect((await stack.runGate()).ok).toBe(true);

        await exec(RUNTIME, ["stop", "-t", "0", cName("svc")]);
        let caught: unknown = null;
        try {
          await stack.runGate();
        } catch (err) {
          caught = err;
        }
        expect((caught as Error | null)?.message).toMatch(/no longer running/);
        // Not the recovery poll's prose, and not its cost either: that would be
        // a claim about a probe podman refused to run, arrived at by spending a
        // readiness budget against a container that cannot answer.
        expect((caught as Error).message).not.toMatch(/did not recover/);

        await removeFixtureContainer(cName("svc"));
        await expect(stack.runGate()).rejects.toThrow(/no longer exists/);
      },
      240_000,
    );

    // #43 end to end, and written as the issue's own worked example: mariadb's
    // `healthcheck.sh --connect --innodb_initialized` is exactly the probe the
    // retired `log` kind existed to approximate. The entrypoint runs a
    // TEMPORARY server while it applies init files, and that server accepts
    // connections — so a naive probe goes green on a database that is about to
    // be shut down and restarted. This one does not, which is why a log pattern
    // is no longer needed to tell them apart.
    //
    // The image declares no HEALTHCHECK of its own (it ships the script and
    // leaves the instruction out), which is the other half of why `command` is
    // required rather than optional.
    it.concurrent(
      "healthcheck readiness goes green on the image's own probe",
      async ({ expect, task, onTestFinished }) => {
      const repo = await initStackRepo();
      let stack: Stack | null = null;
      const stackId = podmanTestStackId("podmantest", task.id);
      const cName = (name: string): string =>
        stackContainerNameFor(SCOPE, stackId, name);
      onTestFinished(async () => {
        if (stack) await stack.stop();
        await rm(repo, { recursive: true, force: true });
      }, 120_000);

        stack = await startStack({
          stackId: stackId,
          scope: SCOPE,
          worktreePath: repo,
          spec: resolveGateStack({
            containers: [
              { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
              {
                name: "db",
                image: IMAGE,
                lifecycle: "issue",
                env: {
                  MYSQL_ALLOW_EMPTY_PASSWORD: "yes",
                  MYSQL_DATABASE: "app",
                },
                readiness: {
                  kind: "healthcheck",
                  command: [
                    "healthcheck.sh",
                    "--connect",
                    "--innodb_initialized",
                  ],
                },
                readinessTimeoutMs: 120_000,
              },
            ],
            steps: [
              {
                name: "query",
                in: "runner",
                command: ["mariadb", "-h", "127.0.0.1", "-uroot", "-e", "SELECT 1"],
              },
            ],
          }),
        });
        // Bringup returning is the readiness assertion; the step is what makes
        // it a claim about a REAL server rather than about the probe giving up.
        expect((await stack.runGate()).ok).toBe(true);
      },
      240_000,
    );

    // The failing half, and the thing #43's notes say misleads silently:
    // `podman healthcheck run` prints the single word `unhealthy` on failure,
    // so a message built from the CLIENT's output would say LESS than the
    // `exec` probe this replaced. What the probe actually saw is in
    // `.State.Health.Log`, and the error has to carry it.
    it.concurrent(
      "a readiness timeout quotes the probe's own output, not podman's `unhealthy`",
      async ({ expect, task, onTestFinished }) => {
      const repo = await initStackRepo();
      let stack: Stack | null = null;
      const stackId = podmanTestStackId("podmantest", task.id);
      const cName = (name: string): string =>
        stackContainerNameFor(SCOPE, stackId, name);
      onTestFinished(async () => {
        if (stack) await stack.stop();
        await rm(repo, { recursive: true, force: true });
      }, 120_000);

        const spec = resolveGateStack({
          containers: [
            { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
            {
              name: "svc",
              image: IMAGE,
              lifecycle: "issue",
              args: ["sh", "-c", "echo starting-up; sleep 300"],
              readiness: {
                kind: "healthcheck",
                command: ["sh", "-c", "echo PROBE-SAW-THIS; exit 1"],
              },
              readinessTimeoutMs: 5_000,
            },
          ],
          steps: [{ name: "ok", in: "runner", command: ["true"] }],
        });

        let caught: unknown = null;
        try {
          stack = await startStack({
            stackId: stackId,
            scope: SCOPE,
            worktreePath: repo,
            spec,
          });
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(ContainerBringupError);
        const e = caught as ContainerBringupError;
        // Names the container and the probe, so an operator is not left
        // guessing which of several containers timed out.
        expect(e.message).toMatch(/'svc'[\s\S]*did not become ready/);
        expect(e.message).toContain("PROBE-SAW-THIS");
        // NOT the word podman's client printed. If this is what the message
        // quotes, the health log is not being read at all.
        expect(e.message).not.toMatch(/last probe: unhealthy/);
        // The health block is ADDED to the container log tail, never swapped
        // for it: the probe's output says what failed, the container's own log
        // usually says why.
        expect(e.healthLog).toContain("PROBE-SAW-THIS");
        expect(e.message).toContain("Container log tail:");
        expect(e.message).toContain("starting-up");
      },
      120_000,
    );
  },
);
