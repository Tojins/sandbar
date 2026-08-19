// #38 — the bin's argv contract.
//
// `parseArgs` is pure so this is a table test rather than a process launch. The
// cases that matter are the refusals: a mistyped flag that parsed as "no
// arguments" would silently run the DEFAULT config, which on a machine with
// several repos is a run against the wrong one.
import { describe, expect, it } from "vitest";

import { parseArgs } from "./cli.js";
import { SandbarError } from "./errors.js";

describe("parseArgs", () => {
  it("defaults to ./sandbar.config.mjs", () => {
    expect(parseArgs([])).toEqual({
      kind: "run",
      configPath: "sandbar.config.mjs",
    });
  });

  it("accepts --config in both spellings", () => {
    expect(parseArgs(["--config", "other.mjs"])).toEqual({
      kind: "run",
      configPath: "other.mjs",
    });
    expect(parseArgs(["--config=other.mjs"])).toEqual({
      kind: "run",
      configPath: "other.mjs",
    });
  });

  it("answers --help and --version", () => {
    expect(parseArgs(["--help"]).kind).toBe("help");
    expect(parseArgs(["-h"]).kind).toBe("help");
    expect(parseArgs(["--version"]).kind).toBe("version");
  });

  // A flag that duplicates a config field would be a second source of truth —
  // the thing #38 removes. There is exactly one, and anything else is a typo
  // rather than a feature request to honour silently.
  it("refuses an unrecognised flag rather than ignoring it", () => {
    expect(() => parseArgs(["--cwd", "/repo"])).toThrow(SandbarError);
    expect(() => parseArgs(["--config", "x.mjs", "--verbose"])).toThrow(
      /Unrecognised argument/,
    );
  });

  it("refuses a bare positional", () => {
    expect(() => parseArgs(["sandbar.config.mjs"])).toThrow(
      /Unrecognised argument/,
    );
  });

  // `--config --help` must not silently consume the next flag as a path and
  // then fail with "no config at ./--help".
  it("refuses --config with no value, or with a flag as its value", () => {
    expect(() => parseArgs(["--config"])).toThrow(/--config needs a path/);
    expect(() => parseArgs(["--config", "--help"])).toThrow(
      /--config needs a path/,
    );
    expect(() => parseArgs(["--config="])).toThrow(/--config needs a path/);
  });
});
