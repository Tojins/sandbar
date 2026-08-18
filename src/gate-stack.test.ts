import { describe, expect, it } from "vitest";

import {
  type GateStackConfig,
  type ResolvedGateStack,
  type ResolvedStackContainer,
  resolveGateStack,
  resolveImages,
} from "./config.js";
import {
  buildArgv,
  checkWorktreeImageUids,
  effectiveUidArgv,
} from "./ensure-images.js";
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
  servesWorktree: false,
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

  // #29: the check above asks only whether SOMETHING mounts the worktree, and
  // this stack satisfies it while every step runs in a container that cannot
  // see the branch. Same verdict for every commit, green included — verbatim
  // the failure that check's own message claims to prevent. Reachable by
  // moving the mount to the wrong container during a refactor, after which
  // every run passes.
  it("refuses a stack where the worktree mount is on a container no step enters", () => {
    expect(() =>
      resolveGateStack({
        containers: [
          { name: "db", image: "mariadb", mountWorktree: "/w" },
          { name: "runner", image: "node", hold: true },
        ],
        steps: [{ name: "test", in: "runner", command: ["npm", "test"] }],
      }),
    ).toThrow(/servesWorktree/);
  });

  // The shape the obvious tightening ("every step's container must mount the
  // worktree") would have over-rejected: an app serving the branch's code over
  // 127.0.0.1 to a playwright container that needs no mount of its own. It is
  // byte-identical to the stack above except in intent, so intent is what the
  // consumer states.
  it("accepts the serve-over-loopback shape when the server declares it", () => {
    expect(() =>
      resolveGateStack({
        containers: [
          { name: "app", image: "app", mountWorktree: "/app", servesWorktree: true },
          { name: "playwright", image: "pw", hold: true },
        ],
        steps: [{ name: "e2e", in: "playwright", command: ["npx", "playwright", "test"] }],
      }),
    ).not.toThrow();
  });

  // A false answer to the one question the rule asks is worse than no answer.
  it("refuses servesWorktree on a container that mounts nothing", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          { name: "app", image: "app", mountWorktree: "/app", hold: true },
          { name: "liar", image: "x", servesWorktree: true },
        ],
      }),
    ).toThrow(/servesWorktree/);
  });

  // `hold` is `sleep infinity` and nothing is exec'd after readiness, so this
  // container provably runs nothing at all — the one form of the declaration
  // that is decidably false rather than merely unlikely.
  it("refuses servesWorktree + hold with no postReadyCommands", () => {
    expect(() =>
      resolveGateStack({
        containers: [
          {
            name: "app",
            image: "app",
            mountWorktree: "/app",
            hold: true,
            servesWorktree: true,
          },
          { name: "pw", image: "pw", hold: true },
        ],
        steps: [{ name: "e2e", in: "pw", command: ["true"] }],
      }),
    ).toThrow(/postReadyCommands/);
  });

  // …but a held container CAN serve, because postReadyCommands are exec'd into
  // it after readiness and one that backgrounds a daemon leaves it serving.
  // That is the only route for an image whose ENTRYPOINT is not a shell.
  it("accepts servesWorktree + hold when a postReadyCommand starts the server", () => {
    expect(() =>
      resolveGateStack({
        containers: [
          {
            name: "app",
            image: "app",
            mountWorktree: "/app",
            hold: true,
            servesWorktree: true,
            postReadyCommands: [["sh", "-c", "cd /app && nohup npm start &"]],
          },
          { name: "pw", image: "pw", hold: true },
        ],
        steps: [{ name: "e2e", in: "pw", command: ["true"] }],
      }),
    ).not.toThrow();
  });

  // D5 defines `issue` as depending only on image + env, which is why its
  // bringup failure is infra and costs two HARD-ERROR retries. A worktree mount
  // makes it depend on branch code, so a branch that breaks its startup is
  // blamed on the environment. `mounts` is what an issue container uses when it
  // only needs fixture files from the worktree.
  it("refuses lifecycle 'issue' on a container that boots its own entrypoint over the worktree", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          {
            name: "db",
            image: "mariadb",
            lifecycle: "issue",
            mountWorktree: "/w",
          },
          { name: "app", image: "app", mountWorktree: "/app", hold: true },
        ],
      }),
    ).toThrow(/lifecycle 'issue'/);
  });

  // The rule reaches exactly as far as its argument does. Under `hold` the
  // entrypoint is `sleep infinity`, so nothing of the branch's runs at bringup
  // and `issue` is honest — and it is the only home for per-issue setup, since
  // postReadyCommands run once per container and an `attempt` container is
  // recreated on every gate run.
  it("accepts lifecycle 'issue' on a held container that mounts the worktree", () => {
    expect(() =>
      resolveGateStack({
        containers: [
          {
            name: "runner",
            image: "app",
            lifecycle: "issue",
            mountWorktree: "/w",
            hold: true,
            postReadyCommands: [["composer", "install", "--no-interaction"]],
          },
        ],
        steps: [{ name: "test", in: "runner", command: ["vendor/bin/phpunit"] }],
      }),
    ).not.toThrow();
  });

  // Issue #29's reproducer verbatim. It trips the lifecycle rule too, so this
  // pins WHICH error it gets: the reachability one, the only one that names the
  // reported symptom. Fixing the lifecycle first would just hand the consumer a
  // config that throws the other error on the next run.
  it("reports the reachability failure, not the lifecycle one, for #29's config", () => {
    expect(() =>
      resolveGateStack({
        containers: [
          { name: "db", image: "mariadb", mountWorktree: "/w", lifecycle: "issue" },
          { name: "runner", image: "node", hold: true },
        ],
        steps: [{ name: "test", in: "runner", command: ["npm", "test"] }],
      }),
    ).toThrow(/servesWorktree/);
  });

  // podman's -v spec is colon-delimited with no escape. `mounts` was checked
  // for this from the start; mountWorktree — the one every valid stack has, and
  // therefore the most-travelled spec sandbar builds — was not.
  it("refuses a colon in mountWorktree", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [{ name: "app", image: "a", mountWorktree: "/ap:p" }],
      }),
    ).toThrow(/colon-delimited/);
  });

  it("refuses mounting the worktree at /", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [{ name: "app", image: "a", mountWorktree: "/" }],
      }),
    ).toThrow(/shadow/);
  });

  // Resolved against the worktree, so "" is the worktree ROOT — the whole tree
  // bind-mounted somewhere nobody asked for, silently.
  it("refuses an empty mount hostPath", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          {
            name: "app",
            image: "a",
            mountWorktree: "/app",
            mounts: [{ hostPath: "", containerPath: "/seed.sql" }],
          },
        ],
      }),
    ).toThrow(/empty.*hostPath/i);
  });

  it("refuses a relative mount containerPath", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          {
            name: "app",
            image: "a",
            mountWorktree: "/app",
            mounts: [{ hostPath: "seed.sql", containerPath: "rel/seed.sql" }],
          },
        ],
      }),
    ).toThrow(/must be absolute/);
  });

  // Pod members share a network namespace, so only one of them can be
  // listening — and one publish would report BOTH ready as soon as either
  // binds, re-opening the green-on-red TCP_SETTLE_MS exists to close.
  it("refuses two containers with the same tcp readiness port", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          {
            name: "app",
            image: "a",
            mountWorktree: "/app",
            readiness: { kind: "tcp", port: 3306 },
          },
          { name: "db", image: "b", readiness: { kind: "tcp", port: 3306 } },
        ],
      }),
    ).toThrow(/both declare tcp readiness on port 3306/);
  });

  it("allows the same tcp port to reappear once the other container is gone", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          {
            name: "app",
            image: "a",
            mountWorktree: "/app",
            readiness: { kind: "tcp", port: 3306 },
          },
          { name: "db", image: "b", readiness: { kind: "tcp", port: 5432 } },
        ],
      }),
    ).not.toThrow();
  });

  it("refuses an empty postReadyCommand", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          {
            name: "app",
            image: "a",
            mountWorktree: "/app",
            postReadyCommands: [["migrate"], []],
          },
        ],
      }),
    ).toThrow(/empty postReadyCommand/);
  });

  // sandbar applies CI=true last, so a consumer value would be silently lost.
  it("refuses a container that sets the reserved CI env key", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          {
            name: "app",
            image: "a",
            mountWorktree: "/app",
            env: { CI: "false" },
          },
        ],
      }),
    ).toThrow(/reserved env key/);
  });

  // The uniqueness rule exists so the failing step is identifiable in the
  // trace, and "test" and "test " render identically there.
  it("refuses step names that differ only in whitespace", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        steps: [
          { name: "test", in: "app", command: ["a"] },
          { name: "test ", in: "app", command: ["b"] },
        ],
      }),
    ).toThrow(/duplicate step name/);
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

