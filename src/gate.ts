// Gate verdicts: the RESULT shape, the diagnostics applied to a red one, and
// the one rendering of a verdict's fields.
//
// Since #24 the gate is a stack of containers and an ordered list of steps, and
// running it lives in `gate-stack.ts`. What stays here is everything that turns
// a failed run's raw output into something a human — or the next implementer
// attempt — can act on, which is pure text processing and therefore directly
// table-testable.
//
// TIMINGS (#82). A gate run is ~1.6 min of a ~10 min review round and happens
// about seven times per issue, and until #82 not one second of it was
// observable from a run's own logs: the only wall-clock measurement anyone had
// taken was by hand, once, off a stopwatch, and it found that 91% of this
// repo's own gate is a single step. `GateResult` therefore carries the elapsed
// time of the whole run and a per-phase split, and `formatGateFields` is the
// ONE rendering of them — four consumers log a gate verdict (inner-loop's
// gate-1, the merger's gate-2, the resolve loop's re-gate and `sandbar gate`),
// and four hand-written formats would be four formats a later stats reader has
// to parse. Same argument as `formatExitLine` (#70).
//
// The per-step numbers NEST inside one `steps=` field rather than being sprayed
// as top-level `check=1120` keys, because step names are the HOST'S and
// free-form since #24: a consumer step called `ok` or `durationMs` must not be
// able to shadow a field. They are rendered verbatim, exactly as `failedStep=`
// already renders the same host-owned name — a step name containing a comma or
// a space makes an awkward log line, and that is all it makes, because nothing
// reads these lines back to decide anything.
//
// `summarizeGateFailure` (#15) post-processes a failed run's output before it
// reaches a human (NEEDS-HUMAN trace) or the resolve agent: it collapses
// uninformative timeout cascades to the root failure + a count and a hint, so
// an environment/setup failure doesn't read as N independent flaky tests.

import { durationField } from "./timing.js";

// One timed phase of a gate run, in execution order. The name is either a
// consumer step's own (`gateStack.steps[].name`) or one of the sandbar-owned
// phases `runStackGate` runs before the first step — see `GateResult.steps`.
export type GateStepTiming = {
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
};

export type GateResult = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  // Names the step from the consumer's `gateStack.steps`, or one of three
  // sandbar-owned pseudo-steps: `worktree-clean` (the tree held uncommitted
  // changes, so no verdict about a commit was possible), `container:<name>` (an
  // attempt-lifecycle container failed to come up, which is the branch's fault —
  // see gate-stack.ts) and `image:<tag>` (an image the branch is a `rebuildOn`
  // input of would not build from this worktree, #37 — the branch's fault for
  // the same reason). `null` only when ok.
  readonly failedStep: string | null;
  // Wall time for the whole run, sandbar-owned pre-step phases included (#82).
  readonly durationMs: number;
  // Every phase that RAN, in execution order — never a fabricated entry for one
  // that did not. Steps fail fast, so on a red gate this is a PREFIX whose last
  // entry carries `ok: false`; the same rule #67 states for an agent
  // invocation.
  //
  // A step killed by its `timeoutMs` records what it actually took, never its
  // bound: `boundedPodman` decides `timedOut` from its own timer and never from
  // an exit code (#26), and writing the bound would launder a step that died
  // early into one that ran to its deadline.
  readonly steps: readonly GateStepTiming[];
  // Labelled log tails for every container in the stack, on a red gate (#24 D9).
  // Empty on green.
  //
  // A SEPARATE field, not appended to stderr, and that separation is what makes
  // it safe: `summarizeGateFailure` collapses a repeated-signature timeout
  // cascade, and it must see the failing STEP's output only. Fold N container
  // logs into the same string and the collapse is reasoning about text that was
  // never one test run — a mariadb log full of identical connection lines is
  // exactly the shape it looks for. Callers summarize the step output, then
  // append this.
  readonly containerLogs: string;
};

// The `steps=` value: `check:1120,test:6640,podman-test:88600`, in execution
// order. Empty string when nothing was timed, so the caller can omit the field
// entirely rather than write `steps=` (#82 — an absent measurement is absent).
export function formatGateSteps(steps: readonly GateStepTiming[]): string {
  return steps.map((s) => `${s.name}:${s.durationMs}`).join(",");
}

