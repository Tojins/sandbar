#!/usr/bin/env node
// The self-hosted launcher (#66, #39).
//
// `npm run sandbar` used to be one shell line: pull --ff-only, build, run, loop
// on 75. Everything after the pull ran out of the operator's WORKING TREE —
// `build` is `rm -rf dist && tsc` over `src/`, uncommitted edits included — so
// the driver of an unattended series was whatever a human happened to have
// saved, not a commit. On 2026-08-31 both halves of that fired at once: the
// pull failed on one unpushed local commit and stopped a series (the cheap
// form), while the same checkout held uncommitted edits to `gate-stack.ts` and
// to `sandbar.config.mjs` that a successful pull would have promoted into the
// driver and the gate stack (the expensive form, silent).
//
// So this repo now drives itself the way README documents for every consumer:
// from an INSTALLED, PINNED release. `sandbar.pin` names a tag, `npm install`
// puts it in `.sandbar/driver/`, and that is what runs. There is no pull to
// fail and no working tree to inherit.
//
// WHAT STILL COMES FROM THE CHECKOUT, stated rather than glossed: the config
// file, `sandbar.env` beside it, and this launcher. The config must — it
// resolves against the process cwd and `sandbar.env` against its own
// `import.meta.url` — so "the run is driven by a pinned commit" is precisely
// true of the orchestrator and its prompts, and NOT of `gateStack`. The guard
// for the seam that opens between them is `requiresSandbar`
// (`requires-sandbar.ts`): a config newer than the driver is refused by name
// instead of being read half-way. What a dirty config still buys an operator is
// visible on the run's first line, which names the config's path and whether
// its tree is dirty (#69).
//
// FOUR DECISIONS, so they are decisions and not drift:
//
//   - INSTALL LOCATION `.sandbar/driver/`, not a devDependency of this repo. A
//     devDependency would be dragged into every issue worktree by
//     `onWorktreeReady`'s `npm ci` and bind-mounted into every gate container,
//     taxing every run with a dependency the judged code never imports. Under
//     `.sandbar/` it is `node_modules`-shaped: gitignored, deletable, costing
//     time and never correctness.
//   - THE PIN IS COMMITTED, at the repo root, because `.sandbar/` is disposable
//     and a decision cannot live somewhere `rm -rf` is a supported operation.
//     A plain file rather than a config field: this script has to read it
//     BEFORE the driver exists, and `sandbar.config.mjs` imports the driver.
//   - INSTALL ONLY WHEN THE PIN MOVES. The stamp beside the install records the
//     spec that produced it; a matching stamp with the bin present is skipped,
//     so a relaunch re-runs a byte-identical driver and costs no network. The
//     stamp is REMOVED before an install and written only after one that
//     produced a bin, so an interrupted or failed install can never be mistaken
//     for a complete one.
//   - A FAILED INSTALL STOPS THE LOOP. Never silently continue on the driver
//     that happens to be on disk: "could not fetch the pin" and "the pin is
//     installed" are different states and only one of them may run. A
//     zero-exit install with no bin behind it counts as failed — the package
//     ships no build, `dist/` comes out of its `prepare` script, and npm is
//     moving install scripts behind per-project approval.
//
// Plain `.mjs` under `scripts/`, outside `files` and outside `src/`: it is not
// part of the package, no consumer runs it, and it must run before anything is
// built. `launcher.test.ts` covers its decisions, which is why they are
// exported pure functions and why `main()` runs only when this file IS the
// program.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Repeated by hand from `exit-conditions.ts` for the same reason the old shell
// loop repeated it: this file runs before the package it would import exists.
export const EXIT_CODE_RELAUNCH = 75;

export const PIN_FILE = "sandbar.pin";

// `github:<owner>/<repo>#v<major>.<minor>.<patch>` and nothing else. A branch
// or a sha would install perfectly well and is refused anyway: a sha names a
// state no consumer could ever reference, and a branch is not a pin at all —
// it moves under the loop, which is the entire failure this file exists to
// remove.
const PIN_PATTERN = /^github:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#v\d+\.\d+\.\d+$/;

export class LaunchError extends Error {}

// Comments are lines whose FIRST character is `#`; the spec's own `#` is what
// separates the repo from the tag, so it cannot be a mid-line comment marker.
export function parsePin(content) {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.length === 0) {
    throw new LaunchError(
      `${PIN_FILE} names no driver. It must contain one npm spec line, ` +
        "`github:<owner>/<repo>#v<X.Y.Z>`.",
    );
  }
  if (lines.length > 1) {
    throw new LaunchError(
      `${PIN_FILE} has ${lines.length} spec lines (${lines.join(", ")}). ` +
        "Exactly one release drives a run; there is no fallback to a second.",
    );
  }
  const spec = lines[0];
  if (!PIN_PATTERN.test(spec)) {
    throw new LaunchError(
      `${PIN_FILE} does not name a tagged release: '${spec}'.\n` +
        "It must be `github:<owner>/<repo>#v<X.Y.Z>` — a tag, as a consumer " +
        "would pin. A branch moves under the loop and a sha names a state no " +
        "consumer could reference, so neither is accepted as a substitute.",
    );
  }
  return spec;
}

// Every path this script touches, derived once from the repo root.
export function driverPaths(root) {
  const dir = join(root, ".sandbar", "driver");
  const pkg = join(dir, "node_modules", "@offergeist", "sandbar");
  return {
    dir,
    pkg,
    // The bin, run directly rather than through `node_modules/.bin/sandbar`:
    // the symlink is one more thing that can be absent on a half-install, and
    // the file it points at is the thing that has to exist.
    cli: join(pkg, "dist", "cli.js"),
    manifest: join(dir, "package.json"),
    stamp: join(dir, "installed-pin"),
  };
}

