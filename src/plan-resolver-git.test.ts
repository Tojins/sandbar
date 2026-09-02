import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readChunkMembers } from "./plan-resolver.js";

// These tests execute git to pin the history boundary behind chunk membership:
// only canonical first-parent merge subjects on fetched origin chunk refs count.
// A ref whose name-derived root has no matching merge is wholly untrusted and
// therefore contributes no members, even when other subjects look canonical.

const repos: string[] = [];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

afterEach(async () => {
  for (const repo of repos.splice(0)) await rm(repo, { recursive: true, force: true });
});

describe("chunk membership from git (#93)", () => {
  it("reads only sandbar issue merge subjects from each origin chunk branch", async () => {
    const repo = await mkdtemp(join(tmpdir(), "sandbar-chunk-members-"));
    repos.push(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "sandbar@example.test");
    git(repo, "config", "user.name", "Sandbar Test");
    await writeFile(join(repo, "base"), "base\n");
    git(repo, "add", "base");
    git(repo, "commit", "-qm", "base");
    git(repo, "checkout", "-qb", "auto-member");
    await writeFile(join(repo, "auto"), "auto\n");
    git(repo, "add", "auto");
    git(repo, "commit", "-qm", "auto work");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "--no-ff", "auto-member", "-m", "Merge sandbar/issue-99: auto work");
    const chunkBase = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-qb", "member");
    await writeFile(join(repo, "member"), "member\n");
    git(repo, "add", "member");
    git(repo, "commit", "-qm", "member work");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "--no-ff", "member", "-m", "Merge sandbar/issue-47: useful work");
    git(repo, "update-ref", "refs/remotes/origin/main", chunkBase);
    git(repo, "update-ref", "refs/remotes/origin/sandbar/chunk-47-useful-work", "HEAD");

    expect(await readChunkMembers(repo)).toEqual(
      new Map([["sandbar/chunk-47-useful-work", new Set([47])]]),
    );
  });

  it("discards a branch whose name-derived root has no membership merge", async () => {
    const repo = await mkdtemp(join(tmpdir(), "sandbar-chunk-no-root-"));
    repos.push(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "sandbar@example.test");
    git(repo, "config", "user.name", "Sandbar Test");
    git(repo, "commit", "--allow-empty", "-qm", "base");
    git(repo, "checkout", "-qb", "member");
    git(repo, "commit", "--allow-empty", "-qm", "member work");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "--no-ff", "member", "-m", "Merge sandbar/issue-61: member");
    git(repo, "update-ref", "refs/remotes/origin/sandbar/chunk-60-root", "HEAD");

    expect(await readChunkMembers(repo)).toEqual(
      new Map([["sandbar/chunk-60-root", new Set()]]),
    );
  });

});
