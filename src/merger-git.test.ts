// realAdapter's git predicates, against REAL repositories — specifically in a
// LINKED WORKTREE, because that is what the merger has run in since #10 and it
// is where the naive filesystem path silently stops working.
//
// `git worktree add` writes a `.git` FILE (a gitlink), not a directory, and
// puts per-worktree state under `<repo>/.git/worktrees/<name>/`. A predicate
// that stats `<cwd>/.git/MERGE_HEAD` therefore returns false forever in
// production while looking correct in any test that uses a plain clone.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { realAdapter, resolveVersionCollision } from "./merger.js";

const exec = promisify(execFile);

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

async function commit(cwd: string, file: string, body: string): Promise<void> {
  await writeFile(join(cwd, file), body);
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", `edit ${file}`);
}

describe("realAdapter.isMergeInProgress (real linked worktree)", () => {
  let root: string;
  let repo: string;
  let wt: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-mg-"));
    repo = join(root, "repo");
    wt = join(root, "wt");
    await exec("git", ["init", "-b", "main", repo], { env: GIT_ENV });
    await commit(repo, "a.txt", "one\n");
    await git(repo, "checkout", "-qb", "side");
    await commit(repo, "a.txt", "side\n");
    await git(repo, "checkout", "-q", "main");
    await commit(repo, "a.txt", "main\n");
    // Exactly how createMergerWorktree sets up: a detached linked worktree.
    await git(repo, "worktree", "add", "--detach", wt, "HEAD");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const adapterAt = (cwd: string) =>
    realAdapter({
      cwd,
      sourceBranch: "main",
      botName: "bot",
      botEmail: "bot@e",
      coauthorTrailer: "",
      mergerModelId: "opus",
      ghOwner: "o",
      ghRepo: "r",
      sandboxImage: "img",
      // These cases exercise only the git primitives; the cast covers the
      // adapter deps they never reach.
    } as unknown as Parameters<typeof realAdapter>[0]);

  it("is false on a clean worktree", async () => {
    expect(await adapterAt(wt).isMergeInProgress()).toBe(false);
  });

  it("accepts abort when no merge is in progress", async () => {
    await adapterAt(wt).abortMerge();
  });

  it("is TRUE mid-conflict, where the naive .git/MERGE_HEAD path reads false", async () => {
    // Deliberately conflicting: both branches rewrote the same line.
    await expect(git(wt, "merge", "--no-ff", "side")).rejects.toThrow();

    expect(await adapterAt(wt).isMergeInProgress()).toBe(true);
    // The bug this replaced, pinned so it cannot come back: the file simply is
    // not there under the worktree's own `.git`, which is a gitlink file.
    const naive = join(wt, ".git", "MERGE_HEAD");
    const { existsSync } = await import("node:fs");
    expect(existsSync(naive)).toBe(false);
  });

  it("goes back to false after the merge is aborted", async () => {
    await expect(git(wt, "merge", "--no-ff", "side")).rejects.toThrow();
    await git(wt, "merge", "--abort");
    expect(await adapterAt(wt).isMergeInProgress()).toBe(false);
  });

  it("still works in a plain (non-worktree) checkout", async () => {
    await expect(git(repo, "merge", "--no-ff", "side")).rejects.toThrow();
    expect(await adapterAt(repo).isMergeInProgress()).toBe(true);
  });

  // #67 — the abandon comment lists the conflicted files, so what "conflicted"
  // means has to be git's answer and not a parse of the porcelain beside it.
  // Asserted by running a real conflicting merge, in a linked worktree, for the
  // same reason isMergeInProgress is.
  it("names the unmerged paths, and only those, while a merge is conflicted", async () => {
    // A second file that merges cleanly, so a digest that simply listed every
    // changed path would be caught.
    await git(repo, "checkout", "-q", "side");
    await commit(repo, "clean.txt", "from side\n");
    await git(repo, "checkout", "-q", "main");
    await git(repo, "worktree", "remove", "--force", wt);
    await git(repo, "worktree", "add", "--detach", wt, "HEAD");

    await expect(git(wt, "merge", "--no-ff", "side")).rejects.toThrow();

    const digest = await adapterAt(wt).conflictDigest();
    expect(digest.paths).toEqual(["a.txt"]);
    expect(digest.status).toContain("a.txt");
  });

  it("names no path at all on a clean tree", async () => {
    expect((await adapterAt(wt).conflictDigest()).paths).toEqual([]);
  });
});

