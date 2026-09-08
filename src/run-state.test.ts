import { describe, expect, it } from "vitest";
import type { RunEvent } from "./events.js";
import { reduceRunEvents, waitingReasonText } from "./run-state.js";

const at = (seq: number, ts: string, event: object): RunEvent =>
  ({ seq, ts, ...event }) as RunEvent;

describe("run event reducer", () => {
  it("renders excluded label actors in the waiting list", () => {
    expect(waitingReasonText({ kind: "label-actor", actor: "mallory" }))
      .toBe("excluded: ready-for-agent applied by @mallory");
    expect(waitingReasonText({ kind: "label-actor", actor: null }))
      .toBe("excluded: ready-for-agent label actor unknown");
  });

  it("projects every event kind into a newest-first, attributed feed", () => {
    const rows: object[] = [
      { kind: "run-start", schemaVersion: 2, driver: "sandbar", configPath: null,
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
      { kind: "complaint", severity: "warning", message: "stale config" },
      { kind: "admitted", issue: 2, title: "Two", branch: "sandbar/issue-2", chunk: null,
        seedRef: "origin/main" },
      { kind: "origin-sync", issue: 2, outcome: "abandoned", detail: "branch abandoned" },
      { kind: "phase", issue: 2, attempt: 1, phases: ["implementer"] },
      { kind: "setup", issue: 2, durationMs: 3 },
      { kind: "ui-check", issue: 2, invocation: 1, provider: "codex", model: "m",
        effort: null, durationMs: 4, result: "CLEAR" },
      { kind: "implementer", issue: 2, attempt: 1, signal: "COMPLETE", commits: 1,
        provider: "codex", model: "m", effort: null, durationMs: 5 },
      { kind: "gate", issue: 2, attempt: 1, gate: "gate-1", ok: true, durationMs: 6 },
      { kind: "review-pass", issue: 2, attempt: 1, round: 1, pass: "quality", invocation: 1,
        provider: "codex", model: "m", effort: null, result: "completed", durationMs: 7 },
      { kind: "review-round", issue: 2, attempt: 1, round: 1, head: "abc",
        qualityMode: "list", gateOk: true, quality: "APPROVED", correctness: "APPROVED",
        rejectingPass: null, qualityFailures: 0, correctnessFailures: 0, durationMs: 8 },
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
      [2, "round 1 · quality pass · invocation 1", ""],
      [2, "gate-1 passed", "good"],
      [2, "attempt 1 complete · 1 commit", ""],
      [2, "UI check 1 · CLEAR", "dim"],
      [2, "setup complete · 3ms", "dim"],
      [2, "phase · implementer", "dim"],
      [2, "origin sync · branch abandoned", "dim"],
      [2, "admitted #2", "dim"],
      [null, "stale config", "warn"],
      [null, "reconcile trace · checked chunks", "dim"],
      [null, "requeued #2", "dim"],
      [null, "recompute 1 · launch", "dim"],
      [null, "landing batch 1 complete · 9ms", "dim"],
      [null, "image built · base", "dim"],
      [null, "startup sweep · 1 removed · 0 failed", "dim"],
      [null, "preflight started · Preflight started", "dim"],
      [null, "wake lock held", "dim"],
      [null, "run started", "dim"],
    ]);
    expect(state.run.complaints).toEqual([{ severity: "warning", text: "stale config" }]);
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
        kind: "run-start", schemaVersion: 1, driver: "sandbar", configPath: null,
        workdir: "/r", maxParallelIssues: 1, pid: 1,
      }),
      at(2, "2026-09-07T09:01:00Z", event),
    ], { now: new Date("2026-09-07T09:02:00Z"), pidAlive: true });
    expect(state.events[0]?.text).toBe(expected);
  });

  it("limits recent feed rows to 200 without changing the total", () => {
    const events = [at(1, "2026-09-07T09:00:00Z", {
      kind: "run-start", schemaVersion: 2, driver: "sandbar", configPath: null,
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
        kind: "run-start", schemaVersion: 2, driver: "sandbar 0.36.0",
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
        kind: "phase", issue: 102, title: "Capacity error", attempt: 1, phases: ["gate-1", "review"],
      }),
      at(5, "2026-09-07T09:21:00Z", {
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
    expect(state.pool[0]).toMatchObject({ issue: 102, phase: "gate-1 + review", attempt: 1 });
    expect(state.pool[0]?.spans).toEqual([
      { kind: "impl", from: "2026-09-07T09:02:00Z", to: "2026-09-07T09:20:00Z", label: "a1" },
      { kind: "review", from: "2026-09-07T09:20:00Z", to: null, label: "gate + review" },
    ]);
    expect(state.waiting).toEqual([
      { issue: 87, title: "Nightly job", why: "parked · unknown terminal · before this run", parked: true },
      { issue: 104, title: "Picker", why: "blocked by #102" },
      { issue: 111, title: "Export", why: "no free slot" },
    ]);
  });

  it("renders a historical parked ref with its recorded first-line cause", () => {
    const events: RunEvent[] = [
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: 1, driver: "sandbar",
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
      kind: "run-start", schemaVersion: 2, driver: "sandbar", configPath: null,
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
        kind: "run-start", schemaVersion: 2, driver: "sandbar",
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
        kind: "run-start", schemaVersion: 2, driver: "sandbar",
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
        kind: "run-start", schemaVersion: 2, driver: "sandbar",
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
        kind: "run-start", schemaVersion: 1, driver: "sandbar",
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
        kind: "run-start", schemaVersion: 2, driver: "sandbar",
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
      kind: "run-start", schemaVersion: 2, driver: "sandbar",
      configPath: null, workdir: "/r/.sandbar", maxParallelIssues: 1, pid: 10,
    });
    const current = [
      start,
      at(2, "2026-09-07T09:01:00Z", { kind: "implementer", issue: 12, attempt: 1,
        signal: "COMPLETE", commits: 1, provider: "codex", model: "m", effort: null,
        durationMs: 1 }),
      at(3, "2026-09-07T09:02:00Z", { kind: "review-round", issue: 12, attempt: 1,
        round: 1, head: "a", qualityMode: "list", gateOk: true, quality: "APPROVED",
        correctness: "APPROVED", rejectingPass: null, qualityFailures: 0,
        correctnessFailures: 0, durationMs: 1 }),
      at(4, "2026-09-07T09:03:00Z", { kind: "hard-error", issue: 12, retry: 1, max: 2,
        reason: "lost stack" }),
      at(5, "2026-09-07T09:04:00Z", { kind: "implementer", issue: 12, attempt: 1,
        signal: "COMPLETE", commits: 1, provider: "codex", model: "m", effort: null,
        durationMs: 1 }),
      at(6, "2026-09-07T09:05:00Z", { kind: "review-round", issue: 12, attempt: 1,
        round: 1, head: "b", qualityMode: "list", gateOk: true, quality: "APPROVED",
        correctness: "APPROVED", rejectingPass: null, qualityFailures: 0,
        correctnessFailures: 0, durationMs: 1 }),
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
        kind: "run-start", schemaVersion: 2, driver: "sandbar",
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
        kind: "run-start", schemaVersion: 2, driver: "sandbar",
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
        kind: "run-start", schemaVersion: 2, driver: "sandbar",
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
