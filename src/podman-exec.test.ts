// The exec guard's own contract (podman-exec.test-util.ts, #254): the wrapped
// command runs under a local `sh` exactly as it would inside a container.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { markExec, retryUndelivered, unmarked } from "./podman-exec.test-util.js";

const exec = promisify(execFile);

const runMarked = async (command: readonly string[]) => {
  const [file, ...args] = markExec(command);
  return exec(file!, args).then(
    ({ stdout }) => ({ code: 0, stdout }),
    (err: { code: number; stdout: string }) => ({ code: err.code, stdout: err.stdout }),
  );
};

describe("markExec", () => {
  it("prints the marker after the command's own output and keeps its exit status", async () => {
    const red = await runMarked(["sh", "-c", "printf 'no newline'; exit 3"]);
    expect(red.code).toBe(3);
    expect(unmarked(red.stdout)).toBe("no newline");
    const green = await runMarked(["echo", "a b"]);
    expect(green.code).toBe(0);
    expect(unmarked(green.stdout)).toBe("a b\n");
  });

  it("refuses to unmark output that has no marker", () => {
    expect(() => unmarked("")).toThrow(/no exec marker/);
  });
});

describe("retryUndelivered", () => {
  it("re-runs once when an output lacks the marker", async () => {
    const delivered = (await runMarked(["echo", "x"])).stdout;
    const outputs = ["", delivered];
    let runs = 0;
    const result = await retryUndelivered(async () => outputs[runs++]!, (o) => [o]);
    expect(result).toBe(delivered);
    expect(runs).toBe(2);
  });

  it("throws on a second loss rather than returning the lost capture", async () => {
    let runs = 0;
    await expect(retryUndelivered(async () => (runs++, ""), (o) => [o])).rejects.toThrow(/lost its output twice/);
    expect(runs).toBe(2);
  });
});
