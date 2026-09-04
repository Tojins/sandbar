import { describe, expect, it } from "vitest";
import { ContinuousPool } from "./scheduler.js";

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
});
