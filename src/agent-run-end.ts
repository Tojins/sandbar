// One classification for the two wrappers that invoke an AgentProvider (#114).
// Their process/container lifecycles remain deliberately different; only the
// meaning of a completed invocation is shared here.

export type AgentRunEnd = "exit" | "timeout" | "signal" | "spawn-error";
export type AgentRunCause = "clean" | "silent" | "provider-failure" | "spawn-error" | "timeout" | "signal" | "parse-error";
export type SilentRunRecovery = "retryable" | "infra";

export type AgentRunClassification = {
  readonly cause: AgentRunCause;
  readonly verdict: "answer" | "infra";
  // A provider or runtime's own narrow explanation. Consumers may add their
  // own presentation around it without accidentally embedding raw streams.
  readonly detail?: string;
  // The sandbox's four-tier failure text: provider → stderr → speech → stdout.
  readonly diagnostic: string;
};

export type AgentRunEndInput = {
  readonly end: AgentRunEnd;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly spoken: string;
  readonly failure?: string;
  readonly spawnError?: string;
  readonly parseError?: string;
  readonly stderr?: string;
  readonly stdout?: string;
  readonly silentRunRecovery: SilentRunRecovery;
};

const exitDetail = (input: AgentRunEndInput): string => {
  if (input.failure?.trim()) return input.failure;
  if (input.stderr?.trim()) return input.stderr;
  if (input.spoken.trim()) return input.spoken;
  return (input.stdout ?? "").split("\n").filter((line) => line.trim()).slice(-20).join("\n");
};

export function classifyAgentRunEnd(input: AgentRunEndInput): AgentRunClassification {
  const diagnostic = exitDetail(input);
  if (input.parseError !== undefined) {
    return {
      cause: "parse-error",
      verdict: "infra",
      detail: input.parseError,
      diagnostic: input.parseError,
    };
  }
  if (input.end === "spawn-error") {
    return {
      cause: "spawn-error",
      verdict: "infra",
      ...(input.spawnError === undefined ? {} : { detail: input.spawnError }),
      diagnostic: input.spawnError ?? diagnostic,
    };
  }
  if (input.end === "timeout") {
    return { cause: "timeout", verdict: "answer", diagnostic: "wall-clock timeout" };
  }
  if (input.end === "signal") {
    return {
      cause: "signal",
      verdict: input.spoken.trim() ? "answer" : "infra",
      diagnostic: input.signal ?? "process killed by a signal",
    };
  }
  if (input.exitCode !== 0 || input.failure !== undefined) {
    return {
      cause: "provider-failure",
      verdict: input.spoken.trim() ? "answer" : "infra",
      ...(input.failure?.trim() ? { detail: input.failure } : {}),
      diagnostic,
    };
  }
  if (!input.spoken.trim()) {
    return {
      cause: "silent",
      verdict: input.silentRunRecovery === "infra" ? "infra" : "answer",
      diagnostic: "process exited successfully without agent speech",
    };
  }
  return { cause: "clean", verdict: "answer", diagnostic: "" };
}
