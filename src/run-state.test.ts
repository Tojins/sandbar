import { describe, expect, it } from "vitest";
import { EVENT_SCHEMA_VERSION, type RunEvent } from "./events.js";
import {
  reduceRunEvents as reduce,
  type ReduceRunOptions,
  waitingReasonText,
} from "./run-state.js";

const at = (seq: number, ts: string, event: object): RunEvent =>
  ({ seq, ts, ...event }) as RunEvent;

const reduceRunEvents = (
  events: readonly RunEvent[],
  options: Omit<ReduceRunOptions, "runDirectory">,
) => reduce(events, { ...options, runDirectory: "/logs/run-test" });

describe("run event reducer", () => {
  it("renders excluded label actors in the waiting list", () => {
    expect(waitingReasonText({ kind: "label-actor", actor: "mallory" }))
      .toBe("excluded: ready-for-agent applied by @mallory");
    expect(waitingReasonText({ kind: "label-actor", actor: null }))
      .toBe("excluded: ready-for-agent label actor unknown");
  });

  it("names why a review-gated issue is held", () => {
    expect(waitingReasonText({ kind: "held", why: "unsettled" }))
      .toBe("held: waiting for the issue graph to settle");
    expect(waitingReasonText({ kind: "held", why: "drifted-branches" }))
      .toBe("held: several chunk branches name its root");
    // A record written before `why` existed.
    expect(waitingReasonText({ kind: "held" }))
      .toBe("held: no chunk to land on");
  });

  it("feeds deploy verdicts and raises only a filed red into the header (#198)", () => {
    const deploy = (seq: number, fields: object) => at(seq, "2026-10-28T09:00:00Z", {
      kind: "deploy", workflow: "deploy.yml", sha: "0123456789abcdef", issues: [7, 8],
      bugIssue: null, filed: false, ...fields,
    });
    const state = reduceRunEvents([
      at(1, "2026-10-28T08:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar", configPath: null,
        workdir: "/r", maxParallelIssues: 1, pid: 1,
      }),
      deploy(2, { outcome: "green", runId: 11, attempt: 1 }),
      deploy(3, { outcome: "unverified", runId: null, attempt: null, issues: [9] }),
      deploy(4, { outcome: "red", runId: 12, attempt: 1, bugIssue: 40, filed: true }),
      // A later process repairing the missing comment of a bug already filed.
      deploy(5, { outcome: "red", runId: 12, attempt: 1, bugIssue: 40, filed: false }),
    ], { now: new Date("2026-10-28T09:01:00Z"), pidAlive: true });

    expect(state.events.slice(0, 4).map(({ text, tone, issue }) => ({ text, tone, issue }))).toEqual([
      { text: "deploy red · deploy.yml run 12 attempt 1 · #7, #8 · bug #40", tone: "bad", issue: null },
      { text: "deploy red · deploy.yml run 12 attempt 1 · #7, #8 · filed #40", tone: "bad", issue: null },
      { text: "deploy unverified · deploy.yml no run within the deadline for 0123456 · #9", tone: "warn", issue: null },
      { text: "deploy green · deploy.yml run 11 attempt 1 · #7, #8", tone: "good", issue: null },
    ]);
    expect(state.run.complaints).toEqual([{
      seq: 4,
      severity: "error",
      text: "deploy red · deploy.yml run 12 attempt 1 · #7, #8 · filed #40",
    }]);
  });

  // A drain can take an hour, and a reader who cannot see the request would
  // see only a pool that stopped admitting (#146).
  it("shows a janitor run as one header row and its feed lines, never as an issue (#205)", () => {
    const janitor = { janitor: "tidy", title: "Idle task: tidy" };
    const events = [
      at(1, "2026-10-28T08:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar", configPath: null,
        workdir: "/r", maxParallelIssues: 2, pid: 1,
      }),
      at(2, "2026-10-28T08:01:00Z", { kind: "setup", ...janitor, durationMs: 5 }),
      at(3, "2026-10-28T08:02:00Z", { kind: "phase", ...janitor, attempt: 1, phases: ["implementer"] }),
      at(4, "2026-10-28T08:03:00Z", {
        kind: "implementer", ...janitor, attempt: 1, signal: "COMPLETE", commits: 1,
        provider: "claude", model: "m", effort: null, durationMs: 9,
      }),
      at(5, "2026-10-28T08:04:00Z", { kind: "hard-error", ...janitor, retry: 1, max: 2, reason: "podman" }),
      at(6, "2026-10-28T08:05:00Z", { kind: "phase", ...janitor, attempt: 1, phases: ["quality"] }),
      at(7, "2026-10-28T08:06:00Z", {
        kind: "review-round", ...janitor, attempt: 1, round: 1, head: "h", quality: "APPROVED",
        qualityRounds: 1, gateOk: true, correctness: "APPROVED", rejectingPass: null,
        gateFailures: 0, correctnessFailures: 0, durationMs: 4,
      }),
    ];
    const live = reduceRunEvents(events, { now: new Date("2026-10-28T08:07:00Z"), pidAlive: true });

    expect(live.run.janitor).toEqual({
      task: "tidy", title: "Idle task: tidy", phase: "quality", phaseSince: "2026-10-28T08:05:00Z",
    });
    expect(live.pool).toEqual([]);
    expect(live.finished).toEqual([]);
    expect(live.run.slots.used).toBe(0);
    expect(live.events.slice(0, 3).map(({ issue, janitor: task, text }) => ({ issue, task, text }))).toEqual([
      { issue: null, task: "tidy", text: "round 1 · approved" },
      { issue: null, task: "tidy", text: "phase · quality" },
      { issue: null, task: "tidy", text: "hard error · retry 1/2 · podman" },
    ]);

    const afterHardError = reduceRunEvents(events.slice(0, 5), {
      now: new Date("2026-10-28T08:07:00Z"), pidAlive: true,
    });
    expect(afterHardError.run.janitor).toMatchObject({ phase: "setup", phaseSince: "2026-10-28T08:04:00Z" });

    const finished = reduceRunEvents([
      ...events,
      at(8, "2026-10-28T08:08:00Z", { kind: "phase", ...janitor, attempt: 1, phases: [] }),
    ], { now: new Date("2026-10-28T08:09:00Z"), pidAlive: true });
    expect(finished.run.janitor).toBeNull();
  });

  it("keeps a pending restart visible for the whole drain", () => {
    const events = [
      at(1, "2026-09-11T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar", configPath: "/i/c.mjs",
        workdir: "/r", maxParallelIssues: 1, pid: 1,
      }),
      at(2, "2026-09-11T09:01:00Z", { kind: "restart-requested", detail: "abc1234" }),
    ];
    const draining = reduceRunEvents(events, {
      now: new Date("2026-09-11T09:02:00Z"), pidAlive: true,
    });
    expect(draining.run.restart).toEqual({
      detail: "abc1234", at: "2026-09-11T09:01:00Z", deferredUntil: null,
    });
    expect(draining.events[0]).toMatchObject({
      text: "restart requested · abc1234 · draining", tone: "warn",
    });

    const exited = reduceRunEvents([
      ...events,
      at(3, "2026-09-11T09:05:00Z", {
        kind: "exit", tag: "restart", reason: "drained", exitCode: 75,
      }),
    ], { now: new Date("2026-09-11T09:06:00Z"), pidAlive: false });
    expect(exited.run.restart).toEqual({
      detail: "abc1234", at: "2026-09-11T09:01:00Z", deferredUntil: null,
    });
    expect(exited.run.exit).toEqual({ tag: "restart", reason: "drained" });
  });

  // A deferred request keeps the pool admitting, so the header must say it is
  // waiting rather than draining, then switch once it becomes due.
  it("shows a deferred restart until it becomes due", () => {
    const events = [
      at(1, "2026-09-11T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar", configPath: "/i/c.mjs",
        workdir: "/r", maxParallelIssues: 1, pid: 1,
      }),
      at(2, "2026-09-11T09:01:00Z", {
        kind: "restart-requested", detail: "abc1234", deferredUntil: "2026-09-11T11:01:00.000Z",
      }),
    ];
    const deferred = reduceRunEvents(events, {
      now: new Date("2026-09-11T09:02:00Z"), pidAlive: true,
    });
    expect(deferred.run.restart).toEqual({
      detail: "abc1234", at: "2026-09-11T09:01:00Z", deferredUntil: "2026-09-11T11:01:00.000Z",
    });
    expect(deferred.events[0]).toMatchObject({
      text: "restart requested · abc1234 · deferred until 2026-09-11T11:01:00.000Z",
    });

    const due = reduceRunEvents([
      ...events,
      at(3, "2026-09-11T09:30:00Z", {
        kind: "restart-requested", detail: "def5678", urgent: true, due: "urgent",
      }),
    ], { now: new Date("2026-09-11T09:31:00Z"), pidAlive: true });
    expect(due.run.restart).toEqual({
      detail: "def5678", at: "2026-09-11T09:30:00Z", deferredUntil: null,
    });
    expect(due.events[0]).toMatchObject({
      text: "restart requested · def5678 · draining (urgent)",
    });
  });

  it("reports no pending restart on a run nobody asked to stop", () => {
    const state = reduceRunEvents([
      at(1, "2026-09-11T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar", configPath: null,
        workdir: "/r", maxParallelIssues: 1, pid: 1,
      }),
    ], { now: new Date("2026-09-11T09:01:00Z"), pidAlive: true });
    expect(state.run.restart).toBeNull();
  });

  it("passes container resource facts through to feed rows without defaulting absences", () => {
    const steps = {
      test: { ok: false, durationMs: 12, peakMemoryBytes: 4096, oomKilled: false },
    };
    const state = reduceRunEvents([
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar", configPath: null,
        workdir: "/r", maxParallelIssues: 1, pid: 1,
      }),
      at(2, "2026-09-07T09:01:00Z", {
        kind: "gate", gate: "gate-1", issue: 2, attempt: 1, ok: false,
        durationMs: 12, steps,
      }),
      at(3, "2026-09-07T09:02:00Z", {
        kind: "review-pass", issue: 2, attempt: 1, round: 1,
        invocation: 1, provider: "codex", model: "m", effort: null,
        result: "failed", durationMs: 9, peakMemoryBytes: 8192, oomKilled: true,
      }),
    ], { now: new Date("2026-09-07T09:03:00Z"), pidAlive: true });
    expect(state.events[0]).toMatchObject({ peakMemoryBytes: 8192, oomKilled: true });
    expect(state.events[1]?.steps).toBe(steps);
    expect(state.events[1]).not.toHaveProperty("peakMemoryBytes");
  });

  it.each([
    ["FAILED", true, "attempt 1 failed · OOM-killed · 0 commits"],
    ["QUOTA", false, "attempt 1 failed · quota · 0 commits"],
    ["CREDENTIAL", false, "attempt 1 failed · credential · 0 commits"],
  ] as const)(
    "renders %s as failure evidence and excludes it from completed attempts",
    (signal, oomKilled, expectedText) => {
      const terminal = signal === "FAILED" ? "HARD-ERROR" : signal;
      const state = reduceRunEvents([
        at(1, "2026-09-07T09:00:00Z", {
          kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar", configPath: null,
          workdir: "/r", maxParallelIssues: 1, pid: 1,
        }),
        at(2, "2026-09-07T09:01:00Z", {
          kind: "implementer", issue: 2, attempt: 1, signal, commits: 0,
          provider: "codex", model: "m", effort: null, durationMs: 5,
          peakMemoryBytes: 4096, oomKilled,
        }),
        at(3, "2026-09-07T09:02:00Z", {
          kind: "terminal", issue: 2, title: "Two", terminal,
          reason: "provider stopped", durationMs: 6,
        }),
      ], { now: new Date("2026-09-07T09:03:00Z"), pidAlive: false });

      expect(state.events[1]).toMatchObject({
        text: expectedText, tone: "bad", peakMemoryBytes: 4096, oomKilled,
      });
      expect(state.finished).toEqual([
        expect.objectContaining({ issue: 2, attempts: 0 }),
      ]);
    },
  );

  // #188: a failed run whose commits the sandbox could not count records none,
  // and the row says nothing about commits rather than "0 commits".
  it("renders a failed attempt with uncounted commits without a commit count", () => {
    const state = reduceRunEvents([
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar", configPath: null,
        workdir: "/r", maxParallelIssues: 1, pid: 1,
      }),
      at(2, "2026-09-07T09:01:00Z", {
        kind: "implementer", issue: 2, attempt: 1, signal: "FAILED",
        provider: "codex", model: "m", effort: null, durationMs: 5,
      }),
    ], { now: new Date("2026-09-07T09:03:00Z"), pidAlive: false });

    expect(state.events[0]).toMatchObject({ text: "attempt 1 failed · invocation failed", tone: "bad" });
  });

  it("projects every event kind into a newest-first, attributed feed", () => {
    const rows: object[] = [
      { kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar", configPath: null,
        workdir: "/r", maxParallelIssues: 2, pid: 1 },
      { kind: "wake-lock", state: "held", detail: "held" },
      { kind: "preflight", action: "started", detail: "Preflight started" },
      { kind: "sweep", scope: "startup", removed: ["pod"], failures: [] },
      { kind: "image", action: "built", image: "base", detail: "built", durationMs: 2 },
      { kind: "landing-batch", n: 1, durationMs: 9 },
      { kind: "recompute", n: 1, trigger: "launch", admitted: [], active: [], waiting: [],
        landRequests: [], deferredChunks: [], candidates: [], refs: [] },
      { kind: "follow-up", action: "re-queued", detail: "requeued #2" },
      { kind: "reconcile", action: "trace", detail: "checked chunks" },
      { kind: "notice", message: "lease renewal recovered" },
      { kind: "complaint", severity: "warning", message: "stale config" },
      { kind: "admitted", issue: 2, title: "Two", branch: "sandbar/issue-2", chunk: null,
        seedRef: "origin/main" },
      { kind: "origin-sync", issue: 2, outcome: "abandoned", detail: "branch abandoned" },
      { kind: "phase", issue: 2, attempt: 1, phases: ["implementer"] },
      { kind: "setup", issue: 2, durationMs: 3 },
      { kind: "issue-anchor", issue: 2, result: "condensed", rawChars: 40, tracedChars: 30,
        anchorChars: 20, comments: 5, dropped: 2, provider: "claude", model: "sonnet",
        effort: null, durationMs: 4 },
      { kind: "issue-anchor", issue: 2, result: "unparseable", rawChars: 40, tracedChars: 30,
        anchorChars: 30, comments: 5, dropped: 0 },
      { kind: "issue-anchor", issue: 2, result: "wrote", rawChars: 40, tracedChars: 30,
        anchorChars: 30, comments: 5, dropped: 0 },
      { kind: "ui-check", issue: 2, invocation: 1, provider: "codex", model: "m",
        effort: null, durationMs: 4, result: "CLEAR" },
      { kind: "scenario-writer", issue: 2, invocation: 1, provider: "claude", model: "opus",
        effort: null, durationMs: 4, result: "completed" },
      { kind: "scenario-writer", issue: 2, invocation: 2, provider: "claude", model: "opus",
        effort: null, durationMs: 4, result: "completed", scenarios: 7 },
      { kind: "scenario-writer", issue: 2, invocation: 1, provider: "claude", model: "opus",
        effort: null, result: "quota" },
      { kind: "implementer", issue: 2, attempt: 1, signal: "COMPLETE", commits: 1,
        provider: "codex", model: "m", effort: null, durationMs: 5 },
      { kind: "quality-review", issue: 2, attempt: 1, round: 1, invocation: 1, mode: "list",
        group: "naming", scope: "full", provider: "codex", model: "m", effort: null,
        result: "completed", verdict: "CHANGES-REQUESTED", prose: "### Tests\nx", durationMs: 6 },
      { kind: "quality-review", issue: 2, attempt: 1, round: 1, invocation: 1, mode: "list",
        scope: "full", provider: "codex", model: "m", effort: null, result: "completed",
        verdict: null, prose: "", durationMs: 6 },
      { kind: "quality-review", issue: 2, attempt: 1, round: 1, invocation: 2, mode: "verify",
        scope: "since:abc", provider: "codex", model: "m", effort: null, result: "quota",
        verdict: null, prose: "", durationMs: 6 },
      { kind: "quality-review", issue: 2, attempt: 1, round: 1, invocation: 1, mode: "verify",
        scope: "since:abc", provider: "codex", model: "m", effort: null, result: "completed",
        verdict: "APPROVED", prose: "<verdict>APPROVED</verdict>", durationMs: 6 },
      { kind: "quality-pass", issue: 2, attempt: 1, round: 1, provider: "codex", model: "m",
        effort: null, result: "completed", commits: ["q1"], durationMs: 6,
        discarded: { dirtyPaths: [" M scratch.ts"], strandedHead: "dead", rewoundTip: null } },
      { kind: "quality-pass", issue: 2, attempt: 1, round: 1, provider: "codex", model: "m",
        effort: null, result: "failed", commits: [], durationMs: 6,
        discarded: { dirtyPaths: [], strandedHead: null, rewoundTip: null } },
      { kind: "quality-pass", issue: 2, attempt: 1, round: 1, provider: "codex", model: "m",
        effort: null, result: "quota", durationMs: 6 },
      { kind: "gate", issue: 2, attempt: 1, gate: "gate-1", ok: true, durationMs: 6 },
      { kind: "review-pass", issue: 2, attempt: 1, round: 1, invocation: 1,
        provider: "codex", model: "m", effort: null, result: "completed", durationMs: 7 },
      { kind: "adjudication", pass: "correctness", issue: 2, attempt: 2, round: 1,
        head: "abc", ruling: "OVERRULED", provider: "codex", model: "m",
        effort: null, durationMs: 4 },
      { kind: "resolve-attempt", issue: 2, attempt: 1, container: "resolve-1",
        end: "exit", exitCode: 137, signal: null, durationMs: 8,
        peakMemoryBytes: 7000, oomKilled: true },
      { kind: "container", stack: "sandbox", issue: 2, title: "Two", name: "db",
        container: "sandbox-db", lifecycle: "issue", durationMs: 9,
        peakMemoryBytes: 8000, oomKilled: true },
      { kind: "review-round", issue: 2, attempt: 1, round: 1, head: "abc",
        quality: "CHANGES-REQUESTED", qualityRounds: 3,
        gateOk: false, correctness: "SKIPPED", rejectingPass: null, gateFailures: 1,
        correctnessFailures: 0, durationMs: 8 },
      { kind: "review-round", issue: 2, attempt: 1, round: 1, head: "abc",
        quality: "APPROVED", qualityRounds: 0,
        gateOk: true, correctness: "APPROVED", rejectingPass: null, gateFailures: 0,
        correctnessFailures: 0, durationMs: 8 },
      { kind: "repair", issue: 2, attempt: 2, action: "re-prompt", detail: "fix" },
      { kind: "hard-error", issue: 2, retry: 1, max: 2, reason: "pod\ntrace" },
      { kind: "terminal", issue: 2, title: "Two", terminal: "DONE", reason: null,
        durationMs: 9 },
      { kind: "landed", issue: 2, title: "Two", outcome: "merged",
        branch: "sandbar/issue-2", target: "main", reason: null, durationMs: 10 },
      { kind: "finalise", issue: 2, finaliseKind: "merged", outcome: "deleted-local" },
      { kind: "exit", tag: "plan-empty", reason: "done", exitCode: 0 },
      { kind: "run-end", reason: "plan-empty" },
    ];
    const events = rows.map((row, index) => at(
      index + 1,
      `2026-09-07T09:${String(index).padStart(2, "0")}:00Z`,
      row,
    ));
    const state = reduceRunEvents(events, { now: new Date("2026-09-07T10:00:00Z"), pidAlive: false });
    expect(state.eventCount).toBe(rows.length);
    expect(state.events.map((event) => [event.issue, event.text, event.tone])).toEqual([
      [null, "run ended · plan-empty", "dim"],
      [null, "exit plan-empty · done", "good"],
      [2, "finalise merged · deleted-local", "dim"],
      [2, "merged sandbar/issue-2 → main", "good"],
      [2, "DONE", "good"],
      [2, "hard error · retry 1/2 · pod", "bad"],
      [2, "repair · re-prompt", "warn"],
      [2, "round 1 · approved", "good"],
      [2, "round 1 · gate changes requested · quality changes-requested", "bad"],
      [2, "sandbox container db stopped", "bad"],
      [2, "resolve attempt 1 · exit", "bad"],
      [2, "round 1 · correctness adjudication · OVERRULED", "good"],
      [2, "round 1 · correctness pass · invocation 1", ""],
      [2, "gate-1 passed", "good"],
      [2, "round 1 · quality pass · quota", "bad"],
      [2, "round 1 · quality pass (invocation failed) · 0 commits", ""],
      [2, "round 1 · quality pass · 1 commit · discarded 1 uncommitted path, off-branch HEAD dead", ""],
      [2, "round 1 · quality verify · invocation 1 · APPROVED", "good"],
      [2, "round 1 · quality verify · invocation 2 · quota", "bad"],
      [2, "round 1 · quality list · invocation 1 · no verdict", ""],
      [2, "round 1 · quality list [naming] · invocation 1 · CHANGES-REQUESTED", ""],
      [2, "attempt 1 complete · 1 commit", ""],
      [2, "scenario writer failed: quota", "warn"],
      [2, "scenarios written: 7", "dim"],
      [2, "scenario writer 1 · format nudge", "dim"],
      [2, "UI check 1 · CLEAR", "dim"],
      [2, "issue anchor · wrote", "bad"],
      [2, "issue anchor · unparseable", "warn"],
      [2, "issue anchor · condensed · 2 of 5 comments dropped", "dim"],
      [2, "setup complete · 3ms", "dim"],
      [2, "phase · implementer", "dim"],
      [2, "origin sync · branch abandoned", "dim"],
      [2, "admitted #2", "dim"],
      [null, "stale config", "warn"],
      [null, "lease renewal recovered", "dim"],
      [null, "reconcile trace · checked chunks", "dim"],
      [null, "requeued #2", "dim"],
      [null, "recompute 1 · launch", "dim"],
      [null, "landing complete · 9ms", "dim"],
      [null, "image built · base", "dim"],
      [null, "startup sweep · 1 removed · 0 failed", "dim"],
      [null, "preflight started · Preflight started", "dim"],
      [null, "wake lock held", "dim"],
      [null, "run started", "dim"],
    ]);
    expect(state.events.find((event) => event.text === "resolve attempt 1 · exit"))
      .toMatchObject({ peakMemoryBytes: 7000, oomKilled: true });
    expect(state.events.find((event) => event.text === "sandbox container db stopped"))
      .toMatchObject({ peakMemoryBytes: 8000, oomKilled: true });
    expect(state.run.complaints).toEqual([
      { seq: 11, severity: "warning", text: "stale config" },
    ]);
  });

  it.each([
    [
      { kind: "hard-error", issue: 2, retry: 2, max: 2,
        reason: "provider cause\n(codex exited with code 1)" },
      "hard error · retry 2/2 · provider cause",
    ],
    [
      { kind: "terminal", issue: 2, terminal: "HARD-ERROR",
        reason: "provider cause\n(codex exited with code 1)", durationMs: 10 },
      "HARD-ERROR · provider cause\n(codex exited with code 1)",
    ],
  ] as const)("projects the cause for %j", (event, expected) => {
    const state = reduceRunEvents([
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar", configPath: null,
        workdir: "/r", maxParallelIssues: 1, pid: 1,
      }),
      at(2, "2026-09-07T09:01:00Z", event),
    ], { now: new Date("2026-09-07T09:02:00Z"), pidAlive: true });
    expect(state.events[0]?.text).toBe(expected);
  });

  it("limits recent feed rows to 200 without changing the total", () => {
    const events = [at(1, "2026-09-07T09:00:00Z", {
      kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar", configPath: null,
      workdir: "/r", maxParallelIssues: 1, pid: 1,
    })];
    for (let index = 0; index < 205; index += 1) {
      events.push(at(index + 2, "2026-09-07T09:01:00Z", {
        kind: "complaint", severity: "warning", message: `warning ${index}`,
      }));
    }
    const state = reduceRunEvents(events, { now: new Date(), pidAlive: true });
    expect(state.eventCount).toBe(206);
    expect(state.events).toHaveLength(200);
    expect(state.events[0]?.text).toBe("warning 204");
  });

  it("renders pool timelines, waiting reasons and parked refs from one recompute", () => {
    const events: RunEvent[] = [
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar 0.36.0",
        configPath: "/r/sandbar.config.mjs", workdir: "/r/.sandbar",
        maxParallelIssues: 3, pid: 10,
      }),
      at(2, "2026-09-07T09:01:00Z", {
        kind: "admitted", issue: 102, title: "Capacity error", branch: "sandbar/issue-102-capacity",
        chunk: null, seedRef: "origin/main",
      }),
      at(3, "2026-09-07T09:02:00Z", {
        kind: "phase", issue: 102, title: "Capacity error", attempt: 1, phases: ["implementer"],
      }),
      at(4, "2026-09-07T09:20:00Z", {
        kind: "phase", issue: 102, title: "Capacity error", attempt: 1, phases: ["quality"],
      }),
      at(5, "2026-09-07T09:20:30Z", {
        kind: "phase", issue: 102, title: "Capacity error", attempt: 1, phases: ["gate-1"],
      }),
      at(6, "2026-09-07T09:20:40Z", {
        kind: "phase", issue: 102, title: "Capacity error", attempt: 1, phases: ["review"],
      }),
      at(7, "2026-09-07T09:21:00Z", {
        kind: "phase", issue: 102, title: "Capacity error", attempt: 2,
        phases: ["adjudication"],
      }),
      at(8, "2026-09-07T09:22:00Z", {
        kind: "adjudication", pass: "quality", issue: 102, title: "Capacity error", attempt: 2,
        round: 1, head: "abc", ruling: "UPHELD",
        provider: "codex", model: "judge", effort: null, durationMs: 60000,
      }),
      at(9, "2026-09-07T09:23:00Z", {
        kind: "recompute", n: 2, trigger: "slot-freed", admitted: [],
        active: [{ issue: 102, title: "Capacity error" }],
        waiting: [
          { issue: 104, title: "Picker", reason: { kind: "blocked", by: [102] } },
          { issue: 111, title: "Export", reason: { kind: "no-slot" } },
        ],
        landRequests: [], deferredChunks: [],
        candidates: [
          { issue: 87, title: "Nightly job", branch: "sandbar/issue-87-job", chunk: null, ready: false },
          { issue: 104, title: "Picker", branch: "sandbar/issue-104-picker", chunk: null, ready: true },
        ],
        refs: [{ issue: 87, branch: "sandbar/issue-87-job", tip: "abc" }],
      }),
    ];
    const state = reduceRunEvents(events, {
      now: new Date("2026-09-07T09:30:00Z"), pidAlive: true,
    });
    expect(state.run).toMatchObject({ status: "live", slots: { used: 1, max: 3 } });
    expect(state.pool[0]).toMatchObject({ issue: 102, phase: "adjudication", attempt: 2 });
    expect(state.pool[0]?.spans).toEqual([
      { kind: "impl", from: "2026-09-07T09:02:00Z", to: "2026-09-07T09:20:00Z", label: "a1" },
      { kind: "review", from: "2026-09-07T09:20:00Z", to: "2026-09-07T09:20:30Z", label: "quality" },
      { kind: "review", from: "2026-09-07T09:20:30Z", to: "2026-09-07T09:20:40Z", label: "gate-1" },
      { kind: "review", from: "2026-09-07T09:20:40Z", to: "2026-09-07T09:21:00Z", label: "review" },
      { kind: "adjudication", from: "2026-09-07T09:21:00Z", to: null,
        label: "UPHELD", verdict: "no" },
    ]);
    expect(state.waiting).toEqual([
      { issue: 87, title: "Nightly job", why: "parked · unknown terminal · before this run", parked: true },
      { issue: 104, title: "Picker", why: "blocked by #102" },
      { issue: 111, title: "Export", why: "no free slot" },
    ]);
  });

  it("does not resurrect a landed chunk member from its retained issue ref", () => {
    const events: RunEvent[] = [
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar",
        configPath: null, workdir: "/r", maxParallelIssues: 1, pid: 1,
      }),
      at(2, "2026-09-07T09:01:00Z", {
        kind: "landed", outcome: "chunk-on-source",
        branch: "sandbar/chunk-383-c", target: "main", pullRequest: 389,
        title: "Chunk 383", members: [383], reason: null, durationMs: 0,
      }),
      at(3, "2026-09-07T09:02:00Z", {
        kind: "recompute", n: 2, trigger: "poll", admitted: [], active: [],
        waiting: [], landRequests: [], deferredChunks: [], candidates: [],
        refs: [{
          issue: 383,
          branch: "sandbar/issue-383-parked",
          tip: "merge-only-tip",
        }],
      }),
    ];

    const state = reduceRunEvents(events, {
      now: new Date("2026-09-07T09:03:00Z"),
      pidAlive: true,
    });

    expect(state.waiting).toEqual([]);
    expect(state.landedChunks).toEqual([
      expect.objectContaining({ pullRequest: 389, members: [383] }),
    ]);
  });

  it("does not resurrect a member landed in an earlier run", () => {
    const events: RunEvent[] = [
      at(1, "2026-09-08T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar",
        configPath: null, workdir: "/r", maxParallelIssues: 1, pid: 1,
      }),
      at(2, "2026-09-08T09:01:00Z", {
        kind: "recompute", n: 1, trigger: "launch", admitted: [], active: [],
        waiting: [], landRequests: [], deferredChunks: [], candidates: [],
        refs: [{
          issue: 383,
          branch: "sandbar/issue-383-parked",
          tip: "retained-unlanded-tip",
        }],
      }),
    ];
    const priorChunk = {
      pullRequest: 389,
      title: "Chunk 383",
      members: [383],
      target: "main",
      ms: 42,
      at: "2026-09-07T09:01:00Z",
    };

    const state = reduceRunEvents(events, {
      now: new Date("2026-09-08T09:02:00Z"),
      pidAlive: true,
      recentLandedChunks: [priorChunk],
    });

    expect(state.waiting).toEqual([]);
    expect(state.landedChunks).toEqual([priorChunk]);
  });

  it("surfaces a retained closed branch only as its preflight complaint", () => {
    const message = "Closed issue #385's cached branch was kept: unlanded work";
    const events: RunEvent[] = [
      at(1, "2026-09-29T13:03:46Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar",
        configPath: null, workdir: "/r", maxParallelIssues: 1, pid: 1,
      }),
      at(2, "2026-09-29T13:03:47Z", {
        kind: "complaint", severity: "warning", message,
        subject: {
          kind: "closed-issue-branch",
          issue: 385,
          branch: "sandbar/issue-385-unlanded",
        },
      }),
      at(3, "2026-09-29T13:03:48Z", {
        kind: "recompute", n: 1, trigger: "launch", admitted: [], active: [],
        waiting: [], landRequests: [], deferredChunks: [], candidates: [],
        refs: [{
          issue: 385,
          branch: "sandbar/issue-385-unlanded",
          tip: "unlanded-tip",
        }],
      }),
    ];

    const state = reduceRunEvents(events, {
      now: new Date("2026-09-29T13:04:00Z"),
      pidAlive: true,
    });

    expect(state.waiting).toEqual([]);
    expect(state.run.complaints).toEqual([{
      seq: 2,
      severity: "warning",
      text: message,
    }]);
  });

  it("projects explicit landing status and moves a landed request into history", () => {
    const base = [
      at(1, "2026-09-17T13:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar",
        configPath: null, workdir: "/r", maxParallelIssues: 2, pid: 1,
      }),
      at(2, "2026-09-17T13:08:00Z", {
        kind: "recompute", n: 1, trigger: "poll", admitted: [], active: [],
        waiting: [], landRequests: ["sandbar/chunk-177-c", "sandbar/chunk-157-c"],
        deferredChunks: [], candidates: [], refs: [],
      }),
      at(3, "2026-09-17T13:08:01Z", {
        kind: "land-request", pullRequest: 305, branch: "sandbar/chunk-177-c",
        title: "Migrations", members: [177],
        status: { kind: "landing", step: "merge", reason: "landing together with #156 → its chunk, PR #306" },
      }),
      at(4, "2026-09-17T13:08:02Z", {
        kind: "land-request", pullRequest: 306, branch: "sandbar/chunk-157-c",
        title: "Review hotfix", members: [157],
        status: { kind: "queued", reason: "lands after PR #305" },
      }),
      at(5, "2026-09-17T14:12:00Z", {
        kind: "land-request", pullRequest: 305, branch: "sandbar/chunk-177-c",
        title: "Migrations", members: [177],
        status: { kind: "landing", step: "gate-2", reason: "landing together with #156 → its chunk, PR #306" },
      }),
    ];
    const active = reduceRunEvents(base, {
      now: new Date("2026-09-17T14:12:30Z"), pidAlive: true,
    });
    expect(active.landing).toEqual([
      {
        pullRequest: 305, branch: "sandbar/chunk-177-c", title: "Migrations",
        members: [177], requestedAt: "2026-09-17T13:08:01Z",
        statusSince: "2026-09-17T14:12:00Z", status: "landing", step: "gate-2",
        reason: "landing together with #156 → its chunk, PR #306",
      },
      expect.objectContaining({
        pullRequest: 306, status: "queued", step: null,
        reason: "lands after PR #305",
      }),
    ]);

    const landed = reduceRunEvents([
      ...base,
      at(6, "2026-09-17T14:13:00Z", {
        kind: "landed", outcome: "chunk-on-source", branch: "sandbar/chunk-177-c",
        target: "main", pullRequest: 305, title: "Migrations", members: [177],
        reason: null, durationMs: 60_000,
      }),
    ], { now: new Date("2026-09-17T14:13:30Z"), pidAlive: true });
    expect(landed.landing.map((request) => request.pullRequest)).toEqual([306]);
    expect(landed.landedChunks).toEqual([{
      pullRequest: 305, title: "Migrations", members: [177], target: "main",
      ms: 60_000, at: "2026-09-17T14:13:00Z",
    }]);
  });

  it("removes ended requests and timestamps a later request anew", () => {
    const requested = [
      at(1, "2026-09-17T13:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar",
        configPath: null, workdir: "/r", maxParallelIssues: 2, pid: 1,
      }),
      at(2, "2026-09-17T13:08:00Z", {
        kind: "recompute", n: 1, trigger: "poll", admitted: [], active: [],
        waiting: [], landRequests: ["sandbar/chunk-177-c"], deferredChunks: [],
        candidates: [], refs: [],
      }),
      at(3, "2026-09-17T13:08:01Z", {
        kind: "land-request", pullRequest: 305, branch: "sandbar/chunk-177-c",
        title: "Migrations", members: [177],
        status: { kind: "queued", reason: "lands next" },
      }),
    ];
    const noLongerLabelled = [
      ...requested,
      at(4, "2026-09-17T13:09:00Z", {
        kind: "recompute", n: 2, trigger: "poll", admitted: [], active: [],
        waiting: [], landRequests: [], deferredChunks: [], candidates: [], refs: [],
      }),
    ];
    expect(reduceRunEvents(noLongerLabelled, {
      now: new Date("2026-09-17T13:09:30Z"), pidAlive: true,
    }).landing).toEqual([]);

    const parked = [
      ...requested,
      at(4, "2026-09-17T13:09:00Z", {
        kind: "landed", outcome: "chunk-parked", branch: "sandbar/chunk-177-c",
        target: null, pullRequest: 305, title: "Migrations", members: [177],
        reason: "conflict", durationMs: 60_000,
      }),
    ];
    expect(reduceRunEvents(parked, {
      now: new Date("2026-09-17T13:09:30Z"), pidAlive: true,
    }).landing).toEqual([]);

    const requestedAgain = reduceRunEvents([
      ...parked,
      at(5, "2026-09-17T13:15:00Z", {
        kind: "recompute", n: 2, trigger: "poll", admitted: [], active: [],
        waiting: [], landRequests: ["sandbar/chunk-177-c"], deferredChunks: [],
        candidates: [], refs: [],
      }),
      at(6, "2026-09-17T13:15:01Z", {
        kind: "land-request", pullRequest: 305, branch: "sandbar/chunk-177-c",
        title: "Migrations", members: [177],
        status: { kind: "queued", reason: "lands next" },
      }),
    ], { now: new Date("2026-09-17T13:15:30Z"), pidAlive: true });
    expect(requestedAgain.landing).toEqual([
      expect.objectContaining({
        pullRequest: 305,
        requestedAt: "2026-09-17T13:15:01Z",
        statusSince: "2026-09-17T13:15:01Z",
      }),
    ]);
  });

  it("renders a historical parked ref with its recorded first-line cause", () => {
    const events: RunEvent[] = [
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar",
        configPath: null, workdir: "/r/.sandbar", maxParallelIssues: 1, pid: 10,
      }),
      at(2, "2026-09-07T09:01:00Z", {
        kind: "recompute", n: 1, trigger: "startup", admitted: [], active: [],
        waiting: [], landRequests: [], deferredChunks: [],
        candidates: [
          { issue: 87, title: "Nightly job", branch: "sandbar/issue-87-job",
            chunk: null, ready: false },
        ],
        refs: [{ issue: 87, branch: "sandbar/issue-87-job", tip: "abc" }],
      }),
    ];
    const previous = {
      issue: 87,
      title: "Nightly job",
      outcome: "HARD-ERROR",
      reason: "provider cause\n(codex exited with code 1)",
      attempts: 1,
      rounds: 0,
      ms: 10,
      landed: "",
      at: "2026-09-06T09:00:00Z",
    };
    const state = reduceRunEvents(events, {
      now: new Date("2026-09-07T09:02:00Z"),
      pidAlive: true,
      recentFinished: [previous],
    });

    expect(state.waiting).toEqual([{
      issue: 87,
      title: "Nightly job",
      why: "parked · HARD-ERROR · provider cause · before this run",
      parked: true,
    }]);
  });

  it("distinguishes a crash from an orderly end", () => {
    const start = at(1, "2026-09-07T09:00:00Z", {
      kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar", configPath: null,
      workdir: "/r/.sandbar", maxParallelIssues: 1, pid: 10,
    });
    expect(reduceRunEvents([start], { now: new Date(), pidAlive: false }).run.status)
      .toBe("crashed");
    const ended = at(2, "2026-09-07T10:00:00Z", { kind: "run-end", reason: "plan-empty" });
    expect(reduceRunEvents([start, ended], { now: new Date(), pidAlive: false }).run.status)
      .toBe("ended");
  });

  it("keeps DONE in the pool until its landing outcome is recorded", () => {
    const events: RunEvent[] = [
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar",
        configPath: null, workdir: "/r/.sandbar", maxParallelIssues: 1, pid: 10,
      }),
      at(2, "2026-09-07T09:01:00Z", {
        kind: "admitted", issue: 12, title: "Twelve",
        branch: "sandbar/issue-12-twelve", chunk: null, seedRef: "origin/main",
      }),
      at(3, "2026-09-07T09:30:00Z", {
        kind: "terminal", issue: 12, title: "Twelve", terminal: "DONE",
        reason: null, durationMs: 1_740_000,
      }),
    ];
    const duringLanding = reduceRunEvents(events, {
      now: new Date("2026-09-07T09:31:00Z"), pidAlive: true,
    });
    expect(duringLanding.pool).toHaveLength(1);
    expect(duringLanding.run.slots.used).toBe(0);
    expect(duringLanding.finished).toEqual([]);

    events.push(at(4, "2026-09-07T09:32:00Z", {
      kind: "landed", outcome: "merged", issue: 12, title: "Twelve",
      branch: "sandbar/issue-12-twelve", target: "main", reason: null,
    }));
    const landed = reduceRunEvents(events, {
      now: new Date("2026-09-07T09:32:00Z"), pidAlive: true,
    });
    expect(landed.pool).toEqual([]);
    expect(landed.finished[0]).toMatchObject({ issue: 12, outcome: "DONE", landed: "main" });
  });

  it("labels teardown 'finishing' until the terminal names the outcome", () => {
    const events: RunEvent[] = [
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar",
        configPath: null, workdir: "/r/.sandbar", maxParallelIssues: 1, pid: 10,
      }),
      at(2, "2026-09-07T09:01:00Z", {
        kind: "admitted", issue: 12, title: "Twelve",
        branch: "sandbar/issue-12-twelve", chunk: null, seedRef: "origin/main",
      }),
      at(3, "2026-09-07T09:02:00Z", { kind: "phase", issue: 12, attempt: 1, phases: ["implementer"] }),
      at(4, "2026-09-07T09:20:00Z", { kind: "phase", issue: 12, attempt: 1, phases: [] }),
    ];
    const tearingDown = reduceRunEvents(events, {
      now: new Date("2026-09-07T09:21:00Z"), pidAlive: true,
    });
    expect(tearingDown.pool[0]).toMatchObject({ phase: "finishing", phaseSince: "2026-09-07T09:20:00Z" });
    expect(tearingDown.run.slots.used).toBe(0);

    events.push(at(5, "2026-09-07T09:22:00Z", {
      kind: "terminal", issue: 12, title: "Twelve", terminal: "NEEDS-INFO",
      reason: null, durationMs: 1_200_000,
    }));
    const parked = reduceRunEvents(events, {
      now: new Date("2026-09-07T09:23:00Z"), pidAlive: true,
    });
    expect(parked.pool[0]).toMatchObject({ phase: "NEEDS-INFO" });
  });

  it("keeps a handoff visible until finalisation without occupying a slot", () => {
    const events = [
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar",
        configPath: null, workdir: "/r/.sandbar", maxParallelIssues: 1, pid: 10,
      }),
      at(2, "2026-09-07T09:01:00Z", {
        kind: "admitted", issue: 12, title: "Twelve",
        branch: "sandbar/issue-12", chunk: null, seedRef: "origin/main",
      }),
      at(3, "2026-09-07T09:30:00Z", {
        kind: "terminal", issue: 12, title: "Twelve", terminal: "NEEDS-INFO",
        reason: "Which environment?", durationMs: 1_740_000,
      }),
    ];
    const state = reduceRunEvents(events, {
      now: new Date("2026-09-07T09:31:00Z"), pidAlive: true,
    });
    expect(state.run.slots.used).toBe(0);
    expect(state.pool[0]).toMatchObject({ issue: 12, phase: "NEEDS-INFO" });
  });

  it("carries a terminal cause into finished and parked projections", () => {
    const events = [
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar",
        configPath: null, workdir: "/r/.sandbar", maxParallelIssues: 1, pid: 10,
      }),
      at(2, "2026-09-07T09:01:00Z", {
        kind: "admitted", issue: 12, title: "Twelve",
        branch: "sandbar/issue-12", chunk: null, seedRef: "origin/main",
      }),
      at(3, "2026-09-07T09:30:00Z", {
        kind: "terminal", issue: 12, title: "Twelve", terminal: "HARD-ERROR",
        reason: "provider cause\n(codex exited with code 1)", durationMs: 1_740_000,
      }),
      at(4, "2026-09-07T09:31:00Z", { kind: "run-end", reason: "stuck" }),
    ];
    const state = reduceRunEvents(events, {
      now: new Date("2026-09-07T09:32:00Z"), pidAlive: false,
    });
    expect(state.finished[0]).toMatchObject({
      outcome: "HARD-ERROR",
      reason: "provider cause\n(codex exited with code 1)",
    });
    expect(state.waiting[0]?.why).toBe("parked · HARD-ERROR · provider cause · this run");
  });

  it("clears a rejected issue task from the pool and occupied slots", () => {
    const events = [
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar",
        configPath: null, workdir: "/r/.sandbar", maxParallelIssues: 1, pid: 10,
      }),
      at(2, "2026-09-07T09:01:00Z", {
        kind: "admitted", issue: 12, title: "Twelve",
        branch: "sandbar/issue-12", chunk: null, seedRef: "origin/main",
      }),
      at(3, "2026-09-07T09:02:00Z", {
        kind: "phase", issue: 12, attempt: 1, phases: ["implementer"],
      }),
      at(4, "2026-09-07T09:03:00Z", {
        kind: "terminal", issue: 12, title: "Twelve", terminal: "REJECTED",
        reason: "event write failed", durationMs: 120_000,
      }),
    ];
    const state = reduceRunEvents(events, {
      now: new Date("2026-09-07T09:04:00Z"), pidAlive: true,
    });
    expect(state.run.slots.used).toBe(0);
    expect(state.pool).toEqual([]);
    expect(state.finished).toEqual([]);
    expect(state.events[0]).toMatchObject({ issue: 12, text: "REJECTED · event write failed" });
  });

  it("counts work across fresh HARD-ERROR cycles and keeps the newest finished record", () => {
    const start = at(1, "2026-09-07T09:00:00Z", {
      kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar",
      configPath: null, workdir: "/r/.sandbar", maxParallelIssues: 1, pid: 10,
    });
    const current = [
      start,
      at(2, "2026-09-07T09:01:00Z", { kind: "implementer", issue: 12, attempt: 1,
        signal: "COMPLETE", commits: 1, provider: "codex", model: "m", effort: null,
        durationMs: 1 }),
      at(3, "2026-09-07T09:02:00Z", { kind: "review-round", issue: 12, attempt: 1,
        round: 1, head: "a", quality: "APPROVED", qualityRounds: 0, gateOk: true,
        correctness: "APPROVED", rejectingPass: null,
        gateFailures: 0, correctnessFailures: 0, durationMs: 1 }),
      at(4, "2026-09-07T09:03:00Z", { kind: "hard-error", issue: 12, retry: 1, max: 2,
        reason: "lost stack" }),
      at(5, "2026-09-07T09:04:00Z", { kind: "implementer", issue: 12, attempt: 1,
        signal: "COMPLETE", commits: 1, provider: "codex", model: "m", effort: null,
        durationMs: 1 }),
      at(6, "2026-09-07T09:05:00Z", { kind: "review-round", issue: 12, attempt: 1,
        round: 1, head: "b", quality: "APPROVED", qualityRounds: 0, gateOk: true,
        correctness: "APPROVED", rejectingPass: null,
        gateFailures: 0, correctnessFailures: 0, durationMs: 1 }),
      at(7, "2026-09-07T09:06:00Z", { kind: "terminal", issue: 12, title: "Twelve",
        terminal: "DONE", reason: null, durationMs: 360_000 }),
      at(8, "2026-09-07T09:07:00Z", { kind: "landed", outcome: "merged", issue: 12,
        title: "Twelve", branch: "sandbar/issue-12", target: "main", reason: null }),
    ];
    const older = { issue: 12, title: "Old title", outcome: "NEEDS-HUMAN", reason: "old cause", attempts: 8,
      rounds: 7, ms: 999, landed: "", at: "2026-09-01T00:00:00Z" };
    const state = reduceRunEvents(current, {
      now: new Date("2026-09-07T09:08:00Z"), pidAlive: true, recentFinished: [older],
    });
    expect(state.finished).toEqual([expect.objectContaining({
      issue: 12, title: "Twelve", outcome: "DONE", attempts: 2, rounds: 2,
    })]);
  });

  it("shows fresh-sandbox setup immediately after a retried HARD-ERROR", () => {
    const events = [
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar",
        configPath: null, workdir: "/r/.sandbar", maxParallelIssues: 1, pid: 10,
      }),
      at(2, "2026-09-07T09:01:00Z", {
        kind: "admitted", issue: 12, title: "Twelve",
        branch: "sandbar/issue-12", chunk: null, seedRef: "origin/main",
      }),
      at(3, "2026-09-07T09:02:00Z", {
        kind: "phase", issue: 12, attempt: 3, phases: [],
      }),
      at(4, "2026-09-07T09:03:00Z", {
        kind: "hard-error", issue: 12, retry: 1, max: 2, reason: "stack failed",
      }),
    ];
    expect(reduceRunEvents(events, {
      now: new Date("2026-09-07T09:04:00Z"), pidAlive: true,
    }).pool[0]).toMatchObject({ phase: "setup", phaseSince: "2026-09-07T09:03:00Z", attempt: 1 });
  });

  it("does not report a skipped DONE as finished before finalisation", () => {
    const events: RunEvent[] = [
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar",
        configPath: null, workdir: "/r/.sandbar", maxParallelIssues: 1, pid: 10,
      }),
      at(2, "2026-09-07T09:01:00Z", {
        kind: "admitted", issue: 12, title: "Twelve",
        branch: "sandbar/issue-12-twelve", chunk: null, seedRef: "origin/main",
      }),
      at(3, "2026-09-07T09:30:00Z", {
        kind: "terminal", issue: 12, title: "Twelve", terminal: "DONE",
        reason: null, durationMs: 1_740_000,
      }),
      at(4, "2026-09-07T09:31:00Z", {
        kind: "landed", outcome: "skipped", issue: 12, title: "Twelve",
        branch: "sandbar/issue-12-twelve", target: null, reason: "silent-noop",
      }),
    ];
    const pending = reduceRunEvents(events, {
      now: new Date("2026-09-07T09:31:00Z"), pidAlive: true,
    });
    expect(pending.pool[0]).toMatchObject({ issue: 12, phase: "finalising" });
    expect(pending.finished).toEqual([]);

    events.push(at(5, "2026-09-07T09:32:00Z", {
      kind: "finalise", issue: 12, title: "Twelve",
      finaliseKind: "fresh-attempt", outcome: "deleted local branch",
    }));
    const retried = reduceRunEvents(events, {
      now: new Date("2026-09-07T09:32:00Z"), pidAlive: true,
    });
    expect(retried.pool[0]).toMatchObject({ issue: 12, phase: "setup" });
    expect(retried.finished).toEqual([]);
  });

  it("turns a finalised merger skip into a human handoff", () => {
    const events: RunEvent[] = [
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar",
        configPath: null, workdir: "/r/.sandbar", maxParallelIssues: 1, pid: 10,
      }),
      at(2, "2026-09-07T09:01:00Z", {
        kind: "admitted", issue: 12, title: "Twelve",
        branch: "sandbar/issue-12-twelve", chunk: null, seedRef: "origin/main",
      }),
      at(3, "2026-09-07T09:30:00Z", {
        kind: "terminal", issue: 12, title: "Twelve", terminal: "DONE",
        reason: null, durationMs: 1_740_000,
      }),
      at(4, "2026-09-07T09:31:00Z", {
        kind: "landed", outcome: "skipped", issue: 12, title: "Twelve",
        branch: "sandbar/issue-12-twelve", target: null, reason: "gate-red",
      }),
      at(5, "2026-09-07T09:32:00Z", {
        kind: "finalise", issue: 12, title: "Twelve",
        finaliseKind: "merge-gate-red", outcome: "pushed branch",
      }),
    ];
    const state = reduceRunEvents(events, {
      now: new Date("2026-09-07T09:32:00Z"), pidAlive: true,
    });
    expect(state.pool).toEqual([]);
    expect(state.finished[0]).toMatchObject({
      issue: 12, outcome: "NEEDS-HUMAN", landed: "",
    });
  });
});

