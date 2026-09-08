// One ChatGPT credential file for every Codex process in a run (#134).
//
// `CODEX_AUTH_JSON` remains the config boundary: it is a value, not a hidden
// host path (#38). At preflight the driver reconciles that value into its own
// `<workDir>/codex-auth.json`. Every agent sandbox and Codex merger container
// bind-mounts that one file read-write at `$CODEX_HOME/auth.json`, so Codex's
// reload-before-refresh protocol gives concurrent readers the newly rotated
// token family instead of leaving each sandbox with a doomed private copy.
//
// The seed rule is deliberately asymmetric. A newer configured value means an
// operator ran `codex login` again and replaces the run-owned family. An older
// configured value never rolls back a refresh already persisted by a sandbox.
// Both timestamps must be trustworthy before comparing them: malformed JSON,
// a missing `last_refresh`, or an invalid date refuses preflight and names the
// exact value whose ordering could not be established.

import { chmod, readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { SandbarError, isErrno } from "./errors.js";

export const CODEX_AUTH_FILE_NAME = "codex-auth.json";
export const DEFAULT_CODEX_SANDBOX_HOME = "/home/agent/.codex";

export type CodexAuthMount = {
  readonly hostPath: string;
  readonly sandboxPath: string;
};

type DatedAuth = {
  readonly value: string;
  readonly lastRefreshMs: number;
};

function parseDatedAuth(value: string, label: string): DatedAuth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SandbarError(`${label} is not valid JSON: ${detail}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SandbarError(`${label} must be a JSON object with a last_refresh field.`);
  }
  const lastRefresh = (parsed as { last_refresh?: unknown }).last_refresh;
  if (typeof lastRefresh !== "string" || lastRefresh.trim() === "") {
    throw new SandbarError(`${label}.last_refresh must be a non-empty date string.`);
  }
  const lastRefreshMs = Date.parse(lastRefresh);
  if (!Number.isFinite(lastRefreshMs)) {
    throw new SandbarError(`${label}.last_refresh is not a valid date: ${lastRefresh}`);
  }
  return { value, lastRefreshMs };
}

export type PrepareCodexAuthResult = {
  readonly mount: CodexAuthMount;
  readonly action: "seeded" | "updated" | "kept";
};

export async function prepareCodexAuth(args: {
  readonly stateDir: string;
  readonly configuredJson: string;
  readonly codexHome?: string;
}): Promise<PrepareCodexAuthResult> {
  const configured = parseDatedAuth(args.configuredJson, "CODEX_AUTH_JSON");
  const hostPath = join(args.stateDir, CODEX_AUTH_FILE_NAME);
  const codexHome = args.codexHome || DEFAULT_CODEX_SANDBOX_HOME;
  if (!isAbsolute(codexHome)) {
    throw new SandbarError(`CODEX_HOME must be absolute to mount auth.json (got ${codexHome}).`);
  }

  let current: DatedAuth | null = null;
  try {
    current = parseDatedAuth(await readFile(hostPath, "utf8"), hostPath);
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
  }

  const action = current === null
    ? "seeded"
    : configured.lastRefreshMs > current.lastRefreshMs
      ? "updated"
      : "kept";
  if (action !== "kept") {
    await mkdir(args.stateDir, { recursive: true });
    const incomingPath = `${hostPath}.incoming`;
    await writeFile(incomingPath, configured.value, { mode: 0o600 });
    await chmod(incomingPath, 0o600);
    await rename(incomingPath, hostPath);
  }
  await chmod(hostPath, 0o600);
  return {
    action,
    mount: { hostPath, sandboxPath: join(codexHome, "auth.json") },
  };
}
