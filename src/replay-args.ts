// `npm run replay`'s command line (#195), parsed with no side effects so it
// can be table-tested; `replay-cli.ts` is the entry point that runs it. Bad
// arguments come back as a message, never thrown: the CLI answers them with
// exit 2.

import { parseArgs } from "node:util";

import { isParseArgsError } from "./errors.js";

export const USAGE =
  "usage: replay-cli.js freeze --issues <n,n…> --logs <dir> --out <file> [--config <path>]\n" +
  "       replay-cli.js run --cases <file> --label <name> [--repeat k] [--parallel P] [--config <path>]\n" +
  "       replay-cli.js report <sessionDir>… [--json]\n" +
  "       npm run replay -- <verb> […]";

export type ReplayArgs =
  | {
      readonly verb: "freeze";
      readonly config: string;
      readonly issues: readonly number[];
      readonly logs: string;
      readonly out: string;
    }
  | {
      readonly verb: "run";
      readonly config: string;
      readonly cases: string;
      readonly label: string;
      readonly repeat: number;
      readonly parallel: number;
    }
  | {
      readonly verb: "report";
      readonly sessions: readonly string[];
      readonly json: boolean;
    };

const COUNT = /^[1-9][0-9]*$/;
const CONFIG = { type: "string", default: "./sandbar.config.mjs" } as const;

// One verb's flags, or why they are not.
function flagsOf<T>(parse: () => T): T | { readonly error: string } {
  try {
    return parse();
  } catch (err) {
    if (!isParseArgsError(err)) throw err;
    return { error: err.message };
  }
}

function parseFreezeArgs(argv: readonly string[]): ReplayArgs | { readonly error: string } {
  const flags = flagsOf(() => parseArgs({
    args: [...argv],
    options: { config: CONFIG, issues: { type: "string" }, logs: { type: "string" }, out: { type: "string" } },
    strict: true,
    allowPositionals: false,
  }));
  if ("error" in flags) return flags;
  const { config, issues, logs, out } = flags.values;
  if (issues === undefined || logs === undefined || out === undefined) {
    return { error: "freeze needs --issues, --logs and --out" };
  }
  const numbers = issues.split(",");
  if (!numbers.every((issue) => COUNT.test(issue)) || new Set(numbers).size !== numbers.length) {
    return { error: "--issues wants distinct issue numbers, comma-separated" };
  }
  return { verb: "freeze", config, issues: numbers.map(Number), logs, out };
}

function parseRunArgs(argv: readonly string[]): ReplayArgs | { readonly error: string } {
  const flags = flagsOf(() => parseArgs({
    args: [...argv],
    options: {
      config: CONFIG,
      cases: { type: "string" },
      label: { type: "string" },
      repeat: { type: "string", default: "1" },
      parallel: { type: "string", default: "1" },
    },
    strict: true,
    allowPositionals: false,
  }));
  if ("error" in flags) return flags;
  const { config, cases, label, repeat, parallel } = flags.values;
  if (cases === undefined || label === undefined) return { error: "run needs --cases and --label" };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) {
    return { error: "--label wants a name of letters, digits, '.', '_' and '-'" };
  }
  if (!COUNT.test(repeat) || !COUNT.test(parallel)) {
    return { error: "--repeat and --parallel want positive counts" };
  }
  return { verb: "run", config, cases, label, repeat: Number(repeat), parallel: Number(parallel) };
}

function parseReportArgs(argv: readonly string[]): ReplayArgs | { readonly error: string } {
  const flags = flagsOf(() => parseArgs({
    args: [...argv],
    options: { json: { type: "boolean", default: false } },
    strict: true,
    allowPositionals: true,
  }));
  if ("error" in flags) return flags;
  if (flags.positionals.length === 0) return { error: "report needs at least one session directory" };
  return { verb: "report", sessions: flags.positionals, json: flags.values.json };
}

export function parseReplayArgs(argv: readonly string[]): ReplayArgs | { readonly error: string } {
  const [verb, ...rest] = argv;
  if (verb === "freeze") return parseFreezeArgs(rest);
  if (verb === "run") return parseRunArgs(rest);
  if (verb === "report") return parseReportArgs(rest);
  return { error: `unknown verb ${verb ?? "(none)"}` };
}
