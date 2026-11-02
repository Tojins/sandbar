// The reflect CLI tests' fixture (#182), shared by reflect-cli.test.ts and
// reflect-cli-report.test.ts: the built entry run as `npm run reflect` runs
// it (`npm test` builds dist/ first), and a consumer directory per test.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach } from "vitest";

const REFLECT_CLI = fileURLToPath(new URL("../dist/reflect-cli.js", import.meta.url));
export const FIXTURE_LOGS = fileURLToPath(new URL("./__fixtures__/stats/logs", import.meta.url));

export const reflect = async (
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

// A consumer directory holding only a config, removed after each test: its
// state directory is `<dir>/.sandbar`.
export function useConsumers(): () => Promise<{ readonly dir: string; readonly config: string }> {
  const temporaryDirectories = new Set<string>();
  afterEach(async () => {
    await Promise.all(
      [...temporaryDirectories].map((path) => rm(path, { recursive: true, force: true })),
    );
    temporaryDirectories.clear();
  });
  return async () => {
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
  };
}
