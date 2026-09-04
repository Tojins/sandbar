import { describe, expect, it } from "vitest";
import { ContinuousPool, decideSchedulerAction, type SchedulerSnapshot } from "./scheduler.js";

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
    const first = pool.admit([issue("3"), issue("1"), issue("2")], 10);
    expect(first.issues.map((i) => i.id)).toEqual(["3", "1"]);
    const jobs = first.issues.map(() => deferred<string>());
    first.issues.forEach((item, i) => pool.start(item, jobs[i]!.promise));
    expect(pool.admit([issue("3"), issue("2")], 10).issues).toEqual([]);
    expect(pool.activeCount).toBe(2);
  });

  it("rejection frees a slot and admits the next candidate", async () => {
    const pool = new ContinuousPool<Issue, string>(1, (i) => i.id);
    const first = pool.admit([issue("1")], 10).issues[0]!;
    const job = deferred<string>();
    pool.start(first, job.promise);
    job.reject(new Error("boom"));
    expect((await pool.waitForFreedSlot())[0]?.status).toBe("rejected");
    expect(pool.admit([issue("2")], 10).issues.map((i) => i.id)).toEqual(["2"]);
  });

  it("refills before yielding a deterministic landing batch", async () => {
    const pool = new ContinuousPool<Issue, string>(3, (i) => i.id);
    const admitted = pool.admit([issue("10"), issue("2"), issue("7")], 10).issues;
    const jobs = admitted.map(() => deferred<string>());
    admitted.forEach((item, i) => pool.start(item, jobs[i]!.promise));
    jobs[0]!.resolve("ten"); jobs[1]!.resolve("two");
    await Promise.resolve(); await Promise.resolve();
    await pool.waitForFreedSlot();
    expect(pool.hasCompleted).toBe(false);
    expect(pool.admit([issue("8")], 10).issues.map((i) => i.id)).toEqual(["8"]);
    expect(pool.takeLandingBatch().map((event) => event.issue.id)).toEqual(["2", "10"]);
  });

  it("retries without counting a second start", () => {
    const pool = new ContinuousPool<Issue, string>(1, (i) => i.id);
    const target = pool.admit([issue("4")], 1).issues[0]!;
    pool.retry(target);
    const retry = pool.admit([], 0);
    expect(retry.issues).toEqual([target]);
    expect(retry.newStarts).toBe(0);
  });

  it("resets the terminal backstop only when work lands", () => {
    const pool = new ContinuousPool<Issue, string>(1, (i) => i.id);
    pool.recordLandingOutcome(2, 0);
    pool.recordLandingOutcome(3, 0);
    expect(pool.noProgressSinceLanding).toBe(5);
    pool.recordLandingOutcome(1, 2);
    expect(pool.noProgressSinceLanding).toBe(0);
    expect(pool.landings).toBe(2);
  });

  it("bounds a human-requested landing pass that makes no progress", () => {
    const pool = new ContinuousPool<Issue, string>(1, (i) => i.id);
    pool.recordLandingOutcome(0, 0, true);
    expect(pool.noProgressSinceLanding).toBe(1);
    pool.recordLandingOutcome(0, 1, true);
    expect(pool.noProgressSinceLanding).toBe(0);
  });
});

describe("scheduler decisions", () => {
  const snapshot = (overrides: Partial<SchedulerSnapshot> = {}): SchedulerSnapshot => ({
    active: 0, ongoing: 0, hasCompleted: false, hasPendingTerminals: false,
    hasCandidates: false, hasRetries: false, hasLandRequests: false, hasCapacity: true,
    budgetRemaining: 10, landings: 0, noProgressSinceLanding: 0,
    noProgressBackstop: 6, quotaClosed: false, ...overrides,
  });

  // Every row names the WHOLE action, reason included: the exit tags are the
  // precedence the header states, and a row that only checked `kind` would
  // pass with quota and stuck swapped.
  it.each([
    ["recompute", snapshot({ hasCompleted: true, active: 1, ongoing: 1 }), { kind: "recompute" }],
    ["land pending terminals", snapshot({ hasPendingTerminals: true, ongoing: 1 }), { kind: "land" }],
    ["quota lands first", snapshot({ quotaClosed: true, hasPendingTerminals: true, ongoing: 1 }), { kind: "land" }],
    ["quota drains", snapshot({ quotaClosed: true, active: 1, ongoing: 1 }), { kind: "drain" }],
    ["quota exits", snapshot({ quotaClosed: true }), { kind: "exit", reason: "quota" }],
    ["quota outranks stuck", snapshot({ quotaClosed: true, noProgressSinceLanding: 6 }), { kind: "exit", reason: "quota" }],
    ["quota outranks relaunch", snapshot({ quotaClosed: true, landings: 1, hasCandidates: true }), { kind: "exit", reason: "quota" }],
    ["stuck exits", snapshot({ noProgressSinceLanding: 6 }), { kind: "exit", reason: "stuck" }],
    ["stuck outranks relaunch", snapshot({ noProgressSinceLanding: 6, landings: 1, hasCandidates: true }), { kind: "exit", reason: "stuck" }],
    ["stuck drains on every observation, not at quiescence", snapshot({ noProgressSinceLanding: 6, active: 3, ongoing: 3, hasCandidates: true }), { kind: "drain" }],
    ["stuck lands first", snapshot({ noProgressSinceLanding: 6, ongoing: 1, hasPendingTerminals: true }), { kind: "land" }],
    ["relaunch at post-landing quiescence", snapshot({ landings: 1, hasCandidates: true }), { kind: "exit", reason: "relaunch" }],
    ["relaunch for a land request alone", snapshot({ landings: 1, hasLandRequests: true }), { kind: "exit", reason: "relaunch" }],
    ["relaunch outranks budget", snapshot({ landings: 1, hasCandidates: true, budgetRemaining: 0 }), { kind: "exit", reason: "relaunch" }],
    ["no relaunch before a landing: a fresh process admits", snapshot({ hasCandidates: true }), { kind: "admit", next: "wait" }],
    ["budget exits", snapshot({ budgetRemaining: 0 }), { kind: "exit", reason: "budget" }],
    ["budget waits for a retry", snapshot({ hasRetries: true, budgetRemaining: 0, ongoing: 1 }), { kind: "admit", next: "wait" }],
    ["refill before landing", snapshot({ hasPendingTerminals: true, hasCandidates: true, ongoing: 1 }), { kind: "admit", next: "land" }],
    ["no capacity: wait", snapshot({ active: 1, ongoing: 1, hasCapacity: false }), { kind: "wait" }],
    ["full pool with a land request waits", snapshot({ active: 1, ongoing: 1, hasCapacity: false, hasLandRequests: true }), { kind: "wait" }],
    ["land request with nothing running lands", snapshot({ hasLandRequests: true }), { kind: "land" }],
    ["plan-empty", snapshot(), { kind: "exit", reason: "plan-empty" }],
  ] as const)("%s", (_name, state, action) => {
    expect(decideSchedulerAction(state)).toEqual(action);
  });
});
