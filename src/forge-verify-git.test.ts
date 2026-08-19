// realVerifyAdapter's git primitives, against REAL repositories.
//
// These are the calls the rest of the suite fakes out, and the ones whose
// failure modes are defined by git's behaviour rather than by ours: whether a
// sha-to-branch push rejects a non-fast-forward instead of clobbering it,
// whether a failed re-merge leaves a half-merged worktree behind, what git
// actually writes (and to which stream) when a merge conflicts, and how much
// the `--force-with-lease` on the scratch ref really protects. None of that
// can be established by asserting argv — it has to be run.
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
    // GIT_ENV covers the calls THIS file makes; it does not reach the calls the
    // adapter makes. `syncWithSource` runs `git merge` with the ambient
    // environment (unlike merger.ts, which passes GIT_AUTHOR_*/GIT_COMMITTER_*
    // from botName), so it commits with whatever identity the repo can find —
    // which on a bare container or a CI runner is none, and the merge fails
    // with "Committer identity unknown" instead of the conflict/success the
    // test is about. Repo-local, so the file keeps its promise not to depend on
    // the developer's git config.
    await git(work, "config", "user.name", "T");
    await git(work, "config", "user.email", "t@e");
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
    // The actual conflict text, not just "some non-empty string": git writes
    // "CONFLICT (content): …" to STDOUT and leaves stderr empty, so a reason
    // built from stderr alone degrades to "Command failed: git merge …" — and
    // this string is the whole of what an operator sees on a parked cycle.
    // (`toBeTruthy()` could not fail here: pushErrorReason always returns a
    // non-empty string.)
    expect(sync.reason).toContain("CONFLICT");
    expect(sync.reason).toContain("a.txt");
    // Resolved via git rather than assumed at `.git/MERGE_HEAD`: in a linked
    // worktree — which is what the merger actually runs in — the merge state
    // lives under `.git/worktrees/<name>/`, so the naive path is absent either
    // way and would make this assertion pass for the wrong reason.
    expect(existsSync(await git(work, "rev-parse", "--git-path", "MERGE_HEAD"))).toBe(
      false,
    );
    // Still on a usable HEAD, not mid-merge.
    await expect(git(work, "status", "--porcelain")).resolves.not.toContain("UU");
  });
  it("the lease on the scratch ref protects only against a change it cannot see", async () => {
    // Worth running rather than reasoning about, because the argv assertion
    // elsewhere makes this look like a guarantee it is not. The lease is read
    // from ls-remote milliseconds before the push, so it only catches a
    // competing write inside that window. Here the ref is moved right after
    // the read: the push is REJECTED, which is the protection working.
    await commit(work, "b.txt", "two\n");
    await adapter.pushIntegration("sandbar/integration");
    const before = await remoteSha("refs/heads/sandbar/integration");

    // Same real adapter, but a third party moves the ref between the lease
    // read and the push.
    const raced = realVerifyAdapter({
      cwd: work,
      sourceBranch: "main",
      repo: { owner: "o", name: "r" },
      exec: async (file, args, opts) => {
        const out = await exec(file, [...args], opts);
        if (args[0] === "ls-remote") {
          await commit(other, "race.txt", "theirs\n");
          await git(other, "push", "-f", "origin", "HEAD:refs/heads/sandbar/integration");
        }
        return out;
      },
    });
    await commit(work, "c.txt", "three\n");
    const out = await raced.pushIntegration("sandbar/integration");
    expect(out.kind).toBe("rejected");
    // And it did NOT clobber the other write.
    expect(await remoteSha("refs/heads/sandbar/integration")).not.toBe(before);
    expect(await remoteSha("refs/heads/sandbar/integration")).toBe(
      await git(other, "rev-parse", "HEAD"),
    );
  });

  it("force-pushes past a ref that moved BEFORE the lease was read", async () => {
    // The other half of the same fact, and the reason config confines
    // integrationBranch to sandbar's own namespace: anything already on the
    // scratch ref when the round starts is overwritten without complaint.
    await commit(other, "theirs.txt", "theirs\n");
    await git(other, "push", "origin", "HEAD:refs/heads/sandbar/integration");
    const mine = await commit(work, "mine.txt", "mine\n");
    const out = await adapter.pushIntegration("sandbar/integration");
    expect(out.kind).toBe("ok");
    expect(await remoteSha("refs/heads/sandbar/integration")).toBe(mine);
  });
});
