// The self-hosted launcher's decisions (#66).
//
// `scripts/sandbar-launch.mjs` is not part of the package — it runs before the
// package exists — so this file reaches across to it by path. What is tested is
// exactly what is decidable without a network: which spec a pin file names,
// when an install is required, the argv that performs it, and — through the
// launcher's two process seams — what an install that FAILS leaves behind, plus
// which exit codes the loop continues on. Those last two are the safety
// properties #66 and #65 are for ("never continue on whichever driver is on
// disk", "loop only on 75"), so the first is asserted on the artefact the next
// launch actually reads — the stamp — and the second on the number of launches
// a sequence of exit codes produces. What npm does with that argv, and what
// `spawnSync` does with a real child process, are npm's and node's to define
// and are not faked here.
//
// It lives under `src/` with every other test, and `files` ships `src/` — so
// the published tarball carries this one file whose import points outside it.
// Left that way on purpose: nothing runs vitest from an install (`devDependencies`
// are not installed, and no consumer has a reason to), and the two alternatives
// are worse — shipping `scripts/` would publish self-hosting tooling no consumer
// runs, and moving the test out of `src/` would put the suite in two places to
// buy a dangling import in a file nobody executes.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXIT_CODE_RELAUNCH as LAUNCHER_RELAUNCH_CODE,
  LaunchError,
  PIN_FILE,
  driverPaths,
  ensureDriver,
  holdWakeLock,
  installArgv,
  installDriver,
  installNeeded,
  main,
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
  //
  // A missing match FAILS rather than passing vacuously. "This config declares
  // no floor" and "the floor is spelled some way this regex does not read" —
  // single quotes, a computed value, a reformat — are indistinguishable from
  // here, and reading the second as a pass would retire the pairing check in
  // silence, which is the failure mode #66 is about.
  it("satisfies the floor sandbar.config.mjs declares", () => {
    const declared = /^\s*requiresSandbar:\s*"([^"]*)"/m.exec(
      read("sandbar.config.mjs"),
    );
    expect(
      declared,
      "sandbar.config.mjs declares no `requiresSandbar: \"X.Y.Z\"` this test can read",
    ).not.toBeNull();
    const floor = parseVersion(declared![1]!);
    expect(floor, declared![1]).not.toBeNull();
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
    expect(result).toEqual({
      spec: PIN,
      cli: paths.cli,
      wakeLock: paths.wakeLock,
    });
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

