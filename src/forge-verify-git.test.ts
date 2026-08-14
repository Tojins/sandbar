// realVerifyAdapter's git primitives, against REAL repositories.
//
// These are the calls the rest of the suite fakes out, and the ones whose
// failure modes are defined by git's behaviour rather than by ours: whether a
// lease-protected force-push actually protects, whether a sha-to-branch push
// rejects a non-fast-forward instead of clobbering it, and whether a failed
// re-merge leaves a half-merged worktree behind. None of that can be
// established by asserting argv — it has to be run.
//
// Everything happens in a temp dir: a bare repo standing in for origin, and a
// detached worktree standing in for the merger's. No network, no forge.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { realVerifyAdapter } from "./forge-verify.js";

const exec = promisify(execFile);

// Identity + a deterministic default branch, so the tests don't depend on the
// developer's git config.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@e",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

async function commit(cwd: string, file: string, body: string): Promise<string> {
  await writeFile(join(cwd, file), body);
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", `add ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

describe("realVerifyAdapter git primitives (real repos)", () => {
  let root: string;
  let origin: string;
  let work: string; // stands in for the merger worktree
  let other: string; // stands in for a third party pushing to origin
  let adapter: ReturnType<typeof realVerifyAdapter>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-fv-"));
    origin = join(root, "origin.git");
    work = join(root, "work");
    other = join(root, "other");

    await exec("git", ["init", "--bare", "-b", "main", origin], { env: GIT_ENV });
    await exec("git", ["clone", origin, work], { env: GIT_ENV });
    await commit(work, "a.txt", "one\n");
    await git(work, "push", "origin", "HEAD:refs/heads/main");
    // The merger worktree is DETACHED — no branch, no upstream, which is why
    // the implicit --force-with-lease form has nothing to compare against.
    await git(work, "checkout", "--detach");
    await exec("git", ["clone", origin, other], { env: GIT_ENV });

    adapter = realVerifyAdapter({
      cwd: work,
      sourceBranch: "main",
      repo: { owner: "o", name: "r" },
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const remoteSha = async (ref: string): Promise<string> => {
    const out = await git(origin, "rev-parse", ref);
    return out;
  };

  it("creates the integration ref when it does not exist yet", async () => {
    const head = await git(work, "rev-parse", "HEAD");
    const out = await adapter.pushIntegration("sandbar/integration");
    expect(out.kind).toBe("ok");
    expect(await remoteSha("refs/heads/sandbar/integration")).toBe(head);
  });

  it("force-updates the scratch ref on a later round, including over a rewrite", async () => {
    await commit(work, "b.txt", "two\n");
    await adapter.pushIntegration("sandbar/integration");
    // Round 2 rewrites history under the ref (a resolve-loop amend would do
    // this); the scratch ref is sandbar's alone, so it must move anyway.
    const pushed = await remoteSha("refs/heads/sandbar/integration");
    await git(work, "reset", "--hard", "HEAD~1");
    // Different content, so the rewritten sha cannot coincidentally equal the
    // one already on the ref and make this assertion vacuous.
    const rewritten = await commit(work, "c.txt", "three\n");
    expect(rewritten).not.toBe(pushed);
    const out = await adapter.pushIntegration("sandbar/integration");
    expect(out.kind).toBe("ok");
    expect(await remoteSha("refs/heads/sandbar/integration")).toBe(rewritten);
  });

  it("fast-forwards the source branch to the verified sha", async () => {
    const head = await commit(work, "b.txt", "two\n");
    const out = await adapter.fastForwardSource(head);
    expect(out.kind).toBe("ok");
    expect(await remoteSha("refs/heads/main")).toBe(head);
  });

  it("REJECTS — and does not clobber — when origin/main moved underneath", async () => {
    // The routine race: a human pushes during the multi-minute CI wait.
    const mine = await commit(work, "b.txt", "two\n");
    const theirs = await commit(other, "c.txt", "three\n");
    await git(other, "push", "origin", "HEAD:refs/heads/main");

    const out = await adapter.fastForwardSource(mine);
    expect(out.kind).toBe("rejected");
    expect(out.kind === "rejected" && out.reason).toMatch(/non-fast-forward|fetch first|rejected/i);
    // The other party's commit is still the tip: a verified-but-stale sha must
    // never overwrite work that arrived while CI was running.
    expect(await remoteSha("refs/heads/main")).toBe(theirs);
  });

  it("re-merges the moved source tip, after which the fast-forward succeeds", async () => {
    await commit(work, "b.txt", "two\n");
    const theirs = await commit(other, "c.txt", "three\n");
    await git(other, "push", "origin", "HEAD:refs/heads/main");

    expect((await adapter.fastForwardSource(await git(work, "rev-parse", "HEAD"))).kind).toBe(
      "rejected",
    );

    const sync = await adapter.syncWithSource();
    expect(sync.ok).toBe(true);

    const merged = await git(work, "rev-parse", "HEAD");
    // The re-merged result contains both sides...
    expect(await git(work, "merge-base", "--is-ancestor", theirs, merged).then(() => true)).toBe(
      true,
    );
    // ...and now lands. (In the real loop this is re-verified first — the
    // point here is only that the git mechanics work.)
    const out = await adapter.fastForwardSource(merged);
    expect(out.kind).toBe("ok");
    expect(await remoteSha("refs/heads/main")).toBe(merged);
  });

  it("leaves no half-merged worktree when the re-merge conflicts", async () => {
    // Both sides edit the same line; the caller's `git reset --hard <base>`
    // would be operating on an ambiguous state if MERGE_HEAD survived.
    await commit(work, "a.txt", "mine\n");
    await commit(other, "a.txt", "theirs\n");
    await git(other, "push", "origin", "HEAD:refs/heads/main");

    const sync = await adapter.syncWithSource();
    expect(sync.ok).toBe(false);
    expect(sync.reason).toBeTruthy();
    expect(existsSync(join(work, ".git", "MERGE_HEAD"))).toBe(false);
    // Still on a usable HEAD, not mid-merge.
    await expect(git(work, "status", "--porcelain")).resolves.not.toContain("UU");
  });
});
