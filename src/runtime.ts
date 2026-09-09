// The container runtime and its one bounded host-side invocation seam.
//
// Hard-coded rather than configurable: sandbar depends on podman-specific
// behaviour that has no docker equivalent — pods (#24), `--userns=keep-id` in
// the agent sandbox, and rootless uid mapping where container root writes as
// the invoking user. A `docker` value would type-check and then fail at the
// first `pod create`, so the constant is the honest statement of the
// dependency.
import { execFile } from "node:child_process";

export const RUNTIME = "podman";

export const RUNTIME_MAX_BUFFER = 50 * 1024 * 1024;

export type BoundedRuntimeResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly maxBufferExceeded: boolean;
  readonly errorMessage: string;
};

export type BoundedRuntime = (
  args: readonly string[],
  timeoutMs: number,
  onChunk?: (chunk: Buffer | string) => void,
) => Promise<BoundedRuntimeResult>;

// Own the deadline rather than using execFile's `timeout`: Podman can turn the
// latter's SIGTERM into exit 0, laundering a timed-out exec into success (#26).
// Every host-side Podman control/read call shares this exact classification.
export const boundedRuntime: BoundedRuntime = (
  args,
  timeoutMs,
  onChunk,
) => new Promise((done) => {
  let killedByTimer = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const child = execFile(
    RUNTIME,
    [...args],
    { maxBuffer: RUNTIME_MAX_BUFFER },
    (err, stdout, stderr) => {
      clearTimeout(timer);
      const error = err as
        | (Error & { code?: number | string; signal?: string })
        | null;
      done({
        stdout,
        stderr,
        exitCode: error === null
          ? 0
          : typeof error.code === "number"
            ? error.code
            : null,
        timedOut: killedByTimer && error !== null,
        maxBufferExceeded: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        errorMessage: error?.message ?? "",
      });
    },
  );
  if (onChunk !== undefined) {
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
  }
  timer = setTimeout(() => {
    killedByTimer = true;
    child.kill("SIGKILL");
  }, timeoutMs);
});

export function boundedRuntimeOk(result: BoundedRuntimeResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.maxBufferExceeded;
}
