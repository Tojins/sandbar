// Gate-stack shard: the standalone gate's three accommodations (#45), against
// real podman. The family header — why these run against a real podman and why
// the suite is sharded — is gate-stack-podman.test-util.ts's.
//
// All three are exceptions to rules the gate-stack module states elsewhere, so
// an `ok`-only assertion proves nothing about any of them: reuse has to be
// shown as the SAME CONTAINER surviving (an id, not a green gate), keep-alive
// as a pod that is still there after `stop()` returned, and the dirty-tree
// bypass as a step that read a file no commit contains. Each is also asserted
// in the negative, because the value of the feature is entirely in what it
// does NOT do in the other case.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveGateStack } from "./config.js";
import { type Stack, startStack } from "./gate-stack.js";
import {
  buildVariantImage,
  IMAGE,
} from "./gate-stack-podman.test-util.js";
import {
  networkNameFor,
  podNameFor,
  stackContainerNameFor,
} from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import { podmanTestScope } from "./podman-test-scope.test-util.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

// See podman-test-availability.test-util.ts for the collection-time rule and
// what `SANDBAR_REQUIRE_PODMAN_TESTS=1` changes.
const available = podmanTestsEnabled({
  what: "gate-stack standalone podman tests",
  image: IMAGE,
});

// Per PROCESS, not per file (#47) — see gate-stack-podman.test.ts.
const { scope: SCOPE, testImageTag, cleanup } = podmanTestScope(
  "gate-stack-standalone",
);

// One file-level sweep; nothing reaps this scope on SIGKILL — the recovery
// command is in `podman-test-scope.test-util.ts`.
afterAll(async () => {
  if (available) await cleanup();
}, 120_000);

