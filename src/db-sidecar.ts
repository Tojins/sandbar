// Per-issue DB sidecar (config-driven; #20).
//
// Each issue's inner-loop owns a dedicated podman network and one database
// container whose recipe — image, env, port, readiness probe, init mounts,
// post-ready setup — comes entirely from `config.dbSidecar`. Sandbar owns only
// the lifecycle: network, pinned IP, naming, teardown. The gate container
// joins the network at run-time and reaches the sidecar by a PINNED IP — not
// by container name. One DB startup per issue, reused across every gate-1
// attempt and gate-2.
//
// Why a pinned IP and not name resolution (#18): name lookups on a rootless
// podman bridge are served by aardvark-dns, which netavark launches via the
// systemd *user* bus. On WSL2 that bus dies across suspend/resume, leaving the
// bridge resolver a black hole — every gate db lookup then hangs on EAI_AGAIN
// even though the DB is Up. So the network is created with `--disable-dns` (no
// aardvark dependency at all) and the DB is launched on a fixed `--ip`; the
// gate connects to that IP with zero name resolution. The subnet is left to
// podman's IPAM rather than pinned, because issues run in PARALLEL (one
// network each): a single hard-coded subnet would collide across the
// concurrent per-issue networks. IPAM hands out non-overlapping subnets; we
// read the gateway back and derive the DB's address from it (`dbIpForGateway`).
//
// initMounts resolve against the WORKTREE the run is gating (`cfg.worktreePath`
// — the issue worktree in the inner loop, the merger worktree for gate-2),
// mounted read-only, so a branch that edits its schema fixture gates against
// its own version. This is a convention, not a jail: `..` and absolute
// hostPaths are honored (consumer config is trusted). Callers must create the
// worktree BEFORE starting the sidecar: bind-mount sources are read at
// container start.
//
// Naming uses the issue id (`sandbar-db-<id>`, `sandbar-net-<id>`). Containers
// from pre-#20 builds were `sandbar-pg-<id>` — still reaped by the orphan
// sweeper, which matches the bare `sandbar-` prefix. The orchestrator holds a
// single-instance lock, so the id collides only with stale resources from a
// prior aborted run — those are swept by cleanupOrphanContainers() at start.
//
// Lifecycle ownership lives here: startDbSidecar registers its own teardown
// with onCleanup() before creating any resource, so a signal during bringup
// is covered. Callers do not need to re-register `sidecar.stop` (the flag in
// stop makes a double-register a harmless no-op regardless).

import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import { onCleanup } from "./cleanup.js";
import type { ResolvedDbSidecarConfig } from "./config.js";
import { RESOURCE_PREFIX } from "./naming.js";

const exec = promisify(execFile);

export const RUNTIME = "podman";
export const READY_POLL_INTERVAL_MS = 500;
// Log tail surfaced when the sidecar container dies during bringup — enough
// for the fatal line of a typical entrypoint error without flooding the trace.
const DEAD_CONTAINER_LOG_TAIL = 15;

export type SidecarConfig = {
  readonly issueId: string;
  readonly spec: ResolvedDbSidecarConfig;
  // Worktree the spec's initMounts resolve against. Must exist (with its
  // files) before this call — bind-mount sources are read at container start.
  readonly worktreePath: string;
};

export type Sidecar = {
  readonly networkName: string;
  readonly containerName: string;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly stop: () => Promise<void>;
};

export function networkNameFor(issueId: string): string {
  return `${RESOURCE_PREFIX}net-${issueId}`;
}

export function containerNameFor(issueId: string): string {
  return `${RESOURCE_PREFIX}db-${issueId}`;
}

