#!/usr/bin/env node
// `npm run stats` (#194): the factory scorecard over one installation's run
// records. A repo script, not a `sandbar` verb (#80): `cli.ts` does not
// dispatch it and `index.ts` does not export it, so it is no output contract
// for a consumer. On the box it runs from a build:
//
//   node /opt/sandbar/builds/<sha>/dist/stats-cli.js --logs <workdir>/logs
//
// `--logs <dir>` defaults to `./.sandbar/logs`; `--last N` or
// `--since YYYY-MM-DD` picks the window (the last 10 runs by default);
// `--json` prints the `StatsReport` instead of its tables; `--with-prose`
// adds each invocation's speech and each issue's last terminal reason. An
// empty or missing logs directory prints the zero-run report. A bad flag
// exits 2.

import { parseArgs } from "node:util";

import { computeStats, renderStatsTables } from "./stats.js";
import { DEFAULT_STATS_WINDOW, readStatsInput, type StatsWindow } from "./stats-record.js";

const USAGE =
  "usage: stats-cli.js [--logs <dir>] [--last N | --since YYYY-MM-DD] [--json] [--with-prose]";

type StatsArgs = {
  readonly logs: string;
  readonly window: StatsWindow;
  readonly json: boolean;
  readonly withProse: boolean;
};

// How parseArgs names an unknown or malformed flag.
const isParseArgsError = (err: unknown): err is TypeError =>
  err instanceof TypeError && "code" in err &&
  String(err.code).startsWith("ERR_PARSE_ARGS_");

function parseStatsArgs(argv: readonly string[]): StatsArgs | { readonly error: string } {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        logs: { type: "string", default: "./.sandbar/logs" },
        last: { type: "string" },
        since: { type: "string" },
        json: { type: "boolean", default: false },
        "with-prose": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    if (!isParseArgsError(err)) throw err;
    return { error: err.message };
  }
  if (values.last !== undefined && values.since !== undefined) {
    return { error: "--last and --since are exclusive" };
  }
  let window = DEFAULT_STATS_WINDOW;
  if (values.last !== undefined) {
    if (!/^[1-9][0-9]*$/.test(values.last)) return { error: `--last wants a positive count, not ${values.last}` };
    window = { last: Number(values.last) };
  }
  if (values.since !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.since)) return { error: `--since wants YYYY-MM-DD, not ${values.since}` };
    window = { since: values.since };
  }
  return { logs: values.logs, window, json: values.json, withProse: values["with-prose"] };
}

const args = parseStatsArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(`${args.error}\n${USAGE}`);
  process.exitCode = 2;
} else {
  const report = computeStats(
    await readStatsInput(args.logs, args.window, { withProse: args.withProse }),
  );
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderStatsTables(report));
}
