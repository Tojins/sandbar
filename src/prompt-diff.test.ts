// #40/#158 — the stat and commit-list slots, against the layout the agents really
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
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandbarError } from "./errors.js";
import { ensureIssueBranch, sourceBranchBase } from "./git-ops.js";
import type { ReviewScope } from "./inner-loop-machine.js";
import { ghIssueSource } from "./issue-anchor.js";
import {
  branchIsAheadOfSeed,
  buildPrompt,
  buildCorrectnessPrompt,
  buildQualityFixPrompt,
  buildQualityReviewPrompt,
  contextChars,
  measureNetDiff,
  readGit,
} from "./prompt.js";
import { loadTemplate } from "./prompts.js";
import { combineStandards, parseStandards } from "./standards-groups.js";
import { repoLayout, worktreePathFor } from "./repo-cache.js";
import { ensureRepoCache } from "./repo-cache.js";

const exec = promisify(execFile);
const git = (repo: string, ...args: string[]) =>
  exec("git", args, { cwd: repo, env: { ...process.env, LC_ALL: "C" } });

const REPO = { owner: "acme", name: "app" };
const BRANCH = "sandbar/issue-7-widget";
const ISSUE = { subject: { kind: "issue", id: "7", title: "widget" }, branch: BRANCH } as const;

// Content the assertions look for. The line itself must stay out of prompt
// slots; its filename in the stat proves progressive disclosure is wired.
const SUBJECT = "commit-on-the-issue-branch";
const ADDED_LINE = "the-line-only-the-branch-has";
const LONG_PATH =
  "src/app/features/visit-editing/components/visit-version-diff/" +
  "visit-version-diff.component.ts";

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

