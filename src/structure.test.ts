// Sandbar's structural checks (#183, #235): the pure layer as tables, and every
// check proved able to go red by running `run.mjs` over a fixture branch built
// in a real repository.
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { addedLines, parseAddedLines } from "../scripts/structure/core.mjs";
import { parseVersion, versionFindings } from "../scripts/structure/version.mjs";
import { git, run, useFixtures } from "./structure.test-util.js";

const { tempDir, fixtureRepo } = useFixtures();

describe("parseAddedLines", () => {
  it.each([
    {
      name: "one hunk per file, counts and the omitted count of one",
      diff: [
        "--- a.ts",
        "+++ a.ts",
        "@@ -3 +3,2 @@",
        "-old",
        "+new",
        "+added",
        "@@ -10,0 +12 @@",
        "+inserted",
        "--- b.yml",
        "+++ b.yml",
        "@@ -1,2 +1,3 @@",
        "-x",
        "-y",
        "+x",
        "+y",
        "+z",
      ],
      expected: [["a.ts", [3, 4, 12]], ["b.yml", [1, 2, 3]]],
    },
    {
      name: "a deletion-only hunk and a deleted file add nothing",
      diff: [
        "--- a.ts",
        "+++ a.ts",
        "@@ -4,2 +3,0 @@",
        "-gone",
        "-gone",
        "--- gone.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-gone",
      ],
      expected: [],
    },
    {
      name: "a new file counts from line 1",
      diff: ["--- /dev/null", "+++ new.ts", "@@ -0,0 +1,2 @@", "+a", "+b"],
      expected: [["new.ts", [1, 2]]],
    },
    {
      name: "a body line that reads like a header is body, and a no-newline marker is not",
      diff: [
        "--- a.md",
        "+++ a.md",
        "@@ -1 +1,2 @@",
        "--- old",
        "\\ No newline at end of file",
        "+++ other",
        "+@@ -1 +9 @@",
        "\\ No newline at end of file",
      ],
      expected: [["a.md", [1, 2]]],
    },
  ])("$name", ({ diff, expected }) => {
    expect([...parseAddedLines(diff.join("\n"))]).toEqual(expected);
  });

  it("reads the lines a real branch adds since its merge base", async () => {
    const dir = await fixtureRepo("version-bumped");
    const lines = addedLines({ dir }, git(dir, "merge-base", "HEAD", "origin/main"));
    expect([...lines]).toEqual([
      ["index.mjs", [1]],
      ["package-lock.json", [3, 8]],
      ["package.json", [3]],
    ]);
  });
});

