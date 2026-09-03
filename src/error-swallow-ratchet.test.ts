import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ERROR_SWALLOW_BASELINE } from "./error-swallow-baseline.test-util.js";

const SRC = dirname(fileURLToPath(import.meta.url));
const SWALLOW_PATTERNS = [
  /\.catch\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  /\.catch\(\s*[A-Za-z_$][\w$.]*\s*\)/g,
  /catch\s*\([^)]*\)\s*\{(?![^{}]*\bthrow\b)/g,
  /catch\s*\{/g,
];

export function countSwallowPatterns(source: string): number {
  return SWALLOW_PATTERNS.reduce(
    (count, pattern) => count + [...source.matchAll(pattern)].length,
    0,
  );
}

export function swallowPatternGrowth(
  counts: Readonly<Record<string, number>>,
  baseline: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).filter(
      ([file, count]) => count > (baseline[file] ?? 0),
    ),
  );
}

describe("production error-swallow ratchet", () => {
  it("counts swallow forms while excluding an explicit rethrow", () => {
    expect(
      countSwallowPatterns(
        "task.catch(() => fallback); task.catch((err) => fallback(err)); " +
          "task.catch(err => null); task.catch(async (err) => null); " +
          "task.catch(swallowIt); try {} catch { fallback(); } " +
          "try {} catch (err) { return null; } " +
          "try {} catch (err) { throw err; }",
      ),
    ).toBe(7);
  });

  it("reports files whose count exceeds their baseline", () => {
    expect(
      swallowPatternGrowth(
        { "grown.ts": 2, "same.ts": 1, "new.ts": 1 },
        { "grown.ts": 1, "same.ts": 1 },
      ),
    ).toEqual({ "grown.ts": 2, "new.ts": 1 });
  });

  it("does not let any production file grow its swallow-pattern count", async () => {
    const files = (await readdir(SRC))
      .filter(
        (file) =>
          file.endsWith(".ts") &&
          !file.endsWith(".test.ts") &&
          !file.endsWith(".test-util.ts"),
      )
      .sort();

    const counts = Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          countSwallowPatterns(await readFile(join(SRC, file), "utf8")),
        ]),
      ),
    );
    const growth = swallowPatternGrowth(counts, ERROR_SWALLOW_BASELINE);

    expect(growth).toEqual({});
  });
});
