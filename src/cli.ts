#!/usr/bin/env node
// The `sandbar` bin (#38).
//
// Sandbar is a library WITH a bin, not a CLI with an API: `run(config)` is
// still the contract and `index.ts` is unchanged. What the bin removes is the
// per-host entry-point file. Before it, being a library meant every consumer
// authored and committed its own runner — which is how a repo ends up with a
// `sandbar/` directory beside its `.sandbar/` one, two sandbar directories in a
// root for a package that should need neither.
//
// It is thin because `run()` is already CLI-shaped: it owns its exit codes and
// carries the top-level handler that prints a `SandbarError` as its message
// alone and anything else with a stack. The only thing this file adds is that
// same treatment for throws that escape BEFORE that handler exists — chiefly
// `resolveConfig`'s validation, which fires before the lock. That is package
// code, not copy-paste every host maintains its own drifting copy of.
//
// ---------------------------------------------------------------------------
// The four constraints, written down so they are decisions and not drift
// ---------------------------------------------------------------------------
//   - EXACTLY ONE flag that carries configuration: `--config`. Every flag that
//     duplicates a config field creates a second source of truth, which is the
//     thing this issue removes. `--help` and `--version` duplicate nothing and
//     answer questions the config cannot, so they are not exceptions to that
//     rule — there is still only one way to configure a run. Neither are
//     `gate`'s `--worktree` and `--keep` (#45), and it is worth saying why,
//     because a subcommand with flags is what that rule looks like breaking:
//     a run derives the tree it gates from an issue branch and tears the stack
//     down with the issue, so there is no `RunConfig` field for either to
//     duplicate. They name what a stack-only invocation has to be told and the
//     config has no opinion about.
//   - NO config search up the directory tree. `./sandbar.config.mjs` or an
//     explicit path. "Which config did it find" is not a question worth the
//     ergonomics, and an ambiguous answer to it is a run against the wrong
//     repo.
//   - `.mjs`, not `.ts`. `engines` is node >= 20, which cannot import
//     TypeScript without a loader. The file is imported, not parsed, so it
//     stays a PROGRAM: computed image tags, a gate stack read from JSON, a
//     shared constant — all of it survives, the way vite.config.js and
//     eslint.config.js do and package.json does not.
//   - The default export is the config OBJECT. A zero-argument factory is not
//     accepted, and the refusal is deliberate rather than lazy: config files
//     are ESM and may use top-level await, so a factory buys nothing and would
//     leave two shapes for a consumer to guess between.
//
// `cwd` is where the prize is. It defaults to the directory holding the
// resolved config file, not to `process.cwd()` — so "you must launch sandbar
// from the repo it operates on" is not fixed, it is unreachable. There is
// nowhere to launch from that gets it wrong. `resolveConfig` keeps
// `process.cwd()` as its own default for programmatic callers, which is right
// for them and wrong here.

import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { RunConfig } from "./config.js";
import { SandbarError } from "./errors.js";
import { GATE_EXIT_NO_VERDICT, runGateCommand } from "./gate-run.js";
import { run } from "./run.js";
import { sandbarVersion } from "./version.js";

const DEFAULT_CONFIG_FILE = "sandbar.config.mjs";

// The one subcommand (#45). A literal rather than a registry: sandbar has one
// verb and one noun, and a dispatch table for two entries is scaffolding for a
// third that does not exist.
const GATE_SUBCOMMAND = "gate";

const USAGE = `Usage: sandbar [--config <path>]
       sandbar gate [--config <path>] [--worktree <path>] [--keep]

  --config <path>   Config file to load. Default: ./${DEFAULT_CONFIG_FILE}
                    (resolved against the current directory). The file is an
                    ES module whose default export is the RunConfig object.
                    Its directory becomes \`cwd\` unless the config sets one.
  --version         Print sandbar's version.
  --help            Print this message.

\`sandbar\` runs the full agent loop. \`sandbar gate\` runs config.gateStack
against one worktree and nothing else — no tracker, no agents, no lock — and
exits 0 green, 1 red, 2 if it could not reach a verdict. It is what a laptop and
a CI job run, so the gate has one implementation.

  --worktree <path> The tree to gate. Default: the current directory.
  --keep            Leave the stack up afterwards, to inspect a red gate. The
                    next \`sandbar gate\` over the same worktree then reuses its
                    issue-lifecycle containers instead of recreating them.

Everything else is configured in that file — see the RunConfig type.`;

