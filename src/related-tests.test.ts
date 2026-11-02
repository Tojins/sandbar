// scripts/related-tests.mjs, sandbar's `related` pass (#269), run over this
// repository: it prints the tests a file's importers reach and nothing else.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("related-tests.mjs", () => {
  // `package.json` beside it would select every test under vitest's default
  // rerun triggers.
  it("prints the test files that import a changed file, one repository path a line", { timeout: 60_000 }, () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/related-tests.mjs", "scripts/structure/coverage.mjs", "package.json"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(result).toMatchObject({ status: 0, stdout: "src/structure-missing-tests.test.ts\n" });
  });
});
