// #99 — ratchet for catch forms that can hide failures in production code.
// Entries disappear as files are converted; an absent file therefore has a
// budget of zero. Keep a decrement in the same commit as the conversion it
// records. Counts include explicit, reviewed classifications and cleanup sites:
// this is a syntactic ratchet, while the coding standard supplies the semantic
// rule.
export const ERROR_SWALLOW_BASELINE: Readonly<Record<string, number>> = {
  "agent-sandbox.ts": 17,
  "chunk-land.ts": 6,
  "cleanup.ts": 1,
  "cli.ts": 2,
  "containers.ts": 1,
  "ensure-images.ts": 6,
  "finalize.ts": 3,
  "forge-verify.ts": 6,
  "gate-run.ts": 2,
  "gate-stack.ts": 7,
  "inner-loop.ts": 5,
  "lock.ts": 4,
  "merger.ts": 7,
  "preflight.ts": 1,
  "prompt.ts": 1,
  "run.ts": 8,
  "sandbox-stack.ts": 3,
};
