// Raw per-run transcripts (#132).
//
// This module writes only files whose bytes are the output of another process:
// implementer/reviewer attempts, merger traces, gate artefacts and resolve
// attempts. They are evidence to inspect, not scheduler facts. Structured run
// facts have one write path, `events.ts`, and live in `events.jsonl`; adding an
// orchestration/status writer here would recreate the two hand-paired records
// #132 removed.

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
  // own root issue resolving in one landing cannot overwrite each other.
  //
  // ANSWERS WITH THE PATH IT WROTE. The abandon comment points a human at these
  // files, and the alternative is the merger composing the same filename a
  // second time from the same three parts.
  writeResolveAttempt(
    key: string,
    record: ResolveAttemptRecord,
  ): Promise<string>;
};

export type TranscriptTree = {
  readonly runDir: string;
  issue(issueId: string): Promise<IssueLogger>;
  landing(n: number): LandingLogger;
};

export async function createTranscriptTree(runDir: string): Promise<TranscriptTree> {
  await mkdir(runDir, { recursive: true });
  const issueCache = new Map<string, Promise<IssueLogger>>();
  const landingCache = new Map<number, LandingLogger>();

  return {
    runDir,
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
  };
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
