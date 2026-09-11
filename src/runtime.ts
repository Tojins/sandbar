// The container runtime and its one bounded host-side invocation seam.
//
// Hard-coded rather than configurable: sandbar depends on podman-specific
// behaviour that has no docker equivalent — pods (#24), `--userns=keep-id` in
// the agent sandbox, and rootless uid mapping where container root writes as
// the invoking user. A `docker` value would type-check and then fail at the
// first `pod create`, so the constant is the honest statement of the
// dependency.
//
// A PODMAN ARGV NEVER HAS `=` AFTER `-e` (#154). Podman's `-e KEY` with no
// value copies KEY from podman's OWN environment, so every container variable
// sandbar sets travels in the child process's env and the argv carries only
// the key. The rule is absolute rather than secret-only: `config.env` exists to
// carry credentials into sandboxes (#38, #73, #134), and the failure it closes
// is that anything wrapping a failed spawn quotes the argv — node's `execFile`
// error message is `Command failed: <argv joined>`, which the inner loop
// records as a `hard-error` event `reason` and the UI then serves (#132). A
// redaction pass over those messages would be the weaker line: it has to know
// every key, and the next `Command failed:` wrapper starts the count again.
// Keeping the value out of the argv removes the mechanism, and closes the `ps`
// exposure for the container's whole lifetime as a side effect. One rule, not a
// secret/non-secret split every reader would have to know, so `HOME`, `CI=true`
// and the consumer's own `gateStack.containers[].env` move too. Nothing can be
// done about a record already written: history is scrubbed by hand.
//
// `RuntimeInvocation` is what that costs: a builder that emits any `-e` returns
// its argv and its env TOGETHER, so a caller cannot run the argv without the
// values it names. Builders that emit no `-e` stay plain string arrays.
import { execFile } from "node:child_process";

export const RUNTIME = "podman";

export const RUNTIME_MAX_BUFFER = 50 * 1024 * 1024;

// One podman invocation: the argv, and the variables the podman CHILD must
// carry for the bare `-e KEY` tokens in it to resolve. Podman silently omits a
// key that is unset in its own environment, which is why the value has to be in
// the SPAWN's env and can never be left to the driver's `process.env`.
export type RuntimeInvocation = {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

// The one spelling of how a `RuntimeInvocation`'s env reaches the child, shared
// by every seam that runs one. OVERLAID on the driver's own environment rather
// than replacing it: node hands a child `env` verbatim, and a podman stripped
// of PATH, HOME and XDG_RUNTIME_DIR cannot find its socket. Absent env means
// absent option, so a caller that passes none still inherits normally.
export function runtimeChildEnv(
  env: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv | undefined {
  return env === undefined ? undefined : { ...process.env, ...env };
}

// The `-e KEY` tokens for an invocation's env, in insertion order. The one
// place the bare-key form is spelled, so no builder can reintroduce `KEY=VALUE`
// by copying a sibling.
export function envArgs(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env).flatMap((key) => ["-e", key]);
}

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
  env?: Readonly<Record<string, string>>,
) => Promise<BoundedRuntimeResult>;

// Own the deadline rather than using execFile's `timeout`: Podman can turn the
// latter's SIGTERM into exit 0, laundering a timed-out exec into success (#26).
// Every host-side Podman control/read call shares this exact classification.
export const boundedRuntime: BoundedRuntime = (
  args,
  timeoutMs,
  onChunk,
  env,
) => new Promise((done) => {
  let killedByTimer = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const child = execFile(
    RUNTIME,
    [...args],
    { maxBuffer: RUNTIME_MAX_BUFFER, env: runtimeChildEnv(env) },
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
