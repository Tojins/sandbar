#!/usr/bin/env node
// `npm run reflect` (#182, #207): mine one installation's run records for
// recurring corrections into a local report. A repo script like `npm run
// stats` (#194), started by a human and never by the daemon: `cli.ts` does not
// dispatch it, `index.ts` does not export it, and nothing in the daemon
// imports a `reflect-*` module. On the box it runs from a build:
//
//   node /opt/sandbar/builds/<sha>/dist/reflect-cli.js --no-agents \
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
// renders only its tables. It is the only mode until the tagger and
// synthesizer land (#208), so it is required, and a run without it means the
// same thing before and after. A bad flag exits 2.
//
// It reads the records through #194 only, with prose, and writes one file:
// the report, under `<stateDir>/reflect/` (tmp + rename), named by
// `reportFileName` so a re-run over the same window rewrites the same bytes.
// It prints the report, then its path. No GitHub call, no other write.

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig, withDefaultCwd } from "./cli.js";
import { resolveConfig } from "./config.js";
import { isParseArgsError } from "./errors.js";
import { loadTemplate } from "./prompts.js";
import { mine } from "./reflect-mine.js";
import { renderReport, reportFileName } from "./reflect-report.js";
import { repoLayout } from "./repo-cache.js";
import { repoSlug } from "./repo-ref.js";
import { computeStats } from "./stats.js";
import { parseStatsWindow, readStatsInput, type StatsWindow } from "./stats-record.js";

const USAGE =
  "usage: reflect-cli.js --no-agents [--config <path>] [--logs <dir>] [--last N | --since YYYY-MM-DD]\n" +
  "       npm run reflect -- --no-agents […]";

type ReflectArgs = {
  readonly config: string;
  readonly logs: string | undefined;
  readonly window: StatsWindow;
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
  if (!values["no-agents"]) {
    return { error: "the tagger and synthesizer are not built yet (#208); pass --no-agents" };
  }
  const window = parseStatsWindow(values);
  if ("error" in window) return window;
  return { config: values.config, logs: values.logs, window };
}

const args = parseReflectArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(`${args.error}\n${USAGE}`);
  process.exitCode = 2;
} else {
  const configPath = resolve(args.config);
  const config = resolveConfig(withDefaultCwd(await loadConfig(configPath), configPath));
  const layout = repoLayout(config.cwd, config.workDir);
  const logsDir = resolve(args.logs ?? layout.logsDir);
  const stats = computeStats(await readStatsInput(logsDir, args.window, { withProse: true }));
  const report = renderReport({
    stats,
    mining: mine(stats, { quality: loadTemplate("coding-standards") }),
    // Only a tagged bucket can show a rule unused, and no agent ran.
    candidates: [],
    logsDir,
    repo: repoSlug({ owner: config.ghOwner, name: config.ghRepo }),
  });
  const dir = join(layout.stateDir, "reflect");
  await mkdir(dir, { recursive: true });
  const path = join(dir, reportFileName(stats, report));
  const incoming = `${path}.tmp-${process.pid}`;
  await writeFile(incoming, report);
  await rename(incoming, path);
  process.stdout.write(`${report}\n${path}\n`);
}
