// Procedural gate. Runs the configured check + test commands against an
// issue worktree inside an ephemeral one-shot container, joined to the
// issue's per-issue podman network so test code reaches the postgres
// sidecar by container name instead of the host's shared db.
//
// Two podman runs (check, then test) so the failedStep is unambiguous and
// the failing run's output can be returned without re-parsing combined
// output. The host is never asked to run npm scripts; gate verdicts are
// hermetic per issue.
//
// `summarizeGateFailure` (#15) post-processes a failed run's output before it
// reaches a human (NEEDS-HUMAN trace) or the resolve agent: it collapses
// uninformative timeout cascades to the root failure + a count and a hint, so
// an environment/setup failure doesn't read as N independent flaky tests.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GateCommand } from "./config.js";
import { RUNTIME } from "./pg-sidecar.js";

const exec = promisify(execFile);

const MAX_BUFFER = 50 * 1024 * 1024;

export type GateOptions = {
  readonly worktreePath: string;
  readonly gateImage: string;
  readonly gateCommands: GateCommand;
  readonly networkName: string;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly dbUser: string;
  readonly dbPassword: string;
  readonly dbName: string;
  readonly dbNameTest: string;
};

export type GateResult = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly failedStep: "check" | "test" | null;
};

export async function runGate(opts: GateOptions): Promise<GateResult> {
  const check = await runStep(opts, "check");
  if (!check.ok) {
    return { ...check, failedStep: "check" };
  }
  const test = await runStep(opts, "test");
  if (!test.ok) {
    return {
      ok: false,
      stdout: check.stdout + "\n" + test.stdout,
      stderr: check.stderr + "\n" + test.stderr,
      exitCode: test.exitCode,
      failedStep: "test",
    };
  }
  return {
    ok: true,
    stdout: check.stdout + "\n" + test.stdout,
    stderr: check.stderr + "\n" + test.stderr,
    exitCode: 0,
    failedStep: null,
  };
}

async function runStep(
  opts: GateOptions,
  step: "check" | "test",
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const stepCmd = opts.gateCommands[step];
  const args = [
    "run",
    "--rm",
    "--userns=keep-id",
    "--user",
    "1000:1000",
    "--network",
    opts.networkName,
    "-v",
    `${opts.worktreePath}:/workspace`,
    "-w",
    "/workspace",
    "-e",
    "CI=true",
    "-e",
    "HOME=/tmp",
    "-e",
    `DB_HOST=${opts.dbHost}`,
    "-e",
    `DB_PORT=${opts.dbPort}`,
    "-e",
    `DB_USER=${opts.dbUser}`,
    "-e",
    `DB_PASSWORD=${opts.dbPassword}`,
    "-e",
    `DB_NAME=${opts.dbName}`,
    "-e",
    `DB_NAME_TEST=${opts.dbNameTest}`,
    "--entrypoint",
    stepCmd.cmd,
    opts.gateImage,
    ...stepCmd.args,
  ];
  try {
    const { stdout, stderr } = await exec(RUNTIME, args, {
      maxBuffer: MAX_BUFFER,
    });
    return { ok: true, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), exitCode: 0 };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      ok: false,
      stdout: stripAnsi(e.stdout ?? ""),
      stderr: stripAnsi(e.stderr ?? ""),
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
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
// When a shared resource (DB sidecar, network, fixture) isn't ready, one slow
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
    "A single slow or unavailable shared resource (DB sidecar, network, fixture) that trips the",
    "per-test timeout makes every dependent test time out too. Check the gate environment",
    "(e.g. DB readiness / migrations) before treating these as real test failures.",
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
