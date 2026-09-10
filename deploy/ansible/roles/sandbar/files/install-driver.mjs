#!/usr/bin/env node
// The Ansible role's thin ExecStartPre entrypoint (#149). Reconciliation lives
// in driver-install.mjs, shared with the repository launcher; this file owns
// only its one-argument command contract and operator-facing error rendering.

import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DriverInstallError,
  ensureInstalledDriver,
} from "./driver-install.mjs";

export {
  DriverInstallError,
  driverPaths,
  ensureInstalledDriver as ensureDriver,
  installArgv,
  readInstallState,
} from "./driver-install.mjs";

export function main(argv, { dir = join(dirname(fileURLToPath(import.meta.url)), "driver"), ...io } = {}) {
  if (argv.length !== 1 || argv[0] === undefined) {
    throw new DriverInstallError(
      "usage: install-driver.mjs github:owner/repo#vX.Y.Z",
    );
  }
  ensureInstalledDriver(dir, argv[0], {
    ...io,
    log: io.log ?? ((message) => console.log(`sandbar driver install: ${message}`)),
  });
  return 0;
}

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
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof DriverInstallError)) throw error;
    console.error(`sandbar driver install: ${error.message}`);
    process.exit(1);
  }
}
