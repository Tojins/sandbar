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
// SANDBAR NOW RUNS BOTH TOPOLOGIES, and the paragraph above is why the second
// one is not a contradiction (#44). The sandbox stack — the same containers,
// beside the AGENT rather than beside the steps — uses the anchor chain, and
// every objection just made is an objection to the anchor being a FOREIGN
// container. There the anchor is the agent's own sandbox: created first,
// outliving every sibling, never recreated per attempt, and the owner of the
// only `--dns`/`-p` flags anyone wants. What forces the choice is that a pod
// cannot host it at all — `--pod` and `--userns=keep-id` are refused together,
// and the agent needs keep-id (uid 1000, `HOME=/home/agent`, and a
// `--dangerously-skip-permissions` that refuses to run as root). So: pods where
// a pod is possible, the chain where it is not. See sandbox-stack.ts, and
// `ContainerAttachment` below for the one place the two meet in this module.
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
// The mapping has to hold for the whole life of the stack, not just its first
// second, and two liveness checks are what make it. A container with no
// `readiness` declared is still asserted alive after a grace interval —
// `podman run -d` exits 0 for an entrypoint that dies immediately, so without
// that check a dead mail catcher passes bringup and is then blamed on the
// branch by every step that talks to it. And the `issue` containers are
// re-checked before EVERY gate run: a database OOM-killed at attempt 4 is still
// infrastructure, so it throws rather than reddening, and the fresh-stack retry
// does what it exists to do instead of burning the rest of the budget against a
// corpse.
//
// ---------------------------------------------------------------------------
// Nothing here may hang
// ---------------------------------------------------------------------------
// This module holds the run's single-instance lock while it works, and node's
// execFile has NO default timeout, so an unbounded exec is not a slow gate —
// it is a run that never ends and never tears down. EVERY podman call in this
// module goes through `boundedPodman`, which does its OWN timing rather than
// passing node's `timeout:` option — see that function, and note that the
// option it replaces did not merely fail to bound a `podman exec`, it reported
// the hung call as a SUCCESS. Steps are bounded by `step.timeoutMs` (#26, per
// step because a lint step and a browser suite do not want the same ceiling);
// readiness probes and postReadyCommands by the container's own readiness
// budget; the calls sandbar makes ABOUT a container rather than through it
// (`logs`, `inspect`, `container exists`) by LOG_READ_TIMEOUT_MS; everything
// that creates or
// destroys a pod, network or container by CONTROL_TIMEOUT_MS; and the tcp probe
// carries a socket timeout because a dropped SYN produces neither `connect` nor
// `error`. The one thing a gate run still shells out to unbounded is not
// podman: `dirtyWorktreePaths`' `git status` (git-ops.ts).
// Note that `readinessTimeoutMs` alone does not do this: the poll loop only
// tests its deadline BETWEEN probes, so one probe that never returns hangs
// forever inside a perfectly valid budget.
//
// A step that exceeds its bound is a gate RED, not a HARD-ERROR — the same
// argument as D5. A suite that hangs is nearly always the branch's own code (a
// test awaiting a promise that never resolves, a reporter that never exits),
// not the environment, so the implementer gets another attempt with a trace
// naming the step and the bound; a hang that IS environmental recurs, exhausts
// the attempt budget and lands on NEEDS-HUMAN carrying that same trace.
//
// There is deliberately no bound on the gate as a WHOLE. A gate run stops at
// the first red, so one hung step costs exactly one step's bound; a second
// number would only add a way to kill a legitimately slow run without being
// able to say which step it killed. The residual is that a stack of N slow but
// PASSING steps can run for the sum of their bounds — finite, and computable by
// the operator from the config in front of them.
//
// Killing the step is not the end of it: killing the `podman exec` CLIENT does
// not touch the process inside the container (also pinned against real podman),
// so a timed-out step leaves its work running, burning CPU beside the next
// attempt and skewing whatever the next gate run measures. The only handle
// podman offers that is total, and that needs no tools in an image sandbar does
// not control, is the container itself: `reapKilledStep` removes it. For an
// `attempt` container that is free — the next gate run recreates it anyway —
// and an `issue` one is recreated on the spot. That recreate used to be the
// only thing between this reap and a verdict misblamed on the branch, because
// `assertIssueContainersAlive` could not see a REMOVED container at all; since
// #36 it can, so the recreate is now an optimisation — read that function for
// what it saves and what it costs. The same reap runs on a maxBuffer kill,
// which strands a process for exactly the same reason.
//
// A recreate that fails is the one case where a killed step does not produce a
// gate red: the bringup error wins and the run takes a HARD-ERROR instead.
//
// The `log` follower (#31) is the one thing here with no deadline at all, and
// its bound is a kill rather than a timeout: `podman logs -f` is unbounded BY
// DESIGN, so what makes it safe is that `waitForReady` owns it in a `finally`
// and kills it on every path out — ready, timeout, or throw. It is deliberately
// not registered with `onCleanup`: that registry never forgets an action, so
// one entry per container per bringup would grow without limit.
//
// What covers a SIGNAL is weaker, and worth stating exactly rather than
// waving at. On SIGINT/SIGTERM the trapped cleanup tears the pod down, and a
// follower whose container has been removed exits ~1s later on its own —
// verified. That chain does NOT cover SIGKILL, SIGHUP (untrapped), or a
// teardown that throws before `pod rm`: an orphaned follower on a QUIET
// container blocks in read, never notices the broken pipe, and survives its
// parent indefinitely. It holds no lock and no podman resource, so it is a
// stray process rather than a leak that blocks the next run — which is why
// this is documented rather than defended against with a pidfile.
//
// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------
// `exec` is direct. `log` FOLLOWS the log with `podman logs -f` and scans the
// stream as it arrives, because the obvious implementation — re-read the whole
// log every poll — is quadratic in the log's size and, past `MAX_BUFFER`, node
// kills every read so the container can never become ready EVEN AFTER the
// pattern is printed, and reports it as "logs unavailable", which reads as
// "the pattern never appeared" and sends the operator to the wrong place
// (#31). Following also means a genuine podman failure is reported as what
// podman said rather than flattened into that same string.
//
// A followed stream delivers a line in as many chunks as it likes — an
// unterminated partial line arrives as its own chunk under the `k8s-file`
// driver, pinned in gate-stack-podman.test.ts — so the scan carries the last
// `pattern.length - 1` bytes of each stream across chunk boundaries. Without
// that carry, a pattern written as `PAR` then `TIAL` is missed forever: a new
// silent failure, and exactly the one that makes the cheap `--tail N` fix
// unacceptable. The carry is sound here only because a followed stream is
// delivered ONCE, in order — the other candidate fix, a rolling `--since`
// cursor, must re-read an overlap window to avoid losing lines, and re-delivery
// makes `carry + chunk` manufacture matches that were never in the log.
//
// The chunk boundary is a BYTE boundary, so the stream is decoded through a
// StringDecoder rather than per-chunk `toString`; decoding independently
// destroys a multi-byte character split across two chunks, and the patterns
// most likely to be given to a frontend dev server are not ASCII.
//
// One behaviour change worth knowing: a container that prints its pattern and
// EXITS within the first poll now fails bringup instead of going ready. The
// old full read could answer from a dead container's log; a follower has ~200ms
// of startup latency, so the first poll finds nothing and `throwIfDead` fires.
// A readiness container that exits is not a service — every step that execs
// into it would fail anyway — so failing loudly at bringup is the better
// answer, but it IS an answer the old probe did not give.
//
// `tcp` is the interesting one: the port is probed from the HOST, through a
// loopback-only publish with a podman-assigned ephemeral host port. Probing
// from inside the namespace would need a shell and
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

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { connect } from "node:net";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

