#!/usr/bin/env node
// Sandbar's structural checks (#183): rules settled by a script at zero
// tokens instead of by prose an agent is asked to follow. Each check is a
// step of sandbar's own gate (deploy/ansible/installations/sandbar), and the
// step's `settles` drops the matching prose from the prompts:
//
//   version  the branch moves `version` above its base (version.mjs), the
//            `version` step, which settles `commit-ritual`
//
//   node scripts/structure/run.mjs [check…] [--base <ref>] [--git-dir <dir>]
//
// No check named runs every check; `--base` defaults to `origin/main`. The
// repository is the working directory, or `--git-dir` (core.mjs).
//
// Output is compact, because a red reaches the implementer as a gate trace
// and every line of it is context paid for: a red check prints one line per
// finding, a green one its one-line summary. Exit 1 on any finding, 2 when a
// check could not be answered or the arguments are wrong, one line either
// way: never a skip, never fail-open.

import { parseArgs } from "node:util";

import { StructureError } from "./core.mjs";
import { checkVersion } from "./version.mjs";

const CHECKS = { version: checkVersion };

const USAGE = `usage: run.mjs [${Object.keys(CHECKS).join("|")}]… [--base <ref>] [--git-dir <dir>]`;

function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { base: { type: "string", default: "origin/main" }, "git-dir": { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    if (!(err instanceof TypeError && String(err.code).startsWith("ERR_PARSE_ARGS_"))) throw err;
    return { error: err.message };
  }
  const names = parsed.positionals.length === 0 ? Object.keys(CHECKS) : parsed.positionals;
  const unknown = names.find((name) => !Object.hasOwn(CHECKS, name));
  if (unknown !== undefined) return { error: `unknown check '${unknown}'` };
  return {
    names,
    base: parsed.values.base,
    repo: { dir: process.cwd(), gitDir: parsed.values["git-dir"] },
  };
}

// Each named check's lines, and the exit code for all of them.
function runChecks(names, repo, base) {
  const lines = [];
  let exitCode = 0;
  for (const name of names) {
    let result;
    try {
      result = CHECKS[name](repo, base);
    } catch (err) {
      if (!(err instanceof StructureError)) throw err;
      lines.push(`${name}: ${err.message}`);
      exitCode = 2;
      continue;
    }
    if (result.findings.length === 0) {
      lines.push(result.summary);
    } else {
      lines.push(...result.findings);
      exitCode = Math.max(exitCode, 1);
    }
  }
  return { lines, exitCode };
}

const args = parse(process.argv.slice(2));
if ("error" in args) {
  console.log(`${args.error}; ${USAGE}`);
  process.exitCode = 2;
} else {
  const { lines, exitCode } = runChecks(args.names, args.repo, args.base);
  console.log(lines.join("\n"));
  process.exitCode = exitCode;
}
