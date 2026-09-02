import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readChunkMembers } from "./plan-resolver.js";

const repos: string[] = [];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

afterEach(async () => {
  for (const repo of repos.splice(0)) await rm(repo, { recursive: true, force: true });
});

describe("chunk membership from branch containment (#93)", () => {
  it("reads contained origin issue refs without consulting commit messages", async () => {
    const repo = await mkdtemp(join(tmpdir(), "sandbar-chunk-members-"));
    repos.push(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "sandbar@example.test");
    git(repo, "config", "user.name", "Sandbar Test");
    git(repo, "commit", "--allow-empty", "-qm", "base");
    git(repo, "checkout", "-qb", "sandbar/issue-47-useful-work");
    git(repo, "commit", "--allow-empty", "-qm", "arbitrary agent prose");
    git(repo, "update-ref", "refs/remotes/origin/sandbar/issue-47-useful-work", "HEAD");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "--no-ff", "sandbar/issue-47-useful-work", "-m", "cosmetic subject");
    git(repo, "update-ref", "refs/remotes/origin/sandbar/chunk-47-useful-work", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD~1");
    expect(await readChunkMembers(repo, "main")).toEqual(
      new Map([["sandbar/chunk-47-useful-work", new Set([47])]]),
    );
  });

  it("excludes source-contained refs live but retains them for reconciliation", async () => {
    const repo = await mkdtemp(join(tmpdir(), "sandbar-landed-members-"));
    repos.push(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "sandbar@example.test");
    git(repo, "config", "user.name", "Sandbar Test");
    git(repo, "commit", "--allow-empty", "-qm", "base");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/sandbar/issue-60-root", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/sandbar/chunk-60-root", "HEAD");
    expect(await readChunkMembers(repo, "main")).toEqual(
      new Map([["sandbar/chunk-60-root", new Set()]]),
    );
    expect(await readChunkMembers(repo, "main", true)).toEqual(
      new Map([["sandbar/chunk-60-root", new Set([60])]]),
    );
  });
});
