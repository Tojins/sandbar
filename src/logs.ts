// Per-run log tree.
//
// At run start, makes `<baseDir>/run-<UTC-ISO>/` and exposes:
//
//   appendOrchestrator(line)              → run-<UTC>/orchestrator.log
//   cycle(n).writePlan(plan)              → run-<UTC>/cycle-<n>/plan.json
//   cycle(n).appendMerger(line)           → run-<UTC>/cycle-<n>/merger.log
//   cycle(n).writeMergerGate(id, gate)    → run-<UTC>/cycle-<n>/merger-gate-<id>.{out,err,meta.json,containers.log}
//   cycle(n).writeResolveAttempt(k, rec)  → run-<UTC>/cycle-<n>/resolve-<k>-attempt-<m>.log
//   cycle(n).writeAttempt(id, m, content) → run-<UTC>/cycle-<n>/issue-<id>/attempt-<m>.log
//   cycle(n).writeAttemptReviewer(...)    → run-<UTC>/cycle-<n>/issue-<id>/attempt-<m>-reviewer.log
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
// round=N verdict=…` trace, which stdout must never carry, and the terminal
// renders titled lists and multi-paragraph banners, which would make the log
// unreadable. What is NOT allowed is an outcome the log never heard about,
// which is how a parked chunk and a halted run each came to be reportable only
// on a terminal nobody kept.
//
// One `report()` writing both would enforce it mechanically and is the wrong
// instrument for exactly the reason above: the two streams carry different
// content on purpose. Two streams, one invariant.
//
// The other half of #70 is WHEN this tree exists. `startRunLogger` is called
// the moment the single-instance lock is won and before anything else — a
// refusal from preflight, from an image build or from the uid check is a
// verdict this driver reached, and each of them used to leave nothing on disk
// at all. run.ts's header owns the two exits that stay outside the record
// (`GH_TOKEN`, which is checked before the lock, and losing the lock itself).
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

export type CycleLogger = AttemptLogger & {
  readonly cycleDir: string;
  writePlan(plan: unknown): Promise<void>;
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
  cycle(n: number): CycleLogger;
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

  const cycleCache = new Map<number, CycleLogger>();

  const logger: RunLogger = {
    runDir,
    async appendOrchestrator(line) {
      await appendFile(
        orchestratorPath,
        `[${new Date().toISOString()}] ${line}\n`,
      );
    },
    cycle(n) {
      const cached = cycleCache.get(n);
      if (cached) return cached;
      const c = makeCycleLogger(runDir, n);
      cycleCache.set(n, c);
      return c;
    },
    async finalize(reason) {
      try {
        await appendFile(
          orchestratorPath,
          `[${new Date().toISOString()}] run-end (${reason})\n`,
        );
      } catch {
        /* best-effort: cleanup must not throw */
      }
    },
  };
  return logger;
}

function makeCycleLogger(runDir: string, n: number): CycleLogger {
  const cycleDir = join(runDir, `cycle-${n}`);
  let cycleDirReady: Promise<void> | null = null;
  const ensureCycleDir = (): Promise<void> => {
    if (!cycleDirReady) {
      cycleDirReady = mkdir(cycleDir, { recursive: true }).then(() => undefined);
    }
    return cycleDirReady;
  };
  const issueDirsReady = new Map<string, Promise<void>>();
  const ensureIssueDir = async (issueId: string): Promise<string> => {
    await ensureCycleDir();
    const dir = join(cycleDir, `issue-${issueId}`);
    let p = issueDirsReady.get(issueId);
    if (!p) {
      p = mkdir(dir, { recursive: true }).then(() => undefined);
      issueDirsReady.set(issueId, p);
    }
    await p;
    return dir;
  };

  return {
    cycleDir,
    async writePlan(plan) {
      await ensureCycleDir();
      await writeFile(join(cycleDir, "plan.json"), JSON.stringify(plan, null, 2));
    },
    async appendMerger(line) {
      await ensureCycleDir();
      await appendFile(
        join(cycleDir, "merger.log"),
        `[${new Date().toISOString()}] ${line}\n`,
      );
    },
    async writeMergerGate(issueId, gate) {
      await ensureCycleDir();
      const base = join(cycleDir, `merger-gate-${issueId}`);
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
      await ensureCycleDir();
      const path = join(cycleDir, `resolve-${key}-attempt-${record.attempt}.log`);
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
    async writeAttempt(issueId, attempt, content) {
      const dir = await ensureIssueDir(issueId);
      await writeFile(join(dir, `attempt-${attempt}.log`), content);
    },
    async writeAttemptReviewer(issueId, attempt, content) {
      const dir = await ensureIssueDir(issueId);
      await writeFile(
        join(dir, `attempt-${attempt}-reviewer.log`),
        content,
      );
    },
  };
}
