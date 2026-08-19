// Unit tests for the dotenv parser, and for the `readEnvFile` wrapper a host
// calls from its own config file (#38).
//
// The parser stopped being contract when `envFilePath` became `env`; the
// wrapper is what a consumer now writes in `sandbar.config.mjs`, which makes
// its FAILURE mode the interesting part — see the last case.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEnvFile, readEnvFile } from "./env-file.js";

describe("parseEnvFile", () => {
  it("parses plain KEY=value pairs", () => {
    expect(parseEnvFile("A=1\nB=two")).toEqual({ A: "1", B: "two" });
  });

  it("ignores blank lines and # comments", () => {
    expect(parseEnvFile("\n# a comment\nA=1\n   \n#B=2\n")).toEqual({ A: "1" });
  });

  it("trims whitespace around key and value", () => {
    expect(parseEnvFile("  A  =  hello  ")).toEqual({ A: "hello" });
  });

  it("strips single and double quotes", () => {
    expect(parseEnvFile(`A="quoted"\nB='single'`)).toEqual({ A: "quoted", B: "single" });
  });

  it("unescapes \\n \\r \\t \\\\ inside double quotes only", () => {
    expect(parseEnvFile('A="line1\\nline2\\t!"')).toEqual({ A: "line1\nline2\t!" });
    // single-quoted values are literal — no unescaping
    expect(parseEnvFile("A='line1\\nline2'")).toEqual({ A: "line1\\nline2" });
  });

  it("keeps '=' that appear in the value (splits on first only)", () => {
    expect(parseEnvFile("URL=https://x?a=1&b=2")).toEqual({ URL: "https://x?a=1&b=2" });
  });

  it("drops lines with no '=' and empty keys", () => {
    expect(parseEnvFile("NOEQ\n=novalue\nA=1")).toEqual({ A: "1" });
  });

  it("preserves an explicitly empty value", () => {
    expect(parseEnvFile("A=")).toEqual({ A: "" });
  });
});

describe("readEnvFile", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("reads a file into the record `config.env` takes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbar-envfile-"));
    dirs.push(dir);
    const path = join(dir, "sandbar.env");
    await writeFile(path, "GH_TOKEN=ghp_x\nCLAUDE_CODE_OAUTH_TOKEN=\n");

    expect(readEnvFile(path)).toEqual({
      GH_TOKEN: "ghp_x",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    });
    expect(readEnvFile(new URL(`file://${path}`))).toEqual(readEnvFile(path));
  });

  // The whole reason it throws rather than returning {}. An empty record is a
  // legitimate configuration, so a silent fallback turns a typo'd path into
  // "GH_TOKEN is missing" and sends the operator to look at their token
  // instead of at the line naming the file.
  it("throws on an unreadable file rather than returning an empty record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbar-envfile-"));
    dirs.push(dir);

    expect(() => readEnvFile(join(dir, "does-not-exist.env"))).toThrow(
      /readEnvFile/,
    );
  });
});
