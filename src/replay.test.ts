import { describe, expect, it } from "vitest";

import {
  type ReplayCase,
  caseCacheRefUpdates,
  commentsAtCutoff,
  lastDoneAdmission,
  parseNumstat,
  parseReplayCases,
  planReplay,
  renderReplayPlan,
  stripForgeCredentials,
} from "./replay.js";

const SEED = "a".repeat(40);

const replayCase = (issue: number, extra: Partial<ReplayCase> = {}): ReplayCase => ({
  issue,
  title: `Issue ${issue}`,
  seedSha: SEED,
  seedFrom: "recorded",
  issueJson: { title: `Issue ${issue}`, body: "", comments: [] },
  issueFrom: "recorded",
  original: { logsDir: "/logs", run: "run-1" },
  landed: { merge: "b".repeat(40), tip: "c".repeat(40), diff: { files: 1, insertions: 2, deletions: 0 } },
  ...extra,
} as ReplayCase);

const caseFile = (cases: readonly unknown[]) => ({
  replayCases: 1,
  repo: "acme/app",
  sourceBranch: "main",
  cases,
});

describe("parseReplayCases (#195)", () => {
  it("accepts a well-formed case file", () => {
    const file = caseFile([
      replayCase(1),
      replayCase(2, { issueFrom: "reconstructed", editedAfterAdmission: true, original: null, landed: null }),
    ]);
    expect(parseReplayCases(file)).toEqual({ cases: file });
  });

  it("lists every violation, not the first", () => {
    expect(parseReplayCases({
      replayCases: 2,
      repo: "app",
      sourceBranch: "",
      cases: [
        replayCase(1, { seedSha: "abc" }),
        replayCase(1, { issueFrom: "reconstructed" } as Partial<ReplayCase>),
        { ...replayCase(0), seedFrom: "guess", issueJson: [], editedAfterAdmission: false, original: { run: "" } },
        replayCase(3, { landed: { merge: SEED, tip: "nope", diff: { files: -1, insertions: 0, deletions: 0 } } }),
        "seven",
      ],
    })).toEqual({
      errors: [
        "replayCases is not 1",
        "repo is not owner/name",
        "sourceBranch is not a non-empty string",
        "cases[0].seedSha is not a 40-hex sha",
        "cases[1].issue #1 is listed twice",
        "cases[1].editedAfterAdmission is not a boolean",
        "cases[2].issue is not a positive integer",
        "cases[2].seedFrom is not recorded, merge-base or manual",
        "cases[2].issueJson is not an object",
        "cases[2].editedAfterAdmission is set on a recorded issue",
        "cases[2].original is neither null nor { logsDir, run }",
        "cases[3].landed is neither null nor { merge, tip, diff } with 40-hex shas and counts",
        "cases[4] is not an object",
      ],
    });
  });

  it.each([
    [null, "the case file is not a JSON object"],
    [[], "the case file is not a JSON object"],
    [caseFile([]), "cases is not a non-empty array"],
  ])("refuses %j", (value, error) => {
    expect(parseReplayCases(value)).toEqual({ errors: [error] });
  });
});

describe("planReplay (#195)", () => {
  const cases = [replayCase(1), replayCase(2)];
  const order = (repeats: number) =>
    planReplay(cases, repeats).map((repeat) => repeat.map((run) => `${run.repeat}:${run.case.issue}`));

  it("runs every case once for k = 1", () => {
    expect(order(1)).toEqual([["1:1", "1:2"]]);
  });

  it("runs repeat-major for k = 3", () => {
    expect(order(3)).toEqual([["1:1", "1:2"], ["2:1", "2:2"], ["3:1", "3:2"]]);
  });
});

describe("stripForgeCredentials (#195)", () => {
  it("removes every forge credential and keeps the rest", () => {
    expect(stripForgeCredentials({
      GH_TOKEN: "t",
      GITHUB_TOKEN: "t",
      GH_ENTERPRISE_TOKEN: "t",
      SSH_AUTH_SOCK: "/agent.sock",
      CLAUDE_CODE_OAUTH_TOKEN: "c",
      GH_HOST: "github.com",
    })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "c", GH_HOST: "github.com" });
  });
});

