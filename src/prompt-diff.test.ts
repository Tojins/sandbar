// #40 — the diff and commit-list slots, against the layout the agents really
// see: a linked worktree of the BARE object cache.
//
// This is the fixture the bug needed and did not have. Every prompt test before
// it stood in an ordinary clone, where `main` is a local head and
// `main..HEAD` resolves by accident; #38 replaced that clone with a bare cache
// whose local head namespace holds exactly one ref — the issue branch — and the
// same range then exited 128 into a `catch` that rendered "No commits yet on
// this branch." The implementer was told its own commits did not exist and the
// reviewer was asked for a verdict on an empty changeset, for a whole run,
// because both failures rendered as the one legitimate empty answer.
//
// So the cache is built by the real `ensureRepoCache`, not hand-rolled: the
// property under test is that a ref resolves in a repo git constructed, and a
// fixture that adds a local `main` of its own passes with the bug restored.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandbarError } from "./errors.js";
import { ensureIssueBranch } from "./git-ops.js";
import { buildPrompt, buildReviewerPrompt, readGit } from "./prompt.js";
import { repoLayout, worktreePathFor } from "./repo-cache.js";
import { ensureRepoCache } from "./repo-cache.js";

const exec = promisify(execFile);
const git = (repo: string, ...args: string[]) =>
  exec("git", args, { cwd: repo, env: { ...process.env, LC_ALL: "C" } });

const REPO = { owner: "acme", name: "app" };
const BRANCH = "sandbar/issue-7-widget";
const ISSUE = { id: "7", title: "widget", branch: BRANCH };

// Content the assertions look for. Distinct strings for the commit subject and
// for the line the commit adds, so "the diff is there" cannot pass on the
// commit list alone.
const SUBJECT = "commit-on-the-issue-branch";
const ADDED_LINE = "the-line-only-the-branch-has";

let root: string;
let checkout: string;
let worktree: string;
let repoDir: string;
let shimBin: string;
let originalPath: string | undefined;

// origin.git <- the "remote"; checkout <- the operator's repo; and then the
// real cache + a worktree of the issue branch hanging off it.
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sandbar-prompt-diff-"));
  const origin = join(root, "origin.git");
  checkout = join(root, "checkout");
  await exec("git", ["init", "--bare", "-q", "-b", "main", origin]);
  await exec("git", ["clone", "-q", origin, checkout], { cwd: root });
  await git(checkout, "config", "user.email", "t@t");
  await git(checkout, "config", "user.name", "t");
  await writeFile(join(checkout, "a.txt"), "base\n");
  await git(checkout, "add", "-A");
  await git(checkout, "commit", "-qm", "base-commit-on-main");
  await git(checkout, "push", "-q", "origin", "main");

  const layout = repoLayout(checkout, ".sandbar");
  await ensureRepoCache(layout);
  repoDir = layout.repoDir;
  await ensureIssueBranch(repoDir, BRANCH, "main");
  worktree = worktreePathFor(layout.worktreesDir, BRANCH);
  await git(repoDir, "worktree", "add", "-q", worktree, BRANCH);
  await git(worktree, "config", "user.email", "t@t");
  await git(worktree, "config", "user.name", "t");

  // A `gh` that answers whatever it is asked. The tracker layer has its own
  // tests (prompt-cwd.test.ts); here it is only in the way.
  shimBin = await mkdtemp(join(tmpdir(), "sandbar-shim-"));
  await writeFile(
    join(shimBin, "gh"),
    '#!/bin/sh\nprintf \'{"title":"t","body":"b","comments":[]}\'\n',
    { mode: 0o755 },
  );
  originalPath = process.env["PATH"];
  process.env["PATH"] = `${shimBin}:${originalPath ?? ""}`;
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = originalPath;
  await rm(root, { recursive: true, force: true });
  await rm(shimBin, { recursive: true, force: true });
});

async function commitOnBranch(): Promise<void> {
  await writeFile(join(worktree, "b.txt"), `${ADDED_LINE}\n`);
  await git(worktree, "add", "-A");
  await git(worktree, "commit", "-qm", SUBJECT);
}

const anchorOpts = (sourceBranch = "main") => ({
  repo: REPO,
  repoDir,
  claudeMdPath: "CLAUDE.md",
  sourceBranch,
});

const implementerInputs = (sourceBranch = "main") => ({
  issue: ISSUE,
  attempt: 2,
  maxAttempts: 8,
  worktreePath: worktree,
  lastFailureTrace: "",
  sourceBranch,
});