// #60 — the three git primitives the chunk landing rests on, against real
// repositories in the shape production uses: a BARE object cache with
// `+refs/heads/*:refs/remotes/origin/*` configured, a detached linked worktree
// hanging off it, and a bare origin. Every claim in the adapter's comments is a
// claim about git's behaviour in exactly that shape, and none of it is visible
// in a plain clone: a chunk branch is fetched into a repo with no working tree,
// and pushed from a HEAD that is on no branch.
describe("realAdapter chunk primitives (real bare cache + worktree)", () => {
  let root: string;
  let origin: string;
  let seed: string;
  let cache: string;
  let wt: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-chunk-"));
    origin = join(root, "origin.git");
    seed = join(root, "seed");
    cache = join(root, "repo.git");
    wt = join(root, "wt");

    await exec("git", ["init", "--bare", "-b", "main", origin], { env: GIT_ENV });
    await exec("git", ["init", "-b", "main", seed], { env: GIT_ENV });
    await commit(seed, "a.txt", "one\n");
    await git(seed, "remote", "add", "origin", origin);
    await git(seed, "push", "-q", "origin", "main");

    await exec("git", ["clone", "--bare", "--quiet", origin, cache], {
      env: GIT_ENV,
    });
    await git(cache, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await git(cache, "fetch", "origin", "--prune", "--quiet");
    await git(cache, "worktree", "add", "--detach", wt, "origin/main");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const adapter = () =>
    realAdapter({
      cwd: wt,
      sourceBranch: "main",
      botName: "bot",
      botEmail: "bot@e",
      coauthorTrailer: "",
    } as unknown as Parameters<typeof realAdapter>[0]);

  const originHas = async (branch: string): Promise<string | null> =>
    git(origin, "rev-parse", branch).catch(() => null);

  it("bases on origin/<sourceBranch> when origin has no such chunk branch", async () => {
    expect(await adapter().chunkBase("sandbar/chunk-1-c")).toBe("origin/main");
  });

  // #64 — the three answers, and the one git fact that separates two of them:
  // `ls-remote --exit-code` exits 2 for "reached the remote, no matching ref"
  // and something else non-zero for "could not ask". No fake can assert that,
  // and the whole of the landing's `branch-missing` park — a human's `land`
  // label removed and a comment about a deleted branch — rests on it.
  it("says a chunk branch origin does not have is ABSENT", async () => {
    expect(await adapter().fetchChunkRef("sandbar/chunk-1-c")).toEqual({
      kind: "absent",
    });
  });

  it("says PRESENT, and leaves the remote-tracking ref behind, when origin has it", async () => {
    await git(seed, "push", "-q", "origin", "main:refs/heads/sandbar/chunk-1-c");

    const found = await adapter().fetchChunkRef("sandbar/chunk-1-c");

    expect(found).toEqual({
      kind: "present",
      ref: "refs/remotes/origin/sandbar/chunk-1-c",
    });
    expect(
      await git(cache, "rev-parse", "--verify", "refs/remotes/origin/sandbar/chunk-1-c"),
    ).toBeTruthy();
  });

  it("says UNREADABLE — not absent — when origin cannot be reached at all", async () => {
    // The branch is on origin; only the transport is broken, which is what an
    // expired key or a proxy looks like from here. Reading this as "the branch
    // is gone" is a tracker write and a false claim on somebody's pull
    // request.
    await git(seed, "push", "-q", "origin", "main:refs/heads/sandbar/chunk-1-c");
    await git(cache, "remote", "set-url", "origin", join(root, "gone.git"));

    const found = await adapter().fetchChunkRef("sandbar/chunk-1-c");

    expect(found.kind).toBe("unreadable");
    expect(found.kind === "unreadable" && found.detail).toBeTruthy();
  });

  it("still bases an unreachable origin on the source branch, which is safe to be wrong about", async () => {
    // `chunkBase` keeps the collapse the landing refuses: its wrongness is
    // caught by a rejected push, never by a tracker write.
    await git(cache, "remote", "set-url", "origin", join(root, "gone.git"));

    expect(await adapter().chunkBase("sandbar/chunk-1-c")).toBe("origin/main");
  });

  it("bases on origin's chunk branch when it exists, fetching it into the bare cache", async () => {
    await git(seed, "push", "-q", "origin", "main:refs/heads/sandbar/chunk-1-c");

    const base = await adapter().chunkBase("sandbar/chunk-1-c");

    expect(base).toBe("refs/remotes/origin/sandbar/chunk-1-c");
    // The point of the explicit refspec: the remote-tracking ref really is in
    // the cache afterwards, so `checkoutDetached(base)` has something to
    // resolve. A fetch that only wrote FETCH_HEAD would pass the line above
    // and fail here.
    expect(await git(cache, "rev-parse", "--verify", base)).toBeTruthy();
  });

  it("pushes a detached HEAD to a chunk branch, creating it on origin", async () => {
    await commit(wt, "b.txt", "member work\n");
    const head = await git(wt, "rev-parse", "HEAD");

    const r = await adapter().pushChunkBranch("sandbar/chunk-1-c");

    expect(r).toEqual({ kind: "ok" });
    expect(await originHas("refs/heads/sandbar/chunk-1-c")).toBe(head);
  });

  it("fast-forwards the chunk branch when the next member lands on it", async () => {
    await commit(wt, "b.txt", "first member\n");
    await adapter().pushChunkBranch("sandbar/chunk-1-c");
    await commit(wt, "c.txt", "second member\n");
    const head = await git(wt, "rev-parse", "HEAD");

    expect(await adapter().pushChunkBranch("sandbar/chunk-1-c")).toEqual({
      kind: "ok",
    });
    expect(await originHas("refs/heads/sandbar/chunk-1-c")).toBe(head);
  });

  it("reports a race rather than overwriting a chunk branch that moved", async () => {
    // Somebody else's commit is on the branch and this composition is not
    // built on it. A force-push here would drop that member silently.
    await commit(seed, "d.txt", "somebody else\n");
    await git(seed, "push", "-q", "origin", "main:refs/heads/sandbar/chunk-1-c");
    const theirs = (await originHas("refs/heads/sandbar/chunk-1-c"))!;
    await commit(wt, "b.txt", "our work\n");

    expect(await adapter().pushChunkBranch("sandbar/chunk-1-c")).toEqual({
      kind: "race",
    });
    expect(await originHas("refs/heads/sandbar/chunk-1-c")).toBe(theirs);
  });

  it("checks out a ref detached, leaving HEAD on no branch", async () => {
    await git(seed, "push", "-q", "origin", "main:refs/heads/sandbar/chunk-1-c");
    const a = adapter();
    const base = await a.chunkBase("sandbar/chunk-1-c");

    await a.checkoutDetached(base);

    expect(await git(wt, "rev-parse", "HEAD")).toBe(
      await git(cache, "rev-parse", base),
    );
    await expect(git(wt, "symbolic-ref", "HEAD")).rejects.toThrow();
  });

  it("comes back to a sha it was moved away from", async () => {
    // The merge phase's return trip: chunk groups move HEAD, and the
    // source-branch pass must resume on the sha the cycle entered on.
    const entry = await git(wt, "rev-parse", "HEAD");
    await commit(wt, "b.txt", "chunk work\n");
    expect(await git(wt, "rev-parse", "HEAD")).not.toBe(entry);

    await adapter().checkoutDetached(entry);

    expect(await git(wt, "rev-parse", "HEAD")).toBe(entry);
  });
});

// #68 — the version collision, against a real conflicting merge in the shape
// production runs in. What "the version files are the only thing still
// unmerged" and "the merge is committed" mean are git's to define, so the whole
// operation is run rather than described: two branches that each did what
// AGENTS.md requires, merged, and the result inspected.
describe("resolveVersionCollision (real conflicting merge in a linked worktree)", () => {
  let root: string;
  let repo: string;
  let wt: string;

  // Exactly the two files `npm version patch` rewrites, with the lockfile
  // carrying npm's two mirrors of the root version AND a dependency's own
  // `version` line at the same indentation as the second of them.
  const pkg = (v: string): string =>
    [
      "{",
      '  "name": "@offergeist/sandbar",',
      `  "version": "${v}",`,
      '  "type": "module"',
      "}",
      "",
    ].join("\n");

  const lock = (v: string, dep = "4.1.2"): string =>
    [
      "{",
      '  "name": "@offergeist/sandbar",',
      `  "version": "${v}",`,
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "": {',
      '      "name": "@offergeist/sandbar",',
      `      "version": "${v}",`,
      '      "dependencies": {',
      '        "proper-lockfile": "^4.1.2"',
      "      }",
      "    },",
      '    "node_modules/proper-lockfile": {',
      `      "version": "${dep}",`,
      '      "license": "MIT"',
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");

  const bump = async (
    cwd: string,
    v: string,
    extra?: { readonly file: string; readonly body: string },
    dep?: string,
  ): Promise<void> => {
    await writeFile(join(cwd, "package.json"), pkg(v));
    await writeFile(join(cwd, "package-lock.json"), lock(v, dep));
    if (extra) await writeFile(join(cwd, extra.file), extra.body);
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-m", `chore: ${v}`);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-vc-"));
    repo = join(root, "repo");
    wt = join(root, "wt");
    await exec("git", ["init", "-b", "main", repo], { env: GIT_ENV });
    await bump(repo, "0.20.33");
    await git(repo, "checkout", "-qb", "side");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const adapterAt = (cwd: string) =>
    realAdapter({
      cwd,
      sourceBranch: "main",
      botName: "bot",
      botEmail: "bot@e",
      coauthorTrailer: "Co-authored-by: Claude <noreply@anthropic.com>",
      mergerModelId: "opus",
      ghOwner: "o",
      ghRepo: "r",
      sandboxImage: "img",
    } as unknown as Parameters<typeof realAdapter>[0]);

  // Both branches did what AGENTS.md requires, from the same base.
  const collide = async (extra?: {
    readonly ours?: { readonly file: string; readonly body: string };
    readonly theirs?: { readonly file: string; readonly body: string };
    readonly ourDep?: string;
    readonly theirDep?: string;
  }): Promise<ReturnType<typeof adapterAt>> => {
    await bump(repo, "0.20.34", extra?.theirs, extra?.theirDep);
    await git(repo, "checkout", "-q", "main");
    await bump(repo, "0.20.35", extra?.ours, extra?.ourDep);
    await git(repo, "worktree", "add", "--detach", wt, "HEAD");
    const a = adapterAt(wt);
    expect(await a.mergeNoFf({ id: "42", title: "t", branch: "side" })).toEqual({
      ok: false,
    });
    return a;
  };

  const lines: string[] = [];
  const emit = async (l: string): Promise<void> => {
    lines.push(l);
  };

  it("resolves the whole conflict, commits the merge, and leaves a clean tree", async () => {
    const a = await collide();
    lines.length = 0;

    expect(await resolveVersionCollision(a, emit, "#42")).toBe("completed");

    expect(await git(wt, "status", "--porcelain")).toBe("");
    expect(await a.unmergedPaths()).toEqual([]);
    // A real merge commit, not a fast-forward or a plain commit.
    expect((await git(wt, "rev-list", "--parents", "-n", "1", "HEAD")).split(" ")).toHaveLength(3);
  });

  it("lands a version greater than BOTH parents', which neither of them carried", async () => {
    const a = await collide();
    await resolveVersionCollision(a, emit, "#42");

    const version = (rev: string): Promise<string> =>
      git(wt, "show", `${rev}:package.json`).then(
        (s) => (JSON.parse(s) as { version: string }).version,
      );
    expect(await version("HEAD^1")).toBe("0.20.35");
    expect(await version("HEAD^2")).toBe("0.20.34");
    expect(await version("HEAD")).toBe("0.20.36");
  });

  it("moves both of npm's lockfile mirrors and no dependency's version", async () => {
    const a = await collide();
    await resolveVersionCollision(a, emit, "#42");

    const merged = JSON.parse(
      await git(wt, "show", "HEAD:package-lock.json"),
    ) as {
      version: string;
      packages: Record<string, { version: string }>;
    };
    expect(merged.version).toBe("0.20.36");
    expect(merged.packages[""]?.version).toBe("0.20.36");
    expect(merged.packages["node_modules/proper-lockfile"]?.version).toBe("4.1.2");
  });

  it("keeps the merge subject and the co-author trailer, and drops git's `# Conflicts:` block", async () => {
    const a = await collide();
    await resolveVersionCollision(a, emit, "#42");

    const message = await git(wt, "log", "-1", "--format=%B");
    expect(message).toContain("Merge sandbar/issue-42: t");
    expect(message).toContain("Co-authored-by: Claude <noreply@anthropic.com>");
    // `git commit --no-edit` keeps comment lines unless cleanup says otherwise.
    expect(message).not.toContain("# Conflicts:");
  });

  it("stages the version files and hands the rest to the agent when a real conflict remains", async () => {
    const a = await collide({
      ours: { file: "src.txt", body: "ours\n" },
      theirs: { file: "src.txt", body: "theirs\n" },
    });
    lines.length = 0;

    expect(await resolveVersionCollision(a, emit, "#42")).toBe("partial");

    expect(await a.unmergedPaths()).toEqual(["src.txt"]);
    expect(await a.isMergeInProgress()).toBe(true);
    // The version files are resolved and staged, so the agent is only asked
    // about the file that needs judgement.
    const staged = await git(wt, "diff", "--name-only", "--cached");
    expect(staged.split("\n")).toContain("package.json");
    expect(staged.split("\n")).toContain("package-lock.json");
    expect(
      (JSON.parse(await git(wt, "show", ":package.json")) as { version: string })
        .version,
    ).toBe("0.20.36");
  });

  it("decides PER FILE: resolves package.json, leaves a lockfile whose DEPENDENCY version conflicted", async () => {
    const a = await collide({ ourDep: "4.1.3", theirDep: "4.1.4" });
    lines.length = 0;

    expect(await resolveVersionCollision(a, emit, "#42")).toBe("partial");

    // package.json was a pure version collision and is resolved and staged;
    // the lockfile carries a real dependency conflict and is untouched, markers
    // and all, so the agent sees exactly what git left.
    expect(await a.unmergedPaths()).toEqual(["package-lock.json"]);
    expect(await a.readWorktreeFile("package-lock.json")).toContain("<<<<<<<");
    expect(
      (JSON.parse(await git(wt, "show", ":package.json")) as { version: string })
        .version,
    ).toBe("0.20.36");
    expect(
      lines.some((l) =>
        l.includes(
          "package-lock.json left to the resolve agent: the conflict also touches",
        ),
      ),
    ).toBe(true);
  });

  it("resolves nothing when a dependency alone conflicted, and names the file it left", async () => {
    // Only the dependency moved, on both sides: there is no version collision
    // here, and the mechanical path must not invent one.
    await writeFile(join(repo, "package-lock.json"), lock("0.20.33", "4.1.3"));
    await git(repo, "commit", "-am", "dep on side");
    await git(repo, "checkout", "-q", "main");
    await writeFile(join(repo, "package-lock.json"), lock("0.20.33", "4.1.4"));
    await git(repo, "commit", "-am", "dep on main");
    await git(repo, "worktree", "add", "--detach", wt, "HEAD");
    const a = adapterAt(wt);
    expect(await a.mergeNoFf({ id: "42", title: "t", branch: "side" })).toEqual({
      ok: false,
    });
    lines.length = 0;

    expect(await resolveVersionCollision(a, emit, "#42")).toBe("none");

    expect(await a.unmergedPaths()).toEqual(["package-lock.json"]);
    expect(await a.readWorktreeFile("package-lock.json")).toContain("<<<<<<<");
    expect(await a.isMergeInProgress()).toBe(true);
    // Nothing resolved, nothing committed — and the log still says which file
    // was looked at and why it was left, which is the question a human reading
    // a spent resolve attempt is asking.
    expect(lines).toEqual([
      "version-collision #42 package-lock.json left to the resolve agent: " +
        "the conflict also touches packages.node_modules/proper-lockfile.version",
    ]);
  });
});
