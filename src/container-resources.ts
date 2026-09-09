// Container memory evidence at an execution boundary (#141).
//
// Sandbar does not set a memory limit and these facts never influence a
// verdict, timeout, retry, or concurrency decision. They are measurements for
// the operator: `peakMemoryBytes` is the cgroup-v2 `memory.peak` value and
// `oomKilled` is the cgroup's non-zero `memory.events` `oom_kill` counter,
// OR-ed with Podman's recorded `.State.OOMKilled` bit. The cgroup counter is
// what sees a workload killed under `podman exec` while a held PID 1 survives;
// Podman's bit still sees the container-init case. Missing cgroup-v2
// delegation, an older kernel without either file, a stopped container that
// Podman can no longer sample, and an unreadable inspect all mean ABSENT —
// never zero.
//
// The cgroup path comes from the same inspect that supplies OOMKilled. The
// file is read host-side because the container may not have its cgroup mounted
// and should not need `cat`. Podman's sampled current usage is deliberately a
// fallback only: it is weaker than a peak, but is still better capacity
// evidence on a host where `memory.peak` is unavailable.

import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import {
  boundedRuntime,
  boundedRuntimeOk,
  type BoundedRuntime,
  type BoundedRuntimeResult,
} from "./runtime.js";

export type ContainerResources = {
  readonly peakMemoryBytes?: number;
  readonly oomKilled?: boolean;
};

export type ContainerTeardown = ContainerResources & {
  readonly name: string;
  readonly container: string;
  readonly lifecycle: "issue" | "attempt";
  readonly durationMs: number;
};

export type ContainerResourceResult = BoundedRuntimeResult;

export type ContainerResourcePodman = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<ContainerResourceResult>;

export type ContainerResourceDeps = {
  readonly podman: ContainerResourcePodman;
  readonly read: (path: string) => Promise<string>;
};

export const CGROUP_ROOT = "/sys/fs/cgroup";
export const CONTAINER_RESOURCE_TIMEOUT_MS = 15_000;
const ok = (result: ContainerResourceResult): boolean =>
  boundedRuntimeOk(result);

const bytes = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const IEC_UNIT_BYTES: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

export function parseContainerState(value: string): {
  readonly cgroupPath?: string;
  readonly oomKilled?: boolean;
} {
  const [cgroupPath, oomKilled] = value.trimEnd().split("\n");
  return {
    ...(cgroupPath !== undefined && cgroupPath !== "" && cgroupPath !== "<no value>"
      ? { cgroupPath }
      : {}),
    ...(oomKilled === "true"
      ? { oomKilled: true }
      : oomKilled === "false"
        ? { oomKilled: false }
        : {}),
  };
}

const cgroupFilePath = (cgroupPath: string, file: string): string | null => {
  const path = resolve(CGROUP_ROOT, `.${cgroupPath.startsWith("/") ? cgroupPath : `/${cgroupPath}`}`);
  return path.startsWith(`${CGROUP_ROOT}${sep}`) ? `${path}${sep}${file}` : null;
};

export function memoryPeakPath(cgroupPath: string): string | null {
  return cgroupFilePath(cgroupPath, "memory.peak");
}

export function memoryEventsPath(cgroupPath: string): string | null {
  return cgroupFilePath(cgroupPath, "memory.events");
}

export function parseMemoryEvents(value: string): boolean | undefined {
  for (const line of value.split("\n")) {
    const match = /^oom_kill\s+(\d+)$/.exec(line.trim());
    if (match === null) continue;
    const count = bytes(match[1]!);
    return count === undefined ? undefined : count > 0;
  }
  return undefined;
}

// `.MemUsageBytes` is `"<usage> / <limit>"`; only the sampled usage belongs
// in this field. Podman versions differ between a raw integer and an IEC-sized
// value here, so accept both without rounding a genuine cgroup peak.
export function parseStatsMemory(value: string): number | undefined {
  const usage = (value.split("/", 1)[0] ?? "").trim();
  const raw = bytes(usage);
  if (raw !== undefined) return raw;
  const sized = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b)$/i.exec(usage);
  if (sized === null) return undefined;
  const unit = IEC_UNIT_BYTES[sized[2]!.toLowerCase()];
  if (unit === undefined) return undefined;
  const parsed = Math.round(Number(sized[1]) * unit);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

