// The one fatal path (#35): report, drain cleanup, exit 1.
import { afterEach, describe, expect, it, vi } from "vitest";

import { exitOnInternalFailure, onCleanup, setCleanupReporter } from "./cleanup.js";

describe("exitOnInternalFailure", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports an internal-failure notice, runs cleanup, then exits 1", async () => {
    const order: string[] = [];
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      order.push(`exit ${code}`);
    }) as never);
    const restore = setCleanupReporter((kind, message, cause) => {
      order.push(`${kind}: ${message}`);
      expect(cause).toBeInstanceOf(Error);
    });
    onCleanup(() => { order.push("cleanup"); });
    try {
      await exitOnInternalFailure("Uncaught exception", new Error("boom"));
    } finally {
      restore();
    }
    expect(exit).toHaveBeenCalledWith(1);
    expect(order).toEqual([
      "internal-failure: Uncaught exception",
      "cleanup",
      "exit 1",
    ]);
  });
});
