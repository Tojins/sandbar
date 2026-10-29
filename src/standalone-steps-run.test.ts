// runStandaloneSteps (#247) over a fake podman: the branches no real podman
// reaches cheaply. The argv and the real container are asserted in
// standalone-steps.test.ts and standalone-steps-podman.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveGateStack } from "./config.js";
import { ImageBuildError } from "./ensure-images.js";
import type { BoundedRuntimeResult } from "./runtime.js";

const fake = vi.hoisted(() => ({
  calls: [] as string[][],
  handler: null as ((args: readonly string[]) => Promise<unknown> | unknown) | null,
}));

vi.mock("./runtime.js", async (importActual) => ({
  ...(await importActual<typeof import("./runtime.js")>()),
  boundedRuntime: async (args: readonly string[]) => {
    fake.calls.push([...args]);
    return fake.handler!(args);
  },
}));

vi.mock("./container-resources.js", async (importActual) => ({
  ...(await importActual<typeof import("./container-resources.js")>()),
  readContainerResourceSnapshot: async () => undefined,
  containerResourcesSince: () => ({}),
}));

const { runStandaloneSteps } = await import("./standalone-steps.js");

const result = (over: Partial<BoundedRuntimeResult> = {}): BoundedRuntimeResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  maxBufferExceeded: false,
  errorMessage: "",
  ...over,
});

const verbs = (): string[] => fake.calls.map((args) => args.find((a) => ["rm", "run", "exec"].includes(a))!);

const stackOf = (stepContainers: readonly string[]) =>
  resolveGateStack({
    containers: ["a", "b"].map((name) => ({ name, image: `localhost/${name}:gate`, mountWorktree: "/app" })),
    steps: stepContainers.map((in_, i) => ({ name: `s${i}`, in: in_, command: ["true"], standalone: true })),
  });

const runWith = (
  stepContainers: readonly string[],
  over: Partial<Parameters<typeof runStandaloneSteps>[0]> = {},
) =>
  runStandaloneSteps({
    scope: "w1" as never,
    stackId: "42",
    stack: stackOf(stepContainers),
    worktreePath: "/wt",
    images: null,
    signal: undefined,
    ...over,
  });

beforeEach(() => {
  fake.calls = [];
  fake.handler = () => result();
});

describe("runStandaloneSteps over a fake podman (#247)", () => {
  it("marks every step of a container unavailable, calling no podman, when its image cannot be built", async () => {
    const runs = await runWith(["a", "a"], {
      images: async () => {
        throw new ImageBuildError("localhost/a:gate", "build failed", "");
      },
    });
    expect(runs.map((r) => r.result)).toEqual(["unavailable", "unavailable"]);
    expect(runs[0]!.detail).toContain("localhost/a:gate");
    expect(fake.calls).toEqual([]);
  });

  it("rethrows an image failure that is not a build error", async () => {
    await expect(runWith(["a"], {
      images: async () => {
        throw new Error("bug");
      },
    })).rejects.toThrow("bug");
  });

  it.each([
    ["fails", result({ exitCode: 125, errorMessage: "no space" }), "no space"],
    ["times out", result({ exitCode: null, timedOut: true }), "no answer within"],
  ])("marks every step unavailable when the copy %s to start, and still removes it", async (_n, started, detail) => {
    fake.handler = (args) => (args.includes("run") ? started : result());
    const runs = await runWith(["a", "a"]);
    expect(runs.map((r) => r.result)).toEqual(["unavailable", "unavailable"]);
    expect(runs[0]!.detail).toContain(detail);
    expect(verbs()).toEqual(["rm", "run", "rm"]);
  });

  it("returns the runs in stack order when the steps alternate between containers", async () => {
    const runs = await runWith(["a", "b", "a", "b"]);
    expect(runs.map((r) => r.step.name)).toEqual(["s0", "s1", "s2", "s3"]);
  });

  it("removes the copy when the signal aborts mid-step", async () => {
    let release!: () => void;
    fake.handler = (args) => args.includes("exec")
      ? new Promise((done) => {
          release = () => done(result());
        })
      : result();
    const controller = new AbortController();
    const pending = runWith(["a"], { signal: controller.signal });
    await vi.waitFor(() => expect(verbs()).toEqual(["rm", "run", "exec"]));
    controller.abort();
    await vi.waitFor(() => expect(verbs()).toEqual(["rm", "run", "exec", "rm"]));
    release();
    await pending;
    expect(verbs()).toEqual(["rm", "run", "exec", "rm"]);
  });

  it("execs nothing and removes the copy once it has started when the signal aborts while it starts", async () => {
    let release!: () => void;
    fake.handler = (args) => args.includes("run")
      ? new Promise((done) => {
          release = () => done(result());
        })
      : result();
    const controller = new AbortController();
    const pending = runWith(["a"], { signal: controller.signal });
    await vi.waitFor(() => expect(verbs()).toEqual(["rm", "run"]));
    controller.abort();
    release();
    const runs = await pending;
    expect(runs.map((r) => r.result)).toEqual(["unavailable"]);
    expect(verbs()).toEqual(["rm", "run", "rm", "rm"]);
  });
});
