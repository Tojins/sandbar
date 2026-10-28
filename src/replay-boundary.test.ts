// #195 — replay is human-only by construction: no module outside replay's own
// imports it, and no prompt names it, so neither the daemon nor any agent role
// (reflect's included) can reach it or be told to run it.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const PROMPTS = join(SRC, "..", "prompts");

describe("replay's boundary (#195)", () => {
  it("is imported by no production module outside replay*.ts", async () => {
    const importers = [];
    for (const file of await readdir(SRC)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.endsWith(".test-util.ts")) continue;
      if (file.startsWith("replay")) continue;
      if (/from\s+["']\.\/replay[^"']*["']|import\(\s*["']\.\/replay/.test(await readFile(join(SRC, file), "utf8"))) {
        importers.push(file);
      }
    }
    expect(importers).toEqual([]);
  });

  it("is named by no prompt", async () => {
    const naming = [];
    for (const file of await readdir(PROMPTS)) {
      if (!file.endsWith(".md")) continue;
      const text = await readFile(join(PROMPTS, file), "utf8");
      if (text.includes("npm run replay") || text.includes("replay-cli")) naming.push(file);
    }
    expect(naming).toEqual([]);
  });
});
