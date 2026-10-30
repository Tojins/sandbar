// A lint rule the repo has no linter for: tests time with `performance.now()`.
//
// `Date.now()` is the wall clock, and a host can step it backwards (WSL's
// resync, an NTP step on the box): an elapsed time measured with it came out
// at -403ms under load, and a lower-bound assertion on it reds a correct
// run. A test that does need the wall clock — a value production compares
// against its own `Date.now()`, or fake timers' system time — says so on the
// same line with a `// wall clock: <why>` comment.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = new URL("./", import.meta.url);
// Spelled apart, so this file's own fixtures do not trip the rule.
const NOW = ["Date", "now"].join(".");
const WALL_CLOCK = /\bDate\.now\b/;
const REASON = /\/\/ wall clock: \S/;

// Each `Date.now` outside a comment on a line with no reason, as `file:line`.
function unmarkedWallClock(file: string, text: string): string[] {
  return text.split("\n").flatMap((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    return WALL_CLOCK.test(code) && !REASON.test(line) ? [`${file}:${i + 1}`] : [];
  });
}

describe("tests time with performance.now()", () => {
  it("flags the wall clock in code, not in a comment or beside a reason", () => {
    expect(unmarkedWallClock("a.test.ts", [
      `const started = ${NOW}();`,
      `// leave the deadline on ${NOW}().`,
      `const at = ${NOW}() + 1; // wall clock: production reads it`,
      `const at = ${NOW}() + 1; // wall clock:`,
      "const t = performance.now();",
    ].join("\n"))).toEqual(["a.test.ts:1", "a.test.ts:4"]);
  });

  it("holds for every test file", () => {
    const files = readdirSync(SRC).filter((name) => /\.test(?:-util)?\.ts$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((name) => unmarkedWallClock(name, readFileSync(new URL(name, SRC), "utf8"))))
      .toEqual([]);
  });
});