import { onCleanup } from "./cleanup.js";
import type {
  ResolvedGateStack,
  ResolvedStackContainer,
  ResolvedStackMount,
} from "./config.js";
import { type ImageMap, ImageBuildError } from "./ensure-images.js";
import { SandbarError } from "./errors.js";
import { type GateResult, stripAnsi } from "./gate.js";
import { dirtyWorktreePaths } from "./git-ops.js";
import {
  type RunScope,
  networkNameFor,
  podNameFor,
  stackContainerNameFor,
} from "./naming.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

const MAX_BUFFER = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Bounded podman calls (#26)
// ---------------------------------------------------------------------------
// Every podman call that could take arbitrarily long goes through
// `boundedPodman`, and it does the timing ITSELF rather than passing node's
// `timeout:` option — because on a `podman exec` that option is a green-on-red.
//
// Node's timeout kills the child with SIGTERM, and `podman exec` EXITS 0 on
// SIGTERM. Node's exit handler reports an error only for a non-zero code or a
// non-null signal, so the call RESOLVES, with whatever partial output had been
// flushed and no indication anything went wrong. A hung test suite would be a
// GREEN gate; a hung `exec` readiness probe would mark its container ready; a
// hung postReadyCommand would report a seeded database. All three were live —
// the readiness probe and the postReadyCommands have carried `timeout:` since
// #24 and neither has ever been able to fail. Pinned in
// gate-stack-podman.test.ts, because it is a fact about podman, not about node.
//
// So the deadline is ours, the signal is SIGKILL (which podman cannot exit 0
// from, and which cannot be ignored — a client that swallowed SIGTERM would
// reintroduce the very hang this closes), and `timedOut` is a flag set by the
// timer, never inferred from the exit code.
//
// It also never throws for a process-level failure. Every caller here has to
// tell "it failed" from "it never answered" — a readiness probe that exits 1 is
// not ready, one that hangs is not ready AND has left a process behind — and an
// exception collapses those into one channel.
export type BoundedResult = {
  readonly stdout: string;
  readonly stderr: string;
  // null when the process was killed rather than exiting on its own.
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly maxBufferExceeded: boolean;
  // Node's own message ("Command failed: …"), for prose. "" on success.
  readonly errorMessage: string;
};

// Exported since #44: sandbox-stack.ts drives podman for the sandbox siblings
// and every claim this module makes about not hanging (and about `podman exec`
// exiting 0 on SIGTERM) applies there verbatim.
export function boundedPodman(
  args: readonly string[],
  timeoutMs: number,
): Promise<BoundedResult> {
  return new Promise((resolve) => {
    let killedByTimer = false;
    // Hoisted, not declared after `execFile`. `clearTimeout(timer)` below is
    // safe only because execFile never invokes its callback synchronously, and
    // a TDZ ReferenceError raised inside that callback would surface as an
    // uncaught throw rather than a rejected promise.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(
      RUNTIME,
      [...args],
      { maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        const e = err as
          | (Error & { code?: number | string; signal?: string })
          | null;
        resolve({
          stdout,
          stderr,
          exitCode: e === null ? 0 : typeof e.code === "number" ? e.code : null,
          // `e !== null` keeps a call that exited 0 in the same tick the timer
          // fired from being read as a timeout — a false red costing an
          // implementation attempt. It does NOT cover the mirror case: a call
          // that exits NON-ZERO inside that same window is reported as a
          // timeout. Against a 15-minute default the window is microseconds,
          // and both readings are red, so the asymmetry is priced in rather
          // than closed.
          timedOut: killedByTimer && e !== null,
          maxBufferExceeded: e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          errorMessage: e?.message ?? "",
        });
      },
    );
    timer = setTimeout(() => {
      killedByTimer = true;
      child.kill("SIGKILL");
    }, timeoutMs);
  });
}

// Did the call exit 0 on its own?
export function boundedOk(r: BoundedResult): boolean {
  return r.exitCode === 0 && !r.timedOut && !r.maxBufferExceeded;
}

// A control-plane call whose failure means the stack cannot exist. Throws a
// plain Error, NOT a SandbarError: SandbarError means "operator-actionable,
// do not retry" and the inner loop rethrows it past HARD-ERROR, which would
// drop the issue for the cycle with no terminal and no finalize. Podman
// failing to create a network is infrastructure — the fresh-stack retry is
// exactly what it wants.
async function mustSucceed(
  args: readonly string[],
  what: string,
): Promise<BoundedResult> {
  const r = await boundedPodman(args, CONTROL_TIMEOUT_MS);
  if (boundedOk(r)) return r;
  throw new Error(
    `gate stack: could not ${what}: ${
      r.timedOut
        ? `${RUNTIME} ${args[0]} did not return within ${CONTROL_TIMEOUT_MS}ms`
        : r.errorMessage
    }`,
  );
}

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

// Bound for the podman calls sandbar makes ABOUT a container rather than
// through it — `logs`, `inspect`. These answer from local state and are fast or
// broken; the point is only that none of them can hang the run. Consumer-facing
// execs are bounded by the readiness budget instead.
export const LOG_READ_TIMEOUT_MS = 15_000;

