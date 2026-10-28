// The deploy watch's range reads against real git (#198): a chunk landed on
// main, whose own branch carries two member merges and a human commit. Every
// git call names its directory and carries its own identity.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { realDeployWatchAdapter } from "./deploy-watch.js";

const exec = promisify(execFile);
const git = async (repo: string, ...args: string[]): Promise<string> =>
  (
    await exec(
      "git",
      ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      { cwd: repo },
    )
  ).stdout.trim();

describe("realDeployWatchAdapter range reads", () => {
  let repo: string;
  let base: string;

  const commit = async (file: string): Promise<void> => {
    await writeFile(join(repo, file), file);
    await git(repo, "add", file);
    await git(repo, "commit", "-qm", `add ${file}`);
  };
  const merge = async (branch: string, subject: string): Promise<void> => {
    await git(repo, "merge", "-q", "--no-ff", "-m", subject, branch);
  };
  const adapter = () =>
    realDeployWatchAdapter({
      repo: { owner: "o", name: "r" },
      repoDir: repo,
      sourceBranch: "main",
      workflow: "deploy.yml",
      label: "deploy-red",
      beforeOriginWrite: async () => undefined,
    });

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "sandbar-deploy-watch-"));
    await git(repo, "init", "-q", "-b", "main");
    await commit("base");
    base = await git(repo, "rev-parse", "HEAD");

    await git(repo, "checkout", "-qb", "sandbar/chunk-1-c");
    await git(repo, "checkout", "-qb", "sandbar/issue-1-one");
    await commit("one");
    await git(repo, "checkout", "-q", "sandbar/chunk-1-c");
    await merge("sandbar/issue-1-one", "Merge sandbar/issue-1: One");
    await commit("human");
    await git(repo, "checkout", "-qb", "sandbar/issue-2-two");
    await commit("two");
    await git(repo, "checkout", "-q", "sandbar/chunk-1-c");
    await merge("sandbar/issue-2-two", "Merge sandbar/issue-2: Two");

    await git(repo, "checkout", "-q", "main");
    await merge("sandbar/chunk-1-c", "Merge sandbar/chunk-1-c: C");
    await git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("attributes the member merges inside a landed chunk and counts the human commit", async () => {
    const tip = await git(repo, "rev-parse", "main");
    const mergeOf = async (issue: number) =>
      git(repo, "log", "--format=%H %ct", "--grep", `^Merge sandbar/issue-${issue}:`, "main");
    const [sha2, ct2] = (await mergeOf(2)).split(" ");
    const [sha1, ct1] = (await mergeOf(1)).split(" ");

    const expected = {
      landings: [
        { issue: 2, title: "Two", sha: sha2, committedAtMs: Number(ct2) * 1000 },
        { issue: 1, title: "One", sha: sha1, committedAtMs: Number(ct1) * 1000 },
      ],
      otherCommits: 1,
    };
    expect(await adapter().landingsBetween(base, tip)).toEqual(expected);
    expect(await adapter().landingsSince(base)).toEqual(expected);
  });

  it("answers null when either end is missing from the cache", async () => {
    const tip = await git(repo, "rev-parse", "main");
    const absent = "0".repeat(40);
    expect(await adapter().landingsBetween(absent, tip)).toBeNull();
    expect(await adapter().landingsBetween(base, absent)).toBeNull();
    await git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    expect(await adapter().landingsSince(base)).toBeNull();
  });
});
