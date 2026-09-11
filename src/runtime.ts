// The container runtime and its one bounded host-side invocation seam.
//
// Hard-coded rather than configurable: sandbar depends on podman-specific
// behaviour that has no docker equivalent — pods (#24), `--userns=keep-id` in
// the agent sandbox, and rootless uid mapping where container root writes as
// the invoking user. A `docker` value would type-check and then fail at the
// first `pod create`, so the constant is the honest statement of the
// dependency.
//
// A PODMAN ARGV NEVER CARRIES AN ENVIRONMENT VALUE (#154). Every container
// variable sandbar sets travels in a 0600 FILE that podman reads, and the argv
// carries only that file's path. The rule is absolute rather than secret-only:
// `config.env` exists to carry credentials into sandboxes (#38, #73, #134), and
// the failure it closes is that anything wrapping a failed spawn quotes the
// argv — node's `execFile` error message is `Command failed: <argv joined>`,
// which the inner loop records as a `hard-error` event `reason` and the UI then
// serves (#132). A redaction pass over those messages would be the weaker line:
// it has to know every key, and the next `Command failed:` wrapper starts the
// count again. Keeping the value out of the argv removes the mechanism, and
// closes the `ps` exposure for the container's whole lifetime as a side effect.
// One rule, not a secret/non-secret split every reader would have to know, so
// `HOME`, `CI=true` and the consumer's own `gateStack.containers[].env` move
// too. Nothing can be done about a record already written: history is scrubbed
// by hand.
//
// THE PODMAN CHILD'S ENVIRONMENT IS PODMAN'S. That is why the file exists and
// podman's other value-free form, `-e KEY` — which copies KEY out of podman's
// own environment — is not usable here: the names sandbar and its consumers
// pick are names for the CONTAINER, and podman reads several of them for
// ITSELF. `HOME` is where a rootless client finds its storage root and
// `containers.conf`, and `CONTAINER_HOST` is the service URL — which this
// repo's own gate config declares on a gate container, pointing at a socket
// path that exists only inside it (#48). Copying container variables into the
// client's environment therefore reconfigures the client: the sandbox's
// `HOME=/home/agent` sends podman looking for an image store under a directory
// the daemon user cannot create, and the gate's `CONTAINER_HOST` turns the next
// `podman run` into a remote client aimed at a socket that is not there. The
// env file keeps the two namespaces apart, so every seam below spawns podman
// with the driver's own environment, untouched.
//
// `RuntimeInvocation` is what the rule costs: a builder that needs any
// container variable returns its argv and its env TOGETHER, and `withRuntimeEnv`
// is the one place that turns the pair into a running command. Builders that
// need none stay plain string arrays.
//
// `ENV_FILE_FLAG` below is the ONE production spelling of any podman
// environment flag, and runtime.test.ts asserts exactly that by scanning
// `src/`: a table test can only cover the builders someone added to it, so the
// scan is what a fifth builder written with `-e KEY=VALUE` runs into. A module
// that genuinely needs one of those flags for something else has to move that
// assertion deliberately.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SandbarError } from "./errors.js";

export const RUNTIME = "podman";

export const RUNTIME_MAX_BUFFER = 50 * 1024 * 1024;

// One podman invocation: the argv, and the variables the CONTAINER must carry.
// The argv holds no trace of them — `withRuntimeEnv` is what puts the two
// together, by writing the env file the argv it then runs names.
export type RuntimeInvocation = {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

// Podman's env-file flag, spelled once. `run` and `exec` both take it.
const ENV_FILE_FLAG = "--env-file";

// Podman parses an env file LINE BY LINE, splitting each at its first `=`,
// skipping lines that begin with `#`, and trimming leading whitespace. So the
// format can carry any value except one containing a newline, and any name
// except one that would re-parse as something else. Those are REFUSED rather
// than written, as the config errors they are: a garbled variable reaches the
// agent or the gate as a silently wrong environment, which is worse than a
// named refusal at the spawn that would have created it.
export function formatEnvFile(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new SandbarError(
          `Cannot pass the container variable ${JSON.stringify(key)} to ` +
            "podman: a name must be letters, digits and underscores, not " +
            "starting with a digit.",
        );
      }
      if (/[\n\r\0]/.test(value)) {
        throw new SandbarError(
          `Cannot pass the container variable ${key} to podman: its value ` +
            "contains a newline or NUL, which podman's env-file format cannot " +
            "represent.",
        );
      }
      return `${key}=${value}\n`;
    })
    .join("");
}

// Run one invocation, with its variables in a file only podman and this process
// can read. The file lives exactly as long as the command: a `podman run`
// returns once the container is created and has its copy, and a `podman exec`
// returns when the step does.
//
// The flag is spliced immediately after the SUBCOMMAND rather than emitted by
// the builder, which cannot know the path. That slot is the one every builder's
// argv certainly still has flags in — podman takes its own flags in any order
// ahead of the first positional argument, which for `run` is the image and for
// `exec` is the container.
//
// Preferring `XDG_RUNTIME_DIR` is not tidiness: this repo's own gate config
// bind-mounts the host `/tmp` into a gate container, and a per-user runtime
// directory is one no container sandbar starts can see. Both get a 0700
// directory and a 0600 file regardless.
export async function withRuntimeEnv<T>(
  invocation: RuntimeInvocation,
  run: (argv: readonly string[]) => Promise<T>,
): Promise<T> {
  const contents = formatEnvFile(invocation.env);
  if (contents === "") return await run(invocation.argv);
  const dir = await mkdtemp(
    join(process.env["XDG_RUNTIME_DIR"] ?? tmpdir(), "sandbar-env-"),
  );
  try {
    const path = join(dir, "env");
    await writeFile(path, contents, { mode: 0o600 });
    return await run([
      ...invocation.argv.slice(0, 1),
      ENV_FILE_FLAG,
      path,
      ...invocation.argv.slice(1),
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
