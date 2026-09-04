// Elapsed time — one measurement module, two field spellings (#82, #83).
//
// Before this, sandbar reported exactly one duration: `ResolveAgentRun.durationMs`
// (measured in merger.ts, rendered in logs.ts and resolve-loop.ts). Everything
// else that touched the clock computed a DEADLINE and reported nothing, so the
// four phases that make up a cycle — setup, the implementer, the gate, the
// reviewer — were a single undifferentiated gap between two timestamped lines,
// and every performance question about them had to be answered by hand off a
// stopwatch or not at all.
//
// The precedent is `formatExitLine` (#70). A dozen call sites each writing
// `Date.now() - t0` is a dozen roundings, several renderings and nothing that
// can be asserted once; one helper is one rounding, one field name, and a
// single place to change if the field ever grows a unit.
//
// MONOTONIC, not wall-clock. `Date.now()` steps backwards under NTP correction
// and, on this repo's own WSL2 host, across a suspend/resume — and a negative
// `durationMs` in an append-only record is a lie nobody can correct afterwards.
// `performance.now()` cannot do that, which is what makes the non-negativity a
// property rather than a clamp: nothing here guards against a backwards clock,
// because with the default one there is no backwards. An injected clock owns
// its own behaviour, and a test that hands over a decreasing one gets what it
// asked for.
//
// `startGapTimer` measures the largest silence between stream lines, including
// the leading gap before the first line and the trailing gap after the last; a
// line-less run therefore reports its whole duration. It owns the second field
// spelling, `maxGapMs=<int>`. Like `durationMs`, it is evidence only: nothing
// decides on it, and a caller that has no measurement omits it rather than
// manufacturing zero.
//
// The clock is injectable because log lines are asserted by exact string in
// several suites (`expect(lines).toContain("merged #42")`). A fake clock keeps
// those assertions exact instead of loosening every one of them to a prefix
// match. `forge-verify.ts`'s injected clock object is the same existing seam
// idiom.
//
// NOTHING IN THE SYSTEM MAY DECIDE ON A DURATION. No budget, no warning
// threshold, no adaptive bound, no retry that reads one, no verdict that moves
// because of one. A duration is a report. The whole argument for measuring at
// all is that the decisions which would use these numbers cannot be made today;
// a driver that started refusing or re-routing on an elapsed time would be a
// second, undocumented bound beside `step.timeoutMs`, which is the one bound
// `gate-stack.ts`'s header says exists.
//
// EVERY DEADLINE IS COMPUTED ON THE MONOTONIC CLOCK. A deadline does decide
// when a configured bound has expired, so wall-clock steps must not move it;
// this is distinct from the rule above that reported durations never decide
// anything.
//
// AN ABSENT MEASUREMENT IS ABSENT. Callers omit the field rather than writing
// `0` — a zero meaning "not measured" is worse than a missing field, because a
// stats reader averages it.

export type Clock = () => number;

export const monotonicClock: Clock = () => performance.now();

// Start measuring; the returned thunk answers "whole milliseconds since the
// call to startTimer", and may be called more than once.
export function startTimer(clock: Clock = monotonicClock): () => number {
  const t0 = clock();
  return () => Math.round(clock() - t0);
}

// The one spelling of the field. Every duration sandbar logs is rendered
// through here, so a reader has exactly one key to look for.
export function durationField(ms: number): string {
  return `durationMs=${ms}`;
}

export type GapTimer = { line(): void; finish(): number };

// Includes the leading and trailing gaps, so a line-less run reports its whole
// duration. The clock seam keeps stream timing deterministic in tests (#83).
export function startGapTimer(clock: Clock = monotonicClock): GapTimer {
  let previous = clock();
  let maxGapMs = 0;
  const observe = (): void => {
    const now = clock();
    maxGapMs = Math.max(maxGapMs, Math.round(now - previous));
    previous = now;
  };
  return { line: observe, finish: () => { observe(); return maxGapMs; } };
}
