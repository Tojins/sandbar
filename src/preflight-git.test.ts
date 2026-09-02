// #34 + #38 — preflight's verdict, and its one destructive step, are about a
// NAMED repo, and since #38 that repo is sandbar's bare cache rather than
// anything a human stands in.
//
// Asserted against two real repos with `process.cwd()` pointed at the WRONG
// one. That arrangement is the whole test: `DEFAULT_CWD()` is `process.cwd()`,
// so on every host that does not set `config.cwd` the two coincide and a test
// that lets them coincide passes just as happily with the threading deleted
// again. Real git, not a fake exec, because the assertions are about refs that
// did or did not move.
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentProviderName } from "./agent-providers.js";
import { makeEnvReader } from "./env.js";
import {
  type DeclaredMount,
  deleteMergedSandbarBranches,
  gatherState,
  PreflightError,
  readConfigStaleness,
  runPreflight,
  which,
} from "./preflight.js";
import { type RepoLayout, ensureRepoCache, repoLayout } from "./repo-cache.js";

const exec = promisify(execFile);

const git = (repo: string, ...args: string[]) =>
  exec("git", args, { cwd: repo });

const hasBranch = async (repo: string, branch: string): Promise<boolean> =>
  exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repo,
  }).then(
    () => true,
    () => false,
  );

// A repo on `main` with one commit and a self-remote, so `origin/main` exists
// without a network.
async function seedRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "t@t");
  await git(repo, "config", "user.name", "t");
  await writeFile(join(repo, "a.txt"), "a\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "init");
  await git(repo, "remote", "add", "origin", repo);
  await git(repo, "fetch", "-q", "origin");
  return repo;
}

