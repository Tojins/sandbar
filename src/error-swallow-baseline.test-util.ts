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
  // The sixteenth and seventeenth are the seed snapshot's bringup (#203): a
  // failure removes the snapshot, reports a removal that failed in turn, and
  // rethrows the original.
  "agent-sandbox.ts": 17,
  "chunk-land.ts": 6,
  "cleanup.ts": 1,
  "cli.ts": 2,
  "containers.ts": 1,
  // The nightly base's job error (#201) runs the import's teardown, logs a
  // failure of that teardown with its cause, and rethrows the original.
  "db-base.ts": 2,
  // A database copy's slot (#201) releases the copy when a swap throws,
  // reports a release that failed in turn, and rethrows the original.
  "db-copy.ts": 2,
  // The deploy watcher's tick (#198) classifies a rate limit, an unanswered
  // request, a forge answer and a lease lost to cleanup; anything else is
  // rethrown.
  "deploy-watch.ts": 1,
  "agent-tools.ts": 4,
  "ensure-images.ts": 2,
  "finalize.ts": 4,
  "forge-verify.ts": 6,
  "gate-run.ts": 2,
  // The three-state origin lookup (#112) reads as a swallow to the pattern and
  // is the classification the rule asks for — the same standing `fetchChunkRef`
  // has in chunk-land.ts.
  "git-ops.ts": 1,
  "gate-stack.ts": 6,
  // The UI-check invocation (#126) classifies a failed read-only agent write
  // before rethrowing the original invocation error, mirroring the reviewer.
  // The tenth is the quality fixer (#185): an agent exit or timeout is the
  // named end of its pass, and every other failure is rethrown. The sandbox
  // cycle's teardowns report through one helper since #223, which added the
  // egress proxy's as a fourth. The last reports a scenario writer that failed
  // while its admission ended (#203), after the terminal is already decided.
  "inner-loop.ts": 9,
  "keepawake.ts": 1,
  "lock.ts": 4,
  "merger.ts": 11,
  // Ref lookup failures are classified into the origin-lock decision
  // vocabulary (#139); malformed leases, unexpected seam failures and CAS
  // failures outside the named command boundary still throw.
  "origin-lock.ts": 2,
  "preflight.ts": 3,
  "prompt.ts": 1,
  // UI port contention is classified as a startup refusal; unexpected UI
  // startup faults share the run's internal-failure path (#132). The two
  // pre-record startup catches classify workdir/preflight and origin-lock
  // refusal while running the cleanup that releases the local lock (#139).
  // The twelfth is the restart request's startup clear (#146), which stops
  // through `stopAtStartup` like every other post-lock startup fault: the fault
  // is recorded as a complaint and a halted exit, and cleanup releases the
  // origin lease — none of which happens if it escapes `run()` instead.
  "run.ts": 11,
  // The scenario writer (#203): a run, and the host steps around it, that
  // failed with anything but sandbar's own SandbarError are its named
  // failures, and that is rethrown; a container that would not close is
  // reported (#83).
  "scenario-writer-run.ts": 3,
  // A database copy's swap-in (#201) classifies a sibling that did not come up
  // into a false return; any other failure restores the target and rethrows.
  "sandbox-stack.ts": 3,
  // The HTTP request boundary maps record/reducer failures to a 500 response
  // for the polling page (#132).
  "ui-server.ts": 1,
  // The verifier's scenario runner (#238): a run's write parks it, a closed
  // provider and a dead egress proxy are rethrown, and every other failure is
  // the runner's harness failing, which leaves its scenarios unverified.
  "verifier-run.ts": 1,
};
