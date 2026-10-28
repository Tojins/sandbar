// startEgress against a scripted podman: the registered cleanup.ts disposable
// tears the proxy down, `stop` withdraws it, and overlapping drains fold each
// log line once.

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

describe("startEgress drain", () => {
  it("folds each line once when drains overlap, including stop's own", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "egress-drain-"));
    podman.logPath = join(logDir, "owner.jsonl");
    const handle = await startEgress({
      scope: gateScope("/egress-drain-test"),
      owner: "owner",
      networkName: "net",
      createNetwork: false,
      image: "img",
      policy: { mode: "enforce", entries: [] } as never,
      logDir,
    });
    await appendFile(
      podman.logPath,
      '{"t":"allow","via":"tls","host":"a.test","port":443}\n' +
        '{"t":"refuse","via":"dns","host":"evil.test","port":null}\n',
    );
    const [first, second, summary] = await Promise.all([
      handle.drain(),
      handle.drain(),
      handle.stop(),
    ]);
    expect([...first.firstRefusals, ...second.firstRefusals, ...summary.firstRefusals])
      .toEqual([{ host: "evil.test", port: null, via: "dns", enforced: true }]);
    expect(summary.allowed).toEqual({ "a.test:443": 1 });
    expect(summary.refused).toEqual({ "evil.test": 1 });
  });
});