// What every consumer logging a gate verdict renders. Deliberately a PARTIAL
// shape rather than `GateResult`: the merger and the resolve loop narrow a
// green gate to `{ ok: true }` plus its timings and genuinely have no exit code
// or failed step to report, and a renderer that demanded them would either
// force those adapters to invent values or force a second format.
//
// Field order matches the line `inner-loop.ts` already wrote, so its prefix is
// byte-identical and the new fields are appended.
// The timing half of a `GateResult`, for the two adapters that narrow a green
// gate to `{ ok: true }` and would otherwise drop it (#82).
export type GateTimings = {
  readonly durationMs: number;
  readonly steps: readonly GateStepTiming[];
};

export type GateFields = {
  readonly ok: boolean;
  readonly exitCode?: number;
  readonly failedStep?: string | null;
  readonly durationMs?: number;
  readonly steps?: readonly GateStepTiming[];
};

export function formatGateFields(g: GateFields): string {
  const out = [`ok=${g.ok}`];
  if (g.exitCode !== undefined) out.push(`exitCode=${g.exitCode}`);
  if (g.failedStep !== undefined) out.push(`failedStep=${g.failedStep ?? "-"}`);
  if (g.durationMs !== undefined) out.push(durationField(g.durationMs));
  const steps = formatGateSteps(g.steps ?? []);
  if (steps !== "") out.push(`steps=${steps}`);
  return out.join(" ");
}

// Gate tools (vitest et al.) emit ANSI SGR colour codes even when their
// stdout is piped — the in-container colour heuristics misfire despite CI=true.
// Those escapes are pure noise in every plain-text sink: the run-logs and,
// worst, the failure-trace comment posted to the GitHub issue (#396), where a
// raw `\x1b[90m` renders as literal `^[[90m` garbage. Strip every CSI escape
// at the capture boundary so all downstream consumers get clean text.
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI, "");
}

export function lastNLines(s: string, n: number): string {
  const lines = s.split(/\r?\n/);
  return lines.slice(-n).join("\n");
}

// Cascade diagnostics (#15).
//
// When a shared resource (a stack container, the network, a fixture) isn't
// ready, one slow
// root operation trips the per-test timeout and every dependent test then times
// out waiting on it. Vitest renders that as an N-line wall of byte-identical
// `Test timed out in 5000ms` lines with no summary — and because the human
// reading a NEEDS-HUMAN verdict has no local repro of the gate's cold
// environment, that wall is exactly when good diagnostics matter most.
//
// `summarizeGateFailure` (a) collapses the identical-signature cascade to its
// first occurrence + a count, (b) leads with that earliest failure (by output
// order, ~= start order, usually the root), and (c) prepends an explicit
// environment-cascade hint. Crucially the collapse runs on the FULL text before
// the tail-truncation a caller would otherwise apply — so the root isn't the
// line that tail-only drops. Non-cascade failures pass through unchanged.

const TIMEOUT_SIGNATURE = /\btimed out in (\d+)\s*ms\b/i;

// A genuine environment cascade is many identical-signature timeouts; a couple
// of independently-slow tests is not. 3 is the floor at which "they all share
// one signature" stops being coincidence and starts being a shared-resource
// pattern.
const CASCADE_MIN_COUNT = 3;

export type TimeoutAnalysis = {
  // Total lines matching the timeout signature, regardless of duration.
  readonly timeoutCount: number;
  // The most common timeout duration in ms (the dominant signature), or null.
  readonly dominantMs: number | null;
  // How many lines share that dominant signature.
  readonly dominantCount: number;
  // First line (trimmed) that matched the dominant signature — the likely root.
  readonly firstDominant: string | null;
  // The nearest preceding test-identity line (e.g. vitest `FAIL <path> > name`)
  // for that first dominant timeout, so the header can name the root test even
  // when its own block is later truncated. Null if none was seen.
  readonly firstDominantContext: string | null;
  // Whether the dominant signature crosses the cascade threshold.
  readonly isCascade: boolean;
};

// A vitest per-test failure header: ` FAIL  src/x.test.ts > name`. Used only to
// attribute the root timeout to a test; non-matching harnesses just yield null.
const FAIL_HEADER = /\bFAIL\b/;

