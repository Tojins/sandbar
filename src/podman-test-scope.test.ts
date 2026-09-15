// The podman fixture contracts a gate with no podman can see (#47, #165).
//
// Scope isolation itself is asserted by running two copies of a podman test
// file concurrently and watching both pass, which the gate structurally cannot
// do. The pure check here catches the realistic regression that would silently
// give it all back: somebody restoring a constant "for reproducibility". The
// removal-hook checks use a fake executable so exit/log/removal ordering stays
// visible on hosts where the real runtime is intentionally absent.

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestContext } from "vitest";

import {
  type FinishedHook,
  podmanTestScope,
  podmanTestStackId,
  removeFixtureContainerOnTestFinished,
} from "./podman-test-scope.test-util.js";

describe("podmanTestScope", () => {
  it("gives every call its own scope and its own fixture tags", () => {
    const a = podmanTestScope("x");
    const b = podmanTestScope("x");

    // Per CALL, not per file: a module-level const would draw its uniqueness
    // from vitest's per-file isolation, which `--no-isolate` removes.
    expect(a.scope).not.toBe(b.scope);
    expect(a.testImageTag("probe")).not.toBe(b.testImageTag("probe"));

    // The sibling scope is a scope the sweeps must be blind to, so it must not
    // be the process's own — nor another process's, which is why it is derived
    // from the same token rather than hardcoded.
    expect(a.otherScope).not.toBe(a.scope);
    expect(a.otherScope).not.toBe(b.otherScope);
  });

  it("keeps stack ids readable, stable per task, and distinct between tasks", () => {
    const first = podmanTestStackId("podmantest", "task-a");
    expect(first).toBe(podmanTestStackId("podmantest", "task-a"));
    expect(first).not.toBe(podmanTestStackId("podmantest", "task-b"));
    expect(first).toMatch(/^podmantest-[0-9a-f]{10}$/);
  });
});

