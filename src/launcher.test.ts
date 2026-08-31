// The self-hosted launcher's decisions (#66).
//
// `scripts/sandbar-launch.mjs` is not part of the package — it runs before the
// package exists — so this file reaches across to it by path. What is tested is
// exactly what is decidable without a network: which spec a pin file names,
// when an install is required, and the argv that performs it. The install
// itself is `npm install` doing what npm defines, and the loop is `spawnSync`
// doing what it defines; neither is faked here.
//
// It lives under `src/` with every other test, and `files` ships `src/` — so
// the published tarball carries this one file whose import points outside it.
// Left that way on purpose: nothing runs vitest from an install (`devDependencies`
// are not installed, and no consumer has a reason to), and the two alternatives
// are worse — shipping `scripts/` would publish self-hosting tooling no consumer
// runs, and moving the test out of `src/` would put the suite in two places to
// buy a dangling import in a file nobody executes.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  EXIT_CODE_RELAUNCH as LAUNCHER_RELAUNCH_CODE,
  LaunchError,
  PIN_FILE,
  driverPaths,
  installArgv,
  installNeeded,
  parsePin,
} from "../scripts/sandbar-launch.mjs";
import { EXIT_CODE_RELAUNCH } from "./exit-conditions.js";

const PIN = "github:Tojins/sandbar#v0.21.0";

describe("parsePin (#66)", () => {
  it("reads the one spec line, ignoring comments and blanks", () => {
    expect(parsePin(`# a comment\n\n${PIN}\n`)).toBe(PIN);
    expect(parsePin(`   ${PIN}   `)).toBe(PIN);
  });

  // The spec's own `#` separates repo from tag, so a comment marker can only be
  // the first character of a line.
  it("does not treat the spec's own '#' as a comment", () => {
    expect(parsePin(PIN)).toBe(PIN);
  });

  it("refuses a file naming no driver", () => {
    expect(() => parsePin("# only comments\n\n")).toThrow(/names no driver/);
  });

  // The class is what the entrypoint's catch discriminates on: a LaunchError is
  // addressed to an operator and prints as its message alone, while anything
  // else is a bug in the launcher and keeps its stack.
  it("throws LaunchError, the class the entrypoint prints bare", () => {
    expect(() => parsePin("")).toThrow(LaunchError);
  });

  it("refuses a file naming two, rather than picking one", () => {
    expect(() =>
      parsePin(`${PIN}\ngithub:Tojins/sandbar#v0.20.33\n`),
    ).toThrow(/2 spec lines/);
  });

  it("refuses anything that is not a tagged github release", () => {
    for (const spec of [
      "github:Tojins/sandbar#main",
      "github:Tojins/sandbar#3882c37",
      "github:Tojins/sandbar",
      "github:Tojins/sandbar#0.21.0",
      "@offergeist/sandbar@0.21.0",
      "file:../sandbar",
    ]) {
      expect(() => parsePin(spec), spec).toThrow(/tagged release/);
    }
  });
});

describe("installNeeded (#66)", () => {
  it("installs when nothing is there", () => {
    expect(installNeeded({ cliPresent: false, installedSpec: null }, PIN)).toBe(
      true,
    );
  });

  it("installs when the pin moved", () => {
    expect(
      installNeeded(
        { cliPresent: true, installedSpec: "github:Tojins/sandbar#v0.20.33" },
        PIN,
      ),
    ).toBe(true);
  });

  // A stamp with no bin behind it is a half-install, not an install.
  it("installs when the stamp matches but the bin is gone", () => {
    expect(installNeeded({ cliPresent: false, installedSpec: PIN }, PIN)).toBe(
      true,
    );
  });

  // What makes a relaunch run a byte-identical driver, and cost no network.
  it("skips when the stamped spec is already installed", () => {
    expect(installNeeded({ cliPresent: true, installedSpec: PIN }, PIN)).toBe(
      false,
    );
  });
});

describe("driverPaths (#66)", () => {
  it("puts the driver under .sandbar/, not in this repo's node_modules", () => {
    const paths = driverPaths("/repo");
    expect(paths.dir).toBe("/repo/.sandbar/driver");
    expect(paths.cli).toBe(
      "/repo/.sandbar/driver/node_modules/@offergeist/sandbar/dist/cli.js",
    );
    expect(paths.stamp).toBe("/repo/.sandbar/driver/installed-pin");
    expect(paths.manifest).toBe("/repo/.sandbar/driver/package.json");
  });

  // The path `sandbar.config.mjs` imports `readEnvFile` from is the same one
  // the launcher runs the bin out of; they are spelled in two files and must
  // not drift.
  it("is the path the repo's own config imports the driver from", () => {
    const configSource = readFileSync(
      new URL("../sandbar.config.mjs", import.meta.url),
      "utf8",
    );
    expect(configSource).toContain(
      ".sandbar/driver/node_modules/@offergeist/sandbar/dist/index.js",
    );
  });
});

describe("installArgv (#66)", () => {
  it("installs the spec into the driver prefix", () => {
    expect(installArgv("/repo/.sandbar/driver", PIN)).toEqual([
      "install",
      "--prefix",
      "/repo/.sandbar/driver",
      "--no-audit",
      "--no-fund",
      PIN,
    ]);
  });
});

describe("the launcher's relaunch code (#65, #66)", () => {
  // Repeated by hand in the launcher, which runs before the package it would
  // import exists. This is the assertion that keeps the two spellings equal.
  it("is the one the orchestrator exits with", () => {
    expect(LAUNCHER_RELAUNCH_CODE).toBe(EXIT_CODE_RELAUNCH);
  });
});

describe("sandbar.pin (#66)", () => {
  it("names a tagged release the launcher accepts", () => {
    const content = readFileSync(
      new URL(`../${PIN_FILE}`, import.meta.url),
      "utf8",
    );
    expect(parsePin(content)).toMatch(/^github:Tojins\/sandbar#v\d+\.\d+\.\d+$/);
  });
});
