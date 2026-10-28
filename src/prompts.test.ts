import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readPromptFiles } from "./prompts.js";

describe("readPromptFiles", () => {
  it("returns every .md template, sorted, with its exact text", () => {
    const dir = fileURLToPath(new URL("../prompts/", import.meta.url));
    const names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
    const files = readPromptFiles();
    expect([...files.keys()]).toEqual(names);
    expect(names).toContain("reflect-tagger.md");
    expect(names).toContain("coding-standards.md");
    expect(files.get("reflect-tagger.md")).toBe(readFileSync(`${dir}reflect-tagger.md`, "utf8"));
  });
});
