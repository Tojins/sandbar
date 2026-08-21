// What PODMAN defines about `--init` (#42), asserted by running podman — the
// same argument gate-stack-podman.test.ts and ensure-images-podman.test.ts
// make. `sandboxRunArgs` in agent-sandbox.test.ts proves sandbar emits the flag
// it means to and puts it where podman will read it; only podman can prove that
// the flag actually changes who pid 1 is and that the new pid 1 reaps.
//
// The control half is the point of the file. An assertion that a sandbox
// carries no zombies is vacuous unless the orphan it plants would otherwise
// become one — a `sleep` that exits *before* its parent, an exec that never
// forked, a /proc read that finds nothing, all pass just as happily. So the
// same argv runs twice, once with `--init` filtered back out, and the pair
// pins the difference rather than the flag.
//
// Not merged into agent-sandbox.test.ts: that file is podman-free by design (it
// drives a fake provider against a real temp git repo), and this one needs a
// real podman and a real image.
//
// IT RUNS IN THE GATE (#52), in the `podman-test` step beside
// gate-stack-podman.test.ts and ensure-images-podman.test.ts, over the host's
// podman through the socket #48 mounted. #48 left it host-only on an explicit
// UNKNOWN rather than a measured difference — whether `--init` reaping observes
// the same way through a remote client was exactly the sort of thing this file
// exists to establish empirically rather than assume — and the measurement came
// back the same both ways.
//
// Unsurprising in hindsight, and the reason is written down rather than left to
// be re-derived: every assertion here is made INSIDE the target container, by
// `podman exec`ing a `/proc` read. Nothing in it depends on the caller's
// network namespace, its filesystem, or its signal handling. Those three are
// what keep work host-only elsewhere — the retired tcp readiness pair landed
// its publish on the host's loopback while the probe ran in the runner's pod
// netns, and gate-stack-hostpodman.test.ts pins the local client's own SIGTERM
// behaviour and the host session's systemd units. This file touches none of
// them.
//
// SO IT IS NO LONGER PART OF THE HUMAN'S STEP. #48 shrank that step from "run
// the full suite on the host" to three files; this leaves two,
// gate-stack-hostpodman.test.ts and sandbox-stack-podman.test.ts, each
// host-only because a remote client demonstrably does something else rather
// than because nobody looked. Prose describing that step is load-bearing in
// both directions: naming this file still sends a human to re-run what the gate
// now runs every attempt, and dropping either of the other two leaves its
// assertions exercised by nobody, with nothing saying so.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { scopedResourcePrefix } from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import {
  podmanTestScope,
  removeFixtureContainer,
} from "./podman-test-scope.test-util.js";
import { sandboxRunArgs } from "./agent-sandbox.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

// Any local image with a shell and a `sleep`. mariadb is what the other podman
// test files already require, so this file adds no new pull.
const IMAGE = "docker.io/library/mariadb:10.11";

// Resolved at COLLECTION time, not in beforeAll: vitest evaluates `runIf`
// while building the suite, so a flag set in a hook arrives too late and
// silently skips everything — a test file that always passes by never running.
//
// No `needsLocalClient`, which is the whole of the wiring change (#52): the
// `test` step's `**/*-podman.test.ts` exclude already misses this file, so
// naming it in `podman-test` is what runs it. Dropping the flag is also what
// makes `SANDBAR_REQUIRE_PODMAN_TESTS=1` reach these two tests — under it an
// unreachable podman is a failing test here rather than a silent skip, which is
// the point of putting the file in a step at all.
const available = podmanTestsEnabled({
  what: "agent-sandbox podman tests",
  image: IMAGE,
});

// Container names carry this process's SCOPE (#47), where they used to be a
// bare uuid. #47 audited this file and cleared it, correctly — the question it
// asked was COLLISION, and against a uuid the answer needs nothing from a
// scope. The debris report asks a different question:
// `findUnattributableResources` names every `sandbar-`-prefixed resource that
// fails `isScopedResourceName`, nothing sweeps it, and it repeats at every
// startup until an operator clears it by hand. `afterEach` removes these, so
// only a SIGKILL leaks one — and moving into the gate is precisely what changes
// those odds, from a human running the file occasionally to three runners on
// every cycle. With the scope carrying the uniqueness, the per-container part
// of the name is free to be the one thing a human reading debris wants from
// it: which of the two variants this was.
const { scope: SCOPE, cleanup } = podmanTestScope("agent-sandbox");

