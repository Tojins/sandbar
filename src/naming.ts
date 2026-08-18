// Centralized naming for sandbar's load-bearing identifiers.
//
// Branch names, container/network/pod names, and the resource label all share a
// common prefix that the planner (creation), the preflight cleanup, and the
// orphan sweeper key on. Keeping them here makes the prefix a single knob.
//
// Transition note (sandcastle → sandbar, issue #11): repos that ran an older
// sandbar may still carry `sandcastle/issue-*` branches and `sandcastle-*`
// containers/networks. New resources are always created with the current
// prefixes; the LEGACY_* prefixes exist so those artifacts are not simply
// forgotten. What happens to them differs by kind, and since #28 the two are
// no longer the same:
//   - BRANCHES are still cleaned automatically. They are in this repo, which
//     this run holds the lock on, so they are unambiguously ours.
//   - RESOURCES (containers, pods, networks) are only REPORTED, by
//     `findUnattributableResources`. A legacy name carries no run scope, so
//     nothing distinguishes a dead run's debris from a concurrently-running
//     OLD sandbar's live stack — and force-removing on that guess is the #28
//     bug itself. See containers.ts.
// Once all hosts have drained their `sandcastle/*` artifacts, delete the
// LEGACY_* exports and their call-site uses for a clean cutover.

import { createHash } from "node:crypto";

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

// All resource prefixes that have ever named a sandbar podman resource
// (current + legacy), used only to REPORT unattributable debris — never to
// remove it. See `runScope` below and `containers.ts`.
export const ALL_RESOURCE_PREFIXES: readonly string[] = [
  RESOURCE_PREFIX,
  ...LEGACY_RESOURCE_PREFIXES,
];

// ---------------------------------------------------------------------------
// The run scope (#28)
//
// Every podman resource sandbar creates carries a scope segment derived from
// the workdir the run holds its lock on: `sandbar-w<8 hex>-...`. Two things
// depend on it, and both were broken without it:
//
//   1. NAME COLLISION. Podman names are host-global; the lock is per-workdir.
//      Two runs against different repos on one machine each hold their own
//      lock legitimately and then both want `sandbar-pod-42`. `startStack`
//      force-removes a namesake before creating (a namesake surviving a crash
//      is stale and must never be reused), so run B would tear down run A's
//      LIVE pod for issue 42.
//   2. THE SWEEP. `cleanupOrphanContainers` force-removes debris no `finally`
//      reached, and by name alone it cannot tell "orphan of a dead run" from
//      "live resource of a sibling run". Scoped, it can: one lock ⇔ one scope,
//      so anything in this run's scope is either this run's or a dead
//      predecessor of the same workdir. Nothing else is ever its business.
//
// The scope is derived (not random) precisely so a crashed run's debris is
// found by the NEXT run of the same workdir. For that to be worth anything the
// scope and the lock must partition the host IDENTICALLY, which is a property
// of the CALLER, not of this function: proper-lockfile resolves symlinks on the
// path it locks, so the caller must hand the canonical path here too. run.ts
// realpaths it, and says why.
//
// Residual, accepted: a scope whose workdir is never run again leaks its
// debris forever, because no live run may claim it. That is the price of never
// destroying a sibling. With no sandbar running, everything clears with
//   podman pod rm -f $(podman pod ls --filter name=^sandbar- -q)
// ---------------------------------------------------------------------------

// 32 bits of workdir. A collision means two workdirs share a namespace, i.e.
// exactly the pre-#28 behaviour, for two specific directories on one host.
const SCOPE_HEX_CHARS = 8;

// Branded, because every guarantee below rests on the string having come from
// `runScope`. `scopedResourcePrefix` and `isScopedResourceName` partition the
// host's resources into "ours" and "not ours" and the sweeper force-removes the
// first set, so a caller passing any other string (a stackId, a branch name, a
// raw workdir) silently redraws that line. The brand makes the four consumers
// checkable instead of leaving the invariant to a comment.
export type RunScope = string & { readonly __runScope: unique symbol };

// The leading `w` (for workdir) is load-bearing, not decoration: it is what
// makes a scoped name distinguishable from an unscoped legacy one. Hex can
// never start with `w`, so `sandbar-w1a2b3c4d-...` cannot be confused with the
// pre-#28 agent-sandbox name `sandbar-<uuid>`, whose first segment is also 8
// hex — without it, that container would read as scoped and never be reported.
//
// `lockedWorkDir` must be the CANONICAL path the run holds its lock on — see
// the call in run.ts for why realpath and not the configured string.
export function runScope(lockedWorkDir: string): RunScope {
  const hex = createHash("sha256")
    .update(lockedWorkDir)
    .digest("hex")
    .slice(0, SCOPE_HEX_CHARS);
  return `w${hex}` as RunScope;
}