describe("preflight operates on the named repo, not process.cwd() (#34, #38)", () => {
  let launchedFrom: string;
  let target: string;
  let originalCwd: string;
  let originalPath: string | undefined;
  let shimBin: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    launchedFrom = await seedRepo("sandbar-launch-");
    target = await seedRepo("sandbar-target-");
    process.chdir(launchedFrom);

    // A `gh` whose host auth and listing reads answer the factual state these
    // git-focused tests need. Operational listing failures propagate since
    // #99, so the fixture must not use one as shorthand for an empty tracker.
    shimBin = await mkdtemp(join(tmpdir(), "sandbar-shim-"));
    await writeFile(
      join(shimBin, "gh"),
      [
        "#!/bin/sh",
        'if [ "$1 $2" = "auth status" ]; then exit 0; fi',
        'if [ "$1 $2" = "issue list" ]; then printf "[]"; exit 0; fi',
        'if [ "$1 $2" = "api graphql" ]; then',
        '  printf \'{"data":{"repository":{"i7":{"state":"CLOSED","labels":{"nodes":[]}}}}}\'',
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
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

  // A layout that names `repoDir` directly, so these cases can point preflight
  // at an ordinary repo and read its refs afterwards. The cache-shaped case is
  // the separate describe below, where the point is that the two directories
  // are DIFFERENT rather than that either is bare.
  const layoutAt = (repoDir: string, hostCwd = repoDir): RepoLayout => ({
    ...repoLayout(hostCwd, ".sandbar"),
    repoDir,
  });

  const cfg = (layout: RepoLayout) => ({
    layout,
    repo: { owner: "acme", name: "app" },
    env: makeEnvReader({}),
    sourceBranch: "main",
    pulledImages: [] as readonly string[],
    mountSources: [] as readonly DeclaredMount[],
    configPath: null,
    // The default routing (#72): claude for both roles, and claude for the
    // merger, so the set the credential check walks is the one every
    // pre-#72 config produces.
    agentProviders: ["claude"] as readonly AgentProviderName[],
  });

  // The highest-stakes half, and the one that qualified #32's fix: #32 put this
  // delete under the single-instance lock, and the lock is taken on
  // `config.cwd` — so a delete running in `process.cwd()` was under *a* lock,
  // just not the one covering the repo whose branches it destroyed.
  describe("deleteMergedSandbarBranches", () => {
    beforeEach(async () => {
      for (const repo of [launchedFrom, target]) {
        await git(repo, "branch", "sandbar/issue-1-merged");
      }
    });

    it("deletes the merged branch in the named repo", async () => {
      const deleted = await deleteMergedSandbarBranches(cfg(layoutAt(target)));

      expect(deleted).toEqual(["sandbar/issue-1-merged"]);
      expect(await hasBranch(target, "sandbar/issue-1-merged")).toBe(false);
    });

    it("does not touch the identically-named branch in the launch directory", async () => {
      await deleteMergedSandbarBranches(cfg(layoutAt(target)));

      expect(await hasBranch(launchedFrom, "sandbar/issue-1-merged")).toBe(true);
    });

    // The converse, so the pair cannot both pass by the two repos agreeing.
    // The chdir is the whole point: pointing config at `launchedFrom` while
    // ALSO standing in it is the coinciding arrangement this file exists to
    // avoid, and a test written that way passes with the fix deleted. So stand
    // in `target` and delete in `launchedFrom` — the mirror image of the pair
    // above, wrong in the opposite direction if the cwd is ignored.
    it("deletes in whichever repo it is pointed at", async () => {
      process.chdir(target);

      await deleteMergedSandbarBranches(cfg(layoutAt(launchedFrom)));

      expect(await hasBranch(launchedFrom, "sandbar/issue-1-merged")).toBe(false);
      expect(await hasBranch(target, "sandbar/issue-1-merged")).toBe(true);
    });

    // Behaviour, not a cwd pin — this one passes either way, and is here to
    // stop the cwd threading being "fixed" by deleting the merged-ness check.
    it("leaves an unmerged branch alone", async () => {
      await git(target, "checkout", "-q", "-b", "sandbar/issue-2-unmerged");
      await git(target, "commit", "-q", "--allow-empty", "-m", "work");
      await git(target, "checkout", "-q", "main");

      const deleted = await deleteMergedSandbarBranches(cfg(layoutAt(target)));

      expect(deleted).toEqual(["sandbar/issue-1-merged"]);
      expect(await hasBranch(target, "sandbar/issue-2-unmerged")).toBe(true);
    });

    // #58's second branch shape, and the one thing about a chunk branch that
    // does not wait on the lifecycle #54 still owes it: commits reachable from
    // the source branch have said everything they had to say, whether one issue
    // wrote them or a whole chunk did.
    it("deletes a merged chunk branch too", async () => {
      await git(target, "branch", "sandbar/chunk-5-review-series");

      const deleted = await deleteMergedSandbarBranches(cfg(layoutAt(target)));

      expect([...deleted].sort()).toEqual([
        "sandbar/chunk-5-review-series",
        "sandbar/issue-1-merged",
      ]);
      expect(await hasBranch(target, "sandbar/chunk-5-review-series")).toBe(false);
    });

    // #60 — the second ground for deleting an issue branch, and the crash
    // window it exists for: a run that died between the chunk push and the
    // label flip, or a flip whose delete failed, leaves a member's issue branch
    // behind. Nothing will ever pick it up again (the planner drops `in-chunk`
    // issues), so left alone it is one dead ref per member a chunk ever landed.
    //
    // The set-up is what the merger produces: a member's commits on a branch
    // that is NOT on main, and origin's chunk branch carrying them.
    const landMemberOnChunk = async (): Promise<void> => {
      await git(target, "checkout", "-q", "-b", "sandbar/issue-7-member");
      await git(target, "commit", "-q", "--allow-empty", "-m", "member work");
      const { stdout } = await git(target, "rev-parse", "HEAD");
      await git(target, "checkout", "-q", "main");
      await git(
        target,
        "update-ref",
        "refs/remotes/origin/sandbar/chunk-7-c",
        stdout.trim(),
      );
    };

    it("deletes an `in-chunk` member's branch once origin's chunk branch carries it", async () => {
      await landMemberOnChunk();

      const deleted = await deleteMergedSandbarBranches({
        ...cfg(layoutAt(target)),
        inChunkIssues: new Set([7]),
      });

      expect([...deleted].sort()).toEqual([
        "sandbar/issue-1-merged",
        "sandbar/issue-7-member",
      ]);
    });

    it("keeps it when the issue is not `in-chunk`, whatever origin carries", async () => {
      // The label is the claim that the landing happened; without it this is
      // an ordinary in-flight branch and deleting it would discard live work.
      await landMemberOnChunk();

      const deleted = await deleteMergedSandbarBranches(cfg(layoutAt(target)));

      expect(deleted).toEqual(["sandbar/issue-1-merged"]);
      expect(await hasBranch(target, "sandbar/issue-7-member")).toBe(true);
    });

    it("keeps it when no chunk branch on origin actually carries the commits", async () => {
      // The label alone is a previous run's word for it. Ancestry is this
      // run's verification, and without it nothing is force-deleted.
      await git(target, "checkout", "-q", "-b", "sandbar/issue-7-member");
      await git(target, "commit", "-q", "--allow-empty", "-m", "member work");
      await git(target, "checkout", "-q", "main");

      const deleted = await deleteMergedSandbarBranches({
        ...cfg(layoutAt(target)),
        inChunkIssues: new Set([7]),
      });

      expect(deleted).toEqual(["sandbar/issue-1-merged"]);
      expect(await hasBranch(target, "sandbar/issue-7-member")).toBe(true);
    });

    it("never reaps a chunk branch on that ground — every one contains itself", async () => {
      // `sandbar/chunk-7-c` is trivially reachable from origin's copy of
      // itself, so a containment check that did not insist on the ISSUE shape
      // would delete the review artifact the moment its first member landed.
      await git(target, "checkout", "-q", "-b", "sandbar/chunk-7-c");
      await git(target, "commit", "-q", "--allow-empty", "-m", "chunk work");
      const { stdout } = await git(target, "rev-parse", "HEAD");
      await git(target, "checkout", "-q", "main");
      await git(
        target,
        "update-ref",
        "refs/remotes/origin/sandbar/chunk-7-c",
        stdout.trim(),
      );

      const deleted = await deleteMergedSandbarBranches({
        ...cfg(layoutAt(target)),
        inChunkIssues: new Set([7]),
      });

      expect(deleted).toEqual(["sandbar/issue-1-merged"]);
      expect(await hasBranch(target, "sandbar/chunk-7-c")).toBe(true);
    });
  });

  // #38 item 3, stated as the thing it protects rather than as a path. `cwd`
  // stopped being a dedicated operating clone and became the human's own
  // checkout, so a `git branch -D` that followed `cwd` would now destroy THEIR
  // branches. The pin is not "the argument says repoDir" — it is that a real
  // preflight against a real cache leaves the operator's refs where they were.
  describe("with a real bare cache, the operator's checkout is never written", () => {
    it("deletes only in the cache, and only sandbar's own refs exist there", async () => {
      // The operator's checkout carries a branch of their own AND an
      // identically-named sandbar branch — the case a prefix-glob delete would
      // reach if it followed `cwd`.
      await git(target, "branch", "my-wip");
      await git(target, "branch", "sandbar/issue-1-merged");

      const layout = repoLayout(target, ".sandbar");
      await ensureRepoCache(layout);

      // The clone imports the operator's branches; the cache clears them, so
      // preflight's `refs/heads/sandbar/issue-*` glob cannot refuse a run over
      // a branch sandbar itself imported from the human's repo.
      const headsInCache = await git(
        layout.repoDir,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/",
      );
      expect(headsInCache.stdout.trim()).toBe("");

      // Now sandbar's own branch, created the way the inner loop creates it.
      await git(
        layout.repoDir,
        "branch",
        "--no-track",
        "sandbar/issue-1-merged",
        "refs/remotes/origin/main",
      );

      const deleted = await deleteMergedSandbarBranches({
        layout,
        sourceBranch: "main",
      });

      expect(deleted).toEqual(["sandbar/issue-1-merged"]);
      expect(await hasBranch(layout.repoDir, "sandbar/issue-1-merged")).toBe(false);
      // The operator's repo is untouched — both their own branch and their
      // same-named one survive.
      expect(await hasBranch(target, "my-wip")).toBe(true);
      expect(await hasBranch(target, "sandbar/issue-1-merged")).toBe(true);
    });
  });

  // The other consequence in #34: a clean launch directory would let preflight
  // pass while the actual target repo carries unmerged issue branches.
  describe("gatherState", () => {
    it("classifies a command that is not on PATH as absent", () => {
      expect(which("sandbar-command-that-does-not-exist")).toBe(false);
    });

    it("reports failed gh auth before making tracker queries", async () => {
      const authCalls = join(shimBin, "auth-calls");
      await writeFile(
        join(shimBin, "gh"),
        [
          "#!/bin/sh",
          `if [ "$1 $2" = "auth status" ]; then echo x >> '${authCalls}'; exit 1; fi`,
          'if [ "$1 $2" = "issue list" ]; then exit 73; fi',
          "exit 1",
        ].join("\n"),
        { mode: 0o755 },
      );

      await expect(runPreflight(cfg(layoutAt(target)))).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof PreflightError &&
          err.failures.some((failure) => failure.includes("gh auth status")),
      );
      expect(
        (await readFile(authCalls, "utf8")).trim().split("\n"),
      ).toHaveLength(1);
    });

    it("withholds tracker-backed classifications when gh auth fails", async () => {
      await writeFile(
        join(shimBin, "gh"),
        [
          "#!/bin/sh",
          'if [ "$1 $2" = "auth status" ]; then exit 1; fi',
          'if [ "$1 $2" = "issue list" ]; then exit 73; fi',
          "exit 1",
        ].join("\n"),
        { mode: 0o755 },
      );

      const state = await gatherState(cfg(layoutAt(target)));

      expect(state.ghAuthOk).toBe(false);
      expect(state.unmergedIssueBranches).toEqual([]);
      expect(state.discardedIssueBranches).toEqual([]);
      expect(state.resumableIssueBranches).toEqual([]);
      expect(state.parkedIssueBranches).toEqual([]);
    });

    it("classifies the target's issue branches, not the launch directory's", async () => {
      await git(launchedFrom, "checkout", "-q", "-b", "sandbar/issue-9-launch");
      await git(launchedFrom, "commit", "-q", "--allow-empty", "-m", "work");
      await git(target, "checkout", "-q", "-b", "sandbar/issue-7-target");
      await git(target, "commit", "-q", "--allow-empty", "-m", "work");
      await git(target, "checkout", "-q", "main");

      const state = await gatherState(cfg(layoutAt(target)));

      expect(state.unmergedIssueBranches).toEqual(["sandbar/issue-7-target"]);
    });

    // A chunk branch (#58) is unmerged for exactly as long as the human
    // reviewing it takes, which is the point of the review lane. Classifying it
    // `unmerged` would turn every open review into a hard refusal to start —
    // the loop stopping because it is waiting for the review it was told to
    // wait for. It is not `resumable` either: the number in it is a chunk ROOT,
    // not one issue whose inner loop could pick the branch up.
    it("takes none of the three classifications for a chunk branch", async () => {
      await git(target, "checkout", "-q", "-b", "sandbar/chunk-5-review-series");
      await git(target, "commit", "-q", "--allow-empty", "-m", "work");
      await git(target, "checkout", "-q", "main");

      const state = await gatherState(cfg(layoutAt(target)));

      expect(state.unmergedIssueBranches).toEqual([]);
      expect(state.discardedIssueBranches).toEqual([]);
      expect(state.resumableIssueBranches).toEqual([]);
    });

    // #60 — the member side of the same argument. A leftover issue branch for
    // an issue that has landed on a chunk branch is neither: not `unmerged`
    // (its commits are published under the chunk's name, so refusing the run
    // over it would refuse over nothing) and not `resumable` (the planner
    // drops `in-chunk` issues by label, so no inner loop will ever continue
    // it). It exists only when a run died between the chunk push and the label
    // flip, and the delete pass reaps it as soon as it can verify containment.
    it("takes none of the three for the issue branch of an `in-chunk` member", async () => {
      // A `gh` that answers the planner's two list queries by label, so
      // `fetchChunkMembers` really returns #7 — the shared shim answers the
      // other cases with an explicit empty issue list.
      await writeFile(
        join(shimBin, "gh"),
        [
          "#!/bin/sh",
          'label=""; prev=""',
          'for a in "$@"; do if [ "$prev" = "--label" ]; then label="$a"; fi; prev="$a"; done',
          'if [ "$label" = "in-chunk" ]; then',
          '  echo \'[{"number":7,"title":"t","body":"","labels":[{"name":"in-chunk"}]}]\'',
          "else",
          "  echo '[]'",
          "fi",
        ].join("\n"),
        { mode: 0o755 },
      );
      await git(target, "checkout", "-q", "-b", "sandbar/issue-7-member");
      await git(target, "commit", "-q", "--allow-empty", "-m", "member work");
      await git(target, "checkout", "-q", "main");

      const state = await gatherState(cfg(layoutAt(target)));

      expect(state.unmergedIssueBranches).toEqual([]);
      expect(state.discardedIssueBranches).toEqual([]);
      expect(state.resumableIssueBranches).toEqual([]);
    });

    // #34 — the tracker is `ghOwner`/`ghRepo` and the push target is the
    // cache's `origin`, and nothing declares the second. Read from the repo
    // preflight was pointed at, through real git, so the assertion covers
    // `git remote get-url` rather than a string this test also wrote.
    it("reads the origin URL of the named repo and parses it", async () => {
      await git(
        target,
        "remote",
        "set-url",
        "origin",
        "https://github.com/acme/app-fork.git",
      );
      await git(
        launchedFrom,
        "remote",
        "set-url",
        "origin",
        "https://github.com/acme/app.git",
      );

      const state = await gatherState(cfg(layoutAt(target)));

      expect(state.originUrl).toBe("https://github.com/acme/app-fork.git");
      expect(state.originRepo).toEqual({ owner: "acme", name: "app-fork" });
      expect(state.originHost).toBe("github.com");
      expect(state.configuredRepo).toEqual({ owner: "acme", name: "app" });
    });

    // A local-path remote is the shape the parser refuses to guess at, and a
    // fixture repo built with a self-remote is exactly that shape — so this is
    // also the default state of every other test in this file.
    it("reports a remote it cannot read as a repo without guessing", async () => {
      const state = await gatherState(cfg(layoutAt(target)));

      expect(state.originUrl).toBe(target);
      expect(state.originRepo).toBeNull();
      expect(state.originHost).toBeNull();
    });

    // The regression the parser rewrite exists for, exercised through real git
    // rather than the parser's own table: an ssh-reached filesystem path is a
    // perfectly ordinary mirror remote, and reading `git/app` out of it made
    // preflight refuse a working configuration for good.
    it("does not invent a repo out of an ssh-reached filesystem path", async () => {
      await git(
        target,
        "remote",
        "set-url",
        "origin",
        "git@gitserver.internal:/srv/git/app.git",
      );

      const state = await gatherState(cfg(layoutAt(target)));

      expect(state.originUrl).toBe("git@gitserver.internal:/srv/git/app.git");
      expect(state.originRepo).toBeNull();
      expect(state.originHost).toBeNull();
    });

    it("reads origin/<sourceBranch> from the named repo", async () => {
      const state = await gatherState(cfg(layoutAt(target)));
      expect(state.hasOriginBranch).toBe(true);

      // A repo with no `origin/main` at all — the invariant must be about the
      // repo it was pointed at, not about the one the process stands in.
      const bare = await mkdtemp(join(tmpdir(), "sandbar-empty-"));
      await git(bare, "init", "-q", "-b", "main");
      const empty = await gatherState(cfg(layoutAt(bare, target)));
      expect(empty.hasOriginBranch).toBe(false);
      await rm(bare, { recursive: true, force: true });
    });

    // #51 — host state, read with a real stat against real paths. The gate
    // stack is the whole of sandbar's consumer-supplied host-path surface, and
    // a source podman cannot resolve fails an `attempt` container at bringup,
    // which #24 D5 reports as a gate red against the branch.
    it("reports a declared mount source that does not exist, and not one that does", async () => {
      const present = join(target, "a.txt");
      const absent = join(target, "run", "podman.sock");

      const state = await gatherState({
        ...cfg(layoutAt(target)),
        mountSources: [
          { container: "gate", hostPath: present },
          { container: "gate", hostPath: absent },
        ],
      });

      expect(state.missingMountSources).toEqual([
        {
          container: "gate",
          hostPath: absent,
          detail: "no such file or directory",
        },
      ]);
    });

    // `stat`, not `lstat`: podman resolves the `-v` source through symlinks, so
    // a link whose target is gone is a bringup failure and has to read as one.
    it("follows a symlink and reports a dangling one as missing", async () => {
      const dangling = join(target, "dangling");
      await symlink(join(target, "nothing-here"), dangling);

      const state = await gatherState({
        ...cfg(layoutAt(target)),
        mountSources: [{ container: "db", hostPath: dangling }],
      });

      expect(state.missingMountSources).toEqual([
        {
          container: "db",
          hostPath: dangling,
          detail: "no such file or directory",
        },
      ]);
    });

    it("reports nothing when the stack declares no absolute sources", async () => {
      const state = await gatherState(cfg(layoutAt(target)));
      expect(state.missingMountSources).toEqual([]);
    });

    // #72 — the credential half, through the real EnvReader. The decision
    // itself (which providers a routing needs, what each accepts) is
    // agent-providers.test.ts's; what is checked here is that gatherState asks
    // the reader for the right keys and treats them as ANY-OF.
    it("finds a claude credential from either of its two keys (#72)", async () => {
      for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
        const state = await gatherState({
          ...cfg(layoutAt(target)),
          env: makeEnvReader({ [key]: "v" }),
        });
        expect(state.uncredentialledProviders).toEqual([]);
      }
    });

    it("reports the provider a routed role has no key for (#72)", async () => {
      const state = await gatherState({
        ...cfg(layoutAt(target)),
        agentProviders: ["claude", "codex"],
        env: makeEnvReader({ ANTHROPIC_API_KEY: "v" }),
      });
      expect(state.uncredentialledProviders).toEqual(["codex"]);
    });

    // An empty value means INHERIT (#38), not "absent", so this key's answer is
    // the HOST's — which is why the host half is set explicitly here rather
    // than left to whatever the machine running the suite exports. Both
    // directions, because the rule is one rule: nothing to inherit is no
    // credential, and something to inherit is one, from the same declaration.
    it("resolves an empty value from the host, and refuses when it is unset (#72)", async () => {
      const KEY = "ANTHROPIC_API_KEY";
      const saved = process.env[KEY];
      try {
        delete process.env[KEY];
        const missing = await gatherState({
          ...cfg(layoutAt(target)),
          env: makeEnvReader({ [KEY]: "" }),
        });
        expect(missing.uncredentialledProviders).toEqual(["claude"]);

        process.env[KEY] = "from-the-host";
        const inherited = await gatherState({
          ...cfg(layoutAt(target)),
          env: makeEnvReader({ [KEY]: "" }),
        });
        expect(inherited.uncredentialledProviders).toEqual([]);
      } finally {
        if (saved === undefined) delete process.env[KEY];
        else process.env[KEY] = saved;
      }
    });

    it("asks only about the providers the run will invoke (#72)", async () => {
      const state = await gatherState({
        ...cfg(layoutAt(target)),
        agentProviders: ["codex"],
        env: makeEnvReader({ OPENAI_API_KEY: "v" }),
      });
      expect(state.uncredentialledProviders).toEqual([]);
    });
  });
});

