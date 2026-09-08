// Run-wide admission for gate stacks (#142).
//
// Gate-1 and gate-2 use the same instance, so the configured bound applies to
// pods rather than to either orchestration path separately. Admission is FIFO:
// a gate that cannot start immediately waits behind every earlier caller. The
// wait owns no timeout and changes no verdict or retry budget; its only output
// is `queuedMs`, which the caller records as evidence. An absent bound admits
// every caller immediately and preserves the pre-#142 behaviour.
//
// This module knows nothing about stacks, issues, or landing. The operation and
// monotonic clock are injected, which keeps ordering, timing, and release on a
// rejected operation directly testable without containers.

import { type Clock, monotonicClock, startTimer } from "./timing.js";

export type AdmittedGate<T> = {
  readonly value: T;
  // Present iff this call joined the wait queue. A queued call may measure 0ms;
  // absence means it never waited, not that its rounded wait happened to be 0.
  readonly queuedMs?: number;
};

export type GateSemaphore = {
  run<T>(operation: () => Promise<T>): Promise<AdmittedGate<T>>;
};

export function createGateSemaphore(
  maxConcurrent: number | undefined,
  clock: Clock = monotonicClock,
): GateSemaphore {
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = async (): Promise<number | undefined> => {
    if (maxConcurrent === undefined || active < maxConcurrent) {
      active += 1;
      return undefined;
    }

    const waited = startTimer(clock);
    await new Promise<void>((resolve) => waiting.push(resolve));
    return waited();
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) active -= 1;
    else next();
  };

  return {
    async run<T>(operation: () => Promise<T>): Promise<AdmittedGate<T>> {
      const queuedMs = await acquire();
      try {
        const value = await operation();
        return {
          value,
          ...(queuedMs === undefined ? {} : { queuedMs }),
        };
      } finally {
        release();
      }
    },
  };
}
