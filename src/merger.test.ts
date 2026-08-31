import { describe, expect, it } from "vitest";

import { SandbarError } from "./errors.js";
import type { PushOutcome, VerifyAdapter } from "./forge-verify.js";
import type { MergerGateOutput } from "./merger.js";
import {
  SOURCE_TARGET,
  buildInstallFailedComment,
  buildForgeUnverifiedComment,
  MergerError,
  READY_FOR_AGENT_LABEL,
  groupByChunk,
  type IssueRef,
  type MergerAdapter,
  type PushResult,
  issueNumberOf,
  runMergerWithAdapter,
  sortIssuesAsc,
} from "./merger.js";

function issue(n: number, title = `t-${n}`): IssueRef {
  return {
    id: String(n),
    title,
    branch: `sandbar/issue-${n}-${title}`,
  };
}

type GateResp = { ok: true } | ({ ok: false } & MergerGateOutput);

type AgentScript = { stdout: string; leavesConflict?: boolean };

type Calls = {
  merges: string[];
  agentRuns: string[];
  isMergeChecks: number;
  conflictDigests: number;
  bodies: string[];
  aborts: number;
  resets: { sha: string }[];
  installs: number;
  gates: number;
  order: string[];
  comments: { n: number; msg: string }[];
  removedLabels: { n: number; label: string }[];
  closes: { n: number; comment: string }[];
  closeAttempts: { n: number }[];
  pushes: number;
  pulls: number;
  chunkBases: string[];
  checkouts: string[];
  chunkPushes: string[];
  chunkPrs: { chunkBranch: string; title: string; body: string }[];
  headReads: number;
};

type Script = {
  merges: ("ok" | "conflict")[];
  agents?: AgentScript[];
  installs?: boolean[];
  gates?: GateResp[];
  pushes?: PushResult[];
  pulls?: boolean[];
  heads?: string[];
  // #60: what origin has for a chunk branch, by branch name. A missing entry
  // means origin has no such branch and the base is the source branch.
  chunkBases?: Record<string, string>;
  chunkPushes?: PushResult[];
  // #62: how the forge answers `ensureChunkPullRequest`. An Error is thrown.
  chunkPrs?: ({ number: number; url: string } | Error)[];
  // Per-issue number of leading close attempts that throw before one succeeds.
  // A value >= total attempts means the close never succeeds. Default 0.
  closeFailsBeforeSuccess?: Record<number, number>;
};

function makeAdapter(script: Script): { adapter: MergerAdapter; calls: Calls } {
  const calls: Calls = {
    merges: [],
    agentRuns: [],
    isMergeChecks: 0,
    conflictDigests: 0,
    bodies: [],
    aborts: 0,
    resets: [],
    installs: 0,
    gates: 0,
    order: [],
    comments: [],
    removedLabels: [],
    closes: [],
    closeAttempts: [],
    pushes: 0,
    pulls: 0,
    chunkBases: [],
    checkouts: [],
    chunkPushes: [],
    chunkPrs: [],
    headReads: 0,
  };
  const closeAttemptsByIssue = new Map<number, number>();
  let mIdx = 0;
  let aIdx = 0;
  let iIdx = 0;
  let gIdx = 0;
  let pIdx = 0;
  let plIdx = 0;
  let cpIdx = 0;
  let prIdx = 0;
  let headIdx = 0;
  let merging = false;

  const adapter: MergerAdapter = {
    async mergeNoFf(i) {
      const r = script.merges[mIdx++];
      calls.merges.push(i.branch);
      calls.order.push("merge");
      if (r === "conflict") merging = true;
      return { ok: r === "ok" };
    },
    async runResolveAgent(_prompt) {
      const entry = script.agents?.[aIdx++];
      if (!entry) throw new Error("runResolveAgent not scripted");
      calls.agentRuns.push("agent");
      calls.order.push("agent");
      if (entry.stdout.includes("<promise>COMMITTED</promise>")) {
        merging = entry.leavesConflict ?? false;
      } else if (
        entry.stdout.includes("<promise>ABANDON</promise>") &&
        entry.leavesConflict !== undefined
      ) {
        merging = entry.leavesConflict;
      }
      return { stdout: entry.stdout };
    },
    async isMergeInProgress() {
      calls.isMergeChecks++;
      return merging;
    },
    async conflictDigest() {
      calls.conflictDigests++;
      return { status: "UU foo", diff: "<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>>" };
    },
    async getIssueBody(id) {
      calls.bodies.push(id);
      return `body-${id}`;
    },
    async getHeadSha() {
      calls.headReads++;
      const idx = headIdx++;
      return script.heads?.[idx] ?? `sha-${idx}`;
    },
    async abortMerge() {
      calls.aborts++;
      calls.order.push("abort");
      merging = false;
    },
    async resetHardSha(sha) {
      calls.resets.push({ sha });
      calls.order.push("reset");
      merging = false;
    },
    async npmInstall() {
      const r = script.installs?.[iIdx++] ?? true;
      calls.installs++;
      calls.order.push("install");
      return { ok: r };
    },
    async runGate() {
      const r = script.gates?.[gIdx++];
      if (r === undefined)
        throw new Error("gate called more times than scripted");
      calls.gates++;
      calls.order.push("gate");
      return r;
    },
    async commentOnIssue(n, msg) {
      calls.comments.push({ n, msg });
    },
    async removeLabel(n, label) {
      calls.removedLabels.push({ n, label });
    },
    async closeIssue(n, comment) {
      const prior = closeAttemptsByIssue.get(n) ?? 0;
      closeAttemptsByIssue.set(n, prior + 1);
      calls.closeAttempts.push({ n });
      const threshold = script.closeFailsBeforeSuccess?.[n] ?? 0;
      if (prior < threshold) {
        throw new SandbarError(
          `merger: failed to close issue #${n} (scripted transient)`,
        );
      }
      calls.closes.push({ n, comment });
    },
    async push() {
      const r = script.pushes?.[pIdx++] ?? { kind: "ok" as const };
      calls.pushes++;
      return r;
    },
    async pullFfOnly() {
      const r = script.pulls?.[plIdx++];
      if (r === undefined) throw new Error("pull called but not scripted");
      calls.pulls++;
      return { ok: r };
    },
    // #60. `chunkBases` scripts what origin has: a branch name mapped to its
    // remote-tracking ref, or nothing for a chunk that has never landed — in
    // which case the real adapter falls back to the source branch, so this
    // does too.
    async chunkBase(branch) {
      calls.chunkBases.push(branch);
      return script.chunkBases?.[branch] ?? "origin/main";
    },
    async checkoutDetached(ref) {
      calls.checkouts.push(ref);
      calls.order.push("checkout");
      return undefined;
    },
    async pushChunkBranch(branch) {
      const r = script.chunkPushes?.[cpIdx++] ?? { kind: "ok" as const };
      calls.chunkPushes.push(branch);
      calls.order.push("chunk-push");
      return r;
    },
    async ensureChunkPullRequest({ chunkBranch, title, body }) {
      calls.chunkPrs.push({ chunkBranch, title, body });
      calls.order.push("chunk-pr");
      const r = script.chunkPrs?.[prIdx++] ?? { number: 7, url: "u7" };
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { adapter, calls };
}

function gateRed(): { ok: false } & MergerGateOutput {
  return {
    ok: false,
    stdout: "x",
    stderr: "y",
    failedStep: "test",
    exitCode: 1,
    containerLogs: "",
  };
}

describe("issueNumberOf", () => {
  it("parses positive integer ids", () => {
    expect(issueNumberOf({ id: "44", title: "x", branch: "y" })).toBe(44);
  });
  it("rejects non-integer ids", () => {
    expect(() => issueNumberOf({ id: "abc", title: "x", branch: "y" })).toThrow();
    expect(() => issueNumberOf({ id: "0", title: "x", branch: "y" })).toThrow();
    expect(() => issueNumberOf({ id: "-3", title: "x", branch: "y" })).toThrow();
  });
});

describe("sortIssuesAsc", () => {
  it("sorts by issue number ascending", () => {
    const sorted = sortIssuesAsc([issue(44), issue(10), issue(42)]);
    expect(sorted.map((i) => i.id)).toEqual(["10", "42", "44"]);
  });
  it("does not mutate input", () => {
    const input = [issue(44), issue(10)];
    sortIssuesAsc(input);
    expect(input.map((i) => i.id)).toEqual(["44", "10"]);
  });
});

describe("runMergerWithAdapter — clean-merge happy paths", () => {
  it("clean merge + green: keeps merge, pushes, closes", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
    });
    const summary = await runMergerWithAdapter([issue(42)], adapter);

    expect(summary.merged.map((i) => i.id)).toEqual(["42"]);
    expect(summary.skipped).toEqual([]);
    expect(summary.pushed).toBe(true);
    expect(calls.order).toEqual(["merge", "install", "gate"]);
    expect(calls.agentRuns).toEqual([]);
    expect(calls.resets).toEqual([]);
    expect(calls.closes).toEqual([
      { n: 42, comment: "Completed by Sandbar" },
    ]);
  });

  it("clean merge + npm install fails: resets to preMergeSha, comments install-failed, skips, no gate", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      installs: [false],
      heads: ["pre-sha"],
    });
    const summary = await runMergerWithAdapter([issue(42)], adapter);

    expect(summary.merged).toEqual([]);
    expect(summary.skipped.map((s) => ({ id: s.issue.id, reason: s.reason }))).toEqual([
      { id: "42", reason: "install-failed" },
    ]);
    expect(summary.pushed).toBe(false);
    expect(calls.resets).toEqual([{ sha: "pre-sha" }]);
    expect(calls.gates).toBe(0);
    expect(calls.comments).toEqual([
      { n: 42, msg: buildInstallFailedComment(SOURCE_TARGET) },
    ]);
    expect(calls.removedLabels).toEqual([
      { n: 42, label: READY_FOR_AGENT_LABEL },
    ]);
  });
});

