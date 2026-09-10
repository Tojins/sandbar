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
import { readFileSync, realpathSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DriverInstallError,
  EXACT_TAG_PATTERN,
  driverPaths as installedDriverPaths,
  ensureInstalledDriver,
} from "../deploy/ansible/roles/sandbar/files/driver-install.mjs";

export {
  DriverInstallError as LaunchError,
  installArgv,
  installDriver,
  installNeeded,
  readInstallState,
} from "../deploy/ansible/roles/sandbar/files/driver-install.mjs";

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
// Comments are lines whose FIRST character is `#`; the spec's own `#` is what
// separates the repo from the tag, so it cannot be a mid-line comment marker.
export function parsePin(content) {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.length === 0) {
    throw new DriverInstallError(
      `${PIN_FILE} names no driver. It must contain one npm spec line, ` +
        "`github:<owner>/<repo>#v<X.Y.Z>`.",
    );
  }
  if (lines.length > 1) {
    throw new DriverInstallError(
      `${PIN_FILE} has ${lines.length} spec lines (${lines.join(", ")}). ` +
        "Exactly one release drives a run; there is no fallback to a second.",
    );
  }
  const spec = lines[0];
  if (!EXACT_TAG_PATTERN.test(spec)) {
    throw new DriverInstallError(
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
  return installedDriverPaths(join(root, ".sandbar", "driver"));
}

function say(message) {
  console.log(`sandbar launcher: ${message}`);
}

// Process seams keep installation and launch testable without a network or a
// real child. TWO seams rather than one because installing the driver and
// running it are different operations. `log` is seamed because this file talks
// to an operator, and a test suite is not one.
function launchSeams(io) {
  return {
    run: io.run ?? spawnSync,
    log: io.log ?? say,
  };
}

// Reads the pin, brings the driver into line with it, and answers where it is.
export function ensureDriver(root, io = {}) {
  const pinPath = join(root, PIN_FILE);
  let content;
  try {
    content = readFileSync(pinPath, "utf8");
  } catch (err) {
    throw new DriverInstallError(
      `cannot read ${pinPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const spec = parsePin(content);
  const paths = driverPaths(root);
  const cli = ensureInstalledDriver(paths.dir, spec, {
    ...io,
    log: io.log ?? say,
  });
  return { spec, cli };
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
  const { run, log } = launchSeams(io);
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
    throw new DriverInstallError(`could not run ${cli}: ${child.error.message}`);
  }
  // Launch succeeded if the driver later died by a signal. Preserve the usual
  // shell status instead of reclassifying that as an operator launch error.
  if (child.status === null) {
    const signal = child.signal ?? null;
    const number = signal === null ? undefined : SIGNALS[signal];
    if (number === undefined) {
      throw new DriverInstallError(
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
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
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
    if (!(err instanceof DriverInstallError)) throw err;
    console.error(`sandbar launcher: ${err.message}`);
    process.exit(1);
  }
}