// #66 — the self-hosted launcher stopped pulling, so the config file a run
// imports is whatever the operator's checkout holds, for as long as they leave
// it there. Real git and three real directories, because the claim being made
// is about WHICH repository answers: the checkout supplies the commit its
// branch points at, and the freshly-fetched cache supplies origin. The operator
// this check exists for has not fetched, so their own `origin/main` is a stale
// ref that would report nothing.
describe("readConfigStaleness — the config the checkout is missing (#66)", () => {
  const CONFIG = "sandbar.config.mjs";
  let origin: string;
  let checkout: string;
  let layout: RepoLayout;
  let configPath: string;

  const identify = async (repo: string) => {
    await git(repo, "config", "user.email", "t@t");
    await git(repo, "config", "user.name", "t");
  };

  beforeEach(async () => {
    // An upstream two commits ahead of a checkout that has never fetched: one
    // of the two changes the config, the other does not.
    const seed = await mkdtemp(join(tmpdir(), "sandbar-upstream-"));
    await git(seed, "init", "-q", "-b", "main");
    await identify(seed);
    await writeFile(join(seed, "a.txt"), "a\n");
    await git(seed, "add", "-A");
    await git(seed, "commit", "-qm", "init");

    origin = await mkdtemp(join(tmpdir(), "sandbar-origin-"));
    await git(seed, "init", "-q", "--bare", "-b", "main", origin);
    await git(seed, "remote", "add", "origin", origin);
    await git(seed, "push", "-q", "-u", "origin", "main");

    checkout = await mkdtemp(join(tmpdir(), "sandbar-checkout-"));
    await git(seed, "clone", "-q", origin, checkout);
    await identify(checkout);
    configPath = join(checkout, CONFIG);

    await writeFile(join(seed, CONFIG), "export default { gateStack: 1 };\n");
    await git(seed, "add", "-A");
    await git(seed, "commit", "-qm", "config: a gate step");
    await writeFile(join(seed, "b.txt"), "b\n");
    await git(seed, "add", "-A");
    await git(seed, "commit", "-qm", "unrelated");
    await git(seed, "push", "-q", "origin", "main");
    await rm(seed, { recursive: true, force: true });

    // The cache, prepared exactly as a run prepares it — cloned from the
    // checkout, remote retargeted to the checkout's own origin, fetched.
    layout = repoLayout(checkout, ".sandbar");
    await ensureRepoCache(layout);
  });

  afterEach(async () => {
    await rm(origin, { recursive: true, force: true });
    await rm(checkout, { recursive: true, force: true });
  });

  // The whole reason the counting runs in the cache: the checkout's own
  // `origin/main` still says C1 here, so asking it would answer "0 behind" in
  // precisely the case the warning exists for.
  it("counts against the fetched cache, not the checkout's stale origin ref", async () => {
    const checkoutSaysBehind = await exec(
      "git",
      ["rev-list", "--count", "main..origin/main"],
      { cwd: checkout },
    );
    expect(checkoutSaysBehind.stdout.trim()).toBe("0");

    expect(
      await readConfigStaleness({ layout, sourceBranch: "main", configPath }),
    ).toMatchObject({ behind: 2, touchingConfig: 1 });
  });

  it("counts no config commits when none of the missing ones touched it", async () => {
    expect(
      await readConfigStaleness({
        layout,
        sourceBranch: "main",
        configPath: join(checkout, "other.config.mjs"),
      }),
    ).toMatchObject({ behind: 2, touchingConfig: 0 });
  });

  // `--config` may name a file outside the checkout entirely, and that history
  // has nothing to say about it. Answered as zeros rather than as a pathspec
  // git refuses.
  it("says nothing about a config file outside the checkout", async () => {
    expect(
      await readConfigStaleness({
        layout,
        sourceBranch: "main",
        configPath: join(tmpdir(), "sandbar-elsewhere.config.mjs"),
      }),
    ).toMatchObject({ behind: 0, touchingConfig: 0 });
  });

  // `config.cwd` is only USUALLY the repository root — a host may keep its
  // config a directory down, or name one above the cwd — and a pathspec spent
  // in the cache is relative to the work tree root either way.
  it("resolves the config against the work tree root, not the run's cwd", async () => {
    const sub = join(checkout, "tools");
    await mkdir(sub);

    expect(
      await readConfigStaleness({
        layout: { ...repoLayout(sub, ".sandbar"), repoDir: layout.repoDir },
        sourceBranch: "main",
        configPath,
      }),
    ).toMatchObject({ behind: 2, touchingConfig: 1 });
  });

  // `--show-toplevel` answers with symlinks resolved and `--config` does not
  // (the bin `resolve()`s argv), so an operator whose checkout is reached
  // through a symlinked parent would otherwise have this warning silently
  // retired: `relative()` would compare the link against its target and the
  // config would look like a file outside the repository.
  it("sees a config named through a symlinked path to the checkout", async () => {
    const link = join(await mkdtemp(join(tmpdir(), "sandbar-link-")), "repo");
    await symlink(checkout, link);

    expect(
      await readConfigStaleness({
        layout: { ...layout, hostCwd: link },
        sourceBranch: "main",
        configPath: join(link, CONFIG),
      }),
    ).toMatchObject({ behind: 2, touchingConfig: 1 });
  });

  it("asks git nothing when the run has no config file", async () => {
    expect(
      await readConfigStaleness({
        layout,
        sourceBranch: "main",
        configPath: null,
      }),
    ).toMatchObject({ behind: 0, touchingConfig: 0 });
  });

  it("reports nothing for a source branch the checkout does not have", async () => {
    expect(
      await readConfigStaleness({
        layout,
        sourceBranch: "release",
        configPath,
      }),
    ).toMatchObject({ behind: 0, touchingConfig: 0 });
  });

  // An UNPUSHED local commit is the ahead-warning's business, not this one's:
  // the cache has never seen it, so there is no range to count and the answer
  // is zeros rather than a number invented from a merge base.
  it("reports nothing when the checkout's tip is unknown to the cache", async () => {
    await writeFile(join(checkout, "local.txt"), "local\n");
    await git(checkout, "add", "-A");
    await git(checkout, "commit", "-qm", "operator's unpushed work");

    expect(
      await readConfigStaleness({ layout, sourceBranch: "main", configPath }),
    ).toMatchObject({ behind: 0, touchingConfig: 0 });
  });
});
