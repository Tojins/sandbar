// Orphan resource cleanup.
//
// All sandbar containers, pods and networks live in podman: the agent sandbox
// (`sandbar-<scope>-<uuid>`), the gate stack's containers
// (`sandbar-<scope>-<stackId>-<name>`), the per-stack pod
// (`sandbar-<scope>-pod-<stackId>`) and its network
// (`sandbar-<scope>-net-<stackId>`). We identify orphans by name prefix.
//
// THE SWEEP ONLY EVER TOUCHES ITS OWN RUN'S SCOPE (#28). It force-removes, so
// its licence to act is that it can prove the resource is not someone else's:
// one lock ⇔ one scope (see naming.ts), so a `sandbar-<ourScope>-*` resource is
// either ours or a dead predecessor's on the same workdir. A bare `sandbar-*`
// match could prove nothing — the lock is per-workdir but podman names are
// host-global, so a second run against a different repo was legitimately live
// and got its pods destroyed mid-gate by its sibling's between-cycle sweep.
//
// What the sweep can no longer reach it REPORTS instead of removing:
// `findUnattributableResources` names pre-scope (`sandbar-*` with no scope
// segment) and legacy (`sandcastle-*`) debris and hands the operator the
// removal command. Deliberately not "remove it anyway, it's probably old" — an
// old sandbar running concurrently is exactly the case this issue is about, and
// a wrong guess there is silent and destructive. Resources in ANOTHER run's
// scope are not reported at all: they may be live, and they are that run's to
// reap.
//
// PODS MUST BE SWEPT SEPARATELY, and not as a tidiness measure (#24). A pod's
// infra container is named `<pod-id-prefix>-infra` — a podman-assigned hash,
// e.g. `c5968a5425d7-infra` — which matches no sandbar prefix at all. Removing
// containers by name therefore leaves the infra container running, the pod
// alive, and its network un-removable, so every aborted run would leak a pod
// the name-prefix sweep is structurally unable to see. `pod rm -f` takes the
// members and the infra container with it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ALL_RESOURCE_PREFIXES,
  type RunScope,
  isScopedResourceName,
  scopedResourcePrefix,
} from "./naming.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

// The seam. A fake satisfies any contract no matter what argv the real one
// builds, and here the argv IS the safety property: a filter that lost its
// scope segment would silently go back to force-removing a sibling run's live
// pods. Table-tested in containers.test.ts.
export type RuntimeExec = (
  args: readonly string[],
) => Promise<{ stdout: string }>;

const defaultExec: RuntimeExec = (args) => exec(RUNTIME, [...args]);

// The three resource kinds differ only in the argv that lists and removes
// them, so they are a table rather than three near-identical function pairs.
//
// `-t 0` on the removals for the same reason gate-stack.ts uses it on teardown:
// without it podman waits out its 10-second graceful stop PER CONTAINER, and a
// leaked pod with four members costs ~40s of dead time at the top of a cycle.
// Nothing being swept here has state worth flushing — it is by definition
// debris.
type ResourceKind = {
  readonly listArgs: (filter: string) => string[];
  readonly rmArgs: (name: string) => string[];
  // Suffix between the scoped prefix and the id, for the kinds that carry one.
  readonly infix: string;
};

// Pods first: `pod rm -f` takes its member containers AND its unreachably-named
// infra container with it, so this is the only step that can free the pod's
// network. Then loose containers — a network can't be removed while a container
// is still attached — then the networks.
const KINDS: readonly ResourceKind[] = [
  {
    listArgs: (f) => [
      "pod",
      "ls",
      "--filter",
      `name=^${f}`,
      "--format",
      "{{.Name}}",
    ],
    rmArgs: (n) => ["pod", "rm", "-f", "-t", "0", n],
    infix: "pod-",
  },
  {
    listArgs: (f) => [
      "ps",
      "-a",
      "--filter",
      `name=^${f}`,
      "--format",
      "{{.Names}}",
    ],
    rmArgs: (n) => ["rm", "-f", "-t", "0", n],
    infix: "",
  },
  {
    listArgs: (f) => [
      "network",
      "ls",
      "--filter",
      `name=^${f}`,
      "--format",
      "{{.Name}}",
    ],
    rmArgs: (n) => ["network", "rm", n],
    infix: "net-",
  },
];