describe("runMergerWithAdapter — conflict enters resolve loop", () => {
  it("conflict + agent COMMITTED + gate green: keeps merge, pushes, closes", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      agents: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    const summary = await runMergerWithAdapter([issue(42)], adapter);

    expect(summary.merged.map((i) => i.id)).toEqual(["42"]);
    expect(summary.skipped).toEqual([]);
    expect(calls.order).toEqual(["merge", "agent", "install", "gate"]);
    expect(calls.aborts).toBe(0);
    expect(calls.resets).toEqual([]);
    expect(calls.closes).toEqual([
      { n: 42, comment: "Completed by Sandbar" },
    ]);
  });

  it("conflict + agent ABANDON while still conflicted: aborts merge, comments with reason, drops label, skips", async () => {
    const reason = "branches #42 and #40 collide; #40 should win";
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      agents: [
        {
          stdout: `<reason>${reason}</reason>\n<promise>ABANDON</promise>`,
          leavesConflict: true,
        },
      ],
    });
    const summary = await runMergerWithAdapter([issue(42)], adapter);

    expect(summary.merged).toEqual([]);
    expect(summary.skipped.map((s) => ({ id: s.issue.id, reason: s.reason }))).toEqual([
      { id: "42", reason: "conflict" },
    ]);
    expect(calls.aborts).toBe(1);
    expect(calls.resets).toEqual([]);
    expect(calls.comments).toHaveLength(1);
    expect(calls.comments[0]!.msg).toContain("agentic resolve loop");
    expect(calls.comments[0]!.msg).toContain(reason);
    expect(calls.removedLabels).toEqual([
      { n: 42, label: READY_FOR_AGENT_LABEL },
    ]);
  });

  it("abandon path + removeLabel fails: halts loud, naming the underlying failure (#33)", async () => {
    // Still fail-loud, still not swallowed — but as a MergerError, because that
    // is the only class run.ts routes to Phase 4 (#33). Nothing is stranded in
    // this particular arrangement: the label removal is what de-queues an
    // issue, and it is the call that failed, so #42 is still `ready-for-agent`
    // and needs no handoff — hence an empty partial rather than a missing one.
    const { adapter } = makeAdapter({
      merges: ["conflict"],
      agents: [
        {
          stdout: "<reason>collide</reason>\n<promise>ABANDON</promise>",
          leavesConflict: true,
        },
      ],
    });
    const throwing: MergerAdapter = {
      ...adapter,
      async removeLabel(n) {
        throw new SandbarError(`merger: failed to remove label from issue #${n}`);
      },
    };
    const err = await runMergerWithAdapter([issue(42)], throwing).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MergerError);
    expect((err as MergerError).message).toContain(
      "failed to remove label from issue #42",
    );
    expect((err as MergerError).partial?.merged).toEqual([]);
    expect((err as MergerError).partial?.skipped).toEqual([]);
  });

  it("conflict + silent abort (agent COMMITTED, no merge in progress, HEAD unchanged): skips with reason silent-noop, NO comment or label change", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      agents: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
      heads: ["pre-sha", "pre-sha"],
    });
    const summary = await runMergerWithAdapter([issue(42)], adapter);

    expect(summary.merged).toEqual([]);
    expect(summary.skipped.map((s) => ({ id: s.issue.id, reason: s.reason }))).toEqual([
      { id: "42", reason: "silent-noop" },
    ]);
    expect(calls.aborts).toBe(0);
    expect(calls.resets).toEqual([{ sha: "pre-sha" }]);
    expect(calls.comments).toEqual([]);
    expect(calls.removedLabels).toEqual([]);
  });

  it("conflict + agent commits the merge then ABANDONs: resets to preMergeSha (not merge --abort)", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      agents: [
        { stdout: "<promise>COMMITTED</promise>" },
        {
          stdout: "<reason>cannot fix tests</reason>\n<promise>ABANDON</promise>",
          leavesConflict: false,
        },
      ],
      gates: [gateRed()],
      heads: ["pre-sha"],
    });
    const summary = await runMergerWithAdapter([issue(42)], adapter);

    expect(summary.merged).toEqual([]);
    expect(summary.skipped[0]!.reason).toBe("conflict");
    expect(calls.aborts).toBe(0);
    expect(calls.resets).toEqual([{ sha: "pre-sha" }]);
  });
});

