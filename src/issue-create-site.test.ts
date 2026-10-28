// #198 — the deploy watch is the only place sandbar ever creates an issue. A
// convention alone would not survive the next feature that finds `gh issue
// create` convenient, so the production sources are scanned for its argv.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

describe("the single `gh issue create` site", () => {
  it("is deploy-watch.ts", async () => {
    const files = (await readdir(SRC)).filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        !file.endsWith(".test-util.ts"),
    );
    const sites = [];
    for (const file of files) {
      if (/"issue",\s*"create"/.test(await readFile(join(SRC, file), "utf8"))) sites.push(file);
    }
    expect(sites).toEqual(["deploy-watch.ts"]);
  });
});
