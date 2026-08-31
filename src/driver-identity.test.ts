import { describe, expect, it } from "vitest";

import {
  type GitExec,
  UNKNOWN_TREE,
  formatDriverIdentity,
  readDriverIdentity,
  readTreeState,
} from "./driver-identity.js";

type Call = { readonly cwd: string; readonly args: readonly string[] };

// Every git call this module makes is `.then(ok, fail)`, so a fake that
// REJECTS is the interesting one — it is how "could not be determined" is
// produced, and the module must never let that escape.
function fakeGit(
  answer: (call: Call) => string | Error,
): { git: GitExec; calls: Call[] } {
  const calls: Call[] = [];
  const git: GitExec = async (cwd, args) => {
    const call = { cwd, args };
    calls.push(call);
    const out = answer(call);
    if (out instanceof Error) throw out;
    return out;
  };
  return { git, calls };
}

const verb = (call: Call): string => call.args[0] ?? "";

// `check-ignore` exits non-zero for a path the repo does not ignore, which is
// the ordinary case; git's exit code reaches us as a rejection.
const notIgnored = new Error("exit 1");

describe("readTreeState", () => {
  it("reads the commit and a clean tree", async () => {
    const { git } = fakeGit((c) =>
      verb(c) === "check-ignore"
        ? notIgnored
        : verb(c) === "rev-parse"
          ? "9f1c0a2b3c4d5e6f70819293a4b5c6d7e8f90a1b\n"
          : "",
    );
    expect(await readTreeState("/repo", git)).toEqual({
      commit: "9f1c0a2b3c4d5e6f70819293a4b5c6d7e8f90a1b",
      dirty: false,
    });
  });

  it("counts an untracked path as dirty, with untracked files forced on", async () => {
    const { git, calls } = fakeGit((c) =>
      verb(c) === "check-ignore"
        ? notIgnored
        : verb(c) === "rev-parse"
          ? "abc\n"
          : "?? src/new-module.ts\n",
    );
    expect(await readTreeState("/repo", git)).toEqual({
      commit: "abc",
      dirty: true,
    });
    // The one thing this argv may not lose: `tsc` compiles an untracked
    // `src/*.ts` into the driver, and a repo whose `status.showUntrackedFiles`
    // is `no` would report that tree clean.
    const status = calls.find((c) => c.args.includes("status"));
    expect(status?.args).toEqual([
      "-c",
      "status.showUntrackedFiles=normal",
      "status",
      "--porcelain",
    ]);
  });

  it("reports unknown for a directory the enclosing repo ignores, without asking it anything else", async () => {
    // The node_modules case: `rev-parse` there would happily answer with the
    // HOST repo's HEAD, a true sha about a different repository.
    const { git, calls } = fakeGit(() => "");
    expect(await readTreeState("/host/node_modules/@offergeist/sandbar", git)).toEqual(
      UNKNOWN_TREE,
    );
    expect(calls.map(verb)).toEqual(["check-ignore"]);
  });

  it("degrades each field on its own when git will not answer", async () => {
    const { git } = fakeGit((c) =>
      verb(c) === "check-ignore"
        ? notIgnored
        : verb(c) === "rev-parse"
          ? new Error("fatal: ambiguous argument 'HEAD'")
          : "M  src/run.ts\n",
    );
    expect(await readTreeState("/repo", git)).toEqual({
      commit: null,
      dirty: true,
    });

    const { git: noStatus } = fakeGit((c) =>
      verb(c) === "check-ignore"
        ? notIgnored
        : verb(c) === "rev-parse"
          ? "abc\n"
          : new Error("timed out"),
    );
    expect(await readTreeState("/repo", noStatus)).toEqual({
      commit: "abc",
      dirty: null,
    });
  });

  it("reports unknown when there is no git at all", async () => {
    const { git } = fakeGit(() => new Error("spawn git ENOENT"));
    expect(await readTreeState("/repo", git)).toEqual(UNKNOWN_TREE);
  });
});

describe("readDriverIdentity", () => {
  it("asks about the config file's DIRECTORY, and about the code path as given", async () => {
    const { git, calls } = fakeGit((c) =>
      verb(c) === "check-ignore" ? notIgnored : verb(c) === "rev-parse" ? "abc\n" : "",
    );
    const id = await readDriverIdentity({
      configPath: "/host/repo/sandbar.config.mjs",
      codePath: "/host/repo/node_modules/@offergeist/sandbar",
      version: "0.20.29",
      git,
    });
    expect(new Set(calls.map((c) => c.cwd))).toEqual(
      new Set(["/host/repo", "/host/repo/node_modules/@offergeist/sandbar"]),
    );
    expect(id.version).toBe("0.20.29");
    expect(id.configPath).toBe("/host/repo/sandbar.config.mjs");
    expect(id.config).toEqual({ commit: "abc", dirty: false });
  });

  it("asks git nothing about a config that is not a file", async () => {
    const { git, calls } = fakeGit(() => new Error("spawn git ENOENT"));
    const id = await readDriverIdentity({
      configPath: null,
      codePath: "/pkg",
      version: "0.1.0",
      git,
    });
    expect(id.config).toEqual(UNKNOWN_TREE);
    expect(calls.every((c) => c.cwd === "/pkg")).toBe(true);
  });
});

describe("formatDriverIdentity", () => {
  it("names the version, both trees and both dirty states on one line", async () => {
    const line = formatDriverIdentity({
      version: "0.20.29",
      codePath: "/home/t/sandbar",
      code: { commit: "9f1c0a2", dirty: true },
      configPath: "/home/t/sandbar/sandbar.config.mjs",
      config: { commit: "9f1c0a2", dirty: false },
    });
    expect(line).toBe(
      "Driver: sandbar 0.20.29 · built from /home/t/sandbar @9f1c0a2 dirty · " +
        "config /home/t/sandbar/sandbar.config.mjs @9f1c0a2 clean",
    );
    expect(line.split("\n")).toHaveLength(1);
  });

  it("spells every undetermined field `unknown` rather than guessing", () => {
    expect(
      formatDriverIdentity({
        version: "unknown",
        codePath: "/pkg",
        code: UNKNOWN_TREE,
        configPath: "/host/sandbar.config.mjs",
        config: { commit: "abc", dirty: null },
      }),
    ).toBe(
      "Driver: sandbar unknown · built from /pkg @unknown dirty-unknown · " +
        "config /host/sandbar.config.mjs @abc dirty-unknown",
    );
  });

  it("says so when there is no config file behind the run", () => {
    expect(
      formatDriverIdentity({
        version: "0.1.0",
        codePath: "/pkg",
        code: { commit: "abc", dirty: false },
        configPath: null,
        config: UNKNOWN_TREE,
      }),
    ).toBe(
      "Driver: sandbar 0.1.0 · built from /pkg @abc clean · " +
        "config none (run() called with no config file)",
    );
  });
});
