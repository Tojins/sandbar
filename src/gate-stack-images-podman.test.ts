// Gate-stack slice: per-branch images between gate runs (#37, #46) — the
// swap, the reap's image bookkeeping, the failed-recreate blame path, and the
// build-failure red. The family header — why these run against a real podman
// and why its tests run concurrently — is the test util's.

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, it } from "vitest";

import { resolveGateStack } from "./config.js";
import { ImageBuildError } from "./ensure-images.js";
import { startStack } from "./gate-stack.js";
import {
  buildVariantImage,
  gateStackFixture,
  IMAGE,
} from "./gate-stack-podman.test-util.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import { podmanTestScope } from "./podman-test-scope.test-util.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

// See podman-test-availability.test-util.ts for the collection-time rule and
// what `SANDBAR_REQUIRE_PODMAN_TESTS=1` changes.
const available = podmanTestsEnabled({
  what: "gate-stack image podman tests",
  image: IMAGE,
});

// Per PROCESS, not per file (#47) — see gate-stack-podman.test.ts.
const {
  scope: SCOPE,
  testImageTag,
  cleanup,
} = podmanTestScope("gate-stack-images");

// One file-level sweep; nothing reaps this scope on SIGKILL — the recovery
// command is in `podman-test-scope.test-util.ts`.
afterAll(async () => {
  if (available) await cleanup();
}, 120_000);

