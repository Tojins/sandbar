// Sandbar-internal failure.
//
// Raised when sandbar's OWN machinery malfunctions — a required git / issue-
// tracker side-effect that sandbar cannot complete (a push, a comment, a label
// flip, an issue close), or a config error such as a handoff label that doesn't
// exist in the repo. This is categorically different from a coding-task outcome
// (a red gate, a CHANGES-REQUESTED review, an issue legitimately reaching
// `agent-stuck`) — those are normal results the loop handles and continues past.
//
// The contract for a SandbarError is "fail loud, do not gracefully continue":
// the network/HTTP layer has already exhausted its own transient-blip retries,
// so by the time one of these surfaces it is a real, non-transient fault.
// Required side-effects therefore THROW this instead of catching, logging, and
// returning as if they had succeeded — the failure that the original #8 bug
// demonstrated, where "couldn't park the issue for a human" was swallowed and
// the run carried on. run() catches it at the top of the loop, prints it as the
// final output, runs cleanup, and exits non-zero.
export class SandbarError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandbarError";
  }
}

// How a fault is rendered for an operator, wherever sandbar prints one and
// stops: run.ts's top-level handler, the bin's, and `runGateCommand`'s (#45).
// An operator-actionable SandbarError prints as its message alone; anything
// else prints a stack, because an unexpected bug that prints like a config
// error is a bug nobody can locate.
//
// Here rather than in cli.ts because since #45 all three of those callers are
// real and the rule is one rule — the same argument `pulledImagesOf` moved on.
// run.ts's handler is the one that had the copy: naming it above while leaving
// the ternary in place would make this comment false on the day it landed.
export function faultDetail(err: unknown): string {
  return err instanceof SandbarError
    ? err.message
    : err instanceof Error
      ? (err.stack ?? err.message)
      : String(err);
}