// #202: a refusal is a warning in the feed, never a header complaint.
describe("egress feed rows (#202)", () => {
  it("shows each refusal and a proxy's summary, and complains about neither", () => {
    const rows = [
      { kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "d", configPath: null,
        workdir: "/w", maxParallelIssues: 1, pid: 1 },
      { kind: "egress-refused", stack: "sandbox", issue: 7, title: "Seven",
        host: "evil.example", port: 443, via: "tls", enforced: true },
      { kind: "egress-refused", stack: "gate", host: "cdn.example", port: null,
        via: "dns", enforced: false },
      { kind: "egress", stack: "sandbox", issue: 7, title: "Seven", mode: "enforce",
        allowed: { "api.anthropic.com:443": 3 }, refused: { "evil.example:443": 2 },
        upstreamErrors: {}, durationMs: 5, peakMemoryBytes: 1000 },
    ];
    const state = reduceRunEvents(
      rows.map((row, i) => at(i + 1, `2026-10-28T09:0${i}:00Z`, row)),
      { now: new Date("2026-10-28T10:00:00Z"), pidAlive: false },
    );
    expect(state.events.map((e) => [e.issue, e.text, e.tone, e.peakMemoryBytes])).toEqual([
      [7, "sandbox egress proxy stopped · 1 destination refused", "dim", 1000],
      [null, "gate egress would refuse cdn.example (dns)", "warn", undefined],
      [7, "sandbox egress refused evil.example:443 (tls)", "warn", undefined],
      [null, "run started", "dim", undefined],
    ]);
    expect(state.run.complaints).toEqual([]);
  });
});

