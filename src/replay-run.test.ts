// #195 — `replay run` end to end over real git, with podman, the images and
// the inner loop faked: what a session leaves on disk, that its records are
// ordinary run records the scorecard reads, that nothing it hands a sandbox
// holds a forge credential, and how a quota stop closes the session; and
// `replay report` over the sessions it leaves.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EventInput } from "./events.js";
import type { InnerLoopOptions, IssueRef, Terminal } from "./inner-loop.js";

const seams = vi.hoisted(() => ({
  cleanup: [] as (() => unknown)[],
  terminals: new Map<string, Terminal>(),
  loops: [] as { readonly issue: string; readonly env: Record<string, string>; readonly issueTitle: unknown }[],
  // Issues whose loop rejects, and how many loops run at once.
  rejects: new Set<string>(),
  active: 0,
  maxActive: 0,
}));

vi.mock("./cleanup.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./cleanup.js")>(),
  installCleanupTraps: () => undefined,
  onCleanup: (action: () => unknown) => {
    seams.cleanup.push(action);
  },
  registerDisposable: (action: () => unknown) => {
    seams.cleanup.push(action);
    return () => {
      const at = seams.cleanup.indexOf(action);
      if (at >= 0) seams.cleanup.splice(at, 1);
    };
  },
  runCleanup: async () => {
    for (let action = seams.cleanup.pop(); action !== undefined; action = seams.cleanup.pop()) await action();
  },
}));
vi.mock("./disk-space.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./disk-space.js")>(),
  podmanGraphRoot: async () => "/graph",
  graphRootSpace: async () => ({ graphRoot: "/graph", availableBytes: 1n << 40n }),
}));
vi.mock("./containers.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./containers.js")>(),
  cleanupOrphanContainers: async () => ({ removed: [], failures: [] }),
}));
vi.mock("./image-lifecycle.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./image-lifecycle.js")>(),
  reconcileImages: async () => ({ removed: [] }),
}));
vi.mock("./ensure-images.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ensure-images.js")>(),
  existingBaseFingerprints: async () => new Map(),
  createBranchImages: () => ({ resolve: async () => new Map(), builtTags: () => [] }),
}));
vi.mock("./agent-tools.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./agent-tools.js")>(),
  createAgentImages: async () => ({
    declaredTag: "image",
    augment: async (tag: string) => tag,
    builtTags: () => [],
    liveTags: () => [],
  }),
}));
vi.mock("./preflight.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./preflight.js")>(),
  checkStackOnHost: async () => undefined,
}));
vi.mock("./driver-identity.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./driver-identity.js")>(),
  readDriverIdentity: async () => ({}),
  formatDriverIdentity: () => "Driver: sandbar test",
}));

const exec = promisify(execFile);
const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = async (cwd: string, args: readonly string[]): Promise<string> =>
  (await exec("git", [...args], { cwd, env: { ...process.env, ...IDENTITY } })).stdout.trim();

