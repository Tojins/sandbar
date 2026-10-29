// #195 decision 3 and freeze, against real git. `upstream.git` stands in for
// GitHub and `checkout` for the operator's clone of it. What is asserted is
// what git does with the case cache's layout: one ref, an origin that is
// itself, pushes refused both out of it and into it, the existing seeding
// code reading it correctly, and nothing reaching the stand-in for GitHub.
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandbarError } from "./errors.js";
import { ensureIssueBranch } from "./git-ops.js";
import { ensureRepoCache, repoLayout } from "./repo-cache.js";
import type { ReplayCases } from "./replay.js";
import { freeze, prepareCaseCache, replayLayout } from "./replay-run.js";

const exec = promisify(execFile);
const IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = async (cwd: string, args: readonly string[], env: Record<string, string> = {}): Promise<string> =>
  (await exec("git", [...args], { cwd, env: { ...process.env, ...IDENTITY, LC_ALL: "C", ...env } })).stdout.trim();

const BRANCH = "sandbar/issue-7-fixture";

type Fixture = {
  readonly root: string;
  readonly upstream: string;
  readonly checkout: string;
  readonly seed: string;
  readonly tip: string;
  readonly merge: string;
};

let fixture: Fixture;
const savedPath = process.env.PATH;

// main: seed ── merge(issue 7) ── later
//          └── tip (the issue branch, authored 2026-01-01)
// plus a later branch and a tag on upstream that no case cache may carry.
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbar-replay-git-"));
  const upstream = join(root, "upstream.git");
  const checkout = join(root, "checkout");
  await exec("git", ["init", "-q", "--bare", "-b", "main", upstream]);
  await exec("git", ["clone", "-q", upstream, checkout]);
  await git(checkout, ["checkout", "-q", "-b", "main"]);
  await writeFile(join(checkout, "a.txt"), "a\n");
  await git(checkout, ["add", "-A"]);
  await git(checkout, ["commit", "-qm", "seed"]);
  const seed = await git(checkout, ["rev-parse", "HEAD"]);
  await git(checkout, ["checkout", "-q", "-b", BRANCH]);
  await writeFile(join(checkout, "b.txt"), "b\n");
  await git(checkout, ["add", "-A"]);
  await git(checkout, ["commit", "-qm", "work"], { GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z" });
  const tip = await git(checkout, ["rev-parse", "HEAD"]);
  await git(checkout, ["checkout", "-q", "main"]);
  await git(checkout, ["merge", "-q", "--no-ff", "-m", "Merge sandbar/issue-7: Fixture", BRANCH]);
  const merge = await git(checkout, ["rev-parse", "HEAD"]);
  await writeFile(join(checkout, "c.txt"), "c\n");
  await git(checkout, ["add", "-A"]);
  await git(checkout, ["commit", "-qm", "later"]);
  await git(checkout, ["tag", "v1"]);
  await git(checkout, ["push", "-q", "origin", "main", "v1", `${BRANCH}:refs/heads/sandbar/issue-9-later`]);
  fixture = { root, upstream, checkout, seed, tip, merge };
});

afterEach(async () => {
  process.env.PATH = savedPath;
  await rm(fixture.root, { recursive: true, force: true });
});

const upstreamRefs = (): Promise<string> => git(fixture.upstream, ["for-each-ref"]);

async function baseCache(): Promise<string> {
  const layout = repoLayout(fixture.checkout, ".sandbar/replay");
  await ensureRepoCache(layout, () => undefined);
  return layout.repoDir;
}

async function caseCache(): Promise<{ readonly caseDir: string; readonly repoDir: string }> {
  const caseDir = join(fixture.root, "case");
  const layout = await prepareCaseCache({
    baseRepoDir: await baseCache(),
    caseDir,
    hostCwd: fixture.checkout,
    sourceBranch: "main",
    seedSha: fixture.seed,
  });
  return { caseDir, repoDir: layout.repoDir };
}

