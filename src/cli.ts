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
//     rule — there is still only one way to configure a run.
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
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { RunConfig } from "./config.js";
import { SandbarError } from "./errors.js";
import { run } from "./run.js";

const DEFAULT_CONFIG_FILE = "sandbar.config.mjs";

const USAGE = `Usage: sandbar [--config <path>]

  --config <path>   Config file to load. Default: ./${DEFAULT_CONFIG_FILE}
                    (resolved against the current directory). The file is an
                    ES module whose default export is the RunConfig object.
                    Its directory becomes \`cwd\` unless the config sets one.
  --version         Print sandbar's version.
  --help            Print this message.

Everything else is configured in that file — see the RunConfig type.`;

export type ParsedArgs =
  | { readonly kind: "run"; readonly configPath: string }
  | { readonly kind: "help" }
  | { readonly kind: "version" };

// Pure, so the argv contract is table-testable rather than only reachable by
// launching a process. Throws SandbarError on anything it does not accept: a
// mistyped flag must not be silently ignored and then run the default config
// against the wrong repo.
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let configPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--version" || arg === "-v") return { kind: "version" };
    if (arg === "--config") {
      const value = argv[i + 1];
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
    throw new SandbarError(
      `Unrecognised argument '${arg}'.\n\n${USAGE}`,
    );
  }
  return { kind: "run", configPath: configPath ?? DEFAULT_CONFIG_FILE };
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

function version(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === "help") {
    console.log(USAGE);
    return;
  }
  if (parsed.kind === "version") {
    console.log(version());
    return;
  }
  // Against the process cwd, which is the one thing a shell invocation can
  // reasonably mean by a relative path — and the last place process.cwd() is
  // allowed to decide anything. From here on `cwd` is the config's directory.
  const configPath = resolve(process.cwd(), parsed.configPath);
  await run(withDefaultCwd(await loadConfig(configPath), configPath));
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
// it installs that handler. Same rule as run.ts's: an operator-actionable
// SandbarError prints as its message alone, anything else prints a stack,
// because an unexpected bug that prints like a config error is a bug nobody
// can locate.
if (isEntrypoint()) {
  main().catch((err: unknown) => {
    const detail =
      err instanceof SandbarError
        ? err.message
        : err instanceof Error
          ? (err.stack ?? err.message)
          : String(err);
    console.error(detail);
    process.exit(1);
  });
}