// What one attempt does to the case cache: seed the branch, commit once in a
// marked issue clone, and pass one gate-1.
vi.mock("./inner-loop.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./inner-loop.js")>(),
  runInnerLoop: async (issue: IssueRef, opts: InnerLoopOptions): Promise<Terminal> => {
    const { ensureIssueBranch, revParse } = await import("./git-ops.js");
    const { worktreePathFor } = await import("./repo-cache.js");
    const { repoDir, worktreesDir } = opts.config.layout;
    seams.loops.push({
      issue: issue.id,
      env: opts.config.env,
      issueTitle: (await opts.config.issueSource(issue.id)).title,
    });
    if (seams.rejects.has(issue.id)) throw new Error(`loop #${issue.id} exploded`);
    seams.maxActive = Math.max(seams.maxActive, ++seams.active);
    try {
      await new Promise((done) => setTimeout(done, 30));
    } finally {
      seams.active--;
    }
    const base = await ensureIssueBranch(repoDir, issue.branch, opts.config.sourceBranch);
    const event = (e: EventInput) => opts.onEvent(e);
    await event({
      kind: "admitted", issue: Number(issue.id), title: issue.title, branch: issue.branch, chunk: null,
      seedRef: base.ref, seedSha: await revParse(repoDir, base.ref),
    });
    const clone = worktreePathFor(worktreesDir, issue.branch);
    await exec("git", ["clone", "-q", "--local", "-b", issue.branch, repoDir, clone]);
    await writeFile(join(clone, `${issue.id}.txt`), "work\n");
    await git(clone, ["add", "-A"]);
    await git(clone, ["commit", "-qm", "attempt"]);
    await git(clone, ["config", "sandbar.issueBranch", issue.branch]);
    await event({ kind: "gate", issue: Number(issue.id), attempt: 1, gate: "gate-1", ok: true, durationMs: 1 });
    return seams.terminals.get(issue.id) ?? { type: "DONE", commits: [], specGaps: [] };
  },
}));

const { readStatsInput } = await import("./stats-record.js");
const { resolveConfig } = await import("./config.js");
const { ensureRepoCache } = await import("./repo-cache.js");
const { replayLayout, report, runReplay } = await import("./replay-run.js");

let root: string;
let checkout: string;
let seed: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sandbar-replay-run-"));
  const upstream = join(root, "upstream.git");
  checkout = join(root, "checkout");
  await exec("git", ["init", "-q", "--bare", "-b", "main", upstream]);
  await exec("git", ["clone", "-q", upstream, checkout]);
  await git(checkout, ["checkout", "-q", "-b", "main"]);
  await writeFile(join(checkout, "a.txt"), "a\n");
  await git(checkout, ["add", "-A"]);
  await git(checkout, ["commit", "-qm", "seed"]);
  seed = await git(checkout, ["rev-parse", "HEAD"]);
  await git(checkout, ["push", "-q", "origin", "main"]);
  seams.cleanup.length = 0;
  seams.terminals.clear();
  seams.loops.length = 0;
  seams.rejects.clear();
  seams.active = 0;
  seams.maxActive = 0;
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(root, { recursive: true, force: true });
});

const config = (extra: Record<string, unknown> = {}) => resolveConfig({
  ghOwner: "acme", ghRepo: "app", developers: "anyone", cwd: checkout, workDir: ".sandbar",
  sandboxImage: "image", botName: "bot", botEmail: "bot@example.com",
  sandboxHooks: {}, env: { GH_TOKEN: "token", CLAUDE_CODE_OAUTH_TOKEN: "claude" },
  gateStack: {
    containers: [{ name: "app", image: "image", mountWorktree: "/work", hold: true }],
    steps: [{ name: "test", in: "app", command: ["true"] }],
  },
  ...extra,
});

const replayCase = (issue: number) => ({
  issue, title: `Issue ${issue}`, seedSha: seed, seedFrom: "recorded",
  issueJson: { title: `Issue ${issue} as admitted`, body: "", comments: [] },
  issueFrom: "recorded", original: null, landed: null,
});

const caseFileOf = (value: Record<string, unknown> = {}) => ({
  replayCases: 1, repo: "acme/app", sourceBranch: "main", cases: [replayCase(7), replayCase(8)], ...value,
});

