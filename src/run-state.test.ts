import { describe, expect, it } from "vitest";
import type { RunEvent } from "./events.js";
import { reduceRunEvents } from "./run-state.js";

const at = (seq: number, ts: string, event: object): RunEvent =>
  ({ seq, ts, ...event }) as RunEvent;

describe("run event reducer", () => {
  it("renders pool timelines, waiting reasons and parked refs from one recompute", () => {
    const events: RunEvent[] = [
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: 1, driver: "sandbar 0.36.0",
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

  it("distinguishes a crash from an orderly end", () => {
    const start = at(1, "2026-09-07T09:00:00Z", {
      kind: "run-start", schemaVersion: 1, driver: "sandbar", configPath: null,
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
        kind: "run-start", schemaVersion: 1, driver: "sandbar",
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

  it("does not report a skipped DONE as finished before finalisation", () => {
    const events: RunEvent[] = [
      at(1, "2026-09-07T09:00:00Z", {
        kind: "run-start", schemaVersion: 1, driver: "sandbar",
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
        kind: "run-start", schemaVersion: 1, driver: "sandbar",
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
