// `npm run reflect`'s report over the fixture window (#182, #207, #208): two
// CLI runs, too slow for reflect-cli.test.ts, a sanity file (#269).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FIXTURE_LOGS, reflect, useConsumers } from "./reflect-cli.test-util.js";

const consumer = useConsumers();

describe("npm run reflect's report", () => {
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
});
