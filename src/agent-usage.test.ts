import { describe, expect, it } from "vitest";
import {
  formatUsageFields,
  normalizeClaudeResult,
  normalizeCodexUsage,
  sumAgentUsage,
} from "./agent-usage.js";

describe("agent usage normalisation", () => {
  it("sums disjoint Claude model ledgers and resolves the largest output model", () => {
    expect(normalizeClaudeResult({ modelUsage: {
      rawA: { inputTokens: 10, cacheReadInputTokens: 20, cacheCreationInputTokens: 3, outputTokens: 8, thinkingTokens: 2, canonicalModel: "model-a" },
      rawB: { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 4, thinkingTokens: 1 },
    }, duration_api_ms: 2021, terminal_reason: "end_turn",
    })).toEqual({
      inputTokens: 11, cachedInputTokens: 22, cacheWriteInputTokens: 3,
      outputTokens: 12, reasoningTokens: 3, apiMs: 2021,
      resolvedModel: "model-a", models: 2, terminalReason: "end_turn",
    });
  });

  it("subtracts Codex cached input, preserves zero, and omits an impossible fresh bucket", () => {
    expect(normalizeCodexUsage({ input_tokens: 20, cached_input_tokens: 12, cache_write_input_tokens: 0 })).toEqual({
      inputTokens: 8, cachedInputTokens: 12, cacheWriteInputTokens: 0,
    });
    expect(normalizeCodexUsage({ input_tokens: 2, cached_input_tokens: 3 })).toEqual({ cachedInputTokens: 3 });
  });

  it("sums ledgers and keeps the largest-output model, maximum model count, and last terminal reason", () => {
    const usage = sumAgentUsage(
      { inputTokens: 2, cachedInputTokens: 5, outputTokens: 8, apiMs: 10,
        resolvedModel: "model-a", models: 3, terminalReason: "first" },
      { inputTokens: 3, cachedInputTokens: 7, outputTokens: 2, apiMs: 20,
        resolvedModel: "model-b", models: 2, terminalReason: "last" },
    );
    expect(usage).toEqual({
      inputTokens: 5, cachedInputTokens: 12, outputTokens: 10, apiMs: 30,
      resolvedModel: "model-a", models: 3, terminalReason: "last",
    });
  });
});

describe("formatUsageFields", () => {
  it.each([
    ["absent usage", undefined, undefined, ""],
    ["reported zeros", { cachedInputTokens: 0 }, 0, " tokens=cached:0 toolCalls=0"],
    ["one model suppressed", { resolvedModel: "claude-opus", models: 1 }, undefined,
      " resolvedModel=claude-opus"],
    ["complete measurement", {
      inputTokens: 910, cachedInputTokens: 10272, cacheWriteInputTokens: 8428,
      outputTokens: 53, reasoningTokens: 36, apiMs: 2021,
      resolvedModel: "claude-haiku-4-5", models: 2,
      terminalReason: "end_turn",
    }, 37,
    " tokens=in:910,cached:10272,write:8428,out:53,reasoning:36 toolCalls=37 apiMs=2021 resolvedModel=claude-haiku-4-5 models=2 terminalReason=end_turn"],
  ])("renders %s", (_name, usage, toolCalls, expected) => {
    expect(formatUsageFields(usage, toolCalls)).toBe(expected);
  });
});
