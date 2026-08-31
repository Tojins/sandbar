import { describe, expect, it } from "vitest";

import {
  analyzeVersionConflict,
  bumpAboveAll,
  differingPaths,
  isVersionConflictFile,
  parseConflictSegments,
  planVersionCollision,
  renderVersionResolution,
} from "./version-conflict.js";

const PKG = (hunk: string): string =>
  [
    "{",
    '  "name": "@offergeist/sandbar",',
    hunk,
    '  "type": "module",',
    '  "scripts": {',
    '    "build": "tsc"',
    "  }",
    "}",
    "",
  ].join("\n");

const conflict = (ours: string, theirs: string, branch = "sandbar/issue-9"): string =>
  [`<<<<<<< HEAD`, ours, "=======", theirs, `>>>>>>> ${branch}`].join("\n");

const VERSION_HUNK = conflict('  "version": "0.20.34",', '  "version": "0.20.35",');

// The lockfile npm actually writes: the root package's version appears twice,
// and every dependency carries a `"version"` line at the SAME indentation as
// the second of them.
const LOCK = (rootHunk: string, depHunk: string): string =>
  [
    "{",
    '  "name": "@offergeist/sandbar",',
    rootHunk,
    '  "lockfileVersion": 3,',
    '  "requires": true,',
    '  "packages": {',
    '    "": {',
    '      "name": "@offergeist/sandbar",',
    rootHunk.replace(/^ {2}"/gm, '      "').replace(/^ {2}(?=[<=>])/gm, ""),
    '      "dependencies": {',
    '        "proper-lockfile": "^4.1.2"',
    "      }",
    "    },",
    '    "node_modules/proper-lockfile": {',
    depHunk,
    '      "license": "MIT"',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");

const DEP_CLEAN = '      "version": "4.1.2",';

describe("parseConflictSegments", () => {
  it("splits a file into what git merged and what it did not", () => {
    const segs = parseConflictSegments(PKG(VERSION_HUNK));
    expect(segs).not.toBeNull();
    const kinds = (segs ?? []).map((s) => s.kind);
    expect(kinds).toEqual(["text", "conflict", "text"]);
    const hunk = (segs ?? [])[1];
    expect(hunk).toEqual({
      kind: "conflict",
      ours: ['  "version": "0.20.34",'],
      theirs: ['  "version": "0.20.35",'],
    });
  });

  it("drops the base section of a diff3-style hunk", () => {
    const text = [
      "a",
      "<<<<<<< HEAD",
      "ours",
      "||||||| base",
      "original",
      "=======",
      "theirs",
      ">>>>>>> other",
      "b",
    ].join("\n");
    expect(parseConflictSegments(text)).toEqual([
      { kind: "text", lines: ["a"] },
      { kind: "conflict", ours: ["ours"], theirs: ["theirs"] },
      { kind: "text", lines: ["b"] },
    ]);
  });

  it.each([
    ["an unterminated hunk", "<<<<<<< HEAD\nours\n=======\ntheirs\n"],
    ["a separator with no hunk open", "a\n=======\nb\n"],
    ["a nested hunk", "<<<<<<< HEAD\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n=======\nc\n>>>>>>> y"],
    ["an end marker with no hunk open", "a\n>>>>>>> x\n"],
  ])("declines to parse %s", (_name, text) => {
    expect(parseConflictSegments(text)).toBeNull();
  });
});

describe("bumpAboveAll", () => {
  it("takes the max of both sides and bumps it once, so it is above both", () => {
    expect(bumpAboveAll(["0.20.34", "0.20.35"])).toBe("0.20.36");
    expect(bumpAboveAll(["0.20.35", "0.20.34"])).toBe("0.20.36");
  });

  it("orders numerically, not lexically", () => {
    expect(bumpAboveAll(["0.9.0", "0.10.0"])).toBe("0.10.1");
    expect(bumpAboveAll(["1.0.0", "0.999.999"])).toBe("1.0.1");
  });

  it("takes a minor bump over a patch bump", () => {
    expect(bumpAboveAll(["0.21.0", "0.20.34"])).toBe("0.21.1");
  });

  it("refuses anything that is not plain major.minor.patch", () => {
    expect(bumpAboveAll(["1.0.0-rc.1", "1.0.0"])).toBeNull();
    expect(bumpAboveAll(["1.0", "1.0.1"])).toBeNull();
    expect(bumpAboveAll([])).toBeNull();
  });
});

describe("differingPaths", () => {
  it("names the deepest common path at which two documents disagree", () => {
    expect(
      differingPaths({ a: { b: 1, c: 2 } }, { a: { b: 9, c: 2 } }),
    ).toEqual([["a", "b"]]);
  });

  it("reports a key present on one side only", () => {
    expect(differingPaths({ a: 1 }, { a: 1, b: 2 })).toEqual([["b"]]);
  });

  it("says nothing about identical documents", () => {
    expect(differingPaths({ a: [1, 2], b: null }, { a: [1, 2], b: null })).toEqual([]);
  });
});

describe("analyzeVersionConflict — package.json", () => {
  it("resolves a conflict confined to the version field", () => {
    const a = analyzeVersionConflict("package.json", PKG(VERSION_HUNK));
    expect(a.kind).toBe("resolvable");
    if (a.kind !== "resolvable") return;
    expect(a.plan.versions).toEqual(["0.20.34", "0.20.35"]);
    // The rewrite reproduces the file byte for byte apart from the version.
    expect(renderVersionResolution(a.plan, "0.20.36")).toBe(
      PKG('  "version": "0.20.36",'),
    );
  });

  it("declines when the conflict also touches a script", () => {
    const text = [
      "{",
      '  "name": "@offergeist/sandbar",',
      VERSION_HUNK,
      '  "scripts": {',
      conflict('    "build": "tsc -p ."', '    "build": "tsc --build"'),
      "  }",
      "}",
      "",
    ].join("\n");
    const a = analyzeVersionConflict("package.json", text);
    expect(a).toEqual({
      kind: "declined",
      reason: "a conflict hunk is not a lone `version` line",
    });
  });

  it("declines when a whole dependency block conflicts around the version", () => {
    const text = [
      "{",
      '  "name": "@offergeist/sandbar",',
      conflict(
        ['  "version": "0.20.34",', '  "dependencies": {', '    "left-pad": "^1.0.0"', "  }"].join("\n"),
        ['  "version": "0.20.35",', '  "dependencies": {', '    "right-pad": "^2.0.0"', "  }"].join("\n"),
      ),
      "}",
      "",
    ].join("\n");
    expect(analyzeVersionConflict("package.json", text)).toEqual({
      kind: "declined",
      reason: "a conflict hunk is not a lone `version` line",
    });
  });

  it("declines a hunk that offers the same version on both sides", () => {
    const text = PKG(conflict('  "version": "0.20.34",', '  "version": "0.20.34",'));
    expect(analyzeVersionConflict("package.json", text)).toEqual({
      kind: "declined",
      reason: "a hunk offers the same version on both sides",
    });
  });

  it("declines a file with no conflict in it at all", () => {
    expect(analyzeVersionConflict("package.json", PKG('  "version": "0.20.34",'))).toEqual({
      kind: "declined",
      reason: "no conflict hunks found in the file",
    });
  });

  it("declines a path it does not own", () => {
    expect(analyzeVersionConflict("src/version.ts", PKG(VERSION_HUNK))).toEqual({
      kind: "declined",
      reason: "not a version-bearing file",
    });
  });

  it("declines when a side is not valid JSON on its own", () => {
    const text = ["{", '  "name": "x"', VERSION_HUNK, "}", ""].join("\n");
    expect(analyzeVersionConflict("package.json", text)).toEqual({
      kind: "declined",
      reason: "a side of the conflict is not valid JSON on its own",
    });
  });

  it("declines markers it cannot parse", () => {
    const text = ["{", "<<<<<<< HEAD", '  "version": "1.0.0"', "}", ""].join("\n");
    expect(analyzeVersionConflict("package.json", text)).toEqual({
      kind: "declined",
      reason: "conflict markers could not be parsed",
    });
  });
});

describe("analyzeVersionConflict — package-lock.json", () => {
  it("resolves both of npm's mirrors of the root version", () => {
    const a = analyzeVersionConflict(
      "package-lock.json",
      LOCK(VERSION_HUNK, DEP_CLEAN),
    );
    expect(a.kind).toBe("resolvable");
    if (a.kind !== "resolvable") return;
    expect(a.plan.versions).toEqual(["0.20.34", "0.20.35", "0.20.34", "0.20.35"]);
    const out = renderVersionResolution(a.plan, "0.20.36");
    expect(out).toBe(LOCK('  "version": "0.20.36",', DEP_CLEAN));
    // Both mirrors moved, and the dependency's own version did not.
    expect(out.match(/"version": "0\.20\.36"/g)).toHaveLength(2);
    expect(out).toContain('"version": "4.1.2"');
  });

  it("declines when a DEPENDENCY's version is what conflicted", () => {
    // The hunk looks exactly like the root package's — same shape, same
    // indentation — and only the JSON path tells them apart.
    const depHunk = conflict('      "version": "4.1.2",', '      "version": "4.1.3",');
    const a = analyzeVersionConflict(
      "package-lock.json",
      LOCK(VERSION_HUNK, depHunk),
    );
    expect(a).toEqual({
      kind: "declined",
      reason:
        "the conflict also touches packages.node_modules/proper-lockfile.version",
    });
  });

  it("declines when the package graph itself conflicts", () => {
    const text = [
      "{",
      '  "name": "@offergeist/sandbar",',
      VERSION_HUNK,
      '  "packages": {',
      '    "": {',
      conflict(
        '      "version": "0.20.34"',
        ['      "version": "0.20.35",', '      "dependencies": {}'].join("\n"),
      ),
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(analyzeVersionConflict("package-lock.json", text)).toEqual({
      kind: "declined",
      reason: "a conflict hunk is not a lone `version` line",
    });
  });
});

describe("planVersionCollision", () => {
  const pkg = { path: "package.json", text: PKG(VERSION_HUNK) };
  const lock = { path: "package-lock.json", text: LOCK(VERSION_HUNK, DEP_CLEAN) };

  it("takes ONE max across every qualifying file", () => {
    // The two files disagree about what the sides were: a single max is what
    // keeps them from leaving the merge on different versions.
    const skewedLock = {
      path: "package-lock.json",
      text: LOCK(
        conflict('  "version": "0.20.34",', '  "version": "0.21.0",'),
        DEP_CLEAN,
      ),
    };
    const plan = planVersionCollision([pkg, skewedLock]);
    expect(plan?.version).toBe("0.21.1");
    expect(plan?.resolved.map((r) => r.path)).toEqual([
      "package.json",
      "package-lock.json",
    ]);
    expect(plan?.declined).toEqual([]);
  });

  it("resolves one file and leaves the other to the agent", () => {
    const depHunk = conflict('      "version": "4.1.2",', '      "version": "4.1.3",');
    const plan = planVersionCollision([
      pkg,
      { path: "package-lock.json", text: LOCK(VERSION_HUNK, depHunk) },
    ]);
    expect(plan?.version).toBe("0.20.36");
    expect(plan?.resolved.map((r) => r.path)).toEqual(["package.json"]);
    expect(plan?.declined).toEqual([
      {
        path: "package-lock.json",
        reason:
          "the conflict also touches packages.node_modules/proper-lockfile.version",
      },
    ]);
  });

  it("ignores paths it does not own entirely, rather than declining them", () => {
    expect(
      planVersionCollision([
        { path: "src/merger.ts", text: "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x" },
      ]),
    ).toBeNull();
  });

  it("declines a file it could not read", () => {
    const plan = planVersionCollision([{ path: "package.json", text: null }]);
    expect(plan).toEqual({
      version: null,
      resolved: [],
      declined: [{ path: "package.json", reason: "the file could not be read" }],
    });
  });

  it("declines a prerelease rather than inventing an ordering for it", () => {
    // Rejected by the hunk check, since a release decision is not a collision.
    const plan = planVersionCollision([
      {
        path: "package.json",
        text: PKG(conflict('  "version": "1.0.0-rc.1",', '  "version": "1.0.1",')),
      },
    ]);
    expect(plan?.version).toBeNull();
    expect(plan?.resolved).toEqual([]);
    expect(plan?.declined).toEqual([
      {
        path: "package.json",
        reason: "a conflict hunk is not a lone `version` line",
      },
    ]);
  });
});

describe("isVersionConflictFile", () => {
  it("owns the two root files and nothing else", () => {
    expect(isVersionConflictFile("package.json")).toBe(true);
    expect(isVersionConflictFile("package-lock.json")).toBe(true);
    // A workspace member's lockfile mirrors are not the two this module knows.
    expect(isVersionConflictFile("packages/web/package.json")).toBe(false);
    expect(isVersionConflictFile("src/version.ts")).toBe(false);
  });
});