// Bound for the podman calls that CREATE and DESTROY things — `pod create`,
// `network create`, `run`, `rm`, `pod rm`. Separate from LOG_READ_TIMEOUT_MS
// and much larger, because these do real work (unpacking layers, setting up
// overlay mounts, tearing down namespaces) and a host running three stacks in
// parallel can legitimately take tens of seconds. 15s here would be a spurious
// bringup failure, which is a false verdict about a branch.
//
// They are bounded at all because the alternative is #26's hang reached through
// #26's own fix: `reapTimedOutStep` tolerates a failed remove on the grounds
// that the next gate run force-removes the container before recreating it, so
// an unbounded remove THERE would hang the run forever holding the lock.
export const CONTROL_TIMEOUT_MS = 120_000;

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
  // This run's resource scope (#28). Every name below is built under it, so a
  // concurrent run against a different workdir cannot be a namesake — the
  // `pod rm -f` that recycles a stale pod below would otherwise be reaching
  // into a live sibling's stack.
  readonly scope: RunScope;
  readonly spec: ResolvedGateStack;
  // The worktree the gate is a verdict about. Must exist, with its files, before
  // this call — bind-mount sources are read at container start.
  readonly worktreePath: string;
  // Which image each container should actually run, for THIS worktree as it is
  // right now (#37). Called at the top of every gate run, never cached: an
  // image that bakes a lockfile is a function of the branch, and the branch
  // grows between attempts — an implementer that adds a dependency in attempt 2
  // must be gated against an image that has it.
  //
  // Omitted, every container runs the image its config names, which is what
  // every stack without a `rebuildOn` image does.
  readonly images?: () => Promise<ImageMap>;
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
// absolute pass through. Read-only unless the mount says `mode: "rw"`, always
// `z`-relabelled: without the SELinux label the mount is denied outright on
// Fedora/RHEL/CentOS, which is what `agent-sandbox.ts` has always done and what
// the pre-#24 gate and sidecar mounts did not. The mode is read off the
// RESOLVED mount rather than defaulted here, so "what does an omitted mode
// mean" is answered in exactly one place (`resolveGateStack`).
export function mountSpec(
  worktreePath: string,
  mount: ResolvedStackMount,
): string {
  const hostPath = isAbsolute(mount.hostPath)
    ? mount.hostPath
    : resolvePath(worktreePath, mount.hostPath);
  return `${hostPath}:${mount.containerPath}:${mount.mode},z`;
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

// How a container gets its network namespace, and the only thing #44 had to
// generalise in this module.
//
// `pod` is the gate's own topology and everything the header says about it
// stands. `netns` is the anchor chain — `--network container:<anchor>` — and it
// exists for exactly one caller, the sandbox stack (sandbox-stack.ts), where
// the argument the header makes AGAINST the chain inverts: the anchor there is
// the agent container, which is created first, outlives every sibling and is
// never recreated per attempt. A pod is unavailable to it for a hard podman
// reason (`--pod` refuses `--userns=keep-id`, and the agent must keep it), so
// the chain is not a docker tax there but the only shape available.
//
// The joiner takes NO `-p` and NO `--dns`: podman refuses both alongside
// `--network container:`, since those are properties of the namespace and the
// namespace belongs to the anchor. That is the whole of the chain's tax, and it
// is paid by the anchor's own run args (agent-sandbox.ts's `sandboxRunArgs`).
export type ContainerAttachment =
  | { readonly kind: "pod"; readonly podName: string }
  | { readonly kind: "netns"; readonly anchorContainerName: string };

// What an attachment is called in an error message.
export function describeAttachment(attach: ContainerAttachment): string {
  return attach.kind === "pod"
    ? `pod ${attach.podName}`
    : `the network namespace of container ${attach.anchorContainerName}`;
}

export function containerRunArgs(opts: {
  readonly containerName: string;
  readonly attach: ContainerAttachment;
  readonly container: ResolvedStackContainer;
  readonly worktreePath: string;
}): string[] {
  const { container: c } = opts;
  const args = [
    "run",
    "-d",
    "--name",
    opts.containerName,
    ...(opts.attach.kind === "pod"
      ? ["--pod", opts.attach.podName]
      : ["--network", `container:${opts.attach.anchorContainerName}`]),
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
    // No `--user`/`--userns`: neither is available in a pod, the image's
    // default user is what the uid preflight checked, and a `netns` joiner
    // deliberately runs the same way — its worktree writes have to land as the
    // invoking user, which under rootless podman is what container root maps
    // to, exactly as in the pod.
    args.push("--entrypoint", "sleep", c.image, "infinity");
  } else {
    args.push(c.image, ...c.args);
  }
  return args;
}

// The image a container should run under a given map (#37). An unmapped
// container runs exactly what its config names, which is every container in
// every stack that declares no `rebuildOn` image.
export function imageFor(
  container: ResolvedStackContainer,
  map: ImageMap,
): string {
  return map.get(container.image) ?? container.image;
}

// The container specs as they should actually run, with images substituted
// where the branch changed one. A pure remap rather than an extra argument on
// every call: `containerRunArgs`, the readiness probes and the bringup error
// messages all read `c.image`, and threading an override past each of them is
// four chances to leave one reading the declared tag.
export function withImages(
  containers: readonly ResolvedStackContainer[],
  map: ImageMap,
): readonly ResolvedStackContainer[] {
  if (map.size === 0) return containers;
  return containers.map((c) => {
    const mapped = map.get(c.image);
    return mapped === undefined || mapped === c.image
      ? c
      : { ...c, image: mapped };
  });
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
  const networkName = networkNameFor(opts.scope, opts.stackId);
  const podName = podNameFor(opts.scope, opts.stackId);
  const nameOf = (c: ResolvedStackContainer): string =>
    stackContainerNameFor(opts.scope, opts.stackId, c.name);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // `pod rm -f` takes the member containers AND the infra container with it.
    // The infra container is named `<pod-id-prefix>-infra`, which matches no
    // sandbar prefix — removing containers by name would leave it, and the pod,
    // behind.
    //
    // Failures here are NOT swallowed. A `pod rm` that fails leaks the pod, its
    // members, that unreachably-named infra container and its network, and the
    // only backstop (`cleanupOrphanContainers`) does not run until the top of
    // the next cycle — so on the last cycle, or on any halt, the leak outlives
    // the process. `-f` on the network too, matching the create path: at this
    // point the pod is meant to be gone and a lingering endpoint is exactly
    // what needs forcing.
    //
    // Bounded through `boundedPodman`, not node's `timeout:` — this is the
    // same green-on-red as everywhere else in this module and it lands
    // precisely on the claim above: node SIGTERMs, podman exits 0, the failure
    // list stays empty, and sandbar reports a clean teardown of a pod that is
    // still running.
    const failures: string[] = [];
    const attempt = async (args: string[]): Promise<void> => {
      const r = await boundedPodman(args, CONTROL_TIMEOUT_MS);
      if (boundedOk(r)) return;
      failures.push(
        `  ${RUNTIME} ${args.join(" ")}\n    ${
          r.timedOut
            ? `timed out after ${CONTROL_TIMEOUT_MS}ms`
            : r.errorMessage
        }`,
      );
    };
    await attempt(POD_RM_ARGS(podName));
    await attempt(["network", "rm", "-f", networkName]);
    if (failures.length > 0) {
      throw new SandbarError(
        `gate stack: teardown of pod '${podName}' / network '${networkName}' ` +
          `failed, leaking podman resources:\n${failures.join("\n")}\n` +
          `Clean up with: ${RUNTIME} ${POD_RM_ARGS(podName).join(" ")} && ` +
          `${RUNTIME} network rm -f ${networkName}`,
      );
    }
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
    //
    // "an older run" is only true because the name carries `opts.scope` (#28).
    // Unscoped, the only namesake a second run against a different repo could
    // find for issue 42 was the FIRST run's live pod, and this line tore it
    // down — the victim just watched its containers disappear mid-gate.
    await boundedPodman(POD_RM_ARGS(podName), CONTROL_TIMEOUT_MS);
    await boundedPodman(
      ["network", "rm", "-f", networkName],
      CONTROL_TIMEOUT_MS,
    );
    await mustSucceed(
      ["network", "create", "--disable-dns", networkName],
      `create network ${networkName}`,
    );
    await mustSucceed(
      podCreateArgs({
        podName,
        networkName,
        publishPorts: tcpProbePorts(opts.spec),
      }),
      `create pod ${podName}`,
    );

    const hostPorts = await readPortBindings(podName);

    const issueContainers = opts.spec.containers.filter(
      (c) => c.lifecycle === "issue",
    );
    // Brought up with the images config NAMES, deliberately, even when some of
    // them are `rebuildOn` images the branch may already have changed (#37).
    // Resolving here would put a per-branch build — which can fail because of
    // the branch — outside every gate run, where its only exit is a throw, i.e.
    // HARD-ERROR: two fresh-stack retries reproducing the same broken lockfile
    // and then `agent-stuck` with an "environment" trace. Leaving it to the
    // first `runGate` gives that failure the one exit that names the branch,
    // and costs at most one extra container start on a resumed issue.
    //
    // Nothing of the branch runs at this point in any case: `resolveGateStack`
    // refuses `lifecycle: "issue"` on an un-held container that mounts the
    // worktree, and a held one's entrypoint is `sleep infinity`.
    const attach: ContainerAttachment = { kind: "pod", podName };

    await bringUpContainers(issueContainers, {
      attach,
      worktreePath: opts.worktreePath,
      nameOf,
      hostPorts,
    });

    const attemptContainers = opts.spec.containers.filter(
      (c) => c.lifecycle === "attempt",
    );

    // What the long-lived containers are currently running, as a tag->tag map
    // in the same shape `opts.images` returns. Mutable and owned by the stack:
    // it is how `runGate` knows which issue containers a changed image leaves
    // stale, and the empty map above is the honest starting value.
    const running = { map: new Map<string, string>() as ImageMap };

    return {
      podName,
      networkName,
      stop,
      runGate: () =>
        runStackGate({
          spec: opts.spec,
          attemptContainers,
          issueContainers,
          attach,
          worktreePath: opts.worktreePath,
          hostPorts,
          nameOf,
          images: opts.images ?? (async () => new Map()),
          running,
        }),
    };
  } catch (err) {
    // The bringup failure is the diagnosis; a teardown failure on top of it is
    // reported but must not replace it.
    await stop().catch((stopErr: unknown) => {
      console.error(
        stopErr instanceof Error ? stopErr.message : String(stopErr),
      );
    });
    throw err;
  }
}

