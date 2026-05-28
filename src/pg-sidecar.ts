// Per-issue postgres sidecar.
//
// Each issue's inner-loop owns a dedicated podman network and a postgres
// container. The gate container joins the network at run-time and resolves
// the sidecar by container name (no host port). One pg startup per issue,
// reused across every gate-1 attempt and gate-2.
//
// Naming uses the issue id (`sandcastle-pg-<id>`, `sandcastle-net-<id>`).
// The orchestrator holds a single-instance lock, so the id collides only
// with stale resources from a prior aborted run — those are swept by
// cleanupOrphanResources() at start.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const RUNTIME = "podman";
// pgvector ships an upstream postgres image with the `vector` extension
// pre-installed. Plain `postgres:18-alpine` lacks the shared library so
// `CREATE EXTENSION vector;` would fail outright. Fully qualified: hosts
// without unqualified-search registries in registries.conf can't resolve a
// bare short name on pull/run.
export const PG_IMAGE = "docker.io/pgvector/pgvector:pg18";
export const PG_USER = "offergeist";
export const PG_PASSWORD = "offergeist";
export const PG_DB = "offergeist";
export const PG_DB_TEST = "offergeist_test";
export const READY_TIMEOUT_MS = 60_000;
export const READY_POLL_INTERVAL_MS = 500;

export type SidecarConfig = {
  readonly issueId: string;
};

export type Sidecar = {
  readonly networkName: string;
  readonly containerName: string;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly dbUser: string;
  readonly dbPassword: string;
  readonly dbName: string;
  readonly dbNameTest: string;
  readonly stop: () => Promise<void>;
};

export function networkNameFor(issueId: string): string {
  return `sandcastle-net-${issueId}`;
}

export function containerNameFor(issueId: string): string {
  return `sandcastle-pg-${issueId}`;
}

export async function startPgSidecar(cfg: SidecarConfig): Promise<Sidecar> {
  const networkName = networkNameFor(cfg.issueId);
  const containerName = containerNameFor(cfg.issueId);

  await exec(RUNTIME, ["network", "create", networkName]);

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

  try {
    await exec(RUNTIME, [
      "run",
      "-d",
      "--name",
      containerName,
      "--network",
      networkName,
      "--network-alias",
      containerName,
      "-e",
      `POSTGRES_USER=${PG_USER}`,
      "-e",
      `POSTGRES_PASSWORD=${PG_PASSWORD}`,
      "-e",
      `POSTGRES_DB=${PG_DB}`,
      PG_IMAGE,
    ]);

    await waitForReady(containerName);
    await ensureTestDb(containerName);
  } catch (err) {
    await stop();
    throw err;
  }

  return {
    networkName,
    containerName,
    dbHost: containerName,
    dbPort: 5432,
    dbUser: PG_USER,
    dbPassword: PG_PASSWORD,
    dbName: PG_DB,
    dbNameTest: PG_DB_TEST,
    stop,
  };
}

async function waitForReady(containerName: string): Promise<void> {
  // The official postgres image starts the server on a unix socket for init
  // scripts before restarting it on TCP, so `pg_isready` flickers green during
  // the init window. Probe via psql against the loopback TCP listener instead;
  // that's the listener gate containers will connect to.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      await exec(RUNTIME, [
        "exec",
        "-e",
        `PGPASSWORD=${PG_PASSWORD}`,
        containerName,
        "psql",
        "-h",
        "127.0.0.1",
        "-U",
        PG_USER,
        "-d",
        PG_DB,
        "-tAc",
        "SELECT 1",
      ]);
      return;
    } catch (e) {
      lastErr = e;
      await sleep(READY_POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `postgres sidecar ${containerName} did not become ready within ${READY_TIMEOUT_MS}ms (last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    })`,
  );
}

async function ensureTestDb(containerName: string): Promise<void> {
  const probe = await exec(RUNTIME, [
    "exec",
    "-e",
    `PGPASSWORD=${PG_PASSWORD}`,
    containerName,
    "psql",
    "-h",
    "127.0.0.1",
    "-U",
    PG_USER,
    "-d",
    PG_DB,
    "-tAc",
    `SELECT 1 FROM pg_database WHERE datname = '${PG_DB_TEST}'`,
  ]);
  if (probe.stdout.trim() === "1") return;
  await exec(RUNTIME, [
    "exec",
    "-e",
    `PGPASSWORD=${PG_PASSWORD}`,
    containerName,
    "psql",
    "-h",
    "127.0.0.1",
    "-U",
    PG_USER,
    "-d",
    PG_DB,
    "-c",
    `CREATE DATABASE "${PG_DB_TEST}" OWNER "${PG_USER}"`,
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
