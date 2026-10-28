// The nightly job's failure paths without a container (#201): podman is a
// script here, so each reason code, the job-error catch and the interrupt
// disposable are reached by what the script answers. Plain `rm` stands in for
// `podman unshare`, as in db-base-fs.test.ts.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertDatabaseCopiesTarget, resolveDatabaseCopies, resolveGateStack } from "./config.js";
import { type UsernsRun, dbBaseLayout, readImportStatus, runDbBaseJob } from "./db-base.js";
import type { BoundedResult } from "./gate-stack.js";

const mocks = vi.hoisted(() => ({
  podman: vi.fn<(args: readonly string[]) => Promise<unknown>>(),
  ready: vi.fn<() => Promise<void>>(),
  disposables: [] as Array<() => Promise<void>>,
  withdrawn: vi.fn(),
}));

vi.mock("./gate-stack.js", async (original) => ({
  ...(await original<typeof import("./gate-stack.js")>()),
  boundedPodman: (args: readonly string[]) => mocks.podman(args),
  pollUntilReady: () => mocks.ready(),
}));
vi.mock("./cleanup.js", async (original) => ({
  ...(await original<typeof import("./cleanup.js")>()),
  registerDisposable: (action: () => Promise<void>) => {
    mocks.disposables.push(action);
    return mocks.withdrawn;
  },
}));

const { ContainerBringupError } = await import("./gate-stack.js");

const exec = promisify(execFile);
const plainFs: UsernsRun = async ([command, ...args]) => (await exec(command!, args)).stdout;
const result = (exitCode: number, over: Partial<BoundedResult> = {}): BoundedResult => ({
  stdout: "", stderr: "", exitCode, timedOut: false, maxBufferExceeded: false, errorMessage: "", ...over,
});
const ok = result(0);

const target = assertDatabaseCopiesTarget(
  resolveGateStack({
    containers: [
      {
        name: "db",
        image: "docker.io/library/mariadb:10.11",
        inSandbox: true,
        readiness: { kind: "healthcheck", command: ["healthcheck.sh"] },
      },
      { name: "runner", image: "localhost/runner", mountWorktree: "/w", hold: true },
    ],
    steps: [{ name: "s", in: "runner", command: ["true"] }],
  }),
  resolveDatabaseCopies({ dump: "/d", root: "/r", container: "db", database: "app" })!,
);

let root: string;
let layout: ReturnType<typeof dbBaseLayout>;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sandbar-db-base-abort-")));
  layout = dbBaseLayout(root);
  await mkdir(join(root, "drop"));
  await writeFile(join(root, "drop/app-latest.sql.gz"), "dump");
  mocks.podman.mockReset().mockResolvedValue(ok);
  mocks.ready.mockReset().mockResolvedValue(undefined);
  mocks.withdrawn.mockReset();
  mocks.disposables.length = 0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const job = (userns: UsernsRun = plainFs) => runDbBaseJob({
  cfg: resolveDatabaseCopies({
    dump: join(root, "drop/app-latest.sql.gz"), root, container: "db", database: "app",
  })!,
  target,
  force: false,
  log: () => undefined,
  userns,
  freeBytes: async () => 1n << 50n,
});

const calls = (verb: string) => mocks.podman.mock.calls.filter(([args]) => args[0] === verb);

describe("runDbBaseJob failure paths", () => {
  it.each([
    ["container-failed", () => mocks.podman.mockImplementation(async (args) =>
      args[0] === "run" ? result(125, { errorMessage: "no such image" }) : ok)],
    ["not-ready", () => mocks.ready.mockRejectedValue(new ContainerBringupError("c", "never healthy", "tail"))],
  ])("records %s, removes the container and the base, and keeps current unset", async (reason, script) => {
    script();
    await expect(job()).resolves.toBe("import-failed");
    expect(await readImportStatus(layout)).toMatchObject({ outcome: "import-failed", detail: reason });
    expect(await readdir(layout.bases)).toEqual([]);
    // The pre-import removal of a killed job's leftover, then this job's own.
    expect(calls("rm")).toHaveLength(2);
    expect(mocks.withdrawn).toHaveBeenCalled();
  });

  it("removes the container and base and records job-error when the import throws", async () => {
    mocks.podman.mockImplementation(async (args) => {
      if (args[0] === "run") throw new Error("podman is gone");
      return ok;
    });
    await expect(job()).rejects.toThrow("podman is gone");
    expect(await readImportStatus(layout)).toMatchObject({ outcome: "import-failed", detail: "job-error" });
    expect(await readdir(layout.bases)).toEqual([]);
    expect(calls("rm")).toHaveLength(2);
  });

  it("records job-error even when the cleanup after it fails, and rethrows the import's error", async () => {
    mocks.podman.mockImplementation(async (args) => {
      if (args[0] === "run") throw new Error("podman is gone");
      return ok;
    });
    const stuck: UsernsRun = async () => {
      throw new Error("rm is stuck");
    };
    await expect(job(stuck)).rejects.toThrow("podman is gone");
    expect(await readImportStatus(layout)).toMatchObject({ detail: "job-error" });
  });

  it("records interrupted and tears down when a signal runs the registered disposable", async () => {
    mocks.podman.mockImplementation(async (args) => {
      if (args[0] !== "run") return ok;
      await mocks.disposables[0]!();
      // The job's own failure after the signal is not recorded over it.
      return result(125);
    });
    await job();
    expect(await readImportStatus(layout)).toMatchObject({ outcome: "import-failed", detail: "interrupted" });
    expect(await readdir(layout.bases)).toEqual([]);
    await expect(readdir(root)).resolves.not.toContain("current");
  });
});
