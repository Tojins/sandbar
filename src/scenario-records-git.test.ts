// `appendScenarioRecords` against real git and a real records directory.
// Every git call names its directory.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ScenarioSet } from "./scenario-parser.js";
import { type ScenarioRecord, appendScenarioRecords } from "./scenario-records.js";
import type { LedgerEntry } from "./verifier.js";

const exec = promisify(execFile);
const git = async (repo: string, ...args: string[]): Promise<string> =>
  (await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
  })).stdout;

describe("appendScenarioRecords", () => {
  let root: string;
  let repo: string;
  let sha: string;
  const stateDir = () => join(root, "state");
  const roundDir = (round: number) => join(root, "logs", `verifier-round-${round}`);
  const scenario = (n: number, area: string[]) => ({
    id: `S${n}`, title: `t${n}`, needs: ["cli" as const], area, given: [`g${n}`], when: [`w${n}`], then: [`t${n}`],
  });
  const set: ScenarioSet = {
    version: 1,
    issue: 268,
    seed: { ref: "origin/main", sha: "seed" },
    writer: { provider: "claude", model: "opus", effort: null },
    scenarios: [scenario(1, ["src/ui"]), scenario(2, ["src/gate.ts"]), scenario(3, ["docs"]), scenario(4, [])],
  };
  const domains = [
    { name: "ui", description: "ui", paths: ["src/ui/**"], sanity: [] },
    { name: "gate", description: "gate", paths: ["src/gate.ts"], sanity: [] },
  ];
  const records = async (): Promise<ScenarioRecord[]> =>
    (await readFile(join(stateDir(), "scenarios", "records.jsonl"), "utf8"))
      .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as ScenarioRecord);
  const append = (ledger: ReadonlyMap<string, LedgerEntry>) =>
    appendScenarioRecords({ stateDir: stateDir(), worktree: repo, sha, set, ledger, domains, roundDir });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbar-scenario-records-"));
    repo = join(root, "repo");
    await mkdir(join(repo, "src", "ui"), { recursive: true });
    await writeFile(join(repo, "src", "ui", "app.ts"), "app");
    await writeFile(join(repo, "src", "gate.ts"), "gate");
    await git(root, "init", "-q", "-b", "main", repo);
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "seed");
    sha = (await git(repo, "rev-parse", "HEAD")).trim();
    await mkdir(join(roundDir(1), "S1"), { recursive: true });
    await writeFile(join(roundDir(1), "S1", "run.sh"), "round 1");
    await mkdir(join(roundDir(2), "S1"), { recursive: true });
    await writeFile(join(roundDir(2), "S1", "run.sh"), "round 2");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("appends one record per scenario, with a pass's scripts from the round that passed it", async () => {
    await append(new Map<string, LedgerEntry>([
      ["S1", { status: "pass", head: sha, round: 2 }],
      ["S2", { status: "retired" }],
      ["S3", { status: "fail", head: sha, round: 1 }],
    ]));

    const base = { issue: 268, sha };
    expect(await records()).toEqual([
      { ...base, id: "S1", given: ["g1"], when: ["w1"], then: ["t1"], domains: ["ui"], verdict: "pass",
        scripts: join("issue-268", sha, "S1") },
      { ...base, id: "S2", given: ["g2"], when: ["w2"], then: ["t2"], domains: ["gate"],
        verdict: "fail-overruled", scripts: null },
      { ...base, id: "S3", given: ["g3"], when: ["w3"], then: ["t3"], domains: [], verdict: "unverified",
        scripts: null },
      { ...base, id: "S4", given: ["g4"], when: ["w4"], then: ["t4"], domains: [], verdict: "unverified",
        scripts: null },
    ]);
    expect(await readFile(join(stateDir(), "scenarios", "issue-268", sha, "S1", "run.sh"), "utf8"))
      .toBe("round 2");
  });

  it("records a pass whose runner left no directory without scripts", async () => {
    await rm(join(roundDir(2), "S1"), { recursive: true });
    await append(new Map<string, LedgerEntry>([["S1", { status: "pass", head: sha, round: 2 }]]));

    expect((await records())[0]).toMatchObject({ id: "S1", verdict: "pass", scripts: null });
    expect(existsSync(join(stateDir(), "scenarios", "issue-268"))).toBe(false);
  });

  it("appends a second DONE at the same sha, its copy replacing the first's", async () => {
    await append(new Map<string, LedgerEntry>([["S1", { status: "pass", head: sha, round: 1 }]]));
    await writeFile(join(stateDir(), "scenarios", "issue-268", sha, "S1", "stale.txt"), "stale");
    await append(new Map<string, LedgerEntry>([["S1", { status: "pass", head: sha, round: 2 }]]));

    expect((await records()).map((r) => `${r.id} ${r.verdict}`)).toEqual([
      "S1 pass", "S2 unverified", "S3 unverified", "S4 unverified",
      "S1 pass", "S2 unverified", "S3 unverified", "S4 unverified",
    ]);
    const copy = join(stateDir(), "scenarios", "issue-268", sha, "S1");
    expect(await readFile(join(copy, "run.sh"), "utf8")).toBe("round 2");
    expect(existsSync(join(copy, "stale.txt"))).toBe(false);
  });
});
