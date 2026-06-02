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