describe("runMergerWithAdapter — gate-red enters resolve loop", () => {
  it("clean merge + gate red + agent fixes it: keeps merge, pushes, closes", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      agents: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [gateRed(), { ok: true }],
    });
    const summary = await runMergerWithAdapter([issue(42)], adapter);

    expect(summary.merged.map((i) => i.id)).toEqual(["42"]);
    expect(calls.order).toEqual([
      "merge",
      "install",
      "gate",
      "agent",
      "install",
      "gate",
    ]);
    expect(calls.resets).toEqual([]);
    expect(calls.closes).toEqual([
      { n: 42, comment: "Completed by Sandbar" },
    ]);
  });

  it("clean merge + gate red + agent ABANDONs: resets to preMergeSha, comments with reason, skips", async () => {
    const reason = "test failure is a real integration bug — needs human";
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      agents: [
        {
          stdout: `<reason>${reason}</reason>\n<promise>ABANDON</promise>`,
        },
      ],
      gates: [gateRed()],
      heads: ["pre-sha"],
    });
    const summary = await runMergerWithAdapter([issue(42)], adapter);

    expect(summary.merged).toEqual([]);
    expect(summary.skipped.map((s) => ({ id: s.issue.id, reason: s.reason }))).toEqual([
      { id: "42", reason: "gate-red" },
    ]);
    expect(calls.aborts).toBe(0);
    expect(calls.resets).toEqual([{ sha: "pre-sha" }]);
    expect(calls.comments).toHaveLength(1);
    expect(calls.comments[0]!.msg).toContain("agentic fix attempt");
    expect(calls.comments[0]!.msg).toContain(reason);
    expect(calls.removedLabels).toEqual([
      { n: 42, label: READY_FOR_AGENT_LABEL },
    ]);
  });

  it("gate-red onGateRed sink fires before entering the resolve loop", async () => {
    const { adapter } = makeAdapter({
      merges: ["ok"],
      agents: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [gateRed(), { ok: true }],
    });
    const sunk: Array<{ issueId: string; failedStep: string | null; exitCode: number }> = [];
    await runMergerWithAdapter(
      [issue(42)],
      adapter,
      undefined,
      (issueId, gate) => {
        sunk.push({ issueId, failedStep: gate.failedStep, exitCode: gate.exitCode });
      },
    );
    expect(sunk).toEqual([{ issueId: "42", failedStep: "test", exitCode: 1 }]);
  });
});

describe("runMergerWithAdapter — multi-issue context", () => {
  it("passes other cycle issues to the resolve loop (bodies fetched for siblings, not self)", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      agents: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    await runMergerWithAdapter(
      [issue(42)],
      adapter,
      undefined,
      undefined,
      { cycleIssues: [issue(40), issue(42), issue(44)] },
    );

    expect(calls.bodies).toEqual(["42", "40", "44"]);
  });

  it("defaults cycleIssues to the issues argument when not provided", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict", "ok"],
      agents: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }, { ok: true }],
    });
    await runMergerWithAdapter([issue(40), issue(42)], adapter);
    expect(calls.bodies).toEqual(["40", "42"]);
  });
});

describe("runMergerWithAdapter — ordering and mixed", () => {
  it("processes branches in ascending issue number order regardless of input order", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok", "ok", "ok"],
      gates: [{ ok: true }, { ok: true }, { ok: true }],
    });
    await runMergerWithAdapter([issue(44), issue(10), issue(42)], adapter);

    expect(calls.merges).toEqual([
      "sandbar/issue-10-t-10",
      "sandbar/issue-42-t-42",
      "sandbar/issue-44-t-44",
    ]);
    expect(calls.closes.map((c) => c.n)).toEqual([10, 42, 44]);
  });

  it("mixed run: some skipped via abandon, some merged — only merged are pushed and closed", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict", "ok", "ok"],
      agents: [
        {
          stdout: "<reason>r1</reason>\n<promise>ABANDON</promise>",
          leavesConflict: true,
        },
        {
          stdout: "<reason>r2</reason>\n<promise>ABANDON</promise>",
        },
      ],
      gates: [{ ok: true }, gateRed()],
      heads: ["sha10", "sha42", "sha44"],
    });
    const summary = await runMergerWithAdapter(
      [issue(44), issue(10), issue(42)],
      adapter,
    );

    expect(summary.merged.map((i) => i.id)).toEqual(["42"]);
    expect(summary.skipped.map((s) => ({ id: s.issue.id, reason: s.reason }))).toEqual([
      { id: "10", reason: "conflict" },
      { id: "44", reason: "gate-red" },
    ]);
    expect(summary.pushed).toBe(true);
    expect(calls.aborts).toBe(1);
    expect(calls.resets).toEqual([{ sha: "sha44" }]);
    expect(calls.closes).toEqual([
      { n: 42, comment: "Completed by Sandbar" },
    ]);
  });

  it("all branches skipped: no push, no closes", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict", "ok"],
      agents: [
        {
          stdout: "<reason>r</reason>\n<promise>ABANDON</promise>",
          leavesConflict: true,
        },
        {
          stdout: "<reason>r</reason>\n<promise>ABANDON</promise>",
        },
      ],
      gates: [gateRed()],
    });
    const summary = await runMergerWithAdapter(
      [issue(10), issue(11)],
      adapter,
    );

    expect(summary.merged).toEqual([]);
    expect(summary.skipped.length).toBe(2);
    expect(summary.pushed).toBe(false);
    expect(calls.pushes).toBe(0);
    expect(calls.closes).toEqual([]);
  });
});

describe("runMergerWithAdapter — push lifecycle", () => {
  it("push race retry: pulls, re-pushes successfully, closes issues", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      pushes: [{ kind: "race" }, { kind: "ok" }],
      pulls: [true],
    });
    const summary = await runMergerWithAdapter([issue(42)], adapter);

    expect(summary.pushed).toBe(true);
    expect(calls.pushes).toBe(2);
    expect(calls.pulls).toBe(1);
    expect(calls.closes).toEqual([
      { n: 42, comment: "Completed by Sandbar" },
    ]);
  });

  it("push race + pull conflict: throws MergerError, no closes", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      pushes: [{ kind: "race" }],
      pulls: [false],
    });

    await expect(runMergerWithAdapter([issue(42)], adapter)).rejects.toBeInstanceOf(
      MergerError,
    );
    expect(calls.pushes).toBe(1);
    expect(calls.pulls).toBe(1);
    expect(calls.closes).toEqual([]);
  });

  it("push race + still-rejected after retry: throws MergerError", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      pushes: [{ kind: "race" }, { kind: "race" }],
      pulls: [true],
    });

    await expect(runMergerWithAdapter([issue(42)], adapter)).rejects.toBeInstanceOf(
      MergerError,
    );
    expect(calls.pushes).toBe(2);
    expect(calls.pulls).toBe(1);
    expect(calls.closes).toEqual([]);
  });

  it("push fatal error: throws MergerError, no closes", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      pushes: [{ kind: "fatal", reason: "ssh: handshake failed" }],
    });

    await expect(runMergerWithAdapter([issue(42)], adapter)).rejects.toThrow(
      /handshake failed/,
    );
    expect(calls.closes).toEqual([]);
  });
});

