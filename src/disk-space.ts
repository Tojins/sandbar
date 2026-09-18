// Podman graphroot free-space preflight (#169).
//
// The daemon lives for days, so startup is not a useful boundary. run.ts asks
// this module after startup reconciliation, before image preparation, and at
// every scheduler recompute. It measures the filesystem that actually contains
// Podman's graphroot, not cwd or `/` by assumption. A low reading closes
// admission and drains; once quiescent, image reconciliation runs and the same
// filesystem is measured again before the run decides whether it can continue.
//
// The floor is deliberately a driver constant rather than installation
// config. It is protection against a host failure mode, not a workload tuning
// knob. Ten GiB leaves room for one of the measured multi-GB sandbox builds
// plus its id-mapped copy and transient build layers without pretending to be
// capacity management.

import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { promisify } from "node:util";

import type { RuntimeExec } from "./containers.js";
import { SandbarError } from "./errors.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);
const GIB = 1024n * 1024n * 1024n;

export const MIN_GRAPHROOT_FREE_BYTES = 10n * GIB;
export const DISK_QUERY_TIMEOUT_MS = 30_000;

const defaultExec: RuntimeExec = (args) => exec(RUNTIME, [...args], {
  timeout: DISK_QUERY_TIMEOUT_MS,
});

export async function podmanGraphRoot(
  run: RuntimeExec = defaultExec,
): Promise<string> {
  const path = (await run([
    "info", "--format", "{{.Store.GraphRoot}}",
  ])).stdout.trim();
  if (!path) {
    throw new SandbarError(
      `${RUNTIME} reported an empty graphroot; free space cannot be preflighted`,
    );
  }
  return path;
}

export type GraphRootSpace = {
  readonly graphRoot: string;
  readonly availableBytes: bigint;
};

type StatFs = (path: string) => Promise<{
  readonly bavail: bigint;
  readonly bsize: bigint;
}>;

const defaultStatFs: StatFs = (path) => statfs(path, { bigint: true });

export async function graphRootSpace(
  graphRoot: string,
  read: StatFs = defaultStatFs,
): Promise<GraphRootSpace> {
  const stats = await read(graphRoot);
  return {
    graphRoot,
    availableBytes: stats.bavail * stats.bsize,
  };
}

export function graphRootSpaceIsLow(space: GraphRootSpace): boolean {
  return space.availableBytes < MIN_GRAPHROOT_FREE_BYTES;
}

export function formatBytes(bytes: bigint): string {
  const whole = bytes / GIB;
  const tenth = (bytes % GIB) * 10n / GIB;
  return `${bytes} bytes (${whole}.${tenth} GiB)`;
}

export function formatLowGraphRootSpace(space: GraphRootSpace): string {
  return `Podman graphroot '${space.graphRoot}' has ${formatBytes(space.availableBytes)} ` +
    `free, below sandbar's ${formatBytes(MIN_GRAPHROOT_FREE_BYTES)} floor`;
}