// Pure: the two facts about what is on disk, against what is asked for.
export function installNeeded(state, spec) {
  if (!state.cliPresent) return true;
  return state.installedSpec !== spec;
}

// `--prefix` rather than a cwd, so npm treats the driver directory as its own
// project and this repo's `package.json` is never the one being installed into.
// The driver's manifest is named `sandbar-driver`, not `@offergeist/sandbar`,
// which also keeps the install clear of npm's self-dependency rules entirely.
export function installArgv(dir, spec) {
  return ["install", "--prefix", dir, "--no-audit", "--no-fund", spec];
}

export function readInstallState(paths) {
  let installedSpec = null;
  try {
    installedSpec = readFileSync(paths.stamp, "utf8").trim();
  } catch {
    installedSpec = null;
  }
  return { cliPresent: existsSync(paths.cli), installedSpec };
}

function say(message) {
  console.log(`sandbar launcher: ${message}`);
}

function installDriver(paths, spec) {
  mkdirSync(paths.dir, { recursive: true });
  // Only when it is absent, and that is not an optimisation. npm is moving
  // install scripts behind per-project approval, and `npm approve-scripts`
  // records the approval as an `allowScripts` entry in exactly this file — so a
  // manifest rewritten on every install would erase, every time, the one thing
  // that makes the next install able to build `dist/`. What sandbar needs the
  // file for is settled by its existence: a named, private project root, so npm
  // installs into this directory rather than synthesising something for a
  // directory that has none.
  if (!existsSync(paths.manifest)) {
    writeFileSync(
      paths.manifest,
      `${JSON.stringify(
        {
          name: "sandbar-driver",
          version: "0.0.0",
          private: true,
          description:
            "Install root for the pinned sandbar that drives this repo (#66). Disposable; the pin lives in sandbar.pin.",
        },
        null,
        2,
      )}\n`,
    );
  }
  rmSync(paths.stamp, { force: true });
  say(`installing ${spec} into ${paths.dir}`);
  const result = spawnSync("npm", installArgv(paths.dir, spec), {
    stdio: "inherit",
  });
  if (result.error) {
    throw new LaunchError(
      `could not run npm to install ${spec}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new LaunchError(
      `npm install of ${spec} failed (exit ${result.status ?? "signal"}).\n` +
        "The loop stops here rather than continuing on whichever driver is on " +
        "disk. Usual causes: the tag does not exist yet (it is created by " +
        "auto-tag.yml on the push to main that lands the version), or the host " +
        "cannot reach GitHub.",
    );
  }
  // The one check that separates "npm exited 0" from "there is a driver". The
  // package has no published build: `dist/` is produced by its `prepare`
  // script, which npm is in the middle of moving behind per-project approval
  // (`npm warn allow-scripts …` today, refusal later). An install that skipped
  // scripts exits 0 and leaves a package with `src/` and no bin, which without
  // this check would be stamped as installed and then run as `node <missing>`.
  if (!existsSync(paths.cli)) {
    throw new LaunchError(
      `npm install of ${spec} reported success, but ${paths.cli} is missing.\n` +
        "The package has no published build — `dist/` comes from its `prepare` " +
        "script — so this is an install whose scripts did not run. Approve them " +
        `for this install root and try again:\n\n` +
        `  npm approve-scripts --prefix ${paths.dir} @offergeist/sandbar\n`,
    );
  }
  writeFileSync(paths.stamp, `${spec}\n`);
}

// Reads the pin, brings the driver into line with it, and answers where it is.
export function ensureDriver(root) {
  const pinPath = join(root, PIN_FILE);
  let content;
  try {
    content = readFileSync(pinPath, "utf8");
  } catch (err) {
    throw new LaunchError(
      `cannot read ${pinPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const spec = parsePin(content);
  const paths = driverPaths(root);
  if (installNeeded(readInstallState(paths), spec)) {
    installDriver(paths, spec);
  } else {
    say(`driver ${spec} already installed at ${paths.dir}`);
  }
  return { spec, cli: paths.cli };
}

export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function main(argv) {
  const root = repoRoot();
  // `--install-only` is for the hand paths — `sandbar gate`, or a config load —
  // which need the driver present but are not a series. Deliberately not a
  // `--config`-style flag: it configures nothing, it stops the loop before it
  // starts.
  const installOnly = argv.includes("--install-only");
  const forwarded = argv.filter((arg) => arg !== "--install-only");
  for (;;) {
    // Re-read every iteration, so a pin edited between cycles is honoured at
    // the next relaunch rather than at the next series.
    const { spec, cli } = ensureDriver(root);
    if (installOnly) return 0;
    say(`running ${spec}`);
    const child = spawnSync(process.execPath, [cli, ...forwarded], {
      cwd: root,
      stdio: "inherit",
    });
    if (child.error) {
      throw new LaunchError(`could not run ${cli}: ${child.error.message}`);
    }
    if (child.status === null) {
      throw new LaunchError(
        `the driver was killed by ${child.signal ?? "a signal"}.`,
      );
    }
    if (child.status !== EXIT_CODE_RELAUNCH) return child.status;
    say(`relaunching (exit ${EXIT_CODE_RELAUNCH})`);
  }
}

// Only when this file IS the program — `launcher.test.ts` imports it for the
// pure functions above, and an import that launched a series would be its own
// kind of #66.
function isEntrypoint() {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return resolve(argv1) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(
        `sandbar launcher: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    });
}