describe("runMergerWithAdapter — post-push close retries (#14)", () => {
  // A no-op sleep that records the backoff durations it was asked to wait, so
  // the suite never actually waits and we can assert the retry cadence.
  function sleepSpy(): {
    sleep: (ms: number) => Promise<void>;
    waits: number[];
  } {
    const waits: number[] = [];
    return {
      sleep: async (ms: number) => {
        waits.push(ms);
      },
      waits,
    };
  }

  it("happy path leaves unclosed empty", async () => {
    const { adapter } = makeAdapter({ merges: ["ok"], gates: [{ ok: true }] });
    const summary = await runMergerWithAdapter([issue(42)], adapter);
    expect(summary.unclosed).toEqual([]);
  });

  it("transient close failure then success: retries with backoff, no unclosed", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      closeFailsBeforeSuccess: { 42: 2 }, // first two attempts throw
    });
    const spy = sleepSpy();
    const summary = await runMergerWithAdapter(
      [issue(42)],
      adapter,
      undefined,
      undefined,
      { sleep: spy.sleep },
    );

    expect(summary.unclosed).toEqual([]);
    expect(calls.closeAttempts.filter((a) => a.n === 42).length).toBe(3);
    expect(calls.closes).toEqual([{ n: 42, comment: "Completed by Sandbar" }]);
    // Backoff slept between the three attempts (after attempt 1 and 2).
    expect(spy.waits).toEqual([1000, 2000]);
  });

  it("close fails past the retry budget: records in unclosed, does not throw", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      closeFailsBeforeSuccess: { 42: 99 }, // never succeeds
    });
    const spy = sleepSpy();
    const summary = await runMergerWithAdapter(
      [issue(42)],
      adapter,
      undefined,
      undefined,
      { sleep: spy.sleep },
    );

    // Merge is still durable and pushed; only the close failed.
    expect(summary.merged.map((i) => i.id)).toEqual(["42"]);
    expect(summary.pushed).toBe(true);
    expect(summary.unclosed.map((u) => u.issue.id)).toEqual(["42"]);
    expect(summary.unclosed[0]?.error).toContain("scripted transient");
    // Initial attempt + CLOSE_MAX_RETRIES (2) = 3 attempts total.
    expect(calls.closeAttempts.filter((a) => a.n === 42).length).toBe(3);
  });

  it("one close failure does not abort the close loop — siblings still close", async () => {
    // The #14 bug: the first throw skipped the close of every remaining issue.
    const { adapter, calls } = makeAdapter({
      merges: ["ok", "ok", "ok"],
      gates: [{ ok: true }, { ok: true }, { ok: true }],
      closeFailsBeforeSuccess: { 10: 99 }, // the first issue (ascending) fails
    });
    const summary = await runMergerWithAdapter(
      [issue(44), issue(10), issue(42)],
      adapter,
      undefined,
      undefined,
      { sleep: async () => {} },
    );

    expect(summary.unclosed.map((u) => u.issue.id)).toEqual(["10"]);
    // 42 and 44 still get closed despite 10 failing first.
    expect(calls.closes.map((c) => c.n).sort((a, b) => a - b)).toEqual([42, 44]);
  });

  it("close retries configurable to zero: single attempt, then unclosed", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      closeFailsBeforeSuccess: { 42: 99 },
    });
    const spy = sleepSpy();
    const summary = await runMergerWithAdapter(
      [issue(42)],
      adapter,
      undefined,
      undefined,
      { closeRetries: 0, sleep: spy.sleep },
    );

    expect(calls.closeAttempts.filter((a) => a.n === 42).length).toBe(1);
    expect(spy.waits).toEqual([]); // no retries → no backoff waits
    expect(summary.unclosed.map((u) => u.issue.id)).toEqual(["42"]);
  });
});

describe("runMergerWithAdapter — logging", () => {
  it("emits expected log lines for clean-merge happy path", async () => {
    const { adapter } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
    });
    const lines: string[] = [];
    await runMergerWithAdapter([issue(42)], adapter, (line) => {
      lines.push(line);
    });
    expect(lines).toContain("merge-attempt #42 sandbar/issue-42-t-42");
    expect(lines).toContain("merged #42");
    expect(lines).toContain("push attempt 1");
  });

  it("logs resolve-loop entry on conflict and gate-red", async () => {
    const { adapter } = makeAdapter({
      merges: ["conflict", "ok"],
      agents: [
        { stdout: "<promise>COMMITTED</promise>" },
        {
          stdout: "<reason>r</reason>\n<promise>ABANDON</promise>",
        },
      ],
      gates: [{ ok: true }, gateRed()],
    });
    const lines: string[] = [];
    await runMergerWithAdapter([issue(10), issue(42)], adapter, (line) => {
      lines.push(line);
    });
    expect(lines.some((l) => l.startsWith("conflict #10 entering resolve-loop"))).toBe(
      true,
    );
    expect(lines.some((l) => l.startsWith("merged #10 (via resolve-loop)"))).toBe(true);
    expect(lines.some((l) => l.startsWith("gate-red #42"))).toBe(true);
    expect(lines.some((l) => l.startsWith("skip #42 reason=gate-red"))).toBe(true);
  });
});

