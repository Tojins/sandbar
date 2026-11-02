// `readSelectionTree` against real git: a branch forked from `main`, with
// committed, uncommitted and untracked changes. Every git call names its
// directory.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readSelectionTree } from "./gate-selection.js";

const exec = promisify(execFile);
const git = (repo: string, ...args: string[]) =>
  exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
  });

describe("readSelectionTree", () => {
  let repo: string;
  const put = async (path: string, text = path) => {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "sandbar-selection-"));
    await git(repo, "init", "-q", "-b", "main");
    for (const path of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]) await put(path);
    await writeFile(join(repo, ".gitignore"), "dist/\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "seed");
    await git(repo, "checkout", "-qb", "work");
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("is empty for a branch that changed nothing", async () => {
    expect(await readSelectionTree(repo, "main")).toEqual({
      changed: [],
      files: [".gitignore", "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
    });
  });

  it("reads committed, uncommitted and untracked changes since the fork, a rename as two", async () => {
    await put("src/a.ts", "changed");
    await git(repo, "mv", "src/b.ts", "src/e.ts");
    await git(repo, "commit", "-qam", "work");
    // main moving on is not the branch's change.
    await git(repo, "checkout", "-q", "main");
    await put("src/main-only.ts");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "main moves");
    await git(repo, "checkout", "-q", "work");
    await put("src/c.ts", "uncommitted");
    await rm(join(repo, "src/d.ts"));
    await put("src/f.test.ts");
    await put("dist/out.js");

    const { changed, files } = await readSelectionTree(repo, "main");
    expect([...changed].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: "src/a.ts", deleted: false },
      { path: "src/b.ts", deleted: true },
      { path: "src/c.ts", deleted: false },
      { path: "src/d.ts", deleted: true },
      { path: "src/e.ts", deleted: false },
      { path: "src/f.test.ts", deleted: false },
    ]);
    expect(files).toEqual([".gitignore", "src/a.ts", "src/c.ts", "src/e.ts", "src/f.test.ts"]);
  });
});
