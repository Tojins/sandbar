// Per-run log tree.
//
// At run start, makes `<baseDir>/run-<UTC-ISO>/` and exposes:
//
//   appendOrchestrator(line)              → run-<UTC>/orchestrator.log
//   plans.jsonl                           → one trigger + plan per recompute
//   issue-<id>/                           → all attempts for one issue
//   landing-<n>/                          → one serialized landing's artefacts
//
// Append-style writers are unbuffered (Node uses O_APPEND), so SIGINT/SIGTERM
// and uncaught exceptions don't lose lines that already returned. finalize()
// drops a closing marker on the orchestrator log via the cleanup trap.
//
// THE INVARIANT (#70): every line reporting an OUTCOME or a REFUSAL exists in
// this log; the terminal may additionally render it for a human. The two
// streams are hand-paired at every site in run.ts — ~26 appends against ~44
// `console.*` — and most of the difference between them is deliberate and
// right: the log carries the whole per-attempt `gate-1 ok=…` / `reviewer
// round=N quality=… correctness=…` trace, which stdout must never carry, and the terminal
// renders titled lists and multi-paragraph banners, which would make the log
// unreadable. What is NOT allowed is an outcome the log never heard about,
// which is how a parked chunk and a halted run each came to be reportable only
// on a terminal nobody kept. It reaches the CLEANUP handlers too, which is
// where an operator has most likely stopped watching and so where the log is
// the only reader left.
//
// DURATIONS (#82). Since #82 the per-attempt trace carries elapsed time on the
// lines that report an outcome — setup, the implementer, gate-1 and its
// per-step split, each reviewer pass, the whole review round, each merge unit,
// both phases and every image build. All of it is here and none of it is on
// stdout, which is the same split this header already describes: the log is
// where a cost question is answered long after the fact, and a terminal
// rendering of ~130 lines per cycle instead of ~50 would be unreadable.
//
// One spelling, `durationMs=<int>`, produced by `timing.ts`; the gate's
// per-step numbers nest inside a single `steps=` field because step names are
// the host's. Two rules a writer must not break: a duration is a REPORT and
// nothing in sandbar may decide on one, and an absent measurement is ABSENT —
// the field is omitted rather than written as `0`, because a zero meaning "not
// measured" is what a stats reader averages.
//
// Agent context depth follows the same #82 rules (#124): `peakContext=<int>` is
// the maximum per-turn input footprint observed during one invocation, a
// REPORT only, and absent is omitted. It is deliberately separate from the
// cumulative token-cost buckets and tool-call count even though all three are
// rendered on the same invocation line.
//
// The terminal lines are written by the TASK that terminated rather than by the
// reporting loop that collects the cohort, which is a coverage fix as much as a
// timing one: an outcome reached eight minutes before the cohort settled used
// to exist in this log only if every sibling also survived. run.ts's call site
// owns that argument.
//
// The invariant is about coverage and NOT a licence to say more than the
// terminal does. A log line is read long after the fact, by someone who has
// only it, so it may only claim what the code reaching it actually knows: the
// parked-chunk line names the decision and not the `gh` writes that follow it,
// because those can be skipped or can throw, and a confident record of a write
// that never happened is worse than no record at all.
//
// One `report()` writing both would enforce it mechanically and is the wrong
// instrument for exactly the reason above: the two streams carry different
// content on purpose. Two streams, one invariant.
//
// The other half of #70 is WHEN this tree exists. `startRunLogger` is called
// the moment the single-instance lock is won and before anything else — a
// refusal from preflight, from an image build or from the uid check is a
// verdict this driver reached, and each of them used to leave nothing on disk
// at all. The boundary is the LOCK, and run.ts's header owns the three exits
// that stay outside it — a refused config and a missing `GH_TOKEN`, both
// checked before the lock is won, and losing the lock itself.
//
// The ISO stamp has `:` and `.` swapped for `-` so the directory name is safe
// on every filesystem we care about (including Windows under WSL).

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Type-only, so this module still pulls in nothing at runtime — resolve-loop.ts
// loads prompt templates from disk at import, and the log tree must not depend
// on those existing.
import type { ResolveAttemptRecord } from "./resolve-loop.js";

export type AttemptLogger = {
  writeAttempt(
    issueId: string,
    attempt: number,
    content: string,
  ): Promise<void>;
  writeAttemptReviewer(
    issueId: string,
    attempt: number,
    content: string,
  ): Promise<void>;
};

// `failedStep` is the name of the gate step that went red — free-form since
// #24, since the steps are the consumer's.
export type MergerGateRecord = {
  readonly stdout: string;
  readonly stderr: string;
  readonly failedStep: string | null;
  readonly exitCode: number;
  // The #24 D9 per-container log tails. Persisted, not just passed to the
  // resolve agent in-prompt: this file is the only offline artefact, and D9's
  // motivating case — the browser step failed because the backend was 500ing —
  // is undiagnosable without it after the run.
  readonly containerLogs: string;
};

export type IssueLogger = AttemptLogger & {
  readonly dir: string;
};

export type LandingLogger = {
  readonly dir: string;
  appendMerger(line: string): Promise<void>;
  writeMergerGate(issueId: string, gate: MergerGateRecord): Promise<void>;
  // One resolve-loop attempt's captured stdout and stderr (#67), keyed like the
  // gate artefact beside it: an issue id for an issue branch, `chunk-<root>`
  // for a chunk, `verify-round-<n>` for a forge-red round — so a chunk and its
  // own root issue resolving in one cycle cannot overwrite each other.
  //
  // ANSWERS WITH THE PATH IT WROTE. The abandon comment points a human at these
  // files, and the alternative is the merger composing the same filename a
  // second time from the same three parts.
  writeResolveAttempt(
    key: string,
    record: ResolveAttemptRecord,
  ): Promise<string>;
};