describe("a replay case cache (#195)", () => {
  it("holds only origin/main at the seed, with itself as origin and a push url that does not exist", async () => {
    const { caseDir, repoDir } = await caseCache();

    expect(await git(repoDir, ["for-each-ref", "--format=%(refname) %(objectname)"]))
      .toBe(`refs/remotes/origin/main ${fixture.seed}`);
    expect(await git(repoDir, ["config", "--get", "remote.origin.url"])).toBe(repoDir);
    expect(await git(repoDir, ["config", "--get", "remote.origin.pushurl"])).toBe(join(caseDir, "push-forbidden"));
  });

  it("refuses a push out of it and out of a hardlink clone of it", async () => {
    const { repoDir } = await caseCache();
    const clone = join(fixture.root, "clone");
    await exec("git", ["clone", "-q", "--local", repoDir, clone]);
    await git(clone, ["checkout", "-q", "-b", "x", fixture.seed]);

    await expect(git(repoDir, ["push", "origin", `${fixture.seed}:refs/heads/x`])).rejects.toThrow();
    await expect(git(clone, ["push", "origin", "x"])).rejects.toThrow(/accepts no push/);
    expect(await git(repoDir, ["for-each-ref", "--format=%(refname)"])).toBe("refs/remotes/origin/main");
  });

  it("seeds an issue branch at the seed with no origin sync, then reads in sync", async () => {
    const { repoDir } = await caseCache();

    expect(await ensureIssueBranch(repoDir, BRANCH, "main")).toEqual({ ref: "origin/main", chunkBranch: null });
    expect(await git(repoDir, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(fixture.seed);
    expect(await ensureIssueBranch(repoDir, BRANCH, "main")).toMatchObject({
      originSync: { kind: "in-sync", tip: fixture.seed },
    });
  });

  it("leaves the stand-in for GitHub byte-identical after a loop commits and publishes", async () => {
    const before = await upstreamRefs();
    const { repoDir } = await caseCache();
    await ensureIssueBranch(repoDir, BRANCH, "main");
    // What an attempt does: work in a hardlink clone, publish into the cache,
    // and — here deliberately — try every push it could.
    const clone = join(fixture.root, "issue-clone");
    await exec("git", ["clone", "-q", "--local", repoDir, clone]);
    await git(clone, ["checkout", "-q", BRANCH]);
    await writeFile(join(clone, "d.txt"), "d\n");
    await git(clone, ["add", "-A"]);
    await git(clone, ["commit", "-qm", "attempt"]);
    await expect(git(clone, ["push", "origin", BRANCH])).rejects.toThrow(/accepts no push/);
    await git(repoDir, ["fetch", "-q", clone, `+refs/heads/${BRANCH}:refs/heads/${BRANCH}`]);
    await expect(git(repoDir, ["push", "origin", BRANCH])).rejects.toThrow(/push-forbidden/);

    expect(await upstreamRefs()).toBe(before);
  });
});

describe("replay freeze (#195)", () => {
  const config = () => ({
    cwd: fixture.checkout,
    workDir: ".sandbar",
    ghOwner: "acme",
    ghRepo: "app",
    sourceBranch: "main",
  });

  // A `gh` answering the two reads a reconstruction makes.
  async function ghShim(): Promise<void> {
    const bin = join(fixture.root, "bin");
    await mkdir(bin);
    const issue = JSON.stringify({
      title: "Fixture, renamed",
      body: "today's body",
      comments: [
        { body: "early", createdAt: "2000-01-01T00:00:00Z" },
        { body: "late", createdAt: "2999-01-01T00:00:00Z" },
      ],
    });
    const edited = JSON.stringify({ data: { repository: { issue: { lastEditedAt: "2999-01-01T00:00:00Z" } } } });
    await writeFile(join(bin, "issue.json"), issue);
    await writeFile(join(bin, "edited.json"), edited);
    await writeFile(join(bin, "gh"), [
      "#!/bin/sh",
      `case "$1 $2" in`,
      `  "issue view") cat "${bin}/issue.json" ;;`,
      `  "api graphql") cat "${bin}/edited.json" ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"));
    await chmod(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
  }

  // Issue 8's last DONE, admitted with both replay fields, and with the set
  // its writer filed when `scenarios` is given.
  async function recordedRun(
    logsDir: string,
    opts: { readonly name?: string; readonly title?: string; readonly snapshot?: unknown; readonly scenarios?: unknown } = {},
  ): Promise<void> {
    const run = join(logsDir, opts.name ?? "run-2026-10-28T00-00-00-000Z");
    await mkdir(join(run, "issue-8"), { recursive: true });
    const events = [
      { kind: "run-start", schemaVersion: 6, ts: "2026-10-28T00:00:00.000Z" },
      {
        kind: "admitted", issue: 8, title: opts.title ?? "Recorded", branch: "sandbar/issue-8-recorded", chunk: null,
        seedRef: "origin/main", seedSha: fixture.seed, issueSnapshot: "issue-snapshot-1.json",
        ts: "2026-10-28T00:00:01.000Z",
      },
      ...(opts.scenarios === undefined ? [] : [{
        kind: "scenario-writer", issue: 8, result: "completed", scenarios: 1, ts: "2026-10-28T00:00:01.500Z",
      }]),
      { kind: "terminal", issue: 8, terminal: "DONE", reason: null, durationMs: 1, ts: "2026-10-28T00:00:02.000Z" },
    ];
    await writeFile(join(run, "events.jsonl"), events.map((e, i) => `${JSON.stringify({ ...e, seq: i + 1 })}\n`).join(""));
    await writeFile(join(run, "issue-8", "issue-snapshot-1.json"), JSON.stringify(opts.snapshot ?? { title: "Recorded", body: "then" }));
    if (opts.scenarios !== undefined) {
      await writeFile(join(run, "issue-8", "scenarios-1.json"), JSON.stringify(opts.scenarios));
    }
  }

  const SET = {
    version: 1,
    issue: 8,
    seed: { ref: "origin/main", sha: "a".repeat(40) },
    writer: { provider: "claude", model: "m", effort: null },
    scenarios: [{ id: "S1", title: "t", needs: ["cli"], area: [], given: ["g"], when: ["w"], then: ["t"] }],
  };

  const frozenCases = async (issues: readonly number[], logsDir: string): Promise<ReplayCases["cases"]> => {
    const out = join(fixture.root, `cases-${issues.join("-")}.json`);
    await freeze({ config: config(), issues, logsDir, out, log: () => undefined });
    return (JSON.parse(await readFile(out, "utf8")) as ReplayCases).cases;
  };

  it("seeds from the landing merge's base or the record, and reconstructs or reads the issue", async () => {
    await ghShim();
    const logsDir = join(fixture.root, "logs");
    await recordedRun(logsDir);
    const out = join(fixture.root, "cases.json");

    await freeze({ config: config(), issues: [7, 8], logsDir, out, log: () => undefined });

    const file = JSON.parse(await readFile(out, "utf8")) as ReplayCases;
    expect(file).toEqual({
      replayCases: 1,
      repo: "acme/app",
      sourceBranch: "main",
      cases: [
        {
          issue: 7,
          title: "Fixture",
          seedSha: fixture.seed,
          seedFrom: "merge-base",
          issueFrom: "reconstructed",
          editedAfterAdmission: true,
          issueJson: {
            title: "Fixture, renamed",
            body: "today's body",
            comments: [{ body: "early", createdAt: "2000-01-01T00:00:00Z" }],
          },
          original: null,
          landed: { merge: fixture.merge, tip: fixture.tip, diff: { files: 1, insertions: 1, deletions: 0 } },
        },
        {
          issue: 8,
          title: "Recorded",
          seedSha: fixture.seed,
          seedFrom: "recorded",
          issueFrom: "recorded",
          issueJson: { title: "Recorded", body: "then" },
          original: { logsDir, run: "run-2026-10-28T00-00-00-000Z" },
          landed: null,
        },
      ],
    });
    const base = replayLayout(config());
    expect(await git(base.repoDir, ["config", "--get", "remote.origin.pushurl"]))
      .toBe(join(base.stateDir, "push-forbidden"));
  });

  it("takes an issue's admission from the newest run that has a DONE for it", async () => {
    const logsDir = join(fixture.root, "logs");
    await recordedRun(logsDir, { name: "run-2026-10-01T00-00-00-000Z", title: "Older" });
    await recordedRun(logsDir, { name: "run-2026-10-02T00-00-00-000Z", title: "Newer" });

    expect((await frozenCases([8], logsDir)).map((c) => [c.title, c.original?.run]))
      .toEqual([["Newer", "run-2026-10-02T00-00-00-000Z"]]);
  });

  it("skips a newer run whose record is missing or unreadable, and anything that is no run", async () => {
    const logsDir = join(fixture.root, "logs");
    await recordedRun(logsDir, { name: "run-2026-10-01T00-00-00-000Z", title: "Older" });
    await mkdir(join(logsDir, "run-2026-10-02T00-00-00-000Z"), { recursive: true });
    await mkdir(join(logsDir, "run-2026-10-03T00-00-00-000Z"), { recursive: true });
    await writeFile(join(logsDir, "run-2026-10-03T00-00-00-000Z", "events.jsonl"), "not json\n");
    await mkdir(join(logsDir, "scratch"), { recursive: true });

    expect((await frozenCases([8], logsDir)).map((c) => [c.title, c.original?.run]))
      .toEqual([["Older", "run-2026-10-01T00-00-00-000Z"]]);
  });

  it("reconstructs from the landing merge when the logs directory does not exist", async () => {
    await ghShim();

    const [c] = await frozenCases([7], join(fixture.root, "no-such-logs"));

    expect(c).toMatchObject({ issue: 7, seedFrom: "merge-base", issueFrom: "reconstructed", original: null });
  });

  it("refuses a recorded issue snapshot that is not an issue", async () => {
    const logsDir = join(fixture.root, "logs");
    await recordedRun(logsDir, { snapshot: { title: 7 } });
    const out = join(fixture.root, "cases.json");

    await expect(freeze({ config: config(), issues: [8], logsDir, out, log: () => undefined }))
      .rejects.toThrow(/issue-snapshot-1\.json is not an issue snapshot: title is not a string/);
    await expect(readFile(out)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // #240
  it("pins the set the admission's writer filed", async () => {
    const logsDir = join(fixture.root, "logs");
    await recordedRun(logsDir, { scenarios: SET });

    const [c] = await frozenCases([8], logsDir);

    expect(c?.scenarios).toEqual(SET);
  });

  it("refuses a filed set that is not a scenario set", async () => {
    const logsDir = join(fixture.root, "logs");
    await recordedRun(logsDir, { scenarios: { ...SET, scenarios: [] } });
    const out = join(fixture.root, "cases.json");

    await expect(freeze({ config: config(), issues: [8], logsDir, out, log: () => undefined }))
      .rejects.toThrow(/scenarios-1\.json is not a scenario set: scenarios is not a list of 1 to 20 scenarios/);
    await expect(readFile(out)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes nothing when an issue has no seed source", async () => {
    await ghShim();
    const out = join(fixture.root, "cases.json");
    await expect(freeze({ config: config(), issues: [7, 9], logsDir: join(fixture.root, "logs"), out, log: () => undefined }))
      .rejects.toThrow(SandbarError);
    await expect(readFile(out)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
