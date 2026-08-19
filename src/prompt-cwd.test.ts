// #34, #38 — the two anchor layers shell out, and both were doing it in
// `process.cwd()`.
//
// This is the layer where a wrong repo is hardest to notice: the project anchor
// quotes recent history and the issue anchor quotes the tracker, and the agent
// has no way to sanity-check either. A prompt built against the launch
// directory reads exactly like this repo with a stale checkout.
//
// Both are asserted through their real shell-out — a real git repo for the
// history, a `gh` shim on PATH that echoes its own working directory for the
// tracker — with `process.cwd()` pointed at a different repo throughout.
//
// #38 split the one `cwd` in two, because the anchor asks two different
// questions of two different places: `repoDir` (the bare cache) answers the
// `git log` and the `gh issue view`, and `sourceWorktree` (a tree at
// `origin/<sourceBranch>`) answers "does this doc exist" — a bare repo has no
// files to probe, and the operator's checkout has their uncommitted edits in
// it. The last case here pins that they really are separate.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPrompt,
  buildProjectAnchor,
  buildReviewerPrompt,
} from "./prompt.js";

const exec = promisify(execFile);

const git = (repo: string, ...args: string[]) =>
  exec("git", args, { cwd: repo });

// A self-remote, so `origin/main` resolves without a network — the anchor asks
// for `origin/<sourceBranch>` since #38, because the cache deliberately keeps
// no local copy of the source branch.
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
  return repo;
}

describe("prompt anchors are built from the configured repo (#34, #38)", () => {
  let launchedFrom: string;
  let target: string;
  let shimBin: string;
  let originalCwd: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    launchedFrom = await seedRepo("sandbar-launch-", "commit-from-launch-dir");
    target = await seedRepo("sandbar-target-", "commit-from-target-repo");
    process.chdir(launchedFrom);

    shimBin = await mkdtemp(join(tmpdir(), "sandbar-shim-"));
    await writeFile(
      join(shimBin, "gh"),
      '#!/bin/sh\nprintf \'{"title":"%s","body":"body","comments":[]}\' "$PWD"\n',
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

  it("quotes the configured repo's recent history", async () => {
    const anchor = await buildProjectAnchor({
      repoDir: target,
      sourceWorktree: target,
      claudeMdPath: "CLAUDE.md",
      sourceBranch: "main",
    });

    expect(anchor).toContain("commit-from-target-repo");
    expect(anchor).not.toContain("commit-from-launch-dir");
  });

  it("fetches the issue from the configured repo's tracker", async () => {
    const prompt = await buildPrompt(
      {
        issue: { id: "1", title: "t", branch: "sandbar/issue-1-t" },
        attempt: 1,
        maxAttempts: 8,
        worktreePath: target,
        lastFailureTrace: "",
        sourceBranch: "main",
      },
      {
        repoDir: target,
        sourceWorktree: target,
        claudeMdPath: "CLAUDE.md",
        sourceBranch: "main",
      },
    );

    expect(prompt).toContain(realpathSync(target));
    expect(prompt).not.toContain(realpathSync(launchedFrom));
  });

  // The @refs the agent resolves inside its sandbox stay repo-relative; it is
  // the host-side existence probe that has to name the repo. Both directions
  // are silent, which is why both are asserted.
  it("probes the anchor docs in the configured repo", async () => {
    await writeFile(join(target, "CONTEXT.md"), "# ctx\n");

    const anchor = await buildProjectAnchor({
      repoDir: target,
      sourceWorktree: target,
      claudeMdPath: "CLAUDE.md",
      contextMdPath: "CONTEXT.md",
      sourceBranch: "main",
    });

    expect(anchor).toContain("Context: @CONTEXT.md");
  });

  it("does not hand the agent a dead @ref for a doc that only exists in the launch directory", async () => {
    await writeFile(join(launchedFrom, "CONTEXT.md"), "# ctx\n");

    const anchor = await buildProjectAnchor({
      repoDir: target,
      sourceWorktree: target,
      claudeMdPath: "CLAUDE.md",
      contextMdPath: "CONTEXT.md",
      sourceBranch: "main",
    });

    expect(anchor).not.toContain("Context: @CONTEXT.md");
  });

  it("lists the ADRs of the configured repo", async () => {
    await mkdir(join(target, "docs", "adr"), { recursive: true });
    await writeFile(join(target, "docs", "adr", "0001-target.md"), "x\n");
    await mkdir(join(launchedFrom, "docs", "adr"), { recursive: true });
    await writeFile(join(launchedFrom, "docs", "adr", "0002-launch.md"), "x\n");

    const anchor = await buildProjectAnchor({
      repoDir: target,
      sourceWorktree: target,
      claudeMdPath: "CLAUDE.md",
      adrDir: "docs/adr",
      sourceBranch: "main",
    });

    expect(anchor).toContain("0001-target.md");
    expect(anchor).not.toContain("0002-launch.md");
  });

  it("points the reviewer at project standards that exist in the configured repo", async () => {
    await writeFile(join(target, "CODING_STANDARDS.md"), "# std\n");

    const prompt = await buildReviewerPrompt({
      issue: { id: "1", title: "t", branch: "sandbar/issue-1-t" },
      repoDir: target,
      sourceWorktree: target,
      worktreePath: target,
      sourceBranch: "main",
      claudeMdPath: "CLAUDE.md",
      codingStandardsPath: "CODING_STANDARDS.md",
    });

    expect(prompt).toContain("@CODING_STANDARDS.md");
  });

  // The reviewer's anchors come from the configured repo, NOT from
  // `worktreePath`. The two are the same repo and would answer identically, but
  // the worktree is the reviewer's subject: sourcing the project anchor from it
  // would make the standard the branch is judged against a function of the
  // branch.
  it("builds the reviewer's anchors from the repo, not from the worktree under review", async () => {
    const prompt = await buildReviewerPrompt({
      issue: { id: "1", title: "t", branch: "sandbar/issue-1-t" },
      repoDir: target,
      sourceWorktree: target,
      worktreePath: launchedFrom,
      sourceBranch: "main",
      claudeMdPath: "CLAUDE.md",
    });

    expect(prompt).toContain("commit-from-target-repo");
    expect(prompt).not.toContain("commit-from-launch-dir");
    expect(prompt).toContain(realpathSync(target));
  });

  // #38: the two are genuinely separate inputs, not one value spelled twice.
  // Pointed at a bare repo the probe would find nothing and every optional doc
  // would silently vanish from the prompt; pointed at a tree with no refs the
  // history would silently become "(unavailable)". Each half is checked against
  // the OTHER directory failing to supply it.
  it("probes docs in the source worktree while reading history from the repo", async () => {
    await writeFile(join(launchedFrom, "CONTEXT.md"), "# ctx\n");

    const anchor = await buildProjectAnchor({
      repoDir: target,
      sourceWorktree: launchedFrom,
      claudeMdPath: "CLAUDE.md",
      contextMdPath: "CONTEXT.md",
      sourceBranch: "main",
    });

    // The doc came from the source worktree...
    expect(anchor).toContain("Context: @CONTEXT.md");
    // ...and the history from the repo, which does not have that doc.
    expect(anchor).toContain("commit-from-target-repo");
    expect(anchor).not.toContain("commit-from-launch-dir");
  });
});
