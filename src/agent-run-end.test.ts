import { describe, expect, it } from "vitest";
import { classifyAgentRunEnd } from "./agent-run-end.js";

describe("classifyAgentRunEnd (#114)", () => {
  type Row = readonly [
    end: "exit" | "timeout" | "signal" | "spawn-error",
    exitCode: 0 | 1 | null,
    speech: boolean,
    failure: boolean,
    policy: "retryable" | "infra",
    cause: "clean" | "silent" | "provider-failure" | "spawn-error" | "timeout" | "signal",
    verdict: "answer" | "infra",
  ];
  const matrix = [
    ["exit", 0, false, false, "retryable", "silent", "answer"],
    ["exit", 0, false, false, "infra", "silent", "infra"],
    ["exit", 0, false, true, "retryable", "provider-failure", "infra"],
    ["exit", 0, false, true, "infra", "provider-failure", "infra"],
    ["exit", 0, true, false, "retryable", "clean", "answer"],
    ["exit", 0, true, false, "infra", "clean", "answer"],
    ["exit", 0, true, true, "retryable", "provider-failure", "answer"],
    ["exit", 0, true, true, "infra", "provider-failure", "answer"],
    ["exit", 1, false, false, "retryable", "provider-failure", "infra"],
    ["exit", 1, false, false, "infra", "provider-failure", "infra"],
    ["exit", 1, false, true, "retryable", "provider-failure", "infra"],
    ["exit", 1, false, true, "infra", "provider-failure", "infra"],
    ["exit", 1, true, false, "retryable", "provider-failure", "answer"],
    ["exit", 1, true, false, "infra", "provider-failure", "answer"],
    ["exit", 1, true, true, "retryable", "provider-failure", "answer"],
    ["exit", 1, true, true, "infra", "provider-failure", "answer"],
    ["timeout", null, false, false, "retryable", "timeout", "answer"],
    ["timeout", null, false, false, "infra", "timeout", "answer"],
    ["timeout", null, false, true, "retryable", "timeout", "answer"],
    ["timeout", null, false, true, "infra", "timeout", "answer"],
    ["timeout", null, true, false, "retryable", "timeout", "answer"],
    ["timeout", null, true, false, "infra", "timeout", "answer"],
    ["timeout", null, true, true, "retryable", "timeout", "answer"],
    ["timeout", null, true, true, "infra", "timeout", "answer"],
    ["signal", null, false, false, "retryable", "signal", "infra"],
    ["signal", null, false, false, "infra", "signal", "infra"],
    ["signal", null, false, true, "retryable", "signal", "infra"],
    ["signal", null, false, true, "infra", "signal", "infra"],
    ["signal", null, true, false, "retryable", "signal", "answer"],
    ["signal", null, true, false, "infra", "signal", "answer"],
    ["signal", null, true, true, "retryable", "signal", "answer"],
    ["signal", null, true, true, "infra", "signal", "answer"],
    ["spawn-error", null, false, false, "retryable", "spawn-error", "infra"],
    ["spawn-error", null, false, false, "infra", "spawn-error", "infra"],
    ["spawn-error", null, false, true, "retryable", "spawn-error", "infra"],
    ["spawn-error", null, false, true, "infra", "spawn-error", "infra"],
    ["spawn-error", null, true, false, "retryable", "spawn-error", "infra"],
    ["spawn-error", null, true, false, "infra", "spawn-error", "infra"],
    ["spawn-error", null, true, true, "retryable", "spawn-error", "infra"],
    ["spawn-error", null, true, true, "infra", "spawn-error", "infra"],
  ] as const satisfies readonly Row[];

  it.each(matrix)("%s / exit-%s / speech-%s / failure-%s / %s", (
    end, exitCode, hasSpeech, hasFailure, silentRunRecovery, cause, verdict,
  ) => {
    const actual = classifyAgentRunEnd({
      end,
      exitCode,
      spoken: hasSpeech ? "answer" : "",
      failure: hasFailure ? "provider said why" : undefined,
      silentRunRecovery,
    });
    expect({ cause: actual.cause, verdict: actual.verdict }).toEqual({ cause, verdict });
  });

  it("makes parse errors infrastructure ahead of every process result", () => {
    expect(classifyAgentRunEnd({
      end: "exit",
      exitCode: 0,
      spoken: "partial",
      parseError: "shape broke",
      silentRunRecovery: "retryable",
    })).toEqual({
      cause: "parse-error",
      verdict: "infra",
      detail: "shape broke",
    });
  });

  it("uses the provider, stderr, speech, stdout-tail detail ladder", () => {
    const base = { end: "exit" as const, exitCode: 1, silentRunRecovery: "infra" as const };
    expect(classifyAgentRunEnd({
      ...base, spoken: "speech", failure: "provider", stderr: "stderr", stdout: "stdout",
    }).diagnostic).toBe("provider");
    expect(classifyAgentRunEnd({
      ...base, spoken: "speech", stderr: "stderr", stdout: "stdout",
    }).diagnostic).toBe("stderr");
    expect(classifyAgentRunEnd({
      ...base, spoken: "speech", stdout: "stdout",
    }).diagnostic).toBe("speech");
    const stdout = Array.from({ length: 25 }, (_, i) => `line-${i}`).join("\n");
    expect(classifyAgentRunEnd({ ...base, spoken: "", stdout }).diagnostic).toBe(
      Array.from({ length: 20 }, (_, i) => `line-${i + 5}`).join("\n"),
    );
  });

  it("keeps merger detail narrow while retaining the sandbox diagnostic", () => {
    const classified = classifyAgentRunEnd({
      end: "exit",
      exitCode: 125,
      spoken: "",
      stderr: "podman failed",
      silentRunRecovery: "infra",
    });
    expect(classified.detail).toBeUndefined();
    expect(classified.diagnostic).toBe("podman failed");
  });

  it("gives a spawn error precedence over a provider failure", () => {
    const classified = classifyAgentRunEnd({
      end: "spawn-error",
      exitCode: null,
      spoken: "",
      failure: "provider",
      spawnError: "ENOENT",
      silentRunRecovery: "infra",
    });
    expect(classified).toMatchObject({
      cause: "spawn-error", detail: "ENOENT",
    });
  });

  it("does not expose a blank provider failure as narrow detail", () => {
    const classified = classifyAgentRunEnd({
      end: "exit", exitCode: 0, spoken: "", failure: "   ",
      silentRunRecovery: "infra",
    });
    expect({ cause: classified.cause, verdict: classified.verdict }).toEqual({
      cause: "provider-failure", verdict: "infra",
    });
    expect(classified.detail).toBeUndefined();
  });
});
