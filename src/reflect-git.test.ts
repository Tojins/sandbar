// Reflect's workspace on real git (#182 Decision 8): what it is built from,
// and that a call which writes to it is caught and undone.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildWorkspace, consumerFiles, guardReadOnly } from "./reflect.js";

const temporaryDirectories = new Set<string>();
afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((path) => rm(path, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

const git = (args: readonly string[]): string => execFileSync("git", [...args], {
  encoding: "utf8",
  env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
}).trim();

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sandbar-reflect-git-"));
  temporaryDirectories.add(dir);
  return dir;
}

// A bare repo whose tip holds the anchor docs, an ADR, an extension, and a
// file reflect has no business copying.
async function fixtureCache(dir: string): Promise<{ readonly cache: string; readonly tip: string }> {
  const source = join(dir, "source");
  for (const [path, text] of Object.entries({
    "CLAUDE.md": "# Conventions\n",
    "docs/adr/0001-store.md": "# Store\n",
    "docs/review-extra.md": "Check the migrations.\n",
    "README.md": "# App\n",
  })) {
    await mkdir(join(source, path, ".."), { recursive: true });
    await writeFile(join(source, path), text);
  }
  git(["init", "-q", "-b", "main", source]);
  git(["-C", source, "add", "-A"]);
  git(["-C", source, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  const cache = join(dir, "repo.git");
  git(["clone", "-q", "--bare", source, cache]);
  return { cache, tip: git([`--git-dir=${cache}`, "rev-parse", "HEAD"]) };
}

const docs = {
  claudeMdPath: "CLAUDE.md",
  contextMdPath: "CONTEXT.md",
  adrDir: "docs/adr",
  promptExtensions: { reviewer: { path: "docs/review-extra.md" }, implementer: { text: "inline" } },
};

describe("reflect's workspace (#182 Decision 8)", () => {
  it("holds the build's prompts and the consumer docs that exist at the tip, in one clean commit", async () => {
    const dir = await tmp();
    const { cache, tip } = await fixtureCache(dir);
    const consumer = await consumerFiles(docs, cache, tip);
    expect(consumer).toEqual(new Map([
      ["consumer/CLAUDE.md", "# Conventions\n"],
      ["consumer/docs/adr/0001-store.md", "# Store\n"],
      ["consumer/docs/review-extra.md", "Check the migrations.\n"],
    ]));
    const workspace = join(dir, "ws-1");
    await buildWorkspace(workspace, new Map([["sandbar/prompts/reflect-tagger.md", "# Tagger\n"], ...consumer]));
    expect(git(["-C", workspace, "ls-files"]).split("\n")).toEqual([
      "consumer/CLAUDE.md", "consumer/docs/adr/0001-store.md", "consumer/docs/review-extra.md",
      "sandbar/prompts/reflect-tagger.md",
    ]);
    expect(git(["-C", workspace, "rev-list", "--count", "HEAD"])).toBe("1");
    expect(git(["-C", workspace, "status", "--porcelain"])).toBe("");
  });

  it("fails a call that wrote with `wrote`, and puts the workspace back", async () => {
    const dir = await tmp();
    const workspace = join(dir, "ws-2");
    await buildWorkspace(workspace, new Map([["consumer/CLAUDE.md", "# Conventions\n"]]));
    const head = git(["-C", workspace, "rev-parse", "HEAD"]);

    const edited = await guardReadOnly(workspace, async () => {
      await writeFile(join(workspace, "consumer", "CLAUDE.md"), "# Rewritten\n");
      await writeFile(join(workspace, "notes.md"), "scratch\n");
      return { answer: "done" };
    });
    expect(edited).toEqual({ failure: expect.stringMatching(/^wrote: .*M consumer\/CLAUDE\.md, \?\? notes\.md$/) });
    expect(git(["-C", workspace, "status", "--porcelain"])).toBe("");
    expect(await readdir(workspace)).not.toContain("notes.md");

    const committed = await guardReadOnly(workspace, async () => {
      git(["-C", workspace, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
      return { answer: "done" };
    });
    expect(committed).toEqual({ failure: expect.stringContaining("wrote: HEAD refs/heads/reflect at") });
    expect(git(["-C", workspace, "rev-parse", "HEAD"])).toBe(head);

    expect(await guardReadOnly(workspace, async () => ({ answer: "read only" }))).toEqual({ answer: "read only" });
  });
});