// The `--filter name=^<prefix>` is podman-side and anchored, but the local
// `startsWith` re-check stays: podman's name filter is a regex, so a prefix
// containing regex metacharacters would match more than intended, and the
// filter has historically been substring-matched on some versions.
//
// A failure here PROPAGATES. It used to be caught and reported as "runtime not
// installed", which preflight has already made unreachable — it hard-fails on a
// missing container runtime before the lock is taken, so anything that fails
// here is a real podman fault (storage-lock contention, a broken
// `podman system`, EPERM). Swallowing those was silent in the worst way: the
// sweep claimed to have removed nothing, debris accumulated, and the first
// visible symptom was an unrelated-looking `startStack` collision. Worse for the
// debris report, which returned an empty result — thereby claiming there was
// nothing to see — while discarding names it had already collected.
async function listByPrefix(
  kind: ResourceKind,
  prefix: string,
  run: RuntimeExec,
): Promise<string[]> {
  const { stdout } = await run(kind.listArgs(prefix));
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((n) => n.startsWith(prefix));
}

export type SweepResult = {
  readonly removed: readonly string[];
  // Resources that were found and could not be removed, preformatted with the
  // command and podman's reason.
  //
  // Reported rather than thrown, and that asymmetry with `listByPrefix` above is
  // deliberate. A failed LIST is a blind sweep: it cannot know what it missed,
  // so continuing means asserting "no debris" on no evidence. A failed REMOVE
  // knows exactly what leaked, and it is self-healing — `startStack` force-
  // removes a namesake before creating one, so the next cycle clears what this
  // one could not. Throwing would let one wedged leftover from an unrelated
  // crash block every future run of the repo, replacing a recoverable leak with
  // a hard stop. But it is not silent: the operator is told what leaked and how
  // to clear it.
  readonly failures: readonly string[];
};

// Sweep this run's scope.
export async function cleanupOrphanContainers(
  scope: RunScope,
  run: RuntimeExec = defaultExec,
): Promise<SweepResult> {
  const removed: string[] = [];
  const failures: string[] = [];
  for (const kind of KINDS) {
    const names = await listByPrefix(
      kind,
      `${scopedResourcePrefix(scope)}${kind.infix}`,
      run,
    );
    for (const name of names) {
      const args = kind.rmArgs(name);
      try {
        await run(args);
        removed.push(name);
      } catch (err) {
        failures.push(
          `  ${RUNTIME} ${args.join(" ")}\n    ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
  return { removed, failures };
}

export type UnattributableResources = {
  readonly names: readonly string[];
  // Copy-pasteable, in the order that actually works (pods before networks).
  // A pod's members are listed separately even though `pod rm` already took
  // them; `podman rm -f` exits 0 on a container that is already gone (verified),
  // so the list stays paste-and-forget rather than needing pod membership
  // resolved first. Networks never cascade, so a listed one always still
  // exists — which matters because `network rm` does NOT tolerate a missing
  // name.
  readonly removalCommands: readonly string[];
};

// Podman resources carrying a sandbar-ish name that no run's scope claims:
// debris from a build predating #28, or from the sandcastle era. Reported, not
// removed — see the module header.
export async function findUnattributableResources(
  run: RuntimeExec = defaultExec,
): Promise<UnattributableResources> {
  const names: string[] = [];
  const removalCommands: string[] = [];
  for (const kind of KINDS) {
    const found = new Set<string>();
    for (const prefix of ALL_RESOURCE_PREFIXES) {
      // Note the prefix is the BARE one — an unscoped pod is `sandbar-pod-42`,
      // with the infix straight after the prefix, exactly as it was before #28.
      const listed = await listByPrefix(kind, `${prefix}${kind.infix}`, run);
      for (const n of listed) {
        if (!isScopedResourceName(n)) found.add(n);
      }
    }
    for (const name of found) {
      names.push(name);
      removalCommands.push(`${RUNTIME} ${kind.rmArgs(name).join(" ")}`);
    }
  }
  return { names, removalCommands };
}