export type RunLogger = {
  readonly runDir: string;
  appendOrchestrator(line: string): Promise<void>;
  writePlan(trigger: "launch" | "slot-freed", plan: unknown): Promise<void>;
  issue(issueId: string): Promise<IssueLogger>;
  landing(n: number): LandingLogger;
  finalize(reason: string): Promise<void>;
};

export function runStampFromDate(d: Date): string {
  // ISO 8601 with `:` and `.` replaced — safe across all filesystems.
  // Example: 2026-05-05T21-15-32-101Z
  return d.toISOString().replace(/[:.]/g, "-");
}

export type StartRunLoggerOptions = {
  readonly baseDir: string;
  readonly now?: Date;
};

export async function startRunLogger(
  opts: StartRunLoggerOptions,
): Promise<RunLogger> {
  const stamp = runStampFromDate(opts.now ?? new Date());
  const runDir = join(opts.baseDir, `run-${stamp}`);
  await mkdir(runDir, { recursive: true });
  const orchestratorPath = join(runDir, "orchestrator.log");
  await appendFile(
    orchestratorPath,
    `[${new Date().toISOString()}] run-start\n`,
  );

  const issueCache = new Map<string, Promise<IssueLogger>>();
  const landingCache = new Map<number, LandingLogger>();

  const logger: RunLogger = {
    runDir,
    async appendOrchestrator(line) {
      await appendFile(
        orchestratorPath,
        `[${new Date().toISOString()}] ${line}\n`,
      );
    },
    async writePlan(trigger, plan) {
      await appendFile(
        join(runDir, "plans.jsonl"),
        `${JSON.stringify({ trigger, plan })}\n`,
      );
    },
    issue(issueId) {
      const cached = issueCache.get(issueId);
      if (cached) return cached;
      const created = makeIssueLogger(runDir, issueId);
      issueCache.set(issueId, created);
      return created;
    },
    landing(n) {
      const cached = landingCache.get(n);
      if (cached) return cached;
      const created = makeLandingLogger(runDir, n);
      landingCache.set(n, created);
      return created;
    },
    async finalize(reason) {
      await appendFile(
        orchestratorPath,
        `[${new Date().toISOString()}] run-end (${reason})\n`,
      );
    },
  };
  return logger;
}

async function makeIssueLogger(runDir: string, issueId: string): Promise<IssueLogger> {
  const dir = join(runDir, `issue-${issueId}`);
  await mkdir(dir, { recursive: true });
  return {
    dir,
    async writeAttempt(_issueId, attempt, content) {
      await writeFile(join(dir, `attempt-${attempt}.log`), content);
    },
    async writeAttemptReviewer(_issueId, attempt, content) {
      await writeFile(join(dir, `attempt-${attempt}-reviewer.log`), content);
    },
  };
}

function makeLandingLogger(runDir: string, n: number): LandingLogger {
  const landingDir = join(runDir, `landing-${n}`);
  let landingDirReady: Promise<void> | null = null;
  const ensureLandingDir = (): Promise<void> => {
    if (!landingDirReady) {
      landingDirReady = mkdir(landingDir, { recursive: true }).then(() => undefined);
    }
    return landingDirReady;
  };

  return {
    dir: landingDir,
    async appendMerger(line) {
      await ensureLandingDir();
      await appendFile(
        join(landingDir, "merger.log"),
        `[${new Date().toISOString()}] ${line}\n`,
      );
    },
    async writeMergerGate(issueId, gate) {
      await ensureLandingDir();
      const base = join(landingDir, `merger-gate-${issueId}`);
      await writeFile(`${base}.out`, gate.stdout);
      await writeFile(`${base}.err`, gate.stderr);
      // Its own file, never appended to `.err`: `summarizeGateFailure`
      // collapses lines that share a timeout signature, and a service log is
      // full of near-identical lines. Keeping them apart on disk mirrors why
      // GateResult keeps them apart in memory.
      if (gate.containerLogs) {
        await writeFile(`${base}.containers.log`, gate.containerLogs);
      }
      await writeFile(
        `${base}.meta.json`,
        JSON.stringify(
          { failedStep: gate.failedStep, exitCode: gate.exitCode },
          null,
          2,
        ),
      );
    },
    async writeResolveAttempt(key, record) {
      await ensureLandingDir();
      const path = join(landingDir, `resolve-${key}-attempt-${record.attempt}.log`);
      // A header before the streams, because the streams are what a container
      // that died at startup does NOT have: on the failure this file exists for,
      // everything below the header is empty and the header is the whole
      // artefact.
      const header = [
        `resolve attempt ${record.attempt} for #${record.issueId} (mode=${record.mode})`,
        `container:  ${record.container}`,
        `ended:      ${record.end}` +
          (record.detail ? ` (${record.detail})` : ""),
        `exit code:  ${record.exitCode ?? "-"}`,
        `signal:     ${record.signal ?? "-"}`,
        `duration:   ${record.durationMs}ms`,
        `stdout:     ${record.stdout.length} bytes`,
        `stderr:     ${record.stderr.length} bytes`,
        "",
      ].join("\n");
      await writeFile(
        path,
        `${header}\n--- stdout ---\n${record.stdout}\n--- stderr ---\n${record.stderr}\n`,
      );
      return path;
    },
  };
}
