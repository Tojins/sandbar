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
import { ensureIssueBranch, sourceBranchBase } from "./git-ops.js";
import { buildPrompt, buildReviewerPrompts, readGit } from "./prompt.js";
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
let origin: string;
let checkout: string;
let worktree: string;
let repoDir: string;
let shimBin: string;
let originalPath: string | undefined;

// origin.git <- the "remote"; checkout <- the operator's repo; and then the
// real cache + a worktree of the issue branch hanging off it.
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sandbar-prompt-diff-"));
  origin = join(root, "origin.git");
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

// The base is threaded, not derived (#61): these builders take whatever
// `ensureIssueBranch` returned, so a test can hand them a chunk tip exactly as
// the inner loop does. `sourceBranchBase` is the ordinary case.
const implementerInputs = (base = sourceBranchBase("main")) => ({
  issue: ISSUE,
  attempt: 2,
  maxAttempts: 8,
  worktreePath: worktree,
  lastFailureTrace: "",
  base,
});

const reviewerInputs = (base = sourceBranchBase("main"), sourceBranch = "main") => ({
  issue: ISSUE,
  repo: REPO,
  repoDir,
  worktreePath: worktree,
  sourceBranch,
  base,
  claudeMdPath: "CLAUDE.md",
  priorRounds: [],
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

    const prompt = (await buildReviewerPrompts(reviewerInputs())).correctness;

    expect(prompt).toContain(SUBJECT);
    expect(prompt).toContain(ADDED_LINE);
    expect(prompt).not.toContain("(empty — no changes against");
  });

  it("anchors the verify diff at the newest follow-up-reviewed head", async () => {
    await commitOnBranch();
    const listingHead = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
    const laterLine = "the-line-added-after-the-listing";
    await writeFile(join(worktree, "c.txt"), `${laterLine}\n`);
    await git(worktree, "add", "-A");
    await git(worktree, "commit", "-qm", "fix-after-listing");

    const prompt = (await buildReviewerPrompts({
      ...reviewerInputs(),
      priorRounds: [{
        round: 1,
        head: listingHead,
        correctness: { verdict: "APPROVED", prose: "<verdict>APPROVED</verdict>" },
        followup: {
          verdict: "CHANGES-REQUESTED",
          prose: "### Tests\n\nAdd coverage.\n<verdict>CHANGES-REQUESTED</verdict>",
        },
      }],
    })).followup;

    const changedSince = prompt.slice(
      prompt.indexOf("## Changed since the last follow-up review"),
      prompt.indexOf("## Coding standards"),
    );
    expect(changedSince).toContain(laterLine);
    expect(changedSince).not.toContain(ADDED_LINE);
  });
});