describe("runMergerWithAdapter — an unexpected throw inside the loop (#33)", () => {
  it("carries the issues it already parked out on MergerError.partial", async () => {
    // The concrete cycle from #33: #40 conflicts and the resolve loop abandons,
    // so the merger comments on it and strips `ready-for-agent` — Phase 4b has
    // not yet applied the handoff label. Then #42 conflicts too and the `gh`
    // call for its sibling context fails. Unwrapped, that SandbarError skips
    // run.ts's `instanceof MergerError` branch entirely and #40 ends commented,
    // un-queued and unlabelled: off the planner's list and off every human
    // filter.
    const { adapter, calls } = makeAdapter({
      merges: ["conflict", "conflict"],
      agents: [
        {
          stdout: "<reason>collide</reason>\n<promise>ABANDON</promise>",
          leavesConflict: true,
        },
      ],
    });
    const throwing: MergerAdapter = {
      ...adapter,
      async getIssueBody(id) {
        // Gated on #40 having been parked, because #42's body is ALSO read as
        // sibling context during #40's own resolve loop, before anything has
        // been written — a throw there strands nothing and would exercise none
        // of this.
        if (id === "42" && calls.removedLabels.length > 0) {
          throw new SandbarError("gh: API rate limit exceeded");
        }
        return adapter.getIssueBody(id);
      },
    };

    const err = await runMergerWithAdapter(
      [issue(40), issue(42)],
      throwing,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MergerError);
    // Loud: the halt names what actually failed, it is not absorbed into a
    // generic "merge phase failed".
    expect((err as MergerError).message).toContain("rate limit");
    expect((err as MergerError).message).toContain("#42");
    const partial = (err as MergerError).partial;
    expect(partial?.skipped.map((s) => [s.issue.id, s.reason])).toEqual([
      ["40", "conflict"],
    ]);
    // The tracker writes the partial describes genuinely happened.
    expect(calls.comments.map((c) => c.n)).toEqual([40]);
    expect(calls.removedLabels).toEqual([{ n: 40, label: READY_FOR_AGENT_LABEL }]);
  });

  it("reports no merges even when branches had merged before the throw", async () => {
    // run.ts asserts `partial.merged` is empty on the grounds that a halt means
    // nothing landed — true here because the merge commits live only in the
    // ephemeral merger worktree, which is removed in run.ts's `finally`.
    // Forwarding the local `merged` array would trip that assertion and replace
    // this halt with a more confusing one.
    const { adapter } = makeAdapter({
      merges: ["ok", "ok"],
      gates: [{ ok: true }, gateRed()],
    });
    const throwing: MergerAdapter = {
      ...adapter,
      async getIssueBody(id) {
        throw new SandbarError(`no body for #${id}`);
      },
    };

    const err = await runMergerWithAdapter(
      [issue(40), issue(42)],
      throwing,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MergerError);
    expect((err as MergerError).partial?.merged).toEqual([]);
    expect((err as MergerError).partial?.pushed).toBe(false);
  });

  it("wraps a throwing gate — #24 D5 throws rather than reddens on a dead issue container", async () => {
    // The second live throw site from #33: `adapter.runGate` is the merger
    // stack's, and a container whose lifecycle is `issue` dying mid-cycle
    // (the OOM-killed database) is infra, so it throws instead of returning a
    // red. By then #40 has already been parked.
    const { adapter } = makeAdapter({
      merges: ["conflict", "ok"],
      agents: [
        {
          stdout: "<reason>collide</reason>\n<promise>ABANDON</promise>",
          leavesConflict: true,
        },
      ],
    });
    const throwing: MergerAdapter = {
      ...adapter,
      async runGate() {
        throw new Error("container db is not running");
      },
    };

    const err = await runMergerWithAdapter(
      [issue(40), issue(42)],
      throwing,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MergerError);
    expect((err as MergerError).message).toContain("container db is not running");
    expect((err as MergerError).partial?.skipped.map((s) => s.issue.id)).toEqual([
      "40",
    ]);
  });

  it("halts with the partial when the LOG SINK throws after a skip", async () => {
    // #33 entered through `emit` instead of `gh`. `no merges, no push` fires
    // exactly when every issue in the cycle was parked, and it is the first
    // thing after the loop — an ENOSPC on the run-log volume there would strand
    // all of them.
    const { adapter } = makeAdapter({
      merges: ["conflict"],
      agents: [
        {
          stdout: "<reason>collide</reason>\n<promise>ABANDON</promise>",
          leavesConflict: true,
        },
      ],
    });

    const err = await runMergerWithAdapter([issue(40)], adapter, (line) => {
      if (line === "no merges, no push") {
        throw new Error("ENOSPC: no space left on device, write");
      }
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MergerError);
    expect((err as MergerError).message).toContain("ENOSPC");
    expect((err as MergerError).partial?.skipped.map((s) => s.issue.id)).toEqual([
      "40",
    ]);
  });

  it("does NOT wrap a log failure once the push has landed", async () => {
    // The other side of the boundary. Past the push, `merged: []` and
    // `pushed: false` would both be false, and a partial that lies is worse
    // than none: run.ts would report a halt, finalise only the skipped, and
    // leave the landed issues open, queued and unclosed against a source branch
    // that has already moved. Raw throw → top-level handler, stack intact.
    const { adapter } = makeAdapter({ merges: ["ok"], gates: [{ ok: true }] });

    const err = await runMergerWithAdapter([issue(40)], adapter, (line) => {
      if (line.startsWith("push ok;")) {
        throw new Error("ENOSPC: no space left on device, write");
      }
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MergerError);
    expect((err as Error).message).toContain("ENOSPC");
  });

  it("carries the original error as `cause` so run.ts can print a stack", async () => {
    // Without it an unexpected BUG (not a designed SandbarError) reaches
    // run.ts's merger-halted branch as a bare message — and that branch is the
    // one that does not reach the top-level handler that prints stacks. The
    // fix would otherwise have made unexpected failures quieter than before it.
    const { adapter } = makeAdapter({ merges: ["ok"], gates: [{ ok: true }] });
    const bug = new TypeError("Cannot read properties of undefined (reading 'ok')");
    const throwing: MergerAdapter = {
      ...adapter,
      async npmInstall() {
        throw bug;
      },
    };

    const err = await runMergerWithAdapter([issue(40)], throwing).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MergerError);
    expect((err as MergerError).cause).toBe(bug);
  });

  it("passes a MergerError through untouched rather than re-wrapping it", async () => {
    // A GUARD, not a pin: nothing inside the loop constructs a MergerError
    // today (every `new MergerError` is post-loop, and `closeMergedIssues` is
    // documented never to throw), so this also passes against the pre-fix code.
    // It is here because double-wrapping would bury the partial the inner error
    // already carries, and the wrapper is now applied in two nested places.
    const { adapter } = makeAdapter({ merges: ["ok"], gates: [{ ok: true }] });
    const inner = new MergerError("inner halt", {
      merged: [],
      skipped: [{ issue: issue(40), reason: "conflict" }],
      pushed: false,
      unclosed: [],
    });
    const throwing: MergerAdapter = {
      ...adapter,
      async mergeNoFf() {
        throw inner;
      },
    };

    const err = await runMergerWithAdapter([issue(40)], throwing).catch(
      (e: unknown) => e,
    );

    expect(err).toBe(inner);
  });
});

// ---------------------------------------------------------------------------
// Verified merge mode (#22) — the forge gates the landing.
// ---------------------------------------------------------------------------

type VerifyFake = {
  verify: VerifyAdapter;
  vCalls: {
    integrationPushes: string[];
    fastForwards: string[];
    prs: number;
  };
};

function makeVerifyFake(opts: {
  checkConclusion?: string;
  integrationPush?: PushOutcome;
  // Throw from a poll, the way an unreachable forge or an unreadable response
  // does. These escape runVerifiedLanding as plain Errors, not MergerErrors.
  listThrows?: Error;
} = {}): VerifyFake {
  const vCalls = { integrationPushes: [] as string[], fastForwards: [] as string[], prs: 0 };
  const verify: VerifyAdapter = {
    async pushIntegration(branch) {
      vCalls.integrationPushes.push(branch);
      return opts.integrationPush ?? { kind: "ok" };
    },
    async listCheckRuns() {
      if (opts.listThrows) throw opts.listThrows;
      return {
        runs: [
          {
            id: 1,
            suiteId: 1,
            name: "tests",
            status: "completed",
            conclusion: opts.checkConclusion ?? "success",
            detailsUrl: "https://github.com/o/r/actions/runs/1/job/2",
          },
        ],
        complete: true,
      };
    },
    async fetchFailureLog() {
      return "ci log";
    },
    async fastForwardSource(sha) {
      vCalls.fastForwards.push(sha);
      return { kind: "ok" };
    },
    async syncWithSource() {
      return { ok: true, reason: "" };
    },
    async ensurePullRequest() {
      vCalls.prs += 1;
      return { number: 5, url: "u" };
    },
    async closePullRequest() {},
  };
  return { verify, vCalls };
}

const VERIFIED_OPTIONS = {
  integrationBranch: "sandbar/integration",
  requiredChecks: ["tests"],
  checkTimeoutMs: 1000,
  pollIntervalMs: 10,
  sourceBranch: "main",
};

describe("runMergerWithAdapter — verified merge mode", () => {
  it("lands via the forge: no direct push, fast-forwards the verified sha, closes the issues", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok", "ok"],
      gates: [{ ok: true }, { ok: true }],
      // cycle base, then each issue's preMergeSha, then the sha under test
      heads: ["base", "p1", "p2", "landed"],
    });
    const { verify, vCalls } = makeVerifyFake();

    const summary = await runMergerWithAdapter([issue(7), issue(9)], adapter, undefined, undefined, {
      verified: { adapter: verify, options: VERIFIED_OPTIONS },
    });

    expect(summary.merged.map((m) => m.id)).toEqual(["7", "9"]);
    expect(summary.pushed).toBe(true);
    expect(summary.skipped).toEqual([]);
    // The source branch is only ever reached through the verified fast-forward.
    expect(calls.pushes).toBe(0);
    expect(vCalls.integrationPushes).toEqual(["sandbar/integration"]);
    expect(vCalls.fastForwards).toEqual(["landed"]);
    expect(calls.closes.map((c) => c.n)).toEqual([7, 9]);
  });

  it("reverts the WHOLE cycle and parks every merged issue when the forge says no", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok", "ok"],
      gates: [{ ok: true }, { ok: true }],
      heads: ["base", "p1", "p2", "landed"],
    });
    const { verify, vCalls } = makeVerifyFake({ checkConclusion: "failure" });

    const summary = await runMergerWithAdapter([issue(7), issue(9)], adapter, undefined, undefined, {
      verified: {
        adapter: verify,
        // One round: the red verdict is final, no resolve attempt.
        options: { ...VERIFIED_OPTIONS, maxRounds: 1 },
      },
    });

    expect(summary.merged).toEqual([]);
    expect(summary.pushed).toBe(false);
    expect(summary.skipped.map((s) => [s.issue.id, s.reason])).toEqual([
      ["7", "forge-unverified"],
      ["9", "forge-unverified"],
    ]);
    // Reverted to where the merger worktree started, not to a per-issue sha.
    expect(calls.resets).toEqual([{ sha: "base" }]);
    expect(vCalls.fastForwards).toEqual([]);
    expect(calls.closes).toEqual([]);
    expect(calls.removedLabels).toEqual([
      { n: 7, label: READY_FOR_AGENT_LABEL },
      { n: 9, label: READY_FOR_AGENT_LABEL },
    ]);
    // Each issue is told it may not be the one at fault, and names its siblings.
    expect(calls.comments.map((c) => c.n)).toEqual([7, 9]);
    expect(calls.comments[0]!.msg).toContain("#9");
    expect(calls.comments[0]!.msg).toContain("not necessarily this issue's fault");
    expect(calls.comments[1]!.msg).toContain("#7");
  });

  it("halts loud (MergerError) when the integration push is rejected", async () => {
    const { adapter } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      heads: ["base", "p1", "landed"],
    });
    const { verify } = makeVerifyFake({
      integrationPush: { kind: "rejected", reason: "stale info" },
    });

    await expect(
      runMergerWithAdapter([issue(7)], adapter, undefined, undefined, {
        verified: { adapter: verify, options: VERIFIED_OPTIONS },
      }),
    ).rejects.toThrow(MergerError);
  });

  it("parks only the issues that actually merged, not the ones already skipped", async () => {
    // #7 never merged (gate red, resolve abandoned) and has already been
    // commented and de-labelled. Re-parking it as `forge-unverified` would
    // post a second, contradictory comment and push TWO finalize inputs for
    // one issue.
    const { adapter, calls } = makeAdapter({
      merges: ["ok", "ok"],
      gates: [gateRed(), { ok: true }],
      agents: [{ stdout: "<reason>nope</reason>\n<promise>ABANDON</promise>" }],
      heads: ["base", "p1", "p2", "landed"],
    });
    const { verify } = makeVerifyFake({ checkConclusion: "failure" });

    const summary = await runMergerWithAdapter(
      [issue(7), issue(9)],
      adapter,
      undefined,
      undefined,
      {
        verified: {
          adapter: verify,
          options: { ...VERIFIED_OPTIONS, maxRounds: 1 },
        },
      },
    );

    expect(summary.skipped.map((s) => [s.issue.id, s.reason])).toEqual([
      ["7", "gate-red"],
      ["9", "forge-unverified"],
    ]);
    // One comment each, never two for #7.
    expect(calls.comments.map((c) => c.n)).toEqual([7, 9]);
  });

  it("names the verified sha, not the scratch branch, and flags discarded agent work", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      // NOT an English word: "landed" also occurs in the comment's boilerplate
      // ("nothing was landed on `main`"), so a sha spelled that way passes even
      // if the builder cites the integration BRANCH instead of the sha.
      heads: ["base", "p1", "deadbeef"],
    });
    const { verify } = makeVerifyFake({ checkConclusion: "failure" });

    await runMergerWithAdapter([issue(7)], adapter, undefined, undefined, {
      verified: {
        adapter: verify,
        options: { ...VERIFIED_OPTIONS, maxRounds: 1 },
      },
    });

    // The integration ref is force-pushed by the next cycle; the sha keeps its
    // check runs forever.
    // The citation itself, not merely the sha somewhere in the message — the
    // failure detail also quotes the sha, so a looser assertion passes even if
    // the sentence names the scratch branch.
    expect(calls.comments[0]!.msg).toContain(
      "The check runs are on commit `deadbeef`",
    );
    expect(calls.comments[0]!.msg).toContain("follow the sha, not the branch");
  });

  it("hands back what it had already applied to the tracker when it halts", async () => {
    // The halt stops the run, but #7 has already been commented and stripped
    // of `ready-for-agent` — without this it would sit on no queue at all.
    const { adapter } = makeAdapter({
      merges: ["ok", "ok"],
      gates: [gateRed(), { ok: true }],
      agents: [{ stdout: "<reason>nope</reason>\n<promise>ABANDON</promise>" }],
      heads: ["base", "p1", "p2", "landed"],
    });
    const { verify } = makeVerifyFake({
      integrationPush: { kind: "rejected", reason: "stale info" },
    });

    const err = await runMergerWithAdapter(
      [issue(7), issue(9)],
      adapter,
      undefined,
      undefined,
      { verified: { adapter: verify, options: VERIFIED_OPTIONS } },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MergerError);
    const partial = (err as MergerError).partial;
    expect(partial?.merged).toEqual([]);
    expect(partial?.skipped.map((s) => [s.issue.id, s.reason])).toEqual([
      ["7", "gate-red"],
    ]);
  });

  it("does not touch the forge when nothing merged", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [gateRed()],
      agents: [{ stdout: "<reason>no</reason>\n<promise>ABANDON</promise>" }],
      heads: ["base", "p1"],
    });
    const { verify, vCalls } = makeVerifyFake();

    const summary = await runMergerWithAdapter([issue(7)], adapter, undefined, undefined, {
      verified: { adapter: verify, options: VERIFIED_OPTIONS },
    });

    expect(summary.merged).toEqual([]);
    expect(summary.pushed).toBe(false);
    expect(vCalls.integrationPushes).toEqual([]);
    expect(calls.pushes).toBe(0);
  });
  it("wraps a raw throw from the landing so the tracker state still reaches Phase 4", async () => {
    // The stranding this prevents: #7 has already been commented and stripped
    // of `ready-for-agent` when the forge becomes unreachable. A plain Error
    // escapes run.ts's `instanceof MergerError` check, Phase 4 never runs, and
    // #7 ends on no queue and under no handoff label — invisible to the planner
    // and to every human filter.
    const { adapter } = makeAdapter({
      merges: ["ok", "ok"],
      gates: [gateRed(), { ok: true }],
      agents: [{ stdout: "<reason>nope</reason>\n<promise>ABANDON</promise>" }],
      heads: ["base", "p1", "p2", "landed"],
    });
    const { verify } = makeVerifyFake({ listThrows: new Error("HTTP 502") });

    const err = await runMergerWithAdapter(
      [issue(7), issue(9)],
      adapter,
      undefined,
      undefined,
      { verified: { adapter: verify, options: VERIFIED_OPTIONS } },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MergerError);
    // Still loud — the message names the underlying failure, it is not absorbed.
    expect((err as MergerError).message).toContain("502");
    expect((err as MergerError).partial?.skipped.map((sk) => sk.issue.id)).toEqual([
      "7",
    ]);
  });

  it("names the merged-but-unlanded issues when it halts", async () => {
    // Their branches and labels survive, but nothing else tells the operator
    // which work was composed and thrown away with the ephemeral worktree.
    const { adapter } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      heads: ["base", "p1", "landed"],
    });
    const { verify } = makeVerifyFake({
      integrationPush: { kind: "rejected", reason: "stale info" },
    });

    const err = await runMergerWithAdapter([issue(7)], adapter, undefined, undefined, {
      verified: { adapter: verify, options: VERIFIED_OPTIONS },
    }).catch((e: unknown) => e);

    expect((err as MergerError).message).toContain("#7");
    expect((err as MergerError).message).toMatch(/merged locally and NOT landed/);
  });

  it("does not tell the author their checks failed when the checks passed", async () => {
    // source-moved: the forge went GREEN and the cycle was dropped over a race
    // with a human push. Reporting that as a rejection sends the author to read
    // a passing build looking for a failure that isn't there.
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      heads: ["base", "p1", "deadbeef"],
    });
    const { verify } = makeVerifyFake();
    verify.fastForwardSource = async () => ({
      kind: "rejected",
      reason: "non-fast-forward",
    });

    await runMergerWithAdapter([issue(7)], adapter, undefined, undefined, {
      verified: {
        adapter: verify,
        options: { ...VERIFIED_OPTIONS, maxRounds: 1 },
      },
    });

    const msg = calls.comments[0]!.msg;
    expect(msg).toContain("checks PASSED");
    expect(msg).not.toMatch(/checks rejected/);
  });
});

