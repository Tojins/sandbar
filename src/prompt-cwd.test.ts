// #34, #38 — the two anchor layers shell out, and each of them has named the
// wrong thing at some point.
//
// This is the layer where a wrong source is hardest to notice: the project
// anchor quotes recent history, the issue anchor quotes the tracker, and the
// agent has no way to sanity-check either. A prompt built against the launch
// directory reads exactly like this repo with a stale checkout.
//
// Three sources, three different questions, and the tests below pin each
// against the OTHER two failing to supply it:
//
//   repo           the tracker. NAMED via `--repo <owner>/<name>` rather than
//                  inferred by `gh` from a directory's remotes — it was
//                  `process.cwd()` before #34 and the cache's `origin` after
//                  it, neither of which is `ghOwner`/`ghRepo`.
//   repoDir        the bare cache, where the `git log` runs. Stays the repo
//                  even for the reviewer, whose worktree is its SUBJECT:
//                  sourcing history from it would make the anchor a function
//                  of the branch under review.
//   probeWorktree  the tree the emitted @refs are RESOLVED in. This one is
//                  supposed to be a function of the branch, and was the last
//                  to be got right: #38 pointed it at `worktrees/source`, a
//                  clean tree at `origin/<sourceBranch>`, which is what an
//                  issue worktree seeds from and stops being the moment the
//                  branch adds a doc.
//
// Asserted through the real shell-outs — real git repos for the history, a `gh`
// shim on PATH for the tracker — with `process.cwd()` pointed at a different
// repo throughout, since a test that stands where it points passes just as
// happily with the fix deleted.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sourceBranchBase } from "./git-ops.js";
import {
  buildPrompt,
  buildProjectAnchor,
  buildReviewerPrompt,
  buildReviewerFollowupPrompt,
} from "./prompt.js";

const exec = promisify(execFile);

const git = (repo: string, ...args: string[]) =>
  exec("git", args, { cwd: repo });

const CONFIGURED = { owner: "acme", name: "app" };

// A self-remote, so `origin/main` resolves without a network — the anchor asks
// for `origin/<sourceBranch>` since #38, because the cache deliberately keeps
// no local copy of the source branch. `origin` is then RETARGETED at a URL
// naming a different GitHub repo, so a `gh` that inferred its repository from
// this directory would infer a wrong one rather than nothing.
async function seedRepo(prefix: string, subject: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "t@t");
  await git(repo, "config", "user.name", "t");
  await writeFile(join(repo, "a.txt"), "a\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", subject);
  await git(repo, "remote", "add", "origin", repo);
  await git(repo, "fetch", "-q", "origin");
  await git(repo, "remote", "set-url", "origin", "https://github.com/other/wrong.git");
  return repo;
}

