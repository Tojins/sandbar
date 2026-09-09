#!/usr/bin/env node
// The self-hosted launcher (#66, #39, #133).
//
// `sandbar.pin` names the installed release under `.sandbar/driver`; the stamp
// avoids reinstalling an unchanged pin and a failed or bin-less install is
// never stamped. The config still comes from the checkout and
// `requiresSandbar` guards that version seam.
//
// Since #133 sandbar itself is the long-running daemon. This launcher starts it
// exactly once and propagates its status; it has no exit-75 loop and no second
// series wake-lock holder. `run.ts` owns polling and the work/idle wake-lock
// transition. Process seams keep the install and one-launch contracts directly
// testable without a network.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Signal NAME to number, for the `128 + signal` exit `main` reports a killed
// driver with. `spawnSync` answers with the name and the shell convention is
// written in the number, so the table has to be crossed somewhere; node ships
// it, and a hand-written SIGKILL=9 would be a second statement of it that is
// wrong on some platform.
const SIGNALS = constants.signals;

export const PIN_FILE = "sandbar.pin";

// `github:<owner>/<repo>#v<major>.<minor>.<patch>` and nothing else. A branch
// or a sha would install perfectly well and is refused anyway: a sha names a
// state no consumer could ever reference, and a branch is not a pin at all.
const PIN_PATTERN = /^github:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#v\d+\.\d+\.\d+$/;

// A launch that cannot proceed, as opposed to a bug in this file. The
// distinction is spent at the one catch site at the bottom: a LaunchError
// prints as its message and exits 1, because it is addressed to an operator and
// there is nothing in a stack trace for them; anything else keeps its stack.
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
        "would pin. A branch moves over time and a sha names a state no " +
        "consumer could reference, so neither is accepted as a substitute.",
    );
  }
  return spec;
}

// Every path this script touches, derived once from the repo root.
export function driverPaths(root) {
  const dir = join(root, ".sandbar", "driver");
  const pkg = join(dir, "node_modules", "sandbar");
  return {
    dir,
    // The bin, run directly rather than through `node_modules/.bin/sandbar`:
    // the symlink is one more thing that can be absent on a half-install, and
    // the file it points at is the thing that has to exist.
    cli: join(pkg, "dist", "cli.js"),
    manifest: join(dir, "package.json"),
    stamp: join(dir, "installed-pin"),
  };
}

// Pure: the two facts about what is on disk, against what is asked for.
//
// The identity compared is the SPEC STRING, never the installed package's own
// `version`, and that is the exact sense in which repeated launches run a
// byte-identical driver: it rests on git tags being immutable. A tag
// moved at origin leaves this stamp matching and the previous bytes running,
// silently, until somebody deletes `.sandbar/driver/`. Reading the installed
// version back would not close it either — a moved tag need not change the
// version — so what stands behind the claim is the convention, stated here
// rather than assumed. `sandbar.pin` refuses a branch or a sha for the same
// reason: only a tag is a name that is supposed to stop moving.
export function installNeeded(state, spec) {
  if (!state.cliPresent) return true;
  return state.installedSpec !== spec;
}

// `--prefix` rather than a cwd, so npm treats the driver directory as its own
// project and this repo's `package.json` is never the one being installed into.
// The driver's manifest is named `sandbar-driver`, not `sandbar`,
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

// Process seams keep installation and launch testable without a network or a
// real child. TWO seams rather than one because installing the driver and
// running it are different operations. `log` is seamed because this file talks
// to an operator, and a test suite is not one.
function seams(io) {
  return {
    spawn: io.spawn ?? spawnSync,
    run: io.run ?? spawnSync,
    log: io.log ?? say,
  };
}