describe("buildForgeUnverifiedComment", () => {
  const base = {
    detail: "d",
    siblings: [],
    integrationBranch: "sandbar/integration",
    sourceBranch: "main",
    verifiedSha: "abc123",
    hasResolveCommits: false,
  } as const;

  it("warns that the resolve agent's commits are NOT on the branch being handed back", () => {
    // They were made on the composed merge result, which the revert discarded.
    // Without this the work silently evaporates and the author has no idea it
    // ever existed.
    const msg = buildForgeUnverifiedComment({
      ...base,
      reason: "checks-red",
      hasResolveCommits: true,
    });
    expect(msg).toMatch(/does NOT contain them/);
    expect(msg).toContain("abc123");
  });

  it("says nothing about discarded commits when there were none", () => {
    const msg = buildForgeUnverifiedComment({ ...base, reason: "checks-red" });
    expect(msg).not.toMatch(/does NOT contain them/);
  });

  it.each([
    ["checks-red", /checks rejected/],
    ["checks-timeout", /never concluded/],
    ["source-moved", /checks PASSED/],
    ["resolve-abandon", /gave up/],
  ] as const)("describes %s accurately", (reason, pattern) => {
    expect(buildForgeUnverifiedComment({ ...base, reason })).toMatch(pattern);
  });

  it("falls back to the branch only when there is no verified sha", () => {
    const msg = buildForgeUnverifiedComment({
      ...base,
      reason: "checks-red",
      verifiedSha: null,
    });
    expect(msg).not.toMatch(/on commit/);
    expect(msg).toContain("sandbar/integration");
  });
});

