// Self-hosted launcher contract (#66, #133). The launcher installs one pinned
// release and starts the daemon once; continuity belongs to run.ts's poll loop.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LaunchError, PIN_FILE, driverPaths, ensureDriver, installArgv, installDriver,
  installNeeded, main, parsePin, readInstallState,
} from "../scripts/sandbar-launch.mjs";
import { compareVersions, parseVersion } from "./requires-sandbar.js";

const PIN = "github:Tojins/sandbar#v0.21.0";

describe("parsePin (#66)", () => {
  it("reads exactly one tagged GitHub release", () => {
    expect(parsePin(`# comment\n\n${PIN}\n`)).toBe(PIN);
    for (const invalid of ["", "github:Tojins/sandbar#main", `${PIN}\n${PIN}`]) {
      expect(() => parsePin(invalid)).toThrow(LaunchError);
    }
  });
});

describe("driver install (#66)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "sandbar-launcher-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("derives the disposable install paths and npm argv", () => {
    const paths = driverPaths(root);
    expect(paths.cli).toBe(join(
      root, ".sandbar", "driver", "node_modules", "@offergeist", "sandbar", "dist", "cli.js",
    ));
    expect(installArgv(paths.dir, PIN)).toEqual([
      "install", "--prefix", paths.dir, "--no-audit", "--no-fund", PIN,
    ]);
  });

  it("requires both the bin and matching stamp", () => {
    expect(installNeeded({ cliPresent: false, installedSpec: PIN }, PIN)).toBe(true);
    expect(installNeeded({ cliPresent: true, installedSpec: null }, PIN)).toBe(true);
    expect(installNeeded({ cliPresent: true, installedSpec: PIN }, PIN)).toBe(false);
  });

  it("stamps only an install that produced the driver bin", () => {
    const paths = driverPaths(root);
    installDriver(paths, PIN, {
      spawn: (() => {
        mkdirSync(dirname(paths.cli), { recursive: true });
        writeFileSync(paths.cli, "#!/usr/bin/env node\n");
        return { status: 0 };
      }) as never,
      log: () => {},
    });
    expect(readInstallState(paths)).toEqual({ cliPresent: true, installedSpec: PIN });
  });

  it("invokes npm with the exact install argv", () => {
    const paths = driverPaths(root);
    const calls: unknown[][] = [];
    installDriver(paths, PIN, {
      spawn: ((...args: unknown[]) => {
        calls.push(args);
        mkdirSync(dirname(paths.cli), { recursive: true });
        writeFileSync(paths.cli, "#!/usr/bin/env node\n");
        return { status: 0 };
      }) as never,
      log: () => {},
    });
    expect(calls).toEqual([["npm", installArgv(paths.dir, PIN), { stdio: "inherit" }]]);
  });

  it("preserves an existing manifest with install-script approval", () => {
    const paths = driverPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    const approved = JSON.stringify({
      name: "sandbar-driver",
      private: true,
      allowScripts: { "@offergeist/sandbar": true },
    });
    writeFileSync(paths.manifest, approved);
    installDriver(paths, PIN, {
      spawn: (() => {
        mkdirSync(dirname(paths.cli), { recursive: true });
        writeFileSync(paths.cli, "#!/usr/bin/env node\n");
        return { status: 0 };
      }) as never,
      log: () => {},
    });
    expect(readFileSync(paths.manifest, "utf8")).toBe(approved);
  });

  it("does not stamp a failed or bin-less install", () => {
    const paths = driverPaths(root);
    expect(() => installDriver(paths, PIN, {
      spawn: (() => ({ status: 1 })) as never, log: () => {},
    })).toThrow(LaunchError);
    expect(readInstallState(paths).installedSpec).toBeNull();
    expect(() => installDriver(paths, PIN, {
      spawn: (() => ({ status: 0 })) as never, log: () => {},
    })).toThrow(/reported success.*missing/s);
  });

  it("removes an old stamp before attempting a replacement install", () => {
    const paths = driverPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.stamp, "github:Tojins/sandbar#v0.20.0\n");
    expect(() => installDriver(paths, PIN, {
      spawn: (() => {
        expect(existsSync(paths.stamp)).toBe(false);
        return { status: 1 };
      }) as never,
      log: () => {},
    })).toThrow(LaunchError);
    expect(existsSync(paths.stamp)).toBe(false);
  });

  it("reads the pin and skips a matching installed driver", () => {
    const paths = driverPaths(root);
    mkdirSync(dirname(paths.cli), { recursive: true });
    writeFileSync(paths.cli, "#!/usr/bin/env node\n");
    writeFileSync(paths.stamp, `${PIN}\n`);
    writeFileSync(join(root, PIN_FILE), `${PIN}\n`);
    expect(ensureDriver(root, {
      spawn: (() => { throw new Error("unexpected install"); }) as never,
      log: () => {},
    })).toEqual({ spec: PIN, cli: paths.cli });
  });
});

describe("main — one daemon launch (#133)", () => {
  let root: string;
  let paths: ReturnType<typeof driverPaths>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-launcher-"));
    paths = driverPaths(root);
    mkdirSync(dirname(paths.cli), { recursive: true });
    writeFileSync(paths.cli, "#!/usr/bin/env node\n");
    writeFileSync(paths.stamp, `${PIN}\n`);
    writeFileSync(join(root, PIN_FILE), `${PIN}\n`);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const invoke = (result: object, argv: string[] = []) => {
    const launches: unknown[][] = [];
    const status = main(argv, {
      root,
      log: () => {},
      spawn: (() => { throw new Error("unexpected install"); }) as never,
      run: ((...args: unknown[]) => { launches.push(args); return result; }) as never,
    });
    return { status, launches };
  };

  it("launches once, forwards argv, and propagates every status including old 75", () => {
    for (const status of [0, 1, 2, 4, 75]) {
      const result = invoke({ status }, ["--config", "other.mjs"]);
      expect(result.status).toBe(status);
      expect(result.launches).toHaveLength(1);
      expect(result.launches[0]?.[1]).toEqual([paths.cli, "--config", "other.mjs"]);
      expect(result.launches[0]?.[2]).toMatchObject({ cwd: root, stdio: "inherit" });
    }
  });

  it("supports install-only without starting the daemon", () => {
    expect(invoke({ status: 0 }, ["--install-only"])).toMatchObject({ status: 0, launches: [] });
  });

  it("maps a signal-killed daemon to the shell status", () => {
    expect(invoke({ status: null, signal: "SIGKILL" }).status)
      .toBe(128 + constants.signals.SIGKILL);
    expect(() => invoke({ status: null, signal: "SIGNOTREAL" }))
      .toThrow(/neither a status nor a signal/);
  });
});

describe("this repository's pin (#66)", () => {
  it("is older than package.json and satisfies the config floor", () => {
    const spec = parsePin(readFileSync(new URL("../sandbar.pin", import.meta.url), "utf8"));
    const pinned = parseVersion(spec.slice(spec.indexOf("#v") + 2));
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const current = parseVersion(pkg.version);
    const configSource = readFileSync(new URL("../sandbar.config.mjs", import.meta.url), "utf8");
    const floorText = configSource.match(/requiresSandbar:\s*"([^"]+)"/)?.[1];
    const floor = floorText === undefined ? null : parseVersion(floorText);
    expect(pinned).not.toBeNull();
    expect(current).not.toBeNull();
    expect(floor).not.toBeNull();
    expect(compareVersions(pinned!, current!)).toBeLessThan(0);
    expect(compareVersions(pinned!, floor!)).toBeGreaterThanOrEqual(0);
  });
});
