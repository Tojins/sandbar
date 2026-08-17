import { describe, expect, it } from "vitest";

import {
  type GateStackConfig,
  type ResolvedStackContainer,
  resolveGateStack,
  resolveImages,
} from "./config.js";
import { buildArgv } from "./ensure-images.js";
import {
  containerRunArgs,
  mountSpec,
  parsePortBindings,
  podCreateArgs,
  stepExecArgs,
  tcpProbePorts,
} from "./gate-stack.js";
import { SandbarError } from "./errors.js";

// The real adapters are the blind spot in an adapter scheme: a fake satisfies
// the contract no matter what argv the real one builds. These assert the argv.

const container = (
  over: Partial<ResolvedStackContainer> = {},
): ResolvedStackContainer => ({
  name: "app",
  image: "localhost/app:gate",
  lifecycle: "attempt",
  env: {},
  args: [],
  mounts: [],
  mountWorktree: null,
  hold: false,
  readiness: null,
  readinessTimeoutMs: 60_000,
  postReadyCommands: [],
  ...over,
});

// A flag's value, reading the LAST occurrence — podman keeps the final value
// for a repeated -e, so "reserved" means "emitted after the consumer's".
const lastEnv = (args: string[], key: string): string | undefined =>
  args
    .filter((a, i) => i > 0 && args[i - 1] === "-e" && a.startsWith(`${key}=`))
    .at(-1)
    ?.slice(key.length + 1);

describe("mountSpec", () => {
  it("resolves a relative hostPath against the gated worktree", () => {
    expect(
      mountSpec("/wt", {
        hostPath: "tests/fixtures/schema.sql",
        containerPath: "/docker-entrypoint-initdb.d/01.sql",
      }),
    ).toBe("/wt/tests/fixtures/schema.sql:/docker-entrypoint-initdb.d/01.sql:ro,z");
  });

  it("passes an absolute hostPath through", () => {
    expect(
      mountSpec("/wt", { hostPath: "/etc/hosts", containerPath: "/etc/hosts" }),
    ).toBe("/etc/hosts:/etc/hosts:ro,z");
  });

  // Category C of sandcastle's permissions taxonomy, and a live bug in the code
  // #24 replaced: without `z` the mount is denied outright under SELinux, so
  // sandbar's gate simply did not work on Fedora/RHEL/CentOS.
  it("always carries the SELinux relabel and read-only flags", () => {
    const spec = mountSpec("/wt", { hostPath: "a", containerPath: "/b" });
    expect(spec.endsWith(":ro,z")).toBe(true);
  });
});

describe("podCreateArgs", () => {
  it("attaches the pod to the per-stack network and carries the resolvers", () => {
    const args = podCreateArgs({
      podName: "sandbar-pod-42",
      networkName: "sandbar-net-42",
      publishPorts: [],
    });
    expect(args.slice(0, 6)).toEqual([
      "pod",
      "create",
      "--name",
      "sandbar-pod-42",
      "--network",
      "sandbar-net-42",
    ]);
    // #18: the network is --disable-dns, so external resolution has to come
    // from explicit resolvers. They live on the POD and members inherit them —
    // which is exactly what the anchor mechanism could not do cleanly.
    expect(args).toContain("--dns");
    expect(args).toContain("1.1.1.1");
    expect(args).toContain("8.8.8.8");
  });

  it("publishes each probe port on loopback with a podman-assigned host port", () => {
    const args = podCreateArgs({
      podName: "p",
      networkName: "n",
      publishPorts: [3306, 1025],
    });
    // Empty host port = podman picks a free one, so two concurrent stacks
    // cannot collide; 127.0.0.1 keeps it off-box.
    expect(args).toContain("127.0.0.1::3306");
    expect(args).toContain("127.0.0.1::1025");
  });

  it("publishes nothing when no container uses a tcp probe", () => {
    const args = podCreateArgs({ podName: "p", networkName: "n", publishPorts: [] });
    expect(args).not.toContain("-p");
  });
});

describe("tcpProbePorts", () => {
  const stack = (containers: ResolvedStackContainer[]) => ({
    containers,
    steps: [{ name: "s", in: "app", command: ["true"] }],
  });

  it("collects only tcp readiness ports", () => {
    expect(
      tcpProbePorts(
        stack([
          container({ name: "db", readiness: { kind: "tcp", port: 3306 } }),
          container({ name: "mail", readiness: { kind: "tcp", port: 1025 } }),
          container({ name: "x", readiness: { kind: "log", pattern: "ready" } }),
          container({ name: "y", readiness: null }),
        ]),
      ),
    ).toEqual([3306, 1025]);
  });

  it("deduplicates — a repeated -p would make `pod create` fail outright", () => {
    expect(
      tcpProbePorts(
        stack([
          container({ name: "a", readiness: { kind: "tcp", port: 8080 } }),
          container({ name: "b", readiness: { kind: "tcp", port: 8080 } }),
        ]),
      ),
    ).toEqual([8080]);
  });
});

