// Dotenv parsing, plus the opt-in helpers that turn a file into `config.env`
// and per-installation role routing (#38, #137).
//
// `config.env` remains a record the host supplies however it likes, and sandbar
// names no file (#38): `readEnvFile` is the opt-in one-liner for hosts that want
// a gitignored file beside the config. `splitRoleRouting` (#137) partitions
// fifteen reserved `SANDBAR_*` keys out of that record before the remainder is
// used as the sandbox allowlist. The config remains a program: it decides
// whether to call the helper and spreads the returned routing over its own
// defaults. Keeping the split beside the parser gives one spelling of those
// reserved keys and makes it impossible for one to cross into a sandbox.
// Keeping the parser here keeps the escape dialect single: two parsers over
// one file is a credential that differs between the preflight check and the
// container by a backslash.
//
// Supported syntax: `KEY=value` lines; blank lines and `#` comments ignored;
// surrounding single or double quotes stripped; inside double quotes the
// escapes \n \r \t \\ are unescaped.

import { readFileSync } from "node:fs";

import type { RunConfig } from "./config.js";
import { SandbarError } from "./errors.js";

const ROLE_ROUTING_FIELDS = [
  "implementerAgent",
  "implementerModelId",
  "implementerEffort",
  "uiCheckAgent",
  "uiCheckModelId",
  "uiCheckEffort",
  "reviewerAgent",
  "reviewerModelId",
  "reviewerEffort",
  "reviewerQualityAgent",
  "reviewerQualityModelId",
  "reviewerQualityEffort",
  "mergerAgent",
  "mergerModelId",
  "mergerEffort",
] as const satisfies readonly (keyof RunConfig)[];

type RoleRoutingField = (typeof ROLE_ROUTING_FIELDS)[number];

type RoleRouting = Partial<Pick<RunConfig, RoleRoutingField>>;

function routingEnvKey(field: RoleRoutingField): string {
  return `SANDBAR_${field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
}

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

// Split a host-supplied env record into the role-routing deviations a config
// spreads over its committed defaults and the allowlist that may enter agent
// sandboxes. Empty reserved values mean "inherit the committed field", exactly
// as empty `config.env` values mean "inherit from process.env". Reserved keys
// are removed in both cases, so routing controls are never exported to an
// agent. Values remain deliberately unvalidated here: `resolveConfig` is the
// one boundary that parses providers and checks provider/model pairings and
// effort shapes.
export function splitRoleRouting(record: Record<string, string>): {
  readonly routing: RoleRouting;
  readonly env: Record<string, string>;
} {
  const routingValues: Record<string, string> = {};
  const env = { ...record };

  for (const field of ROLE_ROUTING_FIELDS) {
    const key = routingEnvKey(field);
    if (!Object.hasOwn(record, key)) continue;

    delete env[key];
    const value = record[key];
    if (value !== undefined && value !== "") routingValues[field] = value;
  }

  // Agent names are still strings at this boundary. The cast describes the
  // config fields they populate; resolveConfig performs the runtime narrowing.
  return { routing: routingValues as RoleRouting, env };
}