describe("prompt anchors name their sources (#34, #38)", () => {
  let launchedFrom: string;
  let target: string;
  let shimBin: string;
  let originalCwd: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    launchedFrom = await seedRepo("sandbar-launch-", "commit-from-launch-dir");
    target = await seedRepo("sandbar-target-", "commit-from-target-repo");
    // `launchedFrom` doubles as the tree under review below, and a reviewer
    // prompt over an empty `origin/main..HEAD` is refused outright (#40) — the
    // loop only ever reaches a reviewer on committed work. So put a commit on
    // it. The subject is deliberately not either seed's, so the "whose history
    // is this" assertions keep testing what they were written to test.
    await writeFile(join(launchedFrom, "work.txt"), "branch work\n");
    await git(launchedFrom, "add", "-A");
    await git(launchedFrom, "commit", "-qm", "commit-under-review");
    process.chdir(launchedFrom);

    shimBin = await mkdtemp(join(tmpdir(), "sandbar-shim-"));
    // Echoes the repository this invocation resolved as the issue title: the
    // `--repo` value when given one, otherwise the working directory's
    // `origin` — modelling what real gh does, so the different-origin repos
    // below are load-bearing rather than decoration.
    await writeFile(
      join(shimBin, "gh"),
      [
        "#!/bin/sh",
        'seen=""',
        "while [ $# -gt 0 ]; do",
        '  case "$1" in --repo) seen="$2"; shift 2 ;; *) shift ;; esac',
        "done",
        "# No --repo: resolve the repository the way gh itself does, from the",
        "# remotes of the working directory. That is what makes the",
        "# different-origin repo below load-bearing rather than decoration —",
        "# delete the flag and the assertion sees `other/wrong`, not a sentinel",
        "# this file made up.",
        "#",
        "# Parameter expansion rather than sed: the obvious `sed \"s#\\.git$##\"`",
        "# has a `$#` in it, which the shell expands to the argument count",
        "# INSIDE double quotes, so the whole expression silently matched",
        "# nothing and the fallback resolved to an empty string — a shim that",
        "# reports no repository is exactly the vacuous sentinel this replaced.",
        'if [ -z "$seen" ]; then',
        "  url=$(git config --get remote.origin.url 2>/dev/null)",
        '  if [ -z "$url" ]; then',
        '    seen="(no-remote)"',
        "  else",
        "    url=${url%.git}",
        "    repo=${url##*[:/]}",
        "    rest=${url%/*}",
        "    owner=${rest##*[:/]}",
        '    seen="$owner/$repo"',
        "  fi",
        "fi",
        'printf \'{"title":"%s","body":"body","comments":[]}\' "$seen"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    originalPath = process.env["PATH"];
    process.env["PATH"] = `${shimBin}:${originalPath ?? ""}`;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    await rm(launchedFrom, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    await rm(shimBin, { recursive: true, force: true });
  });

  it("quotes the named repo's recent history", async () => {
    const anchor = await buildProjectAnchor(
      {
        repo: CONFIGURED,
        repoDir: target,
        claudeMdPath: "CLAUDE.md",
        sourceBranch: "main",
      },
      target,
    );

    expect(anchor).toContain("commit-from-target-repo");
    expect(anchor).not.toContain("commit-from-launch-dir");
  });

  it("fetches the issue from the configured repo, not from any directory's remotes", async () => {
    const prompt = await buildPrompt(
      {
        issue: { id: "1", title: "t", branch: "sandbar/issue-1-t" },
        attempt: 1,
        maxAttempts: 8,
        worktreePath: target,
        lastFailureTrace: "",
        base: sourceBranchBase("main"),
      },
      {
        repo: CONFIGURED,
        repoDir: target,
        probeWorktree: target,
        claudeMdPath: "CLAUDE.md",
        sourceBranch: "main",
      },
    );

    expect(prompt).toContain("Issue #1: acme/app");
    // What the shim resolves on its own. Drop `--repo` and this is the anchor.
    expect(prompt).not.toContain("other/wrong");
  });

  // The @refs the agent resolves inside its sandbox stay repo-relative; it is
  // the host-side existence probe that has to name the tree. Both directions
  // are silent, which is why both are asserted.
  it("probes the anchor docs in the tree the agent will read", async () => {
    await writeFile(join(target, "CONTEXT.md"), "# ctx\n");

    const anchor = await buildProjectAnchor(
      {
        repo: CONFIGURED,
        repoDir: target,
        claudeMdPath: "CLAUDE.md",
        contextMdPath: "CONTEXT.md",
        sourceBranch: "main",
      },
      target,
    );

    expect(anchor).toContain("Context: @CONTEXT.md");
  });

  it("does not hand the agent a dead @ref for a doc that only exists elsewhere", async () => {
    await writeFile(join(launchedFrom, "CONTEXT.md"), "# ctx\n");

    const anchor = await buildProjectAnchor(
      {
        repo: CONFIGURED,
        repoDir: target,
        claudeMdPath: "CLAUDE.md",
        contextMdPath: "CONTEXT.md",
        sourceBranch: "main",
      },
      target,
    );

    expect(anchor).not.toContain("Context: @CONTEXT.md");
  });

  it("lists the ADRs of the probed tree", async () => {
    await mkdir(join(target, "docs", "adr"), { recursive: true });
    await writeFile(join(target, "docs", "adr", "0001-target.md"), "x\n");
    await mkdir(join(launchedFrom, "docs", "adr"), { recursive: true });
    await writeFile(join(launchedFrom, "docs", "adr", "0002-launch.md"), "x\n");

    const anchor = await buildProjectAnchor(
      {
        repo: CONFIGURED,
        repoDir: target,
        claudeMdPath: "CLAUDE.md",
        adrDir: "docs/adr",
        sourceBranch: "main",
      },
      target,
    );

    expect(anchor).toContain("0001-target.md");
    expect(anchor).not.toContain("0002-launch.md");
  });

  // The probe and the resolver must be the SAME tree. `worktreePath` is where
  // the reviewer resolves an @ref, so a doc that exists only there — the shape
  // of "the issue is: add CODING_STANDARDS.md" — has to be found. Probed
  // against `repoDir` (as it was until #38) or against a source tree at
  // `origin/<sourceBranch>` (as it was after), this drops the @ref and the
  // reviewer judges the commit without the standards that commit authored.
  it("points the reviewer at standards the BRANCH adds", async () => {
    await writeFile(join(launchedFrom, "CODING_STANDARDS.md"), "# std\n");

    const prompt = await buildReviewerFollowupPrompt({
      issue: { id: "1", title: "t", branch: "sandbar/issue-1-t" },
      repo: CONFIGURED,
      repoDir: target,
      worktreePath: launchedFrom,
      sourceBranch: "main",
      base: sourceBranchBase("main"),
      claudeMdPath: "CLAUDE.md",
      codingStandardsPath: "CODING_STANDARDS.md",
    });

    expect(prompt).toContain("@CODING_STANDARDS.md");
  });

  it("drops the standards @ref when the branch does not have the file", async () => {
    // Present in the repo the history comes from, absent from the tree under
    // review — so probing the wrong one emits an @ref the reviewer cannot open.
    await writeFile(join(target, "CODING_STANDARDS.md"), "# std\n");

    const prompt = await buildReviewerFollowupPrompt({
      issue: { id: "1", title: "t", branch: "sandbar/issue-1-t" },
      repo: CONFIGURED,
      repoDir: target,
      worktreePath: launchedFrom,
      sourceBranch: "main",
      base: sourceBranchBase("main"),
      claudeMdPath: "CLAUDE.md",
      codingStandardsPath: "CODING_STANDARDS.md",
    });

    expect(prompt).not.toContain("@CODING_STANDARDS.md");
  });

  // History is the half that must NOT follow the branch.
  it("builds the reviewer's history from the repo, not from the worktree under review", async () => {
    const prompt = await buildReviewerPrompt({
      issue: { id: "1", title: "t", branch: "sandbar/issue-1-t" },
      repo: CONFIGURED,
      repoDir: target,
      worktreePath: launchedFrom,
      sourceBranch: "main",
      base: sourceBranchBase("main"),
      claudeMdPath: "CLAUDE.md",
    });

    expect(prompt).toContain("commit-from-target-repo");
    expect(prompt).not.toContain("commit-from-launch-dir");
    expect(prompt).toContain("Issue #1: acme/app");
  });

  // The probe tree and the history repo are genuinely separate inputs, not one
  // value spelled twice. Each half is checked against the other directory
  // failing to supply it.
  it("probes the given tree while reading history from the given repo", async () => {
    await writeFile(join(launchedFrom, "CONTEXT.md"), "# ctx\n");

    const anchor = await buildProjectAnchor(
      {
        repo: CONFIGURED,
        repoDir: target,
        claudeMdPath: "CLAUDE.md",
        contextMdPath: "CONTEXT.md",
        sourceBranch: "main",
      },
      launchedFrom,
    );

    // The doc came from the probed tree...
    expect(anchor).toContain("Context: @CONTEXT.md");
    // ...and the history from the repo, which does not have that doc.
    expect(anchor).toContain("commit-from-target-repo");
    expect(anchor).not.toContain("commit-from-launch-dir");
  });
});