const reviewerInputs = (sourceBranch = "main") => ({
  issue: ISSUE,
  repo: REPO,
  repoDir,
  worktreePath: worktree,
  sourceBranch,
  claudeMdPath: "CLAUDE.md",
});

describe("prompt slots resolve their base ref in a worktree of the bare cache (#40)", () => {
  // The local head namespace is the whole bug in one assertion: `main` is not
  // in it, so the pre-#40 range could never have resolved.
  it("has no local copy of the source branch to fall back on", async () => {
    const heads = (
      await git(repoDir, "for-each-ref", "--format=%(refname)", "refs/heads")
    ).stdout.trim();
    expect(heads).toBe(`refs/heads/${BRANCH}`);
    await expect(
      git(worktree, "rev-parse", "--verify", "main"),
    ).rejects.toThrow();
  });

  it("shows the implementer the work it has already committed", async () => {
    await commitOnBranch();

    const prompt = await buildPrompt(implementerInputs(), anchorOpts());

    expect(prompt).toContain(SUBJECT);
    expect(prompt).toContain(ADDED_LINE);
    expect(prompt).not.toContain("No commits yet on this branch.");
  });

  // Attempt 1 is the one legitimate empty answer, and keeping it legitimate is
  // why the failure below has to throw rather than render as this.
  it("still says so when the branch genuinely holds nothing", async () => {
    const prompt = await buildPrompt(implementerInputs(), anchorOpts());

    expect(prompt).toContain("No commits yet on this branch.");
  });

  it("hands the reviewer both the commit list and the diff", async () => {
    await commitOnBranch();

    const prompt = await buildReviewerPrompt(reviewerInputs());

    expect(prompt).toContain(SUBJECT);
    expect(prompt).toContain(ADDED_LINE);
    expect(prompt).not.toContain("(empty — no changes against the source branch)");
  });
});

describe("a failed read is never rendered as an empty slot (#40)", () => {
  // The base ref not resolving is exactly #40's shape. Whatever else it is, it
  // must not come back as "there is no work here".
  it("throws out of the implementer slot instead of claiming no commits", async () => {
    await commitOnBranch();

    const built = buildPrompt(
      implementerInputs("no-such-branch"),
      anchorOpts("no-such-branch"),
    );

    await expect(built).rejects.toBeInstanceOf(SandbarError);
    await expect(built).rejects.toThrow(/work done so far/);
  });

  // Asserted on the message, not just the class: swallow the read and the
  // empty-changeset refusal below throws a SandbarError of its own, so a
  // class-only assertion here passes with the swallow restored.
  it("throws out of the reviewer slot instead of asking for a verdict on nothing", async () => {
    await commitOnBranch();

    const built = buildReviewerPrompt(reviewerInputs("no-such-branch"));

    await expect(built).rejects.toBeInstanceOf(SandbarError);
    await expect(built).rejects.toThrow(/could not read the commit list/);
  });

  // The backstop, and the reason it is worth having on top of the `origin/`
  // fix: it fires for a base ref that is wrong in some way that still resolves.
  // Here the range is valid and simply empty, which the loop's own invariants
  // say cannot happen by the time a reviewer runs.
  it("refuses a reviewer over an empty changeset", async () => {
    await expect(buildReviewerPrompt(reviewerInputs())).rejects.toThrow(
      /refusing to launch a reviewer/,
    );
  });
});

describe("readGit truncation (#40)", () => {
  // Node's maxBuffer overflow is the one failure that is not a fault, and the
  // property that makes it recoverable is node's, not sandbar's: the prefix
  // read before the kill survives on `err.stdout`. Asserted by running it.
  it("returns the prefix with a marker rather than throwing", async () => {
    await commitOnBranch();

    const out = await readGit(
      ["log", "-p", "--reverse", "origin/main..HEAD"],
      worktree,
      "the work done so far",
      120,
    );

    expect(out).toContain("commit ");
    expect(out).toContain("[sandbar] output truncated");
    expect(out).not.toContain(ADDED_LINE);
  });

  it("does not truncate a read that fits", async () => {
    await commitOnBranch();

    const out = await readGit(
      ["log", "origin/main..HEAD", "--oneline"],
      worktree,
      "the commit list",
    );

    expect(out).toContain(SUBJECT);
    expect(out).not.toContain("[sandbar] output truncated");
  });
});
