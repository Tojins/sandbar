// The podman-layer tests' guard against a remote `podman exec` that exits with
// the right status and delivers none of its output (#254). Seen under load
// through the gate's remote client, against the host's podman service: a green
// read with empty stdout, a red step with no output, either one indistinguishable
// from a real result.
//
// The command is wrapped to print a marker line on stdout after its own output,
// keeping its exit status. Both streams share one attach connection and every
// loss seen dropped the whole of it, so a marker that arrived means the output
// before it did. A result whose outputs lack the marker is run once more; a
// second loss throws rather than handing an assertion a capture podman lost.
//
// `markExec`/`retryUndelivered` are for a test whose exec happens inside
// sandbar (a gate step, a standalone step): it marks the command it configures
// and names the outputs to check. `podmanExecOutput` is the whole guard for a
// test's own exec.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

const MARKER = "sandbar-exec-delivered";
const MARKER_LINE = `${MARKER}\n`;

export function markExec(command: readonly string[]): string[] {
  return ["sh", "-c", `"$@"; status=$?; echo ${MARKER}; exit $status`, "sh", ...command];
}

// The output with the marker removed. A command's output without a trailing
// newline runs into it, which is why this removes the marker and not a line.
export function unmarked(output: string): string {
  if (!output.includes(MARKER_LINE)) throw new Error(`no exec marker in ${JSON.stringify(output)}`);
  return output.replace(MARKER_LINE, "");
}

export async function retryUndelivered<T>(
  run: () => Promise<T>,
  outputs: (result: T) => readonly string[],
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const result = await run();
    const lost = outputs(result).filter((output) => !output.includes(MARKER_LINE));
    if (lost.length === 0) return result;
    if (attempt === 2) throw new Error(`podman exec lost its output twice: ${JSON.stringify(lost)}`);
  }
}

// The stdout of `podman exec <container> <command>`, which must exit 0.
export async function podmanExecOutput(container: string, command: readonly string[]): Promise<string> {
  const { stdout } = await retryUndelivered(
    () => exec(RUNTIME, ["exec", container, ...markExec(command)]),
    (r) => [r.stdout],
  );
  return unmarked(stdout);
}
