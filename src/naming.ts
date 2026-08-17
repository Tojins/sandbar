// Centralized naming for sandbar's load-bearing identifiers.
//
// Branch names, container/network/pod names, and the resource label all share a
// common prefix that the planner (creation), the preflight cleanup, and the
// orphan sweeper key on. Keeping them here makes the prefix a single knob.
//
// Transition note (sandcastle → sandbar, issue #11): repos that ran an older
// sandbar may still carry `sandcastle/issue-*` branches and `sandcastle-*`
// containers/networks. New resources are always created with the current
// prefixes, but the sweep/clean paths additionally recognize the LEGACY_*
// prefixes so pre-existing artifacts are reaped rather than orphaned. Once all
// hosts have drained their `sandcastle/*` resources, delete the LEGACY_*
// exports and their call-site uses for a clean cutover.

// Branch prefix for per-issue work branches: `sandbar/issue-<n>-<slug>`.
export const BRANCH_PREFIX = "sandbar/";

// Old branch prefix, recognized (not created) during the transition window.
export const LEGACY_BRANCH_PREFIXES: readonly string[] = ["sandcastle/"];

// Container / network / pod / image / label prefix: `sandbar-*`.
export const RESOURCE_PREFIX = "sandbar-";

// Old resource prefix, recognized (not created) during the transition window.
export const LEGACY_RESOURCE_PREFIXES: readonly string[] = ["sandcastle-"];

// All branch prefixes the cleanup paths should match (current + legacy).
export const ALL_BRANCH_PREFIXES: readonly string[] = [
  BRANCH_PREFIX,
  ...LEGACY_BRANCH_PREFIXES,
];

// All resource prefixes the orphan sweeper should match (current + legacy).
export const ALL_RESOURCE_PREFIXES: readonly string[] = [
  RESOURCE_PREFIX,
  ...LEGACY_RESOURCE_PREFIXES,
];

// ---------------------------------------------------------------------------
// Gate-stack resource names (#24)
//
// A stack is identified by a `stackId` — the issue id in the inner loop, the
// literal "merger" for gate-2. Three shapes, all sharing RESOURCE_PREFIX so the
// orphan sweeper's name filters reach them:
//
//   network    sandbar-net-<stackId>
//   pod        sandbar-pod-<stackId>
//   container  sandbar-<stackId>-<containerName>
//
// The pod's own INFRA container is the exception and the reason the sweeper
// cannot be containers-and-networks-only: podman names it `<pod-id-prefix>-infra`
// (a hash, e.g. `c5968a5425d7-infra`), which matches no sandbar prefix. Only
// `podman pod rm` reaches it, so cleanupOrphanContainers sweeps pods too.
// ---------------------------------------------------------------------------

export function networkNameFor(stackId: string): string {
  return `${RESOURCE_PREFIX}net-${stackId}`;
}

export function podNameFor(stackId: string): string {
  return `${RESOURCE_PREFIX}pod-${stackId}`;
}

export function stackContainerNameFor(stackId: string, name: string): string {
  return `${RESOURCE_PREFIX}${stackId}-${name}`;
}

// Reverse of the branch-naming convention: pull the issue number out of a
// per-issue branch name (`<prefix>issue-<n>-<slug>`), recognizing every
// current + legacy prefix. Returns null for anything that doesn't match the
// load-bearing shape — preflight's resume path treats those as unrecognized
// (a hard error), never as resumable. A bare `<prefix>issue-<n>` with no slug
// is still matched so the parser doesn't hinge on slug presence.
export function issueNumberFromBranch(branch: string): number | null {
  for (const prefix of ALL_BRANCH_PREFIXES) {
    if (!branch.startsWith(prefix)) continue;
    const m = branch.slice(prefix.length).match(/^issue-(\d+)(?:-|$)/);
    return m ? Number(m[1]) : null;
  }
  return null;
}