async function commitLongPath(subject: string): Promise<void> {
  const path = join(worktree, LONG_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${ADDED_LINE}\n`);
  await git(worktree, "add", "-A");
  await git(worktree, "commit", "-qm", subject);
}

const anchorOpts = (sourceBranch = "main") => ({
  issueSource: ghIssueSource(REPO),
  repo: REPO,
  repoDir,
  anchorCacheDir: join(repoDir, "anchor-cache"),
  claudeMdPath: "CLAUDE.md",
  sourceBranch,
});

// The base is threaded, not derived (#61): these builders take whatever
// `ensureIssueBranch` returned, so a test can hand them a chunk tip exactly as
// the inner loop does. `sourceBranchBase` is the ordinary case.
const implementerInputs = (base = sourceBranchBase("main")) => ({
  ...ISSUE,
  attempt: 2,
  worktreePath: worktree,
  lastFailureTrace: "",
  base,
  settled: new Set<never>(),
});

const reviewerInputs = (base = sourceBranchBase("main"), sourceBranch = "main") => ({
  ...ISSUE,
  issueSource: ghIssueSource(REPO),
  repo: REPO,
  repoDir,
  anchorCacheDir: join(repoDir, "anchor-cache"),
  worktreePath: worktree,
  sourceBranch,
  base,
  claudeMdPath: "CLAUDE.md",
});
const correctnessInputs = (
  base = sourceBranchBase("main"),
  sourceBranch = "main",
  scope: ReviewScope = { kind: "full" },
) => ({
  ...reviewerInputs(base, sourceBranch),
  priorRounds: [],
  scope,
});
const qualityInputs = () => ({
  ...reviewerInputs(),
  standards: combineStandards(parseStandards(loadTemplate("coding-standards"), "sandbar"), null),
  settled: new Set<never>(),
});
const listerInputs = (approvedHead: string | null = null) => {
  const inputs = qualityInputs();
  return {
    ...inputs,
    mode: {
      kind: "list",
      scope: approvedHead === null ? { kind: "full" } : { kind: "since", sha: approvedHead },
      overrules: [],
      group: inputs.standards.groups[0]!,
    },
  } as const;
};
const verifyInputs = (anchor: string) => ({
  ...qualityInputs(),
  mode: { kind: "verify", anchor, report: "### Tests\nmissing" },
} as const);
const fixerInputs = () => ({ ...qualityInputs(), report: "### Tests\nmissing", ruling: null });

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
    expect(prompt).toContain("b.txt");
    expect(prompt).not.toContain(ADDED_LINE);
    expect(prompt).not.toContain("No commits yet on this branch.");
  });

  // Attempt 1 is the one legitimate empty answer, and keeping it legitimate is
  // why the failure below has to throw rather than render as this.
  it("still says so when the branch genuinely holds nothing", async () => {
    const prompt = await buildPrompt(implementerInputs(), anchorOpts());

    expect(prompt).toContain("No commits yet on this branch.");
  });

  it("hands the reviewer the commit list and diff stat, not the patch", async () => {
    await commitOnBranch();

    const prompt = await buildCorrectnessPrompt(correctnessInputs());

    expect(prompt).toContain(SUBJECT);
    expect(prompt).toContain("b.txt");
    expect(prompt).not.toContain(ADDED_LINE);
    expect(prompt).not.toContain("(empty — no changes against");
  });

  it("keeps long filenames exact in every progressive-disclosure stat", async () => {
    await commitLongPath("long-path-on-the-issue-branch");
    const listingHead = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();

    const implementer = await buildPrompt(implementerInputs(), anchorOpts());
    expect(implementer).toContain(LONG_PATH);
    expect(await buildQualityReviewPrompt(listerInputs())).toContain(LONG_PATH);
    expect(await buildQualityFixPrompt(fixerInputs())).toContain(LONG_PATH);
    expect(await buildCorrectnessPrompt(correctnessInputs())).toContain(LONG_PATH);
    expect(implementer).not.toContain(".../components/visit-version-diff");

    const laterPath = `after-review/${LONG_PATH}`;
    const path = join(worktree, laterPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "later\n");
    await git(worktree, "add", "-A");
    await git(worktree, "commit", "-qm", "long-path-after-listing");

    const later = await buildQualityReviewPrompt(listerInputs(listingHead));
    const changedSince = later.slice(
      later.indexOf("## Changed since"),
      later.indexOf("## Coding standards"),
    );
    expect(changedSince).toContain(laterPath);
    expect(changedSince).not.toContain(".../visit-version-diff");

    // The verifier's white-box review from its second round on (#180).
    const review = await buildCorrectnessPrompt(
      correctnessInputs(undefined, undefined, { kind: "since", sha: listingHead }),
    );
    const reviewSince = review.slice(
      review.indexOf("## Changed since"),
      review.indexOf("## Review process"),
    );
    expect(reviewSince).toContain(`## Changed since \`${listingHead}\``);
    expect(reviewSince).toContain(laterPath);
  });

  it("measures the on-demand net diff separately from the rendered prompt", async () => {
    expect(await branchIsAheadOfSeed(worktree, "origin/main")).toBe(false);
    expect(await measureNetDiff(worktree, "origin/main", "main")).toEqual({ chars: 0, largestFiles: [] });
    await commitOnBranch();

    const diff = (await git(worktree, "diff", "origin/main...HEAD")).stdout;
    expect(await branchIsAheadOfSeed(worktree, "origin/main")).toBe(true);
    expect((await measureNetDiff(worktree, "origin/main", "main")).chars).toBe(diff.length);
    expect(contextChars("prompt", diff.length)).toBe(6 + diff.length);
  });

  it("names the three largest files of the measured diff, largest first", async () => {
    for (const [path, size] of [["small.txt", 100], ["large.txt", 300], ["mid.txt", 200], ["tiny.txt", 50]] as const) {
      await writeFile(join(worktree, path), `${"x".repeat(size)}\n`);
    }
    await git(worktree, "add", "-A");
    await git(worktree, "commit", "-qm", "four-files");

    const sizeOf = async (path: string) =>
      (await git(worktree, "diff", "origin/main...HEAD", "--", path)).stdout.length;
    expect((await measureNetDiff(worktree, "origin/main", "main")).largestFiles).toEqual([
      { path: "large.txt", chars: await sizeOf("large.txt") },
      { path: "mid.txt", chars: await sizeOf("mid.txt") },
      { path: "small.txt", chars: await sizeOf("small.txt") },
    ]);
  });

  // git quotes and octal-escapes such paths in a `diff --git` header.
  it("names a file under its real path when git would quote it", async () => {
    const paths = ["café 日本.txt", 'say "hi".txt', "my file.txt"];
    for (const [i, path] of paths.entries()) await writeFile(join(worktree, path), `${"x".repeat(300 - i * 100)}\n`);
    await git(worktree, "add", "-A");
    await git(worktree, "commit", "-qm", "quoted-paths");

    const { largestFiles } = await measureNetDiff(worktree, "origin/main", "main");
    expect(largestFiles.map((file) => file.path)).toEqual(paths);
  });

  // A type change is two patch entries, a deletion and an addition, under one
  // `diff --git` header and one listed name.
  it("names the files after a type change under their own paths", async () => {
    await writeFile(join(worktree, "a.txt"), "a\n");
    await writeFile(join(worktree, "f.txt"), `${"f".repeat(200)}\n`);
    await git(worktree, "add", "-A");
    await git(worktree, "commit", "-qm", "regular-f");
    const base = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(worktree, "a.txt"), `${"a".repeat(100)}\n`);
    await rm(join(worktree, "f.txt"));
    await symlink("a.txt", join(worktree, "f.txt"));
    await writeFile(join(worktree, "h.txt"), `${"h".repeat(600)}\n`);
    await git(worktree, "add", "-A");
    await git(worktree, "commit", "-qm", "f-becomes-a-symlink");

    const sizeOf = async (path: string) => (await git(worktree, "diff", base, "HEAD", "--", path)).stdout.length;
    expect((await measureNetDiff(worktree, base, "main")).largestFiles).toEqual([
      { path: "h.txt", chars: await sizeOf("h.txt") },
      { path: "f.txt", chars: await sizeOf("f.txt") },
      { path: "a.txt", chars: await sizeOf("a.txt") },
    ]);
  });

  // #187: a later lister reads what changed since the last approved quality
  // head, and a verify what changed since the head before the fixer, both
  // read from git at that anchor.
  it.each([
    ["a later lister", listerInputs],
    ["a verify", verifyInputs],
  ] as const)("anchors %s's changed-since stat at its head", async (_role, inputs) => {
    await commitOnBranch();
    const anchor = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
    const laterLine = "the-line-added-after-the-listing";
    await writeFile(join(worktree, "c.txt"), `${laterLine}\n`);
    await git(worktree, "add", "-A");
    await git(worktree, "commit", "-qm", "fix-after-listing");

    const prompt = await buildQualityReviewPrompt(inputs(anchor));

    const changedSince = prompt.slice(
      prompt.indexOf(`## Changed since \`${anchor}\``),
      prompt.indexOf("## Coding standards"),
    );
    expect(changedSince).toContain("c.txt");
    expect(changedSince).not.toContain("b.txt");
    expect(changedSince).not.toContain(laterLine);
  });
});

