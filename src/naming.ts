// Centralized naming for sandbar's load-bearing identifiers.
//
// Branch names, container/network/pg names, and the resource label all share a
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

// Container / network / pg / image / label prefix: `sandbar-*`.
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
