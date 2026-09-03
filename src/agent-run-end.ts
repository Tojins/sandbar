// One classification for the two wrappers that invoke an AgentProvider (#114).
// Their process/container lifecycles remain deliberately different; only the
// meaning of a completed invocation is shared here. A timeout is an ANSWER
// because it spent the merger's whole wall-clock attempt budget. Spawn and
// parse errors are always INFRA, even after speech: the former never produced
// a trustworthy process end and the latter broke the provider shape contract.
// A signal or provider failure is infra only without speech, because partial
// speech remains evidence (#41). In particular, exit-0 `failure` is a residual
// guard rather than codex's credential path: at the pinned codex version a
// missing key emits `turn.failed` and exits 1. A clean silent exit is the sole
// caller policy: the persistent sandbox can re-ask the same session, while a
// fresh merger container cannot.
//
// `detail` is only a provider/runtime's narrow cause for merger presentation.
// `diagnostic` is only the sandbox exit path's four-tier ladder — provider,
// stderr, parsed speech, then the last 20 nonblank stdout lines. Keeping those
// distinct prevents byte-verbatim merger streams from leaking into a halt
// message while preserving the provider's own give-up cause as the sandbox's
// leading explanation.

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
  readonly diagnostic?: string;
};

export type AgentRunEndInput = {
  readonly end: AgentRunEnd;
  readonly exitCode: number | null;
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
  if (input.parseError !== undefined) {
    return {
      cause: "parse-error",
      verdict: "infra",
      detail: input.parseError,
    };
  }
  if (input.end === "spawn-error") {
    return {
      cause: "spawn-error",
      verdict: "infra",
      ...(input.spawnError === undefined ? {} : { detail: input.spawnError }),
    };
  }
  if (input.end === "timeout") {
    return { cause: "timeout", verdict: "answer" };
  }
  if (input.end === "signal") {
    return {
      cause: "signal",
      verdict: input.spoken.trim() ? "answer" : "infra",
    };
  }
  if (input.exitCode !== 0 || input.failure !== undefined) {
    return {
      cause: "provider-failure",
      verdict: input.spoken.trim() ? "answer" : "infra",
      ...(input.failure?.trim() ? { detail: input.failure } : {}),
      diagnostic: exitDetail(input),
    };
  }
  if (!input.spoken.trim()) {
    return {
      cause: "silent",
      verdict: input.silentRunRecovery === "infra" ? "infra" : "answer",
    };
  }
  return { cause: "clean", verdict: "answer" };
}
