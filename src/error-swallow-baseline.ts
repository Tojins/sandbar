// #99 — ratchet for the two syntactic forms that historically hid failures in
// production code.  Entries disappear as files are converted; an absent file
// therefore has a budget of zero.  Keep a decrement in the same commit as the
// conversion it records.
export const ERROR_SWALLOW_BASELINE: Readonly<Record<string, number>> = {
  "chunk-land.ts": 1,
  "chunk-reconcile.ts": 3,
  "cli.ts": 1,
  "ensure-images.ts": 3,
  "finalize.ts": 3,
  "forge-verify.ts": 2,
  "gate-run.ts": 1,
  "gate-stack.ts": 2,
  "git-ops.ts": 1,
  "image-inputs.ts": 2,
  "issue-anchor.ts": 1,
  "keepawake.ts": 3,
  "lock.ts": 5,
  "logs.ts": 1,
  "merger-worktree.ts": 3,
  "merger.ts": 11,
  "preflight.ts": 8,
  "prompt.ts": 1,
  "repo-cache.ts": 4,
  "sandbox-stack.ts": 2,
  "version-conflict.ts": 1,
  "version.ts": 1,
};
