// The pure layer of the early run of standalone steps (#247); the podman
// adapter is asserted by running it, in standalone-steps-podman.test.ts.

import { describe, expect, it } from "vitest";

import type { ResolvedGateStep, ResolvedStackContainer } from "./config.js";
import type { BoundedRuntimeResult } from "./runtime.js";
import { RUNTIME_MAX_BUFFER } from "./runtime.js";
import {
  STEP_FINDING_TAIL_LINES,
  type StandaloneStepRun,
  renderStandaloneLog,
  settleStepRun,
  standaloneCopyArgs,
  standaloneCopyOf,
  stepFindings,
} from "./standalone-steps.js";

const container = (over: Partial<ResolvedStackContainer> = {}): ResolvedStackContainer => ({
  name: "app",
  image: "localhost/app:gate",
  lifecycle: "attempt",
  env: { DB_PASSWORD: "hunter2" },
  args: ["serve"],
  mounts: [{ hostPath: "fixtures", containerPath: "/fixtures", mode: "ro" }],
  mountWorktree: "/app",
  servesWorktree: false,
  inSandbox: false,
  inGate: true,
  secretEnv: [],
  hold: false,
  readiness: { kind: "healthcheck", command: ["curl", "-f", "localhost"] },
  readinessTimeoutMs: 60_000,
  postReadyCommands: [["npm", "run", "migrate"]],
  ...over,
});

const step: ResolvedGateStep = {
  name: "standards-lint",
  in: "app",
  command: ["npm", "run", "lint:diff", "--", "origin/main"],
  timeoutMs: 30_000,
  settles: [],
  standalone: true,
};

const bounded = (over: Partial<BoundedRuntimeResult> = {}): BoundedRuntimeResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  maxBufferExceeded: false,
  errorMessage: "",
  ...over,
});

const failedRun = (output: string): StandaloneStepRun =>
  ({ step, image: "localhost/app:gate", durationMs: 300, result: "failed", exitCode: 2, detail: null, output });

describe("standaloneCopyOf", () => {
  it("holds the container open with no readiness or setup, keeping env and mounts", () => {
    const c = container();
    expect(standaloneCopyOf(c)).toEqual({ ...c, hold: true, readiness: null, postReadyCommands: [] });
  });
});

describe("standaloneCopyArgs", () => {
  const { argv, env } = standaloneCopyArgs({
    containerName: "sandbar-w1-standalone-42-app",
    container: container({ image: "localhost/app:gate-variant" }),
    worktreePath: "/wt",
  });

  it("joins no network and no pod", () => {
    expect(argv.slice(0, 6)).toEqual(["run", "-d", "--name", "sandbar-w1-standalone-42-app", "--network", "none"]);
    expect(argv).not.toContain("--pod");
  });

  it("mounts the worktree read-only, hides its .git behind a tmpfs and works there", () => {
    expect(argv).toContain("/wt:/app:ro,z");
    expect(argv).not.toContain("/wt:/app:rw,z");
    expect(argv[argv.indexOf("--tmpfs") + 1]).toBe("/app/.git:rw,nosuid,nodev,noexec");
    expect(argv[argv.indexOf("-w") + 1]).toBe("/app");
    expect(argv).toContain("/wt/fixtures:/fixtures:ro,z");
  });

  it("runs the image it is handed under sleep infinity, with no probe", () => {
    expect(argv.slice(-4)).toEqual(["--entrypoint", "sleep", "localhost/app:gate-variant", "infinity"]);
    expect(argv.some((a) => a.startsWith("--health"))).toBe(false);
  });

  it("carries no env value in the argv (#154)", () => {
    expect(env).toEqual({ DB_PASSWORD: "hunter2", CI: "true" });
    expect(argv.join(" ")).not.toContain("hunter2");
    expect(argv.join(" ")).not.toContain("DB_PASSWORD");
  });
});

