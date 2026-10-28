// startEgress's cleanup.ts registration, against a scripted podman: the
// registered disposable tears the proxy down, and `stop` withdraws it.

import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({
  actions: [] as Array<() => Promise<void> | void>,
  withdraw: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>,
}));

vi.mock("./cleanup.js", () => ({
  registerDisposable: (action: () => Promise<void> | void) => {
    registered.actions.push(action);
    return registered.withdraw;
  },
  reportCleanupNotice: vi.fn(),
}));

vi.mock("./container-resources.js", () => ({
  readContainerResources: async () => ({}),
  systemContainerResourceDeps: () => ({}),
}));

const podman = vi.hoisted(() => ({ calls: [] as string[][], logPath: "" }));

vi.mock("./gate-stack.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./gate-stack.js")>(),
  boundedPodman: async (args: string[]) => {
    podman.calls.push([...args]);
    if (args[0] === "run") await appendFile(podman.logPath, '{"t":"ready"}\n');
    return { ok: true, stdout: "10.9.0.2\n" };
  },
  boundedOk: (r: { ok: boolean }) => r.ok,
  containerState: async () => "running",
  logTail: async () => "",
}));

const { startEgress } = await import("./egress.js");
const { gateScope } = await import("./naming.js");

describe("startEgress cleanup registration", () => {
  const start = async () => {
    const logDir = await mkdtemp(join(tmpdir(), "egress-dispose-"));
    podman.logPath = join(logDir, "owner.jsonl");
    return startEgress({
      scope: gateScope("/egress-dispose-test"),
      owner: "owner",
      networkName: "net",
      createNetwork: false,
      image: "img",
      policy: { mode: "enforce", entries: [] } as never,
      logDir,
    });
  };
  const removals = () =>
    podman.calls.filter((c) => c[0] === "rm");

  beforeEach(() => {
    registered.actions.length = 0;
    registered.withdraw = vi.fn();
    podman.calls.length = 0;
  });

  it("registers a disposable that removes the proxy when invoked", async () => {
    await start();
    expect(registered.actions).toHaveLength(1);
    const before = removals().length;
    await registered.actions[0]?.();
    expect(removals().length).toBeGreaterThan(before);
  });

  it("withdraws the registration on stop, once, however often stop is called", async () => {
    const handle = await start();
    expect(registered.withdraw).not.toHaveBeenCalled();
    await Promise.all([handle.stop(), handle.stop()]);
    await handle.stop();
    expect(registered.withdraw).toHaveBeenCalledTimes(1);
  });
});