describe.runIf(available)("per-branch images between gate runs (#37)", () => {
  // #37. An image that bakes a lockfile is a function of the branch, so the
  // stack has to be able to change which image it runs BETWEEN gate runs —
  // the branch grows under the loop, and an attempt that adds a dependency
  // must be gated against an image that has it.
  //
  // The interesting half is the `issue` container. `attempt` ones are
  // recreated every gate run regardless, so a swap could not fail to reach
  // them; an `issue` container is deliberately long-lived, which is exactly
  // how it would go on running the old image forever.
  it.concurrent(
    "a changed image recreates the issue container, and an unchanged one leaves it alone",
    async ({ expect, task, onTestFinished }) => {
      const { repo, stackId, inspectOf, hold } = await gateStackFixture(
        SCOPE,
        task.id,
        onTestFinished,
      );

      // A built image, not a `podman tag` alias — see `buildVariantImage`.
      // Since #45 an alias is not a changed image: same ID, so the staleness
      // check settles the string difference and recreates nothing, which is
      // right and would leave this test asserting nothing.
      const ALIAS = testImageTag("image-swap");
      await buildVariantImage(ALIAS);
      let swap = new Map<string, string>();
      // What the stack ASKS about, recorded: since #46 the resolver is shared
      // with the agent sandbox, and the stack — not its caller — names the
      // images it runs, so it can never be handed an entry no container here
      // runs and be reddened by a build it has no use for.
      let askedFor: ReadonlySet<string> | null = null;
      const stack = hold(
        await startStack({
          stackId: stackId,
          scope: SCOPE,
          worktreePath: repo,
          images: async (only) => {
            askedFor = only;
            return swap;
          },
          spec: resolveGateStack({
            containers: [
              { name: "held", image: IMAGE, lifecycle: "issue", hold: true },
              {
                name: "runner",
                image: IMAGE,
                mountWorktree: "/work",
                hold: true,
              },
            ],
            steps: [
              {
                name: "sees-code",
                in: "runner",
                command: ["cat", "marker.txt"],
              },
            ],
          }),
        }),
      );

      expect((await stack.runGate()).ok).toBe(true);
      // Exactly the two containers' images — this stack's own, and only its
      // own (#46).
      expect([...(askedFor ?? [])]).toEqual([IMAGE]);
      const idBefore = await inspectOf("held", "{{.Id}}");
      expect(await inspectOf("held", "{{.ImageName}}")).toContain("mariadb");

      // A second gate run with the same (empty) map must NOT churn it — the
      // whole value of `lifecycle: "issue"` is that a database keeps its
      // state across attempts.
      expect((await stack.runGate()).ok).toBe(true);
      expect(await inspectOf("held", "{{.Id}}")).toBe(idBefore);

      // Now the branch changes what the image is built from.
      swap = new Map([[IMAGE, ALIAS]]);
      expect((await stack.runGate()).ok).toBe(true);
      const idAfter = await inspectOf("held", "{{.Id}}");
      expect(idAfter).not.toBe(idBefore);
      expect(await inspectOf("held", "{{.ImageName}}")).toBe(ALIAS);
      expect(await inspectOf("runner", "{{.ImageName}}")).toBe(ALIAS);

      // …and it settles: a further run with the SAME map recreates nothing,
      // which is the bookkeeping that keeps a per-branch image from
      // restarting the stack on every attempt.
      expect((await stack.runGate()).ok).toBe(true);
      expect(await inspectOf("held", "{{.Id}}")).toBe(idAfter);
    },
    300_000,
  );

  // The regression the whole feature can die on, and the one bringup that
  // neither precedes nor follows a `running.map` update: `reapKilledStep`
  // recreates a timed-out `issue` container, and recreating it from the
  // DECLARED image silently puts the stack back on the base image while the
  // map still says it is on the branch's variant. Nothing ever sees it as
  // stale again, so every remaining attempt gates against the source
  // branch's dependencies — #37 verbatim, green included.
  it.concurrent(
    "a reaped issue container comes back on the image the branch put it on, not the declared one",
    async ({ expect, task, onTestFinished }) => {
      const { repo, stackId, cName, hold } = await gateStackFixture(
        SCOPE,
        task.id,
        onTestFinished,
      );

      const ALIAS = testImageTag("reap-image");
      await buildVariantImage(ALIAS);
      const stack = hold(
        await startStack({
          stackId: stackId,
          scope: SCOPE,
          worktreePath: repo,
          images: async () => new Map([[IMAGE, ALIAS]]),
          spec: resolveGateStack({
            containers: [
              { name: "held", image: IMAGE, lifecycle: "issue", hold: true },
              {
                name: "runner",
                image: IMAGE,
                mountWorktree: "/work",
                hold: true,
              },
            ],
            steps: [
              {
                name: "sees-code",
                in: "runner",
                command: ["cat", "marker.txt"],
              },
              {
                name: "hangs-in-held",
                in: "held",
                command: ["sleep", "613"],
                timeoutMs: 2_000,
              },
            ],
          }),
        }),
      );

      const imageNameOf = async (name: string): Promise<string> =>
        (
          await exec(RUNTIME, [
            "inspect",
            "--format",
            "{{.ImageName}}",
            cName(name),
          ])
        ).stdout.trim();

      expect((await stack.runGate()).failedStep).toBe("hangs-in-held");
      // Recreated by the reap — and on the variant. `ok`-only, or an
      // id-only, assertion passes with the bug present.
      expect(await imageNameOf("held")).toBe(ALIAS);

      // …and the next gate run does not see it as stale (the map is
      // unchanged), which is exactly why getting the reap wrong would never
      // self-correct.
      expect((await stack.runGate()).failedStep).toBe("hangs-in-held");
      expect(await imageNameOf("held")).toBe(ALIAS);
    },
    300_000,
  );

  // The ordering trap the recreate introduces. `bringUp` removes before it
  // creates, so a recreate that fails leaves the issue container GONE — and
  // `assertIssueContainersAlive` would then read sandbar's own removal as
  // "it came up once and something killed it", i.e. an infra HARD-ERROR
  // blaming the environment for an image the branch authored.
  it.concurrent(
    "a failing issue-container recreate reds, and the next gate run retries it instead of reporting infra death",
    async ({ expect, task, onTestFinished }) => {
      const { repo, stackId, cName, hold } = await gateStackFixture(
        SCOPE,
        task.id,
        onTestFinished,
      );

      const stack = hold(
        await startStack({
          stackId: stackId,
          scope: SCOPE,
          worktreePath: repo,
          // An invalid reference, so `podman run` refuses instantly instead of
          // spending a pull timeout. WHY the run fails is not what is under
          // test — the blame path is: whatever kills a recreate leaves the
          // container removed, and that is the state the next gate run has to
          // read correctly.
          images: async () => new Map([[IMAGE, "localhost/Bad_Name:nope"]]),
          spec: resolveGateStack({
            containers: [
              { name: "held", image: IMAGE, lifecycle: "issue", hold: true },
              {
                name: "runner",
                image: IMAGE,
                mountWorktree: "/work",
                hold: true,
              },
            ],
            steps: [
              {
                name: "sees-code",
                in: "runner",
                command: ["cat", "marker.txt"],
              },
            ],
          }),
        }),
      );

      const first = await stack.runGate();
      expect(first.ok).toBe(false);
      expect(first.failedStep).toBe(`container:${cName("held")}`);

      // The container is gone, and the second run must NOT call that an
      // infrastructure failure — it must try the recreate again and red the
      // same way, so the implementer keeps getting a verdict it can act on.
      await expect(
        exec(RUNTIME, ["inspect", "--format", "{{.Id}}", cName("held")]),
      ).rejects.toThrow();
      const second = await stack.runGate();
      expect(second.ok).toBe(false);
      expect(second.failedStep).toBe(`container:${cName("held")}`);
    },
    300_000,
  );

  // The blame mapping, and the reason this is not simply left to throw. A
  // lockfile that does not install is the branch's to fix; as an infra
  // failure it would buy two fresh-stack retries reproducing it exactly and
  // then park the issue with a trace blaming the environment.
  it.concurrent(
    "an image that will not build is a gate RED naming the image, not a throw",
    async ({ expect, task, onTestFinished }) => {
      const { repo, stackId, hold } = await gateStackFixture(
        SCOPE,
        task.id,
        onTestFinished,
      );

      const stack = hold(
        await startStack({
          stackId: stackId,
          scope: SCOPE,
          worktreePath: repo,
          images: async () => {
            throw new ImageBuildError(
              "app",
              "`podman build ...` exited with code 1.",
              "npm error code EUSAGE\nnpm error `npm ci` can only install...",
            );
          },
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
                name: "sees-code",
                in: "runner",
                command: ["cat", "marker.txt"],
              },
            ],
          }),
        }),
      );

      const red = await stack.runGate();
      expect(red.ok).toBe(false);
      expect(red.failedStep).toBe("image:app");
      // The build's own output is the diagnosis and has to survive into the
      // trace the implementer reads.
      expect(red.stderr).toContain("npm error code EUSAGE");
      // No step ran, so nothing else should look like a verdict about one.
      expect(red.stdout).toBe("");
    },
    180_000,
  );

  // The dirty-tree refusal is CHEAPER than a build and comes first: a tree
  // that gets no verdict at all should not pay for an image.
  it.concurrent(
    "does not resolve images for a worktree it is going to refuse anyway",
    async ({ expect, task, onTestFinished }) => {
      const { repo, stackId, hold } = await gateStackFixture(
        SCOPE,
        task.id,
        onTestFinished,
      );

      let asked = 0;
      const stack = hold(
        await startStack({
          stackId: stackId,
          scope: SCOPE,
          worktreePath: repo,
          images: async () => {
            asked += 1;
            return new Map();
          },
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
                name: "sees-code",
                in: "runner",
                command: ["cat", "marker.txt"],
              },
            ],
          }),
        }),
      );

      await writeFile(join(repo, "uncommitted.txt"), "x\n");
      expect((await stack.runGate()).failedStep).toBe("worktree-clean");
      expect(asked).toBe(0);
    },
    180_000,
  );
});
