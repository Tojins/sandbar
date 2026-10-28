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

import { loadConfig, withDefaultCwd } from "./cli.js";
import { resolveConfig } from "./config.js";
import { SandbarError } from "./errors.js";
import { LockHeldError } from "./lock.js";
import { USAGE, type ReplayArgs, parseReplayArgs } from "./replay-args.js";
import { freeze, runReplay } from "./replay-run.js";

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
