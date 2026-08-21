// The podman facts a gate runner CANNOT pin, and why they are exactly these
// three (#48).
//
// Every other podman-backed test in this repo now runs inside the gate, which
// reaches the host's podman through a mounted socket. Two facts do not survive
// that route, and both fail in the direction that matters — one goes red, the
// other goes green for the wrong reason:
//
//   1. TCP READINESS IS PROBED FROM THE HOST, through a loopback-only publish
//      on the pod. Under the socket the pod publishes on the real host's
//      loopback while the process probing it sits in the gate runner's own
//      network namespace, so the probe can never connect. The positive half
//      ("a real listener goes green") fails outright; the negative half — the
//      settle window's green-on-red, the sharpest assertion in the whole podman
//      suite — PASSES VACUOUSLY, because bringup fails for a reason that has
//      nothing to do with the settle window. A test that certifies a mechanism
//      it cannot exercise is worse than no test, which is why the pair moved
//      together rather than only the one that went red.
//
//   2. `podman exec` EXITS 0 WHEN THE CLIENT IS KILLED WITH SIGTERM, which is
//      the entire reason `boundedPodman` does its own timing instead of passing
//      node's `timeout:` option (#26). The remote client does not behave that
//      way, and production always drives a local one — so asserting it through
//      a socket would pin a different system from the one that ships.
//
// Both guards are the same guard: this file runs only when the client is LOCAL
// (`CONTAINER_HOST` unset). It therefore skips in the gate EVEN under
// `SANDBAR_REQUIRE_PODMAN_TESTS=1` — that flag is about a podman that should
// have answered and did not, and a remote client answering correctly is not
// that.
//
// THE MANUAL STEP IS THIS FILE AND `agent-sandbox-podman.test.ts`, both run on
// the host. #48 shrank it from "run the full suite before trusting a cycle
// that touched the podman layer" to those two, and the second one is easy to
// forget precisely because its reason is different: it pins `--init` reaping
// an orphan the entrypoint would not, which was never measured through a
// socket rather than known to differ. It declares `needsLocalClient` for the
// same reason this file does. Describe the step as one file and those
// assertions are exercised by nobody, with nothing saying so.
//
// WHAT DELIBERATELY DID NOT MOVE. The test that carried fact (1)'s positive
// half also asserted that an `issue` container keeps its id and its state
// across gate runs while the `attempt` container is recreated — a fact the
// socket preserves perfectly, and one an `ok`-only assertion cannot see. It was
// split rather than moved: the tcp assertions are here, the container-identity
// ones stayed in gate-stack-podman.test.ts with an `exec` readiness probe,
// which needs no host-side connect. The moved set is a genuine minimum.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveGateStack } from "./config.js";
import { type Stack, startStack } from "./gate-stack.js";
import { stackContainerNameFor } from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import { podmanTestScope } from "./podman-test-scope.test-util.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

// The same image the rest of the podman suite requires, so this file adds no
// new pull: it has a shell, it runs as uid 0, and it serves a real TCP listener
// for the positive half of fact (1).
const IMAGE = "docker.io/library/mariadb:10.11";

// Collection time, not a hook — and `needsLocalClient`, which is what makes
// this file skip in the gate instead of failing there.
const available = podmanTestsEnabled({
  what: "gate-stack host-podman tests",
  image: IMAGE,
  needsLocalClient: true,
});

// Per PROCESS (#47): two copies of this file would otherwise compute identical
// pod, network and container names, and `startStack` force-removes a namesake
// before creating one.
const { scope: SCOPE, cleanup } = podmanTestScope("gate-stack-hostpodman");
const STACK_ID = "hostpodmantest";
const cName = (name: string): string =>
  stackContainerNameFor(SCOPE, STACK_ID, name);

afterAll(async () => {
  if (available) await cleanup();
}, 120_000);

describe.runIf(available)("tcp readiness against a real pod", () => {
  let repo: string;
  let stack: Stack | null = null;

  const git = (...args: string[]) => exec("git", args, { cwd: repo });

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "sandbar-hoststack-"));
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await writeFile(join(repo, "marker.txt"), "v1\n");
    await git("add", "-A");
    await git("commit", "-qm", "init");
  }, 60_000);

  afterEach(async () => {
    if (stack) await stack.stop();
    stack = null;
    await rm(repo, { recursive: true, force: true });
  }, 60_000);

  // The green-on-red the settle window exists for: rootless podman's port
  // forwarder accepts the connection at the host and asks the backend
  // afterwards, so a bare `connect` succeeds against a pod with nothing
  // listening inside. Only a probe that requires the socket to STAY open can
  // tell them apart — and only a host-side probe can run this at all.
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

  // The other half of the same fact, and the reason the negative one above is
  // not simply "tcp readiness never passes": a real listener DOES go green,
  // through the ephemeral loopback publish, within the container's budget.
  it(
    "tcp readiness goes green on a real listener",
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
          // The whole point of one namespace: the consumer writes 127.0.0.1 as
          // a literal, because with a pod it is an address it can know at
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
      // Bringup returning at all is the tcp assertion; the query is what makes
      // it a claim about a LISTENER rather than about the probe giving up.
      const { stdout } = await exec(RUNTIME, [
        "exec",
        cName("db"),
        "mariadb",
        "-h",
        "127.0.0.1",
        "-uroot",
        "-e",
        "SELECT 1",
      ]);
      expect(stdout).toContain("1");
    },
    240_000,
  );
});

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
});
