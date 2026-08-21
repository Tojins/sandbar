// The podman facts a gate runner CANNOT pin, and why they are exactly these
// two (#48, #43).
//
// Every other podman-backed test in this repo runs inside the gate, which
// reaches the host's podman through a mounted socket. What does not survive
// that route is anything that is a property of the CLIENT or of the host's own
// session rather than of the container:
//
//   1. `podman exec` EXITS 0 WHEN THE CLIENT IS KILLED WITH SIGTERM, which is
//      the entire reason `boundedPodman` does its own timing instead of passing
//      node's `timeout:` option (#26). The remote client does not behave that
//      way, and production always drives a local one — so asserting it through
//      a socket would pin a different system from the one that ships.
//
//   2. `--health-cmd` WITH `--health-interval=disable` CREATES NO TRANSIENT
//      SYSTEMD TIMER (#43). That is the whole argument for sandbar scheduling
//      its own readiness polls rather than letting podman schedule the check:
//      a real interval needs a systemd user session the host may not have, and
//      the unit it creates is named by CONTAINER ID — outside the
//      `sandbar-<scope>-*` namespace the orphan sweep can reach, so a SIGKILLed
//      run would leak a timer nothing reaps that keeps firing at a container
//      that is gone. Reading it means reading the HOST's user session, and the
//      gate runner is a container with none.
//
// WHAT LEFT WITH #43. This file used to open with a third fact: tcp readiness
// probed a loopback publish from the HOST, so a bare `connect` succeeded
// against a pod with nothing listening and only a settle window told them
// apart. #43 retired the `tcp` kind, and with it the publish, the settle window
// and both of those tests. The property that replaces it — a dead port and a
// live one separating outright, because the rootless forwarder is not in the
// path — is asserted INSIDE the container, so it needs no local client and
// lives in gate-stack-podman.test.ts where the gate runs it every attempt. That
// is a strict improvement in coverage, not a relocation.
//
// Both remaining guards are the same guard: this file runs only when the client
// is LOCAL (`CONTAINER_HOST` unset). It therefore skips in the gate EVEN under
// `SANDBAR_REQUIRE_PODMAN_TESTS=1` — that flag is about a podman that should
// have answered and did not, and a remote client answering correctly is not
// that.
//
// THE MANUAL STEP IS THIS FILE, `agent-sandbox-podman.test.ts` AND
// `sandbox-stack-podman.test.ts`, all run on the host. #48 shrank it from "run
// the full suite before trusting a cycle that touched the podman layer" to that
// set, and the two beside this one are easy to forget precisely because their
// reasons are different. The second pins `--init` reaping an orphan the
// entrypoint would not, which was never measured through a socket rather than
// known to differ — the easiest of the three to lose, since its exclusion is
// incidental. The third (#44) is here for a reason closer to this file's own:
// it drives the production `sandboxRunArgs` — keep-id, uid 1000, `--init` — and
// then `podman exec`s into that container to assert the agent reaches its
// siblings, so it is a claim about the LOCAL client's own topology. All three
// declare `needsLocalClient`. Describe the step as one file and those
// assertions are exercised by nobody, with nothing saying so.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { stackContainerNameFor } from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import { podmanTestScope } from "./podman-test-scope.test-util.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

// The same image the rest of the podman suite requires, so this file adds no
// new pull: it has a shell and it runs as uid 0.
const IMAGE = "docker.io/library/mariadb:10.11";

// Collection time, not a hook — and `needsLocalClient`, which is what makes
// this file skip in the gate instead of failing there.
const available = podmanTestsEnabled({
  what: "gate-stack host-podman tests",
  image: IMAGE,
  needsLocalClient: true,
});

// Per PROCESS (#47): two copies of this file would otherwise compute identical
// container names, and `podman run --name` would collide.
const { scope: SCOPE, cleanup } = podmanTestScope("gate-stack-hostpodman");
const STACK_ID = "hostpodmantest";
const cName = (name: string): string =>
  stackContainerNameFor(SCOPE, STACK_ID, name);

// One file-level sweep. Guarded because it shells out to podman and there is
// none where `available` is false — nothing was created, so there is nothing to
// remove. Nothing reaps this scope if the process is SIGKILLed; the recovery
// command is in `podman-test-scope.test-util.ts`.
afterAll(async () => {
  if (available) await cleanup();
}, 120_000);

