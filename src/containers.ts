// Orphan resource cleanup.
//
// All sandbar containers, pods and networks live in podman: the agent sandbox
// (created by the in-house provider as `sandbar-<uuid>`), the gate stack's
// containers (`sandbar-<stackId>-<name>`; `sandbar-db-*` / `sandbar-pg-*` on
// pre-#24 builds — all match the bare prefix below), the per-stack pod
// (`sandbar-pod-*`) and the per-stack network (`sandbar-net-*`). We identify
// orphans by name prefix; switching to label-based filtering (`sandbar=true`,
// already applied by the merger and by every stack container) is a one-line
// change.
//
// PODS MUST BE SWEPT SEPARATELY, and not as a tidiness measure (#24). A pod's
// infra container is named `<pod-id-prefix>-infra` — a podman-assigned hash,
// e.g. `c5968a5425d7-infra` — which matches no sandbar prefix at all. Removing
// containers by name therefore leaves the infra container running, the pod
// alive, and its network un-removable, so every aborted run would leak a pod
// the name-prefix sweep is structurally unable to see. `pod rm -f` takes the
// members and the infra container with it.
//
// During the sandcastle→sandbar transition the sweep also matches the legacy
// `sandcastle-*` prefixes so pre-existing resources on already-running repos
// are reaped rather than orphaned (see ./naming.ts).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ALL_RESOURCE_PREFIXES,
  LEGACY_RESOURCE_PREFIXES,
  RESOURCE_PREFIX,
} from "./naming.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

// Networks are named `<prefix>net-*`, pods `<prefix>pod-*`; containers carry
// the bare prefix.
const NETWORK_PREFIXES: readonly string[] = [
  RESOURCE_PREFIX,
  ...LEGACY_RESOURCE_PREFIXES,
].map((p) => `${p}net-`);

const POD_PREFIXES: readonly string[] = [
  RESOURCE_PREFIX,
  ...LEGACY_RESOURCE_PREFIXES,
].map((p) => `${p}pod-`);

async function listContainerOrphans(): Promise<string[]> {
  const found = new Set<string>();
  for (const prefix of ALL_RESOURCE_PREFIXES) {
    try {
      const { stdout } = await exec(RUNTIME, [
        "ps",
        "-a",
        "--filter",
        `name=^${prefix}`,
        "--format",
        "{{.Names}}",
      ]);
      for (const n of stdout.split("\n").map((s) => s.trim())) {
        if (n.startsWith(prefix)) found.add(n);
      }
    } catch {
      // runtime not installed — nothing to clean
      return [];
    }
  }
  return [...found];
}

async function listNetworkOrphans(): Promise<string[]> {
  const found = new Set<string>();
  for (const prefix of NETWORK_PREFIXES) {
    try {
      const { stdout } = await exec(RUNTIME, [
        "network",
        "ls",
        "--filter",
        `name=^${prefix}`,
        "--format",
        "{{.Name}}",
      ]);
      for (const n of stdout.split("\n").map((s) => s.trim())) {
        if (n.startsWith(prefix)) found.add(n);
      }
    } catch {
      return [];
    }
  }
  return [...found];
}

async function listPodOrphans(): Promise<string[]> {
  const found = new Set<string>();
  for (const prefix of POD_PREFIXES) {
    try {
      const { stdout } = await exec(RUNTIME, [
        "pod",
        "ls",
        "--filter",
        `name=^${prefix}`,
        "--format",
        "{{.Name}}",
      ]);
      for (const n of stdout.split("\n").map((s) => s.trim())) {
        if (n.startsWith(prefix)) found.add(n);
      }
    } catch {
      return [];
    }
  }
  return [...found];
}

async function removePod(name: string): Promise<boolean> {
  try {
    await exec(RUNTIME, ["pod", "rm", "-f", name]);
    return true;
  } catch {
    return false;
  }
}

async function removeContainer(name: string): Promise<boolean> {
  try {
    await exec(RUNTIME, ["rm", "-f", name]);
    return true;
  } catch {
    return false;
  }
}

async function removeNetwork(name: string): Promise<boolean> {
  try {
    await exec(RUNTIME, ["network", "rm", name]);
    return true;
  } catch {
    return false;
  }
}

export async function cleanupOrphanContainers(): Promise<readonly string[]> {
  const removed: string[] = [];
  // Pods first: `pod rm -f` takes its member containers AND its unreachably-
  // named infra container with it, so this is the only step that can free the
  // pod's network. Doing it after the container sweep would work too, but doing
  // it first means the container sweep has less to find.
  for (const name of await listPodOrphans()) {
    if (await removePod(name)) removed.push(name);
  }
  // Then loose containers; a network can't be removed while a container is
  // still attached. After force-removing all sandbar-prefixed containers, the
  // network removal is unblocked.
  for (const name of await listContainerOrphans()) {
    if (await removeContainer(name)) removed.push(name);
  }
  for (const name of await listNetworkOrphans()) {
    if (await removeNetwork(name)) removed.push(name);
  }
  return removed;
}