async function writeCases(value: unknown = caseFileOf()): Promise<string> {
  const path = join(root, "cases.json");
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

async function casesFile(value?: unknown): Promise<string> {
  await ensureRepoCache(replayLayout(config()), () => undefined);
  return await writeCases(value);
}

const replay = async (
  label: string,
  repeats: number,
  opts: { readonly parallel?: number; readonly config?: ReturnType<typeof config>; readonly cases?: string } = {},
) => runReplay({
  config: opts.config ?? config(),
  configPath: join(checkout, "sandbar.config.mjs"),
  casesFile: opts.cases ?? await casesFile(),
  label,
  repeats,
  parallel: opts.parallel ?? 1,
  log: () => undefined,
});

const sessionOf = (label: string): string => join(replayLayout(config()).stateDir, "sessions", label);
const manifestOf = async (label: string) => JSON.parse(await readFile(join(sessionOf(label), "replay.json"), "utf8"));

// Each session drives real git through preflight, the cache and every run's
// records: ~1.5s idle, past vitest's 5s default on a loaded gate host.
const SESSION_TIMEOUT = 30_000;

describe("replay run (#195)", { timeout: SESSION_TIMEOUT }, () => {
  it("records every case × repeat into a session the scorecard reads", async () => {
    process.env.GH_TOKEN = "secret";

    await expect(replay("baseline", 2)).resolves.toBe(0);

    expect(process.env.GH_TOKEN).toBeUndefined();
    expect(seams.loops.map((loop) => loop.issue)).toEqual(["7", "8", "7", "8"]);
    expect(seams.loops.every((loop) => !("GH_TOKEN" in loop.env) && loop.env.CLAUDE_CODE_OAUTH_TOKEN === "claude"))
      .toBe(true);
    expect(seams.loops[0]?.issueTitle).toBe("Issue 7 as admitted");
    const session = join(replayLayout(config()).stateDir, "sessions", "baseline");
    const manifest = JSON.parse(await readFile(join(session, "replay.json"), "utf8"));
    expect(manifest).toMatchObject({
      replaySession: 1, label: "baseline", driver: "Driver: sandbar test", repeats: 2, parallel: 1,
      routing: { implementer: { agent: "claude" } },
    });
    expect(manifest.results).toHaveLength(4);
    expect(manifest.results[0]).toMatchObject({
      repeat: 1, issue: 7, seedSha: seed, branch: "sandbar/issue-7-issue-7", status: "ran",
      terminal: "DONE", lastGateOk: true, diff: { files: 1, insertions: 1, deletions: 0 },
    });
    const caseCache = join(session, "cases", "7-r1", "repo.git");
    expect(manifest.results[0].tip).toBe(await git(caseCache, ["rev-parse", "refs/heads/sandbar/issue-7-issue-7"]));

    const stats = await readStatsInput(join(session, "logs"), { last: 10 }, { withProse: false });
    expect(stats.skipped).toEqual([]);
    expect(stats.runs).toHaveLength(2);
    expect(stats.runs.map((run) => run.events.filter((e) => e.kind === "terminal").map((e) => e.issue)))
      .toEqual([[7, 8], [7, 8]]);
    expect(manifest.results.map((r: { run: string }) => r.run)).toEqual([
      stats.runs[0]?.run, stats.runs[0]?.run, stats.runs[1]?.run, stats.runs[1]?.run,
    ]);
  });

  it.each<[string, Terminal, string]>([
    ["QUOTA", { type: "QUOTA", provider: "codex", window: "five_hour", specGaps: [] } as Terminal, "QUOTA: codex five_hour"],
    ["CREDENTIAL", { type: "CREDENTIAL", provider: "codex", detail: "expired", specGaps: [] } as Terminal, "CREDENTIAL: codex: expired"],
  ])("stops at a %s, recording every case not yet started as not run, and answers 3", async (type, terminal, reason) => {
    seams.terminals.set("7", terminal);

    await expect(replay("stop", 2)).resolves.toBe(3);

    expect(seams.loops.map((loop) => loop.issue)).toEqual(["7"]);
    const session = sessionOf("stop");
    const { results } = await manifestOf("stop");
    expect(results.map((r: Record<string, unknown>) => [r.repeat, r.issue, r.status, r.terminal ?? r.reason])).toEqual([
      [1, 7, "ran", type],
      [1, 8, "not-run", reason],
      [2, 7, "not-run", reason],
      [2, 8, "not-run", reason],
    ]);
    expect(results[1].run).toBe(results[0].run);
    expect(results[2].run).toBeNull();
    const stats = await readStatsInput(join(session, "logs"), { last: 10 }, { withProse: false });
    expect(stats.runs).toHaveLength(1);
  });

  it("caps --parallel at maxParallelIssues, so no two loops overlap", async () => {
    await expect(replay("capped", 1, { parallel: 2, config: config({ maxParallelIssues: 1 }) })).resolves.toBe(0);

    expect((await manifestOf("capped")).parallel).toBe(1);
    expect(seams.maxActive).toBe(1);
  });

  it("runs --parallel loops at once when maxParallelIssues allows it", async () => {
    await expect(replay("wide", 1, { parallel: 2, config: config({ maxParallelIssues: 2 }) })).resolves.toBe(0);

    expect((await manifestOf("wide")).parallel).toBe(2);
    expect(seams.maxActive).toBe(2);
  });

  it("records a REJECTED terminal, admits no further case, keeps the finished results and rejects", async () => {
    const cases = await casesFile(caseFileOf({ cases: [replayCase(7), replayCase(8), replayCase(9)] }));
    seams.rejects.add("8");

    await expect(replay("boom", 1, { parallel: 2, config: config({ maxParallelIssues: 2 }), cases }))
      .rejects.toThrow("loop #8 exploded");

    expect(seams.loops.map((loop) => loop.issue).sort()).toEqual(["7", "8"]);
    const { results } = await manifestOf("boom");
    expect(results.map((r: Record<string, unknown>) => [r.issue, r.status])).toEqual([[7, "ran"]]);
    const logs = join(sessionOf("boom"), "logs");
    const [run] = await readdir(logs);
    const events = (await readFile(join(logs, run ?? "", "events.jsonl"), "utf8"))
      .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
    expect(events.filter((e) => e.kind === "terminal").map((e) => [e.issue, e.terminal, e.reason])).toEqual([
      [8, "REJECTED", "loop #8 exploded"],
      [7, "DONE", null],
    ]);
  });

  it("refuses a label that already exists", async () => {
    await expect(replay("again", 1)).resolves.toBe(0);
    await expect(replay("again", 1)).rejects.toThrow(/already exists/);
    expect(seams.loops).toHaveLength(2);
  });

  describe("refusals before a token is spent", () => {
    it("refuses a case file that is not JSON", async () => {
      const cases = await writeCases("{nope");
      await expect(replay("bad", 1, { cases })).rejects.toThrow(/cases\.json is not JSON: /);
      expect(seams.loops).toEqual([]);
    });

    it("refuses an invalid case file, listing every violation", async () => {
      const cases = await writeCases(caseFileOf({ replayCases: 2, cases: [] }));
      await expect(replay("bad", 1, { cases })).rejects.toThrow(
        /cases\.json:\nreplayCases is not 1\ncases is not a non-empty array$/,
      );
    });

    it.each([
      ["repo", { repo: "other/app" }, "other/app main, but the config names acme/app main"],
      ["source branch", { sourceBranch: "dev" }, "acme/app dev, but the config names acme/app main"],
    ])("refuses a case file frozen from another %s", async (_, change, named) => {
      const cases = await writeCases(caseFileOf(change));
      await expect(replay("bad", 1, { cases })).rejects.toThrow(new RegExp(`was frozen from ${named}$`));
    });

    it("refuses with no base cache, telling the human to freeze first", async () => {
      const cases = await writeCases();
      await expect(replay("bad", 1, { cases })).rejects.toThrow(/No replay base cache at .*; run `replay freeze` first\./);
    });

    it("refuses a seed the base cache lacks, listing the issue and sha", async () => {
      const lost = "1".repeat(40);
      const cases = await casesFile(caseFileOf({ cases: [replayCase(7), { ...replayCase(8), seedSha: lost }] }));
      await expect(replay("bad", 1, { cases })).rejects.toThrow(
        new RegExp(`Seed\\(s\\) missing from .*; freeze again:\\n#8 ${lost}$`),
      );
      expect(seams.loops).toEqual([]);
    });
  });
});

describe("replay report (#195)", { timeout: SESSION_TIMEOUT }, () => {
  // A case file whose #7 names an earlier session's first run as its original.
  async function casesWithOriginal(): Promise<string> {
    await expect(replay("orig", 1)).resolves.toBe(0);
    const logsDir = join(sessionOf("orig"), "logs");
    const [run] = await readdir(logsDir);
    const landed = { merge: "b".repeat(40), tip: "c".repeat(40), diff: { files: 4, insertions: 40, deletions: 2 } };
    return await writeCases(caseFileOf({
      cases: [{ ...replayCase(7), original: { logsDir, run }, landed }, replayCase(8)],
    }));
  }

  it("lays each case's original beside every session, each repeat read from its own run", async () => {
    const cases = await casesWithOriginal();
    seams.terminals.set("8", {
      type: "NEEDS-HUMAN", cause: "gate-red", failureTrace: "red", latestReviewerProse: null,
      budgetExhausted: null, strandedHead: null, specGaps: [],
    } as Terminal);
    await expect(replay("base", 2, { cases })).resolves.toBe(0);
    seams.terminals.clear();
    await expect(replay("cand", 1, { cases })).resolves.toBe(0);

    const result = await report([sessionOf("base"), sessionOf("cand")]);

    expect(result.sessions.map((session) => [session.label, session.repeats])).toEqual([["base", 2], ["cand", 1]]);
    const columns = (issue: number) => result.cases.find((c) => c.issue === issue)!.columns.map((col) => ({
      label: col.label, runs: col.runs, outcomes: col.outcomes, gate: col.gate,
      gateRounds: col.rounds.gate, files: col.diff.files,
    }));
    const one = (value: number) => ({ of: 1, n: 1, min: value, median: value, max: value });
    const two = (value: number) => ({ of: 2, n: 2, min: value, median: value, max: value });
    expect(columns(7)).toEqual([
      { label: "original", runs: 1, outcomes: { DONE: 1 }, gate: { green: 1, red: 0, unknown: 0 }, gateRounds: one(1), files: one(4) },
      { label: "base", runs: 2, outcomes: { DONE: 2 }, gate: { green: 2, red: 0, unknown: 0 }, gateRounds: two(1), files: two(1) },
      { label: "cand", runs: 1, outcomes: { DONE: 1 }, gate: { green: 1, red: 0, unknown: 0 }, gateRounds: one(1), files: one(1) },
    ]);
    expect(columns(8).map((col) => [col.label, col.runs, col.outcomes])).toEqual([
      ["original", 0, {}],
      ["base", 2, { "NEEDS-HUMAN": 2 }],
      ["cand", 1, { DONE: 1 }],
    ]);
  });

  it("refuses sessions that ran different case files", async () => {
    await expect(replay("base", 1)).resolves.toBe(0);
    await expect(replay("cand", 1, { cases: await casesWithOriginal() })).resolves.toBe(0);

    await expect(report([sessionOf("base"), sessionOf("cand")])).rejects.toThrow(/^The sessions ran different case files:\n/);
  });

  it("refuses a case file that has changed since the sessions ran it", async () => {
    await expect(replay("base", 1)).resolves.toBe(0);
    await writeCases(caseFileOf({ cases: [replayCase(7)] }));

    await expect(report([sessionOf("base")])).rejects.toThrow(/cases\.json has changed since the sessions ran it\.$/);
  });

  it("refuses a directory whose replay.json is no session manifest", async () => {
    await writeFile(join(root, "replay.json"), JSON.stringify({ replayCases: 1 }));

    await expect(report([root])).rejects.toThrow(/replay\.json is not a replay session manifest$/);
  });
});
