import { describe, expect, it } from "vitest";

import {
  DEFAULT_STEP_TIMEOUT_MS,
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
  type BoundedResult,
  containerRunArgs,
  imageFor,
  withImages,
  containerState,
  formatHealthLog,
  healthCheckArgs,
  lastProbeText,
  mountSpec,
  parseHealthLog,
  podCreateArgs,
  type PodmanProbe,
  stepExecArgs,
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
        mode: "ro",
      }),
    ).toBe("/wt/tests/fixtures/schema.sql:/docker-entrypoint-initdb.d/01.sql:ro,z");
  });

  it("passes an absolute hostPath through", () => {
    expect(
      mountSpec("/wt", {
        hostPath: "/etc/hosts",
        containerPath: "/etc/hosts",
        mode: "ro",
      }),
    ).toBe("/etc/hosts:/etc/hosts:ro,z");
  });

  // Category C of sandcastle's permissions taxonomy, and a live bug in the code
  // #24 replaced: without `z` the mount is denied outright under SELinux, so
  // sandbar's gate simply did not work on Fedora/RHEL/CentOS. The relabel is
  // the half `mode` may NOT touch, so it is asserted on both modes rather than
  // on one. What an OMITTED mode means is not this function's question and is
  // not asserted here — `resolveGateStack` decides it, and pins it.
  it("always carries the SELinux relabel", () => {
    for (const mode of ["ro", "rw"] as const) {
      const spec = mountSpec("/wt", {
        hostPath: "a",
        containerPath: "/b",
        mode,
      });
      expect(spec.endsWith(`:${mode},z`)).toBe(true);
    }
  });

  // #48's motivating case: the gate runner identity-mounts the host's `/tmp`
  // so a step can build fixtures at paths the host's podman also resolves,
  // which is a mount written THROUGH rather than read. (The socket in the same
  // config is not — it stays `ro`.) The mode reaches the `-v` spec and takes
  // the relabel with it.
  it("emits rw for a mount that asked for it", () => {
    expect(
      mountSpec("/wt", { hostPath: "/tmp", containerPath: "/tmp", mode: "rw" }),
    ).toBe("/tmp:/tmp:rw,z");
  });
});