// #60 — the second landing target. What these pin is the SHAPE of the phase:
// which base each group is composed on, that the worktree comes back to where
// the cycle started, that a member is recorded only after the push, and that
// the source-branch pass is untouched by any of it.
describe("runMergerWithAdapter — chunk landing (#60)", () => {
  const chunkIssue = (n: number, root = n): IssueRef => ({
    ...issue(n),
    chunk: { root, branch: `sandbar/chunk-${root}-c` },
  });

  it("bases a first landing on origin/<sourceBranch>, merges, gates, pushes the chunk branch", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
    });
    const summary = await runMergerWithAdapter([chunkIssue(42)], adapter);

    // Origin has no such branch, so the chunk branch is created where every
    // issue branch is seeded from — which is what makes the merge honest.
    expect(calls.chunkBases).toEqual(["sandbar/chunk-42-c"]);
    expect(calls.checkouts[0]).toBe("origin/main");
    expect(calls.order).toEqual([
      "checkout",
      "merge",
      "install",
      "gate",
      "chunk-push",
      // The review surface comes after the push, never before it (#62).
      "chunk-pr",
      "checkout",
    ]);
    expect(calls.chunkPushes).toEqual(["sandbar/chunk-42-c"]);
    expect(summary.chunkLanded).toEqual([
      { issue: chunkIssue(42), chunkBranch: "sandbar/chunk-42-c" },
    ]);
    // Nothing reached the source branch: no merge, no push, no close.
    expect(summary.merged).toEqual([]);
    expect(summary.pushed).toBe(false);
    expect(calls.pushes).toBe(0);
    expect(calls.closes).toEqual([]);
  });

  it("bases a later landing on origin's copy of the chunk branch", async () => {
    // The recovery point is on origin, so a member landing after the first
    // composes on what is there rather than on a local ref or on the source.
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      chunkBases: {
        "sandbar/chunk-42-c": "refs/remotes/origin/sandbar/chunk-42-c",
      },
    });
    await runMergerWithAdapter([chunkIssue(43, 42)], adapter);

    expect(calls.checkouts[0]).toBe("refs/remotes/origin/sandbar/chunk-42-c");
  });

  it("lands the chunks first, then returns the worktree to the sha the cycle started on", async () => {
    // The source-branch pass must merge onto origin/<sourceBranch> and not
    // onto whatever chunk was landed last.
    const { adapter, calls } = makeAdapter({
      merges: ["ok", "ok"],
      gates: [{ ok: true }, { ok: true }],
      heads: ["entry-sha"],
    });
    const summary = await runMergerWithAdapter(
      [issue(10), chunkIssue(42)],
      adapter,
    );

    expect(calls.checkouts).toEqual(["origin/main", "entry-sha"]);
    expect(calls.merges).toEqual([
      "sandbar/issue-42-t-42",
      "sandbar/issue-10-t-10",
    ]);
    expect(summary.chunkLanded.map((c) => c.issue.id)).toEqual(["42"]);
    expect(summary.merged.map((i) => i.id)).toEqual(["10"]);
    expect(summary.pushed).toBe(true);
    expect(calls.closes).toEqual([{ n: 10, comment: "Completed by Sandbar" }]);
  });

  it("gives each chunk its own base, composition and push, in root order", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok", "ok"],
      gates: [{ ok: true }, { ok: true }],
    });
    const summary = await runMergerWithAdapter(
      [chunkIssue(44), chunkIssue(42)],
      adapter,
    );

    expect(calls.chunkBases).toEqual([
      "sandbar/chunk-42-c",
      "sandbar/chunk-44-c",
    ]);
    expect(calls.chunkPushes).toEqual([
      "sandbar/chunk-42-c",
      "sandbar/chunk-44-c",
    ]);
    expect(summary.chunkLanded.map((c) => c.chunkBranch)).toEqual([
      "sandbar/chunk-42-c",
      "sandbar/chunk-44-c",
    ]);
  });

  it("pushes nothing when the chunk's only member is skipped, and names the chunk in the comment", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      installs: [false],
      heads: ["entry-sha", "pre-sha"],
    });
    const summary = await runMergerWithAdapter([chunkIssue(42)], adapter);

    expect(calls.chunkPushes).toEqual([]);
    expect(summary.chunkLanded).toEqual([]);
    expect(summary.skipped.map((s) => s.reason)).toEqual(["install-failed"]);
    expect(calls.resets).toEqual([{ sha: "pre-sha" }]);
    // The prose must not claim the source branch: nothing of this was ever
    // heading there.
    expect(calls.comments[0]!.msg).toContain("sandbar/chunk-42-c");
    expect(calls.comments[0]!.msg).not.toContain("into the source branch");
  });

  it("halts on a rejected chunk push, carrying the chunks that DID land in the partial", async () => {
    // The rejection means the branch moved under this cycle, so the
    // composition is not built on it — never force-pushed, never retried. The
    // earlier chunk's members are on origin and still owe their `in-chunk`
    // label, which is what the partial carries to Phase 4.
    const { adapter, calls } = makeAdapter({
      merges: ["ok", "ok"],
      gates: [{ ok: true }, { ok: true }],
      chunkPushes: [{ kind: "ok" }, { kind: "race" }],
    });
    const err = await runMergerWithAdapter(
      [chunkIssue(42), chunkIssue(44)],
      adapter,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MergerError);
    const partial = (err as MergerError).partial;
    expect(partial?.merged).toEqual([]);
    expect(partial?.chunkLanded?.map((c) => c.issue.id)).toEqual(["42"]);
    expect((err as MergerError).message).toContain("sandbar/chunk-44-c");
    expect((err as MergerError).message).toContain("#44");
    // The failed group's members keep their branches and their queue label.
    expect(calls.removedLabels).toEqual([]);
  });

  it("reads no head sha and checks out nothing when no issue carries a chunk", async () => {
    // The auto lane pays nothing for this: same calls as before #60.
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      heads: ["pre-sha"],
    });
    const summary = await runMergerWithAdapter([issue(42)], adapter);

    expect(calls.checkouts).toEqual([]);
    expect(calls.chunkBases).toEqual([]);
    expect(calls.chunkPushes).toEqual([]);
    expect(summary.chunkLanded).toEqual([]);
    // One getHeadSha, the per-issue preMergeSha: the entry read that exists to
    // get back FROM a chunk is not paid for when there is no chunk.
    expect(calls.headReads).toBe(1);
  });
});

