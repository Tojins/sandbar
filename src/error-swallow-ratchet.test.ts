import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ERROR_SWALLOW_BASELINE } from "./error-swallow-baseline.js";

const SRC = dirname(fileURLToPath(import.meta.url));
const SWALLOW_PATTERNS = [/\.catch\(\(\) =>/g, /catch \{/g];

function countSwallowPatterns(source: string): number {
  return SWALLOW_PATTERNS.reduce(
    (count, pattern) => count + [...source.matchAll(pattern)].length,
    0,
  );
}

describe("production error-swallow ratchet", () => {
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
    const growth = Object.fromEntries(
      Object.entries(counts).filter(
        ([file, count]) => count > (ERROR_SWALLOW_BASELINE[file] ?? 0),
      ),
    );

    expect(growth).toEqual({});
  });
});