describe("a failed read is never rendered as an empty slot (#40)", () => {
  // The base ref not resolving is exactly #40's shape. Both independent prompt
  // reads use it concurrently, so either named read may be the first rejection;
  // whatever else it is, it must not come back as "there is no work here".
  it("throws out of the implementer slot instead of claiming no commits", async () => {
    await commitOnBranch();

    const built = buildPrompt(
      implementerInputs(sourceBranchBase("no-such-branch")),
      anchorOpts("no-such-branch"),
    );

    await expect(built).rejects.toBeInstanceOf(SandbarError);
    await expect(built).rejects.toThrow(
      /could not read the (commit list|branch diff stat)/,
    );
  });

  // Asserted on the message, not just the class: swallow the read and the
  // empty-changeset refusal below throws a SandbarError of its own, so a
  // class-only assertion here passes with the swallow restored.
  it("throws out of the reviewer slot instead of asking for a verdict on nothing", async () => {
    await commitOnBranch();

    const built = buildCorrectnessPrompt(
      correctnessInputs(sourceBranchBase("no-such-branch"), "no-such-branch"),
    );

    await expect(built).rejects.toBeInstanceOf(SandbarError);
    await expect(built).rejects.toThrow(/could not read the commit list/);
  });

  // The backstop, and the reason it is worth having on top of the `origin/`
  // fix: it fires for a base ref that is wrong in some way that still resolves.
  // Here the range is valid and simply empty, which the loop's own invariants
  // say cannot happen by the time a reviewer runs.
  it("refuses a reviewer or fixer over an empty changeset", async () => {
    await expect(buildCorrectnessPrompt(correctnessInputs())).rejects.toThrow(
      /refusing to launch the verifier's white-box review/,
    );
    await expect(buildQualityReviewPrompt(listerInputs())).rejects.toThrow(
      /refusing to launch a quality lister/,
    );
    await expect(buildQualityFixPrompt(fixerInputs())).rejects.toThrow(
      /refusing to launch the quality fixer/,
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
  const MEMBER_ISSUE = {
    subject: { kind: "issue", id: "8", title: "member" },
    branch: MEMBER_BRANCH,
  } as const;
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
      { ...implementerInputs(base), ...MEMBER_ISSUE, worktreePath: memberWt },
      anchorOpts(),
    );

    expect(prompt).toContain(MEMBER_SUBJECT);
    expect(prompt).toContain("member.txt");
    expect(prompt).not.toContain(MEMBER_LINE);
    expect(prompt).not.toContain(CHUNK_SUBJECT);
    expect(prompt).not.toContain(CHUNK_LINE);
    // And it is told why, so an empty-looking tree is not a mystery.
    expect(prompt).toContain(CHUNK.branch);
  });

  it("gives the reviewer this issue's changeset and not the chunk's", async () => {
    const prompt = await buildCorrectnessPrompt({
      ...correctnessInputs(base),
      ...MEMBER_ISSUE,
      worktreePath: memberWt,
    });

    expect(prompt).toContain(MEMBER_SUBJECT);
    expect(prompt).toContain("member.txt");
    expect(prompt).not.toContain(MEMBER_LINE);
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
        ...MEMBER_ISSUE,
        worktreePath: memberWt,
      },
      anchorOpts(),
    );

    expect(prompt).toContain(CHUNK_SUBJECT);
    expect(prompt).toContain("chunk.txt");
    expect(prompt).not.toContain(CHUNK_LINE);
  });
});

