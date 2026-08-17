// The gate stack (#24): several containers on one network namespace, and an
// ordered list of steps that run in them, producing one verdict about one
// commit.
//
// This replaces the single DB sidecar of #20. The shape a real repo needs is
// not "a database plus two npm scripts" — it is a database, a mail catcher, an
// application server, a frontend dev server and five steps spread across them,
// some of which only exist because the branch under test builds them.
//
// ---------------------------------------------------------------------------
// The pod
// ---------------------------------------------------------------------------
// Every container joins one podman POD, so the whole stack shares a network
// namespace and addresses itself as `127.0.0.1`. Nothing is published for the
// stack's own use, so a gate run cannot collide with the operator's dev stack
// or with another issue's gate running in parallel.
//
// A pod, not the `--network container:<anchor>` chain a docker-based launcher
// has to use. The anchor mechanism exists only because docker has no pods, and
// it costs two real constraints: the anchor owns the namespace (so the `--dns`
// flags must go on it, and every joiner inherits whatever it was created with),
// and REMOVING the anchor destroys the namespace — so the anchor can never be a
// container that is recreated per attempt. `RUNTIME` is podman, so sandbar owes
// none of that: the pod is created first, holds the resolver config, and
// survives every container's removal. There is no `anchor` in sandbar's config.
//
// What the pod costs: `--userns=keep-id` and `--pod` cannot be combined
// (podman refuses outright), and `--user 1000:1000` inside a pod maps to a
// SUBUID, not to the invoking user — a container that writes to the mounted
// worktree that way gets EACCES. Container ROOT under rootless podman maps to
// the invoking user, so a worktree-mounting container must run as root or as
// the host uid, which is checked empirically before the run starts
// (ensure-images.ts) rather than discovered as a mysterious mid-gate failure.
//
// The per-issue network stays underneath the pod. The pod isolates the
// namespace, but two pods on one shared bridge could still reach each other,
// and `--disable-dns` (#18) is a property of the network: on WSL2 the
// aardvark-dns resolver dies with the systemd user bus across suspend/resume
// and leaves every in-bridge lookup a black hole. The pod carries explicit
// public `--dns` servers so external resolution still works, and every
// container in it inherits them.
//
// ---------------------------------------------------------------------------
// Whose failure is a failed bringup
// ---------------------------------------------------------------------------
// `lifecycle` decides, and it is the most consequential field in the config.
// An `issue` container (a database, a mail catcher) depends only on its image
// and its env — never on the branch — so its failure is infra: it throws, the
// runner wraps it as HARD-ERROR, and the issue retries with a fresh stack. An
// `attempt` container mounts the worktree and runs the branch's code, so its
// failure is the branch's fault like any red test: gate red, with the
// container's log as the trace, and the implementer gets another attempt.
//
// Getting that backwards is not a style question. An agent that breaks the
// service bootstrap produces a readiness timeout; under a blanket
// "container failure = infra" rule that becomes two fresh-stack retries
// reproducing the identical failure and then NEEDS-HUMAN with an
// "environment" trace — for a bug the implementer could have fixed on the next
// attempt if it had been shown the log.
//
// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------
// `exec` and `log` are direct. `tcp` is the interesting one: the port is
// probed from the HOST, through a loopback-only publish with a podman-assigned
// ephemeral host port. Probing from inside the namespace would need a shell and
// a socket tool in an image sandbar does not control, and the images that most
// need a TCP probe (mail catchers, scratch-based services) are exactly the ones
// that have neither.
//
// A bare TCP connect to that published port is NOT a readiness signal, and
// treating it as one would be a green-on-red of the same family as #22's: the
// rootless port forwarder accepts the connection at the host and only then
// tries the backend, so `connect` succeeds against a pod with nothing listening
// at all. Verified: dead backend and mid-initialisation mariadb both connect
// and are closed ~190ms later, while a serving mariadb stays open. So the probe
// requires the socket to STAY open for a settle window. A server that accepts
// and immediately hangs up for its own reasons would read as not-ready
// forever — such a service should use `exec` readiness instead.

import { execFile } from "node:child_process";
import { connect } from "node:net";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

