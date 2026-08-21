// The sandbox stack without podman (#44).
//
// Two halves. The first decides what the stack IS before anything is created:
// which containers it contains, which ports the anchor has to publish for it,
// where the agent finds a sibling's log. The second drives `startSandboxStack`
// through the `SandboxStackDeps` seam, because the decisions worth pinning
// there are all decisions about FAILURES — D3's blame mapping above all — and
// no real podman produces those on demand.
//
// The podman half proper — that a keep-id anchor can host a root joiner at all,
// that the joiner's low port is reachable from the agent as uid 1000, that a
// pod is refused outright — is in sandbox-stack-podman.test.ts, which is
// host-only.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveGateStack } from "./config.js";
import { ContainerBringupError } from "./gate-stack.js";
import { runScope } from "./naming.js";
import {
  SANDBOX_LOG_MOUNT,
  type LogFollower,
  type SandboxStackDeps,
  sandboxContainers,
  sandboxLogPathFor,
  sandboxPublishPorts,
  startSandboxStack,
} from "./sandbox-stack.js";

const spec = (containers: Parameters<typeof resolveGateStack>[0]["containers"]) =>
  resolveGateStack({
    containers,
    steps: [{ name: "test", in: "app", command: ["npm", "test"] }],
  });

describe("sandboxContainers", () => {
  // The property the whole feature's cost story rests on: a consumer that
  // declares nothing gets nothing — no sibling, no publish, no log mount, no
  // prompt slot. Asserted on a REALISTIC stack rather than an empty one,
  // because the failure would be a filter that let everything through.
  it("is empty for a stack that declares no inSandbox container", () => {
    expect(
      sandboxContainers(
        spec([
          { name: "db", image: "mariadb", lifecycle: "issue" },
          { name: "app", image: "app", mountWorktree: "/app", hold: true },
        ]),
      ),
    ).toEqual([]);
  });

  it("selects exactly the declared subset, in declaration order", () => {
    const containers = sandboxContainers(
      spec([
        { name: "db", image: "mariadb", lifecycle: "issue", inSandbox: true },
        { name: "mail", image: "mailhog", lifecycle: "issue" },
        {
          name: "app",
          image: "app",
          mountWorktree: "/app",
          hold: true,
          inSandbox: true,
          postReadyCommands: [["sh", "-c", "httpd &"]],
        },
      ]),
    );
    expect(containers.map((c) => c.name)).toEqual(["db", "app"]);
  });

  // `lifecycle` answers a different question (whose failure a failed bringup
  // is), and the motivating consumer's application server is `attempt` and is
  // precisely what the agent needs to see. A subset keyed on lifecycle would
  // have selected the database and left the app behind.
  it("is not the lifecycle: 'issue' set", () => {
    const containers = sandboxContainers(
      spec([
        { name: "db", image: "mariadb", lifecycle: "issue" },
        {
          name: "app",
          image: "app",
          mountWorktree: "/app",
          hold: true,
          inSandbox: true,
          postReadyCommands: [["sh", "-c", "httpd &"]],
        },
      ]),
    );
    expect(containers.map((c) => c.name)).toEqual(["app"]);
    expect(containers.map((c) => c.lifecycle)).toEqual(["attempt"]);
  });
});