describe("a failed read is never rendered as an empty slot (#40)", () => {
  // The base ref not resolving is exactly #40's shape. Whatever else it is, it
  // must not come back as "there is no work here".
  it("throws out of the implementer slot instead of claiming no commits", async () => {
    await commitOnBranch();

    const built = buildPrompt(
      implementerInputs(sourceBranchBase("no-such-branch")),
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

    const built = buildReviewerPrompts(
      reviewerInputs(sourceBranchBase("no-such-branch"), "no-such-branch"),
    );

    await expect(built).rejects.toBeInstanceOf(SandbarError);
    await expect(built).rejects.toThrow(/could not read the commit list/);
  });

  // The backstop, and the reason it is worth having on top of the `origin/`
  // fix: it fires for a base ref that is wrong in some way that still resolves.
  // Here the range is valid and simply empty, which the loop's own invariants
  // say cannot happen by the time a reviewer runs.
  it("refuses a reviewer over an empty changeset", async () => {
    await expect(buildReviewerPrompts(reviewerInputs())).rejects.toThrow(
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

// #61 — the same guarantee for a chunk member, whose branch is cut from the
// chunk TIP rather than from `origin/<sourceBranch>`.
//
// This is #40's failure re-entered from the other side, and the fixture is what
// makes it visible: with the anchor re-derived as `origin/main`, every range
// below still RESOLVES — it just answers with the chunk's earlier work folded
// in beside the member's own. The implementer reads that as work it did and
// does not need to do, and the reviewer is asked for a verdict on commits
// belonging to an issue it was never given. Nothing exits non-zero, so only an
// assertion about the CONTENT of the slot can see it.
describe("a chunk member's slots are measured from the chunk tip (#61)", () => {
  const CHUNK = { root: 6, branch: "sandbar/chunk-6-widget" };
  const MEMBER_BRANCH = "sandbar/issue-8-member";
  const MEMBER_ISSUE = { id: "8", title: "member", branch: MEMBER_BRANCH };
  // The earlier member's contribution: on the chunk branch and nowhere else.
  const CHUNK_SUBJECT = "commit-that-belongs-to-an-earlier-member";
  const CHUNK_LINE = "the-line-only-the-chunk-branch-has";
  const MEMBER_SUBJECT = "commit-this-issue-actually-made";
  const MEMBER_LINE = "the-line-this-member-added";

  let memberWt: string;
  let base: Awaited<ReturnType<typeof ensureIssueBranch>>;

  beforeEach(async () => {
    // What the merge phase leaves on origin once the chunk's root has landed.
    await writeFile(join(checkout, "chunk.txt"), `${CHUNK_LINE}\n`);
    await git(checkout, "add", "-A");
    await git(checkout, "commit", "-qm", CHUNK_SUBJECT);
    await git(checkout, "push", "-q", "origin", `HEAD:refs/heads/${CHUNK.branch}`);
    await git(checkout, "reset", "-q", "--hard", "origin/main");

    base = await ensureIssueBranch(repoDir, MEMBER_BRANCH, "main", CHUNK);
    memberWt = join(root, "member-wt");
    await git(repoDir, "worktree", "add", "-q", memberWt, MEMBER_BRANCH);
    await git(memberWt, "config", "user.email", "t@t");
    await git(memberWt, "config", "user.name", "t");
    await writeFile(join(memberWt, "member.txt"), `${MEMBER_LINE}\n`);
    await git(memberWt, "add", "-A");
    await git(memberWt, "commit", "-qm", MEMBER_SUBJECT);
  });

  // The premise: the blocker's work really is under the member's feet. If this
  // ever stops holding, the two assertions below pass for the wrong reason.
  it("has the earlier member's work in the tree and out of the range", async () => {
    expect(await git(memberWt, "cat-file", "-e", "HEAD:chunk.txt")).toBeTruthy();
    expect(base.chunkBranch).toBe(CHUNK.branch);
  });

  it("shows the implementer its own commits and not the chunk's", async () => {
    const prompt = await buildPrompt(
      { ...implementerInputs(base), issue: MEMBER_ISSUE, worktreePath: memberWt },
      anchorOpts(),
    );

    expect(prompt).toContain(MEMBER_SUBJECT);
    expect(prompt).toContain(MEMBER_LINE);
    expect(prompt).not.toContain(CHUNK_SUBJECT);
    expect(prompt).not.toContain(CHUNK_LINE);
    // And it is told why, so an empty-looking tree is not a mystery.
    expect(prompt).toContain(CHUNK.branch);
  });

  it("gives the reviewer this issue's changeset and not the chunk's", async () => {
    const prompt = (await buildReviewerPrompts({
      ...reviewerInputs(base),
      issue: MEMBER_ISSUE,
      worktreePath: memberWt,
    })).correctness;

    expect(prompt).toContain(MEMBER_SUBJECT);
    expect(prompt).toContain(MEMBER_LINE);
    expect(prompt).not.toContain(CHUNK_SUBJECT);
    expect(prompt).not.toContain(CHUNK_LINE);
    expect(prompt).toContain(CHUNK.branch);
  });

  // The counterfactual, stated as a test rather than as a comment: the bug this
  // whole arrangement avoids is one line — deriving the anchor from the source
  // branch instead of taking the seed the branch was really cut from.
  it("would hand the member the whole chunk if the base were re-derived", async () => {
    const prompt = await buildPrompt(
      {
        ...implementerInputs(sourceBranchBase("main")),
        issue: MEMBER_ISSUE,
        worktreePath: memberWt,
      },
      anchorOpts(),
    );

    expect(prompt).toContain(CHUNK_SUBJECT);
    expect(prompt).toContain(CHUNK_LINE);
  });
});
