// Dotenv parsing, and the opt-in helper that turns a file into `config.env`.
//
// Since #38 this is no longer contract. `config.env` is a
// `Record<string, string>` the host supplies however it likes, and sandbar
// names no file — so a host whose compose already owns `.env`, or whose secrets
// arrive from a vault, passes its own loader's output and never runs this
// parser at all. What survives is the convenience: most hosts do want a
// gitignored file beside the config, and `readEnvFile` is the one-liner for it.
//
// Keeping the parser here rather than deleting it also keeps the escape
// dialect single. The two predecessors of this module disagreed on escapes;
// the failure mode of two parsers over one file is a credential that differs
// between the preflight check and the container by a backslash.
//
// Supported syntax: `KEY=value` lines; blank lines and `#` comments ignored;
// surrounding single or double quotes stripped; inside double quotes the
// escapes \n \r \t \\ are unescaped.

import { readFileSync } from "node:fs";

import { SandbarError } from "./errors.js";

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

// Read a dotenv-style file into the record `config.env` takes. Exported from
// the package root so a config file can write:
//
//   env: readEnvFile(new URL("sandbar.env", import.meta.url)),
//
// Throws rather than returning `{}` for an unreadable file. An empty record is
// a legitimate configuration (CI supplies everything through the process
// environment), so a silent fallback would turn a typo'd path into "GH_TOKEN is
// missing" and send the operator to look at their token instead of at the line
// that names the file.
export function readEnvFile(path: string | URL): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch (err) {
    throw new SandbarError(
      `readEnvFile: cannot read '${path instanceof URL ? path.pathname : path}': ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
}