export type ParsedArgs =
  | { readonly kind: "run"; readonly configPath: string }
  | {
      readonly kind: "gate";
      readonly configPath: string;
      readonly worktree: string;
      readonly keep: boolean;
    }
  | { readonly kind: "help" }
  | { readonly kind: "version" };

// Pure, so the argv contract is table-testable rather than only reachable by
// launching a process. Throws SandbarError on anything it does not accept: a
// mistyped flag must not be silently ignored and then run the default config
// against the wrong repo.
export function parseArgs(argv: readonly string[]): ParsedArgs {
  // A subcommand only in FIRST position, and only the exact word. `sandbar
  // --config x gate` is rejected rather than accepted-and-ignored, for the same
  // reason a mistyped flag is: the two spellings would do entirely different
  // things and the wrong one is a full agent run against a repo the operator
  // meant to spot-check.
  const isGate = argv[0] === GATE_SUBCOMMAND;
  const rest = isGate ? argv.slice(1) : argv;

  let configPath: string | null = null;
  let worktree: string | null = null;
  let keep = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--version" || arg === "-v") return { kind: "version" };
    if (arg === "--config") {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new SandbarError(`--config needs a path.\n\n${USAGE}`);
      }
      configPath = value;
      i++;
      continue;
    }
    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (!value) throw new SandbarError(`--config needs a path.\n\n${USAGE}`);
      configPath = value;
      continue;
    }
    // Gate-only flags are rejected on the run path by NAME rather than falling
    // through to "unrecognised": `sandbar --keep` is someone who meant
    // `sandbar gate --keep`, and telling them so beats a usage dump.
    if (arg === "--worktree" || arg.startsWith("--worktree=") || arg === "--keep") {
      if (!isGate) {
        throw new SandbarError(
          `'${arg}' is a \`sandbar gate\` flag; a run has no stack of its own ` +
            `to point at or keep. Did you mean \`sandbar ${GATE_SUBCOMMAND} ` +
            `${arg}\`?\n\n${USAGE}`,
        );
      }
      if (arg === "--keep") {
        keep = true;
        continue;
      }
      if (arg === "--worktree") {
        const value = rest[i + 1];
        if (value === undefined || value.startsWith("-")) {
          throw new SandbarError(`--worktree needs a path.\n\n${USAGE}`);
        }
        worktree = value;
        i++;
        continue;
      }
      const value = arg.slice("--worktree=".length);
      if (!value) throw new SandbarError(`--worktree needs a path.\n\n${USAGE}`);
      worktree = value;
      continue;
    }
    throw new SandbarError(
      `Unrecognised argument '${arg}'.\n\n${USAGE}`,
    );
  }
  const resolvedConfigPath = configPath ?? DEFAULT_CONFIG_FILE;
  return isGate
    ? {
        kind: "gate",
        configPath: resolvedConfigPath,
        worktree: worktree ?? ".",
        keep,
      }
    : { kind: "run", configPath: resolvedConfigPath };
}

