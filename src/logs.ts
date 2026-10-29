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
// human opens says OOMKilled even without consulting events.jsonl. An
// invocation file ends with its uncapped control lines (#189), the lifecycle
// evidence a hang is diagnosed from, which the bounded tails can lose.
// Before them, its commands: one line each, prefixed with the context depth
// the provider reported when the command was issued, or `-` when it reported
// none. The agent never reports that depth itself; it is read off the stream.
// Each admission also files the issue as `gh` returned it then (#195):
// `issue-snapshot-<n>.json`, create-only, numbered by its own per-issue
// sequence so a later admission in the same run never overwrites an earlier
// one. The writer answers with the filename, which `admitted` records.
// The scenario writer's output (#203) is filed the same way, create-only and
// numbered per issue: `scenarios-<k>.json`, the one file a written set lives
// in, beside the `scenario-writer-<n>.log` invocations that produced it. The
// writer answers with its path. No sandbox mounts this directory, so the
// scenarios stay hidden from the implementer. The verifier's scenario runner
// (#238) logs as `attempt-<n>-scenario-runner-<k>.log`, and each round that
// ran scenarios has its evidence archived under `verifier/round-<n>/`.
// An idle janitor run (#205) logs like an issue, under `janitor-<task>/`: its
// logger is cached per task the same way, so the invocation sequence spans
// every run of that task in the process.
// The quality pass's early run of the standalone gate steps (#247) files
// one log per fan-out from the same sequence, green or red:
// `attempt-<n>-standalone-steps-list.log` beside the listers and
// `attempt-<n>-standalone-steps-verify-<k>.log` beside a verify, a banner per
// step above its output.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Resolve types stay type-only — resolve-loop.ts loads prompt templates from
// disk at import, and the log tree must not depend on those existing. The
// resource formatter is the sole runtime helper and has no template inputs.
import type { ResolveAttemptRecord } from "./resolve-loop.js";
import type { AgentInvocationRecord } from "./agent-sandbox.js";
import type { IssueJson } from "./issue-anchor.js";
import type { ScenarioSet } from "./scenario-parser.js";
import { formatContainerResources } from "./container-resources.js";

export type AttemptLogger = {
  writeInvocation(filename: string, record: AgentInvocationRecord): Promise<void>;
  writeGate(filename: string, gate: AttemptGateRecord): Promise<void>;
  writeStandaloneSteps(filename: string, log: string): Promise<void>;
  startInvocationCycle(): AgentInvocationSequence;
  writeIssueSnapshot(issue: IssueJson): Promise<string>;
  writeScenarios(set: ScenarioSet): Promise<string>;
  // Where a verifier round's evidence is archived, by the name the sequence
  // gave it (`verifier-round`).
  verifierRoundDir(name: string): string;
};

// The `gate` role is not an agent invocation, but it is an artefact OF one
// attempt and must carry that attempt's number: a fresh HARD-ERROR cycle
// renumbers its attempts from 1, and a gate log numbered outside the sequence
// would sit beside `attempt-7.log` calling itself attempt 1.
export type AgentInvocationIdentity =
  | { readonly role: "implementer"; readonly attempt: number; readonly nudge: boolean }
  // The quality pass (#187): one lister per rule group per attempt (#204),
  // then fixer, verify and quality adjudicator steps numbered by the fixer
  // round they belong to.
  | {
      readonly role: "quality-list";
      readonly attempt: number;
      readonly group: string;
      readonly invocation: number;
    }
  | {
      readonly role: "quality-fix" | "quality-verify" | "quality-adjudicator";
      readonly attempt: number;
      readonly fixRound: number;
      readonly invocation: number;
    }
  | { readonly role: "reviewer"; readonly attempt: number; readonly invocation: number }
  | { readonly role: "scenario-runner"; readonly attempt: number; readonly invocation: number }
  | { readonly role: "adjudicator"; readonly attempt: number; readonly invocation: number }
  | { readonly role: "gate"; readonly attempt: number }
  // The early run of the standalone gate steps (#247): one file per fan-out,
  // beside the listers or beside a verify.
  | { readonly role: "standalone-steps"; readonly attempt: number; readonly mode: "list" }
  | {
      readonly role: "standalone-steps";
      readonly attempt: number;
      readonly mode: "verify";
      readonly fixRound: number;
    }
  // Not a file: the directory a verifier round's scenario evidence is
  // archived in, numbered like the round's other artefacts.
  | { readonly role: "verifier-round"; readonly attempt: number }
  | { readonly role: PreAttemptRole; readonly invocation: number };

// Roles that run before attempt 1 and number only their own invocations.
const PRE_ATTEMPT_ROLES = {
  "anchor-condense": true,
  "ui-check": true,
  "partition-check": true,
  "scenario-writer": true,
} as const;
type PreAttemptRole = keyof typeof PRE_ATTEMPT_ROLES;
const isPreAttempt = (
  identity: AgentInvocationIdentity,
): identity is Extract<AgentInvocationIdentity, { role: PreAttemptRole }> =>
  identity.role in PRE_ATTEMPT_ROLES;

export type AgentInvocationSequence = {
  filename(identity: AgentInvocationIdentity): string;
};

