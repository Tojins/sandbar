// Runs the built entry as `npm run reflect` does (reflect-cli.test-util.ts);
// the fixture window's report is reflect-cli-report.test.ts's.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FIXTURE_LOGS, reflect, useConsumers } from "./reflect-cli.test-util.js";

const consumer = useConsumers();

describe("npm run reflect (#182, #207, #208)", () => {
  it.each([
    ["an unknown flag", ["--no-agents", "--verbose"]],
    ["both windows", ["--no-agents", "--last", "3", "--since", "2026-09-01"]],
    ["a count that is not one", ["--no-agents", "--last", "0"]],
  ])("exits 2 on %s", async (_name, args) => {
    const result = await reflect(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: reflect-cli.js");
    expect(result.stdout).toBe("");
  });

  it("reads <stateDir>/logs by default and cites each member's log", async () => {
    const { dir, config } = await consumer();
    const logs = join(dir, ".sandbar", "logs");
    const run = join(logs, "run-2026-09-05T00-00-00-000Z");
    await mkdir(run, { recursive: true });
    const row = (fields: object) => JSON.stringify({ ts: "2026-09-05T00:00:00Z", ...fields });
    const failed = (issue: number, seq: number) => row({
      kind: "implementer", seq, issue, title: "t", attempt: 1, signal: "FAILED", provider: "claude",
      model: "m", effort: null, durationMs: 1, transcript: "implementer-1.log",
    });
    await writeFile(join(run, "events.jsonl"), [
      row({ kind: "run-start", schemaVersion: 6, driver: "sandbar test", configPath: null,
        workdir: "/w", maxParallelIssues: 1, pid: 1, seq: 1 }),
      failed(7, 2),
      failed(8, 3),
    ].join("\n") + "\n");
    const result = await reflect(["--no-agents", "--config", config]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("| `fail:implementer:FAILED` | 2 | 2 |");
    expect(result.stdout).toContain(`- acme/floorplan#7 attempt 1: \`${join(run, "issue-7")}/implementer-1.log\``);
    expect(result.stdout).toContain(`- acme/floorplan#8 attempt 1: \`${join(run, "issue-8")}/implementer-1.log\``);
  });

  it("exits 1 and writes no report when the agents cannot read the source tip", async () => {
    const { dir, config } = await consumer();
    const result = await reflect(["--config", config, "--logs", FIXTURE_LOGS]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("refs/remotes/origin/main");
    await expect(readdir(join(dir, ".sandbar", "reflect"))).rejects.toThrow("ENOENT");
  });
});
