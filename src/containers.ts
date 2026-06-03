// Orphan resource cleanup.
//
// All sandbar containers and networks live in podman: the agent sandbox
// (created by the in-house provider as `sandbar-<uuid>`), the gate runner, the
// per-issue pg sidecar (`sandbar-pg-*`), and the per-issue network
// (`sandbar-net-*`). We identify orphans by name prefix; switching to
// label-based filtering (`sandbar=true`, already applied by the merger) is a
// one-line change.
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
import { RUNTIME } from "./pg-sidecar.js";

const exec = promisify(execFile);

// Networks are named `<prefix>net-*`; containers carry the bare prefix.
const NETWORK_PREFIXES: readonly string[] = [
  RESOURCE_PREFIX,
  ...LEGACY_RESOURCE_PREFIXES,
].map((p) => `${p}net-`);

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
  // Containers first; a network can't be removed while a container is still
  // attached. After force-removing all sandbar-prefixed containers, the
  // network removal is unblocked.
  for (const name of await listContainerOrphans()) {
    if (await removeContainer(name)) removed.push(name);
  }
  for (const name of await listNetworkOrphans()) {
    if (await removeNetwork(name)) removed.push(name);
  }
  return removed;
}
