// The sandbox stack's podman facts (#44), and why they are host-only.
//
// Everything the design of #44 turns on is a claim about podman, and each one
// deletes a branch of the design if it goes the other way. They were settled by
// running podman rather than by reading its documentation, and the same is true
// of this file: it is the only place the anchor chain is exercised end to end.
//
// WHY IT DOES NOT RUN IN THE GATE. The gate runner reaches podman through a
// mounted socket (#48), and two of the assertions below are about the LOCAL
// client's topology:
//
//   - the `tcp` readiness probe connects to a loopback publish on the HOST,
//     while a gate runner sits in its own network namespace and can never
//     reach it. That is the same reason gate-stack-hostpodman.test.ts is
//     host-only, and it fails the same way: the positive half goes red and the
//     negative half would pass vacuously;
//   - `podman exec` into the anchor is how "the agent can reach its sibling on
//     127.0.0.1" is asserted, and the anchor is created here with
//     `sandboxRunArgs` — the production argv, `--init` and keep-id included —
//     which is the pairing agent-sandbox-podman.test.ts was left host-only for.
//
// So this file declares `needsLocalClient` and skips in the gate even under
// SANDBAR_REQUIRE_PODMAN_TESTS=1: that flag is about a podman that should have
// answered and did not, and a remote client answering correctly is not that.
// CLAUDE.md's list of files a human runs on the host before trusting a cycle
// that touched this layer names this one.
//
// THE CONTROL HALF IS NOT OPTIONAL. The first test asserts that `--pod` and
// `--userns=keep-id` are REFUSED together. Without it, nothing in the suite
// records why the sandbox is an anchor chain instead of a pod, and the next
// refactor "simplifies" it into a pod — at which point the agent runs as root,
// `claude --dangerously-skip-permissions` refuses to start, and the loop stops
// working entirely for a reason no test names.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { sandboxRunArgs } from "./agent-sandbox.js";
import { resolveGateStack } from "./config.js";
import { sandboxContainerNameFor } from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import { podmanTestScope } from "./podman-test-scope.test-util.js";
import { RUNTIME } from "./runtime.js";
import { type SandboxStack, startSandboxStack } from "./sandbox-stack.js";

const exec = promisify(execFile);

// The image the rest of the podman suite already requires. It earns its place
// three times over here: it has a shell and a `sleep` that accepts `infinity`
// (so it can stand in for the AGENT container, whose entrypoint is exactly
// that), it runs as root (so it is a legitimate stand-in for a gate container
// behind `mountWorktree`), and it ships a client the anchor can reach its
// sibling with.
const IMAGE = "docker.io/library/mariadb:10.11";

// The one fact `IMAGE` cannot pin, and the reason a second image is worth a
// pull. The privileged-port bind (below) needs a server that binds :80 as ROOT,
// and mariadb's entrypoint `gosu`s to the `mysql` user BEFORE it binds — so a
// `--port=80` there fails on a dropped capability rather than on the namespace
// question this is about, which is the worst kind of red. httpd binds as root
// and drops afterwards, which is exactly the shape the motivating consumer's
// apache has.
const LOW_PORT_IMAGE = "docker.io/library/httpd:2.4-alpine";

const available = podmanTestsEnabled({
  what: "sandbox-stack podman tests",
  image: IMAGE,
  needsLocalClient: true,
});

// Asked separately rather than folded into `available`, so a host that has not
// pulled httpd still runs the other four facts and is TOLD, by name and with
// the pull command, which one it is not running. Same policy function, so the
// gate's `needsLocalClient` skip still comes first.
const lowPortAvailable =
  available &&
  podmanTestsEnabled({
    what: "sandbox-stack privileged-port test",
    image: LOW_PORT_IMAGE,
    needsLocalClient: true,
  });

const { scope: SCOPE, cleanup } = podmanTestScope("sandbox-stack-podman");
const ISSUE_ID = "sbxtest";

afterAll(async () => {
  if (available) await cleanup();
}, 120_000);

