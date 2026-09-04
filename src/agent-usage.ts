// Provider token ledgers use opposite input conventions: Claude reports fresh,
// cache-read and cache-write buckets as disjoint values, while Codex includes
// cached input inside input_tokens. Sandbar normalises both to Claude's
// disjoint convention so adding the rendered buckets means the same thing for
// every provider. Reasoning remains a subset of output. Missing/non-numeric
// measurements are absent; a reported zero remains a real measurement (#85).
//
// Those terminal ledgers are invocation COSTS, not context depths (#124).
// In particular, cache reads are running totals over API turns, so a long
// session can report millions of cached tokens without ever holding that many
// tokens at once. Depth comes from each turn's own usage event and occupies a
// separate parser register: retain only the maximum of fresh + cache-read +
// cache-write for Claude, or input_tokens + cache-write for Codex because its
// input already includes cached tokens. It is evidence only, never a bound or
// completion signal, and malformed/unavailable measurements stay absent.

export type AgentUsage = {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly apiMs?: number;
  readonly resolvedModel?: string;
  readonly models?: number;
  readonly terminalReason?: string;
};

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const tokenCount = (value: unknown): number | undefined => {
  const count = finite(value);
  return count !== undefined && count >= 0 ? count : undefined;
};

const optionalTokenCount = (value: unknown): number | undefined =>
  value === undefined ? 0 : tokenCount(value);

const contextDepth = (...counts: readonly (number | undefined)[]): number | undefined => {
  if (counts.some((count) => count === undefined)) return undefined;
  const sum = counts.reduce<number>((total, count) => total + (count ?? 0), 0);
  return Number.isFinite(sum) ? sum : undefined;
};

export function normalizeClaudeContextDepth(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  return contextDepth(
    tokenCount(usage.input_tokens),
    optionalTokenCount(usage.cache_read_input_tokens),
    optionalTokenCount(usage.cache_creation_input_tokens),
  );
}

export function normalizeCodexContextDepth(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  return contextDepth(
    tokenCount(usage.input_tokens),
    optionalTokenCount(usage.cache_write_input_tokens),
  );
}

export function maxContextDepth(
  ...items: readonly (number | undefined)[]
): number | undefined {
  const values = items.filter((item): item is number => item !== undefined);
  return values.length === 0 ? undefined : Math.max(...values);
}

const present = (candidate: AgentUsage): AgentUsage | undefined => {
  const usage = Object.fromEntries(
    Object.entries(candidate).filter(([, value]) => value !== undefined),
  ) as AgentUsage;
  return Object.keys(usage).length === 0 ? undefined : usage;
};

export function normalizeClaudeResult(value: unknown): AgentUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const result = value as Record<string, unknown>;
  const modelUsage = result.modelUsage;
  const entries = modelUsage !== null && typeof modelUsage === "object"
    ? Object.entries(modelUsage).flatMap(([rawModel, raw]) =>
    raw !== null && typeof raw === "object"
      ? [{ rawModel, value: raw as Record<string, unknown> }]
      : [],
    )
    : [];
  const sum = (field: string): number | undefined => {
    const values = entries.map(({ value: entry }) => finite(entry[field]));
    return values.every((item) => item === undefined)
      ? undefined
      : values.reduce<number>((total, item) => total + (item ?? 0), 0);
  };
  const resolved = entries
    .map(({ rawModel, value: entry }) => ({
      model: typeof entry.canonicalModel === "string" ? entry.canonicalModel : rawModel,
      output: finite(entry.outputTokens) ?? 0,
    }))
    .sort((a, b) => b.output - a.output)[0]?.model;
  return present({
    inputTokens: sum("inputTokens"),
    cachedInputTokens: sum("cacheReadInputTokens"),
    cacheWriteInputTokens: sum("cacheCreationInputTokens"),
    outputTokens: sum("outputTokens"),
    reasoningTokens: sum("thinkingTokens"),
    apiMs: finite(result.duration_api_ms),
    resolvedModel: resolved,
    models: entries.length > 1 ? entries.length : undefined,
    terminalReason:
      typeof result.terminal_reason === "string"
        ? result.terminal_reason
        : undefined,
  });
}

export function normalizeCodexUsage(value: unknown): AgentUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const input = finite(usage.input_tokens);
  const cached = finite(usage.cached_input_tokens);
  const fresh = input === undefined
    ? undefined
    : cached === undefined
      ? input
      : input >= cached
        ? input - cached
        : undefined;
  return present({
    inputTokens: fresh,
    cachedInputTokens: cached,
    cacheWriteInputTokens: finite(usage.cache_write_input_tokens),
    outputTokens: finite(usage.output_tokens),
    reasoningTokens: finite(usage.reasoning_output_tokens),
  });
}

export function sumAgentUsage(
  ...items: readonly (AgentUsage | undefined)[]
): AgentUsage | undefined {
  const values = items.filter((item): item is AgentUsage => item !== undefined);
  if (values.length === 0) return undefined;
  const sum = (field: keyof AgentUsage): number | undefined => {
    const numbers = values
      .map((item) => item[field])
      .filter((v): v is number => typeof v === "number");
    return numbers.length === 0 ? undefined : numbers.reduce((a, b) => a + b, 0);
  };
  const largestOutputModel = values
    .filter((item) => item.resolvedModel !== undefined)
    .sort((a, b) => (b.outputTokens ?? 0) - (a.outputTokens ?? 0))[0]
    ?.resolvedModel;
  const reportedModels = values
    .map((item) => item.models)
    .filter((value): value is number => value !== undefined);
  const modelCount = reportedModels.length === 0 ? 0 : Math.max(...reportedModels);
  return present({
    inputTokens: sum("inputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    cacheWriteInputTokens: sum("cacheWriteInputTokens"),
    outputTokens: sum("outputTokens"),
    reasoningTokens: sum("reasoningTokens"),
    apiMs: sum("apiMs"),
    resolvedModel: largestOutputModel,
    models: modelCount > 1 ? modelCount : undefined,
    terminalReason: values.at(-1)?.terminalReason,
  });
}

export function formatUsageFields(
  usage: AgentUsage | undefined,
  toolCalls?: number,
  peakContext?: number,
): string {
  const tokens = usage === undefined ? [] : [
    ["in", usage.inputTokens],
    ["cached", usage.cachedInputTokens],
    ["write", usage.cacheWriteInputTokens],
    ["out", usage.outputTokens],
    ["reasoning", usage.reasoningTokens],
  ].filter((field): field is [string, number] => field[1] !== undefined);
  return (tokens.length === 0
    ? ""
    : ` tokens=${tokens.map(([name, value]) => `${name}:${value}`).join(",")}`) +
    (toolCalls === undefined ? "" : ` toolCalls=${toolCalls}`) +
    (peakContext === undefined ? "" : ` peakContext=${peakContext}`) +
    (usage?.apiMs === undefined ? "" : ` apiMs=${usage.apiMs}`) +
    (usage?.resolvedModel === undefined ? "" : ` resolvedModel=${usage.resolvedModel}`) +
    (usage?.models === undefined || usage.models <= 1 ? "" : ` models=${usage.models}`) +
    (usage?.terminalReason === undefined
      ? ""
      : ` terminalReason=${usage.terminalReason}`);
}
