// The role-owned systemd ExecStartPre driver installer (#149).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  it("refuses a moving spec before invoking npm", () => {
    expect(() => ensureDriver(dir, "github:Tojins/sandbar#main", {
      spawn: () => { throw new Error("unexpected install"); },
    })).toThrow(/not an exact tagged driver/);
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
