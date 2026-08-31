// The three facts about GIT that `readTreeState` is built on (#69). No fake can
// produce them, and the guard in that module is only worth its lines if the
// first one is true:
//
//   1. `git -C <an ignored directory> rev-parse HEAD` does not fail. It answers
//      with the ENCLOSING repository's HEAD — which is what would print after
//      the words "built from" for a driver installed under `node_modules/`.
//   2. An untracked file makes the tree dirty even when the repository's own
//      config says `status.showUntrackedFiles = no`.
//   3. A directory in no repository at all costs the fields, not the run.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UNKNOWN_TREE, readTreeState } from "./driver-identity.js";

const exec = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@e",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

describe("readTreeState (real git)", () => {
  let root: string;
  let work: string;
  let head: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-driver-"));
    work = join(root, "work");
    await exec("git", ["init", "-b", "main", work], { env: GIT_ENV });
    await writeFile(join(work, "package.json"), '{"version":"0.0.1"}\n');
    await writeFile(join(work, ".gitignore"), "vendor/\n");
    await git(work, "add", ".");
    await git(work, "commit", "-m", "base");
    head = await git(work, "rev-parse", "HEAD");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("names the full HEAD sha of a clean checkout", async () => {
    expect(await readTreeState(work)).toEqual({ commit: head, dirty: false });
    expect(head).toHaveLength(40);
  });

  it("is dirty for an untracked source file, whatever the repo's own status config says", async () => {
    await git(work, "config", "status.showUntrackedFiles", "no");
    await writeFile(join(work, "new-module.ts"), "export const x = 1;\n");
    expect(await readTreeState(work)).toEqual({ commit: head, dirty: true });
  });

  it("is dirty for a modified tracked file", async () => {
    await writeFile(join(work, "package.json"), '{"version":"0.0.2"}\n');
    expect(await readTreeState(work)).toEqual({ commit: head, dirty: true });
  });

  it("reports unknown inside an ignored directory, which git itself would answer for", async () => {
    const vendored = join(work, "vendor", "sandbar");
    await mkdir(vendored, { recursive: true });
    await writeFile(join(vendored, "package.json"), '{"version":"9.9.9"}\n');

    // The trap, stated by git: the enclosing repo's HEAD, for code that is not
    // in it.
    expect(await git(vendored, "rev-parse", "HEAD")).toBe(head);
    expect(await readTreeState(vendored)).toEqual(UNKNOWN_TREE);
  });

  it("reports unknown for a directory in no repository", async () => {
    const loose = join(root, "loose");
    await mkdir(loose, { recursive: true });
    expect(await readTreeState(loose)).toEqual(UNKNOWN_TREE);
  });

  it("reports unknown for a directory that does not exist", async () => {
    expect(await readTreeState(join(root, "gone"))).toEqual(UNKNOWN_TREE);
  });
});
