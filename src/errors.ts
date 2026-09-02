// Sandbar-internal failure.
//
// Raised when sandbar's OWN machinery malfunctions — a required git / issue-
// tracker side-effect that sandbar cannot complete, or a config error. This is
// categorically different from a coding-task outcome (a red gate, a
// CHANGES-REQUESTED review, `agent-stuck`) — those are normal results the loop
// handles and continues past.
//
// The contract is "fail loud, do not gracefully continue" (#8): by the time
// one of these surfaces the transient-blip retries are exhausted, so required
// side-effects THROW this instead of catching, logging, and returning as if
// they had succeeded. run() catches it at the top of the loop, prints it as
// the final output, runs cleanup, and exits non-zero.
export class SandbarError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandbarError";
  }
}

function propertyEquals(value: unknown, key: string, expected: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)[key] === expected;
}

export function isExitCode(err: unknown, code: number): boolean {
  return propertyEquals(err, "code", code);
}

export function hasExitCode(err: unknown): boolean {
  return typeof err === "object" && err !== null &&
    typeof (err as { code?: unknown }).code === "number";
}

export function isErrno(err: unknown, code: string): boolean {
  return propertyEquals(err, "code", code);
}

export function isExitStatus(err: unknown, status: number): boolean {
  return propertyEquals(err, "status", status);
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
