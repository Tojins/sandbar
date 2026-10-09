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

// What `gh` writes to stderr when its request never got an HTTP answer: its
// own "error connecting to <host>" for DNS/TCP/TLS failures, and the Go
// transport errors it passes through when a connection dies mid-request. Any
// HTTP status — 401, 404, a 5xx — is the forge answering and stays out.
const FORGE_TRANSPORT_STDERR = [
  /\berror connecting to \S/,
  /\bconnection reset by peer\b/,
  /\bi\/o timeout\b/,
  /\bTLS handshake timeout\b/,
];

// True when a `gh` failure, or any error wrapping one as its `cause`, is a
// request that never reached the forge — a non-answer about the tracker, as
// opposed to the tracker saying no. Reads STDERR only: the message quotes the
// argv, and a comment body that quotes this very error must not classify.
export function isForgeTransportFailure(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e !== undefined && depth < 8; depth += 1) {
    if (typeof e !== "object" || e === null) return false;
    const stderr = (e as { stderr?: unknown }).stderr;
    if (
      typeof stderr === "string" &&
      FORGE_TRANSPORT_STDERR.some((pattern) => pattern.test(stderr))
    ) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
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
