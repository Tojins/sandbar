// #99 — ratchet for catch forms that can hide failures in production code.
// Entries disappear as files are converted; an absent file therefore has a
// budget of zero. Every budget is EXACT — the ratchet fails on growth and on
// slack alike — so a decrement lands in the same commit as the conversion it
// records. Counts include explicit, reviewed classifications and cleanup sites:
// this is a syntactic ratchet, while the coding standard supplies the semantic
// rule.
//
// A MERGE RE-SEEDS the entries it touches, and says so here rather than
// quietly. #99 was queued behind five issues and its baseline was taken before
// them, so landing it brought in files main had moved since (#98's issue
// clones, #109's quota channel, #112's origin sync, #117's wake lock, #118's
// reachability gate, #120/#121's provider work). Every one of those files is
// still at or below what main carried — the sweep is a strict improvement in
// all twenty — but a budget cannot be a promise about code the ratchet has
// never seen. What it keeps promising is the thing it was built for: from here
// no file may grow, and the entries above zero are the remainder #99 designates
// as the todo list.
export const ERROR_SWALLOW_BASELINE: Readonly<Record<string, number>> = {
  "agent-sandbox.ts": 16,
  "chunk-land.ts": 6,
  "cleanup.ts": 1,
  "cli.ts": 2,
  "containers.ts": 1,
  "agent-tools.ts": 7,
  "ensure-images.ts": 3,
  "finalize.ts": 4,
  "forge-verify.ts": 6,
  "gate-run.ts": 2,
  // The three-state origin lookup (#112) reads as a swallow to the pattern and
  // is the classification the rule asks for — the same standing `fetchChunkRef`
  // has in chunk-land.ts.
  "git-ops.ts": 1,
  "gate-stack.ts": 7,
  "inner-loop.ts": 8,
  "keepawake-hold.ts": 1,
  "keepawake.ts": 1,
  "lock.ts": 4,
  "merger.ts": 11,
  "preflight.ts": 5,
  "prompt.ts": 1,
  "run.ts": 9,
  "sandbox-stack.ts": 3,
};
