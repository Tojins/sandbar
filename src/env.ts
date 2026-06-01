// Host-side reader for the orchestrator's env file (`config.envFilePath`).
//
// This is the SAME file the sandbox env resolver reads (see
// `agent-sandbox.ts:resolveEnv`) — `config.envFilePath` is authoritative for
// both. Preflight uses this reader to verify credentials (GH_TOKEN, the agent
// key) up front; because it inspects the identical path the container will
// load, a wrong/missing file fails preflight loudly instead of surfacing later
// as an in-container "Not logged in".
//
// Per-key semantics: prefer the file's value, fall back to process.env for the
// requested key (preflight only needs to know the credential exists *somewhere*
// the host can see). Parsing is delegated to the shared `parseEnvFile`.

import { readFileSync } from "node:fs";
import { parseEnvFile } from "./env-file.js";

export type EnvReader = (key: string) => string | undefined;

export function makeEnvReader(envFilePath: string): EnvReader {
  let parsed: Record<string, string> | null;
  try {
    parsed = parseEnvFile(readFileSync(envFilePath, "utf8"));
  } catch {
    parsed = null;
  }
  return (key: string): string | undefined => {
    const v = parsed?.[key];
    return v !== undefined && v !== "" ? v : process.env[key];
  };
}
