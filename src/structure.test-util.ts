// The structural checks' harness (#183): fixture branches built in real
// repositories, and `run.mjs` run over them.
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

const RUN = fileURLToPath(new URL("../scripts/structure/run.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../scripts/structure/fixtures/", import.meta.url));

export const git = (dir: string, ...args: string[]): string => {
  const result = spawnSync("git", [
    "-C", dir, "-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false",
    "-c", "init.defaultBranch=main", ...args,
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

// Temporary directories and fixture repositories in them, each removed
// after the test that made it. A fixture repository's `origin/main` is the
// fixture's `base/` tree, and its HEAD, on `topic`, adds its `head/` tree on
// top.
export function useFixtures() {
  const made = new Set<string>();
  afterEach(async () => {
    await Promise.all([...made].map((path) => rm(path, { recursive: true, force: true })));
    made.clear();
  });
  const tempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "sandbar-structure-"));
    made.add(dir);
    return dir;
  };
  const fixtureRepo = async (fixture: string): Promise<string> => {
    const dir = await tempDir();
    await cp(join(FIXTURES, fixture, "base"), dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(dir, "checkout", "-q", "-b", "topic");
    await cp(join(FIXTURES, fixture, "head"), dir, { recursive: true });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "head");
    return dir;
  };
  return { tempDir, fixtureRepo };
}

export const run = (cwd: string, ...args: string[]) => {
  const result = spawnSync(process.execPath, [RUN, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, lines: result.stdout.trimEnd().split("\n"), stderr: result.stderr };
};