describe("containerRunArgs", () => {
  const base = {
    containerName: "sandbar-42-app",
    podName: "sandbar-pod-42",
    worktreePath: "/wt",
  };

  it("joins the pod and names the container", () => {
    const args = containerRunArgs({ ...base, container: container() });
    expect(args.slice(0, 6)).toEqual([
      "run",
      "-d",
      "--name",
      "sandbar-42-app",
      "--pod",
      "sandbar-pod-42",
    ]);
  });

  // The pod is why: podman refuses `--userns` alongside `--pod`, and uid 1000
  // inside a pod maps to a subuid rather than to the invoking user.
  it("passes no --userns and no --user — neither works inside a pod", () => {
    const args = containerRunArgs({
      ...base,
      container: container({ mountWorktree: "/app" }),
    });
    expect(args.some((a) => a.startsWith("--userns"))).toBe(false);
    expect(args).not.toContain("--user");
  });

  it("mounts the worktree rw,z and makes it the working directory", () => {
    const args = containerRunArgs({
      ...base,
      container: container({ mountWorktree: "/app" }),
    });
    expect(args).toContain("/wt:/app:rw,z");
    expect(args[args.indexOf("-w") + 1]).toBe("/app");
  });

  it("omits the worktree mount when the container does not ask for one", () => {
    const args = containerRunArgs({ ...base, container: container() });
    expect(args.some((a) => a.includes("/wt:"))).toBe(false);
    expect(args).not.toContain("-w");
  });

  it("injects CI=true after the consumer's env, so it cannot be overridden", () => {
    const args = containerRunArgs({
      ...base,
      container: container({ env: { CI: "false", APP_ENV: "test" } }),
    });
    expect(lastEnv(args, "CI")).toBe("true");
    expect(lastEnv(args, "APP_ENV")).toBe("test");
  });

  it("puts image CMD args AFTER the image ref", () => {
    const args = containerRunArgs({
      ...base,
      container: container({
        image: "docker.io/library/mariadb:10.11",
        args: ["--sql-mode=NO_ENGINE_SUBSTITUTION"],
      }),
    });
    const imageIdx = args.indexOf("docker.io/library/mariadb:10.11");
    expect(imageIdx).toBeGreaterThan(-1);
    expect(args.slice(imageIdx + 1)).toEqual(["--sql-mode=NO_ENGINE_SUBSTITUTION"]);
  });

  // What makes a one-shot task runner an ordinary container rather than a
  // special case: hold it open and `exec` steps into it.
  it("holds a `hold` container open with sleep infinity", () => {
    const args = containerRunArgs({
      ...base,
      container: container({ image: "runner:gate", hold: true }),
    });
    expect(args.slice(-4)).toEqual([
      "--entrypoint",
      "sleep",
      "runner:gate",
      "infinity",
    ]);
  });

  it("labels the container so a label-based sweep can find it", () => {
    const args = containerRunArgs({ ...base, container: container() });
    expect(args[args.indexOf("--label") + 1]).toBe("sandbar=true");
  });
});

describe("stepExecArgs", () => {
  it("execs the command in the named container with CI set", () => {
    expect(stepExecArgs("sandbar-42-app", ["npm", "test"])).toEqual([
      "exec",
      "-e",
      "CI=true",
      "sandbar-42-app",
      "npm",
      "test",
    ]);
  });
});

describe("parsePortBindings", () => {
  it("maps container port to the host port podman assigned", () => {
    const m = parsePortBindings(
      '{"3306/tcp":[{"HostIp":"127.0.0.1","HostPort":"44719"}],' +
        '"1025/tcp":[{"HostIp":"127.0.0.1","HostPort":"33001"}]}',
    );
    expect(m.get(3306)).toBe(44719);
    expect(m.get(1025)).toBe(33001);
  });

  it("returns empty for a pod with no publishes", () => {
    expect(parsePortBindings("null").size).toBe(0);
    expect(parsePortBindings("").size).toBe(0);
    expect(parsePortBindings("{}").size).toBe(0);
  });

  it("skips malformed entries rather than inventing a port", () => {
    // A bogus mapping would send the readiness probe at an unrelated host
    // service and could read someone else's listener as this stack being ready.
    const m = parsePortBindings(
      '{"3306/tcp":[],"x/tcp":[{"HostPort":"1"}],"80/tcp":[{"HostPort":"nope"}]}',
    );
    expect(m.size).toBe(0);
  });
});

describe("buildArgv", () => {
  it("builds with the containerfile's directory as context", () => {
    expect(buildArgv({ tag: "t", containerfile: "gate/Containerfile.php" })).toEqual([
      "build",
      "-t",
      "t",
      "-f",
      "gate/Containerfile.php",
      "gate",
    ]);
  });

  it("builds with NO context when stdinContext is set", () => {
    // `-` is the whole point: a Containerfile that only pulls from a registry
    // needs no context, and tarring the repo up for it is pure latency.
    const args = buildArgv({
      tag: "t",
      containerfile: "gate/Containerfile.php",
      stdinContext: true,
    });
    expect(args).toEqual(["build", "-t", "t", "-"]);
    expect(args).not.toContain("-f");
  });

  it("passes buildArgs through verbatim — sandbar injects no magic ARG name", () => {
    expect(
      buildArgv({
        tag: "t",
        containerfile: "Containerfile",
        buildArgs: { AGENT_UID: "1000", AGENT_GID: "1000" },
      }),
    ).toEqual([
      "build",
      "-t",
      "t",
      "--build-arg",
      "AGENT_UID=1000",
      "--build-arg",
      "AGENT_GID=1000",
      "-f",
      "Containerfile",
      ".",
    ]);
  });
});