describe("version check", () => {
  it.each([
    ["1.2.3", [1, 2, 3]],
    ["10.0.12", [10, 0, 12]],
    ["v1.2.3", null],
    ["1.2", null],
    ["1.2.3-rc.1", null],
    [undefined, null],
  ])("parseVersion(%s)", (raw, expected) => {
    expect(parseVersion(raw)).toEqual(expected);
  });

  const lock = (version: string, root = version) =>
    ({ version, packages: { "": { version: root } } });

  it.each([
    { name: "a patch bump", base: "0.41.2", head: "0.41.3", lock: lock("0.41.3"), expected: [] },
    { name: "a minor bump over a higher patch", base: "0.41.9", head: "0.42.0", lock: lock("0.42.0"), expected: [] },
    { name: "a numeric, not textual, comparison", base: "0.9.0", head: "0.10.0", lock: lock("0.10.0"), expected: [] },
    {
      name: "no bump",
      base: "0.41.2", head: "0.41.2", lock: lock("0.41.2"),
      expected: ["package.json: version 0.41.2 is not above origin/main's 0.41.2"],
    },
    {
      name: "a version moved down",
      base: "0.41.2", head: "0.40.9", lock: lock("0.40.9"),
      expected: ["package.json: version 0.40.9 is not above origin/main's 0.41.2"],
    },
    {
      name: "both lock mirrors left behind",
      base: "0.41.2", head: "0.41.3", lock: lock("0.41.2"),
      expected: [
        "package-lock.json: version 0.41.2 is not package.json's 0.41.3",
        'package-lock.json: packages[""].version 0.41.2 is not package.json\'s 0.41.3',
      ],
    },
    {
      name: "a lock without its root package",
      base: "0.41.2", head: "0.41.3", lock: { version: "0.41.3" },
      expected: ['package-lock.json: packages[""].version undefined is not package.json\'s 0.41.3'],
    },
    {
      name: "an unparseable head version",
      base: "0.41.2", head: "next", lock: lock("next"),
      expected: ["package.json: version next is not X.Y.Z"],
    },
    {
      name: "an unparseable base version",
      base: "0.41", head: "0.41.3", lock: lock("0.41.3"),
      expected: ["package.json: origin/main's version 0.41 is not X.Y.Z"],
    },
  ])("$name", ({ base, head, lock: headLock, expected }) => {
    expect(versionFindings("origin/main", { version: base }, { version: head }, headLock))
      .toEqual(expected);
  });

  // The proofs that the check can go red (#183 §3), each beside its green twin.
  it.each([
    {
      fixture: "version-bumped",
      status: 0,
      lines: ["version: 1.2.4 is above origin/main's 1.2.3, and package-lock.json agrees"],
    },
    {
      fixture: "version-unbumped",
      status: 1,
      lines: ["package.json: version 1.2.3 is not above origin/main's 1.2.3"],
    },
    {
      fixture: "version-lock-mismatch",
      status: 1,
      lines: ['package-lock.json: packages[""].version 1.2.3 is not package.json\'s 1.3.0'],
    },
  ])("run.mjs over $fixture exits $status", async ({ fixture, status, lines }) => {
    const dir = await fixtureRepo(fixture);
    expect(run(dir, "version", "--base", "origin/main")).toEqual({ status, lines, stderr: "" });
  });

  it("measures from the merge base, not from where the base has moved since", async () => {
    const dir = await fixtureRepo("version-bumped");
    git(dir, "checkout", "-q", "main");
    git(dir, "commit", "-q", "--allow-empty", "-m", "main moves");
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    // The landing shape: origin/main merged with the branch, on top of it.
    git(dir, "merge", "-q", "--no-ff", "-m", "land", "topic");
    expect(run(dir, "version", "--base", "origin/main").status).toBe(0);
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    expect(run(dir, "version", "--base", "origin/main")).toMatchObject({
      status: 1,
      lines: ["package.json: version 1.2.4 is not above origin/main's 1.2.4"],
    });
  });

  // Sandbar's gate reads the clone's `.git` from a read-only mount elsewhere.
  it("reads the repository through --git-dir from a directory that is none", async () => {
    const dir = await fixtureRepo("version-unbumped");
    const elsewhere = await tempDir();
    expect(run(elsewhere, "version", "--git-dir", join(dir, ".git"))).toMatchObject({
      status: 1,
      lines: ["package.json: version 1.2.3 is not above origin/main's 1.2.3"],
    });
  });

  // git's own words vary by version, so only the line's shape is pinned.
  it.each([
    {
      name: "a base that does not resolve",
      args: ["version", "--base", "origin/nope"],
      line: /^version: git merge-base HEAD origin\/nope: fatal: .*origin\/nope/,
    },
    {
      name: "a package.json that is not JSON",
      args: ["version"],
      broken: true,
      line: /^version: package\.json at HEAD is not JSON: /,
    },
    {
      name: "an unknown option",
      args: ["version", "--bogus"],
      line: /--bogus.*; usage: run\.mjs \[version\|tests\]… \[--base <ref>\] \[--git-dir <dir>\]$/,
    },
    {
      name: "an option missing its value",
      args: ["--base"],
      line: /--base.*; usage: run\.mjs \[version\|tests\]…/,
    },
    {
      name: "an unknown check",
      args: ["nope"],
      line: /^unknown check 'nope'; usage: run\.mjs \[version\|tests\]… \[--base <ref>\] \[--git-dir <dir>\]$/,
    },
  ])("$name is a one-line exit 2", async ({ args, broken, line }) => {
    const dir = await fixtureRepo("version-bumped");
    if (broken === true) {
      await cp(join(dir, "index.mjs"), join(dir, "package.json"));
      git(dir, "commit", "-q", "-am", "broken");
    }
    const result = run(dir, ...args);
    expect(result).toMatchObject({ status: 2, stderr: "" });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatch(line);
  });
});