// #263 — the context budget counts the branch's own work, never what it merged
// from the source branch. The seed is a chunk tip that trails main, the shape
// Tojins/outdoor#827 parked on: main moves past the seed, the issue branch
// merges main, and `seed...HEAD` then charges main's change to the issue.
describe("the measured net diff leaves out what the branch merged from the source branch (#263)", () => {
  const CHUNK = { root: 6, branch: "sandbar/chunk-6-widget" };
  const MEMBER_BRANCH = "sandbar/issue-8-member";
  // A single-line generated asset, as outdoor's `emoji.json` was.
  const EMOJI = `[${'"x",'.repeat(99_000)}"y"]`;

  let memberWt: string;
  let seed: string;
  let ownDiff: string;

  const commitIn = async (dir: string, files: Record<string, string>, subject: string) => {
    for (const [path, body] of Object.entries(files)) await writeFile(join(dir, path), body);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", subject);
  };

  const advanceMain = async (files: Record<string, string>) => {
    await commitIn(checkout, files, "main-moves-past-the-seed");
    await git(checkout, "push", "-q", "origin", "main");
    await git(repoDir, "fetch", "-q", "origin");
  };

  const measure = () => measureNetDiff(memberWt, seed, "main");

  beforeEach(async () => {
    await commitIn(checkout, { "emoji.json": EMOJI }, "emoji-on-main");
    await git(checkout, "push", "-q", "origin", "main");
    await commitIn(checkout, { "chunk.txt": "earlier member\n" }, "earlier-member");
    await git(checkout, "push", "-q", "origin", `HEAD:refs/heads/${CHUNK.branch}`);
    await git(checkout, "reset", "-q", "--hard", "origin/main");
    await git(repoDir, "fetch", "-q", "origin");

    seed = (await ensureIssueBranch(repoDir, MEMBER_BRANCH, "main", CHUNK)).ref;
    memberWt = join(root, "member-wt");
    await git(repoDir, "worktree", "add", "-q", memberWt, MEMBER_BRANCH);
    await git(memberWt, "config", "user.email", "t@t");
    await git(memberWt, "config", "user.name", "t");
    await commitIn(memberWt, { "own.txt": "own work line\n".repeat(750) }, "own-work");
    ownDiff = (await git(memberWt, "diff", "HEAD^", "HEAD")).stdout;
  });

  it("measures 10k of own work, not a 1 MB file merged from main", async () => {
    await advanceMain({ "big.txt": `${"b".repeat(1_000_000)}\n` });
    await git(memberWt, "merge", "-q", "--no-edit", "origin/main");

    expect(ownDiff.length).toBeGreaterThan(10_000);
    expect((await measure()).chars).toBe(ownDiff.length);
  });

  it("measures only own work after merging main's edit to a large single-line file", async () => {
    await advanceMain({ "emoji.json": EMOJI.replace('"y"', '"z"') });
    await git(memberWt, "merge", "-q", "--no-edit", "origin/main");

    // The premise: the old measure charged the issue for main's one-line edit.
    expect((await git(memberWt, "diff", `${seed}...HEAD`)).stdout.length).toBeGreaterThan(2 * EMOJI.length);
    expect(await measure()).toEqual({
      chars: ownDiff.length,
      largestFiles: [{ path: "own.txt", chars: ownDiff.length }],
    });
  });

  it("measures a branch that never merged main exactly as seed...HEAD", async () => {
    await advanceMain({ "big.txt": "unmerged\n" });
    await commitIn(memberWt, { "chunk.txt": "rewritten\n" }, "more-own-work");

    expect((await measure()).chars).toBe((await git(memberWt, "diff", `${seed}...HEAD`)).stdout.length);
  });

  // Only a conflict yields a tree; any other `merge-tree` failure is git's.
  it("propagates a merge-tree failure that is not a conflict", async () => {
    await git(checkout, "checkout", "-q", "--orphan", "unrelated");
    await commitIn(checkout, { "a.txt": "another history\n" }, "unrelated-root");
    await git(checkout, "push", "-q", "origin", "unrelated");
    await git(repoDir, "fetch", "-q", "origin");
    await git(memberWt, "merge", "-q", "--no-edit", "--allow-unrelated-histories", "-X", "ours", "origin/unrelated");

    await expect(measureNetDiff(memberWt, seed, "unrelated")).rejects.toThrow(/refusing to merge unrelated histories/);
  });

  it("measures against the conflicted tree when the seed and main conflict", async () => {
    await commitIn(checkout, { "chunk.txt": "main's version\n" }, "main-edits-chunk-file");
    await advanceMain({ "big.txt": `${"b".repeat(100_000)}\n` });
    await expect(git(memberWt, "merge", "-q", "--no-edit", "origin/main")).rejects.toThrow();
    await commitIn(memberWt, { "chunk.txt": "resolved\n" }, "merge-main");

    const measured = await measure();
    expect(measured.largestFiles.map((file) => file.path)).toEqual(["own.txt", "chunk.txt"]);
    expect(measured.chars).toBeLessThan(ownDiff.length + 1_000);
  });
});