// #65's contract, which is the whole of the loop: continue on
// EXIT_CODE_RELAUNCH and on nothing else, propagate every other exit code
// unchanged. It is the one claim the launcher makes that the shell one-liner
// also made and that nothing has ever exercised — a `[ "$c" -eq 75 ]` typo, or
// a `!==` slipped to `!=`, would turn "landed, go again" into either a stopped
// series or an unbounded one. The driver is stamped in place so no install is
// attempted, and a fake `run` answers a scripted sequence of exits.
describe("main — the relaunch loop (#65, #66)", () => {
  let root: string;
  let paths: ReturnType<typeof driverPaths>;

  // A driver already installed at the pin: `ensureDriver` skips straight past
  // the install, which is what every launch after the first does.
  const stampInstalled = () => {
    mkdirSync(dirname(paths.cli), { recursive: true });
    writeFileSync(paths.cli, "#!/usr/bin/env node\n");
    writeFileSync(paths.stamp, `${PIN}\n`);
  };

  // Answers `exits` in order, recording the argv each launch was given.
  const driver = (...exits: Array<Record<string, unknown>>) => {
    const launches: unknown[][] = [];
    return {
      launches,
      run: ((...args: unknown[]) => {
        launches.push(args);
        return exits[launches.length - 1] ?? { status: 0 };
      }) as never,
    };
  };

  const io = (over: Record<string, unknown>) => ({
    log: () => {},
    spawn: (() => {
      throw new Error("no install expected");
    }) as never,
    root,
    ...over,
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-launcher-"));
    paths = driverPaths(root);
    writeFileSync(join(root, PIN_FILE), `${PIN}\n`);
    stampInstalled();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("launches once and returns the driver's exit code", () => {
    const d = driver({ status: 0 });
    expect(main([], io({ run: d.run }))).toBe(0);
    expect(d.launches).toHaveLength(1);
    expect(d.launches[0]?.[0]).toBe(process.execPath);
    expect(d.launches[0]?.[1]).toEqual([paths.cli]);
    // `cwd: root`, which the launcher argues for at length: the driver's cwd is
    // what decides which repository a series operates on, and it must be the
    // repo whose `sandbar.pin` chose the driver rather than wherever the
    // launcher was invoked from.
    expect(d.launches[0]?.[2]).toMatchObject({ cwd: root });
  });

  it("loops on 75 and stops on the first code that is not", () => {
    const d = driver(
      { status: EXIT_CODE_RELAUNCH },
      { status: EXIT_CODE_RELAUNCH },
      { status: 3 },
    );
    expect(main([], io({ run: d.run }))).toBe(3);
    expect(d.launches).toHaveLength(3);
  });

  // Every non-75 code is the run's own answer and belongs to whoever launched
  // the loop: 2 is stuck, 3 is the budget, 1 is a fault. Swallowing any of them
  // would report a failed series as a finished one.
  it("propagates every other exit code without a second launch", () => {
    for (const status of [0, 1, 2, 3, 74, 76]) {
      const d = driver({ status });
      expect(main([], io({ run: d.run })), String(status)).toBe(status);
      expect(d.launches, String(status)).toHaveLength(1);
    }
  });

  it("forwards its own argv to the driver", () => {
    const d = driver({ status: 0 });
    main(["gate", "--config", "other.mjs"], io({ run: d.run }));
    expect(d.launches[0]?.[1]).toEqual([
      paths.cli,
      "gate",
      "--config",
      "other.mjs",
    ]);
  });

  // The hand path: install the driver and stop, without starting a series.
  it("returns 0 without launching under --install-only", () => {
    const d = driver({ status: 0 });
    expect(main(["--install-only"], io({ run: d.run }))).toBe(0);
    expect(d.launches).toHaveLength(0);
  });

  // A driver that could not be STARTED is the launcher's own failure: there is
  // no verdict behind it and no exit code that would mean one.
  it("stops loudly when the driver cannot be spawned", () => {
    const d = driver({ error: new Error("spawn ENOENT") });
    expect(() => main([], io({ run: d.run }))).toThrow(/could not run .*cli\.js/);
  });

  // A driver KILLED is the other thing, and the distinction is the one
  // `LaunchError` exists to draw: the launcher did its job and the run died, so
  // it is reported the way a shell reports it — `128 + signal`, which is also
  // the shape `cleanup.ts`'s own SIGINT/SIGTERM exits already have — rather
  // than as the launcher's exit 1.
  it("reports a signal-killed driver as 128 + the signal, not as its own fault", () => {
    const logged: string[] = [];
    const d = driver({ status: null, signal: "SIGKILL" });
    expect(
      main([], io({ run: d.run, log: (m: string) => void logged.push(m) })),
    ).toBe(128 + constants.signals.SIGKILL);
    expect(logged.join("\n")).toMatch(/killed by SIGKILL/);
  });

  // Neither a status nor a signal this platform names: there is nothing to
  // encode, so it goes back to being the launcher saying it cannot proceed.
  it("stops loudly when the driver answered with neither", () => {
    const d = driver({ status: null, signal: "SIGNOTATHING" });
    expect(() => main([], io({ run: d.run }))).toThrow(
      /neither a status nor a signal/,
    );
  });

  // Decision 4 reaching the loop: an install that fails stops it, rather than
  // launching whatever is on disk.
  it("never launches when the install failed", () => {
    writeFileSync(join(root, PIN_FILE), "github:Tojins/sandbar#v9.9.9\n");
    const d = driver({ status: 0 });
    expect(() =>
      main([], io({ run: d.run, spawn: (() => ({ status: 1 })) as never })),
    ).toThrow(LaunchError);
    expect(d.launches).toHaveLength(0);
  });

  // The pin is re-read every iteration, so an operator who edits it between
  // cycles gets the new driver at the next relaunch — the one way a series can
  // change drivers under itself, and it takes an edit to a committed file.
  it("re-reads the pin on each relaunch", () => {
    const moved = "github:Tojins/sandbar#v0.21.1";
    const installs: string[] = [];
    const d = driver({ status: EXIT_CODE_RELAUNCH }, { status: 0 });
    let launched = 0;

    main(
      [],
      io({
        run: ((...args: unknown[]) => {
          if (launched++ === 0) writeFileSync(join(root, PIN_FILE), `${moved}\n`);
          return d.run(...(args as [])) as never;
        }) as never,
        spawn: ((_cmd: string, argv: string[]) => {
          installs.push(argv[argv.length - 1]!);
          writeFileSync(paths.cli, "#!/usr/bin/env node\n");
          return { status: 0 };
        }) as never,
      }),
    );

    expect(installs).toEqual([moved]);
    expect(d.launches).toHaveLength(2);
  });
});

// #117. The wake lock is the one child that must outlive a call: every sleep
// observed on this repo's host began within minutes of a run ending, and one of
// them 6 ms after the driver released its own. #65's seam is between two driver
// processes, so the property is about THIS file — one lock, taken before the
// first launch, still held across every relaunch, released when the loop is
// done — and it is a property no per-run holder can have.
describe("the series-long wake lock (#117)", () => {
  let root: string;
  let paths: ReturnType<typeof driverPaths>;

  const stampInstalled = () => {
    mkdirSync(dirname(paths.cli), { recursive: true });
    writeFileSync(paths.cli, "#!/usr/bin/env node\n");
    writeFileSync(paths.stamp, `${PIN}\n`);
  };

  // Records the holds, and gives each one back a child whose release is
  // observable. `on` is present because `holdWakeLock` attaches an error
  // handler to the async `spawn` it does not get from `spawnSync`.
  const holder = () => {
    const holds: unknown[][] = [];
    const children: Array<{ ended: boolean; killed: boolean }> = [];
    return {
      holds,
      children,
      hold: ((...args: unknown[]) => {
        holds.push(args);
        const child = { ended: false, killed: false };
        children.push(child);
        return {
          on: () => {},
          stdin: { end: () => void (child.ended = true) },
          kill: () => void (child.killed = true),
        };
      }) as never,
    };
  };

  const driver = (...exits: Array<Record<string, unknown>>) => {
    const launches: unknown[][] = [];
    return {
      launches,
      run: ((...args: unknown[]) => {
        launches.push(args);
        return exits[launches.length - 1] ?? { status: 0 };
      }) as never,
    };
  };

  const io = (over: Record<string, unknown>) => ({
    log: () => {},
    spawn: (() => {
      throw new Error("no install expected");
    }) as never,
    root,
    ...over,
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-launcher-"));
    paths = driverPaths(root);
    writeFileSync(join(root, PIN_FILE), `${PIN}\n`);
    stampInstalled();
    // The holder program the driver ships. Its EXISTENCE is the capability
    // probe, so every test that expects a lock has to put it there.
    writeFileSync(paths.wakeLock, "// held\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("holds ONE lock across every relaunch, and releases it at the end", () => {
    const d = driver(
      { status: EXIT_CODE_RELAUNCH },
      { status: EXIT_CODE_RELAUNCH },
      { status: 0 },
    );
    const h = holder();
    expect(main([], io({ run: d.run, hold: h.hold }))).toBe(0);
    expect(d.launches).toHaveLength(3);
    // One hold for three launches is the whole point: a lock re-taken per
    // iteration would lapse in exactly the seam that cost 50 minutes.
    expect(h.holds).toHaveLength(1);
    expect(h.holds[0]?.[0]).toBe(process.execPath);
    expect(h.holds[0]?.[1]).toEqual([paths.wakeLock]);
    // stdin is the lock's lifeline, on both sides of the pipe.
    expect(h.holds[0]?.[2]).toMatchObject({
      stdio: ["pipe", "inherit", "inherit"],
    });
    expect(h.children[0]).toEqual({ ended: true, killed: true });
  });

  it("releases the lock when the driver dies by a signal", () => {
    const d = driver({ status: null, signal: "SIGKILL" });
    const h = holder();
    main([], io({ run: d.run, hold: h.hold }));
    expect(h.children[0]?.ended).toBe(true);
  });

  it("releases the lock when a launch throws", () => {
    // `finally`, not a release before each `return`: there are six ways out of
    // that loop and a leaked wake lock is a host that will not sleep again.
    const h = holder();
    expect(() =>
      main(
        [],
        io({
          run: (() => ({ error: new Error("boom") })) as never,
          hold: h.hold,
        }),
      ),
    ).toThrow(LaunchError);
    expect(h.children[0]?.ended).toBe(true);
  });

  it("takes no lock for --install-only, which is not a series", () => {
    const d = driver({ status: 0 });
    const h = holder();
    expect(main(["--install-only"], io({ run: d.run, hold: h.hold }))).toBe(0);
    expect(h.holds).toHaveLength(0);
  });

  it("says so and runs anyway when the pinned driver predates the holder", () => {
    // `sandbar.pin` LAGS this checkout always (#66), so this is the ordinary
    // state for a release or two after the feature lands — a fact, never a
    // refusal to launch.
    rmSync(paths.wakeLock);
    const logged: string[] = [];
    const d = driver({ status: 0 });
    const h = holder();
    expect(
      main(
        [],
        io({
          run: d.run,
          hold: h.hold,
          log: (m: string) => void logged.push(m),
        }),
      ),
    ).toBe(0);
    expect(h.holds).toHaveLength(0);
    expect(d.launches).toHaveLength(1);
    expect(logged.join("\n")).toContain("wake-lock: NOT held");
  });

  it("probes for the holder beside the driver's own bin", () => {
    expect(paths.wakeLock).toBe(
      join(paths.dir, "node_modules", "@offergeist", "sandbar", "dist", "keepawake-hold.js"),
    );
    expect(holdWakeLock(join(root, "nope.js"), { log: () => {} })).toBeNull();
  });
});