import { onCleanup } from "./cleanup.js";
import type {
  ResolvedGateStack,
  ResolvedStackContainer,
  StackMount,
} from "./config.js";
import { SandbarError } from "./errors.js";
import { type GateResult, stripAnsi } from "./gate.js";
import { dirtyWorktreePaths } from "./git-ops.js";
import { networkNameFor, podNameFor, stackContainerNameFor } from "./naming.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

const MAX_BUFFER = 50 * 1024 * 1024;

export const READY_POLL_INTERVAL_MS = 500;

// How long a TCP connection must stay open before the listener counts as real.
// 300ms clears the ~190ms in which the rootless port forwarder accepts and then
// closes a connection whose backend refused it.
export const TCP_SETTLE_MS = 300;

// Public resolvers on the pod, so external name resolution survives the
// `--disable-dns` network (#18). `--dns` writes resolv.conf directly, bypassing
// the (absent) aardvark resolver; pod members inherit it.
const DNS_SERVERS: readonly string[] = ["1.1.1.1", "8.8.8.8"];

// Lines of each container's log appended to a red gate's trace (#24 D9), and
// the tail shown when a container dies during bringup.
export const CONTAINER_LOG_TAIL = 40;

// The one env key sandbar owns in the stack. Everything else a step needs —
// DB_HOST, credentials, ports — is now literal config the consumer writes,
// because with one namespace `127.0.0.1` is an address it can know up front.
const RESERVED_ENV: Readonly<Record<string, string>> = { CI: "true" };

// `-t 0` kills immediately instead of waiting out podman's default 10-second
// graceful stop PER CONTAINER. Nothing in a gate stack has state worth
// flushing — the containers are recreated from the image every attempt — and
// paying 10s a container on every teardown is real wall-clock across three
// parallel issues and eight attempts each.
const POD_RM_ARGS = (podName: string): string[] => [
  "pod",
  "rm",
  "-f",
  "-t",
  "0",
  podName,
];

export type StackOptions = {
  // Issue id in the inner loop, "merger" for gate-2.
  readonly stackId: string;
  readonly spec: ResolvedGateStack;
  // The worktree the gate is a verdict about. Must exist, with its files, before
  // this call — bind-mount sources are read at container start.
  readonly worktreePath: string;
};

export type Stack = {
  readonly podName: string;
  readonly networkName: string;
  // Recreate the attempt-lifecycle containers and run every step in order.
  readonly runGate: () => Promise<GateResult>;
  readonly stop: () => Promise<void>;
};

// A container failed to start or never became ready. Thrown for `issue`
// containers (infra → HARD-ERROR); caught and converted to a red gate for
// `attempt` ones.
export class ContainerBringupError extends SandbarError {
  readonly containerName: string;
  readonly logTail: string;
  constructor(containerName: string, message: string, logTail: string) {
    super(`${message}\nContainer log tail:\n${logTail}`);
    this.name = "ContainerBringupError";
    this.containerName = containerName;
    this.logTail = logTail;
  }
}

// ---------------------------------------------------------------------------
// Pure argv builders — the real adapters' blind spot is that a fake satisfies
// the contract no matter what argv the real one builds, so these are separated
// out and table-tested (gate-stack.test.ts).
// ---------------------------------------------------------------------------

// One `-v` spec. Relative hostPaths resolve against the gated worktree;
// absolute pass through. Always read-only, always `z`-relabelled: without the
// SELinux label the mount is denied outright on Fedora/RHEL/CentOS, which is
// what `agent-sandbox.ts` has always done and what the pre-#24 gate and sidecar
// mounts did not.
export function mountSpec(worktreePath: string, mount: StackMount): string {
  const hostPath = isAbsolute(mount.hostPath)
    ? mount.hostPath
    : resolvePath(worktreePath, mount.hostPath);
  return `${hostPath}:${mount.containerPath}:ro,z`;
}

export function podCreateArgs(opts: {
  readonly podName: string;
  readonly networkName: string;
  // Container ports needing a host-side probe (tcp readiness).
  readonly publishPorts: readonly number[];
}): string[] {
  return [
    "pod",
    "create",
    "--name",
    opts.podName,
    "--network",
    opts.networkName,
    ...DNS_SERVERS.flatMap((s) => ["--dns", s]),
    // Loopback-only, podman picks the host port: two concurrent stacks cannot
    // collide, and nothing is reachable off-box.
    ...opts.publishPorts.flatMap((p) => ["-p", `127.0.0.1::${p}`]),
  ];
}

