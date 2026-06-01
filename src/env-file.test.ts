// Unit tests for the shared dotenv parser consumed by both the preflight
// reader (env.ts) and the sandbox env resolver (agent-sandbox.ts).

import { describe, expect, it } from "vitest";
import { parseEnvFile } from "./env-file.js";

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
