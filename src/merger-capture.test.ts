// `captureAgentRun` against REAL child processes (#67).
//
// Everything this function claims is a claim about `child_process`, not about
// podman: that `close` is the point at which a large stdout has arrived and
// `exit` is not, that a SIGTERM'd child is reported as our timeout rather than
// as a signal, that a spawn which never produced a process is a third thing,
// and that writing a prompt to a child that has already gone does not take the
// run down with an uncaught EPIPE. None of that is assertable against a mock —
// the mock would be the thing under test — so these run `node` and `sh`.
//
// The one bound on a test here is vitest's own; every case exits on its own or
// is killed by a timeout this file sets in milliseconds.

import { describe, expect, it } from "vitest";

import { buildAgentProvider } from "./agent-providers.js";
import { captureAgentRun, parseCapturedAgentRun } from "./merger.js";
import { isInfraFailure, parseResolveSignal } from "./resolve-loop.js";

const opts = (timeoutMs = 30_000) => ({ container: "c-under-test", timeoutMs });

// `node -e` rather than a shell, so the same script runs whatever /bin/sh is.
const node = (script: string): [string, string[]] => [
  process.execPath,
  ["-e", script],
];

describe("captureAgentRun (#67)", () => {
  it("captures stdout, stderr and the exit code of a process that ran", async () => {
    const [file, args] = node(
      `process.stdout.write("said something"); process.stderr.write("complained"); process.exit(3);`,
    );
    const run = await captureAgentRun(file, args, "", opts());
    expect(run.stdout).toBe("said something");
    // stderr used to be piped to nobody: on the failure #67 is about, it is
    // the whole of the diagnosis.
    expect(run.stderr).toBe("complained");
    expect(run.end).toBe("exit");
    expect(run.exitCode).toBe(3);
    expect(run.signal).toBeNull();
    expect(run.container).toBe("c-under-test");
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  // A real agent transcript is far larger than a pipe buffer and arrives in
  // chunks. This pins that none of it is dropped — which matters more since
  // #67 than it did before, because an EMPTY capture now halts the run: a
  // capture that truncated all the way down would report a working agent as a
  // container that never started. (It does not, by itself, prove the `close`
  // rather than `exit` settle: that race is timing-dependent and does not
  // reproduce on demand. The settle is on `close` because node documents
  // `exit` as able to precede the stdio streams closing, not because this case
  // catches it.)
  it("captures a transcript far larger than the pipe buffer, whole", async () => {
    // No explicit `process.exit`: that discards a pipe write the runtime has
    // not flushed yet, which would be the CHILD truncating rather than us.
    const [file, args] = node(
      `process.stdout.write("x".repeat(4 * 1024 * 1024));`,
    );
    const run = await captureAgentRun(file, args, "", opts());
    expect(run.stdout).toHaveLength(4 * 1024 * 1024);
    expect(run.end).toBe("exit");
  });

  it("reads the prompt from stdin", async () => {
    const [file, args] = node(
      `let b=""; process.stdin.on("data",c=>b+=c); process.stdin.on("end",()=>process.stdout.write("got:"+b));`,
    );
    const run = await captureAgentRun(file, args, "the prompt", opts());
    expect(run.stdout).toBe("got:the prompt");
  });

  // The case in the run that filed #67: attempt 1 killed at the ten-minute
  // budget. It has to come back as OUR timeout and not as "killed by SIGTERM",
  // because the signal is ours and the elapsed budget is the fact.
  it("reports the timeout as a timeout, not as the signal it sent", async () => {
    const [file, args] = node(`setTimeout(() => {}, 60_000);`);
    const run = await captureAgentRun(file, args, "", opts(150));
    expect(run.end).toBe("timeout");
    expect(run.stdout).toBe("");
    expect(run.durationMs).toBeGreaterThanOrEqual(100);
  });

  // Whatever the agent managed to print before the budget ran out is still
  // captured — a timeout is a spent attempt, and what it printed is the only
  // record of what it was doing.
  it("keeps the output a timed-out process had already produced", async () => {
    const [file, args] = node(
      `process.stdout.write("partway through"); setTimeout(() => {}, 60_000);`,
    );
    const run = await captureAgentRun(file, args, "", opts(300));
    expect(run.end).toBe("timeout");
    expect(run.stdout).toBe("partway through");
  });

  it("reports a signal that was not ours as a signal", async () => {
    const [file, args] = node(`process.kill(process.pid, "SIGKILL");`);
    const run = await captureAgentRun(file, args, "", opts());
    expect(run.end).toBe("signal");
    expect(run.signal).toBe("SIGKILL");
    expect(run.exitCode).toBeNull();
  });

  // A runtime that is not installed at all. Distinct from every other end,
  // because there is no exit status to report and no output to wait for.
  it("reports a binary that does not exist as a spawn-error, with the reason", async () => {
    const run = await captureAgentRun(
      "sandbar-no-such-binary-67",
      [],
      "prompt",
      opts(),
    );
    expect(run.end).toBe("spawn-error");
    expect(run.detail).toContain("ENOENT");
    expect(run.stdout).toBe("");
  });

  // The EPIPE guard, exercised rather than asserted: a child that exits before
  // reading its prompt makes the stdin write fail, and an unhandled 'error' on
  // that stream is an uncaught exception out of a promise executor — which
  // would take the whole run down past every structured handler run.ts has.
  it("survives writing a prompt to a child that has already gone", async () => {
    const [file, args] = node(`process.exit(9);`);
    const run = await captureAgentRun(
      file,
      args,
      "x".repeat(2_000_000),
      opts(),
    );
    expect(run.end).toBe("exit");
    expect(run.exitCode).toBe(9);
  });
});

describe("parseCapturedAgentRun (#74)", () => {
  const captured = (stdout: string) => ({
    stdout,
    stderr: "raw stderr",
    end: "exit" as const,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    container: "resolve-1",
  });

  it("takes resolve promises from codex agent speech, not raw JSONL", () => {
    const raw = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "<promise>ABANDON</promise>" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "<promise>COMMITTED</promise>" },
      }),
    ].join("\n");
    const run = parseCapturedAgentRun(
      rawCapture(raw),
      buildAgentProvider("codex", "m"),
    );
    expect(run.stdout).toBe(raw);
    expect(parseResolveSignal(run.output ?? "")).toEqual({ kind: "COMMITTED" });
  });

  it("treats a terminal provider failure without speech as infra", () => {
    const raw = JSON.stringify({
      type: "turn.failed",
      error: { message: "pool spent" },
    });
    const run = parseCapturedAgentRun(
      rawCapture(raw),
      buildAgentProvider("codex", "m"),
    );
    expect(run.output).toBe("");
    expect(run.providerFailure).toBe("pool spent");
    expect(isInfraFailure(run)).toBe(true);
  });

  function rawCapture(stdout: string) {
    return captured(stdout);
  }
});
