// The pure half of the sandbox stack (#44).
//
// Everything here decides what the sandbox stack IS before podman is involved:
// which containers it contains, which ports the anchor has to publish for it,
// and where the agent finds a sibling's log. The podman half — that a keep-id
// anchor can host a root joiner at all, that the joiner's low port is reachable
// from the agent as uid 1000, that a pod is refused outright — is in
// sandbox-stack-podman.test.ts, which is host-only.

import { describe, expect, it } from "vitest";

import { resolveGateStack } from "./config.js";
import {
  SANDBOX_LOG_MOUNT,
  sandboxContainers,
  sandboxLogPathFor,
  sandboxPublishPorts,
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
