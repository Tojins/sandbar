import { describe, expect, it } from "vitest";
import {
  type AgentRunEnd,
  classifyAgentRunEnd,
} from "./agent-run-end.js";

describe("classifyAgentRunEnd (#114)", () => {
  const ends: readonly AgentRunEnd[] = ["exit", "timeout", "signal", "spawn-error"];
  const bools = [false, true] as const;
  const policies = ["retryable", "infra"] as const;

  // Exhaustive over every register that can change the judgement. This table
  // makes a policy edit touch all invocation shapes instead of changing one
  // wrapper unnoticed.
  for (const end of ends) {
    for (const nonzero of bools) {
      for (const hasSpeech of bools) {
        for (const hasFailure of bools) {
          for (const silentRunRecovery of policies) {
            const label = [end, nonzero ? "exit-1" : "exit-0", hasSpeech ? "speech" : "silent", hasFailure ? "failure" : "no-failure", silentRunRecovery].join(" / ");
            it(label, () => {
              const actual = classifyAgentRunEnd({
                end,
                exitCode: end === "exit" ? (nonzero ? 1 : 0) : null,
                signal: end === "signal" ? "SIGKILL" : null,
                spoken: hasSpeech ? "answer" : "",
                failure: hasFailure ? "provider said why" : undefined,
                stderr: "stderr detail",
                stdout: "raw stdout",
                silentRunRecovery,
              });
              const cause = end === "spawn-error"
                ? "spawn-error"
                : end === "timeout"
                  ? "timeout"
                  : end === "signal"
                    ? "signal"
                    : nonzero || hasFailure
                      ? "provider-failure"
                      : hasSpeech
                        ? "clean"
                        : "silent";
              const verdict = end !== "spawn-error" && (end === "timeout" || hasSpeech || (cause === "silent" && silentRunRecovery === "retryable"))
                ? "answer"
                : "infra";
              expect({ cause: actual.cause, verdict: actual.verdict }).toEqual({ cause, verdict });
            });
          }
        }
      }
    }
  }

  it("makes parse errors infrastructure ahead of every process result", () => {
    expect(classifyAgentRunEnd({
      end: "exit",
      exitCode: 0,
      signal: null,
      spoken: "partial",
      parseError: "shape broke",
      silentRunRecovery: "retryable",
    })).toEqual({ cause: "parse-error", verdict: "infra", detail: "shape broke" });
  });

  it("uses the provider, stderr, speech, stdout-tail detail ladder", () => {
    const base = { end: "exit" as const, exitCode: 1, signal: null, silentRunRecovery: "infra" as const };
    expect(classifyAgentRunEnd({ ...base, spoken: "speech", failure: "provider", stderr: "stderr", stdout: "stdout" }).detail).toBe("provider");
    expect(classifyAgentRunEnd({ ...base, spoken: "speech", stderr: "stderr", stdout: "stdout" }).detail).toBe("stderr");
    expect(classifyAgentRunEnd({ ...base, spoken: "speech", stdout: "stdout" }).detail).toBe("speech");
    const stdout = Array.from({ length: 25 }, (_, i) => `line-${i}`).join("\n");
    expect(classifyAgentRunEnd({ ...base, spoken: "", stdout }).detail).toBe(Array.from({ length: 20 }, (_, i) => `line-${i + 5}`).join("\n"));
  });
});
