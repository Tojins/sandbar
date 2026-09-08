// Container memory evidence at an execution boundary (#141).
//
// Sandbar does not set a memory limit and these facts never influence a
// verdict, timeout, retry, or concurrency decision. They are measurements for
// the operator: `peakMemoryBytes` is the cgroup-v2 `memory.peak` value and
// `oomKilled` is Podman's recorded `.State.OOMKilled` bit. Missing cgroup-v2
// delegation, an older kernel without `memory.peak`, a stopped container that
// Podman can no longer sample, and an unreadable inspect all mean ABSENT —
// never zero.
//
// The cgroup path comes from the same inspect that supplies OOMKilled. The
// file is read host-side because the container may not have its cgroup mounted
// and should not need `cat`. Podman's sampled current usage is deliberately a
// fallback only: it is weaker than a peak, but is still better capacity
// evidence on a host where `memory.peak` is unavailable.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { RUNTIME } from "./runtime.js";

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

export type ContainerResourceResult = {
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly maxBufferExceeded: boolean;
};

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
const MAX_RESOURCE_OUTPUT = 1024 * 1024;

const ok = (result: ContainerResourceResult): boolean =>
  result.exitCode === 0 && !result.timedOut && !result.maxBufferExceeded;

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

export function memoryPeakPath(cgroupPath: string): string | null {
  const path = resolve(CGROUP_ROOT, `.${cgroupPath.startsWith("/") ? cgroupPath : `/${cgroupPath}`}`);
  return path.startsWith(`${CGROUP_ROOT}${sep}`) ? `${path}${sep}memory.peak` : null;
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
  if (state.cgroupPath !== undefined) {
    const path = memoryPeakPath(state.cgroupPath);
    if (path !== null) {
      try {
        peakMemoryBytes = bytes(await deps.read(path));
      } catch (err) {
        if (!unavailableFile(err)) throw err;
      }
    }
  }
  if (peakMemoryBytes === undefined) {
    const sampled = await deps.podman(
      ["stats", "--no-stream", "--format", "{{.MemUsageBytes}}", containerName],
      CONTAINER_RESOURCE_TIMEOUT_MS,
    );
    if (ok(sampled)) peakMemoryBytes = parseStatsMemory(sampled.stdout);
  }

  return {
    ...(peakMemoryBytes === undefined ? {} : { peakMemoryBytes }),
    ...(state.oomKilled === undefined ? {} : { oomKilled: state.oomKilled }),
  };
}

const systemContainerResourcePodman: ContainerResourcePodman = (
  args,
  timeoutMs,
) => new Promise((done) => {
  let killedByTimer = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const child = execFile(
    RUNTIME,
    [...args],
    { maxBuffer: MAX_RESOURCE_OUTPUT },
    (err, stdout) => {
      clearTimeout(timer);
      const error = err as (Error & { code?: number | string }) | null;
      done({
        stdout,
        exitCode: error === null
          ? 0
          : typeof error.code === "number"
            ? error.code
            : null,
        timedOut: killedByTimer && error !== null,
        maxBufferExceeded: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
    },
  );
  timer = setTimeout(() => {
    killedByTimer = true;
    child.kill("SIGKILL");
  }, timeoutMs);
});

export const systemContainerResourceDeps = (
  podman: ContainerResourcePodman = systemContainerResourcePodman,
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
