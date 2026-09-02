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
  it("reads contained origin member refs without consulting commit messages", async () => {
    const repo = await mkdtemp(join(tmpdir(), "sandbar-chunk-members-"));
    repos.push(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "sandbar@example.test");
    git(repo, "config", "user.name", "Sandbar Test");
    git(repo, "commit", "--allow-empty", "-qm", "base");
    git(repo, "checkout", "-qb", "sandbar/issue-47-useful-work");
    git(repo, "commit", "--allow-empty", "-qm", "arbitrary agent prose");
    git(repo, "update-ref", "refs/remotes/origin/sandbar/member-47", "HEAD");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "--no-ff", "sandbar/issue-47-useful-work", "-m", "cosmetic subject");
    // A parked child can point at the chunk tip and is still not membership:
    // issue refs may survive independently, while only landing publishes member refs.
    git(repo, "update-ref", "refs/remotes/origin/sandbar/issue-48-parked", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/sandbar/chunk-47-useful-work", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD~1");
    expect(await readChunkMembers(repo)).toEqual(
      new Map([["sandbar/chunk-47-useful-work", new Set([47])]]),
    );
  });

  it("retains members after a chunk is fast-forwarded into source", async () => {
    const repo = await mkdtemp(join(tmpdir(), "sandbar-landed-members-"));
    repos.push(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "sandbar@example.test");
    git(repo, "config", "user.name", "Sandbar Test");
    git(repo, "commit", "--allow-empty", "-qm", "base");
    git(repo, "checkout", "-qb", "sandbar/issue-60-root");
    git(repo, "commit", "--allow-empty", "-qm", "member work");
    git(repo, "update-ref", "refs/remotes/origin/sandbar/member-60", "HEAD");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "--no-ff", "sandbar/issue-60-root", "-m", "chunk work");
    git(repo, "update-ref", "refs/remotes/origin/sandbar/chunk-60-root", "HEAD");
    git(repo, "checkout", "-qb", "source", "HEAD~1");
    git(repo, "merge", "--ff-only", "origin/sandbar/chunk-60-root");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");

    expect(await readChunkMembers(repo)).toEqual(
      new Map([["sandbar/chunk-60-root", new Set([60])]]),
    );
  });

  it("reports inherited member refs in every containing chunk", async () => {
    const repo = await mkdtemp(join(tmpdir(), "sandbar-inherited-members-"));
    repos.push(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "sandbar@example.test");
    git(repo, "config", "user.name", "Sandbar Test");
    git(repo, "commit", "--allow-empty", "-qm", "base");
    git(repo, "checkout", "-qb", "member-10");
    git(repo, "commit", "--allow-empty", "-qm", "member 10");
    git(repo, "update-ref", "refs/remotes/origin/sandbar/member-10", "HEAD");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "--no-ff", "member-10", "-m", "chunk A");
    git(repo, "update-ref", "refs/remotes/origin/sandbar/chunk-10-alpha", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repo, "checkout", "-qb", "member-20");
    git(repo, "commit", "--allow-empty", "-qm", "member 20");
    git(repo, "update-ref", "refs/remotes/origin/sandbar/member-20", "HEAD");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "--no-ff", "member-20", "-m", "chunk B");
    git(repo, "update-ref", "refs/remotes/origin/sandbar/chunk-20-beta", "HEAD");
    expect(await readChunkMembers(repo)).toEqual(new Map([
      ["sandbar/chunk-10-alpha", new Set([10])],
      ["sandbar/chunk-20-beta", new Set([10, 20])],
    ]));
  });
});
