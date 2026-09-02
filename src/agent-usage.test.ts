import { describe, expect, it } from "vitest";
import {
  formatUsageFields,
  normalizeClaudeUsage,
  normalizeCodexUsage,
  sumAgentUsage,
} from "./agent-usage.js";

describe("agent usage normalisation", () => {
  it("sums disjoint Claude model ledgers and resolves the largest output model", () => {
    expect(normalizeClaudeUsage({
      rawA: { inputTokens: 10, cacheReadInputTokens: 20, cacheCreationInputTokens: 3, outputTokens: 8, thinkingTokens: 2, canonicalModel: "model-a" },
      rawB: { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 4, thinkingTokens: 1 },
    })).toEqual({
      inputTokens: 11, cachedInputTokens: 22, cacheWriteInputTokens: 3,
      outputTokens: 12, reasoningTokens: 3, resolvedModel: "model-a", models: 2,
    });
  });

  it("subtracts Codex cached input, preserves zero, and omits an impossible fresh bucket", () => {
    expect(normalizeCodexUsage({ input_tokens: 20, cached_input_tokens: 12, cache_write_input_tokens: 0 })).toEqual({
      inputTokens: 8, cachedInputTokens: 12, cacheWriteInputTokens: 0,
    });
    expect(normalizeCodexUsage({ input_tokens: 2, cached_input_tokens: 3 })).toEqual({ cachedInputTokens: 3 });
  });

  it("sums fresh invocation ledgers without collapsing token buckets", () => {
    const usage = sumAgentUsage(
      { inputTokens: 2, cachedInputTokens: 5, outputTokens: 1, apiMs: 10 },
      { inputTokens: 3, cachedInputTokens: 7, outputTokens: 2, apiMs: 20 },
    );
    expect(usage).toEqual({ inputTokens: 5, cachedInputTokens: 12, outputTokens: 3, apiMs: 30 });
    expect(formatUsageFields(usage, 0)).toBe(" tokens=in:5,cached:12,out:3 toolCalls=0 apiMs=30");
  });
});
