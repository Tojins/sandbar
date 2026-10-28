// #195 — `npm run replay`'s command line: every refusal the CLI answers with
// exit 2, and the defaults a good line gets.
import { describe, expect, it } from "vitest";

import { parseReplayArgs } from "./replay-args.js";

const CONFIG = "./sandbar.config.mjs";

describe("parseReplayArgs (#195)", () => {
  it("parses freeze, defaulting the config", () => {
    expect(parseReplayArgs(["freeze", "--issues", "317,412", "--logs", "l", "--out", "o.json"]))
      .toEqual({ verb: "freeze", config: CONFIG, issues: [317, 412], logs: "l", out: "o.json" });
  });

  it("parses run, defaulting repeat and parallel to 1", () => {
    expect(parseReplayArgs(["run", "--cases", "c.json", "--label", "base.1_a-b"])).toEqual({
      verb: "run", config: CONFIG, cases: "c.json", label: "base.1_a-b", repeat: 1, parallel: 1,
    });
    expect(parseReplayArgs(["run", "--cases", "c", "--label", "x", "--repeat", "3", "--parallel", "2", "--config", "k.mjs"]))
      .toEqual({ verb: "run", config: "k.mjs", cases: "c", label: "x", repeat: 3, parallel: 2 });
  });

  it.each<[string, string[], string]>([
    ["no verb", [], "unknown verb (none)"],
    ["an unknown verb", ["all"], "unknown verb all"],
    ["freeze without --issues", ["freeze", "--logs", "l", "--out", "o"], "freeze needs --issues, --logs and --out"],
    ["freeze without --logs", ["freeze", "--issues", "1", "--out", "o"], "freeze needs --issues, --logs and --out"],
    ["freeze without --out", ["freeze", "--issues", "1", "--logs", "l"], "freeze needs --issues, --logs and --out"],
    ["a non-distinct --issues", ["freeze", "--issues", "1,2,1", "--logs", "l", "--out", "o"], "--issues wants distinct issue numbers, comma-separated"],
    ["a non-numeric --issues", ["freeze", "--issues", "1,x", "--logs", "l", "--out", "o"], "--issues wants distinct issue numbers, comma-separated"],
    ["a zero issue", ["freeze", "--issues", "0", "--logs", "l", "--out", "o"], "--issues wants distinct issue numbers, comma-separated"],
    ["an empty --issues entry", ["freeze", "--issues", "1,,2", "--logs", "l", "--out", "o"], "--issues wants distinct issue numbers, comma-separated"],
    ["run without --cases", ["run", "--label", "x"], "run needs --cases and --label"],
    ["run without --label", ["run", "--cases", "c"], "run needs --cases and --label"],
    ["a label with a slash", ["run", "--cases", "c", "--label", "a/b"], "--label wants a name of letters, digits, '.', '_' and '-'"],
    ["a label led by a dot", ["run", "--cases", "c", "--label", ".x"], "--label wants a name of letters, digits, '.', '_' and '-'"],
    ["--repeat 0", ["run", "--cases", "c", "--label", "x", "--repeat", "0"], "--repeat and --parallel want positive counts"],
    ["--repeat 1.5", ["run", "--cases", "c", "--label", "x", "--repeat", "1.5"], "--repeat and --parallel want positive counts"],
    ["--parallel -1", ["run", "--cases", "c", "--label", "x", "--parallel=-1"], "--repeat and --parallel want positive counts"],
  ])("refuses %s", (_, argv, error) => {
    expect(parseReplayArgs(argv)).toEqual({ error });
  });

  it.each([
    ["an unknown flag", ["run", "--cases", "c", "--label", "x", "--all"]],
    ["a flag of the other verb", ["freeze", "--issues", "1", "--logs", "l", "--out", "o", "--label", "x"]],
    ["a positional", ["run", "--cases", "c", "--label", "x", "extra"]],
  ])("refuses %s with parseArgs' own message", (_, argv) => {
    expect(parseReplayArgs(argv)).toEqual({ error: expect.any(String) });
  });
});
