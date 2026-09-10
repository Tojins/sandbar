// The role-owned systemd ExecStartPre driver installer (#149).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DriverInstallError,
  driverPaths,
  ensureDriver,
  installArgv,
  main,
  readInstallState,
} from "../deploy/ansible/roles/sandbar/files/install-driver.mjs";

const PIN = "github:Tojins/sandbar#v0.39.7";
const ROLE_FILES = new URL("../deploy/ansible/roles/sandbar/files/", import.meta.url);

describe("role-owned driver install (#149)", () => {
  let dir: string;

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "sandbar-driver-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function successfulInstall(paths: ReturnType<typeof driverPaths>) {
    return () => {
      mkdirSync(dirname(paths.cli), { recursive: true });
      writeFileSync(paths.cli, "#!/usr/bin/env node\n");
      return { status: 0 };
    };
  }

  it("skips npm when the CLI and stamp match", () => {
    const paths = driverPaths(dir);
    mkdirSync(dirname(paths.cli), { recursive: true });
    writeFileSync(paths.cli, "#!/usr/bin/env node\n");
    writeFileSync(paths.stamp, `${PIN}\n`);
    expect(ensureDriver(dir, PIN, {
      spawn: () => { throw new Error("unexpected install"); },
      log: () => {},
    })).toBe(paths.cli);
  });

  it("installs and stamps when the requested tag differs", () => {
    const paths = driverPaths(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(paths.stamp, "github:Tojins/sandbar#v0.39.6\n");
    const calls: unknown[][] = [];
    ensureDriver(dir, PIN, {
      spawn: ((...args: unknown[]) => {
        calls.push(args);
        return successfulInstall(paths)();
      }) as never,
      log: () => {},
    });
    expect(calls).toEqual([["npm", installArgv(dir, PIN), { stdio: "inherit" }]]);
    expect(readInstallState(paths)).toEqual({ cliPresent: true, installedSpec: PIN });
  });

  it("removes the old stamp and fails ExecStartPre when npm fails", () => {
    const paths = driverPaths(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(paths.stamp, "github:Tojins/sandbar#v0.39.6\n");
    expect(() => main([PIN], {
      dir,
      spawn: (() => ({ status: 1 })) as never,
      log: () => {},
    })).toThrow(DriverInstallError);
    expect(existsSync(paths.stamp)).toBe(false);
  });

  it("refuses to stamp an npm success that did not produce the CLI", () => {
    const paths = driverPaths(dir);
    expect(() => ensureDriver(dir, PIN, {
      spawn: (() => ({ status: 0 })) as never,
      log: () => {},
    })).toThrow(/reported success.*missing/s);
    expect(existsSync(paths.stamp)).toBe(false);
  });

  it("executes the deployed entrypoint and exits nonzero when npm fails", () => {
    const installation = join(dir, "installation");
    const fakeBin = join(dir, "bin");
    mkdirSync(installation, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    copyFileSync(
      fileURLToPath(new URL("install-driver.mjs", ROLE_FILES)),
      join(installation, "install-driver.mjs"),
    );
    copyFileSync(
      fileURLToPath(new URL("driver-install.mjs", ROLE_FILES)),
      join(installation, "driver-install.mjs"),
    );
    const npm = join(fakeBin, "npm");
    writeFileSync(npm, "#!/bin/sh\nexit 23\n");
    chmodSync(npm, 0o700);

    const paths = driverPaths(join(installation, "driver"));
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.stamp, "github:Tojins/sandbar#v0.39.6\n");
    const result = spawnSync(
      process.execPath,
      [join(installation, "install-driver.mjs"), PIN],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`npm install of ${PIN} failed (exit 23)`);
    expect(existsSync(paths.stamp)).toBe(false);
  });

  it("refuses a moving spec before invoking npm", () => {
    expect(() => ensureDriver(dir, "github:Tojins/sandbar#main", {
      spawn: () => { throw new Error("unexpected install"); },
    })).toThrow(/not an exact tagged driver/);
  });

  it("propagates a stamp read failure other than absence", () => {
    const paths = driverPaths(dir);
    mkdirSync(paths.stamp);
    expect(() => readInstallState(paths)).toThrow();
  });

  it("preserves an install-script approval manifest", () => {
    const paths = driverPaths(dir);
    mkdirSync(dir, { recursive: true });
    const manifest = '{"private":true,"allowScripts":{"sandbar":true}}';
    writeFileSync(paths.manifest, manifest);
    ensureDriver(dir, PIN, { spawn: successfulInstall(paths) as never, log: () => {} });
    expect(readFileSync(paths.manifest, "utf8")).toBe(manifest);
  });
});
