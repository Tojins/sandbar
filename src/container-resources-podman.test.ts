// What Podman and the host kernel define for #141: a running ROOTLESS
// container's inspect record names a cgroup whose host-side `memory.peak`
// exists and contains bytes. The unit table proves Sandbar builds and parses
// those reads; only a real container can prove the path is usable.
//
// This is local-client-only. A remote Podman returns the remote host's cgroup
// path, while this process can read only its own filesystem. It therefore
// self-skips in Sandbar's socket-backed gate and without Podman, and runs in
// the documented host-side Podman pass.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { memoryPeakPath, parseContainerState } from "./container-resources.js";
import { scopedResourcePrefix } from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import { podmanTestScope } from "./podman-test-scope.test-util.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);
const IMAGE = "docker.io/library/mariadb:10.11";
const available = podmanTestsEnabled({
  what: "container resource podman tests",
  image: IMAGE,
  needsLocalClient: true,
});
const rootless = (process.getuid?.() ?? 0) !== 0;
const { scope: SCOPE, cleanup } = podmanTestScope("container-resources");

afterAll(async () => {
  if (available) await cleanup();
}, 120_000);

describe.runIf(available && rootless)("container resource cgroup evidence", () => {
  it("finds memory.peak for a running rootless container", async () => {
    const name = `${scopedResourcePrefix(SCOPE)}peak-${randomUUID()}`;
    try {
      await exec(RUNTIME, [
        "run", "-d", "--name", name, "--image-volume=ignore",
        "--entrypoint", "sleep", IMAGE, "infinity",
      ]);
      const inspected = await exec(RUNTIME, [
        "inspect", "--format", "{{.State.CgroupPath}}\n{{.State.OOMKilled}}", name,
      ]);
      const state = parseContainerState(inspected.stdout);
      expect(state.cgroupPath).toBeTruthy();
      const path = memoryPeakPath(state.cgroupPath ?? "");
      expect(path).not.toBeNull();
      expect((await readFile(path!, "utf8")).trim()).toMatch(/^\d+$/);
    } finally {
      await exec(RUNTIME, ["rm", "-f", "-v", "-t", "0", name]).catch(() => undefined);
    }
  }, 120_000);
});