describe("caseCacheRefUpdates (#195)", () => {
  it("deletes heads, tags and remotes and writes the one seed ref", () => {
    expect(caseCacheRefUpdates(
      [
        "refs/heads/main",
        "refs/remotes/origin/main",
        "refs/remotes/origin/sandbar/issue-9-later",
        "refs/sandbar/lock",
        "refs/tags/v1",
      ],
      "main",
      SEED,
    )).toEqual([
      "delete refs/heads/main",
      "delete refs/remotes/origin/sandbar/issue-9-later",
      "delete refs/sandbar/lock",
      "delete refs/tags/v1",
      `update refs/remotes/origin/main ${SEED}`,
    ]);
  });
});

describe("commentsAtCutoff (#195)", () => {
  it("keeps comments made by the cutoff, inclusive, and drops undated ones", () => {
    const issue = {
      title: "t",
      body: "b",
      comments: [
        { body: "before", createdAt: "2026-10-28T12:00:00Z" },
        { body: "at", createdAt: "2026-10-28T12:00:01Z" },
        { body: "after", createdAt: "2026-10-28T12:00:01.001Z" },
        { body: "undated" },
      ],
    };
    expect(commentsAtCutoff(issue, "2026-10-28T12:00:01.000Z").comments?.map((c) => c.body))
      .toEqual(["before", "at"]);
  });
});

describe("lastDoneAdmission (#195)", () => {
  const admitted = (ts: string, extra: object = {}) =>
    ({ kind: "admitted", issue: 7, title: "Seven", ts, ...extra });
  const terminal = (outcome: string) => ({ kind: "terminal", issue: 7, terminal: outcome });

  it("is the admission behind the last DONE, with its replay fields", () => {
    expect(lastDoneAdmission("run-x", [
      admitted("t1", { seedSha: "old" }),
      terminal("DONE"),
      { kind: "admitted", issue: 8, title: "Eight", ts: "t2" },
      admitted("t3", { seedSha: SEED, issueSnapshot: "issue-snapshot-2.json" }),
      terminal("DONE"),
      admitted("t4"),
      terminal("NEEDS-HUMAN"),
    ], 7)).toEqual({
      run: "run-x",
      ts: "t3",
      title: "Seven",
      seedSha: SEED,
      issueSnapshot: "issue-snapshot-2.json",
    });
  });

  it("is null without a DONE, and reads an older record's missing fields as null", () => {
    expect(lastDoneAdmission("run-x", [admitted("t1"), terminal("HARD-ERROR")], 7)).toBeNull();
    expect(lastDoneAdmission("run-x", [admitted("t1"), terminal("DONE")], 7))
      .toMatchObject({ seedSha: null, issueSnapshot: null });
  });
});

describe("parseNumstat (#195)", () => {
  it("counts files and lines, a binary file as no lines", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\n-\t-\timg.png\n10\t0\tsrc/b.ts\n"))
      .toEqual({ files: 3, insertions: 13, deletions: 1 });
    expect(parseNumstat("")).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});

describe("renderReplayPlan (#195)", () => {
  it("states the spend, the routing and the shared quota", () => {
    expect(renderReplayPlan({
      label: "baseline",
      cases: 12,
      repeats: 3,
      parallel: 2,
      routing: {
        implementer: { agent: "claude", model: "opus", effort: "high" },
        adjudicator: { agent: "codex", model: "gpt-5.6", effort: null },
      },
    })).toBe([
      "replay baseline: 12 cases × 3 = 36 runs, 2 at a time",
      "  implementer  claude opus (effort high)",
      "  adjudicator  codex gpt-5.6",
      "Every run spends real tokens from the same model quota as any sandbar daemon on this account.",
    ].join("\n"));
  });
});
