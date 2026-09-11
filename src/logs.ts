// Raw per-run transcripts (#132).
//
// This module writes only files whose bytes describe the output of another
// process: agent invocations, merger traces, gate artefacts and resolve
// attempts. They are evidence to inspect, not scheduler facts. An invocation
// file has a small diagnostic header because an agent that dies before emitting
// a byte otherwise leaves no evidence at all (#135). Structured run facts have
// one write path, `events.ts`, and live in `events.jsonl`; adding an
// orchestration/status writer here would recreate the two hand-paired records
// #132 removed. The cached per-issue logger also owns the filename sequence,
// so a later admission in the same run continues after every file already
// allocated for that issue. Invocation writes are create-only: a naming
// collision must fail rather than erase the earlier invocation's evidence
// (#135), and an attempt's gate artefact is written the same way from the same
// sequence (#153) — a red gate-1 is the commonest way an inner loop fails and
// used to survive only inside the next implementer's prompt.
// Duration headers for container-backed invocations and resolve attempts also
// render their available peak-memory/OOM facts (#141), so the raw artefact a
// human opens says OOMKilled even without consulting events.jsonl.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Resolve types stay type-only — resolve-loop.ts loads prompt templates from
// disk at import, and the log tree must not depend on those existing. The
// resource formatter is the sole runtime helper and has no template inputs.
import type { ResolveAttemptRecord } from "./resolve-loop.js";
import type { AgentInvocationRecord } from "./agent-sandbox.js";
import { formatContainerResources } from "./container-resources.js";

export type AttemptLogger = {
  writeInvocation(filename: string, record: AgentInvocationRecord): Promise<void>;
  writeGate(filename: string, gate: AttemptGateRecord): Promise<void>;
  startInvocationCycle(): AgentInvocationSequence;
};

// The `gate` role is not an agent invocation, but it is an artefact OF one
// attempt and must carry that attempt's number: a fresh HARD-ERROR cycle
// renumbers its attempts from 1, and a gate log numbered outside the sequence
// would sit beside `attempt-7.log` calling itself attempt 1.
export type AgentInvocationIdentity =
  | { readonly role: "implementer"; readonly attempt: number; readonly nudge: boolean }
  | {
      readonly role: "reviewer";
      readonly attempt: number;
      readonly pass: "quality" | "correctness";
      readonly invocation: number;
    }
  | { readonly role: "gate"; readonly attempt: number }
  | { readonly role: "ui-check"; readonly invocation: number };

export type AgentInvocationSequence = {
  filename(identity: AgentInvocationIdentity): string;
};

export function agentInvocationFilename(identity: AgentInvocationIdentity): string {
  switch (identity.role) {
    case "implementer":
      return `attempt-${identity.attempt}${identity.nudge ? "-nudge" : ""}.log`;
    case "reviewer":
      return `attempt-${identity.attempt}-reviewer-${identity.pass}-${identity.invocation}.log`;
    case "gate":
      return `attempt-${identity.attempt}-gate.log`;
    case "ui-check":
      return `ui-check-${identity.invocation}.log`;
  }
}

export function createAgentInvocationSequencer(): {
  startCycle(): AgentInvocationSequence;
} {
  let nextAttempt = 1;
  let nextUiCheck = 1;
  return {
    startCycle() {
      const attemptOffset = nextAttempt - 1;
      const uiCheckOffset = nextUiCheck - 1;
      return {
        filename(identity) {
          if (identity.role === "ui-check") {
            const invocation = uiCheckOffset + identity.invocation;
            nextUiCheck = Math.max(nextUiCheck, invocation + 1);
            return agentInvocationFilename({ ...identity, invocation });
          }
          const attempt = attemptOffset + identity.attempt;
          nextAttempt = Math.max(nextAttempt, attempt + 1);
          return agentInvocationFilename({ ...identity, attempt });
        },
      };
    },
  };
}

// The evidence either gate hands its artefact writer — the narrowing of
// `GateResult` that describes the run rather than times it. One type for both
// because gate-1 and gate-2 run the same stack and a reader wants the same
// bytes; the timings stay in the `gate` event, where nothing has to be
// reconstructed from a file.
//
// `failedStep` is the name of the gate step that went red — free-form since
// #24, since the steps are the consumer's.
export type GateRecord = {
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

// Gate-1's artefact carries the verdict as well as the evidence. Gate-2's sink
// is `onGateRed` and sees nothing else, so its files need no such field; gate-1
// files green runs too and would otherwise have to infer the verdict from
// `failedStep`, restating a `gate-stack.ts` invariant in a log writer.
export type AttemptGateRecord = GateRecord & { readonly ok: boolean };

export type IssueLogger = AttemptLogger & {
  readonly dir: string;
};

export type LandingLogger = {
  readonly dir: string;
  appendMerger(line: string): Promise<void>;
  writeMergerGate(issueId: string, gate: GateRecord): Promise<void>;
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
  const invocationSequencer = createAgentInvocationSequencer();
  return {
    dir,
    startInvocationCycle: () => invocationSequencer.startCycle(),
    async writeInvocation(filename, record) {
      const resources = formatContainerResources(record);
      const header = [
        `agent:      ${record.agent}`,
        `provider:   ${record.provider}`,
        `model:      ${record.model ?? "-"}`,
        `ended:      ${record.end}${record.detail ? ` (${record.detail})` : ""}`,
        `exit code:  ${record.exitCode ?? "-"}`,
        `duration:   ${record.durationMs}ms`,
        ...(resources ? [`resources:  ${resources}`] : []),
        "",
      ].join("\n");
      await writeFile(
        join(dir, filename),
        `${header}\n--- speech ---\n${record.speech}\n` +
          `--- stdout tail ---\n${record.stdout}\n` +
          `--- stderr tail ---\n${record.stderr}\n`,
        { flag: "wx" },
      );
    },
    // One file per attempt, beside that attempt's invocation records (#153).
    // Green gates included: the artefact a red gate has to be read against is
    // the last green one, and a run that only kept the reds has nothing to
    // diff. The section layout is therefore FIXED — an empty `containerLogs`
    // still gets its heading, so two attempts' files differ only where the
    // gate did.
    //
    // Unlike gate-2's four-file spread, which is read by a human already
    // standing in a landing directory, an attempt's gate log competes for
    // attention with the attempt logs around it: one file that `cat` answers
    // completely is worth more here than separable streams.
    async writeGate(filename, gate) {
      const header = [
        `result:     ${gate.ok ? "green" : "red"}`,
        `failed:     ${gate.failedStep ?? "-"}`,
        `exit code:  ${gate.exitCode}`,
        "",
      ].join("\n");
      await writeFile(
        join(dir, filename),
        `${header}\n--- stdout ---\n${gate.stdout}\n` +
          `--- stderr ---\n${gate.stderr}\n` +
          `--- container logs ---\n${gate.containerLogs}\n`,
        { flag: "wx" },
      );
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
      const resources = formatContainerResources(record);
      const header = [
        `resolve attempt ${record.attempt} for #${record.issueId} (mode=${record.mode})`,
        `container:  ${record.container}`,
        `ended:      ${record.end}` +
          (record.detail ? ` (${record.detail})` : ""),
        `exit code:  ${record.exitCode ?? "-"}`,
        `signal:     ${record.signal ?? "-"}`,
        `duration:   ${record.durationMs}ms`,
        ...(resources ? [`resources:  ${resources}`] : []),
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