// This process's own scoped sweep, for whatever `afterEach` did not reach.
afterAll(async () => {
  if (available) await cleanup();
}, 120_000);

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe.runIf(available)("the sandbox container against real podman", () => {
  const started: string[] = [];

  afterEach(async () => {
    for (const name of started.splice(0)) {
      await removeFixtureContainer(name).catch(() => {});
    }
  }, 60_000);

  // The production argv, verbatim, with `--init` kept or filtered out — the
  // only axis this file has. Taking that axis rather than a list of flags to
  // drop is what lets the container's NAME state which variant it is without
  // the two being able to disagree: one argument decides both, so a leftover
  // `…-noinit` can only ever be a container that really was started without it.
  const start = async (init: "with-init" | "without-init"): Promise<string> => {
    const name = `${scopedResourcePrefix(SCOPE)}initprobe-${
      init === "with-init" ? "init" : "noinit"
    }`;
    const args = sandboxRunArgs({
      containerName: name,
      imageName: IMAGE,
      // Not the real sandbox paths: this image has neither, and `-w` is not
      // what is under test.
      workdir: "/tmp",
      env: {},
      volumeMounts: [],
      userns: "keep-id",
      containerUid: 1000,
      containerGid: 1000,
      networks: [],
      groups: [],
      devices: [],
      cpus: undefined,
    }).filter((a) => init === "with-init" || a !== "--init");
    started.push(name);
    await exec(RUNTIME, args);
    return name;
  };

  // Fork a process and let its parent exit first, exactly as a test runner's
  // browser or a build's worker does. The `podman exec` returns as soon as the
  // inner `sh` exits, leaving `sleep` orphaned and reparented to pid 1.
  const orphan = (name: string): Promise<unknown> =>
    exec(RUNTIME, ["exec", name, "sh", "-c", 'sh -c "sleep 1 & exit 0"']);

  // /proc, not `ps`: procps is not in every image, and `/proc/<pid>/stat` is
  // world-readable whatever uid the container runs as. Field 3 is the state
  // letter, and it follows the `)` that closes the comm field.
  const zombieCount = async (name: string): Promise<number> => {
    const { stdout } = await exec(RUNTIME, [
      "exec",
      name,
      "sh",
      "-c",
      "cat /proc/[0-9]*/stat",
    ]);
    return stdout.split("\n").filter((l) => /\)\s+Z\s/.test(l)).length;
  };

  // The control's claim — a zombie APPEARED — is satisfiable by waiting, so it
  // polls to a deadline instead of sleeping a fixed interval: it returns the
  // moment the orphan's `sleep 1` has exited and been left unreaped, and no
  // amount of contention between three concurrent gate stacks and one podman
  // can make it report early. Its mirror cannot be written this way and is not
  // — "none yet" and "none ever" are the same observation, so the `toBe(0)`
  // assertions keep the fixed settle below, which is what makes them mean
  // anything. Returns the last count rather than throwing, so a deadline that
  // does expire fails as the assertion it belongs to.
  const waitForZombie = async (name: string): Promise<number> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const n = await zombieCount(name);
      if (n > 0 || Date.now() >= deadline) return n;
      await delay(250);
    }
  };

  const pid1Comm = async (name: string): Promise<string> => {
    const { stdout } = await exec(RUNTIME, [
      "exec",
      name,
      "cat",
      "/proc/1/comm",
    ]);
    return stdout.trim();
  };

  it(
    "leaks a zombie per orphan when pid 1 is the sleep entrypoint",
    async () => {
      const name = await start("without-init");
      // The control's own premise: without --init, `sleep infinity` is pid 1.
      expect(await pid1Comm(name)).toBe("sleep");

      await orphan(name);
      expect(await waitForZombie(name)).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "reaps the same orphan under --init",
    async () => {
      const name = await start("with-init");
      // podman's init takes pid 1 and the entrypoint becomes its child; the
      // binary's comm has been both `catatonit` and `podman-init` across
      // versions, so what is asserted is that `sleep` is no longer pid 1.
      expect(await pid1Comm(name)).not.toBe("sleep");

      await orphan(name);
      // Fixed, and it has to be: nothing distinguishes "reaped" from "the
      // orphan has not exited yet" except having waited longer than it takes.
      // Comfortably over the orphan's own `sleep 1`.
      await delay(2500);
      expect(await zombieCount(name)).toBe(0);

      // And it keeps reaping — the count is monotonic without a reaper, so a
      // second orphan is what separates "reaped" from "hasn't arrived yet".
      await orphan(name);
      await delay(2500);
      expect(await zombieCount(name)).toBe(0);
    },
    60_000,
  );
});