// #62 — the review surface. The chunk branch is where the work is; this is
// what makes it something a human can be handed. What these pin is that it
// happens once per chunk, after the push, describing everything the branch
// carries — and that failing to open it is loud rather than silent.
describe("runMergerWithAdapter — the chunk PR (#62)", () => {
  const chunkIssue = (n: number, root = n, landed?: readonly { number: number; title: string }[]): IssueRef => ({
    ...issue(n),
    chunk: {
      root,
      branch: `sandbar/chunk-${root}-c`,
      ...(landed ? { landed } : {}),
    },
  });

  it("opens one PR per chunk, after the push, naming the branch and its members", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
    });
    await runMergerWithAdapter([chunkIssue(42)], adapter);

    expect(calls.chunkPrs).toHaveLength(1);
    const pr = calls.chunkPrs[0]!;
    expect(pr.chunkBranch).toBe("sandbar/chunk-42-c");
    expect(pr.title).toBe("Sandbar chunk #42: t-42");
    expect(pr.body).toContain("- #42 — t-42");
    expect(pr.body).toContain("sandbar/chunk-42-c");
  });

  it("describes the members already on the branch as well as the ones landing now", async () => {
    // The failure this prevents: a chunk growing a member per cycle whose PR
    // describes the newest member alone, dropping the ones under review above
    // it. The plan carries the earlier ones (#62); the merge phase adds its own.
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
    });
    await runMergerWithAdapter(
      [chunkIssue(43, 42, [{ number: 42, title: "The root" }])],
      adapter,
    );

    const pr = calls.chunkPrs[0]!;
    expect(pr.body).toContain("- #42 — The root");
    expect(pr.body).toContain("- #43 — t-43");
    // The root titles the PR even when it landed in an earlier cycle.
    expect(pr.title).toBe("Sandbar chunk #42: The root");
  });

  it("gives each chunk its own PR, in root order", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok", "ok"],
      gates: [{ ok: true }, { ok: true }],
    });
    await runMergerWithAdapter([chunkIssue(44), chunkIssue(42)], adapter);

    expect(calls.chunkPrs.map((p) => p.chunkBranch)).toEqual([
      "sandbar/chunk-42-c",
      "sandbar/chunk-44-c",
    ]);
  });

  it("opens nothing for a chunk whose members all skipped", async () => {
    // Nothing was pushed, so there is nothing to review — and a PR opened here
    // would describe a branch this cycle never touched.
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      installs: [false],
      heads: ["entry-sha", "pre-sha"],
    });
    await runMergerWithAdapter([chunkIssue(42)], adapter);

    expect(calls.chunkPrs).toEqual([]);
  });

  it("opens nothing when no issue carries a chunk", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
    });
    await runMergerWithAdapter([issue(42)], adapter);

    expect(calls.chunkPrs).toEqual([]);
  });

  it("halts when the PR cannot be opened, keeping the landing in the partial", async () => {
    // The push already happened: those commits are on origin and their issues
    // still owe `in-chunk`, so the partial has to carry them. What is lost is
    // the cycle, not the work.
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      chunkPrs: [new Error("gh: HTTP 403")],
    });
    const err = await runMergerWithAdapter([chunkIssue(42)], adapter).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MergerError);
    const merr = err as MergerError;
    expect(merr.message).toContain("sandbar/chunk-42-c");
    expect(merr.message).toContain("#42");
    expect(merr.message).toContain("gh: HTTP 403");
    expect(merr.partial?.chunkLanded?.map((c) => c.issue.id)).toEqual(["42"]);
    expect(merr.partial?.merged).toEqual([]);
    // Not a skip: the issue landed, and telling it otherwise would ask for the
    // work again.
    expect(merr.partial?.skipped).toEqual([]);
    expect(calls.chunkPushes).toEqual(["sandbar/chunk-42-c"]);
  });
});

describe("groupByChunk (#60)", () => {
  const withChunk = (n: number, root: number): IssueRef => ({
    ...issue(n),
    chunk: { root, branch: `sandbar/chunk-${root}-c` },
  });

  it("groups by branch and orders by chunk root", () => {
    const groups = groupByChunk([
      withChunk(50, 44),
      issue(10),
      withChunk(45, 42),
      withChunk(43, 42),
    ]);

    expect(groups.map((g) => g.target.branch)).toEqual([
      "sandbar/chunk-42-c",
      "sandbar/chunk-44-c",
    ]);
    expect(groups[0]!.members.map((m) => m.id)).toEqual(["45", "43"]);
    expect(groups[1]!.members.map((m) => m.id)).toEqual(["50"]);
  });

  it("is empty when nothing carries a chunk", () => {
    expect(groupByChunk([issue(1), { ...issue(2), chunk: null }])).toEqual([]);
  });

  // #62 — the group also carries what the pull request needs: the root that
  // titles it, and the members the plan says are already on the branch.
  it("carries the root and the plan's already-landed members", () => {
    const landed = [{ number: 41, title: "Landed earlier" }];
    const groups = groupByChunk([
      { ...issue(43), chunk: { root: 42, branch: "sandbar/chunk-42-c", landed } },
    ]);

    expect(groups[0]!.root).toBe(42);
    expect(groups[0]!.landed).toEqual(landed);
  });

  it("reads no landed members as none, not as a missing answer", () => {
    // `landed` is optional on `ChunkTarget` for the same reason `chunk` is
    // optional on `IssueRef`: hand-built targets have nothing to say about it.
    expect(groupByChunk([withChunk(43, 42)])[0]!.landed).toEqual([]);
  });
});