export function analyzeTimeouts(s: string): TimeoutAnalysis {
  const counts = new Map<number, number>();
  const firstLineByMs = new Map<number, string>();
  const firstContextByMs = new Map<number, string>();
  let timeoutCount = 0;
  let lastFailHeader: string | null = null;
  for (const line of s.split(/\r?\n/)) {
    if (FAIL_HEADER.test(line)) lastFailHeader = line.trim();
    const m = line.match(TIMEOUT_SIGNATURE);
    if (!m) continue;
    timeoutCount++;
    const ms = Number(m[1]);
    counts.set(ms, (counts.get(ms) ?? 0) + 1);
    if (!firstLineByMs.has(ms)) {
      firstLineByMs.set(ms, line.trim());
      if (lastFailHeader !== null) firstContextByMs.set(ms, lastFailHeader);
    }
  }
  let dominantMs: number | null = null;
  let dominantCount = 0;
  for (const [ms, c] of counts) {
    if (c > dominantCount) {
      dominantMs = ms;
      dominantCount = c;
    }
  }
  return {
    timeoutCount,
    dominantMs,
    dominantCount,
    firstDominant: dominantMs === null ? null : (firstLineByMs.get(dominantMs) ?? null),
    firstDominantContext:
      dominantMs === null ? null : (firstContextByMs.get(dominantMs) ?? null),
    isCascade: dominantCount >= CASCADE_MIN_COUNT,
  };
}

// A stack frame / continuation line (vitest `❯ …`, a node `at …` frame, or a
// blank line inside a failure block). Used to drop a suppressed cascade test's
// whole block, not just its one-line error.
const STACK_CONTINUATION = /^\s*(?:❯|at\s)/;

// Collapse the dominant timeout cascade to its FIRST block plus a `… and N more`
// marker. The first occurrence (and its FAIL header / stack frame) is kept in
// place; every later block sharing the dominant signature is removed whole — its
// error line, the FAIL header that introduced it, and the trailing stack frames
// — so the marker and the root survive a downstream tail-truncation instead of
// being buried under N untouched FAIL/❯ pairs. All non-cascade content is kept.
function collapseCascade(s: string, dominantMs: number): string {
  const out: string[] = [];
  let seenFirst = false;
  let suppressed = 0;
  let markerIndex = -1;
  let skippingBlock = false;
  for (const line of s.split(/\r?\n/)) {
    const m = line.match(TIMEOUT_SIGNATURE);
    if (m && Number(m[1]) === dominantMs) {
      if (!seenFirst) {
        seenFirst = true;
        skippingBlock = false;
        out.push(line);
        markerIndex = out.length;
      } else {
        suppressed++;
        // The FAIL header for this duplicate block was just emitted; drop it,
        // then skip the trailing stack frames below.
        const prev = out[out.length - 1];
        if (prev !== undefined && FAIL_HEADER.test(prev)) out.pop();
        skippingBlock = true;
      }
      continue;
    }
    if (skippingBlock) {
      if (line.trim() === "" || STACK_CONTINUATION.test(line)) continue;
      skippingBlock = false; // a new, non-continuation line ends the block
    }
    out.push(line);
  }
  if (suppressed > 0 && markerIndex >= 0) {
    out.splice(
      markerIndex,
      0,
      `… and ${suppressed} more test(s) timed out identically (same "timed out in ${dominantMs}ms" signature)`,
    );
  }
  return out.join("\n");
}

// Drop-in for `lastNLines(combined, tailLines)` on a FAILED gate's output:
// identical to it when there's no cascade, but on a cascade it collapses the
// repeated-signature wall, then tail-truncates the (now-small) remainder, then
// prepends the root failure + environment hint above the truncation boundary so
// the diagnosis is never the part that gets cut.
export function summarizeGateFailure(combined: string, tailLines: number): string {
  const a = analyzeTimeouts(combined);
  if (!a.isCascade || a.dominantMs === null) {
    return lastNLines(combined, tailLines);
  }
  const tail = lastNLines(collapseCascade(combined, a.dominantMs), tailLines);
  const header = [
    `⚠ Probable environment/setup failure (timeout cascade), not ${a.dominantCount} independent test bugs.`,
    `${a.dominantCount} tests failed with the identical signature "timed out in ${a.dominantMs}ms".`,
    "A single slow or unavailable shared resource (a gate-stack container, the network, a",
    "fixture) that trips the per-test timeout makes every dependent test time out too. Check",
    "the container logs below and the stack's readiness/postReadyCommands before treating",
    "these as real test failures.",
    "",
    "Earliest timeout (likely root):",
    ...(a.firstDominantContext ? [`  ${a.firstDominantContext}`] : []),
    `  ${a.firstDominant ?? "(unavailable)"}`,
    "",
    "─".repeat(60),
    "",
  ].join("\n");
  return header + tail;
}
