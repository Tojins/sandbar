// #195 — `replay run` end to end over real git, with podman, the images and
// the inner loop faked: what a session leaves on disk, that its records are
// ordinary run records the scorecard reads, that nothing it hands a sandbox
// holds a forge credential, and how a quota stop closes the session.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const { ReplayRefusedError, replayLayout, runReplay } = await import("./replay-run.js");

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
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(root, { recursive: true, force: true });
});

const config = () => resolveConfig({
  ghOwner: "acme", ghRepo: "app", developers: "anyone", cwd: checkout, workDir: ".sandbar",
  sandboxImage: "image", botName: "bot", botEmail: "bot@example.com",
  sandboxHooks: {}, env: { GH_TOKEN: "token", CLAUDE_CODE_OAUTH_TOKEN: "claude" },
  gateStack: {
    containers: [{ name: "app", image: "image", mountWorktree: "/work", hold: true }],
    steps: [{ name: "test", in: "app", command: ["true"] }],
  },
});

async function casesFile(): Promise<string> {
  await ensureRepoCache(replayLayout(config()), () => undefined);
  const replayCase = (issue: number) => ({
    issue, title: `Issue ${issue}`, seedSha: seed, seedFrom: "recorded",
    issueJson: { title: `Issue ${issue} as admitted`, body: "", comments: [] },
    issueFrom: "recorded", original: null, landed: null,
  });
  const path = join(root, "cases.json");
  await writeFile(path, JSON.stringify({ replayCases: 1, repo: "acme/app", sourceBranch: "main", cases: [replayCase(7), replayCase(8)] }));
  return path;
}

const replay = async (label: string, repeats: number) => runReplay({
  config: config(),
  configPath: join(checkout, "sandbar.config.mjs"),
  casesFile: await casesFile(),
  label,
  repeats,
  parallel: 1,
  log: () => undefined,
});

describe("replay run (#195)", () => {
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

  it("stops at a quota, recording every case not yet started as not run, and answers 3", async () => {
    seams.terminals.set("7", { type: "QUOTA", provider: "codex", window: "five_hour", specGaps: [] } as Terminal);

    await expect(replay("quota", 2)).resolves.toBe(3);

    expect(seams.loops.map((loop) => loop.issue)).toEqual(["7"]);
    const session = join(replayLayout(config()).stateDir, "sessions", "quota");
    const { results } = JSON.parse(await readFile(join(session, "replay.json"), "utf8"));
    expect(results.map((r: Record<string, unknown>) => [r.repeat, r.issue, r.status, r.terminal ?? r.reason])).toEqual([
      [1, 7, "ran", "QUOTA"],
      [1, 8, "not-run", "QUOTA: codex five_hour"],
      [2, 7, "not-run", "QUOTA: codex five_hour"],
      [2, 8, "not-run", "QUOTA: codex five_hour"],
    ]);
    expect(results[2].run).toBeNull();
    const stats = await readStatsInput(join(session, "logs"), { last: 10 }, { withProse: false });
    expect(stats.runs).toHaveLength(1);
  });

  it("refuses a label that already exists", async () => {
    await expect(replay("again", 1)).resolves.toBe(0);
    await expect(replay("again", 1)).rejects.toThrow(ReplayRefusedError);
    expect(seams.loops).toHaveLength(2);
  });
});