// Throws LaunchError on every outcome that is not "there is a driver at
// `paths.cli` and it is `spec`". The stamp is the record the next launch
// reads, so it is removed FIRST and written LAST: every throw below leaves the
// directory in a state `installNeeded` answers `true` for.
export function installDriver(paths, spec, io = {}) {
  const { spawn, log } = seams(io);
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
  log(`installing ${spec} into ${paths.dir}`);
  const result = spawn("npm", installArgv(paths.dir, spec), {
    stdio: "inherit",
  });
  if (result.error) {
    throw new LaunchError(
      `could not run npm to install ${spec}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    // `status` is null when npm died by a signal — a Ctrl-C during the install
    // takes exactly this path, since `spawnSync` inherits the process group —
    // so the signal is named rather than printed as the literal word "signal".
    const how =
      result.status === null
        ? `killed by ${result.signal ?? "a signal"}`
        : `exit ${result.status}`;
    throw new LaunchError(
      `npm install of ${spec} failed (${how}).\n` +
        "The launcher stops here rather than continuing on whichever driver is on " +
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
        `  npm approve-scripts --prefix ${paths.dir} sandbar\n`,
    );
  }
  writeFileSync(paths.stamp, `${spec}\n`);
}

// Reads the pin, brings the driver into line with it, and answers where it is.
export function ensureDriver(root, io = {}) {
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
    installDriver(paths, spec, io);
  } else {
    seams(io).log(`driver ${spec} already installed at ${paths.dir}`);
  }
  return { spec, cli: paths.cli };
}

// Not exported: `main` is the only caller, and this file lives at a fixed depth
// under the root it derives.
function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

// Launch the daemon once and propagate its exit code
// unchanged — and a driver killed by a signal as `128 + signal`, which is what
// a shell would have propagated and is the one answer that is not an exit code
// of the driver's own. `root` is a parameter so a test can point it at a
// temporary directory holding a pin and a fake install; production passes
// neither it nor the seams.
export function main(argv, { root = repoRoot(), ...io } = {}) {
  const { run, log } = seams(io);
  // `--install-only` is for the hand paths — `sandbar gate`, or a config load —
  // which need the driver present but are not a run. Deliberately not a
  // `--config`-style flag: it configures nothing, it stops before the driver
  // starts, and so it is never forwarded: the one launch it could reach is the
  // one it returns ahead of.
  const installOnly = argv.includes("--install-only");
  const { spec, cli } = ensureDriver(root, io);
  if (installOnly) return 0;
  log(`running ${spec}`);
  // The driver's cwd decides which repository it operates on, so use the repo
  // whose pin chose it rather than wherever the launcher was invoked. Relative
  // `--config` paths consequently resolve against this root as well.
  const child = run(process.execPath, [cli, ...argv], {
    cwd: root,
    stdio: "inherit",
  });
  if (child.error) {
    throw new LaunchError(`could not run ${cli}: ${child.error.message}`);
  }
  // Launch succeeded if the driver later died by a signal. Preserve the usual
  // shell status instead of reclassifying that as an operator launch error.
  if (child.status === null) {
    const signal = child.signal ?? null;
    const number = signal === null ? undefined : SIGNALS[signal];
    if (number === undefined) {
      throw new LaunchError(
        `the driver at ${cli} exited with neither a status nor a signal ` +
          `this platform names (${JSON.stringify(signal)}).`,
      );
    }
    log(`the driver was killed by ${signal} (exiting ${128 + number})`);
    return 128 + number;
  }
  return child.status;
}

// Only when this file IS the program — `launcher.test.ts` imports it for the
// pure functions above, and an import that launched a daemon would be its own
// kind of #66.
//
// `realpathSync` on both sides, because Node's ESM loader resolves symlinks
// before it fills `import.meta.url`: invoked through a symlink, a plain
// `resolve(argv[1])` compares the link against its target, does not match, and
// the launcher exits 0 having done NOTHING — no daemon, no output, no error.
// `npm run sandbar` never takes that path, but a silent no-op is the worst
// available failure for the one file whose job is to fail loudly.
function isEntrypoint() {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(resolve(argv1)) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  // Synchronous throughout — every step of a launch is `spawnSync`, so there is
  // nothing to await and a promise hop would only put this catch one tick away.
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    // `LaunchError` is the class of failure an operator ACTS on — a pin that
    // names nothing, an install that could not fetch it — and its message is
    // written to be read alone. Anything else reaching here is a bug in this
    // file, and a bug printed as one tidy line is a bug with its stack thrown
    // away, so it is rethrown instead.
    if (!(err instanceof LaunchError)) throw err;
    console.error(`sandbar launcher: ${err.message}`);
    process.exit(1);
  }
}
