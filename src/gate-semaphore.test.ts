import { describe, expect, it } from "vitest";

import { createGateSemaphore } from "./gate-semaphore.js";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe("gate semaphore (#142)", () => {
  it("admits waiting gates in call order and reports only their queue time", async () => {
    let now = 10;
    const semaphore = createGateSemaphore(1, () => now);
    const firstFinished = deferred<string>();
    const secondFinished = deferred<string>();
    const starts: string[] = [];

    const first = semaphore.run(async () => {
      starts.push("attempt-1");
      return await firstFinished.promise;
    });
    const second = semaphore.run(async () => {
      starts.push("attempt-2");
      return await secondFinished.promise;
    });

    await Promise.resolve();
    expect(starts).toEqual(["attempt-1"]);
    now = 35;
    firstFinished.resolve("first");
    await expect(first).resolves.toEqual({ value: "first" });
    await Promise.resolve();
    expect(starts).toEqual(["attempt-1", "attempt-2"]);
    secondFinished.resolve("second");
    await expect(second).resolves.toEqual({ value: "second", queuedMs: 25 });
  });

  it("releases a permit when an admitted gate throws", async () => {
    const semaphore = createGateSemaphore(1, () => 0);
    const started = deferred<void>();
    const failure = deferred<never>();
    const starts: string[] = [];

    const first = semaphore.run(async () => {
      starts.push("first");
      started.resolve();
      return await failure.promise;
    });
    await started.promise;
    const second = semaphore.run(async () => {
      starts.push("second");
      return "ok";
    });

    failure.reject(new Error("gate failed"));
    await expect(first).rejects.toThrow("gate failed");
    await expect(second).resolves.toEqual({ value: "ok", queuedMs: 0 });
    expect(starts).toEqual(["first", "second"]);
  });

  it("is unlimited when the bound is unset", async () => {
    const semaphore = createGateSemaphore(undefined, () => 0);
    const finish = deferred<void>();
    const starts: number[] = [];

    const gates = [1, 2, 3].map((n) => semaphore.run(async () => {
      starts.push(n);
      await finish.promise;
      return n;
    }));

    await Promise.resolve();
    expect(starts).toEqual([1, 2, 3]);
    finish.resolve();
    await expect(Promise.all(gates)).resolves.toEqual([
      { value: 1 }, { value: 2 }, { value: 3 },
    ]);
  });
});
