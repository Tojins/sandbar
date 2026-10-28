// Runs the built entry as `npm run stats` does: `npm test` builds dist/ first.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const STATS_CLI = fileURLToPath(new URL("../dist/stats-cli.js", import.meta.url));
const FIXTURE_LOGS = fileURLToPath(new URL("./__fixtures__/stats/logs", import.meta.url));

const stats = async (
  args: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [STATS_CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failed = err as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
};

const temporaryDirectories = new Set<string>();
afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((path) => rm(path, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("npm run stats (#194)", () => {
  it.each([
    ["an unknown flag", ["--verbose"]],
    ["both windows", ["--last", "3", "--since", "2026-09-01"]],
    ["a count that is not one", ["--last", "0"]],
    ["a date that is not one", ["--since", "yesterday"]],
  ])("exits 2 on %s", async (_name, args) => {
    const result = await stats(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: stats-cli.js");
    expect(result.stdout).toBe("");
  });

  it("prints the zero-run report for a logs directory that does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbar-stats-cli-"));
    temporaryDirectories.add(dir);
    const result = await stats(["--logs", join(dir, "logs"), "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      statsSchema: 1, window: { last: 10 }, runs: [], skipped: [], issues: [],
    });
  });

  it("prints the window's tables, or its report as JSON", async () => {
    const tables = await stats(["--logs", FIXTURE_LOGS, "--since", "2026-09-02"]);
    expect(tables.code).toBe(0);
    expect(tables.stdout).toContain("# Sandbar scorecard: runs since 2026-09-02");
    const json = await stats(["--logs", FIXTURE_LOGS, "--last", "1", "--json"]);
    expect(JSON.parse(json.stdout).runs).toEqual([
      { run: "run-2026-09-02T08-30-00-000Z", schemaVersion: 5, driver: "sandbar 0.49.13" },
    ]);
  });

  it("reads the speech section only with --with-prose", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbar-stats-cli-"));
    temporaryDirectories.add(dir);
    const run = join(dir, "run-2026-09-05T00-00-00-000Z");
    await mkdir(join(run, "issue-7"), { recursive: true });
    const row = (fields: object) => JSON.stringify({ ts: "2026-09-05T00:00:00Z", ...fields });
    await writeFile(join(run, "events.jsonl"), [
      row({ kind: "run-start", schemaVersion: 6, driver: "sandbar test", configPath: null,
        workdir: "/w", maxParallelIssues: 1, pid: 1, seq: 1 }),
      row({ kind: "ui-check", seq: 2, issue: 7, invocation: 1, provider: "claude", model: "m",
        effort: null, durationMs: 1, result: "CLEAR", transcript: "ui-check-1.log" }),
    ].join("\n") + "\n");
    await writeFile(
      join(run, "issue-7", "ui-check-1.log"),
      "header\n\n--- speech ---\n<ui-check>CLEAR</ui-check>\n--- stdout tail ---\n",
    );
    const withProse = await stats(["--logs", dir, "--json", "--with-prose"]);
    expect(JSON.parse(withProse.stdout).invocations[0].prose).toBe("<ui-check>CLEAR</ui-check>");
    const bare = await stats(["--logs", dir, "--json"]);
    expect(JSON.parse(bare.stdout).invocations[0]).not.toHaveProperty("prose");
  });
});
