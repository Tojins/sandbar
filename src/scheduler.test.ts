import { describe, expect, it, vi } from "vitest";
import {
  chunkRefreshRequestsAreRunnable,
  ContinuousPool,
  decideAfterFailedRefresh,
  decideSchedulerAction,
  restartDueReason,
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

  it("keeps a held terminal ongoing but out of landing until released (#244)", async () => {
    const pool = new ContinuousPool<Issue, string>(2, (i) => i.id);
    const admitted = pool.admit([issue("1"), issue("2")]);
    admitted.forEach((item, i) => pool.start(item, Promise.resolve(i === 0 ? "held" : "lands")));
    await pool.waitForFreedSlot();
    await pool.waitForFreedSlot();

    const held = pool.holdTerminals((event) =>
      event.status === "fulfilled" && event.value === "held"
    );
    expect(held.map((event) => event.issue.id)).toEqual(["1"]);
    expect(pool.holdTerminals(() => true).map((event) => event.issue.id)).toEqual(["2"]);
    expect(pool.hasPendingTerminals).toBe(false);
    expect(pool.takeLandingBatch()).toEqual([]);
    expect(pool.ongoingCount).toBe(2);
    expect(pool.admit([issue("1"), issue("2")])).toEqual([]);

    pool.releaseHeldTerminals();
    expect(pool.hasPendingTerminals).toBe(true);
    expect(pool.takeLandingBatch().map((event) => event.issue.id)).toEqual(["1", "2"]);
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
    hasCandidates: false, hasRetries: false, hasLandRequests: false,
    hasChunkRefreshRequests: false, hasCapacity: true,
    noProgressSinceLanding: 0,
    noProgressBackstop: 6, providerClosed: false, restartDue: false,
    storageLow: false, ...overrides,
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
    ["restart lands pending terminals first", snapshot({ restartDue: true, hasPendingTerminals: true, ongoing: 1 }), { kind: "land" }],
    ["restart lands an outstanding land request", snapshot({ restartDue: true, hasLandRequests: true }), { kind: "land" }],
    ["restart ignores a chunk refresh request", snapshot({ restartDue: true, hasChunkRefreshRequests: true }), { kind: "exit", reason: "restart" }],
    ["restart drains running work", snapshot({ restartDue: true, active: 1, ongoing: 1 }), { kind: "drain" }],
    ["restart exits when idle", snapshot({ restartDue: true }), { kind: "exit", reason: "restart" }],
    ["restart outranks admission", snapshot({ restartDue: true, hasCandidates: true }), { kind: "exit", reason: "restart" }],
    ["restart outranks provider closure", snapshot({ restartDue: true, providerClosed: true }), { kind: "exit", reason: "restart" }],
    ["restart outranks stuck", snapshot({ restartDue: true, noProgressSinceLanding: 6 }), { kind: "exit", reason: "restart" }],
    ["restart outranks low storage", snapshot({ restartDue: true, storageLow: true }), { kind: "exit", reason: "restart" }],
    ["a completion still outranks restart", snapshot({ restartDue: true, hasCompleted: true, active: 1, ongoing: 1 }), { kind: "recompute" }],
    ["low storage lands pending terminals", snapshot({ storageLow: true, hasPendingTerminals: true, ongoing: 1 }), { kind: "land" }],
    ["low storage drains running work", snapshot({ storageLow: true, active: 1, ongoing: 1, hasCandidates: true }), { kind: "drain" }],
    ["low storage exits when drained", snapshot({ storageLow: true }), { kind: "exit", reason: "storage-low" }],
    ["low storage does not start a fresh land request", snapshot({ storageLow: true, hasLandRequests: true }), { kind: "exit", reason: "storage-low" }],
    ["low storage does not start a chunk refresh", snapshot({ storageLow: true, hasChunkRefreshRequests: true }), { kind: "exit", reason: "storage-low" }],
    ["low storage outranks provider closure", snapshot({ storageLow: true, providerClosed: true }), { kind: "exit", reason: "storage-low" }],
    ["stuck exits", snapshot({ noProgressSinceLanding: 6 }), { kind: "exit", reason: "stuck" }],
    ["stuck outranks admission", snapshot({ noProgressSinceLanding: 6, hasCandidates: true }), { kind: "exit", reason: "stuck" }],
    ["stuck drains on every observation, not at quiescence", snapshot({ noProgressSinceLanding: 6, active: 3, ongoing: 3, hasCandidates: true }), { kind: "drain" }],
    ["stuck lands first", snapshot({ noProgressSinceLanding: 6, ongoing: 1, hasPendingTerminals: true }), { kind: "land" }],
    ["admits at post-landing quiescence", snapshot({ hasCandidates: true }), { kind: "admit", next: "wait" }],
    ["admits a retry", snapshot({ hasRetries: true, ongoing: 1 }), { kind: "admit", next: "wait" }],
    ["refill before landing", snapshot({ hasPendingTerminals: true, hasCandidates: true, ongoing: 1 }), { kind: "admit", next: "land" }],
    ["refill before a requested landing", snapshot({ hasLandRequests: true, hasCandidates: true, active: 1, ongoing: 1 }), { kind: "admit", next: "land" }],
    ["refill before a chunk refresh", snapshot({ hasChunkRefreshRequests: true, hasCandidates: true, active: 1, ongoing: 1 }), { kind: "admit", next: "land" }],
    ["no capacity: wait", snapshot({ active: 1, ongoing: 1, hasCapacity: false }), { kind: "wait" }],
    ["full pool with a land request lands", snapshot({ active: 1, ongoing: 1, hasCapacity: false, hasLandRequests: true }), { kind: "land" }],
    ["land request with nothing running lands", snapshot({ hasLandRequests: true }), { kind: "land" }],
    ["chunk refresh with nothing running lands", snapshot({ hasChunkRefreshRequests: true }), { kind: "land" }],
    ["idle waits for the poll", snapshot(), { kind: "wait" }],
  ] as const)("%s", (_name, state, action) => {
    expect(decideSchedulerAction(state)).toEqual(action);
  });

  it.each([
    ["ordinary planning", snapshot({ hasChunkRefreshRequests: true }), true],
    ["low-storage drain", snapshot({ hasChunkRefreshRequests: true, storageLow: true }), false],
    ["no-progress drain", snapshot({ hasChunkRefreshRequests: true, noProgressSinceLanding: 6 }), false],
  ] as const)("chunk refresh runnable during %s: %s", (_name, state, runnable) => {
    expect(chunkRefreshRequestsAreRunnable(state)).toBe(runnable);
  });

  // A failed refresh ordinarily retries, and the deploy is the one thing that
  // cannot afford it: an emptied pool's only wake is the poll timer, so a fetch
  // that stays broken would otherwise hold the restart exit forever (#146).
  it.each([
    ["no restart: retry", snapshot(), { kind: "wait" }],
    ["no restart, nothing running: still a retry", snapshot({ noProgressSinceLanding: 6, providerClosed: true }), { kind: "wait" }],
    ["a drained restart exits without the refs", snapshot({ restartDue: true }), { kind: "exit", reason: "restart" }],
    ["restart with a slot still held retries", snapshot({ restartDue: true, active: 1, ongoing: 1 }), { kind: "wait" }],
    ["restart with work still ongoing retries", snapshot({ restartDue: true, ongoing: 1 }), { kind: "wait" }],
    ["restart with a terminal still to land retries", snapshot({ restartDue: true, hasPendingTerminals: true }), { kind: "wait" }],
    ["an outstanding land request could not land on refs this poll lacks", snapshot({ restartDue: true, hasLandRequests: true }), { kind: "exit", reason: "restart" }],
  ] as const)("failed poll refresh: %s", (_name, state, action) => {
    expect(decideAfterFailedRefresh(state)).toEqual(action);
  });
  // A deploy waits for the pool unless waiting costs more than it saves: every
  // landing on this repo is a deploy, and draining for each one emptied every
  // slot once per landed issue.
  const request = (overrides: Partial<Parameters<typeof restartDueReason>[0]> = {}) => ({
    urgent: false, ageMs: 0, deferMs: 7_200_000,
    active: 2, ongoing: 3, hasPendingTerminals: false, ...overrides,
  });
  it.each([
    ["a fresh request on a busy pool waits", request(), null],
    ["just short of the deferral waits", request({ ageMs: 7_199_999 }), null],
    ["the deferral elapsed", request({ ageMs: 7_200_000 }), "deferral-elapsed"],
    ["no deferral configured", request({ deferMs: 0 }), "deferral-elapsed"],
    ["an urgent request", request({ urgent: true }), "urgent"],
    ["urgency names itself even when the deferral elapsed", request({ urgent: true, ageMs: 9e9 }), "urgent"],
    ["an empty pool has nothing to drain", request({ active: 0, ongoing: 0 }), "idle"],
    ["a DONE issue waiting to land is not idle", request({ active: 0, ongoing: 1 }), null],
    ["a pending terminal is not idle", request({ active: 0, ongoing: 0, hasPendingTerminals: true }), null],
  ] as const)("restart due: %s", (_name, state, reason) => {
    expect(restartDueReason(state)).toBe(reason);
  });
});
