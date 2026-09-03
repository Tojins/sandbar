import { describe, expect, it, vi } from "vitest";

import type { Sandbox } from "./agent-sandbox.js";
import { runSandboxAndPublish } from "./inner-loop.js";

describe("runSandboxAndPublish", () => {
  it("preserves the agent failure when recovery publishing also fails", async () => {
    const agentError = new Error("agent idle timeout");
    const sandbox = {
      run: vi.fn().mockRejectedValue(agentError),
      syncBranchToCache: vi.fn().mockRejectedValue(new Error("packed-refs.lock")),
    } as unknown as Sandbox;
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        runSandboxAndPublish(sandbox, {} as Parameters<Sandbox["run"]>[0], "98"),
      ).rejects.toBe(agentError);
      expect(sandbox.syncBranchToCache).toHaveBeenCalledOnce();
      expect(reported).toHaveBeenCalledWith(
        expect.stringContaining("continuing with original error"),
        expect.any(Error),
      );
    } finally {
      reported.mockRestore();
    }
  });
});