// Everything this run creates starts with this, and the sweeper's name filters
// key on exactly this. `sandbar-w1a2b3c4d-`.
export function scopedResourcePrefix(scope: RunScope): string {
  return `${RESOURCE_PREFIX}${scope}-`;
}

// The prefix is interpolated into a regex, so it is escaped — `containers.ts`
// declines to trust podman's own name filter for exactly this reason, and it
// would be odd to build the local check less carefully than the remote one.
const SCOPED_NAME_RE = new RegExp(
  `^${RESOURCE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` +
    `w[0-9a-f]{${SCOPE_HEX_CHARS}}-`,
);

// True for a resource belonging to SOME run's scope — not necessarily ours.
// The debris report uses it to stay silent about other workdirs' resources,
// which may well be live and are in any case their own run's to reap.
export function isScopedResourceName(name: string): boolean {
  return SCOPED_NAME_RE.test(name);
}

// ---------------------------------------------------------------------------
// Gate-stack resource names (#24)
//
// A stack is identified by a `stackId` — the issue id in the inner loop, the
// literal "merger" for gate-2 — within a run's scope. Three shapes:
//
//   network    sandbar-<scope>-net-<stackId>
//   pod        sandbar-<scope>-pod-<stackId>
//   container  sandbar-<scope>-<stackId>-<containerName>
//
// The pod's own INFRA container is the exception and the reason the sweeper
// cannot be containers-and-networks-only: podman names it `<pod-id-prefix>-infra`
// (a hash, e.g. `c5968a5425d7-infra`), which matches no sandbar prefix. Only
// `podman pod rm` reaches it, so cleanupOrphanContainers sweeps pods too.
// ---------------------------------------------------------------------------

export function networkNameFor(scope: RunScope, stackId: string): string {
  return `${scopedResourcePrefix(scope)}net-${stackId}`;
}

export function podNameFor(scope: RunScope, stackId: string): string {
  return `${scopedResourcePrefix(scope)}pod-${stackId}`;
}

export function stackContainerNameFor(
  scope: RunScope,
  stackId: string,
  name: string,
): string {
  return `${scopedResourcePrefix(scope)}${stackId}-${name}`;
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

// ---------------------------------------------------------------------------
// Per-branch image tags (#37)
//
// An image that bakes dependencies from a lockfile is a function of the branch,
// so a branch that changes that lockfile needs its own image. The variant's tag
// is derived from the base tag, the run scope and the hash of the image's
// declared inputs:
//
//   sandbar-outdoor           -> sandbar-outdoor:sb-w1a2b3c4-9f2e1d70
//   sandbar-outdoor:latest    -> sandbar-outdoor:latest-sb-w1a2b3c4-9f2e1d70
//   localhost/x/y:v1          -> localhost/x/y:v1-sb-w1a2b3c4-9f2e1d70
//
// Both halves of the suffix earn their place. The FINGERPRINT makes the tag
// content-addressed, which is what lets the ordinary `image exists` skip do the
// right thing: two issues that make the same lockfile change share one build,
// and a gate run that changes nothing rebuilds nothing. The SCOPE keeps the tag
// attributable to a run, so debris a crash leaves behind can be named — image
// tags are otherwise the one podman resource class no scope partitions, and a
// content hash alone would leave an orphan nobody could tie to a workdir.
//
// The suffix goes on the TAG component, never the name: a reference is
// `[registry/]name[:tag]`, so appending to `localhost/x/y` unqualified would
// silently invent a different repository rather than a different tag.
// ---------------------------------------------------------------------------

// Podman tag components are limited to 128 chars; the fingerprint is truncated
// so a long base tag plus this suffix stays well inside that.
const IMAGE_FINGERPRINT_CHARS = 8;

export function variantImageTag(
  baseTag: string,
  scope: RunScope,
  fingerprint: string,
): string {
  const suffix = `sb-${scope}-${fingerprint.slice(0, IMAGE_FINGERPRINT_CHARS)}`;
  // A `:` only introduces a tag when it comes after the last `/` — otherwise it
  // is a registry port (`registry.example:5000/x`), and the reference is
  // untagged.
  const hasTag = baseTag.lastIndexOf(":") > baseTag.lastIndexOf("/");
  return hasTag ? `${baseTag}-${suffix}` : `${baseTag}:${suffix}`;
}
