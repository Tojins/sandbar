// The orphan sweep force-removes, so what it is ALLOWED to see is the whole
// safety property — and that lives entirely in the argv it builds (#28). A fake
// adapter would satisfy any contract; these tests drive the real functions
// through their `exec` seam and assert on the commands themselves.
//
// The failure being locked out: the lock is per-workdir but podman names are
// host-global, so two sandbar runs against different repos both hold their own
// lock legitimately. With a bare `sandbar-` filter, run B's between-cycle sweep
// force-removed run A's live pods, and run B's `pod rm -f` of a "stale"
// namesake tore down run A's live stack for the same issue number. Both were
// silent from A's side: containers vanished mid-gate and it reported infra.

import { describe, expect, it } from "vitest";

import {
  type RuntimeExec,
  cleanupOrphanContainers,
  findUnattributableResources,
} from "./containers.js";
import {
  networkNameFor,
  podNameFor,
  runScope,
  stackContainerNameFor,
} from "./naming.js";

const A = runScope("/repo-a/.sandbar");
const B = runScope("/repo-b/.sandbar");

// A fake podman holding a set of resources. `ls` filters the way podman's
// `--filter name=^<re>` is SUPPOSED to; a separate test covers what happens
// when it doesn't.
function fakeRuntime(world: {
  pods?: string[];
  containers?: string[];
  networks?: string[];
}) {
  const state = {
    pods: new Set(world.pods ?? []),
    containers: new Set(world.containers ?? []),
    networks: new Set(world.networks ?? []),
  };
  const calls: string[][] = [];
  const setFor = (args: readonly string[]): Set<string> =>
    args[0] === "pod"
      ? state.pods
      : args[0] === "network"
        ? state.networks
        : state.containers;

  const run: RuntimeExec = async (args) => {
    calls.push([...args]);
    const verb = args.includes("ls") || args.includes("ps") ? "list" : "rm";
    const bag = setFor(args);
    if (verb === "list") {
      const filter = args[args.indexOf("--filter") + 1] ?? "";
      const prefix = (filter.split("name=^")[1] ?? "").replace(/^name=/, "");
      return {
        stdout: [...bag].filter((n) => n.startsWith(prefix)).join("\n"),
      };
    }
    const name = args[args.length - 1] as string;
    if (!bag.delete(name)) throw new Error(`no such resource: ${name}`);
    // `pod rm` takes its members with it, including the infra container whose
    // podman-assigned `<hash>-infra` name matches no sandbar prefix.
    if (args[0] === "pod") {
      for (const c of state.containers) {
        if (c.startsWith(name.replace("-pod-", "-")) || c.endsWith("-infra")) {
          state.containers.delete(c);
        }
      }
    }
    return { stdout: "" };
  };
  return { run, calls, state };
}

