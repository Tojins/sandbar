#!/usr/bin/env node
// `npm run reflect` (#182, #207, #208): mine one installation's run records
// for recurring corrections into a local report of proposals. A repo script like `npm run
// stats` (#194), started by a human and never by the daemon: `cli.ts` does not
// dispatch it, `index.ts` does not export it, and nothing in the daemon
// imports a `reflect-*` module. On the box it runs from a build:
//
//   node /opt/sandbar/builds/<sha>/dist/reflect-cli.js \
//     --config ~/installation/sandbar.config.mjs
//
// Through npm the flags follow `--` (`npm run reflect -- --no-agents`), since
// npm keeps a bare `--no-agents` as its own config.
//
// `--config` (default `./sandbar.config.mjs`, loaded as `sandbar` loads it)
// supplies the state directory and the `owner/repo` of the citations.
// `--logs <dir>` defaults to `<stateDir>/logs`, and any record tree works;
// `--last N` or `--since YYYY-MM-DD` picks the window as #194 does.
// `--no-agents` stops after the deterministic pass (`reflect-mine.ts`) and
// renders only its tables; without it the tagger and synthesizer run
// (`reflect.ts`). A bad flag exits 2; a fault that stops the agents (a quota,
// a credential, podman, an unbuilt image) exits 1 with no report.
//
// It reads the records through #194 only, with prose. It writes the report
// under `<stateDir>/reflect/`, named by `reportFileName` so a re-run over
// the same window rewrites the same bytes, plus reflect's own cache and
// throwaway workspace beside it. It prints the report, then its path, and
// each agent step's progress on stderr. No GitHub call, no other write.

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig, withDefaultCwd } from "./cli.js";
import { resolveConfig } from "./config.js";
import { faultDetail, isParseArgsError } from "./errors.js";
import { reflect } from "./reflect.js";
import { repoLayout } from "./repo-cache.js";
import { parseStatsWindow, type StatsWindow } from "./stats-record.js";

const USAGE =
  "usage: reflect-cli.js [--no-agents] [--config <path>] [--logs <dir>] [--last N | --since YYYY-MM-DD]\n" +
  "       npm run reflect -- […]";

type ReflectArgs = {
  readonly config: string;
  readonly logs: string | undefined;
  readonly window: StatsWindow;
  readonly agents: boolean;
};

function parseReflectArgs(argv: readonly string[]): ReflectArgs | { readonly error: string } {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        config: { type: "string", default: "./sandbar.config.mjs" },
        logs: { type: "string" },
        last: { type: "string" },
        since: { type: "string" },
        "no-agents": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    if (!isParseArgsError(err)) throw err;
    return { error: err.message };
  }
  const window = parseStatsWindow(values);
  if ("error" in window) return window;
  return { config: values.config, logs: values.logs, window, agents: !values["no-agents"] };
}

const args = parseReflectArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(`${args.error}\n${USAGE}`);
  process.exitCode = 2;
} else {
  const configPath = resolve(args.config);
  try {
    const config = resolveConfig(withDefaultCwd(await loadConfig(configPath), configPath));
    const { reportPath, report } = await reflect(config, {
      logsDir: resolve(args.logs ?? repoLayout(config.cwd, config.workDir).logsDir),
      window: args.window,
      agents: args.agents,
      log: (line) => console.error(`reflect: ${line}`),
    });
    process.stdout.write(`${report}\n${reportPath}\n`);
  } catch (err) {
    console.error(faultDetail(err));
    process.exitCode = 1;
  }
}