const unavailableFile = (err: unknown): boolean => {
  if (err === null || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  // Every filesystem errno means the host could not supply this optional
  // measurement. A thrown value with no errno is a bug in the injected seam
  // and still propagates rather than being laundered into absence.
  return typeof code === "string";
};

const readOptional = async (
  path: string | null,
  read: ContainerResourceDeps["read"],
): Promise<string | undefined> => {
  if (path === null) return undefined;
  try {
    return await read(path);
  } catch (err) {
    if (!unavailableFile(err)) throw err;
    return undefined;
  }
};

export async function readContainerResources(
  containerName: string,
  deps: ContainerResourceDeps,
): Promise<ContainerResources> {
  const inspected = await deps.podman(
    [
      "inspect",
      "--format",
      "{{.State.CgroupPath}}\n{{.State.OOMKilled}}",
      containerName,
    ],
    CONTAINER_RESOURCE_TIMEOUT_MS,
  );
  const state = ok(inspected) ? parseContainerState(inspected.stdout) : {};

  let peakMemoryBytes: number | undefined;
  let cgroupOomKilled: boolean | undefined;
  if (state.cgroupPath !== undefined) {
    const [peak, events] = await Promise.all([
      readOptional(memoryPeakPath(state.cgroupPath), deps.read),
      readOptional(memoryEventsPath(state.cgroupPath), deps.read),
    ]);
    if (peak !== undefined) peakMemoryBytes = bytes(peak);
    if (events !== undefined) cgroupOomKilled = parseMemoryEvents(events);
  }
  if (peakMemoryBytes === undefined) {
    const sampled = await deps.podman(
      ["stats", "--no-stream", "--format", "{{.MemUsageBytes}}", containerName],
      CONTAINER_RESOURCE_TIMEOUT_MS,
    );
    if (ok(sampled)) peakMemoryBytes = parseStatsMemory(sampled.stdout);
  }

  const oomKilled = cgroupOomKilled === true || state.oomKilled === true
    ? true
    : cgroupOomKilled === false
      ? false
      : undefined;
  return {
    ...(peakMemoryBytes === undefined ? {} : { peakMemoryBytes }),
    ...(oomKilled === undefined ? {} : { oomKilled }),
  };
}

export const systemContainerResourceDeps = (
  podman: BoundedRuntime = boundedRuntime,
): ContainerResourceDeps => ({
  podman,
  read: (path) => readFile(path, "utf8"),
});

export function formatContainerResources(resources: ContainerResources): string {
  return [
    ...(resources.peakMemoryBytes === undefined
      ? []
      : [`peakMemoryBytes=${resources.peakMemoryBytes}`]),
    ...(resources.oomKilled === true ? ["oomKilled=true"] : []),
  ].join(" ");
}

export function mergeContainerResources(
  first: ContainerResources,
  second: ContainerResources,
): ContainerResources {
  const peaks = [first.peakMemoryBytes, second.peakMemoryBytes].filter(
    (value): value is number => value !== undefined,
  );
  return {
    ...(peaks.length === 0 ? {} : { peakMemoryBytes: Math.max(...peaks) }),
    ...(first.oomKilled === undefined && second.oomKilled === undefined
      ? {}
      : { oomKilled: first.oomKilled === true || second.oomKilled === true }),
  };
}

export function containerResourcesOf(resources: ContainerResources): ContainerResources {
  return {
    ...(resources.peakMemoryBytes === undefined
      ? {}
      : { peakMemoryBytes: resources.peakMemoryBytes }),
    ...(resources.oomKilled === undefined
      ? {}
      : { oomKilled: resources.oomKilled }),
  };
}
