// Procedural gate. Runs the configured check + test commands against an
// issue worktree inside an ephemeral one-shot container, joined to the
// issue's per-issue podman network so test code reaches the postgres
// sidecar by container name instead of the host's shared db.
//
// Two podman runs (check, then test) so the failedStep is unambiguous and
// the failing run's output can be returned without re-parsing combined
// output. The host is never asked to run npm scripts; gate verdicts are
// hermetic per issue.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GateCommand } from "./config.js";
import { RUNTIME } from "./pg-sidecar.js";

const exec = promisify(execFile);

const MAX_BUFFER = 50 * 1024 * 1024;

export type GateOptions = {
  readonly worktreePath: string;
  readonly gateImage: string;
  readonly gateCommands: GateCommand;
  readonly networkName: string;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly dbUser: string;
  readonly dbPassword: string;
  readonly dbName: string;
  readonly dbNameTest: string;
};

export type GateResult = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly failedStep: "check" | "test" | null;
};

export async function runGate(opts: GateOptions): Promise<GateResult> {
  const check = await runStep(opts, "check");
  if (!check.ok) {
    return { ...check, failedStep: "check" };
  }
  const test = await runStep(opts, "test");
  if (!test.ok) {
    return {
      ok: false,
      stdout: check.stdout + "\n" + test.stdout,
      stderr: check.stderr + "\n" + test.stderr,
      exitCode: test.exitCode,
      failedStep: "test",
    };
  }
  return {
    ok: true,
    stdout: check.stdout + "\n" + test.stdout,
    stderr: check.stderr + "\n" + test.stderr,
    exitCode: 0,
    failedStep: null,
  };
}

async function runStep(
  opts: GateOptions,
  step: "check" | "test",
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const stepCmd = opts.gateCommands[step];
  const args = [
    "run",
    "--rm",
    "--userns=keep-id",
    "--user",
    "1000:1000",
    "--network",
    opts.networkName,
    "-v",
    `${opts.worktreePath}:/workspace`,
    "-w",
    "/workspace",
    "-e",
    "CI=true",
    "-e",
    "HOME=/tmp",
    "-e",
    `DB_HOST=${opts.dbHost}`,
    "-e",
    `DB_PORT=${opts.dbPort}`,
    "-e",
    `DB_USER=${opts.dbUser}`,
    "-e",
    `DB_PASSWORD=${opts.dbPassword}`,
    "-e",
    `DB_NAME=${opts.dbName}`,
    "-e",
    `DB_NAME_TEST=${opts.dbNameTest}`,
    "--entrypoint",
    stepCmd.cmd,
    opts.gateImage,
    ...stepCmd.args,
  ];
  try {
    const { stdout, stderr } = await exec(RUNTIME, args, {
      maxBuffer: MAX_BUFFER,
    });
    return { ok: true, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), exitCode: 0 };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      ok: false,
      stdout: stripAnsi(e.stdout ?? ""),
      stderr: stripAnsi(e.stderr ?? ""),
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

// Gate tools (vitest et al.) emit ANSI SGR colour codes even when their
// stdout is piped — the in-container colour heuristics misfire despite CI=true.
// Those escapes are pure noise in every plain-text sink: the run-logs and,
// worst, the failure-trace comment posted to the GitHub issue (#396), where a
// raw `\x1b[90m` renders as literal `^[[90m` garbage. Strip every CSI escape
// at the capture boundary so all downstream consumers get clean text.
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI, "");
}

export function lastNLines(s: string, n: number): string {
  const lines = s.split(/\r?\n/);
  return lines.slice(-n).join("\n");
}
