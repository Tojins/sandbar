// The self-hosted launcher's decisions (#66).
//
// `scripts/sandbar-launch.mjs` is not part of the package — it runs before the
// package exists — so this file reaches across to it by path. What is tested is
// exactly what is decidable without a network: which spec a pin file names,
// when an install is required, the argv that performs it, and — through the
// launcher's one process seam — what an install that FAILS leaves behind. That
// last one is the safety property #66 is for ("never continue on whichever
// driver is on disk"), so it is asserted on the artefact the next launch
// actually reads: the stamp. What npm does with that argv, and what the loop
// does with a real child process, are npm's and `spawnSync`'s to define and are
// not faked here.
//
// It lives under `src/` with every other test, and `files` ships `src/` — so
// the published tarball carries this one file whose import points outside it.
// Left that way on purpose: nothing runs vitest from an install (`devDependencies`
// are not installed, and no consumer has a reason to), and the two alternatives
// are worse — shipping `scripts/` would publish self-hosting tooling no consumer
// runs, and moving the test out of `src/` would put the suite in two places to
// buy a dangling import in a file nobody executes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXIT_CODE_RELAUNCH as LAUNCHER_RELAUNCH_CODE,
  LaunchError,
  PIN_FILE,
  driverPaths,
  ensureDriver,
  installArgv,
  installDriver,
  installNeeded,
  parsePin,
  readInstallState,
} from "../scripts/sandbar-launch.mjs";
import { EXIT_CODE_RELAUNCH } from "./exit-conditions.js";
import { compareVersions, parseVersion } from "./requires-sandbar.js";

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

// This repo's own pin, and the two properties that decide whether the next
// launch after a landing works at all. The shape alone does not: a
// well-formed spec naming a tag that does not exist reads as covered while
// `npm install` fails on every launch and the loop stops until a human moves
// it by hand — the manual step #65 and #66 exist to delete. Tag existence
// cannot be asserted here (it is a fact about origin, and the gate has no
// network and a broken gitlink for a repository), so what is asserted is the
// offline invariant that implies it.
describe("sandbar.pin (#66)", () => {
  const read = (name: string) =>
    readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  const pinned = () => {
    const spec = parsePin(read(PIN_FILE));
    const version = parseVersion(spec.slice(spec.indexOf("#v") + 2));
    expect(version, spec).not.toBeNull();
    return version!;
  };

  it("names a tagged release the launcher accepts", () => {
    expect(parsePin(read(PIN_FILE))).toMatch(
      /^github:Tojins\/sandbar#v\d+\.\d+\.\d+$/,
    );
  });

  // The rule `sandbar.pin`'s header states: the pin LAGS this checkout. The
  // version in `package.json` is the one being written right now — it has not
  // landed, so `auto-tag.yml` has not tagged it, so it is not installable; and
  // even once it lands it only gets a tag if it is the version at the pushed
  // HEAD, which the merger's whole-source-pass push makes a coin flip. Pinning
  // it, or anything above it, is pinning something that may never exist.
  it("is strictly older than the version being written here", () => {
    const working = parseVersion(
      JSON.parse(read("package.json")).version as string,
    );
    expect(working).not.toBeNull();
    expect(compareVersions(pinned(), working!)).toBeLessThan(0);
  });

  // The other half of the pairing, and the one a fallback to an older release
  // gets wrong: a driver that installs and then refuses the config it was
  // installed to read. Regex rather than an import because importing the
  // config runs it, and it throws unless a driver is installed — the literal
  // is what this repo's config carries, and a computed floor here would want
  // this assertion rewritten rather than deleted.
  it("satisfies the floor sandbar.config.mjs declares", () => {
    const declared = /^\s*requiresSandbar:\s*"([^"]*)"/m.exec(
      read("sandbar.config.mjs"),
    );
    if (declared === null) return; // No floor declared: nothing to satisfy.
    const floor = parseVersion(declared[1]!);
    expect(floor, declared[1]).not.toBeNull();
    expect(compareVersions(pinned(), floor!)).toBeGreaterThanOrEqual(0);
  });
});