describe("sandboxPublishPorts", () => {
  // These go on the AGENT container, because podman refuses `-p` on a
  // `--network container:` joiner — so the derivation has to run before the
  // sandbox exists, over the resolved subset alone.
  it("collects the subset's tcp readiness ports", () => {
    const containers = sandboxContainers(
      spec([
        {
          name: "db",
          image: "mariadb",
          lifecycle: "issue",
          inSandbox: true,
          readiness: { kind: "tcp", port: 3306 },
        },
        {
          name: "mail",
          image: "mailhog",
          lifecycle: "issue",
          inSandbox: true,
          readiness: { kind: "tcp", port: 1025 },
        },
        { name: "app", image: "app", mountWorktree: "/app", hold: true },
      ]),
    );
    expect(sandboxPublishPorts(containers)).toEqual([3306, 1025]);
  });

  // A container probed by `log` or `exec` needs no host-side socket, so
  // publishing for it would open a host port nothing ever connects to.
  it("ignores readiness kinds that are not probed from the host", () => {
    const containers = sandboxContainers(
      spec([
        {
          name: "db",
          image: "mariadb",
          lifecycle: "issue",
          inSandbox: true,
          readiness: { kind: "exec", argv: ["mysqladmin", "ping"] },
        },
        {
          name: "app",
          image: "app",
          mountWorktree: "/app",
          hold: true,
          inSandbox: true,
          postReadyCommands: [["sh", "-c", "httpd &"]],
          readiness: { kind: "log", pattern: "ready" },
        },
      ]),
    );
    expect(sandboxPublishPorts(containers)).toEqual([]);
  });

  // A gate container that is NOT in the sandbox must not open a host port on
  // the agent container: the isolation argument is that the agent cannot reach
  // the stack its verdict is formed in, and a stray publish is a hole in it —
  // it would forward to whatever is listening in the AGENT's namespace, which
  // is a different service under the same number.
  it("ignores tcp readiness on containers outside the subset", () => {
    const containers = sandboxContainers(
      spec([
        {
          name: "db",
          image: "mariadb",
          lifecycle: "issue",
          readiness: { kind: "tcp", port: 3306 },
        },
        { name: "app", image: "app", mountWorktree: "/app", hold: true },
      ]),
    );
    expect(sandboxPublishPorts(containers)).toEqual([]);
  });

  it("is empty for an empty subset", () => {
    expect(sandboxPublishPorts([])).toEqual([]);
  });
});