async function readPortBindings(podName: string): Promise<Map<number, number>> {
  const r = await boundedPodman(
    [
      "pod",
      "inspect",
      podName,
      "--format",
      "{{json .InfraConfig.PortBindings}}",
    ],
    LOG_READ_TIMEOUT_MS,
  );
  // A plain Error, deliberately. `SandbarError` is the "operator-actionable,
  // this run cannot proceed" class, and `inner-loop.ts` rethrows it PAST
  // HARD-ERROR — so raising one here for a flaked `pod inspect` would drop that
  // issue for the whole cycle with no terminal, no comment, no label flip and
  // no retry, while leaving it queued to burn another budget next run. Podman
  // failing to answer is infrastructure; HARD-ERROR's fresh stack is the right
  // response. (`parsePortBindings` still raises SandbarError for a shape it
  // cannot parse — that one really is sandbar's bug.)
  if (!boundedOk(r)) {
    throw new Error(
      `gate stack: could not read the port bindings of pod ${podName}` +
        (r.timedOut
          ? ` (${RUNTIME} pod inspect did not return within ` +
            `${LOG_READ_TIMEOUT_MS}ms)`
          : `: ${r.errorMessage}`),
    );
  }
  return parsePortBindings(r.stdout);
}

// Exported since #44: the sandbox stack brings its siblings up through exactly
// this, so the readiness probes, the liveness asserts and the postReadyCommands
// discipline exist once rather than twice. `attach` is the only thing that
// differs between the two callers.
export type BringUpCtx = {
  readonly attach: ContainerAttachment;
  readonly worktreePath: string;
  // Passed as a closure rather than rebuilt from (scope, stackId) here: the
  // name is the stack's identity, and one place composes it.
  readonly nameOf: (c: ResolvedStackContainer) => string;
  readonly hostPorts: ReadonlyMap<number, number>;
};

// Start every container, THEN wait for all of them, then run their post-ready
// setup. Started together because a container only needs the pod to exist, not
// its neighbours to be ready — there is no reason for a frontend that builds
// the app on startup to queue behind a database initialising a schema it never
// reads.
export async function bringUpContainers(
  containers: readonly ResolvedStackContainer[],
  ctx: BringUpCtx,
): Promise<void> {
  for (const c of containers) {
    const containerName = ctx.nameOf(c);
    // A container of this name may survive a crashed run; the sweep covers the
    // usual case but the pod was just recreated, so any leftover is stale.
    //
    // Bounded, and that bound is load-bearing rather than tidy: this remove is
    // the fallback `reapTimedOutStep` leans on when its own remove fails, so an
    // unbounded one here would turn a red gate into a run that hangs forever.
    await boundedPodman(
      ["rm", "-f", "-t", "0", containerName],
      CONTROL_TIMEOUT_MS,
    );
    const started = await boundedPodman(
      containerRunArgs({
        containerName,
        attach: ctx.attach,
        container: c,
        worktreePath: ctx.worktreePath,
      }),
      CONTROL_TIMEOUT_MS,
    );
    if (!boundedOk(started)) {
      throw new ContainerBringupError(
        containerName,
        `gate stack: container '${c.name}' (${c.image}) failed to start: ${
          started.timedOut
            ? `${RUNTIME} run did not return within ${CONTROL_TIMEOUT_MS}ms`
            : started.errorMessage
        }`,
        await logTail(containerName),
      );
    }
  }

  for (const c of containers) {
    await waitForReady(ctx.nameOf(c), c, ctx);
  }

  for (const c of containers) {
    const containerName = ctx.nameOf(c);
    for (const command of c.postReadyCommands) {
      // Bounded by the container's readiness budget: post-ready setup is
      // bringup, and an unbounded exec here hangs the run holding the lock
      // exactly as a hung probe would. `CI=true` is passed for the same
      // reason steps get it — a migration or seed script that branches on it
      // must not see a different environment than the steps that follow.
      const r = await boundedPodman(
        stepExecArgs(containerName, command),
        c.readinessTimeoutMs,
      );
      if (boundedOk(r)) continue;
      // Post-ready setup is part of the container's contract — a failing
      // command means every step runs against a half-initialized service. A
      // command that HANGS is the same thing and used to be worse than a slow
      // one: with node's `timeout:` doing the killing, a seed script that
      // never returned was reported as having succeeded.
      throw new ContainerBringupError(
        containerName,
        `gate stack: postReadyCommand ${JSON.stringify(command)} ` +
          (r.timedOut
            ? `did not finish within the container's ${c.readinessTimeoutMs}ms ` +
              `readiness budget and was killed, in container '${c.name}'. ` +
              "Raise `readinessTimeoutMs` if the setup is genuinely this slow." +
              // Only on this branch: node's own message already ends with the
              // command's stderr, so appending it to the non-timeout branch
              // would print the failure twice.
              (r.stderr.trim() ? `\n${stripAnsi(r.stderr).trim()}` : "")
            : `failed in container '${c.name}': ${r.errorMessage}`),
        await logTail(containerName),
      );
    }
  }
}

// Milliseconds left before `deadline`, floored at 1. The floor mattered more
// when this fed node's `timeout:` option, which reads 0 as "no timeout"; it now
// feeds `boundedPodman`'s own `setTimeout`, where 0 and 1 are both "next tick".
// Kept because a probe budget is meaningfully expressed as at-least-one-tick
// and a 0 would invite the old reading back.
function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function waitForReady(
  containerName: string,
  c: ResolvedStackContainer,
  ctx: BringUpCtx,
): Promise<void> {
  if (c.readiness === null) {
    // No probe was declared, so nothing else ever looks at this container: the
    // loop below is the only site that would, and `throwIfDead` is reachable
    // only from inside it. Skip that and a container whose entrypoint dies at
    // startup passes bringup — `podman run -d` exits 0 for it — and its death
    // is then charged to the branch by every step that talks to it, which is
    // D5's blame mapping running backwards. One grace interval (the container
    // has to get far enough to fail) and then the same liveness assert every
    // probed container gets.
    await sleep(READY_POLL_INTERVAL_MS);
    await throwIfDead(containerName, c);
    return;
  }
  const readiness = c.readiness;
  // Started before the loop and killed in the `finally`: the follower is the
  // one thing here that is unbounded by design, so its bound is this ownership.
  const watcher =
    readiness.kind === "log" ? watchLog(containerName, readiness.pattern) : null;
  try {
    await pollUntilReady(containerName, c, ctx, readiness, watcher);
  } finally {
    watcher?.stop();
  }
}