describe("janitor runner feed rows (#205)", () => {
  it("shows a run's start and its outcome as feed lines, never as an issue", () => {
    const events = [
      at(1, "2026-10-28T08:00:00Z", {
        kind: "run-start", schemaVersion: EVENT_SCHEMA_VERSION, driver: "sandbar", configPath: null,
        workdir: "/r", maxParallelIssues: 2, pid: 1,
      }),
      at(2, "2026-10-28T08:01:00Z", {
        kind: "janitor-start", task: "tidy", branch: "sandbar/janitor-tidy", base: "b".repeat(40),
        fresh: true, scope: ["a.ts", "b.ts"], runsToday: 1, runsPerDay: 4,
      }),
      at(3, "2026-10-28T08:30:00Z", {
        kind: "janitor-run", task: "tidy", branch: "sandbar/janitor-tidy", outcome: "committed",
        commits: 2, pullRequest: 12, scope: ["a.ts", "b.ts"], durationMs: 5,
      }),
      at(4, "2026-10-28T09:30:00Z", {
        kind: "janitor-run", task: "tidy", branch: "sandbar/janitor-tidy", outcome: "rejected",
        cause: "stack-change", scope: ["c.ts"], durationMs: 5,
      }),
    ];
    const live = reduceRunEvents(events, { now: new Date("2026-10-28T09:31:00Z"), pidAlive: true });

    expect(live.events.slice(0, 3).map(({ text, tone }) => ({ text, tone }))).toEqual([
      { text: "janitor tidy rejected · stack-change", tone: "dim" },
      { text: "janitor tidy committed · PR #12", tone: "good" },
      { text: "janitor tidy started · 2 path(s) · run 1 of 4 today", tone: "dim" },
    ]);
    expect(live.pool).toEqual([]);
    expect(live.finished).toEqual([]);
  });
});