describe("resolveGateStack validation", () => {
  const ok: GateStackConfig = {
    containers: [
      { name: "db", image: "mariadb", lifecycle: "issue" },
      { name: "app", image: "app", mountWorktree: "/app", hold: true },
    ],
    steps: [{ name: "test", in: "app", command: ["npm", "test"] }],
  };

  it("accepts a well-formed stack", () => {
    expect(() => resolveGateStack(ok)).not.toThrow();
  });

  it("refuses an empty step list — it would report success for every commit", () => {
    expect(() => resolveGateStack({ ...ok, steps: [] })).toThrow(SandbarError);
  });

  it("refuses an empty container list", () => {
    expect(() => resolveGateStack({ ...ok, containers: [] })).toThrow(SandbarError);
  });

  // The verdict has to be about the code. Without a worktree mount the gate
  // returns the same answer for every commit — green included.
  it("refuses a stack where nothing mounts the worktree", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [{ name: "app", image: "app", hold: true }],
      }),
    ).toThrow(/mountWorktree/);
  });

  it("refuses a step targeting an undeclared container", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        steps: [{ name: "test", in: "nope", command: ["true"] }],
      }),
    ).toThrow(/not a declared container/);
  });

  it("refuses duplicate container names", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          { name: "app", image: "a", mountWorktree: "/app" },
          { name: "app", image: "b" },
        ],
      }),
    ).toThrow(/duplicate container name/);
  });

  it("refuses duplicate step names — the trace names the failing step", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        steps: [
          { name: "test", in: "app", command: ["a"] },
          { name: "test", in: "app", command: ["b"] },
        ],
      }),
    ).toThrow(/duplicate step name/);
  });

  // `hold` replaces the entrypoint, so args would land after `infinity` and be
  // silently ignored — the consumer's CMD arguments would vanish, not fail.
  it("refuses hold + args together", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          { name: "app", image: "a", mountWorktree: "/app", hold: true, args: ["x"] },
        ],
      }),
    ).toThrow(/hold/);
  });

  it("refuses a relative mountWorktree", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [{ name: "app", image: "a", mountWorktree: "app" }],
      }),
    ).toThrow(/absolute/);
  });

  // podman -v specs are colon-delimited with no escape, so a colon silently
  // re-splits the spec into different paths and options.
  it("refuses a colon in a mount path", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          {
            name: "app",
            image: "a",
            mountWorktree: "/app",
            mounts: [{ hostPath: "a:b", containerPath: "/c" }],
          },
        ],
      }),
    ).toThrow(/colon-delimited/);
  });

  it("refuses an out-of-range tcp readiness port", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          {
            name: "app",
            image: "a",
            mountWorktree: "/app",
            readiness: { kind: "tcp", port: 70000 },
          },
        ],
      }),
    ).toThrow(/out-of-range/);
  });

  // `Number(process.env.X)` on an unset var is NaN, which fails every
  // comparison — the readiness poll would spin forever holding the run's lock.
  it("refuses a NaN readinessTimeoutMs", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          { name: "app", image: "a", mountWorktree: "/app", readinessTimeoutMs: NaN },
        ],
      }),
    ).toThrow(/readinessTimeoutMs/);
  });

  it("refuses an invalid podman container name", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [{ name: "-bad", image: "a", mountWorktree: "/app" }],
      }),
    ).toThrow(/valid podman name/);
  });
});

describe("resolveImages", () => {
  it("defaults to building the sandbox image from ./Containerfile", () => {
    expect(resolveImages(undefined, "sandbar:app")).toEqual([
      { tag: "sandbar:app", containerfile: "Containerfile" },
    ]);
  });

  // The agent and the merger's resolve agent both run in the sandbox image;
  // sandbar builds only what `images` lists, so omitting it fails at the first
  // createSandbox — long after the run started.
  it("refuses an images list that does not build the sandbox image", () => {
    expect(() =>
      resolveImages([{ tag: "other:gate", containerfile: "Containerfile" }], "sandbar:app"),
    ).toThrow(/sandboxImage/);
  });

  it("refuses duplicate tags — the second build would overwrite the first", () => {
    expect(() =>
      resolveImages(
        [
          { tag: "sandbar:app", containerfile: "Containerfile" },
          { tag: "sandbar:app", containerfile: "Containerfile.other" },
        ],
        "sandbar:app",
      ),
    ).toThrow(/duplicate tag/);
  });
});