describe("settleStepRun", () => {
  it.each<[string, Partial<BoundedRuntimeResult>, Partial<StandaloneStepRun>]>([
    ["an exit 0 as passed", { exitCode: 0 }, { result: "passed", exitCode: 0, detail: null }],
    ["any other exit as failed", { exitCode: 1 }, { result: "failed", exitCode: 1, detail: null }],
    ["a command podman could not find as failed, as gate-1 reads it", { exitCode: 127 },
      { result: "failed", exitCode: 127, detail: null }],
    ["a timeout as timed out", { exitCode: null, timedOut: true }, { result: "timed-out", exitCode: null, detail: null }],
    ["an overflow as unavailable", { exitCode: null, maxBufferExceeded: true },
      { result: "unavailable", exitCode: null, detail: `the step printed more than ${RUNTIME_MAX_BUFFER} bytes and was killed` }],
    ["podman's own exit 125 as unavailable", { exitCode: 125, errorMessage: "Command failed: no container" },
      { result: "unavailable", exitCode: null, detail: "podman exec failed: Command failed: no container" }],
    ["a spawn failure as unavailable", { exitCode: null, errorMessage: "spawn podman ENOENT" },
      { result: "unavailable", exitCode: null, detail: "podman exec failed: spawn podman ENOENT" }],
  ])("settles %s", (_name, r, expected) => {
    expect(settleStepRun(bounded(r))).toMatchObject(expected);
  });

  it("keeps stdout then stderr, ANSI-stripped", () => {
    expect(settleStepRun(bounded({ exitCode: 1, stdout: "\u001b[31mred\u001b[0m", stderr: "err" })).output)
      .toBe("red\nerr");
    expect(settleStepRun(bounded({ stdout: "only" })).output).toBe("only");
  });
});

describe("stepFindings", () => {
  it("renders a failed step as one block headed by the step, naming its command and exit", () => {
    const [finding, ...rest] = stepFindings([failedRun("src/a.ts:3 private method has one caller; inline it")]);
    expect(rest).toEqual([]);
    expect(finding).toMatch(/^\[step: standards-lint\] Gate step `npm run lint:diff -- origin\/main` exited 2 on this head\./);
    expect(finding).toContain("gate-1 runs it again and goes\nred while it still reports these lines");
    expect(finding).toContain("```\nsrc/a.ts:3 private method has one caller; inline it\n```");
  });

  it(`keeps the last ${STEP_FINDING_TAIL_LINES} lines of the output`, () => {
    const lines = Array.from({ length: STEP_FINDING_TAIL_LINES + 20 }, (_, i) => `line ${i}`);
    const [finding] = stepFindings([failedRun(lines.join("\n"))]);
    expect(finding).toContain(`line ${lines.length - 1}`);
    expect(finding).toContain(`line ${lines.length - STEP_FINDING_TAIL_LINES}\n`);
    expect(finding).not.toContain(`line ${lines.length - STEP_FINDING_TAIL_LINES - 1}\n`);
  });

  it("says so when the step printed nothing", () => {
    expect(stepFindings([failedRun("")])[0]).toContain("```\n(no output)\n```");
  });

  it("makes no finding of a step that passed, timed out or was unavailable", () => {
    const base = { step, image: "i", durationMs: 1, output: "x" };
    expect(stepFindings([
      { ...base, result: "passed", exitCode: 0, detail: null },
      { ...base, result: "timed-out", exitCode: null, detail: null },
      { ...base, result: "unavailable", exitCode: null, detail: "no image" },
    ])).toEqual([]);
  });
});

describe("renderStandaloneLog", () => {
  it("banners every step with its outcome, then its output", () => {
    const base = { image: "i", durationMs: 1 };
    expect(renderStandaloneLog([
      { ...failedRun("bad line") },
      { ...base, step: { ...step, name: "types" }, result: "passed", exitCode: 0, detail: null, output: "ok" },
      { ...base, step: { ...step, name: "slow" }, result: "timed-out", exitCode: null, detail: null, output: "" },
      { ...base, step: { ...step, name: "gone" }, result: "unavailable", exitCode: null, detail: "no image", output: "" },
    ])).toBe(
      "== standards-lint (app) · failed exit 2\nbad line\n" +
        "== types (app) · passed\nok\n" +
        "== slow (app) · timed out after 30000ms\n\n" +
        "== gone (app) · unavailable: no image\n",
    );
  });
});
