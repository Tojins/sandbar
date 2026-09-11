import { describe, expect, it, vi } from "vitest";
import {
  ContinuousPool,
  decideAfterFailedRefresh,
  decideSchedulerAction,
  type SchedulerSnapshot,
} from "./scheduler.js";

type Issue = { id: string };
const issue = (id: string): Issue => ({ id });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("continuous pool", () => {
  it("never exceeds its width and starts each issue once", () => {
    const pool = new ContinuousPool<Issue, string>(2, (i) => i.id);
    const first = pool.admit([issue("3"), issue("1"), issue("2")]);
    expect(first.map((i) => i.id)).toEqual(["3", "1"]);
    const jobs = first.map(() => deferred<string>());
    first.forEach((item, i) => pool.start(item, jobs[i]!.promise));
    expect(pool.admit([issue("3"), issue("2")])).toEqual([]);
    expect(pool.activeCount).toBe(2);
  });

  it("rejection frees a slot and admits the next candidate", async () => {
    const pool = new ContinuousPool<Issue, string>(1, (i) => i.id);
    const first = pool.admit([issue("1")])[0]!;
    const job = deferred<string>();
    pool.start(first, job.promise);
    job.reject(new Error("boom"));
    expect((await pool.waitForFreedSlot())[0]?.status).toBe("rejected");
    expect(pool.admit([issue("2")]).map((i) => i.id)).toEqual(["2"]);
  });

  it("refills before yielding a deterministic landing batch", async () => {
    const pool = new ContinuousPool<Issue, string>(3, (i) => i.id);
    const admitted = pool.admit([issue("10"), issue("2"), issue("7")]);
    const jobs = admitted.map(() => deferred<string>());
    admitted.forEach((item, i) => pool.start(item, jobs[i]!.promise));
    jobs[0]!.resolve("ten"); jobs[1]!.resolve("two");
    await Promise.resolve(); await Promise.resolve();
    await pool.waitForFreedSlot();
    expect(pool.hasCompleted).toBe(false);
    expect(pool.admit([issue("8")]).map((i) => i.id)).toEqual(["8"]);
    expect(pool.takeLandingBatch().map((event) => event.issue.id)).toEqual(["2", "10"]);
  });

  it("serves a silent-noop retry ahead of candidates", () => {
    const pool = new ContinuousPool<Issue, string>(1, (i) => i.id);
    const target = pool.admit([issue("4")])[0]!;
    pool.retry(target);
    const retry = pool.admit([]);
    expect(retry).toEqual([target]);
  });

  it("resets the terminal backstop only when work lands", () => {
    const pool = new ContinuousPool<Issue, string>(1, (i) => i.id);
    pool.recordLandingOutcome(2, 0);
    pool.recordLandingOutcome(3, 0);
    expect(pool.noProgressSinceLanding).toBe(5);
    pool.recordLandingOutcome(1, 2);
    expect(pool.noProgressSinceLanding).toBe(0);
  });

  it("does not count an unchanged landing deferral as progress or failure", () => {
    const pool = new ContinuousPool<Issue, string>(1, (i) => i.id);
    pool.recordLandingOutcome(0, 0);
    expect(pool.noProgressSinceLanding).toBe(0);
    pool.recordLandingOutcome(0, 1);
    expect(pool.noProgressSinceLanding).toBe(0);
  });

  it("makes a terminal issue eligible again at the next poll", () => {
    const pool = new ContinuousPool<Issue, string>(1, (i) => i.id);
    const target = pool.admit([issue("4")])[0]!;
    pool.finishTerminal(target);
    expect(pool.admit([target])).toEqual([]);
    pool.beginPoll();
    expect(pool.admit([target])).toEqual([target]);
  });

  it("wakes an empty pool from the poll timer and a full pool from its slot", async () => {
    vi.useFakeTimers();
    try {
      const idle = new ContinuousPool<Issue, string>(1, (i) => i.id);
      const pollWake = idle.waitForWake(100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(pollWake).resolves.toBe("poll");

      const busy = new ContinuousPool<Issue, string>(1, (i) => i.id);
      const target = busy.admit([issue("7")])[0]!;
      const job = deferred<string>();
      busy.start(target, job.promise);
      const slotWake = busy.waitForWake(100);
      job.resolve("done");
      await expect(slotWake).resolves.toBe("slot-freed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("races both wake sources while the pool is partially occupied", async () => {
    vi.useFakeTimers();
    try {
      const pollFirst = new ContinuousPool<Issue, string>(2, (i) => i.id);
      const hung = deferred<string>();
      const first = pollFirst.admit([issue("1")])[0]!;
      pollFirst.start(first, hung.promise);
      const pollWake = pollFirst.waitForWake(100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(pollWake).resolves.toBe("poll");

      // A poll winner withdraws its completion subscription. Prove that while
      // the original task is still hung by arming another poll wait: a stale
      // waiter would make this throw "pool already has an active wake wait".
      const nextPollWake = pollFirst.waitForWake(100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(nextPollWake).resolves.toBe("poll");

      const slotFirst = new ContinuousPool<Issue, string>(2, (i) => i.id);
      const completing = deferred<string>();
      const second = slotFirst.admit([issue("2")])[0]!;
      slotFirst.start(second, completing.promise);
      const slotWake = slotFirst.waitForWake(100);
      completing.resolve("done");
      await expect(slotWake).resolves.toBe("slot-freed");
      expect(vi.getTimerCount()).toBe(0);

      // Settling the old task is observed only by a fresh wait, not by a
      // callback retained from either completed poll race.
      hung.resolve("late");
      await Promise.resolve();
      await expect(pollFirst.waitForWake(100)).resolves.toBe("slot-freed");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scheduler decisions", () => {
  const snapshot = (overrides: Partial<SchedulerSnapshot> = {}): SchedulerSnapshot => ({
    active: 0, ongoing: 0, hasCompleted: false, hasPendingTerminals: false,
    hasCandidates: false, hasRetries: false, hasLandRequests: false, hasCapacity: true,
    noProgressSinceLanding: 0,
    noProgressBackstop: 6, providerClosed: false, restartRequested: false, ...overrides,
  });

  // Every row names the WHOLE action, reason included: the exit tags are the
  // precedence the header states, and a row that only checked `kind` would
  // pass with quota and stuck swapped.
  it.each([
    ["recompute", snapshot({ hasCompleted: true, active: 1, ongoing: 1 }), { kind: "recompute" }],
    ["land pending terminals", snapshot({ hasPendingTerminals: true, ongoing: 1 }), { kind: "land" }],
    ["provider closure lands first", snapshot({ providerClosed: true, hasPendingTerminals: true, ongoing: 1 }), { kind: "land" }],
    ["provider closure drains", snapshot({ providerClosed: true, active: 1, ongoing: 1 }), { kind: "drain" }],
    ["provider closure exits", snapshot({ providerClosed: true }), { kind: "exit", reason: "provider-closed" }],
    ["provider closure outranks stuck", snapshot({ providerClosed: true, noProgressSinceLanding: 6 }), { kind: "exit", reason: "provider-closed" }],
    ["provider closure outranks admission", snapshot({ providerClosed: true, hasCandidates: true }), { kind: "exit", reason: "provider-closed" }],
    ["restart lands pending terminals first", snapshot({ restartRequested: true, hasPendingTerminals: true, ongoing: 1 }), { kind: "land" }],
    ["restart lands an outstanding land request", snapshot({ restartRequested: true, hasLandRequests: true }), { kind: "land" }],
    ["restart drains running work", snapshot({ restartRequested: true, active: 1, ongoing: 1 }), { kind: "drain" }],
    ["restart exits when idle", snapshot({ restartRequested: true }), { kind: "exit", reason: "restart" }],
    ["restart outranks admission", snapshot({ restartRequested: true, hasCandidates: true }), { kind: "exit", reason: "restart" }],
    ["restart outranks provider closure", snapshot({ restartRequested: true, providerClosed: true }), { kind: "exit", reason: "restart" }],
    ["restart outranks stuck", snapshot({ restartRequested: true, noProgressSinceLanding: 6 }), { kind: "exit", reason: "restart" }],
    ["a completion still outranks restart", snapshot({ restartRequested: true, hasCompleted: true, active: 1, ongoing: 1 }), { kind: "recompute" }],
    ["stuck exits", snapshot({ noProgressSinceLanding: 6 }), { kind: "exit", reason: "stuck" }],
    ["stuck outranks admission", snapshot({ noProgressSinceLanding: 6, hasCandidates: true }), { kind: "exit", reason: "stuck" }],
    ["stuck drains on every observation, not at quiescence", snapshot({ noProgressSinceLanding: 6, active: 3, ongoing: 3, hasCandidates: true }), { kind: "drain" }],
    ["stuck lands first", snapshot({ noProgressSinceLanding: 6, ongoing: 1, hasPendingTerminals: true }), { kind: "land" }],
    ["admits at post-landing quiescence", snapshot({ hasCandidates: true }), { kind: "admit", next: "wait" }],
    ["admits a retry", snapshot({ hasRetries: true, ongoing: 1 }), { kind: "admit", next: "wait" }],
    ["refill before landing", snapshot({ hasPendingTerminals: true, hasCandidates: true, ongoing: 1 }), { kind: "admit", next: "land" }],
    ["no capacity: wait", snapshot({ active: 1, ongoing: 1, hasCapacity: false }), { kind: "wait" }],
    ["full pool with a land request waits", snapshot({ active: 1, ongoing: 1, hasCapacity: false, hasLandRequests: true }), { kind: "wait" }],
    ["land request with nothing running lands", snapshot({ hasLandRequests: true }), { kind: "land" }],
    ["idle waits for the poll", snapshot(), { kind: "wait" }],
  ] as const)("%s", (_name, state, action) => {
    expect(decideSchedulerAction(state)).toEqual(action);
  });

  // A failed refresh ordinarily retries, and the deploy is the one thing that
  // cannot afford it: an emptied pool's only wake is the poll timer, so a fetch
  // that stays broken would otherwise hold the restart exit forever (#146).
  it.each([
    ["no restart: retry", snapshot(), { kind: "wait" }],
    ["no restart, nothing running: still a retry", snapshot({ noProgressSinceLanding: 6, providerClosed: true }), { kind: "wait" }],
    ["a drained restart exits without the refs", snapshot({ restartRequested: true }), { kind: "exit", reason: "restart" }],
    ["restart with a slot still held retries", snapshot({ restartRequested: true, active: 1, ongoing: 1 }), { kind: "wait" }],
    ["restart with work still ongoing retries", snapshot({ restartRequested: true, ongoing: 1 }), { kind: "wait" }],
    ["restart with a terminal still to land retries", snapshot({ restartRequested: true, hasPendingTerminals: true }), { kind: "wait" }],
    ["an outstanding land request could not land on refs this poll lacks", snapshot({ restartRequested: true, hasLandRequests: true }), { kind: "exit", reason: "restart" }],
  ] as const)("failed poll refresh: %s", (_name, state, action) => {
    expect(decideAfterFailedRefresh(state)).toEqual(action);
  });
});