// Derive the DB's pinned address from the network gateway podman/IPAM
// assigned. The gateway is the subnet's `.1`; the DB takes the next host
// (`.2`), which is always inside the subnet for the /24s podman's default pool
// hands out. Pure and total over a well-formed IPv4 gateway; throws loudly
// otherwise rather than handing the gate a bogus DB_HOST that would fail
// opaquely later.
export function dbIpForGateway(gateway: string): string {
  const parts = gateway.split(".");
  const last = Number(parts[3]);
  if (
    parts.length !== 4 ||
    !parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255) ||
    !Number.isInteger(last) ||
    last > 253
  ) {
    throw new Error(`cannot derive a db IP from gateway "${gateway}"`);
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.${last + 1}`;
}

// Create the per-issue network `--disable-dns` (no aardvark; see header). A
// namesake surviving from an older sandbar build may be DNS-enabled or
// otherwise stale, and we must never reuse it — so force-remove any leftover
// first, then create fresh. `network rm -f` no-ops when absent, so this is the
// recreate-once migration and the first-time create in one idempotent step. No
// container is attached yet at this point, so the force-remove is safe.
async function createDnslessNetwork(networkName: string): Promise<void> {
  await exec(RUNTIME, ["network", "rm", "-f", networkName]).catch(() => {});
  await exec(RUNTIME, ["network", "create", "--disable-dns", networkName]);
}

// Read back the IPv4 gateway IPAM assigned to the freshly-created network.
// Default podman networks carry exactly one IPv4 subnet, so the range template
// yields a single gateway. Empty output means no subnet was allocated — a hard
// failure, since the DB can't be pinned without one.
async function networkGateway(networkName: string): Promise<string> {
  const { stdout } = await exec(RUNTIME, [
    "network",
    "inspect",
    networkName,
    "--format",
    "{{range .Subnets}}{{.Gateway}}{{end}}",
  ]);
  const gateway = stdout.trim();
  if (!gateway) {
    throw new Error(`network ${networkName} has no IPv4 gateway to pin the db against`);
  }
  return gateway;
}

// One `-v` volume spec for an init mount. Relative hostPaths resolve against
// the worktree; absolute pass through. Always read-only. Podman's `-v` syntax
// is colon-delimited with no escape mechanism, so a colon in either path would
// silently re-split the spec — reject it loudly instead.
export function initMountSpec(
  worktreePath: string,
  mount: { readonly hostPath: string; readonly containerPath: string },
): string {
  const hostPath = isAbsolute(mount.hostPath)
    ? mount.hostPath
    : resolve(worktreePath, mount.hostPath);
  if (hostPath.includes(":") || mount.containerPath.includes(":")) {
    throw new Error(
      `initMounts paths must not contain ":" (podman -v specs are colon-delimited): ` +
        `${hostPath} -> ${mount.containerPath}`,
    );
  }
  return `${hostPath}:${mount.containerPath}:ro`;
}

// The full `podman run` argv (sans the runtime itself) for the sidecar
// container. Pure over its inputs so the flag assembly — env, mounts, image
// CMD args AFTER the image ref — is table-testable.
export function sidecarRunArgs(opts: {
  readonly containerName: string;
  readonly networkName: string;
  readonly dbHost: string;
  readonly spec: ResolvedDbSidecarConfig;
  readonly worktreePath: string;
}): string[] {
  const { spec } = opts;
  return [
    "run",
    "-d",
    "--name",
    opts.containerName,
    "--network",
    opts.networkName,
    "--ip",
    opts.dbHost,
    ...Object.entries(spec.containerEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...spec.initMounts.flatMap((m) => ["-v", initMountSpec(opts.worktreePath, m)]),
    spec.image,
    ...spec.containerArgs,
  ];
}

export async function startDbSidecar(cfg: SidecarConfig): Promise<Sidecar> {
  const { spec } = cfg;
  const networkName = networkNameFor(cfg.issueId);
  const containerName = containerNameFor(cfg.issueId);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await exec(RUNTIME, ["rm", "-f", containerName]);
    } catch {
      /* best-effort */
    }
    try {
      await exec(RUNTIME, ["network", "rm", networkName]);
    } catch {
      /* best-effort */
    }
  };
  // Register the teardown before the first `exec`, so a SIGINT/SIGTERM landing
  // anywhere in the bringup window below — network create, the detached `run`,
  // or the readiness poll — still sweeps whatever resources exist. The local
  // catch only fires for JS throws; signal-driven process.exit does not unwind
  // it. `stop` is idempotent (stopped flag) and best-effort, so registering it
  // before either resource exists is safe — the `rm`s no-op.
  onCleanup(stop);

  await createDnslessNetwork(networkName);
  const dbHost = dbIpForGateway(await networkGateway(networkName));

  try {
    await exec(
      RUNTIME,
      sidecarRunArgs({
        containerName,
        networkName,
        dbHost,
        spec,
        worktreePath: cfg.worktreePath,
      }),
    );

    await waitForReady(containerName, spec);
    for (const command of spec.postReadyCommands) {
      // Post-ready setup is part of the sidecar contract — a failing command
      // means the gate would run against a half-initialized DB. Fail loud.
      await exec(RUNTIME, ["exec", containerName, ...command]);
    }
  } catch (err) {
    await stop();
    throw err;
  }

  return {
    networkName,
    containerName,
    dbHost,
    dbPort: spec.port,
    stop,
  };
}

// Poll the consumer's readiness argv inside the container until it exits 0.
// The probe doubles as the init-wait: official images process initdb.d before
// serving on TCP, so a probe against the real listener naturally waits it out.
//
// The sidecar recipe is untrusted consumer input, so a container whose
// entrypoint dies at startup (bad containerEnv, bad containerArgs) is an
// EXPECTED failure mode — after each failed probe we check the container is
// still running, and if not we fail immediately with its log tail instead of
// polling a corpse for the full timeout and reporting a misleading
// "did not become ready".
async function waitForReady(
  containerName: string,
  spec: ResolvedDbSidecarConfig,
): Promise<void> {
  const deadline = Date.now() + spec.readinessTimeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      await exec(RUNTIME, ["exec", containerName, ...spec.readinessCommand]);
      return;
    } catch (e) {
      lastErr = e;
      await throwIfContainerDead(containerName, spec);
      await sleep(READY_POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `db sidecar ${containerName} (${spec.image}) did not become ready within ${spec.readinessTimeoutMs}ms (last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    })`,
  );
}

async function throwIfContainerDead(
  containerName: string,
  spec: ResolvedDbSidecarConfig,
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
    // Inspect itself flaking is not evidence of death; let the poll continue
    // and the deadline be the arbiter.
    return;
  }
  if (running === "true") return;
  const logs = await exec(RUNTIME, [
    "logs",
    "--tail",
    String(DEAD_CONTAINER_LOG_TAIL),
    containerName,
  ]).catch(() => null);
  const tail = logs ? `${logs.stdout}\n${logs.stderr}`.trim() : "(logs unavailable)";
  throw new Error(
    `db sidecar ${containerName} (${spec.image}) exited during startup — ` +
      `check dbSidecar.containerEnv/containerArgs. Container log tail:\n${tail}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
