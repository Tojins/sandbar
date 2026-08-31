// The two readers of `config.env`, and the one place its semantics live.
//
// `config.env` is a `Record<string, string>` — a VALUE in the config, not a
// path to a file (#38): sandbar names no file, and one record is structurally
// one answer for preflight and the container.
//
// The semantics are an allowlist. Only keys the config DECLARES cross into a
// container; the host's environment never leaks wholesale. A declared key with
// an empty value means "inherit this one from the host". `readEnvFile`
// (env-file.ts) turns a dotenv file into this record for hosts that want one.

export type EnvReader = (key: string) => string | undefined;

// Host-side lookup, used by preflight and by run.ts's GH_TOKEN check. For a
// DECLARED key it prefers the configured value and falls back to the host's
// environment for that key alone — preflight only needs to know the credential
// exists somewhere the host can see, because `resolveSandboxEnv` applies the
// identical fallback when it builds what the container gets. An undeclared key
// resolves to nothing in both, which is what keeps them from disagreeing.
export function makeEnvReader(env: Record<string, string>): EnvReader {
  return (key: string): string | undefined => {
    // An UNDECLARED key resolves to nothing, whatever the host environment
    // holds. Falling back for it would make the two readers disagree in the
    // one direction that is silent and unrecoverable: preflight would find
    // `GH_TOKEN` in its own environment and pass, `resolveSandboxEnv` iterates
    // only declared keys and would export nothing, and every agent would run
    // unauthenticated for its whole attempt budget — the exact failure the
    // credential check exists to prevent, reached through the check. Which is
    // also why the reader is not merely `env[key] ?? process.env[key]`.
    if (!Object.prototype.hasOwnProperty.call(env, key)) return undefined;
    const v = env[key];
    return v !== undefined && v !== "" ? v : process.env[key];
  };
}

// What a sandbox container actually receives: every declared key whose value
// resolves to something non-empty, taking the host's environment when the
// config left it blank. A key that resolves to nothing is omitted rather than
// exported empty — an empty `ANTHROPIC_API_KEY` in the container is worse than
// an absent one, since it defeats the agent's own "is it set" checks.
export function resolveSandboxEnv(
  env: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    const value = env[key] || process.env[key];
    if (value) result[key] = value;
  }
  return result;
}