async function pollUntilReady(
  containerName: string,
  c: ResolvedStackContainer,
  ctx: BringUpCtx,
  readiness: NonNullable<ResolvedStackContainer["readiness"]>,
  watcher: LogWatcher | null,
): Promise<void> {
  const deadline = Date.now() + c.readinessTimeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    // Bounded by what is LEFT of the readiness budget, not by the budget: the
    // loop's `Date.now() < deadline` is only tested between probes, so a single
    // probe that never returns — an `exec` curl against a service that accepts
    // and then never answers, the very accept-first behaviour this module's
    // header documents — hangs the run forever, holding the single-instance
    // lock, with no HARD-ERROR and no teardown. config.ts rejects a NaN
    // readinessTimeoutMs for exactly this hang; a valid one must not reach it.
    const probe = await probeOnce(
      containerName,
      readiness,
      ctx,
      remainingMs(deadline),
      watcher,
    );
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
      `last probe: ${lastErr}${watcher?.deathNote() ?? ""})`,
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
  timeoutMs: number,
  watcher: LogWatcher | null,
): Promise<{ ready: boolean; detail: string }> {
  switch (readiness.kind) {
    case "exec": {
      const r = await boundedPodman(
        ["exec", containerName, ...readiness.argv],
        timeoutMs,
      );
      if (boundedOk(r)) return { ready: true, detail: "" };
      // A probe that never returns is NOT ready, and saying so is the whole
      // point of doing the timing here rather than through node's `timeout:`,
      // which would have killed the client, seen it exit 0, and reported the
      // container ready — an `exec` curl against a service that accepts and
      // then never answers is the exact shape this module's header describes.
      return {
        ready: false,
        detail: r.timedOut
          ? `probe did not return within ${timeoutMs}ms`
          : r.errorMessage,
      };
    }
    case "log": {
      if (watcher === null) {
        // waitForReady starts a follower for every log readiness, so its
        // absence is a sandbar bug. Never a silent unready: that would spend
        // the whole budget and then blame the consumer's pattern.
        throw new SandbarError(
          `gate stack: no log follower for container ${containerName}. ` +
            "waitForReady starts one for every log readiness, so this is an " +
            "internal inconsistency.",
        );
      }
      return watcher.poll();
    }
    case "tcp": {
      const hostPort = ctx.hostPorts.get(readiness.port);
      if (hostPort === undefined) {
        // The publish is derived from this same readiness declaration, so its
        // absence is a sandbar bug, not a consumer one. Never a silent skip:
        // skipping would make "ready" mean "I could not check".
        throw new SandbarError(
          `gate stack: no host publish for container port ${readiness.port} on ` +
            `${describeAttachment(ctx.attach)}. A publish is created for every ` +
            "tcp readiness port, so this is an internal inconsistency.",
        );
      }
      return probeTcp(hostPort, timeoutMs);
    }
  }
}

// The follower's argv. `-f` from the container's first log line, never a
// `--tail`/`--since` window: a window can only be justified by a bound on how
// far back the pattern might be, and there is none — a container that printed
// "ready" before the first poll is the ordinary case, not an edge one.
export function logFollowArgs(containerName: string): string[] {
  return ["logs", "-f", containerName];
}

// Scan one chunk of a followed stream for the pattern, carrying whatever suffix
// could still be the head of a match into the next chunk.
//
// The carry is the whole point. A followed stream splits a line wherever the
// driver feels like it — `podman logs -f` under `k8s-file` emits an
// unterminated partial line as its own chunk, verified in
// gate-stack-podman.test.ts — so a per-chunk `includes` alone never sees a
// pattern written as `PAR` then `TIAL`, and reports a timeout against a
// container that printed exactly what was asked for.
//
// `pattern.length - 1` code units is exactly the right amount to keep and no
// more: a match straddling the boundary can overlap the previous chunk by at
// most that, and keeping more is the unbounded retention this whole change
// exists to remove. Code units, not bytes — the caller decodes before it gets
// here, which it must (see watchLog), so a chunk boundary in the middle of a
// multi-byte character is not this function's problem to solve.
export function scanChunk(
  carry: string,
  chunk: string,
  pattern: string,
): { found: boolean; carry: string } {
  const text = carry + chunk;
  if (text.includes(pattern)) return { found: true, carry: "" };
  // `<= 0`, not `=== 0`: an empty pattern makes this -1, and `slice(1)` would
  // grow the carry without bound forever. config.ts rejects an empty pattern
  // and `includes("")` returns above, so this is unreachable through sandbar —
  // but an exported pure function defends itself rather than relying on that.
  const keep = Math.min(pattern.length - 1, text.length);
  return { found: false, carry: keep <= 0 ? "" : text.slice(-keep) };
}

// How much of a follower's stderr is kept to explain its death. `podman logs`
// writes podman's OWN diagnostics and the container's stderr to one fd, so this
// is a tail of whichever spoke last — on a non-zero exit that is overwhelmingly
// podman, which is the case worth explaining.
const FOLLOWER_ERR_TAIL = 500;

// A running `podman logs -f`, scanning for the readiness pattern as the log
// arrives. Owned by waitForReady, which kills it on every path out.
export type LogWatcher = {
  readonly poll: () => { ready: boolean; detail: string };
  // What has gone wrong with the follower itself, for the timeout message.
  // Separate from `poll`'s detail because a death is overwritten within one
  // poll: the restart succeeds, the next poll says "pattern not in log yet",
  // and an intermittently-dying follower would otherwise leave no trace at all
  // in the error the operator reads.
  readonly deathNote: () => string;
  readonly stop: () => void;
};