export function containerRunArgs(opts: {
  readonly containerName: string;
  readonly podName: string;
  readonly container: ResolvedStackContainer;
  readonly worktreePath: string;
}): string[] {
  const { container: c } = opts;
  const args = [
    "run",
    "-d",
    "--name",
    opts.containerName,
    "--pod",
    opts.podName,
    "--label",
    "sandbar=true",
    // Consumer env first, sandbar's reserved key last: podman keeps the final
    // value for a repeated -e, so the reserved key wins.
    ...Object.entries(c.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...Object.entries(RESERVED_ENV).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...c.mounts.flatMap((m) => ["-v", mountSpec(opts.worktreePath, m)]),
  ];
  if (c.mountWorktree !== null) {
    args.push("-v", `${opts.worktreePath}:${c.mountWorktree}:rw,z`);
    args.push("-w", c.mountWorktree);
  }
  if (c.hold) {
    // No `--user`/`--userns`: neither is available in a pod, and the image's
    // default user is what the uid preflight checked.
    args.push("--entrypoint", "sleep", c.image, "infinity");
  } else {
    args.push(c.image, ...c.args);
  }
  return args;
}

export function stepExecArgs(
  containerName: string,
  command: readonly string[],
): string[] {
  return [
    "exec",
    ...Object.entries(RESERVED_ENV).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    containerName,
    ...command,
  ];
}

// Container ports that need a host-side publish, deduplicated. Two containers
// cannot listen on the same port in one namespace anyway, but a duplicate here
// would make `pod create` fail rather than merely waste a mapping.
export function tcpProbePorts(spec: ResolvedGateStack): number[] {
  const ports = new Set<number>();
  for (const c of spec.containers) {
    if (c.readiness?.kind === "tcp") ports.add(c.readiness.port);
  }
  return [...ports];
}

// Parse `podman pod inspect --format '{{json .InfraConfig.PortBindings}}'` into
// containerPort → hostPort. Shape:
//   {"3306/tcp":[{"HostIp":"127.0.0.1","HostPort":"44719"}]}
export function parsePortBindings(json: string): Map<number, number> {
  const out = new Map<number, number>();
  const trimmed = json.trim();
  if (!trimmed || trimmed === "null") return out;
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null) return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const containerPort = Number(key.split("/")[0]);
    if (!Number.isInteger(containerPort)) continue;
    if (!Array.isArray(value) || value.length === 0) continue;
    const first = value[0] as { HostPort?: unknown };
    const hostPort = Number(first?.HostPort);
    if (!Number.isInteger(hostPort) || hostPort <= 0) continue;
    out.set(containerPort, hostPort);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function startStack(opts: StackOptions): Promise<Stack> {
  const networkName = networkNameFor(opts.stackId);
  const podName = podNameFor(opts.stackId);
  const nameOf = (c: ResolvedStackContainer): string =>
    stackContainerNameFor(opts.stackId, c.name);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // `pod rm -f` takes the member containers AND the infra container with it.
    // The infra container is named `<pod-id-prefix>-infra`, which matches no
    // sandbar prefix — removing containers by name would leave it, and the pod,
    // behind.
    await exec(RUNTIME, POD_RM_ARGS(podName)).catch(() => {});
    await exec(RUNTIME, ["network", "rm", networkName]).catch(() => {});
  };
  // Registered before the first resource exists, so a signal anywhere in the
  // bringup window below still sweeps whatever was created. The local catch
  // only fires for JS throws; signal-driven exit does not unwind it. `stop` is
  // idempotent and best-effort, so an early registration is safe.
  onCleanup(stop);

  try {
    // A namesake surviving an older run may be DNS-enabled or otherwise stale
    // and must never be reused. `rm -f` no-ops when absent, so this is the
    // recreate-once migration and the first-time create in one step.
    await exec(RUNTIME, POD_RM_ARGS(podName)).catch(() => {});
    await exec(RUNTIME, ["network", "rm", "-f", networkName]).catch(() => {});
    await exec(RUNTIME, ["network", "create", "--disable-dns", networkName]);
    await exec(
      RUNTIME,
      podCreateArgs({
        podName,
        networkName,
        publishPorts: tcpProbePorts(opts.spec),
      }),
    );

    const hostPorts = await readPortBindings(podName);

    const issueContainers = opts.spec.containers.filter(
      (c) => c.lifecycle === "issue",
    );
    await bringUp(issueContainers, {
      podName,
      worktreePath: opts.worktreePath,
      stackId: opts.stackId,
      hostPorts,
    });

    const attemptContainers = opts.spec.containers.filter(
      (c) => c.lifecycle === "attempt",
    );

    return {
      podName,
      networkName,
      stop,
      runGate: () =>
        runStackGate({
          spec: opts.spec,
          attemptContainers,
          podName,
          stackId: opts.stackId,
          worktreePath: opts.worktreePath,
          hostPorts,
          nameOf,
        }),
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

async function readPortBindings(podName: string): Promise<Map<number, number>> {
  const { stdout } = await exec(RUNTIME, [
    "pod",
    "inspect",
    podName,
    "--format",
    "{{json .InfraConfig.PortBindings}}",
  ]);
  return parsePortBindings(stdout);
}

type BringUpCtx = {
  readonly podName: string;
  readonly worktreePath: string;
  readonly stackId: string;
  readonly hostPorts: ReadonlyMap<number, number>;
};

// Start every container, THEN wait for all of them, then run their post-ready
// setup. Started together because a container only needs the pod to exist, not
// its neighbours to be ready — there is no reason for a frontend that builds
// the app on startup to queue behind a database initialising a schema it never
// reads.
async function bringUp(
  containers: readonly ResolvedStackContainer[],
  ctx: BringUpCtx,
): Promise<void> {
  for (const c of containers) {
    const containerName = stackContainerNameFor(ctx.stackId, c.name);
    // A container of this name may survive a crashed run; the sweep covers the
    // usual case but the pod was just recreated, so any leftover is stale.
    await exec(RUNTIME, ["rm", "-f", "-t", "0", containerName]).catch(() => {});
    try {
      await exec(
        RUNTIME,
        containerRunArgs({
          containerName,
          podName: ctx.podName,
          container: c,
          worktreePath: ctx.worktreePath,
        }),
      );
    } catch (err) {
      throw new ContainerBringupError(
        containerName,
        `gate stack: container '${c.name}' (${c.image}) failed to start: ${
          err instanceof Error ? err.message : String(err)
        }`,
        await logTail(containerName),
      );
    }
  }

  for (const c of containers) {
    await waitForReady(stackContainerNameFor(ctx.stackId, c.name), c, ctx);
  }

  for (const c of containers) {
    const containerName = stackContainerNameFor(ctx.stackId, c.name);
    for (const command of c.postReadyCommands) {
      try {
        await exec(RUNTIME, ["exec", containerName, ...command], {
          maxBuffer: MAX_BUFFER,
        });
      } catch (err) {
        // Post-ready setup is part of the container's contract — a failing
        // command means every step runs against a half-initialized service.
        throw new ContainerBringupError(
          containerName,
          `gate stack: postReadyCommand ${JSON.stringify(command)} failed in ` +
            `container '${c.name}': ${
              err instanceof Error ? err.message : String(err)
            }`,
          await logTail(containerName),
        );
      }
    }
  }
}

async function waitForReady(
  containerName: string,
  c: ResolvedStackContainer,
  ctx: BringUpCtx,
): Promise<void> {
  if (c.readiness === null) return;
  const readiness = c.readiness;
  const deadline = Date.now() + c.readinessTimeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    const probe = await probeOnce(containerName, readiness, ctx);
    if (probe.ready) return;
    lastErr = probe.detail;
    // The recipe is untrusted consumer input and the branch's own code, so a
    // container whose entrypoint dies at startup is an EXPECTED failure. Report
    // it immediately with its log instead of polling a corpse for the full
    // timeout and then reporting a misleading "did not become ready".
    await throwIfDead(containerName, c);
    await sleep(READY_POLL_INTERVAL_MS);
  }
  throw new ContainerBringupError(
    containerName,
    `gate stack: container '${c.name}' (${c.image}) did not become ready ` +
      `within ${c.readinessTimeoutMs}ms (${describeReadiness(readiness)}; ` +
      `last probe: ${lastErr})`,
    await logTail(containerName),
  );
}

function describeReadiness(r: NonNullable<ResolvedStackContainer["readiness"]>): string {
  switch (r.kind) {
    case "tcp":
      return `tcp port ${r.port}`;
    case "log":
      return `log pattern ${JSON.stringify(r.pattern)}`;
    case "exec":
      return `exec ${JSON.stringify(r.argv)}`;
  }
}

async function probeOnce(
  containerName: string,
  readiness: NonNullable<ResolvedStackContainer["readiness"]>,
  ctx: BringUpCtx,
): Promise<{ ready: boolean; detail: string }> {
  switch (readiness.kind) {
    case "exec": {
      try {
        await exec(RUNTIME, ["exec", containerName, ...readiness.argv], {
          maxBuffer: MAX_BUFFER,
        });
        return { ready: true, detail: "" };
      } catch (err) {
        return {
          ready: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }
    case "log": {
      // Not `logs | grep -q`: a match would close the pipe, the writer takes
      // SIGPIPE, and on a long enough log the probe never succeeds.
      const r = await exec(RUNTIME, ["logs", containerName], {
        maxBuffer: MAX_BUFFER,
      }).catch(() => null);
      if (r === null) return { ready: false, detail: "logs unavailable" };
      const found = `${r.stdout}${r.stderr}`.includes(readiness.pattern);
      return { ready: found, detail: found ? "" : "pattern not in log yet" };
    }
    case "tcp": {
      const hostPort = ctx.hostPorts.get(readiness.port);
      if (hostPort === undefined) {
        // The publish is derived from this same readiness declaration, so its
        // absence is a sandbar bug, not a consumer one. Never a silent skip:
        // skipping would make "ready" mean "I could not check".
        throw new SandbarError(
          `gate stack: no host publish for container port ${readiness.port} on ` +
            `pod ${ctx.podName}. The pod is created with a publish for every ` +
            "tcp readiness port, so this is an internal inconsistency.",
        );
      }
      return probeTcp(hostPort);
    }
  }
}

// Connect, then require the socket to stay open (see the header): the rootless
// port forwarder accepts at the host before it learns the backend is refusing,
// so "connected" alone is not a listener.
function probeTcp(hostPort: number): Promise<{ ready: boolean; detail: string }> {
  return new Promise((resolveProbe) => {
    const socket = connect({ port: hostPort, host: "127.0.0.1" });
    let settled = false;
    let connected = false;
    let settleTimer: NodeJS.Timeout | null = null;
    const finish = (ready: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      if (settleTimer) clearTimeout(settleTimer);
      socket.destroy();
      resolveProbe({ ready, detail });
    };
    socket.on("connect", () => {
      connected = true;
      settleTimer = setTimeout(
        () => finish(true, ""),
        TCP_SETTLE_MS,
      );
    });
    socket.on("close", () =>
      finish(
        false,
        connected
          ? "forwarder accepted then closed — nothing listening inside the pod"
          : "connection closed before connect",
      ),
    );
    socket.on("error", (err: NodeJS.ErrnoException) =>
      finish(false, `connect failed (${err.code ?? err.message})`),
    );
  });
}

async function throwIfDead(
  containerName: string,
  c: ResolvedStackContainer,
): Promise<void> {
  let running: string;
  try {
    const { stdout } = await exec(RUNTIME, [
      "inspect",
      "--format",
      "{{.State.Running}}",
      containerName,
    ]);
    running = stdout.trim();
  } catch {
    // Inspect itself flaking is not evidence of death; let the deadline arbitrate.
    return;
  }
  if (running === "true") return;
  throw new ContainerBringupError(
    containerName,
    `gate stack: container '${c.name}' (${c.image}) exited during startup.`,
    await logTail(containerName),
  );
}

async function logTail(
  containerName: string,
  lines = CONTAINER_LOG_TAIL,
): Promise<string> {
  const r = await exec(RUNTIME, [
    "logs",
    "--tail",
    String(lines),
    containerName,
  ]).catch(() => null);
  if (r === null) return "(logs unavailable)";
  const text = stripAnsi(`${r.stdout}${r.stderr}`).trim();
  return text || "(empty)";
}

// ---------------------------------------------------------------------------
// The gate run
// ---------------------------------------------------------------------------

type RunGateCtx = {
  readonly spec: ResolvedGateStack;
  readonly attemptContainers: readonly ResolvedStackContainer[];
  readonly podName: string;
  readonly stackId: string;
  readonly worktreePath: string;
  readonly hostPorts: ReadonlyMap<number, number>;
  readonly nameOf: (c: ResolvedStackContainer) => string;
};

async function runStackGate(ctx: RunGateCtx): Promise<GateResult> {
  // The verdict is about a commit, so the tree had better BE the commit. This
  // also covers gate-2 in the merger worktree, where the resolve agent can
  // leave edits behind; the inner loop short-circuits earlier (the state
  // machine re-prompts the implementer to commit) and never reaches here dirty.
  const dirty = await dirtyWorktreePaths(ctx.worktreePath);
  if (dirty.length > 0) {
    return {
      ok: false,
      stdout: "",
      stderr:
        "Refusing to gate: the worktree has uncommitted changes, so a verdict " +
        "about it would not be a verdict about any commit. Commit or discard:\n" +
        dirty.map((p) => `  ${p}`).join("\n"),
      exitCode: 1,
      failedStep: "worktree-clean",
      containerLogs: "",
    };
  }

  // Recreated every gate run: they mount the worktree and run the branch's
  // code, so reusing one would gate an earlier attempt's process against a
  // later attempt's source.
  try {
    await bringUp(ctx.attemptContainers, {
      podName: ctx.podName,
      worktreePath: ctx.worktreePath,
      stackId: ctx.stackId,
      hostPorts: ctx.hostPorts,
    });
  } catch (err) {
    if (err instanceof ContainerBringupError) {
      return withContainerLogs(
        {
          ok: false,
          stdout: "",
          stderr: err.message,
          exitCode: 1,
          failedStep: `container:${err.containerName}`,
          containerLogs: "",
        },
        ctx,
      );
    }
    throw err;
  }

  let stdout = "";
  let stderr = "";
  for (const step of ctx.spec.steps) {
    const container = ctx.spec.containers.find((c) => c.name === step.in);
    // resolveGateStack proved this at config time; a miss here is a bug.
    if (container === undefined) {
      throw new SandbarError(
        `gate stack: step '${step.name}' targets unknown container '${step.in}'.`,
      );
    }
    const containerName = ctx.nameOf(container);
    const banner = `\n== ${step.name} (${step.in})\n`;
    try {
      const r = await exec(RUNTIME, stepExecArgs(containerName, step.command), {
        maxBuffer: MAX_BUFFER,
      });
      stdout += banner + stripAnsi(r.stdout);
      stderr += stripAnsi(r.stderr);
    } catch (err) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      // Stop at the first red. Every later step tends to read what an earlier
      // one built, so running them would bury the real failure under derived
      // ones — the same reason gate.sh refuses to run suites after a failed
      // prepare.
      return withContainerLogs(
        {
          ok: false,
          stdout: stdout + banner + stripAnsi(e.stdout ?? ""),
          stderr: stderr + stripAnsi(e.stderr ?? ""),
          exitCode: typeof e.code === "number" ? e.code : 1,
          failedStep: step.name,
          containerLogs: "",
        },
        ctx,
      );
    }
  }
  return {
    ok: true,
    stdout,
    stderr,
    exitCode: 0,
    failedStep: null,
    containerLogs: "",
  };
}

// Collect a labelled log tail for every stack container onto a RED gate (#24 D9).
//
// When the browser step fails because the backend is 500ing, the step's own
// output ("expected 200, got 500") is undiagnosable and the answer is in a
// container the step never touched. It lands in its own `containerLogs` field
// rather than on stderr, so the cascade collapse never reads it as test output
// — see the field's comment in gate.ts.
async function withContainerLogs(
  result: GateResult,
  ctx: RunGateCtx,
): Promise<GateResult> {
  const sections: string[] = [];
  for (const c of ctx.spec.containers) {
    const name = ctx.nameOf(c);
    sections.push(
      `\n--- container ${c.name} (last ${CONTAINER_LOG_TAIL} lines) ---\n` +
        (await logTail(name)),
    );
  }
  return { ...result, containerLogs: sections.join("\n") };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