// Why `boundedPodman` does its own timing instead of passing node's `timeout:`
// option (#26). This is about PODMAN, not about node, and it was discovered by
// running it — which is the only reason the option looks safe in a diff. The
// sibling assertions (the in-container process surviving the client's death)
// hold under a remote client too and stayed in gate-stack-podman.test.ts.
describe.runIf(available)("podman exec under a killed local client", () => {
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
  // readiness probe a container reported ready, a hung postReadyCommand a
  // database reported seeded.
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
});

// Whether this host can answer the question at all. A box with no systemd user
// session trivially creates no timers, which would make the assertion below
// pass for the wrong reason AND make its control half — the container that
// SHOULD create one — fail. Both directions are wrong, so the file declines to
// answer rather than reporting either.
//
// Resolved at collection time for the same reason `available` is: a flag set in
// `beforeAll` arrives after vitest has already decided what to register.
const hasUserSystemd = ((): boolean => {
  if (!available) return false;
  try {
    execFileSync("systemctl", ["--user", "list-timers", "--no-pager"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    console.warn(
      "skipping the healthcheck systemd-timer test: no systemd user session " +
        "on this host, so the control half (a real --health-interval DOES " +
        "create a timer) could not be exercised and the assertion would be " +
        "vacuous.",
    );
    return false;
  }
})();

// #43 D1. `--health-interval=disable` alongside `--health-cmd` designs the
// systemd dependency OUT rather than probing for it, and this is the assertion
// that says so.
//
// THE CONTROL HALF CARRIES THE WEIGHT. "No timer named after this container"
// passes on any host where podman never creates timers at all, where systemd
// names units differently, or where the listing is empty for an unrelated
// reason. The container run WITH an interval is what proves the observation
// works, so the negative one means something.
describe.runIf(hasUserSystemd)("healthcheck scheduling", () => {
  const SCHEDULED = cName("hctimer");
  const UNSCHEDULED = cName("hcnotimer");

  // The full container id, which is what podman names the transient unit after
  // — and the reason a leaked timer is outside every namespace #28's scope can
  // sweep. Not truncated: systemd only ellipsizes for a terminal, and this is
  // read through a pipe.
  const idOf = async (name: string): Promise<string> =>
    (await exec(RUNTIME, ["inspect", "--format", "{{.Id}}", name])).stdout.trim();

  const userTimers = async (): Promise<string> =>
    (await exec("systemctl", ["--user", "list-timers", "--all", "--no-pager"]))
      .stdout;

  beforeEach(async () => {
    for (const n of [SCHEDULED, UNSCHEDULED]) {
      await exec(RUNTIME, ["rm", "-f", "-t", "0", n]).catch(() => {});
    }
  }, 60_000);

  afterEach(async () => {
    // `rm` is also what removes the transient unit podman created, so this is
    // cleanup of two things rather than one.
    for (const n of [SCHEDULED, UNSCHEDULED]) {
      await exec(RUNTIME, ["rm", "-f", "-t", "0", n]).catch(() => {});
    }
  }, 60_000);

  it(
    "an interval creates a transient timer; `disable` creates none",
    async () => {
      // Control: a real interval, which is what sandbar deliberately never
      // passes. Without this half the assertion below is vacuous.
      await exec(RUNTIME, [
        "run", "-d",
        "--name", SCHEDULED,
        "--health-cmd", JSON.stringify(["true"]),
        "--health-interval=2s",
        IMAGE, "sleep", "infinity",
      ]);
      expect(await userTimers()).toContain(await idOf(SCHEDULED));

      // Exactly what `healthCheckArgs` emits. M2/M9: with a `--health-cmd`
      // present, `disable` suppresses the unit entirely — and `.Config` still
      // carries the probe, so `podman healthcheck run` works on demand.
      await exec(RUNTIME, [
        "run", "-d",
        "--name", UNSCHEDULED,
        "--health-cmd", JSON.stringify(["true"]),
        "--health-interval=disable",
        IMAGE, "sleep", "infinity",
      ]);
      expect(await userTimers()).not.toContain(await idOf(UNSCHEDULED));

      // The probe is registered even though nothing schedules it — otherwise
      // "no timer" would be true of a container with no healthcheck at all,
      // which is not the claim.
      await exec(RUNTIME, ["healthcheck", "run", UNSCHEDULED]);
    },
    180_000,
  );
});