// Decisions 3 and 4 of the launcher's header — "install only when the pin
// moves" and "a failed install stops the loop" — which between them are what
// keeps a series from being driven by something nobody chose. Both are
// decisions about the STAMP, since that is the only thing a later launch reads
// to tell "the pin is installed" from "an install did not finish": every
// assertion below is therefore about whether the stamp exists afterwards, not
// merely about the throw. A fake `spawn` stands in for npm — the failures
// being tested (a tag that does not exist, an install whose scripts did not
// run) cannot be produced on demand from a real one.
describe("installDriver (#66)", () => {
  let root: string;
  let paths: ReturnType<typeof driverPaths>;
  const logged: string[] = [];
  const io = (spawn: (...args: never[]) => unknown) => ({
    spawn: spawn as never,
    log: (m: string) => void logged.push(m),
  });

  // What a successful npm install leaves behind: the package, built.
  const writeCli = () => {
    mkdirSync(dirname(paths.cli), { recursive: true });
    writeFileSync(paths.cli, "#!/usr/bin/env node\n");
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-launcher-"));
    paths = driverPaths(root);
    logged.length = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stamps the spec after an install that produced a bin", () => {
    installDriver(
      paths,
      PIN,
      io(() => {
        writeCli();
        return { status: 0 };
      }),
    );

    expect(readFileSync(paths.stamp, "utf8").trim()).toBe(PIN);
    expect(readInstallState(paths)).toEqual({
      cliPresent: true,
      installedSpec: PIN,
    });
    expect(installNeeded(readInstallState(paths), PIN)).toBe(false);
  });

  it("runs npm with the install argv, in the driver prefix", () => {
    const calls: unknown[][] = [];
    installDriver(
      paths,
      PIN,
      io(((...args: unknown[]) => {
        calls.push(args);
        writeCli();
        return { status: 0 };
      }) as never),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("npm");
    expect(calls[0]?.[1]).toEqual(installArgv(paths.dir, PIN));
  });

  // The tag does not exist yet, or the host cannot reach GitHub. The loop must
  // stop, and must not record an install that did not happen.
  it("throws and leaves no stamp when npm exits non-zero", () => {
    expect(() =>
      installDriver(
        paths,
        PIN,
        io(() => ({ status: 1 })),
      ),
    ).toThrow(LaunchError);

    expect(existsSync(paths.stamp)).toBe(false);
    expect(installNeeded(readInstallState(paths), PIN)).toBe(true);
  });

  // Exit 0 with no build behind it — an install whose `prepare` script did not
  // run. Stamping this would run the next launch as `node <missing>`.
  it("throws and leaves no stamp when the install produced no bin", () => {
    expect(() =>
      installDriver(
        paths,
        PIN,
        io(() => ({ status: 0 })),
      ),
    ).toThrow(/reported success, but .*cli\.js is missing/s);

    expect(existsSync(paths.stamp)).toBe(false);
  });

  it("throws and leaves no stamp when npm cannot be run at all", () => {
    expect(() =>
      installDriver(
        paths,
        PIN,
        io(() => ({ error: new Error("spawn npm ENOENT") })),
      ),
    ).toThrow(/could not run npm/);

    expect(existsSync(paths.stamp)).toBe(false);
  });

  // The half-install that would otherwise be indistinguishable from a whole
  // one: a stamp from the previous pin survives a failed attempt at the new
  // one, and the next launch reads it as "installed".
  it("clears a previous stamp before installing, not after", () => {
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.stamp, "github:Tojins/sandbar#v0.20.33\n");
    writeCli();

    expect(() =>
      installDriver(
        paths,
        PIN,
        io(() => ({ status: 1 })),
      ),
    ).toThrow(LaunchError);

    expect(existsSync(paths.stamp)).toBe(false);
    expect(installNeeded(readInstallState(paths), PIN)).toBe(true);
  });

  // The manifest carries `npm approve-scripts`' `allowScripts` entry, which is
  // what lets the next install build `dist/` at all — rewriting it every time
  // would erase the approval every time.
  it("writes the install root's manifest once, and never overwrites it", () => {
    mkdirSync(paths.dir, { recursive: true });
    const approved = JSON.stringify({
      name: "sandbar-driver",
      private: true,
      allowScripts: { "@offergeist/sandbar": true },
    });
    writeFileSync(paths.manifest, approved);

    installDriver(
      paths,
      PIN,
      io(() => {
        writeCli();
        return { status: 0 };
      }),
    );

    expect(readFileSync(paths.manifest, "utf8")).toBe(approved);
  });

  it("creates the manifest when there is none, as a private named root", () => {
    installDriver(
      paths,
      PIN,
      io(() => {
        writeCli();
        return { status: 0 };
      }),
    );

    expect(JSON.parse(readFileSync(paths.manifest, "utf8"))).toMatchObject({
      name: "sandbar-driver",
      private: true,
    });
  });
});

describe("ensureDriver (#66)", () => {
  let root: string;
  let paths: ReturnType<typeof driverPaths>;
  const io = (spawn: (...args: never[]) => unknown) => ({
    spawn: spawn as never,
    log: () => {},
  });
  const refuse = io(() => ({ status: 1 }));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-launcher-"));
    paths = driverPaths(root);
    writeFileSync(join(root, PIN_FILE), `# the pin\n${PIN}\n`);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // The whole loop's safety property, at the level that decides it: a launch
  // whose install failed must leave the next launch reinstalling rather than
  // running whatever is on disk.
  it("stops on a failed install, and the next launch retries it", () => {
    expect(() => ensureDriver(root, refuse)).toThrow(LaunchError);
    expect(existsSync(paths.stamp)).toBe(false);

    // Second launch: the fake refuses again, so what is asserted is that it was
    // ASKED — a launch that read the failed attempt as installed would have
    // returned instead.
    expect(() => ensureDriver(root, refuse)).toThrow(LaunchError);
  });

  // What makes a relaunch byte-identical and free: an install already stamped
  // is not re-run, so nothing about the driver can change under the loop.
  it("does not install again when the stamp already matches", () => {
    mkdirSync(dirname(paths.cli), { recursive: true });
    writeFileSync(paths.cli, "#!/usr/bin/env node\n");
    writeFileSync(paths.stamp, `${PIN}\n`);
    let spawned = 0;

    const result = ensureDriver(
      root,
      io(() => {
        spawned += 1;
        return { status: 0 };
      }),
    );

    expect(spawned).toBe(0);
    expect(result).toEqual({ spec: PIN, cli: paths.cli });
  });

  it("refuses a pin file that names nothing installable", () => {
    writeFileSync(join(root, PIN_FILE), "github:Tojins/sandbar#main\n");
    expect(() => ensureDriver(root, refuse)).toThrow(/tagged release/);
  });

  it("refuses a root with no pin file at all", async () => {
    await rm(join(root, PIN_FILE));
    expect(() => ensureDriver(root, refuse)).toThrow(/cannot read .*sandbar\.pin/);
  });
});
