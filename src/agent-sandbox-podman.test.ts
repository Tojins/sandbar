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
// It stays a HOST-ONLY file after #48, which gave the gate runner a podman over
// the host's socket and moved gate-stack-podman.test.ts and
// ensure-images-podman.test.ts into the gate with it. This file was never
// measured through that socket — whether `--init` reaping observes the same way
// through a remote client is exactly the sort of thing this file exists to
// establish empirically rather than assume — so it declares
// `needsLocalClient`, neither gate step names it, and it runs where it always
// ran: on the host, before trusting a cycle that touched this module's run
// args.
//
// SO IT IS HALF OF THE HUMAN'S STEP, not a footnote to it. #48 shrank that
// step from "run the full suite on the host" to two files, and this is one of
// them (gate-stack-hostpodman.test.ts is the other). Anything that describes
// the manual step as one file leaves these assertions exercised by nobody,
// with nothing saying so — which is #48's own failure mode moved into the
// handoff text.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import { removeFixtureContainer } from "./podman-test-scope.test-util.js";
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
// `needsLocalClient` is what makes "host-only" a property this FILE enforces
// rather than one that lives in a gate step's file list the file cannot see.
// Without it, host-only status is the accident of a glob in
// `sandbar.config.mjs` excluding `**/*-podman.test.ts` and a second step
// naming its two files by hand — two lists that can drift silently, which is
// how this file came to be in neither.
const available = podmanTestsEnabled({
  what: "agent-sandbox podman tests",
  image: IMAGE,
  needsLocalClient: true,
});

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe.runIf(available)("the sandbox container against real podman", () => {
  const started: string[] = [];

  afterEach(async () => {
    for (const name of started.splice(0)) {
      await removeFixtureContainer(name).catch(() => {});
    }
  }, 60_000);

  // The production argv, verbatim, minus whichever flags a test wants gone.
  const start = async (drop: readonly string[] = []): Promise<string> => {
    const name = `sandbar-initprobe-${randomUUID()}`;
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
    }).filter((a) => !drop.includes(a));
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
      const name = await start(["--init"]);
      // The control's own premise: without --init, `sleep infinity` is pid 1.
      expect(await pid1Comm(name)).toBe("sleep");

      await orphan(name);
      // Long enough for the orphan's own `sleep 1` to finish and for its exit
      // status to sit unreaped.
      await delay(2500);
      expect(await zombieCount(name)).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "reaps the same orphan under --init",
    async () => {
      const name = await start();
      // podman's init takes pid 1 and the entrypoint becomes its child; the
      // binary's comm has been both `catatonit` and `podman-init` across
      // versions, so what is asserted is that `sleep` is no longer pid 1.
      expect(await pid1Comm(name)).not.toBe("sleep");

      await orphan(name);
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