describe.runIf(available)("standalone gate accommodations (#45)", () => {
  const GATE_STACK_ID = "gate45";
  const gName = (name: string): string =>
    stackContainerNameFor(SCOPE, GATE_STACK_ID, name);
  const podName = podNameFor(SCOPE, GATE_STACK_ID);
  const networkName = networkNameFor(SCOPE, GATE_STACK_ID);

  let repo: string;
  const git = (...args: string[]) => exec("git", args, { cwd: repo });

  const idOf = async (name: string): Promise<string | null> =>
    await exec(RUNTIME, ["inspect", "--format", "{{.Id}}", gName(name)])
      .then((r) => r.stdout.trim())
      .catch(() => null);

  // `keepAlive` makes `stop()` a no-op by design, so nothing but this removes
  // what these tests leave behind.
  const teardown = async (): Promise<void> => {
    await exec(RUNTIME, ["pod", "rm", "-f", "-t", "0", podName]).catch(() => {});
    await exec(RUNTIME, ["network", "rm", "-f", networkName]).catch(() => {});
  };

  const spec = () =>
    resolveGateStack({
      containers: [
        {
          name: "db",
          image: IMAGE,
          lifecycle: "issue",
          // Held, so the container is `sleep infinity` and comes up in a
          // second: what is under test is the reuse decision, not mariadb.
          hold: true,
          // One-shot setup, which a reused container deliberately does NOT
          // re-run — so the file's CONTENTS are how a recreate is told from a
          // reuse even if podman were to hand back an identical id.
          postReadyCommands: [["sh", "-c", "date +%s%N > /seeded"]],
        },
        { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
      ],
      steps: [
        { name: "read-marker", in: "runner", command: ["cat", "marker.txt"] },
      ],
    });

  beforeEach(async () => {
    await teardown();
    repo = await mkdtemp(join(tmpdir(), "sandbar-gate45-"));
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await writeFile(join(repo, "marker.txt"), "committed\n");
    await git("add", "-A");
    await git("commit", "-qm", "init");
  }, 60_000);

  afterEach(async () => {
    await teardown();
    await rm(repo, { recursive: true, force: true });
  }, 120_000);

  it(
    "keeps the stack up, then adopts its issue container on the same token and rebuilds it on a different one",
    async () => {
      const first = await startStack({
        stackId: GATE_STACK_ID,
        scope: SCOPE,
        worktreePath: repo,
        spec: spec(),
        reuseToken: "token-a",
        keepAlive: true,
        allowDirtyWorktree: true,
      });
      expect(first.reused).toEqual([]);
      expect((await first.runGate()).ok).toBe(true);
      const dbId = await idOf("db");
      const seeded = (
        await exec(RUNTIME, ["exec", gName("db"), "cat", "/seeded"])
      ).stdout.trim();
      expect(dbId).not.toBeNull();
      expect(seeded).not.toBe("");

      // `stop()` under `keepAlive` removes nothing. It is still called, still
      // idempotent, and still the thing the cleanup registry holds — it simply
      // has nothing to do, which is what makes a Ctrl-C keep the stack too.
      await first.stop();
      expect(await idOf("db")).toBe(dbId);

      // Same token: the pod is adopted rather than force-removed, the `issue`
      // container is the SAME container, and its postReadyCommands did not run
      // again — which is the whole speed win and also the only way a schema an
      // earlier invocation migrated survives.
      const second = await startStack({
        stackId: GATE_STACK_ID,
        scope: SCOPE,
        worktreePath: repo,
        spec: spec(),
        reuseToken: "token-a",
        keepAlive: true,
        allowDirtyWorktree: true,
      });
      expect(second.reused).toEqual(["db"]);
      expect(await idOf("db")).toBe(dbId);
      expect(
        (await exec(RUNTIME, ["exec", gName("db"), "cat", "/seeded"])).stdout.trim(),
      ).toBe(seeded);
      // And it still gates: the `attempt` container is recreated as always,
      // so an adopted stack is not a half-built one.
      expect((await second.runGate()).ok).toBe(true);
      await second.stop();

      // A different token is a config the running container no longer answers
      // to. The pod goes, and with it the container and its accumulated state —
      // which is the point: adopting it would gate against what an older config
      // described.
      const third = await startStack({
        stackId: GATE_STACK_ID,
        scope: SCOPE,
        worktreePath: repo,
        spec: spec(),
        reuseToken: "token-b",
        keepAlive: true,
        allowDirtyWorktree: true,
      });
      expect(third.reused).toEqual([]);
      expect(await idOf("db")).not.toBe(dbId);
      expect(
        (await exec(RUNTIME, ["exec", gName("db"), "cat", "/seeded"])).stdout.trim(),
      ).not.toBe(seeded);
      await third.stop();
    },
    600_000,
  );

  it(
    "tears the stack down when keepAlive is not asked for, and reuses nothing without a token",
    async () => {
      const stack = await startStack({
        stackId: GATE_STACK_ID,
        scope: SCOPE,
        worktreePath: repo,
        spec: spec(),
        reuseToken: "token-a",
        allowDirtyWorktree: true,
      });
      expect(await idOf("db")).not.toBeNull();
      await stack.stop();
      // The default is unchanged: `stop` removes the pod, its members and the
      // network. `--keep` is opt-in, so nothing about a run's teardown moved.
      expect(await idOf("db")).toBeNull();

      // No token at all — every stack inside a run — adopts nothing even when
      // a namesake pod is standing, because a pod with no recorded config is a
      // pod nothing can vouch for. (Here there is none, and the absence of a
      // token is what makes that unconditional.)
      const again = await startStack({
        stackId: GATE_STACK_ID,
        scope: SCOPE,
        worktreePath: repo,
        spec: spec(),
        allowDirtyWorktree: true,
      });
      expect(again.reused).toEqual([]);
      await again.stop();
    },
    600_000,
  );

  it(
    "gates the working tree when told to, and refuses it otherwise",
    async () => {
      // Uncommitted, and untracked: the commonest shape of D1's refusal is a
      // forgotten `git add`, and it is also the shape the standalone gate most
      // needs to be able to gate.
      await writeFile(join(repo, "marker.txt"), "uncommitted\n");
      await writeFile(join(repo, "extra.txt"), "new\n");

      const refusing = await startStack({
        stackId: GATE_STACK_ID,
        scope: SCOPE,
        worktreePath: repo,
        spec: spec(),
      });
      const red = await refusing.runGate();
      expect(red.ok).toBe(false);
      expect(red.failedStep).toBe("worktree-clean");
      expect(red.stderr).toContain("extra.txt");
      await refusing.stop();

      const allowing = await startStack({
        stackId: GATE_STACK_ID,
        scope: SCOPE,
        worktreePath: repo,
        spec: spec(),
        allowDirtyWorktree: true,
      });
      const green = await allowing.runGate();
      expect(green.ok).toBe(true);
      // Not merely "it did not refuse": the step read the UNCOMMITTED bytes,
      // which is what an operator running `sandbar gate` on work in progress
      // is asking about.
      expect(green.stdout).toContain("uncommitted");
      await allowing.stop();
    },
    600_000,
  );

  it(
    "tees each step's output as it arrives without disturbing the capture",
    async () => {
      const chunks: string[] = [];
      const stack = await startStack({
        stackId: GATE_STACK_ID,
        scope: SCOPE,
        worktreePath: repo,
        spec: resolveGateStack({
          containers: [
            { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
          ],
          steps: [
            {
              name: "chatty",
              in: "runner",
              command: ["sh", "-c", "echo out-line; echo err-line >&2"],
            },
          ],
        }),
        allowDirtyWorktree: true,
        onStepOutput: (c) => chunks.push(c),
      });
      const result = await stack.runGate();
      await stack.stop();

      expect(result.ok).toBe(true);
      const streamed = chunks.join("");
      // The banner is teed BEFORE the step runs, so a step that prints nothing
      // for minutes still names itself to whoever is watching.
      expect(streamed).toContain("== chatty (runner)");
      // Both streams reach the live view…
      expect(streamed).toContain("out-line");
      expect(streamed).toContain("err-line");
      // …and it is a TEE: every downstream reader still gets the complete
      // capture, because the gate trace, the D9 block and the cascade collapse
      // all read the buffer and none of them knows anyone was watching.
      expect(result.stdout).toContain("out-line");
      expect(result.stderr).toContain("err-line");
    },
    300_000,
  );

  // The combination that must not stand: `--keep` over a bringup that never
  // finished. The token is a pod label written at pod-CREATE time and the adopt
  // test is "podman says this container is running", so neither says the
  // previous invocation got to the end — and `bringUpContainers` starts every
  // container, then probes every one, then runs every `postReadyCommand`, so a
  // failure in the last loop leaves a container that is up, healthy, and
  // missing exactly the setup a reuse then declines to re-run.
  //
  // Modelled as the operator's own sequence, because that is what makes the
  // token match on the second invocation: the seed reads a file in the
  // worktree, so fixing it changes no config at all. With the wreckage kept,
  // the second call adopts `db`, skips its postReadyCommands because they are
  // "already done", and gates against a database that was never seeded.
  it(
    "does not keep — and so cannot adopt — a stack whose bringup never finished",
    async () => {
      const seedFlag = join(repo, "seed-flag");
      const seeding = () =>
        resolveGateStack({
          containers: [
            {
              name: "db",
              image: IMAGE,
              lifecycle: "issue",
              hold: true,
              mounts: [{ hostPath: "seed-flag", containerPath: "/seed-flag" }],
              postReadyCommands: [
                ["sh", "-c", "grep -q ok /seed-flag && date +%s%N > /seeded"],
              ],
            },
            { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
          ],
          steps: [
            { name: "read-marker", in: "runner", command: ["cat", "marker.txt"] },
          ],
        });

      await writeFile(seedFlag, "fail\n");
      const failed = await startStack({
        stackId: GATE_STACK_ID,
        scope: SCOPE,
        worktreePath: repo,
        spec: seeding(),
        reuseToken: "token-seed",
        keepAlive: true,
        allowDirtyWorktree: true,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect((failed as Error | null)?.message).toContain("postReadyCommand");
      // Torn down despite `keepAlive`: no pod to carry the token, and no
      // running container behind it. Both halves of the adopt test are gone,
      // which is the property — not that the pod happens to be missing.
      expect(await idOf("db")).toBeNull();
      await expect(
        exec(RUNTIME, ["pod", "exists", podName]),
      ).rejects.toBeTruthy();

      // The operator fixes the seed and reruns. Same config, so the same token
      // — the case a "the label matched, so it is ours" reuse gets wrong.
      await writeFile(seedFlag, "ok\n");
      const fixed = await startStack({
        stackId: GATE_STACK_ID,
        scope: SCOPE,
        worktreePath: repo,
        spec: seeding(),
        reuseToken: "token-seed",
        keepAlive: true,
        allowDirtyWorktree: true,
      });
      expect(fixed.reused).toEqual([]);
      // …and the seed the first invocation never got to has now run, which is
      // what `reused: []` is worth asserting FOR: an adopted container would
      // have skipped it and gated against an unseeded database.
      expect(
        (await exec(RUNTIME, ["exec", gName("db"), "cat", "/seeded"])).stdout.trim(),
      ).not.toBe("");
      await fixed.stop();
    },
    600_000,
  );
  // The reuse path's own image bookkeeping, which is where a spelling
  // difference can defeat the whole feature silently (#45).
  //
  // An adopted container's entry in `running.map` is read back off podman —
  // podman's rendering of a reference — while the value it is compared against
  // on the next gate run comes from the image resolver. Two authors, so the two
  // strings can name one image and differ: a normalising `localhost/` prefix is
  // enough. Believed as staleness, that recreates the very container `--keep`
  // was asked to preserve, re-runs its `postReadyCommands`, and says nothing —
  // once per invocation, forever.
  //
  // The difference is forced from the RESOLVER's side rather than by hoping
  // podman normalises, because whether it does is a version detail this test
  // must not depend on: two tags of one built image, one named by the
  // invocation that created the container and the other by the invocation that
  // adopts it. The property is the same either way — a difference in the string
  // is not a difference in the image.
  it(
    "does not recreate an adopted container because the image it runs is spelled differently",
    async () => {
      const variantA = testImageTag("reuse-variant");
      const variantB = testImageTag("reuse-variant-alias");
      await buildVariantImage(variantA);
      await exec(RUNTIME, ["tag", variantA, variantB]);

      const start = async (variant: string): Promise<Stack> =>
        await startStack({
          stackId: GATE_STACK_ID,
          scope: SCOPE,
          worktreePath: repo,
          spec: spec(),
          images: async () => new Map([[IMAGE, variant]]),
          reuseToken: "token-variant",
          keepAlive: true,
          allowDirtyWorktree: true,
        });

      // The first invocation puts `db` on the variant: `startStack` brings
      // issue containers up on the DECLARED image and the first gate run
      // recreates whatever the branch moved (#37), which is what leaves an
      // adopted container running something its config does not name.
      const first = await start(variantA);
      expect((await first.runGate()).ok).toBe(true);
      const dbId = await idOf("db");
      const seeded = (
        await exec(RUNTIME, ["exec", gName("db"), "cat", "/seeded"])
      ).stdout.trim();
      expect(dbId).not.toBeNull();
      await first.stop();

      // …and the second adopts it and must leave it alone, though it names that
      // image by its other tag.
      const second = await start(variantB);
      expect(second.reused).toEqual(["db"]);
      expect((await second.runGate()).ok).toBe(true);
      expect(await idOf("db")).toBe(dbId);
      // The id alone would be satisfied by podman handing an identical one
      // back; the seed is what says the container was never recreated.
      expect(
        (await exec(RUNTIME, ["exec", gName("db"), "cat", "/seeded"])).stdout.trim(),
      ).toBe(seeded);
      await second.stop();
    },
    600_000,
  );
});
