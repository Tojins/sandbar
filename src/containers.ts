// Orphan resource cleanup.
//
// All sandcastle containers and networks live in podman: the agent sandbox
// (created by @ai-hero/sandcastle's podman provider as `sandcastle-<uuid>`),
// the gate runner, the per-issue pg sidecar (`sandcastle-pg-*`), and the
// per-issue network (`sandcastle-net-*`). We identify orphans by name
// prefix; the upstream library doesn't yet apply a `sandcastle=true` label,
// but switching to label-based filtering when it does is a one-line change.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { RUNTIME } from "./pg-sidecar.js";

const exec = promisify(execFile);

const NAME_PREFIX = "sandcastle-";
const NETWORK_PREFIX = "sandcastle-net-";

async function listContainerOrphans(): Promise<string[]> {
  try {
    const { stdout } = await exec(RUNTIME, [
      "ps",
      "-a",
      "--filter",
      `name=^${NAME_PREFIX}`,
      "--format",
      "{{.Names}}",
    ]);
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((n) => n.startsWith(NAME_PREFIX));
  } catch {
    // runtime not installed — nothing to clean
    return [];
  }
}

async function listNetworkOrphans(): Promise<string[]> {
  try {
    const { stdout } = await exec(RUNTIME, [
      "network",
      "ls",
      "--filter",
      `name=^${NETWORK_PREFIX}`,
      "--format",
      "{{.Name}}",
    ]);
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((n) => n.startsWith(NETWORK_PREFIX));
  } catch {
    return [];
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
  // Containers first; a network can't be removed while a container is still
  // attached. After force-removing all sandcastle-prefixed containers, the
  // network removal is unblocked.
  for (const name of await listContainerOrphans()) {
    if (await removeContainer(name)) removed.push(name);
  }
  for (const name of await listNetworkOrphans()) {
    if (await removeNetwork(name)) removed.push(name);
  }
  return removed;
}
