// Runs the built entry as `npm run reflect` does: `npm test` builds dist/ first.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const REFLECT_CLI = fileURLToPath(new URL("../dist/reflect-cli.js", import.meta.url));
const FIXTURE_LOGS = fileURLToPath(new URL("./__fixtures__/stats/logs", import.meta.url));

const reflect = async (
  args: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [REFLECT_CLI, ...args]);
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

// A consumer directory holding only a config: its state directory is
// `<dir>/.sandbar`.
async function consumer(): Promise<{ readonly dir: string; readonly config: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sandbar-reflect-cli-"));
  temporaryDirectories.add(dir);
  const config = join(dir, "sandbar.config.mjs");
  await writeFile(config, `export default {
  ghOwner: "acme",
  ghRepo: "floorplan",
  developers: "anyone",
  sandboxImage: "localhost/sandbox",
  gateStack: {
    containers: [{ name: "runner", image: "localhost/sandbox", mountWorktree: "/w", hold: true }],
    steps: [{ name: "test", in: "runner", command: ["npm", "test"] }],
  },
};\n`);
  return { dir, config };
}

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

  it("writes the fixture window's tables under the state directory and prints them, then the path", async () => {
    const { dir, config } = await consumer();
    const args = ["--no-agents", "--config", config, "--logs", FIXTURE_LOGS];
    const result = await reflect(args);
    expect(result.code).toBe(0);
    const reports = await readdir(join(dir, ".sandbar", "reflect"));
    expect(reports).toEqual([expect.stringMatching(/^report-run-2026-09-02T08-30-00-000Z-n2-[0-9a-f]{8}\.md$/)]);
    const path = join(dir, ".sandbar", "reflect", reports[0]!);
    const report = await readFile(path, "utf8");
    expect(result.stdout).toBe(`${report}\n${path}\n`);
    await expect(report).toMatchFileSnapshot("./__fixtures__/reflect/report.golden.md");

    // The same window renders the same bytes into the same file.
    expect((await reflect(args)).stdout).toBe(result.stdout);
    expect(await readdir(join(dir, ".sandbar", "reflect"))).toEqual(reports);
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
