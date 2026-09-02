import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readChunkMembers, resolvePlan } from "./plan-resolver.js";

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
    git(repo, "checkout", "-qb", "member");
    await writeFile(join(repo, "member"), "member\n");
    git(repo, "add", "member");
    git(repo, "commit", "-qm", "member work");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "--no-ff", "member", "-m", "Merge sandbar/issue-47: useful work");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD~1");
    git(repo, "update-ref", "refs/remotes/origin/sandbar/chunk-47-useful-work", "HEAD");

    expect(await readChunkMembers(repo)).toEqual(
      new Map([["sandbar/chunk-47-useful-work", new Set([47])]]),
    );
  });

  it("ignores needs-review labels when git does not name the member", () => {
    const issue = { number: 47, title: "Useful work", body: "", labels: ["ready-for-agent", "needs-review"] };
    const result = resolvePlan(
      [issue],
      new Map([[47, { state: "OPEN" as const, labels: ["needs-review"] }]]),
      new Set(),
      3,
      "review",
      new Map(),
    );
    expect(result.plan.map((p) => p.id)).toEqual(["47"]);
  });

  it("does not satisfy membership recorded on a different chunk branch", () => {
    const issues = [
      { number: 47, title: "Root", body: "", labels: ["ready-for-agent"] },
      { number: 48, title: "Child", body: "## Blocked by\n- #47\n", labels: ["ready-for-agent"] },
    ];
    const result = resolvePlan(
      issues,
      new Map(issues.map((i) => [i.number, { state: "OPEN" as const, labels: [] }])),
      new Set(),
      3,
      "review",
      new Map([["sandbar/chunk-99-other", new Set([47])]]),
    );
    expect(result.plan.map((p) => p.id)).toEqual(["47"]);
  });
});
