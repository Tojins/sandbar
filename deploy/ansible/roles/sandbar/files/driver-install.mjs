// Canonical exact-tag driver installation (#66, #149).
//
// The Ansible role uses this module for every installation. A driver
// is current only when its expected CLI exists and `installed-pin` names the
// requested immutable tag. Replacement removes that stamp before npm runs and
// restores it only after the CLI exists, so every failed or incomplete install
// remains visibly in need of repair.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const EXACT_TAG_PATTERN =
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
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  return { cliPresent: existsSync(paths.cli), installedSpec };
}

export function installDriver(paths, spec, io = {}) {
  const spawn = io.spawn ?? spawnSync;
  const log = io.log ?? console.log;
  mkdirSync(paths.dir, { recursive: true });

  // npm records install-script approval in this manifest. Create it only when
  // absent so a later driver update cannot erase that operator decision.
  if (!existsSync(paths.manifest)) {
    writeFileSync(
      paths.manifest,
      `${JSON.stringify(
        {
          name: "sandbar-driver",
          version: "0.0.0",
          private: true,
          description: "Disposable exact-tag sandbar driver install root.",
        },
        null,
        2,
      )}\n`,
    );
  }

  rmSync(paths.stamp, { force: true });
  log(`installing ${spec} into ${paths.dir}`);
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
      `npm install of ${spec} reported success, but ${paths.cli} is missing. ` +
        "The package build script may not have run; approve it for this install " +
        `root with \`npm approve-scripts --prefix ${paths.dir} sandbar\` and retry.`,
    );
  }
  writeFileSync(paths.stamp, `${spec}\n`);
}

export function ensureInstalledDriver(dir, spec, io = {}) {
  if (!EXACT_TAG_PATTERN.test(spec)) {
    throw new DriverInstallError(
      `'${spec}' is not an exact tagged driver; expected github:owner/repo#vX.Y.Z`,
    );
  }
  const paths = driverPaths(dir);
  if (installNeeded(readInstallState(paths), spec)) {
    installDriver(paths, spec, io);
  } else {
    (io.log ?? console.log)(`driver ${spec} already installed at ${dir}`);
  }
  return paths.cli;
}
