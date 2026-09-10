#!/usr/bin/env node
// One installation's exact-tag driver reconciler (#149). The role places this
// file at ~/installation/install-driver.mjs, beside its disposable `driver/`
// directory. The installed-pin stamp is removed before npm runs and written
// only after the expected CLI exists, so a failed replacement cannot launch
// old bytes. Exported seams make that systemd ExecStartPre contract testable.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TAG_PATTERN =
  /^github:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#v\d+\.\d+\.\d+$/;

export class DriverInstallError extends Error {}

export function driverPaths(dir) {
  const pkg = join(dir, "node_modules", "sandbar");
  return {
    dir,
    cli: join(pkg, "dist", "cli.js"),
    manifest: join(dir, "package.json"),
    stamp: join(dir, "installed-pin"),
  };
}

export function installNeeded(state, spec) {
  return !state.cliPresent || state.installedSpec !== spec;
}

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

export function installDriver(paths, spec, io = {}) {
  const spawn = io.spawn ?? spawnSync;
  const log = io.log ?? console.log;
  mkdirSync(paths.dir, { recursive: true });
  if (!existsSync(paths.manifest)) {
    writeFileSync(
      paths.manifest,
      `${JSON.stringify(
        {
          name: "sandbar-driver",
          version: "0.0.0",
          private: true,
          description: "Disposable exact-tag sandbar driver installed by the Ansible role.",
        },
        null,
        2,
      )}\n`,
    );
  }

  rmSync(paths.stamp, { force: true });
  log(`sandbar driver install: installing ${spec} into ${paths.dir}`);
  const result = spawn("npm", installArgv(paths.dir, spec), { stdio: "inherit" });
  if (result.error) {
    throw new DriverInstallError(
      `could not run npm to install ${spec}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const how =
      result.status === null
        ? `killed by ${result.signal ?? "a signal"}`
        : `exit ${result.status}`;
    throw new DriverInstallError(`npm install of ${spec} failed (${how})`);
  }
  if (!existsSync(paths.cli)) {
    throw new DriverInstallError(
      `npm install of ${spec} reported success, but ${paths.cli} is missing`,
    );
  }
  writeFileSync(paths.stamp, `${spec}\n`);
}

export function ensureDriver(dir, spec, io = {}) {
  if (!TAG_PATTERN.test(spec)) {
    throw new DriverInstallError(
      `'${spec}' is not an exact tagged driver; expected github:owner/repo#vX.Y.Z`,
    );
  }
  const paths = driverPaths(dir);
  if (installNeeded(readInstallState(paths), spec)) {
    installDriver(paths, spec, io);
  } else {
    (io.log ?? console.log)(
      `sandbar driver install: ${spec} already installed at ${dir}`,
    );
  }
  return paths.cli;
}

export function main(argv, { dir = join(dirname(fileURLToPath(import.meta.url)), "driver"), ...io } = {}) {
  if (argv.length !== 1 || argv[0] === undefined) {
    throw new DriverInstallError(
      "usage: install-driver.mjs github:owner/repo#vX.Y.Z",
    );
  }
  ensureDriver(dir, argv[0], io);
  return 0;
}

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
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof DriverInstallError)) throw error;
    console.error(`sandbar driver install: ${error.message}`);
    process.exit(1);
  }
}