describe("podCreateArgs", () => {
  it("attaches the pod to the per-stack network and carries the resolvers", () => {
    const args = podCreateArgs({
      podName: "sandbar-pod-42",
      networkName: "sandbar-net-42",
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

  // Unconditional since #43: `tcp` readiness was the only thing that ever put
  // a `-p` on a gate pod, and the probe runs inside the container now. The
  // README's "publishes no fixed ports" lost its asterisk, and this is what
  // keeps it that way.
  it("publishes nothing at all", () => {
    const args = podCreateArgs({ podName: "p", networkName: "n" });
    expect(args).not.toContain("-p");
    expect(args.some((a) => a.includes("127.0.0.1::"))).toBe(false);
  });
});

// Both flags or neither (#43). `--health-interval=disable` is IGNORED without
// a `--health-cmd`, so emitting it alone would be the one configuration that
// schedules a transient systemd timer — the thing the pair exists to prevent.
describe("healthCheckArgs", () => {
  it("registers the probe as JSON argv with scheduling disabled", () => {
    expect(
      healthCheckArgs(
        container({
          readiness: {
            kind: "healthcheck",
            command: ["healthcheck.sh", "--connect"],
          },
        }),
      ),
    ).toEqual([
      "--health-cmd",
      '["healthcheck.sh","--connect"]',
      "--health-interval=disable",
    ]);
  });

  // JSON, so podman stores it as ["CMD", …] and runs it directly. A bare
  // string would be wrapped in CMD-SHELL and re-split by a shell, which is the
  // quoting dialect every other argv in this config avoids.
  it("does not let an argument with spaces become two arguments", () => {
    const args = healthCheckArgs(
      container({
        readiness: { kind: "healthcheck", command: ["sh", "-c", "a b || c"] },
      }),
    );
    expect(args[1]).toBe('["sh","-c","a b || c"]');
    expect(JSON.parse(args[1] as string)).toEqual(["sh", "-c", "a b || c"]);
  });

  it("emits neither flag for a container with no readiness", () => {
    expect(healthCheckArgs(container({ readiness: null }))).toEqual([]);
  });
});

describe("containerRunArgs", () => {
  const base = {
    containerName: "sandbar-42-app",
    attach: { kind: "pod", podName: "sandbar-pod-42" } as const,
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

  // The sandbox stack's topology (#44). Not a second builder: everything after
  // the attachment — env, mounts, the worktree, `hold` — is the same container
  // definition, and a copy would be the place the two silently diverge.
  it("joins an anchor's network namespace when told to", () => {
    const args = containerRunArgs({
      ...base,
      attach: { kind: "netns", anchorContainerName: "sandbar-w1-uuid" },
      container: container(),
    });
    expect(args.slice(0, 6)).toEqual([
      "run",
      "-d",
      "--name",
      "sandbar-42-app",
      "--network",
      "container:sandbar-w1-uuid",
    ]);
    // A publish belongs to the namespace and the namespace belongs to the
    // anchor, so podman refuses `-p` here outright — which since #43 costs the
    // chain nothing, there being no port to publish for anyone.
    expect(args).not.toContain("--pod");
    expect(args).not.toContain("-p");
  });

  // The joiner must write the worktree as the invoking user, which under
  // rootless podman is what container ROOT maps to — the same reason the pod's
  // members carry neither flag. `--userns=keep-id` is available outside a pod,
  // and using it here would map the container to uid 1000 and break every image
  // that needs its own root (the mariadb of #44's fact 3).
  it("passes no --userns and no --user to a netns joiner either", () => {
    const args = containerRunArgs({
      ...base,
      attach: { kind: "netns", anchorContainerName: "sandbar-w1-uuid" },
      container: container({ mountWorktree: "/app" }),
    });
    expect(args.some((a) => a.startsWith("--userns"))).toBe(false);
    expect(args).not.toContain("--user");
    expect(args).toContain("/wt:/app:rw,z");
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

  // #43. The flags have to land BEFORE the image ref, or podman reads them as
  // arguments to the image's own entrypoint — the same mistake `--entrypoint
  // id` exists to avoid in `checkWorktreeImageUids`.
  it("registers a readiness probe before the image ref", () => {
    const args = containerRunArgs({
      ...base,
      container: container({
        image: "docker.io/library/mariadb:10.11",
        readiness: { kind: "healthcheck", command: ["healthcheck.sh"] },
      }),
    });
    const imageIdx = args.indexOf("docker.io/library/mariadb:10.11");
    expect(args.indexOf("--health-cmd")).toBeGreaterThan(-1);
    expect(args.indexOf("--health-cmd")).toBeLessThan(imageIdx);
    expect(args.indexOf("--health-interval=disable")).toBeLessThan(imageIdx);
    expect(args[args.indexOf("--health-cmd") + 1]).toBe('["healthcheck.sh"]');
  });

  // Same placement rule for a held container, whose tail is
  // `--entrypoint sleep <image> infinity` — a health flag appended after that
  // would become an argument to `sleep`.
  it("registers a readiness probe before a held container's entrypoint", () => {
    const args = containerRunArgs({
      ...base,
      container: container({
        image: "runner:gate",
        hold: true,
        readiness: { kind: "healthcheck", command: ["true"] },
      }),
    });
    expect(args.slice(-4)).toEqual([
      "--entrypoint",
      "sleep",
      "runner:gate",
      "infinity",
    ]);
    expect(args.indexOf("--health-cmd")).toBeLessThan(args.length - 4);
  });

  it("registers no healthcheck for a container with no readiness", () => {
    const args = containerRunArgs({ ...base, container: container() });
    expect(args.some((a) => a.startsWith("--health"))).toBe(false);
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

// What the operator reads when a container never came ready (#43). The health
// log is podman's own record of what each probe SAW, which is the thing
// `podman healthcheck run`'s own output — the single word `unhealthy` — cannot
// tell anyone.
describe("parseHealthLog", () => {
  const LOG =
    '{"Status":"starting","FailingStreak":2,"Log":[' +
    '{"Start":"2026-08-21T09:42:40Z","End":"2026-08-21T09:42:40Z",' +
    '"ExitCode":1,"Output":"healthcheck connect failed"},' +
    '{"Start":"2026-08-21T09:42:46Z","End":"2026-08-21T09:42:46Z",' +
    '"ExitCode":0,"Output":""}]}';

  it("reads podman's recorded probe invocations in order", () => {
    const entries = parseHealthLog(LOG);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      start: "2026-08-21T09:42:40Z",
      exitCode: 1,
      output: "healthcheck connect failed",
    });
    expect(entries[1]?.exitCode).toBe(0);
  });

  // `.State.Health` is a zero-valued struct on a container with no check, and
  // `Log` is null on one that has never been probed. Neither is an error.
  it("returns nothing for a container that has no health record", () => {
    expect(parseHealthLog("null")).toEqual([]);
    expect(parseHealthLog("")).toEqual([]);
    expect(parseHealthLog('{"Status":"","FailingStreak":0,"Log":null}')).toEqual(
      [],
    );
  });

  // This runs while a ContainerBringupError is already being raised about
  // something else. That error is the diagnosis; losing it to a JSON parse
  // failure while assembling an addendum would be strictly worse than an error
  // with no health block.
  it("degrades to nothing rather than throwing on a shape it did not expect", () => {
    expect(parseHealthLog("{not json")).toEqual([]);
    expect(parseHealthLog("[1,2,3]")).toEqual([]);
    expect(parseHealthLog('{"Log":[null,7,{"ExitCode":"x"}]}')).toEqual([
      { start: "", exitCode: NaN, output: "" },
    ]);
  });
});

describe("formatHealthLog", () => {
  it("renders each probe with its recorded exit code and output", () => {
    const text = formatHealthLog([
      { start: "T1", exitCode: 1, output: "connect failed\n" },
      { start: "T2", exitCode: 0, output: "" },
    ]);
    expect(text).toContain("T1 exit 1");
    expect(text).toContain("connect failed");
    // An entry with no output must still be visible: "the probe ran and said
    // nothing" and "the probe did not run" are different facts.
    expect(text).toContain("T2 exit 0 (no output)");
  });

  it("renders nothing at all when there are no entries", () => {
    // The caller only adds a "Container health log" heading for a non-empty
    // string, so this is what keeps a heading from standing over nothing.
    expect(formatHealthLog([])).toBe("");
  });
});

// The `last probe:` slot of a readiness timeout. Three outcomes, and the third
// is the one that needs the test: a probe sandbar KILLED at the deadline is
// invisible to the health log, so the log's newest entry belongs to an earlier
// failure and rendering it describes something that did not happen.
describe("lastProbeText", () => {
  const failed = { start: "T1", exitCode: 1, output: "connect failed\n" };

  it("quotes the last recorded probe, not podman's `unhealthy`", () => {
    expect(lastProbeText([failed], "unhealthy", false)).toBe(
      "exit 1: connect failed",
    );
  });

  // An entry with an empty Output still says more than the client does — the
  // probe ran and returned a code.
  it("names the exit code when the probe recorded no output", () => {
    expect(
      lastProbeText([{ start: "T1", exitCode: 1, output: "" }], "x", false),
    ).toBe("exit 1, no output");
  });

  it("falls back to the client's detail when nothing was recorded", () => {
    expect(lastProbeText([], "no such container", false)).toBe(
      "no such container",
    );
    expect(lastProbeText([], "", false)).toBe("no probe was recorded");
  });

  // The blocking case. Polls 1..N fail fast and record entries; the service
  // then starts accepting and never answers, so probe N+1 hangs and is
  // SIGKILLed at the deadline, recording nothing. Reporting the stale entry
  // sends the operator to debug a connection error against a probe that in
  // fact stopped returning — the #31 misdirection rebuilt in its replacement.
  it("leads with the kill when the final probe was killed at the deadline", () => {
    const text = lastProbeText([failed], "probe did not return within 800ms and was killed", true);
    expect(text).toMatch(/^probe did not return within 800ms and was killed/);
    // The stale entry is context, and is labelled as previous rather than as
    // the verdict — dropping it would lose the only thing any probe ever said.
    expect(text).toContain("previous probe: exit 1: connect failed");
  });

  it("reports the kill even with no entries at all to fall back on", () => {
    expect(lastProbeText([], "", true)).toBe("probe was killed at the deadline");
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

describe("withImages / imageFor (#37)", () => {
  const c = (name: string, image: string): ResolvedStackContainer =>
    resolveGateStack({
      containers: [{ name, image, mountWorktree: "/w" }],
      steps: [{ name: "s", in: name, command: ["true"] }],
    }).containers[0]!;

  it("substitutes only the mapped image, and returns the SAME array when nothing maps", () => {
    const containers = [c("app", "app:base"), c("db", "mariadb")];
    // Identity on an empty map matters: it is the ordinary case, and the
    // stack compares mapped images to decide what to recreate.
    expect(withImages(containers, new Map())).toBe(containers);
    const mapped = withImages(containers, new Map([["app:base", "app:sb-x"]]));
    expect(mapped.map((x) => x.image)).toEqual(["app:sb-x", "mariadb"]);
    // Untouched entries are not copied, so nothing downstream can accidentally
    // depend on object identity changing.
    expect(mapped[1]).toBe(containers[1]);
  });

  it("maps by the DECLARED image, so two containers sharing one image both move", () => {
    const containers = [c("app", "app:base"), c("worker", "app:base")];
    const mapped = withImages(containers, new Map([["app:base", "app:sb-x"]]));
    expect(mapped.map((x) => x.image)).toEqual(["app:sb-x", "app:sb-x"]);
  });

  it("imageFor falls back to the declared image", () => {
    expect(imageFor(c("app", "app:base"), new Map())).toBe("app:base");
    expect(
      imageFor(c("app", "app:base"), new Map([["app:base", "app:sb-x"]])),
    ).toBe("app:sb-x");
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

  // #43 retired three readiness kinds. A consumer crossing this change has a
  // working config in front of them, so the only useful error names the
  // replacement — "unknown kind" would send them to read the type instead. The
  // break is loud and early: resolve time, before the lock.
  it("refuses each retired readiness kind with its translation", () => {
    const retired = [
      { kind: "tcp", port: 3306 },
      { kind: "log", pattern: "port: 3306" },
      { kind: "exec", argv: ["mariadb", "-e", "SELECT 1"] },
    ];
    for (const readiness of retired) {
      expect(() =>
        resolveGateStack({
          ...ok,
          containers: [
            {
              name: "app",
              image: "a",
              mountWorktree: "/app",
              readiness: readiness as never,
            },
          ],
        }),
      ).toThrow(
        new RegExp(`retired '${readiness.kind}' readiness kind[\\s\\S]*healthcheck`),
      );
    }
  });

  // The `log` message must not read as a mechanical rename. Retiring it is a
  // statement that the log was never the right question — a pattern lifted
  // verbatim into `sh -c` is a different wrong probe, not a translation.
  it("tells a `log` consumer to write the probe the pattern stood in for", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          {
            name: "app",
            image: "a",
            mountWorktree: "/app",
            readiness: { kind: "log", pattern: "ready" } as never,
          },
        ],
      }),
    ).toThrow(/NOT a mechanical translation/);
  });

  it("refuses a readiness kind it does not recognise at all", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          {
            name: "app",
            image: "a",
            mountWorktree: "/app",
            readiness: { kind: "http", url: "/health" } as never,
          },
        ],
      }),
    ).toThrow(/unknown readiness kind/);
  });

  // Checked like every other argv in this config: `--health-cmd '[]'`
  // registers a probe that can never pass, and the container then spends its
  // whole readiness budget before saying so.
  it("refuses an empty healthcheck command", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          {
            name: "app",
            image: "a",
            mountWorktree: "/app",
            readiness: { kind: "healthcheck", command: [] },
          },
        ],
      }),
    ).toThrow(/empty healthcheck readiness command/);
  });

  // The rule that went WITH the tcp kind: two containers could not share a
  // readiness port because the pod published one host socket per port and
  // whichever container bound it marked both ready. Nothing is published now
  // and each probe runs inside its own container, so the shape is simply legal.
  it("allows two containers to probe the same port, now that nothing is published", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          {
            name: "app",
            image: "a",
            mountWorktree: "/app",
            readiness: {
              kind: "healthcheck",
              command: ["nc", "-z", "127.0.0.1", "3306"],
            },
          },
          {
            name: "db",
            image: "b",
            readiness: {
              kind: "healthcheck",
              command: ["nc", "-z", "127.0.0.1", "3306"],
            },
          },
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

  // ---------------------------------------------------------------------
  // inSandbox (#44 D2)
  // ---------------------------------------------------------------------------

  // Opt-in by construction: the flag's absence is what keeps every existing
  // consumer's topology and cost exactly where they were.
  it("defaults inSandbox to false, so no stack declares a sandbox by accident", () => {
    expect(resolveGateStack(ok).containers.map((c) => c.inSandbox)).toEqual([
      false,
      false,
    ]);
  });

  it("carries an explicit inSandbox onto the resolved container", () => {
    const resolved = resolveGateStack({
      ...ok,
      containers: [
        { name: "db", image: "mariadb", lifecycle: "issue", inSandbox: true },
        { name: "app", image: "app", mountWorktree: "/app", hold: true },
      ],
    });
    expect(resolved.containers.map((c) => c.inSandbox)).toEqual([true, false]);
  });

  // The one decidable emptiness: `hold` replaces the entrypoint with
  // `sleep infinity`, so held with nothing exec'd after readiness is a
  // container that provably runs nothing — and the sandbox slot would then name
  // the agent a neighbour with no process behind it, which is worse than not
  // listing it at all. (The gate's copy of that container is fine: steps
  // `exec` into it. The sandbox's is not: nothing execs into a sibling.)
  it("refuses inSandbox on a held container that runs nothing", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          { name: "db", image: "mariadb", lifecycle: "issue" },
          {
            name: "app",
            image: "app",
            mountWorktree: "/app",
            hold: true,
            inSandbox: true,
          },
        ],
      }),
    ).toThrow(/inSandbox/);
  });

  it("accepts inSandbox on a held container that starts something after readiness", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          { name: "db", image: "mariadb", lifecycle: "issue" },
          {
            name: "app",
            image: "app",
            mountWorktree: "/app",
            hold: true,
            inSandbox: true,
            postReadyCommands: [["sh", "-c", "httpd &"]],
          },
        ],
      }),
    ).not.toThrow();
  });

  // Two siblings probing the same port is fine here for the same reason it is
  // fine in the gate (above): the probe runs inside its own container and
  // nothing is published, so there is no host socket for two of them to
  // disagree over. #44 inherited the rule that used to forbid it and #43 had
  // already deleted it — the sandbox never needed one of its own.
  it("allows two sandbox containers to probe the same port", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          {
            name: "db",
            image: "mariadb",
            lifecycle: "issue",
            inSandbox: true,
            readiness: {
              kind: "healthcheck",
              command: ["nc", "-z", "127.0.0.1", "3306"],
            },
          },
          {
            name: "db2",
            image: "mariadb",
            lifecycle: "issue",
            inSandbox: true,
            readiness: {
              kind: "healthcheck",
              command: ["nc", "-z", "127.0.0.1", "3306"],
            },
          },
          { name: "app", image: "app", mountWorktree: "/app", hold: true },
        ],
      }),
    ).not.toThrow();
  });

  // #26. An unbounded step is not a slow gate, it is a run that never ends and
  // never releases the single-instance lock, so the resolved shape has no
  // "absent" case — a step that names no bound gets sandbar's.
  it("gives every step a timeout, defaulting when it names none", () => {
    const resolved = resolveGateStack({
      ...ok,
      steps: [
        { name: "lint", in: "app", command: ["npm", "run", "lint"] },
        { name: "e2e", in: "app", command: ["npx", "playwright", "test"], timeoutMs: 45_000 },
      ],
    });
    expect(resolved.steps.map((s) => s.timeoutMs)).toEqual([
      DEFAULT_STEP_TIMEOUT_MS,
      45_000,
    ]);
  });

  // The bound is a `setTimeout` sandbar owns, so 0, a negative and NaN all fire
  // on the next tick: every step killed before it runs, a red gate every
  // attempt until the budget dies. Infinity is the mirror — a bound that never
  // fires. NaN is the one that actually happens, from a misparsed env var.
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a step timeoutMs of %s",
    (timeoutMs) => {
      expect(() =>
        resolveGateStack({
          ...ok,
          steps: [{ name: "test", in: "app", command: ["a"], timeoutMs }],
        }),
      ).toThrow(/timeoutMs/);
    },
  );

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

  // An omitted mode is decided once, at resolve time — `mountSpec` reads the
  // resolved value and has no default of its own to disagree with.
  it("defaults a mount's mode to ro and carries an explicit rw through", () => {
    const spec = resolveGateStack({
      ...ok,
      containers: [
        {
          name: "app",
          image: "a",
          mountWorktree: "/app",
          mounts: [
            { hostPath: "fixtures", containerPath: "/fixtures" },
            { hostPath: "/tmp", containerPath: "/tmp", mode: "rw" },
          ],
        },
      ],
    });
    expect(spec.containers[0]?.mounts).toEqual([
      { hostPath: "fixtures", containerPath: "/fixtures", mode: "ro" },
      { hostPath: "/tmp", containerPath: "/tmp", mode: "rw" },
    ]);
  });

  // podman would reject the `-v` spec at container-create time, which on an
  // `attempt` container arrives as a gate RED blamed on the branch — the same
  // argument every other mount rule here is made from.
  it("refuses an unknown mount mode", () => {
    expect(() =>
      resolveGateStack({
        ...ok,
        containers: [
          {
            name: "app",
            image: "a",
            mountWorktree: "/app",
            mounts: [
              // The shape a consumer reaches for by analogy with podman's own
              // spelling of the same idea.
              { hostPath: "a", containerPath: "/c", mode: "readonly" as "ro" },
            ],
          },
        ],
      }),
    ).toThrow(/unknown mode/);
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

describe("resolveImages: rebuildOn (#37)", () => {
  const img = (extra: Record<string, unknown>) =>
    resolveImages(
      [{ tag: "sandbar:app", containerfile: "Containerfile", ...extra }],
      "sandbar:app",
    );

  it("normalises and deduplicates the declared paths", () => {
    // Sorted only at hash time; here the point is that a path written twice
    // does not become two records, which would make the fingerprint depend on
    // how many times someone wrote it down.
    expect(
      img({ rebuildOn: ["package-lock.json", " package-lock.json ", "bower.json"] })[0]
        ?.rebuildOn,
    ).toEqual(["package-lock.json", "bower.json"]);
  });

  // Every rejection below is a declaration that would either escape the
  // worktree root it is resolved against, or silently name nothing — and an
  // inert declaration is the #37 failure itself: the operator has written down
  // what the image is a function of and sandbar never acts on it.
  it("refuses stdinContext alongside rebuildOn — that build has no context to change", () => {
    expect(() => img({ rebuildOn: ["package-lock.json"], stdinContext: true })).toThrow(
      /stdinContext/,
    );
  });

  it("refuses an absolute containerfile, which cannot be re-rooted at a worktree", () => {
    expect(() =>
      resolveImages(
        [
          {
            tag: "sandbar:app",
            containerfile: "/etc/Containerfile",
            rebuildOn: ["package-lock.json"],
          },
        ],
        "sandbar:app",
      ),
    ).toThrow(/absolute/);
  });

  it("refuses a path outside the containerfile's own directory — the build context", () => {
    // `buildArgv` sets the context to `dirname(containerfile)`, so a path
    // outside it cannot be COPYd and the image cannot be a function of it.
    // Unchecked, that config passes everything else, changes its fingerprint on
    // every edit, pays a variant build per gate run, and produces an image
    // byte-identical to the base — #37 exactly, wearing the fix.
    expect(() =>
      resolveImages(
        [
          {
            tag: "sandbar:app",
            containerfile: "gate/Containerfile.runner",
            rebuildOn: ["package-lock.json"],
          },
        ],
        "sandbar:app",
      ),
    ).toThrow(/outside its build context/);
    // Inside it is fine, and so is a root containerfile with a nested input.
    expect(() =>
      resolveImages(
        [
          {
            tag: "sandbar:app",
            containerfile: "gate/Containerfile.runner",
            rebuildOn: ["gate/package-lock.json"],
          },
        ],
        "sandbar:app",
      ),
    ).not.toThrow();
    expect(() => img({ rebuildOn: ["packages/api/bun.lock"] })).not.toThrow();
  });

  it("refuses a non-positive, NaN or infinite buildTimeoutMs", () => {
    // Same rule and reason as `step.timeoutMs` (#26): the deadline is a
    // setTimeout sandbar owns, so 0 and NaN fire on the next tick — every build
    // killed before it starts — and Infinity never fires.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => img({ buildTimeoutMs: bad })).toThrow(/buildTimeoutMs/);
    }
    expect(() => img({ buildTimeoutMs: 60_000 })).not.toThrow();
  });

  it("refuses absolute, empty, and traversing paths", () => {
    expect(() => img({ rebuildOn: ["/etc/passwd"] })).toThrow(/absolute/);
    expect(() => img({ rebuildOn: ["  "] })).toThrow(/empty/);
    expect(() => img({ rebuildOn: ["../other/package-lock.json"] })).toThrow(
      /'\.', '\.\.' or empty segment/,
    );
    expect(() => img({ rebuildOn: ["./package-lock.json"] })).toThrow(
      /'\.', '\.\.' or empty segment/,
    );
    expect(() => img({ rebuildOn: ["a//b"] })).toThrow(
      /'\.', '\.\.' or empty segment/,
    );
  });
});

describe("resolveImages", () => {
  it("defaults to building the sandbox image from ./Containerfile", () => {
    expect(resolveImages(undefined, "sandbar:app")).toEqual([
      // `rebuildOn` is normalised to the empty list rather than left absent:
      // resolution validated and deduplicated it, and the two readers should
      // not have to re-decide what absence means (#37).
      { tag: "sandbar:app", containerfile: "Containerfile", rebuildOn: [] },
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

// ---------------------------------------------------------------------------
// containerState (#36)
//
// The classification, not podman: gate-stack-podman.test.ts pins what a real
// podman ANSWERS (`exists` 0 in any state, 1 for gone, `inspect` 125 for both
// gone and unwell), and this pins what sandbar concludes from each answer.
// Neither file can substitute for the other — a real podman will not produce a
// timed-out inspect or a SIGKILLed `exists` on demand, and those are exactly
// the answers whose misreading is the retry storm issue #36's notes warn
// against. Hence the probe seam.
// ---------------------------------------------------------------------------

const podmanSaid = (over: Partial<BoundedResult>): BoundedResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  maxBufferExceeded: false,
  errorMessage: "",
  ...over,
});

// A probe that answers each subcommand once, and records what it was asked —
// "was `exists` consulted at all" is half of what these tests assert.
const probeOf = (
  answers: Record<string, BoundedResult>,
): { probe: PodmanProbe; calls: string[] } => {
  const calls: string[] = [];
  const probe: PodmanProbe = (args) => {
    const key = args[0] === "container" ? "exists" : String(args[0]);
    calls.push(key);
    const answer = answers[key];
    if (!answer) throw new Error(`unexpected podman call: ${key}`);
    return Promise.resolve(answer);
  };
  return { probe, calls };
};

describe("containerState", () => {
  it("reads a clean inspect directly, without asking `exists`", async () => {
    for (const [stdout, expected] of [
      ["true\n", "running"],
      ["false\n", "stopped"],
    ] as const) {
      const { probe, calls } = probeOf({ inspect: podmanSaid({ stdout }) });
      expect(await containerState("c", probe)).toBe(expected);
      // The ordinary case, and the cost argument for the whole change: one
      // call, exactly as before #36.
      expect(calls).toEqual(["inspect"]);
    }
  });

  // The bug. Inspect exits 125 for a removed container AND for a podman that
  // is unwell, so this pairing is the only thing that separates them.
  it("is `gone` when inspect exits non-zero and `exists` says 1", async () => {
    const { probe, calls } = probeOf({
      inspect: podmanSaid({ exitCode: 125, errorMessage: "no such object" }),
      exists: podmanSaid({ exitCode: 1 }),
    });
    expect(await containerState("c", probe)).toBe("gone");
    expect(calls).toEqual(["inspect", "exists"]);
  });

  // The second producer of `unknown`, and the one the readiness poll leans on
  // when it keeps probing rather than declaring a container dead: it
  // demonstrably EXISTS, we just cannot say whether it is running. Reading this
  // as death would be the retry storm.
  it("is `unknown` when inspect fails but `exists` says the container is there", async () => {
    const { probe } = probeOf({
      inspect: podmanSaid({ exitCode: 125 }),
      exists: podmanSaid({ exitCode: 0 }),
    });
    expect(await containerState("c", probe)).toBe("unknown");
  });

  // An exit code `exists` does not document is podman being unreliable, not
  // podman saying no. `exists` answers 125 for a malformed invocation.
  it("is `unknown` for an `exists` exit code that is neither 0 nor 1", async () => {
    const { probe } = probeOf({
      inspect: podmanSaid({ exitCode: 125 }),
      exists: podmanSaid({ exitCode: 125 }),
    });
    expect(await containerState("c", probe)).toBe("unknown");
  });

  // `exists` exiting 1 is only evidence if it exited on its own. Under the
  // timer's SIGKILL boundedPodman reports exitCode null, but the guard tests
  // the flags too, so a 1 that arrived in the same tick the timer fired is
  // still not death.
  it("is `unknown` when `exists` was killed or overflowed, whatever the code", async () => {
    for (const over of [
      { exitCode: null },
      { exitCode: 1, timedOut: true },
      { exitCode: 1, maxBufferExceeded: true },
    ] as Partial<BoundedResult>[]) {
      const { probe } = probeOf({
        inspect: podmanSaid({ exitCode: 125 }),
        exists: podmanSaid(over),
      });
      expect(await containerState("c", probe)).toBe("unknown");
    }
  });

  // A wedged podman is asked once, not twice. `exists` would be answered
  // through the same wedged podman and cannot change the verdict, and the
  // second 15s would come straight off the readiness budget — pollUntilReady
  // tests its deadline only BETWEEN probes, so a doubled worst case doubles
  // the overshoot and halves how many polls a 60s budget buys.
  it("does not consult `exists` when inspect never returned", async () => {
    for (const over of [
      { exitCode: null, timedOut: true },
      { exitCode: null },
      { exitCode: 1, maxBufferExceeded: true },
    ] as Partial<BoundedResult>[]) {
      const { probe, calls } = probeOf({ inspect: podmanSaid(over) });
      expect(await containerState("c", probe)).toBe("unknown");
      expect(calls).toEqual(["inspect"]);
    }
  });
});