describe("sandboxLogPathFor", () => {
  // Quoted verbatim in the implementer's prompt, so it is a path an agent is
  // told to `tail`. It must be under the directory the anchor mounts, or the
  // prompt names a file that does not exist.
  it("puts every sibling's log under the mounted directory", () => {
    expect(sandboxLogPathFor("db")).toBe(`${SANDBOX_LOG_MOUNT}/db.log`);
    expect(sandboxLogPathFor("app").startsWith(`${SANDBOX_LOG_MOUNT}/`)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// startSandboxStack, through the deps seam
// ---------------------------------------------------------------------------

describe("startSandboxStack (#44 D3)", () => {
  const SCOPE = runScope("/some/workdir");
  const ANCHOR = "sandbar-w0011223-anchor";
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "sandbar-sbxstack-unit-"));
  });
  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

  // A stack with one of each lifecycle, which is the motivating consumer's
  // shape: a database that depends only on image and env, and an application
  // server that mounts the worktree and runs the branch's own code.
  const twoLifecycles = () =>
    resolveGateStack({
      containers: [
        {
          name: "db",
          image: "mariadb",
          lifecycle: "issue",
          inSandbox: true,
          readiness: { kind: "tcp", port: 3306 },
        },
        {
          name: "app",
          image: "app",
          mountWorktree: "/app",
          inSandbox: true,
        },
      ],
      steps: [{ name: "test", in: "app", command: ["npm", "test"] }],
    });

  type Recorder = {
    readonly broughtUp: string[][];
    readonly labels: string[];
    readonly removed: string[];
    readonly followed: string[];
    readonly deps: SandboxStackDeps;
  };

  const recorder = (
    fail: (name: string) => ContainerBringupError | Error | null = () => null,
  ): Recorder => {
    const broughtUp: string[][] = [];
    const labels: string[] = [];
    const removed: string[] = [];
    const followed: string[] = [];
    const deps: SandboxStackDeps = {
      bringUp: async (containers, ctx) => {
        broughtUp.push(containers.map((c) => c.name));
        labels.push(ctx.label);
        for (const c of containers) {
          const err = fail(c.name);
          if (err) throw err;
        }
      },
      portBindings: async () => new Map([[3306, 44719]]),
      remove: async (name) => {
        removed.push(name);
        return null;
      },
      follow: (name): LogFollower => {
        followed.push(name);
        return { stop: () => {} };
      },
    };
    return { broughtUp, labels, removed, followed, deps };
  };

  const start = (r: Recorder) =>
    startSandboxStack(
      {
        issueId: "44",
        scope: SCOPE,
        spec: twoLifecycles(),
        worktreePath: "/wt",
        anchorContainerName: ANCHOR,
        logDir,
      },
      r.deps,
    );

  const bringupError = (name: string) =>
    new ContainerBringupError(
      `sandbar-x-sbx-44-${name}`,
      `sandbox stack: container '${name}' did not become ready within 60000ms`,
      "PHP Fatal error: syntax error, unexpected ';'",
    );

  // The bringup code is the GATE's, and its messages are the one string D3
  // hands a degraded sibling — rendered into the implementer's prompt right
  // under a paragraph saying the gate's stack is a namespace it cannot reach.
  // Told nothing, it would prefix every one of them `gate stack:` and read as a
  // red gate that never ran. This half is the telling; that the message uses
  // what it is told is pinned against a real podman next door.
  it("tells the shared bringup which stack it is", async () => {
    const r = recorder();
    await start(r);
    expect(r.labels).toEqual(["sandbox stack", "sandbox stack"]);
  });

  it("reports every declared sibling, with its address and log path", async () => {
    const r = recorder();
    const stack = await start(r);
    expect(stack.statuses).toEqual([
      {
        name: "db",
        image: "mariadb",
        lifecycle: "issue",
        address: "127.0.0.1:3306",
        logPath: `${SANDBOX_LOG_MOUNT}/db.log`,
        up: true,
        failure: null,
      },
      {
        name: "app",
        image: "app",
        lifecycle: "attempt",
        address: null,
        logPath: `${SANDBOX_LOG_MOUNT}/app.log`,
        up: true,
        failure: null,
      },
    ]);
    expect(r.followed).toEqual(["sandbar-" + SCOPE + "-sbx-44-db", "sandbar-" + SCOPE + "-sbx-44-app"]);
  });

  // D3, the infra half. A database that will not start depends only on image
  // and env, so nothing the agent can do changes the answer: it throws, the
  // runner takes HARD-ERROR, and the issue retries with a fresh sandbox.
  it("throws when an issue-lifecycle sibling will not start", async () => {
    const r = recorder((n) => (n === "db" ? bringupError(n) : null));
    await expect(start(r)).rejects.toThrow(/did not become ready/);
    // And it takes what it created with it rather than leaving the agent
    // container anchoring debris.
    expect(r.removed).toEqual([`sandbar-${SCOPE}-sbx-44-db`]);
  });

  // D3, the other half, and the one that is easy to get backwards. An app
  // server that will not boot is the BRANCH's own bootstrap failing, and the
  // agent is the only party that can fix it — so the sandbox comes up degraded
  // and the agent is told, rather than the issue spending two fresh-sandbox
  // retries to reproduce an error it could have read.
  it("comes up degraded when an attempt-lifecycle sibling will not start", async () => {
    const r = recorder((n) => (n === "app" ? bringupError(n) : null));
    const stack = await start(r);
    expect(stack.statuses.map((st) => [st.name, st.up])).toEqual([
      ["db", true],
      ["app", false],
    ]);
    // The log tail rides along, because that is the whole of what the agent
    // gets to act on.
    expect(stack.statuses[1]?.failure).toMatch(/PHP Fatal error/);
  });

  // "Degraded" has to mean the OTHER siblings still came up, and
  // `bringUpContainers` abandons the rest of its group on the first failure —
  // so the attempt subset goes up one container at a time while the issue
  // subset goes as a group.
  it("brings the attempt siblings up one at a time, the issue ones as a group", async () => {
    const spec = resolveGateStack({
      containers: [
        { name: "db", image: "mariadb", lifecycle: "issue", inSandbox: true },
        { name: "mail", image: "mailhog", lifecycle: "issue", inSandbox: true },
        { name: "app", image: "app", mountWorktree: "/app", inSandbox: true },
        { name: "web", image: "web", mountWorktree: "/w", inSandbox: true },
      ],
      steps: [{ name: "test", in: "app", command: ["npm", "test"] }],
    });
    const r = recorder((n) => (n === "app" ? bringupError(n) : null));
    const stack = await startSandboxStack(
      {
        issueId: "44",
        scope: SCOPE,
        spec,
        worktreePath: "/wt",
        anchorContainerName: ANCHOR,
        logDir,
      },
      r.deps,
    );
    expect(r.broughtUp).toEqual([["db", "mail"], ["app"], ["web"]]);
    expect(stack.statuses.map((st) => [st.name, st.up])).toEqual([
      ["db", true],
      ["mail", true],
      ["app", false],
      ["web", true],
    ]);
  });

  // The two lifecycle groups go up separately, which is an internal detail of
  // whose failure is whose — and the list this returns is read by an agent, in
  // its prompt, as a description of the stack the consumer wrote. Ordering it
  // by the bringup groups would show a `gateStack` nobody authored.
  it("reports the siblings in declaration order, not bringup order", async () => {
    const r = recorder();
    const stack = await startSandboxStack(
      {
        issueId: "44",
        scope: SCOPE,
        spec: resolveGateStack({
          containers: [
            { name: "app", image: "app", mountWorktree: "/app", inSandbox: true },
            { name: "db", image: "mariadb", lifecycle: "issue", inSandbox: true },
          ],
          steps: [{ name: "test", in: "app", command: ["npm", "test"] }],
        }),
        worktreePath: "/wt",
        anchorContainerName: ANCHOR,
        logDir,
      },
      r.deps,
    );
    expect(r.broughtUp).toEqual([["db"], ["app"]]);
    expect(stack.statuses.map((st) => st.name)).toEqual(["app", "db"]);
  });

  // Anything that is not a bringup failure is not a verdict about a container
  // at all — a podman that would not answer, a bug in this module — and
  // swallowing it into a "degraded" status would report a service as broken
  // when nothing about it is known.
  it("does not degrade on an error that is not a bringup failure", async () => {
    const r = recorder((n) => (n === "app" ? new Error("podman went away") : null));
    await expect(start(r)).rejects.toThrow("podman went away");
  });

  // The path in the prompt is quoted to an agent that will follow it, so a
  // container that never came up needs a file that explains itself rather than
  // an ENOENT that reads as sandbar having lost the log.
  it("leaves a readable log file for a sibling that did not come up", async () => {
    const r = recorder((n) => (n === "app" ? bringupError(n) : null));
    await start(r);
    const written = await readFile(join(logDir, "app.log"), "utf8");
    expect(written).toMatch(/did not come up/);
    expect(written).toMatch(/PHP Fatal error/);
    // And it is followed anyway. The commonest degraded shape is a container
    // that started and then missed its readiness, so it keeps logging for the
    // rest of the issue — and the prompt tells the agent this file says why.
    // Frozen at the placeholder, that is a lie the agent cannot check.
    expect(r.followed).toEqual([
      `sandbar-${SCOPE}-sbx-44-db`,
      `sandbar-${SCOPE}-sbx-44-app`,
    ]);
  });

  // The log directory is per ISSUE, so a HARD-ERROR retry's containers write
  // into the files the previous sandbox left. Truncating would throw away the
  // only record of what the run did before it restarted — which is exactly the
  // record an operator reads to find out why it restarted.
  it("appends the placeholder rather than truncating an earlier sandbox's log", async () => {
    await writeFile(join(logDir, "app.log"), "earlier sandbox: boot, then OOM\n");
    const r = recorder((n) => (n === "app" ? bringupError(n) : null));
    await start(r);
    const written = await readFile(join(logDir, "app.log"), "utf8");
    expect(written).toMatch(/earlier sandbox: boot, then OOM/);
    expect(written).toMatch(/did not come up/);
  });

  // A name is claimed BEFORE the container is created, because one that
  // started and then failed readiness still has to be removed and nothing out
  // here can tell that apart from one that never started. The cost of the
  // other choice is a container holding a worktree mount for the rest of the
  // run.
  it("removes every claimed sibling on stop, including one that never came up", async () => {
    const r = recorder((n) => (n === "app" ? bringupError(n) : null));
    const stack = await start(r);
    await stack.stop();
    expect(r.removed).toEqual([
      `sandbar-${SCOPE}-sbx-44-app`,
      `sandbar-${SCOPE}-sbx-44-db`,
    ]);
    // Idempotent: the inner loop's finally and the cleanup registry both call
    // it, and a second pass would report a leak for containers it removed
    // itself.
    await stack.stop();
    expect(r.removed).toHaveLength(2);
  });

  // What leaks here is a running container holding a worktree mount, and the
  // next scoped sweep does not run on the last cycle or on a halt — so the
  // operator gets the names and the command.
  it("reports a sibling it could not remove, with a command that clears it", async () => {
    const r = recorder();
    const deps: SandboxStackDeps = {
      ...r.deps,
      remove: async (name) => `  podman rm -f -t 0 ${name}\n    timed out`,
    };
    const stack = await startSandboxStack(
      {
        issueId: "44",
        scope: SCOPE,
        spec: twoLifecycles(),
        worktreePath: "/wt",
        anchorContainerName: ANCHOR,
        logDir,
      },
      deps,
    );
    await expect(stack.stop()).rejects.toThrow(
      new RegExp(`Clean up with: podman rm -f -t 0 .*sbx-44-app.*sbx-44-db`),
    );
  });
});
