// Single source of truth for parsing dotenv-style files.
//
// Both the host-side preflight reader (`env.ts:makeEnvReader`) and the
// sandbox env resolver (`agent-sandbox.ts:resolveEnv`) consume the SAME
// `config.envFilePath`. Keeping one parser here means they can never drift
// (the two predecessors disagreed on escape handling). I/O stays in the
// callers — this is a pure content → record transform so it is trivially
// table-testable and works for both sync and async readers.
//
// Supported syntax: `KEY=value` lines; blank lines and `#` comments ignored;
// surrounding single or double quotes stripped; inside double quotes the
// escapes \n \r \t \\ are unescaped.

export function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (!key) continue;
    let value = trimmed.slice(eqIndex + 1).trim();
    const isDoubleQuoted =
      value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"';
    const isSingleQuoted =
      value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'";
    if (isDoubleQuoted || isSingleQuoted) {
      value = value.slice(1, -1);
    }
    if (isDoubleQuoted) {
      const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\" };
      value = value.replace(/\\([nrt\\])/g, (_, ch: string) => escapes[ch] ?? ch);
    }
    vars[key] = value;
  }
  return vars;
}