// Exported for cli.test.ts: every branch below is an operator-facing message
// on a path that only ever fires against a real file on disk.
export async function loadConfig(configPath: string): Promise<RunConfig> {
  if (!existsSync(configPath)) {
    throw new SandbarError(
      `No sandbar config at ${configPath}.\n` +
        `Create a \`${DEFAULT_CONFIG_FILE}\` at the root of the repo sandbar ` +
        "should work on (its default export is the RunConfig object), or pass " +
        "`--config <path>`. Sandbar does not search parent directories.",
    );
  }
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(configPath).href)) as { default?: unknown };
  } catch (err) {
    throw new SandbarError(
      `Failed to load the sandbar config at ${configPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  const config = mod.default;
  if (config === undefined) {
    throw new SandbarError(
      `${configPath} has no default export. Sandbar reads the config from ` +
        "`export default { … }`.",
    );
  }
  if (typeof config === "function") {
    throw new SandbarError(
      `${configPath} default-exports a function. Sandbar imports the config ` +
        "rather than calling it — config files are ES modules and may use " +
        "top-level await, so export the object itself.",
    );
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new SandbarError(
      `${configPath} default-exports a ${Array.isArray(config) ? "array" : typeof config}. ` +
        "Sandbar expects the RunConfig object.",
    );
  }
  return config as RunConfig;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === "help") {
    console.log(USAGE);
    return 0;
  }
  if (parsed.kind === "version") {
    console.log(sandbarVersion());
    return 0;
  }
  // Against the process cwd, which is the one thing a shell invocation can
  // reasonably mean by a relative path — and the last place process.cwd() is
  // allowed to decide anything. From here on `cwd` is the config's directory.
  const configPath = resolve(process.cwd(), parsed.configPath);
  if (parsed.kind === "gate") {
    // Everything from here down exits `GATE_EXIT_NO_VERDICT`, config faults
    // included — a `sandbar gate` that never reached a verdict must never
    // report one of the two codes that IS a verdict, and to a CI job a config
    // typo and an unbuildable image are the same "we do not know" (#45).
    // Argument faults are the exception and stay on the outer handler's 1:
    // they are answered before any config is loaded, they are the operator's
    // shell rather than their repo, and a usage error exiting like a gate
    // outcome is its own confusion.
    try {
      // `--worktree` stays relative to the process cwd, NOT to the config's
      // directory. `cwd`'s default is the config's directory because a run
      // operates on the repo the config sits in and there is no other
      // candidate; a worktree is a path the operator typed at a shell, and
      // re-rooting it somewhere else is the class of surprise this file exists
      // to remove.
      return await runGateCommand(
        withDefaultCwd(await loadConfig(configPath), configPath),
        { worktree: parsed.worktree, keep: parsed.keep },
      );
    } catch (err) {
      console.error(faultDetail(err));
      return GATE_EXIT_NO_VERDICT;
    }
  }
  // `run()` owns its own exit codes and calls `process.exit` for anything
  // non-zero, so there is no code to return here.
  await run(withDefaultCwd(await loadConfig(configPath), configPath));
  return 0;
}

// How a fault is rendered, in both handlers below and in the gate branch above.
// Same rule as run.ts's: an operator-actionable SandbarError prints as its
// message alone, anything else prints a stack, because an unexpected bug that
// prints like a config error is a bug nobody can locate.
function faultDetail(err: unknown): string {
  return err instanceof SandbarError
    ? err.message
    : err instanceof Error
      ? (err.stack ?? err.message)
      : String(err);
}

// The bin's whole prize, and the reason it is a function rather than three
// lines inside `main`: `cwd` defaults to the directory the CONFIG FILE sits
// in, not to wherever the operator's shell happened to be. That is what makes
// "you must launch sandbar from the repo" unreachable instead of merely
// documented — and it is invisible to any test that runs from the same
// directory it configures, which is why it is pinned separately.
//
// Not a spread with the default first: a config that names `cwd: undefined`
// explicitly would overwrite it and fall through to `process.cwd()`, which is
// the exact behaviour this default exists to make unreachable.
export function withDefaultCwd(
  config: RunConfig,
  configPath: string,
): RunConfig {
  return config.cwd === undefined
    ? { ...config, cwd: dirname(configPath) }
    : config;
}

// Only when this file IS the program. Without the guard, importing the module
// — which `cli.test.ts` does to table-test `parseArgs` — launches a run against
// whatever config happens to sit in the importer's directory, and then calls
// `process.exit`. `realpathSync` on both sides because npm installs the bin as
// a symlink in `node_modules/.bin`.
function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// `run()` handles its own faults and exits; this catches what escapes before
// it installs that handler — and, since #45, whatever `main` returns, because
// `sandbar gate` reports its verdict as an exit code and has nobody else to
// report it to.
if (isEntrypoint()) {
  main()
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err: unknown) => {
      console.error(faultDetail(err));
      process.exit(1);
    });
}
