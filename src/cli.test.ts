// #38 — the bin's argv contract.
//
// `parseArgs` is pure so this is a table test rather than a process launch. The
// cases that matter are the refusals: a mistyped flag that parsed as "no
// arguments" would silently run the DEFAULT config, which on a machine with
// several repos is a run against the wrong one.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, parseArgs, withDefaultCwd } from "./cli.js";
import type { RunConfig } from "./config.js";
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

// #45 — the one subcommand.
describe("parseArgs: the gate subcommand", () => {
  it("defaults the worktree to the current directory and keeps nothing", () => {
    expect(parseArgs(["gate"])).toEqual({
      kind: "gate",
      configPath: "sandbar.config.mjs",
      worktree: ".",
      keep: false,
    });
  });

  it("takes --config, --worktree in both spellings, and --keep", () => {
    expect(parseArgs(["gate", "--config", "o.mjs", "--worktree", "/w", "--keep"])).toEqual(
      { kind: "gate", configPath: "o.mjs", worktree: "/w", keep: true },
    );
    expect(parseArgs(["gate", "--config=o.mjs", "--worktree=/w"])).toEqual({
      kind: "gate",
      configPath: "o.mjs",
      worktree: "/w",
      keep: false,
    });
  });

  // The subcommand is first-position only. Accepted anywhere, `sandbar --config
  // x gate` and `sandbar gate --config x` would look alike and do entirely
  // different things — one runs the full agent loop.
  it("only recognises `gate` in first position", () => {
    expect(() => parseArgs(["--config", "x.mjs", "gate"])).toThrow(
      /Unrecognised argument 'gate'/,
    );
  });

  // The mirror of that: a gate flag on the run path is someone who dropped the
  // subcommand, and the whole point of the refusal is that they are told so
  // rather than shown a usage dump for an "unrecognised" flag that exists.
  it("names the subcommand when a gate flag arrives without it", () => {
    expect(() => parseArgs(["--keep"])).toThrow(/sandbar gate --keep/);
    expect(() => parseArgs(["--worktree", "/w"])).toThrow(/is a `sandbar gate` flag/);
    expect(() => parseArgs(["--worktree=/w"])).toThrow(/is a `sandbar gate` flag/);
  });

  it("refuses --worktree with no value, or with a flag as its value", () => {
    expect(() => parseArgs(["gate", "--worktree"])).toThrow(
      /--worktree needs a path/,
    );
    expect(() => parseArgs(["gate", "--worktree", "--keep"])).toThrow(
      /--worktree needs a path/,
    );
    expect(() => parseArgs(["gate", "--worktree="])).toThrow(
      /--worktree needs a path/,
    );
  });

  it("still answers --help and --version, and still refuses a typo", () => {
    expect(parseArgs(["gate", "--help"]).kind).toBe("help");
    expect(parseArgs(["gate", "--version"]).kind).toBe("version");
    expect(() => parseArgs(["gate", "--kepe"])).toThrow(/Unrecognised argument/);
    expect(() => parseArgs(["gate", "extra"])).toThrow(/Unrecognised argument/);
  });
});

// The bin's headline behaviour. A test that runs from the directory it points
// at cannot see this — `process.cwd()` and `dirname(configPath)` coincide and
// it passes with the default deleted — so every case here names a config path
// somewhere the process is NOT standing.
describe("withDefaultCwd", () => {
  const cfg = (over: Partial<RunConfig> = {}) =>
    ({ sourceBranch: "main", ...over }) as RunConfig;

  it("defaults cwd to the directory holding the config file", () => {
    expect(withDefaultCwd(cfg(), "/repos/widgets/sandbar.config.mjs").cwd).toBe(
      "/repos/widgets",
    );
    expect(withDefaultCwd(cfg(), "/repos/widgets/sandbar.config.mjs").cwd).not.toBe(
      process.cwd(),
    );
  });

  it("leaves an explicit cwd alone", () => {
    expect(
      withDefaultCwd(cfg({ cwd: "/elsewhere" }), "/repos/widgets/sandbar.config.mjs")
        .cwd,
    ).toBe("/elsewhere");
  });

  // A spread with the default first would let this key overwrite it and fall
  // through to `process.cwd()` — the behaviour the default exists to make
  // unreachable, restored by the shape of the merge.
  it("treats an explicitly-undefined cwd as absent, not as an override", () => {
    expect(
      withDefaultCwd(cfg({ cwd: undefined }), "/repos/widgets/sandbar.config.mjs")
        .cwd,
    ).toBe("/repos/widgets");
  });

  it("does not otherwise touch the config", () => {
    const c = cfg({ sourceBranch: "trunk", workDir: ".state" });
    expect(withDefaultCwd(c, "/r/sandbar.config.mjs")).toMatchObject({
      sourceBranch: "trunk",
      workDir: ".state",
    });
  });
});

// Each branch is an operator-facing message on the very first thing the bin
// does, so each is reached with a real file rather than a mock.
describe("loadConfig", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  const write = async (body: string, name = "sandbar.config.mjs") => {
    const dir = await mkdtemp(join(tmpdir(), "sandbar-cli-"));
    dirs.push(dir);
    const path = join(dir, name);
    await writeFile(path, body);
    return path;
  };

  it("returns the default export", async () => {
    const path = await write('export default { sourceBranch: "main" };\n');
    await expect(loadConfig(path)).resolves.toEqual({ sourceBranch: "main" });
  });

  it("survives top-level await, because the config is a program", async () => {
    const path = await write(
      'const b = await Promise.resolve("trunk");\nexport default { sourceBranch: b };\n',
    );
    await expect(loadConfig(path)).resolves.toEqual({ sourceBranch: "trunk" });
  });

  it("says so when there is no config, and does not search upward", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbar-cli-"));
    dirs.push(dir);
    await expect(loadConfig(join(dir, "sandbar.config.mjs"))).rejects.toThrow(
      /does not search parent directories/,
    );
  });

  it("reports a config that throws on import as a load failure", async () => {
    const path = await write('throw new Error("boom");\n');
    await expect(loadConfig(path)).rejects.toThrow(/Failed to load the sandbar config/);
  });

  it("refuses a config with no default export", async () => {
    const path = await write('export const config = { sourceBranch: "main" };\n');
    await expect(loadConfig(path)).rejects.toThrow(/has no default export/);
  });

  // The factory shape is the plausible wrong guess, and it has to be named
  // rather than falling into the generic "not an object" message: config files
  // may use top-level await, so a factory buys nothing.
  it("refuses a default-exported function", async () => {
    const path = await write('export default () => ({ sourceBranch: "main" });\n');
    await expect(loadConfig(path)).rejects.toThrow(/default-exports a function/);
  });

  it.each([
    ["a string", 'export default "main";\n'],
    ["an array", "export default [];\n"],
    ["null", "export default null;\n"],
  ])("refuses %s as the config", async (_name, body) => {
    const path = await write(body);
    await expect(loadConfig(path)).rejects.toThrow(/default-exports a/);
  });

  it("throws SandbarError, so the bin prints a message rather than a stack", async () => {
    const path = await write("export default 1;\n");
    await expect(loadConfig(path)).rejects.toBeInstanceOf(SandbarError);
  });
});