export function agentInvocationFilename(identity: AgentInvocationIdentity): string {
  switch (identity.role) {
    case "implementer":
      return `attempt-${identity.attempt}${identity.nudge ? "-nudge" : ""}.log`;
    case "quality-list":
      return `attempt-${identity.attempt}-quality-list-${identity.group}-${identity.invocation}.log`;
    case "quality-fix":
    case "quality-verify":
    case "quality-adjudicator":
      return `attempt-${identity.attempt}-${identity.role}-${identity.fixRound}-${identity.invocation}.log`;
    case "reviewer":
      return `attempt-${identity.attempt}-reviewer-${identity.invocation}.log`;
    case "scenario-runner":
      return `attempt-${identity.attempt}-scenario-runner-${identity.invocation}.log`;
    case "adjudicator":
      return `attempt-${identity.attempt}-adjudicator-${identity.invocation}.log`;
    case "gate":
      return `attempt-${identity.attempt}-gate.log`;
    case "standalone-steps":
      return `attempt-${identity.attempt}-standalone-steps-${
        identity.mode === "list" ? "list" : `verify-${identity.fixRound}`
      }.log`;
    case "verifier-round":
      return join("verifier", `round-${identity.attempt}`);
    case "anchor-condense":
    case "ui-check":
    case "partition-check":
    case "scenario-writer":
      return `${identity.role}-${identity.invocation}.log`;
  }
}

export function createAgentInvocationSequencer(): {
  startCycle(): AgentInvocationSequence;
} {
  let nextAttempt = 1;
  const nextPreAttempt: Record<PreAttemptRole, number> = {
    "anchor-condense": 1,
    "ui-check": 1,
    "partition-check": 1,
    "scenario-writer": 1,
  };
  return {
    startCycle() {
      const attemptOffset = nextAttempt - 1;
      const preAttemptStart = { ...nextPreAttempt };
      return {
        filename(identity) {
          if (isPreAttempt(identity)) {
            const { role } = identity;
            const invocation = preAttemptStart[role] - 1 + identity.invocation;
            nextPreAttempt[role] = Math.max(nextPreAttempt[role], invocation + 1);
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
  // for a chunk, `verify-round-<n>` for a forge-red round (and, for the gate
  // artefact alone, `origin-sync` for a push race's re-gate) — so a chunk and its
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
  janitor(task: string): Promise<IssueLogger>;
  landing(n: number): LandingLogger;
};

// The run-directory entry an issue's or a janitor task's logs live under.
export const issueLogDirName = (issueId: string): string => `issue-${issueId}`;
export const janitorLogDirName = (task: string): string => `janitor-${task}`;

export async function createTranscriptTree(runDir: string): Promise<TranscriptTree> {
  await mkdir(runDir, { recursive: true });
  // Keyed by directory name, which keeps issues and janitor tasks apart.
  const subjectCache = new Map<string, Promise<IssueLogger>>();
  const landingCache = new Map<number, LandingLogger>();
  const subjectLogger = (dirName: string): Promise<IssueLogger> => {
    const cached = subjectCache.get(dirName);
    if (cached) return cached;
    const created = makeIssueLogger(join(runDir, dirName));
    subjectCache.set(dirName, created);
    return created;
  };

  return {
    runDir,
    issue: (issueId) => subjectLogger(issueLogDirName(issueId)),
    janitor: (task) => subjectLogger(janitorLogDirName(task)),
    landing(n) {
      const cached = landingCache.get(n);
      if (cached) return cached;
      const created = makeLandingLogger(runDir, n);
      landingCache.set(n, created);
      return created;
    },
  };
}

// One line per command: a multi-line argument (a heredoc) shows its first
// line and an ellipsis, so the depth column stays scannable.
const formatCommand = (command: AgentInvocationRecord["commands"][number]): string => {
  const depth = command.contextTokens === undefined ? "-" : `${command.contextTokens} tok`;
  const [first = ""] = command.args.split("\n");
  const args = first === command.args ? first : `${first} …`;
  return `[${depth}] ${command.name}: ${args}\n`;
};

async function makeIssueLogger(dir: string): Promise<IssueLogger> {
  await mkdir(dir, { recursive: true });
  const invocationSequencer = createAgentInvocationSequencer();
  let nextSnapshot = 1;
  let nextScenarios = 1;
  return {
    dir,
    startInvocationCycle: () => invocationSequencer.startCycle(),
    async writeIssueSnapshot(issue) {
      const filename = `issue-snapshot-${nextSnapshot++}.json`;
      await writeFile(join(dir, filename), `${JSON.stringify(issue, null, 2)}\n`, { flag: "wx" });
      return filename;
    },
    verifierRoundDir: (name) => join(dir, name),
    // Create-only, green fan-outs included, as gate-1's are (#153).
    async writeStandaloneSteps(filename, log) {
      await writeFile(join(dir, filename), log, { flag: "wx" });
    },
    async writeScenarios(set) {
      const path = join(dir, `scenarios-${nextScenarios++}.json`);
      await writeFile(path, `${JSON.stringify(set, null, 2)}\n`, { flag: "wx" });
      return path;
    },
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
          `--- stderr tail ---\n${record.stderr}\n` +
          `--- commands ---\n${record.commands.map(formatCommand).join("")}` +
          `--- control lines ---\n${record.controlLines.map((line) => `${line}\n`).join("")}`,
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
