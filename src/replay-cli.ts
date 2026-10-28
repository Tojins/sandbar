#!/usr/bin/env node
// `npm run replay` (#195): rerun past issues at their seeds to test a harness
// change. A repo script like `npm run stats`, and HUMAN-ONLY: `cli.ts` does not
// dispatch it, `index.ts` does not export it, nothing in the daemon imports a
// `replay*` module, no prompt names it, and AGENTS.md forbids agents to run it.
// It spends real tokens, and there is no "every issue" form.
//
//   freeze --issues 317,412 --logs <dir> --out <file> [--config <path>]
//   run --cases <file> --label <name> [--repeat k] [--parallel P] [--config <path>]
//
// `freeze` spends no tokens: it writes the case file (`replay.ts`) create-only
// from the run records under `--logs` and from git and GitHub. `run` prints
// its plan and starts, with no confirmation, into a new session
// `<workDir>/replay/sessions/<label>/` (`replay-run.ts`). `--repeat` and
// `--parallel` default to 1; `--parallel` is capped at `maxParallelIssues`.
// `--config` defaults to `./sandbar.config.mjs`, loaded as `sandbar` loads it.
// Through npm the flags follow `--`.
//
// Exit 0 ok, 1 refused or failed, 2 bad args, 3 stopped by a quota or
// credential.

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig, withDefaultCwd } from "./cli.js";
import { resolveConfig } from "./config.js";
import { SandbarError, isParseArgsError } from "./errors.js";
import { LockHeldError } from "./lock.js";
import { freeze, runReplay } from "./replay-run.js";

const USAGE =
  "usage: replay-cli.js freeze --issues <n,n…> --logs <dir> --out <file> [--config <path>]\n" +
  "       replay-cli.js run --cases <file> --label <name> [--repeat k] [--parallel P] [--config <path>]\n" +
  "       npm run replay -- <verb> […]";

type ReplayArgs =
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

function parseReplayArgs(argv: readonly string[]): ReplayArgs | { readonly error: string } {
  const [verb, ...rest] = argv;
  if (verb === "freeze") return parseFreezeArgs(rest);
  if (verb === "run") return parseRunArgs(rest);
  return { error: `unknown verb ${verb ?? "(none)"}` };
}

async function replay(args: ReplayArgs): Promise<number> {
  const configPath = resolve(args.config);
  const config = resolveConfig(withDefaultCwd(await loadConfig(configPath), configPath));
  const log = (line: string): void => console.error(line);
  if (args.verb === "freeze") {
    await freeze({ config, issues: args.issues, logsDir: resolve(args.logs), out: resolve(args.out), log });
    return 0;
  }
  return await runReplay({
    config,
    configPath,
    casesFile: args.cases,
    label: args.label,
    repeats: args.repeat,
    parallel: args.parallel,
    log,
  });
}

const args = parseReplayArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(`${args.error}\n${USAGE}`);
  process.exitCode = 2;
} else {
  try {
    process.exitCode = await replay(args);
  } catch (err) {
    if (!(err instanceof SandbarError) && !(err instanceof LockHeldError)) throw err;
    console.error(err.message);
    process.exitCode = 1;
  }
}
