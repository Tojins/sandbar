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
// A consequence worth naming, since the config imports the driver: the hand
// path `npm run build && node dist/cli.js` runs orchestrator code out of the
// `dist/` just built, but a config that takes `readEnvFile` from
// `.sandbar/driver/`. That is one function and harmless in the ordinary case —
// but someone iterating `env.ts` is not exercising their change until they
// move the pin or point the config's import at `./dist/` for the duration.
//
// Plain `.mjs` under `scripts/`, outside `files` and outside `src/`: it is not
// part of the package, no consumer runs it, and it must run before anything is
// built. `launcher.test.ts` covers all four decisions AND the loop contract
// #65 states (continue on 75, propagate every other exit), which is why each is
// a separately exported function and why the two that shell out take process
// seams (`io.spawn`, `io.run`) instead of reaching for `spawnSync` directly:
// those decisions ARE the safety property of #66, and a safety property nothing
// exercises is a claim. `main` is exported for that reason alone — it still
// runs only when this file IS the program, so importing it cannot start a
// series.

import { spawn, spawnSync } from "node:child_process";
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
    // The bin, run directly rather than through `node_modules/.bin/sandbar`:
    // the symlink is one more thing that can be absent on a half-install, and
    // the file it points at is the thing that has to exist.
    cli: join(pkg, "dist", "cli.js"),
    // The series-long wake lock (#117), run as a child for the whole loop. Its
    // EXISTENCE is the capability probe: `sandbar.pin` lags this checkout
    // always (#66), so this launcher will run against drivers that predate the
    // file, and a version comparison would be a second statement of the same
    // fact that can disagree with it.
    wakeLock: join(pkg, "dist", "keepawake-hold.js"),
    manifest: join(dir, "package.json"),
    stamp: join(dir, "installed-pin"),
  };
}

// Pure: the two facts about what is on disk, against what is asked for.
//
// The identity compared is the SPEC STRING, never the installed package's own
// `version`, and that is the exact sense in which "a relaunch runs a
// byte-identical driver" is true: it rests on git tags being immutable. A tag
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

// The process seams in this file, and the reason they exist is that decisions 3
// and 4 — plus #65's loop contract — are the safety properties of #66 and none
// of them can be asserted against the real thing: `spawn` would need a network,
// a tag and a way to make `npm install` fail on demand, and `run` would need a
// driver that exits 75 exactly as often as a test wants. Production passes
// nothing. A test passes a fake `spawn` and reads back what happened to the
// STAMP, which is the fact deciding whether the next launch reinstalls or runs
// what is on disk, and a fake `run` to count the launches a sequence of exit
// codes produces. TWO seams rather than one because the two calls mean
// different things — installing the driver, and being driven by it — and a test
// that could not tell them apart could not assert either. `log` is seamed for
// the ordinary reason: this file talks to an operator, and a test suite is not
// one.
function seams(io) {
  return {
    spawn: io.spawn ?? spawnSync,
    run: io.run ?? spawnSync,
    // The wake lock is the one child that must OUTLIVE a call (#117), so it is
    // the async `spawn` and a seam of its own: a test that could not tell it
    // from `run` could not assert that exactly one is held for a whole series
    // of relaunches, which is the entire property.
    hold: io.hold ?? spawn,
    log: io.log ?? say,
  };
}

// The series-long wake lock (#117). On this repo's WSL2 host every observed
// sleep began within minutes of a run ending, and one of them 6 ms after the
// driver released its own lock — so the seam #65 opens between two driver
// processes is exactly where the machine sleeps, and only this process spans
// it. Held once, before the first launch, released when the loop is done.
//
// It is a CHILD rather than a call because this file cannot make the call: it
// is synchronous by decision, it runs before the driver it would import
// exists, and it is blocked inside `spawnSync` for hours at a time, so it
// could neither await a confirmation nor notice the lock dying. The child has
// a live event loop and inherits stdout, so it reports its own status.
//
// A missing program is a driver older than the feature, not a failure: the pin
// LAGS this checkout always (#66). Say so and carry on unlocked — a launcher
// that refused to run on the pin it was given would be a worse bargain than a
// host that may sleep.
export function holdWakeLock(program, io = {}) {
  const { hold, log } = seams(io);
  if (!existsSync(program)) {
    log(
      "wake-lock: NOT held — the pinned driver predates it " +
        `(${program} is missing). Move ${PIN_FILE} to pick it up.`,
    );
    return null;
  }
  const child = hold(process.execPath, [program], {
    // stdin is the lock's lifeline: this process holding the write end IS the
    // lock, and its death — clean or not — closes the pipe and releases it.
    // stdout and stderr are inherited so the child's own status lines reach
    // the terminal without needing an event loop turn here.
    stdio: ["pipe", "inherit", "inherit"],
  });
  // Async `spawn` reports a failure by event, and this process is about to
  // stop turning its loop, so the handler is a best effort by construction.
  // The only reachable cause is `process.execPath` being unrunnable, which is
  // not a state this script could still be executing in.
  child.on?.("error", (err) => log(`wake-lock: NOT held — ${err.message}`));
  return child;
}

