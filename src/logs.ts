// Per-run log tree.
//
// At run start, makes `<baseDir>/run-<UTC-ISO>/` and exposes:
//
//   appendOrchestrator(line)              → run-<UTC>/orchestrator.log
//   cycle(n).writePlan(plan)              → run-<UTC>/cycle-<n>/plan.json
//   cycle(n).appendMerger(line)           → run-<UTC>/cycle-<n>/merger.log
//   cycle(n).writeMergerGate(id, gate)    → run-<UTC>/cycle-<n>/merger-gate-<id>.{out,err,meta}
//   cycle(n).writeAttempt(id, m, content) → run-<UTC>/cycle-<n>/issue-<id>/attempt-<m>.log
//   cycle(n).writeAttemptReviewer(...)    → run-<UTC>/cycle-<n>/issue-<id>/attempt-<m>-reviewer.log
//
// Append-style writers are unbuffered (Node uses O_APPEND), so SIGINT/SIGTERM
// and uncaught exceptions don't lose lines that already returned. finalize()
// drops a closing marker on the orchestrator log via the cleanup trap.
//
// The ISO stamp has `:` and `.` swapped for `-` so the directory name is safe
// on every filesystem we care about (including Windows under WSL).

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

export type MergerGateRecord = {
  readonly stdout: string;
  readonly stderr: string;
  readonly failedStep: "check" | "test" | null;
  readonly exitCode: number;
};

export type CycleLogger = AttemptLogger & {
  readonly cycleDir: string;
  writePlan(plan: unknown): Promise<void>;
  appendMerger(line: string): Promise<void>;
  writeMergerGate(issueId: string, gate: MergerGateRecord): Promise<void>;
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
      await writeFile(
        `${base}.meta.json`,
        JSON.stringify(
          { failedStep: gate.failedStep, exitCode: gate.exitCode },
          null,
          2,
        ),
      );
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
