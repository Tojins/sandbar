// One classification for the two wrappers that invoke an AgentProvider (#114).
// Their process/container lifecycles remain deliberately different; only the
// meaning of a completed invocation is shared here.

export type AgentRunEnd = "exit" | "timeout" | "signal" | "spawn-error";
export type AgentRunCause = "clean" | "silent" | "provider-failure" | "spawn-error" | "timeout" | "signal" | "parse-error";
export type SilentRunRecovery = "retryable" | "infra";

export type AgentRunClassification = {
  readonly cause: AgentRunCause;
  readonly verdict: "answer" | "infra";
  readonly detail: string;
};

export type AgentRunEndInput = {
  readonly end: AgentRunEnd;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly spoken: string;
  readonly failure?: string;
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
  if (input.parseError !== undefined) return { cause: "parse-error", verdict: "infra", detail: input.parseError };
  if (input.end === "spawn-error") return { cause: "spawn-error", verdict: "infra", detail: exitDetail(input) };
  if (input.end === "timeout") return { cause: "timeout", verdict: "answer", detail: "wall-clock timeout" };
  if (input.end === "signal") return { cause: "signal", verdict: input.spoken.trim() ? "answer" : "infra", detail: input.signal ?? "process killed by a signal" };
  if (input.exitCode !== 0 || input.failure !== undefined) return { cause: "provider-failure", verdict: input.spoken.trim() ? "answer" : "infra", detail: exitDetail(input) };
  if (!input.spoken.trim()) return { cause: "silent", verdict: input.silentRunRecovery === "infra" ? "infra" : "answer", detail: "process exited successfully without agent speech" };
  return { cause: "clean", verdict: "answer", detail: "" };
}