function releaseWakeLock(child) {
  if (!child) return;
  try {
    child.stdin?.end();
    child.kill?.();
  } catch {
    // A lock that is already gone is the outcome this asks for.
  }
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
  return { spec, cli: paths.cli, wakeLock: paths.wakeLock };
}

// Not exported: `main` is the only caller, and this file lives at a fixed depth
// under the root it derives.
function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

// The loop itself, and #65's contract is the whole of it: continue on
// EXIT_CODE_RELAUNCH and on nothing else, propagate every other exit code
// unchanged — and a driver killed by a signal as `128 + signal`, which is what
// a shell would have propagated and is the one answer that is not an exit code
// of the driver's own. `root` is a parameter so a test can point it at a
// temporary directory holding a pin and a fake install; production passes
// neither it nor the seams.
export function main(argv, { root = repoRoot(), ...io } = {}) {
  const { run, log } = seams(io);
  // `--install-only` is for the hand paths — `sandbar gate`, or a config load —
  // which need the driver present but are not a series. Deliberately not a
  // `--config`-style flag: it configures nothing, it stops the loop before it
  // starts, and so it is never forwarded: the one launch it could reach is the
  // one it returns ahead of.
  const installOnly = argv.includes("--install-only");
  // Taken once, below, and released in the `finally` — so it spans every
  // relaunch seam, which is the whole reason it lives here and not in `run()`
  // (#117). `try`/`finally` rather than a release before each `return`: there
  // are six ways out of this loop including two throws, and a wake lock that
  // leaks on one of them is a host that will not sleep again until it reboots.
  let wakeLock = null;
  try {
    for (;;) {
      // Re-read every iteration, so a pin edited between cycles is honoured at
      // the next relaunch rather than at the next series.
      const { spec, cli, wakeLock: holder } = ensureDriver(root, io);
      if (installOnly) return 0;
      // After the first `ensureDriver`, because the program being run is the
      // driver's. That leaves the FIRST install uncovered, deliberately: it is a
      // human-initiated command whose install lasts seconds, against a seam that
      // recurs unattended every time a cycle lands a merge.
      if (wakeLock === null) wakeLock = holdWakeLock(holder, io);
      log(`running ${spec}`);
      // `cwd: root` rather than this process's own, and that is a decision. The
      // config resolves against the process cwd (cli.ts) and `config.cwd`
      // defaults to it, so the driver's cwd decides which repository a series
      // operates on — and the answer must be the repo whose `sandbar.pin` chose
      // the driver, not wherever the launcher happened to be invoked. Under
      // `npm run sandbar` the two agree (npm runs scripts from the package
      // root); invoked directly from a subdirectory, or through a symlink, they
      // do not, and the old shell loop would have gone looking for a config that
      // is not there. The one visible cost is that a RELATIVE `--config` passed
      // through now resolves against the root as well — absolute paths are
      // unaffected, and pinning it here at least makes the resolution the same
      // on every launch of a series.
      const child = run(process.execPath, [cli, ...argv], {
        cwd: root,
        stdio: "inherit",
      });
      if (child.error) {
        throw new LaunchError(`could not run ${cli}: ${child.error.message}`);
      }
      // A driver killed by a signal is not a LaunchError: the launcher proceeded
      // exactly as asked and the DRIVER died, which is the distinction that class
      // exists to draw — printing it as one operator-addressed line and exiting 1
      // makes an OOM-killed run indistinguishable from a pin that names nothing.
      // So it is reported as a shell reports one, `128 + signal`, which is what
      // the shell loop this file replaced already returned and what
      // `cleanup.ts`'s own SIGINT/SIGTERM exits (130, 143) already look like. It
      // stops the loop by construction: no signal maps onto 75.
      if (child.status === null) {
        const signal = child.signal ?? null;
        const number = signal === null ? undefined : SIGNALS[signal];
        if (number === undefined) {
          // Nothing to encode — `spawnSync` answered neither a code nor a signal
          // this platform names, so there is no verdict and no exit code that
          // would mean one.
          throw new LaunchError(
            `the driver at ${cli} exited with neither a status nor a signal ` +
              `this platform names (${JSON.stringify(signal)}).`,
          );
        }
        log(`the driver was killed by ${signal} (exiting ${128 + number})`);
        return 128 + number;
      }
      if (child.status !== EXIT_CODE_RELAUNCH) return child.status;
      log(`relaunching (exit ${EXIT_CODE_RELAUNCH})`);
    }
  } finally {
    releaseWakeLock(wakeLock);
  }
}

// Only when this file IS the program — `launcher.test.ts` imports it for the
// pure functions above, and an import that launched a series would be its own
// kind of #66.
//
// `realpathSync` on both sides, because Node's ESM loader resolves symlinks
// before it fills `import.meta.url`: invoked through a symlink, a plain
// `resolve(argv[1])` compares the link against its target, does not match, and
// the launcher exits 0 having done NOTHING — no series, no output, no error.
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