describe("cleanupOrphanContainers", () => {
  it("removes its own scope's debris", async () => {
    const { run, state } = fakeRuntime({
      pods: [podNameFor(A, "42")],
      containers: [stackContainerNameFor(A, "42", "db"), `sandbar-${A}-someuuid`],
      networks: [networkNameFor(A, "42")],
    });
    const removed = await cleanupOrphanContainers(A, run);
    expect(removed).toContain(podNameFor(A, "42"));
    expect(removed).toContain(networkNameFor(A, "42"));
    expect(removed).toContain(`sandbar-${A}-someuuid`);
    expect(state.pods.size).toBe(0);
    expect(state.networks.size).toBe(0);
  });

  it("cannot see another run's live resources — the whole point of #28", async () => {
    const { run, state } = fakeRuntime({
      pods: [podNameFor(B, "42")],
      containers: [stackContainerNameFor(B, "42", "db"), `sandbar-${B}-someuuid`],
      networks: [networkNameFor(B, "42")],
    });
    const removed = await cleanupOrphanContainers(A, run);
    expect(removed).toEqual([]);
    expect(state.pods.size).toBe(1);
    expect(state.containers.size).toBe(2);
    expect(state.networks.size).toBe(1);
  });

  it("leaves pre-#28 unscoped resources alone rather than guessing", async () => {
    // They could belong to an old sandbar running RIGHT NOW, which is exactly
    // the case this issue is about. findUnattributableResources reports them.
    const { run, state } = fakeRuntime({
      pods: ["sandbar-pod-42", "sandcastle-pod-42"],
      containers: ["sandbar-42-db", "sandbar-1a2b3c4d-5e6f-7081-9234-56789abc"],
      networks: ["sandbar-net-42"],
    });
    expect(await cleanupOrphanContainers(A, run)).toEqual([]);
    expect(state.pods.size).toBe(2);
    expect(state.containers.size).toBe(2);
    expect(state.networks.size).toBe(1);
  });

  it("scopes every filter it sends, at every resource kind", async () => {
    const { run, calls } = fakeRuntime({});
    await cleanupOrphanContainers(A, run);
    const filters = calls
      .filter((c) => c.includes("--filter"))
      .map((c) => c[c.indexOf("--filter") + 1]);
    expect(filters).toEqual([
      `name=^sandbar-${A}-pod-`,
      `name=^sandbar-${A}-`,
      `name=^sandbar-${A}-net-`,
    ]);
  });

  it("still filters locally when podman's name filter is not anchored", async () => {
    // podman's `--filter name=` has been a substring match on some versions, so
    // the `^` in the regex is not on its own load-bearing enough to rely on.
    const seen: string[] = [];
    const leaky: RuntimeExec = async (args) => {
      if (args.includes("--filter")) {
        return { stdout: [podNameFor(A, "42"), podNameFor(B, "42")].join("\n") };
      }
      seen.push(args[args.length - 1] as string);
      return { stdout: "" };
    };
    const removed = await cleanupOrphanContainers(A, leaky);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((n) => n.startsWith(`sandbar-${A}-`))).toBe(true);
    expect(removed).not.toContain(podNameFor(B, "42"));
  });

  it("removes pods before networks, or the network is still attached", async () => {
    const { run, calls } = fakeRuntime({
      pods: [podNameFor(A, "42")],
      networks: [networkNameFor(A, "42")],
    });
    await cleanupOrphanContainers(A, run);
    const rms = calls.filter((c) => c.includes("rm")).map((c) => c[0]);
    expect(rms.indexOf("pod")).toBeLessThan(rms.indexOf("network"));
  });

  it("uses -t 0 so a leaked pod does not cost 10s per member", async () => {
    const { run, calls } = fakeRuntime({ pods: [podNameFor(A, "42")] });
    await cleanupOrphanContainers(A, run);
    expect(calls).toContainEqual(["pod", "rm", "-f", "-t", "0", podNameFor(A, "42")]);
  });

  it("returns empty when the runtime is not installed", async () => {
    const missing: RuntimeExec = async () => {
      throw new Error("spawn podman ENOENT");
    };
    expect(await cleanupOrphanContainers(A, missing)).toEqual([]);
  });
});

describe("findUnattributableResources", () => {
  it("names pre-scope and legacy debris with a removal command", async () => {
    const { run } = fakeRuntime({
      pods: ["sandbar-pod-42", "sandcastle-pod-7"],
      containers: ["sandbar-42-db"],
      networks: ["sandbar-net-42"],
    });
    const { names, removalCommands } = await findUnattributableResources(run);
    expect(names.sort()).toEqual(
      ["sandbar-42-db", "sandbar-net-42", "sandbar-pod-42", "sandcastle-pod-7"].sort(),
    );
    expect(removalCommands).toContain("podman pod rm -f -t 0 sandbar-pod-42");
    expect(removalCommands).toContain("podman network rm sandbar-net-42");
  });

  it("stays silent about resources any run's scope claims", async () => {
    // Including OTHER runs': they may be live, and they are that run's to reap.
    const { run } = fakeRuntime({
      pods: [podNameFor(A, "42"), podNameFor(B, "42")],
      containers: [stackContainerNameFor(B, "42", "db"), `sandbar-${B}-someuuid`],
      networks: [networkNameFor(A, "42")],
    });
    expect((await findUnattributableResources(run)).names).toEqual([]);
  });

  it("reports a pre-#28 agent-sandbox container despite its hex-looking name", async () => {
    // `sandbar-<uuid>`: the uuid's first segment is 8 hex chars, so only the
    // leading `w` of a real scope keeps this from being silently claimed.
    const { run } = fakeRuntime({
      containers: ["sandbar-1a2b3c4d-5e6f-7081-9234-56789abcdef0"],
    });
    expect((await findUnattributableResources(run)).names).toEqual([
      "sandbar-1a2b3c4d-5e6f-7081-9234-56789abcdef0",
    ]);
  });

  it("reports nothing when the runtime is not installed", async () => {
    const missing: RuntimeExec = async () => {
      throw new Error("spawn podman ENOENT");
    };
    expect(await findUnattributableResources(missing)).toEqual({
      names: [],
      removalCommands: [],
    });
  });
});
