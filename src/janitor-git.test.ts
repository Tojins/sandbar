// #205 — the janitor runner's git, asserted by running it: the merge-tree
// refresh, the leased push and the scope candidates, then whole runs over a
// real origin and bare cache with the inner loop and the forge faked.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JanitorTask, PromptExtension } from "./config.js";
import type { EventInput } from "./events.js";
import { AgentCredentialError, AgentQuotaError } from "./agent-sandbox.js";
import { InnerLoopAbortedError, type Terminal, type runInnerLoop } from "./inner-loop.js";
import {
  type JanitorForge,
  listScopeCandidates,
  pushRollingBranch,
  refreshRollingBranch,
  runJanitor,
} from "./janitor.js";
import { janitorLedgerPath } from "./janitor-ledger.js";
import type { LatestPullRequest } from "./janitor-plan.js";
import type { IssueLogger } from "./logs.js";
import { repoLayout } from "./repo-cache.js";

const exec = promisify(execFile);
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
const git = async (dir: string, ...args: string[]): Promise<string> =>
  (await exec("git", [...IDENTITY, ...args], { cwd: dir })).stdout.trim();

const BOT = { botName: "sandbar", botEmail: "bot@example.com" };

describe("the janitor's git (#205)", () => {
  let root: string;
  let origin: string;
  let work: string;
  let cache: string;

  // Commit `files` in the working clone on `branch` and push it to origin.
  const commit = async (branch: string, files: Record<string, string>, message = "c"): Promise<string> => {
    await git(work, "checkout", "-q", "-B", branch);
    for (const [path, body] of Object.entries(files)) {
      await mkdir(join(work, path, ".."), { recursive: true });
      await writeFile(join(work, path), body);
    }
    await git(work, "add", "-A");
    await git(work, "commit", "-qm", message);
    await git(work, "push", "-q", "-f", "origin", `${branch}:${branch}`);
    return await git(work, "rev-parse", "HEAD");
  };
  const fetchCache = (): Promise<string> =>
    git(cache, "fetch", "-q", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-janitor-git-"));
    origin = join(root, "origin.git");
    work = join(root, "work");
    await exec("git", ["init", "-q", "--bare", "-b", "main", origin]);
    await exec("git", ["init", "-q", "-b", "main", work]);
    await git(work, "remote", "add", "origin", origin);
    await commit("main", { "README.md": "readme\n", "src/a.ts": "a\n" });
    cache = repoLayout(root, ".sandbar").repoDir;
    await mkdir(cache, { recursive: true });
    await exec("git", ["init", "-q", "--bare", cache]);
    await git(cache, "remote", "add", "origin", origin);
    await fetchCache();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("refreshRollingBranch", () => {
    const refresh = async (branchTip: string, sourceTip: string) => refreshRollingBranch({
      repoDir: cache, branch: "sandbar/janitor-tidy", branchTip, sourceBranch: "main", sourceTip, ...BOT,
    });

    it("merges a moved source in as the bot, both tips its parents", async () => {
      const branchTip = await commit("sandbar/janitor-tidy", { "src/a.ts": "tidied\n" });
      const sourceTip = await commit("main", { "README.md": "moved\n" });
      await fetchCache();
      const refreshed = await refresh(branchTip, sourceTip);
      expect(refreshed.kind).toBe("clean");
      const sha = (refreshed as { sha: string }).sha;
      expect(await git(cache, "log", "-1", "--format=%P|%an <%ae>|%cn|%s", sha))
        .toBe(`${branchTip} ${sourceTip}|sandbar <bot@example.com>|sandbar|Merge main into sandbar/janitor-tidy`);
      expect(await git(cache, "show", `${sha}:src/a.ts`)).toBe("tidied");
      expect(await git(cache, "show", `${sha}:README.md`)).toBe("moved");
    });

    it("keeps a branch that already contains the source", async () => {
      await git(work, "checkout", "-q", "main");
      const branchTip = await commit("sandbar/janitor-tidy", { "src/a.ts": "tidied\n" });
      await fetchCache();
      const sourceTip = await git(cache, "rev-parse", "refs/remotes/origin/main");
      expect(await refresh(branchTip, sourceTip)).toEqual({ kind: "clean", sha: branchTip });
    });

    it("reports a conflict and writes no commit", async () => {
      const branchTip = await commit("sandbar/janitor-tidy", { "src/a.ts": "ours\n" });
      await git(work, "checkout", "-q", "main");
      await git(work, "reset", "-q", "--hard", "HEAD");
      const sourceTip = await commit("main", { "src/a.ts": "theirs\n" });
      await fetchCache();
      expect(await refresh(branchTip, sourceTip)).toEqual({ kind: "conflict" });
    });
  });

  describe("pushRollingBranch", () => {
    const branch = "sandbar/janitor-tidy";
    const setLocal = async (sha: string): Promise<void> => {
      await git(cache, "update-ref", `refs/heads/${branch}`, sha);
    };

    it("creates a branch origin does not have under the empty lease", async () => {
      const tip = await git(cache, "rev-parse", "refs/remotes/origin/main");
      await setLocal(tip);
      expect(await pushRollingBranch(cache, branch, "")).toBe(true);
      expect(await git(origin, "rev-parse", `refs/heads/${branch}`)).toBe(tip);
    });

    it("replaces a closed PR's branch under a lease on its tip", async () => {
      const stale = await commit(branch, { "src/a.ts": "stale\n" });
      const fresh = await git(cache, "rev-parse", "refs/remotes/origin/main");
      await setLocal(fresh);
      expect(await pushRollingBranch(cache, branch, stale)).toBe(true);
      expect(await git(origin, "rev-parse", `refs/heads/${branch}`)).toBe(fresh);
    });

    it("refuses when origin moved off the lease, and leaves origin as a human left it", async () => {
      const seen = await commit(branch, { "src/a.ts": "seen\n" });
      const human = await commit(branch, { "src/a.ts": "human\n" });
      await setLocal(await git(cache, "rev-parse", "refs/remotes/origin/main"));
      expect(await pushRollingBranch(cache, branch, seen)).toBe(false);
      expect(await git(origin, "rev-parse", `refs/heads/${branch}`)).toBe(human);
      expect(await pushRollingBranch(cache, branch, "")).toBe(false);
    });
  });

  it("lists the blobs the pathspecs match, excludes included, with their sizes", async () => {
    await commit("main", {
      "src/b.ts": "bb\n",
      "src/vendor/v.ts": "vvvv\n",
      "docs/guide.md": "g\n",
    });
    await symlink("a.ts", join(work, "src", "link.ts"));
    const tip = await commit("main", {});
    await fetchCache();
    expect([...await listScopeCandidates(cache, tip, ["src", ":(exclude)src/vendor"])]
      .sort((a, b) => a.path.localeCompare(b.path)))
      .toEqual([
        { path: "src/a.ts", bytes: 2 },
        { path: "src/b.ts", bytes: 3 },
      ]);
    expect((await listScopeCandidates(cache, tip, ["*.md"])).map((c) => c.path).sort())
      .toEqual(["README.md", "docs/guide.md"]);
  });

  describe("runJanitor", () => {
    const branch = "sandbar/janitor-tidy";
    let layout: ReturnType<typeof repoLayout>;
    let events: EventInput[];
    let prs: LatestPullRequest[];
    let comments: { pr: number; body: string }[];
    let ensured: { head: string; title: string; body: string }[];

    const task: JanitorTask = {
      name: "tidy", prompt: { file: "JANITOR.md" }, runsPerDay: 4, paths: ["src"], unit: "file",
    };
    const forge: JanitorForge = {
      latestPullRequest: async () => prs.at(-1) ?? null,
      commentOnPullRequest: async (pr, body) => {
        comments.push({ pr, body });
      },
      ensureDraftPullRequest: async (args) => {
        ensured.push(args);
        return { number: ensureNumber, url: "https://example.com/pull/12" };
      },
    };
    // The inner loop, faked: one commit on the run's branch, then `terminal`.
    const loopEnding = (terminal: Terminal | Error, commits = 1): typeof runInnerLoop =>
      (async (issue, opts) => {
        let head = opts.janitor!.base.ref;
        for (let i = 0; i < commits; i += 1) {
          head = await git(cache, "commit-tree", `${head}^{tree}`, "-p", head, "-m", `tidy ${i}`);
        }
        await git(cache, "update-ref", `refs/heads/${issue.branch}`, head);
        if (terminal instanceof Error) throw terminal;
        return terminal;
      }) as typeof runInnerLoop;
    const DONE: Terminal = { type: "DONE", commits: [], specGaps: [] };
    let ensureNumber = 12;
    const run = (
      runLoop: typeof runInnerLoop,
      runTask = task,
      standards: PromptExtension | undefined = undefined,
    ) => runJanitor({
      task: runTask,
      layout,
      sourceBranch: "main",
      ...BOT,
      maxContextChars: 600_000,
      standards,
      forge,
      beforeOriginWrite: async () => undefined,
      loop: {} as never,
      attemptLogger: { dir: join(root, "logs") } as IssueLogger,
      onEvent: async (event) => {
        events.push(event);
      },
      signal: new AbortController().signal,
      now: () => new Date("2026-10-28T12:00:00.000Z"),
      runLoop,
    });
    const originTip = async (): Promise<string | null> =>
      (await exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: origin })
        .then(({ stdout }) => stdout.trim(), () => null));
    const ended = () => events.find((e) => e.kind === "janitor-run");

    beforeEach(async () => {
      layout = repoLayout(root, ".sandbar");
      events = [];
      prs = [];
      comments = [];
      ensured = [];
      ensureNumber = 12;
      await commit("main", { "JANITOR.md": "Tidy the tests.\n" });
      await fetchCache();
    });

    it("pushes a DONE run from the source tip and opens its draft pull request", async () => {
      expect(await run(loopEnding(DONE, 2))).toBe("committed");
      const sourceTip = await git(cache, "rev-parse", "refs/remotes/origin/main");
      expect(await git(origin, "rev-list", "--count", `${sourceTip}..${branch}`)).toBe("2");
      expect(ensured).toEqual([{
        head: branch, title: "Idle task: tidy", body: "Idle task `tidy`, applying `JANITOR.md`.",
      }]);
      expect(events.find((e) => e.kind === "janitor-start")).toMatchObject({
        task: "tidy", branch, base: sourceTip, fresh: true, scope: ["src/a.ts"], runsToday: 1, runsPerDay: 4,
      });
      expect(ended()).toMatchObject({ outcome: "committed", commits: 2, pullRequest: 12, scope: ["src/a.ts"] });
      const ledger = JSON.parse(await readFile(janitorLedgerPath(layout.stateDir, "tidy"), "utf8"));
      expect(ledger).toEqual({
        version: 1,
        starts: ["2026-10-28T12:00:00.000Z"],
        visits: { "src/a.ts": "2026-10-28T12:00:00.000Z" },
      });
    });

    it("hands the loop the task anchor and the base as a sha", async () => {
      let seen: Parameters<typeof runInnerLoop>[1]["janitor"];
      await run((async (issue, opts) => {
        seen = opts.janitor;
        expect(issue).toEqual({ id: "janitor-tidy", title: "Idle task: tidy", branch });
        return { type: "NEEDS-INFO", questions: "nothing to do", strandedHead: null, specGaps: [] };
      }) as typeof runInnerLoop);
      expect(seen?.base).toEqual({ ref: await git(cache, "rev-parse", "refs/remotes/origin/main"), chunkBranch: null });
      expect(seen?.anchor).toContain("- `src/a.ts`");
      expect(seen?.anchor).toContain("From `JANITOR.md` on `main`:\n\nTidy the tests.");
    });

    it("leaves origin untouched for a run with nothing to do, yet counts the visit", async () => {
      const outcome = await run(loopEnding({ type: "NEEDS-INFO", questions: "clean", strandedHead: null, specGaps: [] }, 0));
      expect(outcome).toBe("no-change");
      expect(await originTip()).toBeNull();
      expect(ensured).toEqual([]);
      const ledger = JSON.parse(await readFile(janitorLedgerPath(layout.stateDir, "tidy"), "utf8"));
      expect(Object.keys(ledger.visits)).toEqual(["src/a.ts"]);
    });

    it("discards a rejected run without a word to the forge", async () => {
      const outcome = await run(loopEnding({
        type: "NEEDS-HUMAN-REVIEW", cause: "correctness-budget-exhausted", latestReviewerProse: "no",
        roundsUsed: 3, commits: [], specGaps: [],
      }));
      expect(outcome).toBe("rejected");
      expect(await originTip()).toBeNull();
      expect(ensured).toEqual([]);
      expect(comments).toEqual([]);
    });

    it("discards a pre-empted run and does not count its visit", async () => {
      expect(await run(loopEnding(new InnerLoopAbortedError()))).toBe("pre-empted");
      expect(await originTip()).toBeNull();
      const ledger = JSON.parse(await readFile(janitorLedgerPath(layout.stateDir, "tidy"), "utf8"));
      expect(ledger.visits).toEqual({});
      expect(ledger.starts).toHaveLength(1);
    });

    it("discards a DONE run whose pull request was labelled land meanwhile", async () => {
      prs = [{ number: 9, state: "OPEN", labels: [] }];
      await commit(branch, { "src/a.ts": "earlier run\n" });
      await fetchCache();
      const before = await originTip();
      const labelling = loopEnding(DONE);
      const outcome = await run((async (...args: Parameters<typeof runInnerLoop>) => {
        const terminal = await labelling(...args);
        prs = [{ number: 9, state: "OPEN", labels: ["land"] }];
        return terminal;
      }) as typeof runInnerLoop);
      expect(outcome).toBe("pre-empted");
      expect(ended()).toMatchObject({ outcome: "pre-empted", cause: "land" });
      expect(await originTip()).toBe(before);
    });

    it("continues an open PR's branch through a driver merge of the moved source", async () => {
      prs = [{ number: 9, state: "OPEN", labels: [] }];
      const earlier = await commit(branch, { "src/a.ts": "earlier run\n" });
      await git(work, "checkout", "-q", "main");
      await git(work, "reset", "-q", "--hard", "origin/main");
      const sourceTip = await commit("main", { "README.md": "moved\n" });
      await fetchCache();
      expect(await run(loopEnding(DONE))).toBe("committed");
      const start = events.find((e) => e.kind === "janitor-start") as Extract<EventInput, { kind: "janitor-start" }>;
      expect(start.fresh).toBe(false);
      expect(await git(cache, "log", "-1", "--format=%P", start.base)).toBe(`${earlier} ${sourceTip}`);
      expect(await git(origin, "rev-parse", `${branch}~1`)).toBe(start.base);
    });

    it("starts afresh over a closed PR's branch", async () => {
      prs = [{ number: 9, state: "CLOSED", labels: [] }];
      const stale = await commit(branch, { "src/a.ts": "rejected by a human\n" });
      await fetchCache();
      expect(await run(loopEnding(DONE))).toBe("committed");
      const sourceTip = await git(cache, "rev-parse", "refs/remotes/origin/main");
      expect(await git(origin, "rev-parse", `${branch}~1`)).toBe(sourceTip);
      expect(await git(origin, "merge-base", "--is-ancestor", stale, branch).then(() => true, () => false)).toBe(false);
    });

    it("holds a conflicted task with one PR comment, and runs nothing", async () => {
      prs = [{ number: 9, state: "OPEN", labels: [] }];
      await commit(branch, { "src/a.ts": "ours\n" });
      await git(work, "checkout", "-q", "main");
      await git(work, "reset", "-q", "--hard", "origin/main");
      await commit("main", { "src/a.ts": "theirs\n" });
      await fetchCache();
      let ran = false;
      expect(await run((async () => {
        ran = true;
        return DONE;
      }) as typeof runInnerLoop)).toBe("held");
      expect(ran).toBe(false);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.pr).toBe(9);
      expect(events.some((e) => e.kind === "janitor-run" || e.kind === "janitor-start")).toBe(false);
      const ledger = JSON.parse(await readFile(janitorLedgerPath(layout.stateDir, "tidy"), "utf8"));
      expect(ledger.hold.kind).toBe("conflict");
    });

    it("spends nothing when the pathspecs match no file", async () => {
      let ran = false;
      expect(await run((async () => {
        ran = true;
        return DONE;
      }) as typeof runInnerLoop, { ...task, paths: ["no-such-dir"] })).toBe("no-change");
      expect(ran).toBe(false);
      expect(ended()).toMatchObject({ outcome: "no-change", cause: "nothing in scope", scope: [] });
      expect(events.some((e) => e.kind === "janitor-start")).toBe(false);
    });

    it("holds a task whose prompt file the source tip lacks", async () => {
      await git(work, "rm", "-q", "JANITOR.md");
      await commit("main", {});
      await fetchCache();
      expect(await run(loopEnding(DONE))).toBe("held");
      expect(events.find((e) => e.kind === "notice")).toMatchObject({
        message: expect.stringContaining("JANITOR.md is missing at origin/main"),
      });
    });

    it("reports a lease that no longer holds as failed, keeping the human's push", async () => {
      prs = [{ number: 9, state: "OPEN", labels: [] }];
      await commit(branch, { "src/a.ts": "earlier run\n" });
      await fetchCache();
      const racing = loopEnding(DONE);
      let human = "";
      const outcome = await run((async (...args: Parameters<typeof runInnerLoop>) => {
        const terminal = await racing(...args);
        human = await commit(branch, { "src/a.ts": "a human's fix\n" });
        return terminal;
      }) as typeof runInnerLoop);
      expect(outcome).toBe("failed");
      expect(ended()).toMatchObject({ outcome: "failed", cause: "lease" });
      expect(await originTip()).toBe(human);
    });

    it("leaves out the pull request number a forge answers with 0", async () => {
      ensureNumber = 0;
      expect(await run(loopEnding(DONE))).toBe("committed");
      const event = ended();
      expect(event).toMatchObject({ outcome: "committed", commits: 1 });
      expect(event).not.toHaveProperty("pullRequest");
    });

    it.each([
      ["a quota error", new AgentQuotaError("claude", { window: "5h" } as never), "QUOTA"],
      ["a credential error", new AgentCredentialError("expired"), "CREDENTIAL"],
    ])("reports %s as a failed run, pushes nothing and does not count the visit", async (_, error, cause) => {
      expect(await run(loopEnding(error))).toBe("failed");
      expect(ended()).toMatchObject({ outcome: "failed", cause });
      expect(await originTip()).toBeNull();
      expect(ensured).toEqual([]);
      const ledger = JSON.parse(await readFile(janitorLedgerPath(layout.stateDir, "tidy"), "utf8"));
      expect(ledger.visits).toEqual({});
    });

    it("reports a thrown abort as a pre-empted run", async () => {
      expect(await run((async () => {
        throw new InnerLoopAbortedError();
      }) as typeof runInnerLoop)).toBe("pre-empted");
      expect(ended()).toMatchObject({ outcome: "pre-empted" });
      expect(await originTip()).toBeNull();
    });

    it("holds a task whose previous clone must be preserved, without a start or an end", async () => {
      const clone = join(layout.worktreesDir, "sandbar-janitor-tidy");
      await mkdir(clone, { recursive: true });
      await exec("git", ["init", "-q", clone]);
      await git(clone, "config", "sandbar.issueBranch", branch);
      await git(clone, "checkout", "-q", "-b", branch);
      await writeFile(join(clone, "scratch.txt"), "uncommitted\n");
      let ran = false;
      expect(await run((async () => {
        ran = true;
        return DONE;
      }) as typeof runInnerLoop)).toBe("held");
      expect(ran).toBe(false);
      expect(events).toContainEqual({
        kind: "complaint",
        severity: "error",
        message: expect.stringContaining("Janitor clone preserved at"),
      });
      expect(events.some((e) => e.kind === "janitor-start" || e.kind === "janitor-run")).toBe(false);
      const ledger = JSON.parse(await readFile(janitorLedgerPath(layout.stateDir, "tidy"), "utf8"));
      expect(ledger.hold.kind).toBe("clone-preserved");
    });

    describe("a standards task", () => {
      const standardsTask: JanitorTask = { ...task, prompt: "standards" };

      it("runs with the flagged group's text in the anchor", async () => {
        let anchor = "";
        await run((async (_issue, opts) => {
          anchor = opts.janitor!.anchor;
          return { type: "NEEDS-INFO", questions: "nothing", strandedHead: null, specGaps: [] };
        }) as typeof runInnerLoop, standardsTask, { text: "## Tests {janitor}\n- keep tests tidy\n" });
        expect(anchor).toContain("Find code in scope that breaks these project rules and fix it.");
        expect(anchor).toContain("keep tests tidy");
      });

      it("holds with the standards message when no group is flagged", async () => {
        expect(await run(loopEnding(DONE), standardsTask, { text: "## Tests\n- keep tests tidy\n" })).toBe("held");
        expect(events).toContainEqual({
          kind: "notice",
          message: expect.stringContaining("no project standards group is flagged {janitor}"),
        });
        const ledger = JSON.parse(await readFile(janitorLedgerPath(layout.stateDir, "tidy"), "utf8"));
        expect(ledger.hold.kind).toBe("source-missing");
      });
    });

    it("lists a directory task's scope as the directory", async () => {
      let anchor = "";
      await run((async (_issue, opts) => {
        anchor = opts.janitor!.anchor;
        return { type: "NEEDS-INFO", questions: "nothing", strandedHead: null, specGaps: [] };
      }) as typeof runInnerLoop, { ...task, unit: "directory" });
      expect(anchor).toContain("- `src/`, the files directly in it");
    });
  });
});