export function watchLog(containerName: string, pattern: string): LogWatcher {
  let found = false;
  let child: ChildProcess | null = null;
  let lastDeath = "";
  let deaths = 0;
  let stopped = false;

  const start = (): void => {
    // Decoders and carries are per-START, not per-watcher: a restart re-reads
    // the log from the beginning, so anything they held is about to arrive
    // again.
    //
    // StringDecoder, not `chunk.toString("utf8")`: a chunk boundary can fall
    // INSIDE a multi-byte character, and decoding each chunk independently
    // replaces both halves with U+FFFD before scanChunk ever sees them — so the
    // carry preserves corrupted text and the pattern is missed. That is not
    // exotic for the container this feature is aimed at: Next.js prints
    // "✓ Ready in" and Vite prints "➜  Local:", and either is a natural
    // readiness pattern. The failure would be silent and reported as "pattern
    // not in log yet", which is the exact misdirection #31 exists to remove.
    const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
    let outCarry = "";
    let errCarry = "";
    let errTail = "";
    // stdin is never written to, so don't allocate a pipe for it.
    const ch = spawn(RUNTIME, logFollowArgs(containerName), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = ch;
    // Scanned per stream rather than on a concatenation of the two. `podman
    // logs` keeps the container's stdout and stderr separate (verified), so
    // joining them manufactures a seam that no reader of the log would ever
    // see and that a pattern could straddle.
    ch.stdout?.on("data", (b: Buffer) => {
      const r = scanChunk(outCarry, decoders.out.write(b), pattern);
      outCarry = r.carry;
      if (r.found) found = true;
    });
    ch.stderr?.on("data", (b: Buffer) => {
      const text = decoders.err.write(b);
      errTail = (errTail + text).slice(-FOLLOWER_ERR_TAIL);
      const r = scanChunk(errCarry, text, pattern);
      errCarry = r.carry;
      if (r.found) found = true;
    });
    ch.on("error", (err: Error) => {
      // Node emits this when the process could not be spawned OR could not be
      // killed, so the process may still be alive. Dropping the handle would
      // leak a follower `stop` can no longer reach, so kill first and only then
      // let go of it.
      if (child === ch) {
        ch.kill("SIGKILL");
        child = null;
      }
      deaths += 1;
      lastDeath = `could not run ${RUNTIME} logs (${err.message})`;
    });
    // An 'error' on a child's stdio stream is an UNHANDLED event otherwise, and
    // an unhandled event takes the whole run down — a readiness follower must
    // never be able to do that. The handle is dropped here as well: a stream
    // that has errored delivers nothing more, and if the process happens to
    // survive it, leaving `child` set would leave the watcher permanently blind
    // AND permanently silent, reporting "pattern not in log yet" for the rest
    // of the budget. That is the failure #31 is about, so it must not be
    // reachable through the fix for it. Never swallowed: it is counted and
    // reported through deathNote.
    for (const stream of [ch.stdout, ch.stderr]) {
      stream?.on("error", (err: Error) => {
        if (child === ch) {
          ch.kill("SIGKILL");
          child = null;
        }
        deaths += 1;
        lastDeath = `${RUNTIME} logs stream failed (${err.message})`;
      });
    }
    // `close`, not `exit`: `exit` fires when the process ends, which can be
    // before its stdout has delivered everything it read. `close` waits for the
    // stdio streams too, so a container that prints the pattern and exits in
    // the same breath still has that chunk scanned before the follower counts
    // as gone — and before the poll that would restart it.
    ch.on("close", (code: number | null) => {
      if (child === ch) child = null;
      if (stopped) return;
      deaths += 1;
      lastDeath =
        code === 0
          ? "log stream ended"
          : `${RUNTIME} logs exited ${String(code)}` +
            (errTail.trim() ? `: ${errTail.trim()}` : "");
    });
  };

  start();

  return {
    poll: () => {
      if (found) return { ready: true, detail: "" };
      if (child === null && !stopped) {
        // Restart rather than latch unready. `podman logs -f` ends when the
        // CONTAINER ends, and it can also die of a podman hiccup — under the
        // old re-read both became a permanent "logs unavailable" (#31). Re-
        // reading from the start is idempotent for a substring test, so the
        // only cost is the reread, and the poll interval rate-limits it.
        //
        // It can still restart for the whole budget, but only for a container
        // whose state podman will not report: `throwIfDead` ends the wait for
        // one that EXITED and, since #36, for one that was REMOVED, leaving
        // only `unknown` to poll to the deadline — podman refusing to answer,
        // or answering that the container is there while inspect still cannot
        // say whether it is running. That is the right trade, since the
        // alternative is treating a flaked podman as a corpse, and deathNote is
        // what stops it being mysterious: the timeout says podman kept dying on
        // this container rather than blaming the consumer's pattern.
        const detail = lastDeath;
        start();
        return { ready: false, detail };
      }
      return { ready: false, detail: "pattern not in log yet" };
    },
    deathNote: () =>
      deaths === 0
        ? ""
        : `; log follower died ${deaths}x, last: ${lastDeath}`,
    stop: () => {
      stopped = true;
      // SIGKILL: there is nothing to flush, and a follower that ignored SIGTERM
      // would outlive the run holding a pipe to a container being torn down.
      child?.kill("SIGKILL");
      child = null;
    },
  };
}

// Connect, then require the socket to stay open (see the header): the rootless
// port forwarder accepts at the host before it learns the backend is refusing,
// so "connected" alone is not a listener.
function probeTcp(
  hostPort: number,
  timeoutMs: number,
): Promise<{ ready: boolean; detail: string }> {
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
    // A dropped SYN produces neither `connect` nor `error` — the socket just
    // sits there. Without this the probe never resolves and `waitForReady`
    // never regains control to notice its deadline passed.
    socket.setTimeout(timeoutMs, () =>
      finish(false, `no response within ${timeoutMs}ms`),
    );
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

// What podman says about a container right now.
//
// `unknown` means the question could not be answered, and is never evidence
// either way: read as death it would report a live container as a corpse,
// which is a HARD-ERROR from `assertIssueContainersAlive` and a bringup failure
// from `throwIfDead` — a slow host turned into a retry storm. It has two
// producers, and the second is the one worth naming: podman would not answer at
// all, OR it answered that the container EXISTS while `inspect` still could not
// say whether it is running. The latter is a real pairing (a 15s inspect
// timeout under load, a cheap `exists` answering 0) and it is the case the
// follower-restart trade in `watchLog` leans on.
//
// `gone` is the state this used to lose (#36). A container that no longer
// EXISTS is the strongest evidence of death there is, but `inspect` reports it
// with the same exit 125 as a podman that is merely unwell, so a single inspect
// collapses it into `unknown` and the one check whose job is to catch it waves
// it through. It is not exotic: an operator's `podman rm` on a wedged stack, a
// `podman system prune`, an OOM kill under a removing restart policy, and —
// since #26 — `reapKilledStep` itself.
export type ContainerState = "running" | "stopped" | "gone" | "unknown";

// The seam these liveness reads are tested through. `containerState`'s whole
// job is to classify what podman answers, and the answers that matter most are
// the ones a real podman will not produce on demand — a timed-out inspect, a
// kill, an exit code `exists` does not document. Every other podman call in
// this module is exercised against a live podman in gate-stack-podman.test.ts;
// this one branch cannot be, and it is the branch whose misfire is a
// HARD-ERROR storm, so it gets an injectable probe instead (the same argument
// `realVerifyAdapter`'s `exec` and `checkWorktreeImageUids`' `UidProbe` make).
export type PodmanProbe = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<BoundedResult>;

// Does this container exist at all, in any state? Exit 1 and nothing else: 0
// means it is there, and a timeout, a kill, or an exit code `exists` does not
// document is podman being unreliable. The point is to shrink `unknown`
// honestly, not to let failure fall through to death.
async function containerGone(
  containerName: string,
  probe: PodmanProbe,
): Promise<boolean> {
  const e = await probe(
    ["container", "exists", containerName],
    LOG_READ_TIMEOUT_MS,
  );
  return e.exitCode === 1 && !e.timedOut && !e.maxBufferExceeded;
}

// What `logTail` puts in the tail slot for a container that is not there.
// Skipping the read is not just an optimisation: `logs` against a removed
// container fails, and the "(logs unavailable)" that produces reads as "the log
// could not be retrieved" and sends the reader looking for a log that does not
// exist. Phrased to sit under `ContainerBringupError`'s "Container log tail:"
// header without contradicting it.
const GONE_LOG_NOTE = "(none — the container no longer exists)";

export async function containerState(
  containerName: string,
  probe: PodmanProbe = boundedPodman,
): Promise<ContainerState> {
  const r = await probe(
    ["inspect", "--format", "{{.State.Running}}", containerName],
    LOG_READ_TIMEOUT_MS,
  );
  if (boundedOk(r)) return r.stdout.trim() === "true" ? "running" : "stopped";
  // Only when inspect RETURNED and said no. An inspect that timed out or was
  // killed is podman being unresponsive, not podman answering ambiguously —
  // `exists` would be asked to answer through the same wedged podman, and the
  // classification is `unknown` whatever it says. Skipping it there keeps this
  // function's worst case at one LOG_READ_TIMEOUT_MS rather than two, which
  // matters because `pollUntilReady` only tests its deadline BETWEEN probes:
  // doubling the worst case would double how far a readiness wait overshoots
  // its budget and halve how many polls a 60s budget buys.
  if (r.timedOut || r.maxBufferExceeded || r.exitCode === null) return "unknown";
  // Inspect exited non-zero on its own. That is 125 both for a container that
  // is GONE and for a podman that is unwell, so ask the question podman has a
  // purpose-built answer for rather than matching its stderr: the wording
  // differs per subcommand (`inspect` says "no such object", the exec family
  // says "no container with name or ID ... found"), so a string test would be
  // both fragile and version-bound. One extra call, only on a path where
  // inspect already failed — which in the ordinary case is never.
  return (await containerGone(containerName, probe)) ? "gone" : "unknown";
}

async function throwIfDead(
  containerName: string,
  c: ResolvedStackContainer,
): Promise<void> {
  const state = await containerState(containerName);
  // A flaked inspect is not evidence of death; let the deadline arbitrate.
  if (state === "running" || state === "unknown") return;
  throw new ContainerBringupError(
    containerName,
    state === "gone"
      ? `gate stack: container '${c.name}' (${c.image}) no longer exists — ` +
        "something removed it during startup."
      : `gate stack: container '${c.name}' (${c.image}) exited during startup.`,
    state === "gone" ? GONE_LOG_NOTE : await logTail(containerName),
  );
}

export async function logTail(
  containerName: string,
  lines = CONTAINER_LOG_TAIL,
): Promise<string> {
  // MAX_BUFFER, not node's 1MB default: `--tail 40` bounds the LINE count, not
  // the byte count, and 40 lines of a JSON dump or a minified bundle overflows
  // it — losing the one diagnostic D9 exists to provide, precisely when the log
  // is biggest.
  const r = await boundedPodman(
    ["logs", "--tail", String(lines), containerName],
    LOG_READ_TIMEOUT_MS,
  );
  const text = stripAnsi(`${r.stdout}${r.stderr}`).trim();
  // A timed-out read keeps whatever it got — this is the diagnostic a hung
  // step's trace leans on entirely, so half of it beats none — but says that
  // it is partial, because a tail silently cut short reads as a log that just
  // stopped.
  if (r.timedOut) {
    const note =
      `(log read timed out after ${LOG_READ_TIMEOUT_MS}ms; this tail may be ` +
      "incomplete)";
    return text ? `${text}\n${note}` : note;
  }
  // "(logs unavailable)" reads as "the log could not be retrieved", which is
  // the wrong thing to hand an implementer agent reading a red gate's D9 block
  // about a container that is simply not there any more. The extra call is on a
  // path where `logs` has already failed, so it costs nothing in the ordinary
  // case. (`throwIfDead` and `assertIssueContainersAlive` do not reach this:
  // they already know the state and pass GONE_LOG_NOTE without reading.)
  if (!boundedOk(r)) {
    return (await containerGone(containerName, boundedPodman))
      ? GONE_LOG_NOTE
      : "(logs unavailable)";
  }
  return text || "(empty)";
}

// ---------------------------------------------------------------------------
// The gate run
// ---------------------------------------------------------------------------

type RunGateCtx = {
  readonly spec: ResolvedGateStack;
  readonly attemptContainers: readonly ResolvedStackContainer[];
  readonly issueContainers: readonly ResolvedStackContainer[];
  readonly attach: ContainerAttachment;
  readonly worktreePath: string;
  readonly hostPorts: ReadonlyMap<number, number>;
  readonly nameOf: (c: ResolvedStackContainer) => string;
  readonly images: () => Promise<ImageMap>;
  // Mutable, owned by `startStack`: what the issue containers are running now.
  readonly running: { map: ImageMap };
};

// The long-lived half of the stack, re-checked before every gate run.
//
// `lifecycle` was consulted only at bringup, which made the blame mapping hold
// for exactly as long as the first attempt. A database OOM-killed (or left dead
// by a host suspend, or removed out from under the run) at attempt 4 is still
// an INFRA failure, but every later step fails talking to it, so the gate reds,
// the implementer is asked to fix a service it never touched, the rest of the
// budget burns against a corpse and the run lands on NEEDS-HUMAN with an
// "environment" trace. That is D5 running backwards, and the fix is to ask.
// Throwing (rather than reddening) puts it back on the HARD-ERROR path, where
// the outer layer retries with a fresh stack.
//
// "Ask" has to mean a question podman can answer about a container that is not
// there (#36): a removed one used to be indistinguishable from a flaked inspect
// and was waved through, which is the exact failure above reached through the
// check meant to prevent it.
//
// Residual, stated rather than hidden: this runs ONCE per gate run (just after
// the per-branch image recreate, for the reason given at the call site). An
// issue container that dies after it and before step N still reds that
// gate against the branch — the misblame is narrowed from "every remaining
// attempt" to "exactly one", not eliminated. Re-checking between steps would
// cost a podman call per step per gate run to shave one attempt off a failure
// that is already rare, and would still leave a window inside the step itself.
async function assertIssueContainersAlive(ctx: RunGateCtx): Promise<void> {
  for (const c of ctx.issueContainers) {
    const containerName = ctx.nameOf(c);
    const state = await containerState(containerName);
    if (state === "running" || state === "unknown") continue;
    // The two death states get different prose because they imply different
    // next steps: a stopped container is still there to be inspected and its
    // log read, whereas a removed one cannot be looked at at all and the
    // operator's question is who removed it. Reporting a removal as "no longer
    // running" sends them to `podman logs` for a container that answers "no
    // container with name or ID ... found".
    const what =
      state === "gone"
        ? "no longer exists — someone or something removed it"
        : "is no longer running";
    throw new ContainerBringupError(
      containerName,
      // The image it is actually RUNNING, which since #37 is not always the one
      // config names — sending the operator to inspect the declared tag when a
      // per-branch variant is what died is a wrong answer to the first question
      // they will ask.
      `gate stack: issue-lifecycle container '${c.name}' ` +
        `(${imageFor(c, ctx.running.map)}) ${what}. ` +
        "It came up once for this issue and every attempt since has depended " +
        "on it, so this is an infrastructure failure and not a verdict about " +
        "the branch.",
      state === "gone" ? GONE_LOG_NOTE : await logTail(containerName),
    );
  }
}

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

  // Which images this commit should be gated with (#37). After the cheap
  // checks above — a dirty tree gets no verdict at all, so there is no reason
  // to pay a build for it — and before any container is created.
  //
  // A build that fails is a RED GATE, not an infrastructure failure, and this
  // is the same argument D5 makes about `attempt` containers: the image is a
  // function of the branch, so a lockfile that does not install is the branch's
  // to fix. Routed to HARD-ERROR it would buy two fresh-stack retries that
  // reproduce it exactly and then park the issue with a trace blaming the
  // environment for a dependency the agent chose.
  let images: ImageMap;
  try {
    images = await ctx.images();
  } catch (err) {
    if (err instanceof ImageBuildError) {
      return {
        ok: false,
        stdout: "",
        stderr:
          `Refusing to gate: image '${err.tag}' could not be built from this ` +
          "worktree. It declares `rebuildOn` paths that this branch changed, " +
          "so the gate needs an image built from the branch's own " +
          "dependencies and this branch does not produce one.\n\n" +
          err.message,
        exitCode: 1,
        failedStep: `image:${err.tag}`,
        // Deliberately empty. D9 collects container logs because the diagnosis
        // of a failing step is often in a container the step never touched;
        // here nothing has run yet and the build's own output is the whole
        // diagnosis, already above.
        containerLogs: "",
      };
    }
    throw err;
  }

  // The `issue` containers are normally NOT recreated — that is the whole point
  // of the lifecycle — but one whose image the branch just changed is running
  // the wrong bytes, which is the same staleness the recreate-every-run rule
  // below exists to prevent one level down. Its bringup failure is a red rather
  // than a HARD-ERROR, and that is a deliberate exception to D5: D5 maps
  // `issue` to infra because such a container depends only on image + env, and
  // an image the branch authored is precisely where that stops being true.
  const staleIssueContainers = ctx.issueContainers.filter(
    (c) => imageFor(c, images) !== imageFor(c, ctx.running.map),
  );
  if (staleIssueContainers.length > 0) {
    try {
      await bringUpContainers(withImages(staleIssueContainers, images), {
        attach: ctx.attach,
        worktreePath: ctx.worktreePath,
        nameOf: ctx.nameOf,
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
    // Only after they are actually up. A failed recreate leaves the previous
    // map in place so the NEXT gate run recreates them again rather than
    // recording a state the containers never reached — which is also what keeps
    // `assertIssueContainersAlive` honest below: `bringUp` removes before it
    // creates, so a recreate that died left the container GONE, and a run that
    // reported that as an infrastructure death would be blaming the environment
    // for a container sandbar removed on the branch's behalf.
    ctx.running.map = images;
  }

  // Deliberately OUTSIDE the try blocks that convert bringup failures to a gate
  // red: a dead issue container must reach the caller as a throw.
  //
  // After the recreate above, not before it. Ordered the other way, a container
  // the previous gate run removed and failed to recreate reads as "it came up
  // once and something killed it" — an infra HARD-ERROR — when the truth is
  // that the branch's own image would not start and this run was about to try
  // again. What it still catches is unchanged: a container nothing here touched
  // that died on its own between gate runs.
  await assertIssueContainersAlive(ctx);

  // Recreated every gate run: they mount the worktree and run the branch's
  // code, so reusing one would gate an earlier attempt's process against a
  // later attempt's source.
  try {
    await bringUpContainers(withImages(ctx.attemptContainers, images), {
      attach: ctx.attach,
      worktreePath: ctx.worktreePath,
      nameOf: ctx.nameOf,
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
    const r = await boundedPodman(
      stepExecArgs(containerName, step.command),
      step.timeoutMs,
    );
    if (boundedOk(r)) {
      stdout += banner + stripAnsi(r.stdout);
      stderr += stripAnsi(r.stderr);
      continue;
    }

    // Named, because otherwise the two kills below are indistinguishable from
    // an ordinary red: node reports a maxBuffer kill with a STRING code, so it
    // would land as a plain `exitCode: 1` with silently truncated output — a
    // verbose but PASSING suite reading as a real, unexplained failure that
    // reproduces identically every attempt until the budget dies — and a
    // timeout arrives with no output and no exit code at all.
    const note = r.timedOut
      ? `\n\n[sandbar] step '${step.name}' was still running after ` +
        `${step.timeoutMs}ms and was killed (this step's \`timeoutMs\`, or ` +
        "sandbar's default for one). A step that exceeds its bound is a red " +
        "gate, not an infrastructure failure: the usual cause is the branch's " +
        "own code — a test awaiting a promise that never resolves, a suite " +
        "whose reporter never exits. The step's own output above is only what " +
        "it had flushed before the kill and is often empty, so the diagnosis " +
        "is usually in the container logs. Raise `timeoutMs` for this step if " +
        "the work is genuinely this slow.\n"
      : r.maxBufferExceeded
        ? `\n\n[sandbar] step '${step.name}' produced more than ` +
          `${MAX_BUFFER} bytes of output and was killed; the output above is ` +
          "truncated and the exit code is unknown. This is an output-volume " +
          "failure, not necessarily a test failure — quieten the step's " +
          "reporter.\n"
        : "";

    // Stop at the first red. Every later step tends to read what an earlier
    // one built, so running them would bury the real failure under derived
    // ones: a test suite that fails because the build step before it never
    // produced anything reports N failures that are all one failure.
    //
    // The container logs are collected BEFORE the reap below — removing the
    // container first would throw away the one diagnostic a hang leaves.
    const red = await withContainerLogs(
      {
        ok: false,
        stdout: stdout + banner + stripAnsi(r.stdout) + note,
        stderr: stderr + stripAnsi(r.stderr),
        // 124 is GNU `timeout`'s convention, and the alternative is worse than
        // arbitrary: a killed process has no exit code, so the honest-looking
        // `1` is indistinguishable from a suite that ran and failed once.
        exitCode: r.timedOut ? 124 : (r.exitCode ?? 1),
        failedStep: step.name,
        containerLogs: "",
      },
      ctx,
    );
    // Both kills leave the work running inside the container — node SIGTERMs
    // the client for a maxBuffer overflow exactly as the timer does, and podman
    // exits 0 either way — so both reap. An ordinary non-zero exit does not:
    // the process is already gone.
    if (r.timedOut || r.maxBufferExceeded) {
      await reapKilledStep(container, containerName, ctx, red.failedStep ?? "");
    }
    return red;
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

// Kill the work a killed step left running inside its container (#26).
//
// The `podman exec` client is dead by the time this runs, and that is all the
// kill accomplished: the process it started keeps running in the container
// (pinned in gate-stack-podman.test.ts, for both the timer's SIGKILL and the
// SIGTERM node sends on a maxBuffer overflow). Leaving it there means a wedged
// suite burning CPU beside the next attempt's gate and, for anything stateful,
// skewing what that gate measures — the failure the timeout was supposed to
// END, made quieter rather than fixed.
//
// The container is the only handle that is total. Killing the process directly
// would mean either a `kill` binary in an image sandbar does not control, or
// matching argv against `podman top` output and walking its PPID column — both
// of which fail exactly where a hang is most likely, on a test runner that has
// spawned children of its own.
async function reapKilledStep(
  container: ResolvedStackContainer,
  containerName: string,
  ctx: RunGateCtx,
  stepName: string,
): Promise<void> {
  const removed = await boundedPodman(
    ["rm", "-f", "-t", "0", containerName],
    LOG_READ_TIMEOUT_MS,
  );
  if (!boundedOk(removed)) {
    // Not fatal, and not silent. The verdict is already decided, and the next
    // gate run force-removes this container by name before recreating it — a
    // remove that is itself bounded, so this tolerance cannot become a hang —
    // so throwing here would trade a red gate for a HARD-ERROR over a leftover
    // that clears itself. But a survivor burns CPU until then, so say so.
    // For an `issue` container it does not even reach the next run: the
    // recreate below force-removes this name before running, so a remove that
    // failed here fails there too and takes the run down with a bringup error
    // rather than silently gating against a survivor.
    const why = removed.timedOut
      ? `\`${RUNTIME} rm\` timed out`
      : removed.stderr.trim() || removed.errorMessage;
    console.error(
      `gate stack: could not remove container '${containerName}' after its ` +
        "step timed out, so the timed-out work may still be running inside " +
        `it: ${why}`,
    );
  }
  // An `attempt` container is recreated by the next gate run anyway. An
  // `issue` one is not, so it is put back here.
  //
  // Be precise about what that prevents. Until #36 the answer was "the gate
  // going red against the branch": `assertIssueContainersAlive` could not see a
  // REMOVED container at all, so every later step targeting it exited 125 and
  // reddened the gate, D5's blame mapping running backwards for a container
  // sandbar itself removed. That check now catches it — which makes the
  // recreate here an optimisation rather than the only thing standing between
  // this reap and a misattributed verdict, but an optimisation worth keeping:
  // the alternative is throwing away a working stack and the rest of the
  // issue's attempts on a HARD-ERROR, for a container we know exactly how to
  // put back.
  //
  // The cost is more than the re-run of `postReadyCommands`: everything the
  // container accumulated beyond its declared setup goes with it — a schema an
  // earlier gate step migrated, rows an earlier attempt wrote, fixtures
  // uploaded into it. A held `issue` container is the only home for per-issue
  // setup, so consumers are invited to keep exactly that state there. Losing it
  // is still better than the alternatives: leaving a runaway inside it for the
  // rest of the issue, or reporting a red the branch cannot act on.
  if (container.lifecycle !== "issue") return;
  try {
    // `ctx.running.map`, not the declared spec and not a fresh `ctx.images()`.
    // The declared spec is #37 reintroduced through the one bringup that
    // neither precedes nor follows a `running.map` update: a container recreated
    // from the base image while the map still says it is on the branch's
    // variant is never seen as stale again, so every remaining attempt gates
    // against the source branch's dependencies — silently, green included. And
    // it must be the map as it STANDS: this is a restore of what was running,
    // not a new resolution, and re-resolving mid-red would pay a build for a
    // gate whose verdict is already decided.
    await bringUpContainers(withImages([container], ctx.running.map), {
      attach: ctx.attach,
      worktreePath: ctx.worktreePath,
      nameOf: ctx.nameOf,
      hostPorts: ctx.hostPorts,
    });
  } catch (err) {
    // Deliberately not swallowed, even though it costs the red gate we were
    // about to return: a stack whose issue container will not come back up IS
    // an infrastructure failure, and HARD-ERROR retries it on a fresh stack.
    //
    // This is the one exception to "a step timeout is always a gate red", and
    // it is stated rather than hidden: on this path the step name, the bound
    // and the D9 container logs are all discarded in favour of the bringup
    // error, so the line below is what connects the two for whoever reads the
    // run's output.
    console.error(
      `gate stack: step '${stepName}' was killed in issue-lifecycle container ` +
        `'${container.name}', and recreating that container failed. The gate's ` +
        "verdict is being discarded in favour of the bringup failure below.",
    );
    throw err;
  }
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