// #24 D3. A worktree-mounting container cannot use `--userns=keep-id` (podman
// refuses it alongside `--pod`) and `--user 1000:1000` maps to a subuid, so the
// image must run as root or as the host uid. Getting this wrong does not fail
// at bringup — it fails as a silent EACCES mid-gate, which is why the check is
// a preflight refusal, and why it needs to be pinned.
describe("checkWorktreeImageUids", () => {
  const stackWith = (
    containers: readonly {
      name: string;
      image: string;
      mountWorktree?: string;
    }[],
  ): ResolvedGateStack =>
    resolveGateStack({
      containers: containers.map((c) => ({ ...c, hold: true })),
      steps: [{ name: "test", in: containers[0]!.name, command: ["true"] }],
    });

  const oneMounter = stackWith([
    { name: "app", image: "app:gate", mountWorktree: "/app" },
  ]);

  it("builds the uid argv with --entrypoint, not a trailing command", () => {
    // `run --rm <image> id -u` passes `id -u` as ARGUMENTS to the image's own
    // ENTRYPOINT, which answers a different question — or none. The whole
    // check rests on this argv.
    expect(effectiveUidArgv("mariadb:10.11")).toEqual([
      "run",
      "--rm",
      "--entrypoint",
      "id",
      "mariadb:10.11",
      "-u",
    ]);
  });

  it("accepts root — rootless podman maps it to the invoking user", async () => {
    await expect(
      checkWorktreeImageUids(oneMounter, 1000, async () => 0),
    ).resolves.toBeUndefined();
  });

  it("accepts an image already aligned to the host uid", async () => {
    await expect(
      checkWorktreeImageUids(oneMounter, 1000, async () => 1000),
    ).resolves.toBeUndefined();
  });

  it("refuses any other uid, naming the container and the fix", async () => {
    await expect(
      checkWorktreeImageUids(oneMounter, 1000, async () => 1001),
    ).rejects.toThrow(/uid 1001.*neither root.*nor the host uid \(1000\)/s);
    await expect(
      checkWorktreeImageUids(oneMounter, 1000, async () => 1001),
    ).rejects.toThrow(/'app'/);
  });

  // Widening the check to every image would hard-halt every run whose mariadb
  // happens to run as uid 999 and never touches the tree.
  it("ignores images behind containers that do not mount the worktree", async () => {
    const stack = stackWith([
      { name: "app", image: "app:gate", mountWorktree: "/app" },
      { name: "db", image: "mariadb:10.11" },
    ]);
    const probed: string[] = [];
    await checkWorktreeImageUids(stack, 1000, async (image) => {
      probed.push(image);
      return 0;
    });
    expect(probed).toEqual(["app:gate"]);
  });

  it("probes each distinct image once, however many containers use it", async () => {
    const stack = stackWith([
      { name: "app", image: "app:gate", mountWorktree: "/app" },
      { name: "worker", image: "app:gate", mountWorktree: "/worker" },
    ]);
    const probed: string[] = [];
    await checkWorktreeImageUids(stack, 1000, async (image) => {
      probed.push(image);
      return 0;
    });
    expect(probed).toEqual(["app:gate"]);
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
