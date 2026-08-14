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
// initMounts resolve against the ISSUE WORKTREE (`cfg.worktreePath`), mounted
// read-only — so a branch that edits its schema fixture gates against its own
// version, and the operator's checkout never leaks into a gate (same isolation
// argument as issue #10). Callers must therefore create the worktree BEFORE
// starting the sidecar: bind-mount sources are read at container start.
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
    await exec(RUNTIME, [
      "run",
      "-d",
      "--name",
      containerName,
      "--network",
      networkName,
      "--ip",
      dbHost,
      ...Object.entries(spec.containerEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      ...spec.initMounts.flatMap((m) => [
        "-v",
        `${isAbsolute(m.hostPath) ? m.hostPath : resolve(cfg.worktreePath, m.hostPath)}:${m.containerPath}:ro`,
      ]),
      spec.image,
      ...spec.containerArgs,
    ]);

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
      await sleep(READY_POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `db sidecar ${containerName} (${spec.image}) did not become ready within ${spec.readinessTimeoutMs}ms (last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    })`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