describe("removeFixtureContainerOnTestFinished", () => {
  let binDir: string;
  let callsPath: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), "sandbar-fake-podman-"));
    callsPath = join(binDir, "calls");
    originalPath = process.env["PATH"];
    const podman = join(binDir, "podman");
    await writeFile(
      podman,
      "#!/bin/sh\n" +
        "printf '%s\\n' \"$*\" >> \"$FAKE_PODMAN_CALLS\"\n" +
        "if [ \"$1 $2 $3\" = \"container exists gone\" ]; then exit 1; fi\n" +
        "if [ \"$1 $2 $3\" = \"container exists exists-error\" ]; then\n" +
        "  printf 'existence check failed\\n' >&2; exit 125\n" +
        "fi\n" +
        "if [ \"$1\" = inspect ]; then printf '127\\n'; exit 0; fi\n" +
        "if [ \"$1\" = logs ]; then\n" +
        "  if [ \"$4\" = collect-rm-fail ]; then\n" +
        "    printf 'log read failed\\n' >&2; exit 125\n" +
        "  fi\n" +
        "  printf 'starting fixture\\n'\n" +
        "  printf 'httpd: applet not found\\n' >&2\n" +
        "fi\n" +
        "if [ \"$1\" = rm ]; then\n" +
        "  case \" $* \" in\n" +
        "    *\" rm-fail \"*|*\" collect-rm-fail \"*)\n" +
        "      printf 'fixture removal failed\\n' >&2; exit 125;;\n" +
        "  esac\n" +
        "fi\n",
    );
    await chmod(podman, 0o755);
    process.env["PATH"] = `${binDir}:${originalPath ?? ""}`;
    process.env["FAKE_PODMAN_CALLS"] = callsPath;
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    delete process.env["FAKE_PODMAN_CALLS"];
    await rm(binDir, { recursive: true, force: true });
  });

  const registeredHook = (
    ...args: readonly string[]
  ): ((context: TestContext) => Promise<void>) => {
    let hook: ((context: TestContext) => Promise<void>) | undefined;
    const onTestFinished = ((candidate, timeout) => {
      hook = candidate;
      expect(timeout).toBe(60_000);
    }) as FinishedHook;
    removeFixtureContainerOnTestFinished(onTestFinished, ...args);
    if (hook === undefined) throw new Error("finished hook was not registered");
    return hook;
  };

  const context = (state: "pass" | "fail"): TestContext =>
    ({ task: { result: { state } } }) as unknown as TestContext;

  const calls = async (): Promise<string[]> =>
    (await readFile(callsPath, "utf8")).trim().split("\n");

  it("attaches exit and log evidence to a failure after removing the fixture", async () => {
    const hook = registeredHook("--depend", "dead");

    await expect(hook(context("fail"))).rejects.toThrow(
      /dead exit code: 127[\s\S]*starting fixture[\s\S]*httpd: applet not found/,
    );
    const recorded = await calls();
    expect(recorded[0]).toBe("container exists dead");
    expect(recorded.slice(1, -1)).toEqual(
      expect.arrayContaining([
        "inspect --format {{.State.ExitCode}} dead",
        "logs --tail 40 dead",
      ]),
    );
    expect(recorded.slice(1, -1)).toHaveLength(2);
    expect(recorded.at(-1)).toBe("rm -f -v -t 0 --depend dead");
  });

  it("removes a passing fixture without reading or emitting diagnostics", async () => {
    const hook = registeredHook("live");

    await expect(hook(context("pass"))).resolves.toBeUndefined();
    expect(await calls()).toEqual([
      "container exists live",
      "rm -f -v -t 0 live",
    ]);
  });

  it("propagates a passing test's fixture removal failure", async () => {
    const hook = registeredHook("rm-fail");

    await expect(hook(context("pass"))).rejects.toThrow(
      /fixture removal failed/,
    );
    expect(await calls()).toEqual([
      "container exists rm-fail",
      "rm -f -v -t 0 rm-fail",
    ]);
  });

  it("does nothing when the fixture is already gone", async () => {
    const hook = registeredHook("gone");

    await expect(hook(context("fail"))).resolves.toBeUndefined();
    expect(await readFile(callsPath, "utf8")).toBe("container exists gone\n");
  });

  it("propagates an existence-check infrastructure failure", async () => {
    const hook = registeredHook("exists-error");

    await expect(hook(context("fail"))).rejects.toThrow(
      /existence check failed/,
    );
    expect(await calls()).toEqual(["container exists exists-error"]);
  });

  it("keeps diagnostics when fixture removal also fails", async () => {
    const hook = registeredHook("rm-fail");

    let caught: unknown;
    try {
      await hook(context("fail"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
    expect((caught as Error).message).toMatch(
      /rm-fail exit code: 127[\s\S]*httpd: applet not found[\s\S]*fixture container removal also failed[\s\S]*fixture removal failed/,
    );
    expect((await calls()).at(-1)).toBe("rm -f -v -t 0 rm-fail");
  });

  it("keeps an evidence-read failure when fixture removal also fails", async () => {
    const hook = registeredHook("collect-rm-fail");

    let caught: unknown;
    try {
      await hook(context("fail"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
    expect((caught as Error).message).toMatch(
      /log read failed[\s\S]*fixture container removal also failed[\s\S]*fixture removal failed/,
    );
    expect((await calls()).at(-1)).toBe("rm -f -v -t 0 collect-rm-fail");
  });

  it("diagnoses and removes present fixtures while excluding an absent sibling", async () => {
    const hook = registeredHook("--depend", "live", "gone");

    await expect(hook(context("fail"))).rejects.toThrow(
      /live exit code: 127/,
    );
    const recorded = await calls();
    expect(recorded.slice(0, 2)).toEqual(
      expect.arrayContaining([
        "container exists live",
        "container exists gone",
      ]),
    );
    expect(recorded.slice(2, -1)).toEqual(
      expect.arrayContaining([
        "inspect --format {{.State.ExitCode}} live",
        "logs --tail 40 live",
      ]),
    );
    expect(recorded.slice(2, -1)).toHaveLength(2);
    expect(recorded.at(-1)).toBe("rm -f -v -t 0 --depend live");
    expect(recorded.join("\n")).not.toMatch(/(?:inspect|logs).*gone/);
  });
});