describe.runIf(available)("the sandbox stack's anchor chain", () => {
  let repo: string;
  let logDir: string;
  let anchor: string;
  let stack: SandboxStack | null = null;

  const git = (...args: string[]) => exec("git", args, { cwd: repo });

  // The anchor is created with the PRODUCTION argv builder, not a hand-written
  // `podman run`. That is the point of the file: `sandboxRunArgs` is what an
  // agent sandbox actually runs, so a flag that turns out to be incompatible
  // with hosting joiners has to fail here rather than in a cycle.
  const startAnchor = async (publishPorts: number[]): Promise<string> => {
    const name = `sandbar-${SCOPE}-anchor-${Math.abs(publishPorts[0] ?? 0)}`;
    await exec(RUNTIME, ["rm", "-f", "-t", "0", "--depend", name]).catch(() => {});
    await exec(
      RUNTIME,
      sandboxRunArgs({
        containerName: name,
        imageName: IMAGE,
        workdir: "/",
        env: {},
        volumeMounts: [],
        userns: "keep-id",
        containerUid: 1000,
        containerGid: 1000,
        networks: [],
        publishPorts,
        groups: [],
        devices: [],
        cpus: undefined,
      }),
    );
    return name;
  };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "sandbar-sbxstack-"));
    logDir = await mkdtemp(join(tmpdir(), "sandbar-sbxlogs-"));
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await writeFile(join(repo, "marker.txt"), "v1\n");
    await git("add", "-A");
    await git("commit", "-qm", "init");
    anchor = "";
  }, 60_000);

  afterEach(async () => {
    if (stack) await stack.stop().catch(() => {});
    stack = null;
    if (anchor) {
      await exec(RUNTIME, ["rm", "-f", "-t", "0", "--depend", anchor]).catch(
        () => {},
      );
    }
    await rm(repo, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  }, 120_000);

  // FACT 1 + 3, the control half. Both spellings of "put the sandbox in a pod"
  // are refused, and they are refused differently: the flag combination outright
  // (fact 1), and — since `pod create --userns=keep-id` DOES exist — the
  // resulting pod by being unable to host an image that needs its own root
  // (fact 3). Only the first is cheap enough to assert here; asserting it at
  // all is what stops the chain being read as a stylistic preference.
  it(
    "podman refuses --pod together with --userns=keep-id",
    async () => {
      const podName = `sandbar-${SCOPE}-pod-refusal`;
      await exec(RUNTIME, ["pod", "rm", "-f", "-t", "0", podName]).catch(() => {});
      await exec(RUNTIME, ["pod", "create", "--name", podName]);
      try {
        await expect(
          exec(RUNTIME, [
            "run",
            "-d",
            "--name",
            `${podName}-member`,
            "--pod",
            podName,
            "--userns=keep-id:uid=1000,gid=1000",
            "--entrypoint",
            "sleep",
            IMAGE,
            "infinity",
          ]),
        ).rejects.toThrow(/userns.*pod|pod.*userns/i);
      } finally {
        await exec(RUNTIME, ["pod", "rm", "-f", "-t", "0", podName]).catch(
          () => {},
        );
      }
    },
    180_000,
  );

  // FACT 5, end to end, and the whole design in one assertion: a keep-id anchor
  // running as uid 1000 hosts an ordinary rootless-root joiner; readiness is
  // probed from the HOST through the anchor's own publish (podman refuses `-p`
  // on a joiner, so that publish can only live on the anchor); and the agent —
  // as uid 1000, from inside the anchor — reaches the sibling on 127.0.0.1.
  //
  // The `SELECT 1` is what makes it a claim about a LISTENER the agent can use
  // rather than about bringup having returned.
  it(
    "a keep-id anchor hosts a root joiner the agent reaches on 127.0.0.1",
    async () => {
      anchor = await startAnchor([3306]);
      stack = await startSandboxStack({
        issueId: ISSUE_ID,
        scope: SCOPE,
        spec: resolveGateStack({
          containers: [
            {
              name: "db",
              image: IMAGE,
              lifecycle: "issue",
              inSandbox: true,
              env: { MYSQL_ALLOW_EMPTY_PASSWORD: "yes", MYSQL_DATABASE: "app" },
              readiness: { kind: "tcp", port: 3306 },
              readinessTimeoutMs: 120_000,
            },
            { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
          ],
          steps: [{ name: "ok", in: "runner", command: ["true"] }],
        }),
        worktreePath: repo,
        anchorContainerName: anchor,
        logDir,
      });

      expect(stack.statuses.map((s) => ({ name: s.name, up: s.up }))).toEqual([
        { name: "db", up: true },
      ]);
      // Only the declared subset is created — the gate's `runner` is not the
      // agent's business, and the agent must not be able to reach the stack its
      // verdict is formed in.
      await expect(
        exec(RUNTIME, [
          "container",
          "exists",
          sandboxContainerNameFor(SCOPE, ISSUE_ID, "runner"),
        ]),
      ).rejects.toThrow();

      // From INSIDE the anchor, as the agent sees it. `podman exec` without
      // `--user` runs as the container's configured user, which is the
      // keep-id 1000 the sandbox runs the agent as.
      const { stdout } = await exec(RUNTIME, [
        "exec",
        anchor,
        "mariadb",
        "-h",
        "127.0.0.1",
        "-uroot",
        "-e",
        "SELECT 1",
      ]);
      expect(stdout).toContain("1");

      // D4: the sibling's log is on the host, under the directory the anchor
      // mounts read-only. An agent debugging a 500 with no log would be a
      // regression against the 163-line script this replaces.
      const log = await readFile(join(logDir, "db.log"), "utf8");
      expect(log.length).toBeGreaterThan(0);
    },
    300_000,
  );

  // The half `IMAGE` cannot pin: a joiner binding a PRIVILEGED port inside a
  // namespace owned by the ANCHOR's user namespace. It is not a curiosity —
  // the motivating consumer's apache binds :80 — and it is not obviously true,
  // because CAP_NET_BIND_SERVICE is evaluated against the user namespace that
  // OWNS the netns, which under keep-id is not the joiner's own.
  //
  // Bringup returning is the whole assertion: a `tcp` readiness only goes green
  // when the socket stays open past the settle window, which is precisely how
  // the gate tells a real listener from the rootless forwarder's accept-then-
  // close (gate-stack-hostpodman.test.ts pins that separately).
  it.runIf(lowPortAvailable)(
    "a root joiner binds a privileged port inside the anchor's namespace",
    async () => {
      anchor = await startAnchor([80]);
      stack = await startSandboxStack({
        issueId: ISSUE_ID,
        scope: SCOPE,
        spec: resolveGateStack({
          containers: [
            {
              name: "web",
              image: LOW_PORT_IMAGE,
              inSandbox: true,
              readiness: { kind: "tcp", port: 80 },
              readinessTimeoutMs: 60_000,
            },
            { name: "runner", image: IMAGE, mountWorktree: "/work", hold: true },
          ],
          steps: [{ name: "ok", in: "runner", command: ["true"] }],
        }),
        worktreePath: repo,
        anchorContainerName: anchor,
        logDir,
      });

      expect(stack.statuses.map((s) => ({ name: s.name, up: s.up }))).toEqual([
        { name: "web", up: true },
      ]);
    },
    300_000,
  );

  // D3's uid rule, which the pod's D3 states and the chain inherits unchanged:
  // container ROOT under rootless podman maps to the invoking user, so a joiner
  // that writes the bind-mounted worktree produces files the agent (uid 1000,
  // keep-id) and the host both own. `--user 1000:1000` on a joiner would map to
  // a subuid and fail, which is why `containerRunArgs` passes neither flag.
  it(
    "a joiner writes the shared worktree as the invoking user",
    async () => {
      anchor = await startAnchor([]);
      stack = await startSandboxStack({
        issueId: ISSUE_ID,
        scope: SCOPE,
        spec: resolveGateStack({
          containers: [
            {
              name: "app",
              image: IMAGE,
              mountWorktree: "/work",
              hold: true,
              inSandbox: true,
              postReadyCommands: [
                ["sh", "-c", "echo from-the-sibling > /work/sibling.txt"],
              ],
            },
          ],
          steps: [{ name: "ok", in: "app", command: ["true"] }],
        }),
        worktreePath: repo,
        anchorContainerName: anchor,
        logDir,
      });

      expect(stack.statuses[0]?.up).toBe(true);
      const written = await stat(join(repo, "sibling.txt"));
      expect(written.uid).toBe(process.getuid?.() ?? 0);
    },
    300_000,
  );

  // The chain's second mechanical tax, and the reason the inner loop's teardown
  // order is not a preference: removing the anchor destroys the namespace under
  // its joiners, so podman refuses to do it at all while one is attached. Get
  // the order backwards and the leak is the WHOLE chain, not half of it.
  it(
    "podman refuses to remove the anchor while a joiner is attached",
    async () => {
      anchor = await startAnchor([]);
      stack = await startSandboxStack({
        issueId: ISSUE_ID,
        scope: SCOPE,
        spec: resolveGateStack({
          containers: [
            {
              name: "app",
              image: IMAGE,
              mountWorktree: "/work",
              hold: true,
              inSandbox: true,
              postReadyCommands: [["true"]],
            },
          ],
          steps: [{ name: "ok", in: "app", command: ["true"] }],
        }),
        worktreePath: repo,
        anchorContainerName: anchor,
        logDir,
      });

      await expect(
        exec(RUNTIME, ["rm", "-f", "-t", "0", anchor]),
      ).rejects.toThrow(/depend/i);

      // Joiners first, and then the anchor goes.
      await stack.stop();
      stack = null;
      await expect(
        exec(RUNTIME, [
          "container",
          "exists",
          sandboxContainerNameFor(SCOPE, ISSUE_ID, "app"),
        ]),
      ).rejects.toThrow();
      await exec(RUNTIME, ["rm", "-f", "-t", "0", anchor]);
      anchor = "";
    },
    300_000,
  );

  // The backstop for every path the ordering cannot cover — a SIGKILL between
  // the two removals, a stack whose `stop` threw. `sandbox.close()` and the
  // orphan sweep both pass `--depend` for exactly this, and a no-op on a
  // container with no dependants is what makes it free for consumers that
  // declare no sandbox container.
  it(
    "--depend removes the anchor and its joiners together",
    async () => {
      anchor = await startAnchor([]);
      stack = await startSandboxStack({
        issueId: ISSUE_ID,
        scope: SCOPE,
        spec: resolveGateStack({
          containers: [
            {
              name: "app",
              image: IMAGE,
              mountWorktree: "/work",
              hold: true,
              inSandbox: true,
              postReadyCommands: [["true"]],
            },
          ],
          steps: [{ name: "ok", in: "app", command: ["true"] }],
        }),
        worktreePath: repo,
        anchorContainerName: anchor,
        logDir,
      });

      await exec(RUNTIME, ["rm", "-f", "-t", "0", "--depend", anchor]);
      const joiner = sandboxContainerNameFor(SCOPE, ISSUE_ID, "app");
      await expect(exec(RUNTIME, ["container", "exists", joiner])).rejects.toThrow();
      stack = null;
      anchor = "";
    },
    300_000,
  );
});
