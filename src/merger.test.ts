import { describe, expect, it } from "vitest";

import { SandbarError } from "./errors.js";
import type { MergerGateOutput } from "./merger.js";
import {
  INSTALL_FAILED_COMMENT,
  MergerError,
  READY_FOR_AGENT_LABEL,
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
};

type Script = {
  merges: ("ok" | "conflict")[];
  agents?: AgentScript[];
  installs?: boolean[];
  gates?: GateResp[];
  pushes?: PushResult[];
  pulls?: boolean[];
  heads?: string[];
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
  };
  const closeAttemptsByIssue = new Map<number, number>();
  let mIdx = 0;
  let aIdx = 0;
  let iIdx = 0;
  let gIdx = 0;
  let pIdx = 0;
  let plIdx = 0;
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
    expect(calls.comments).toEqual([{ n: 42, msg: INSTALL_FAILED_COMMENT }]);
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

  it("abandon path + removeLabel fails: mergeAll propagates the error (fail loud, does not swallow)", async () => {
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
    await expect(runMergerWithAdapter([issue(42)], throwing)).rejects.toThrow(SandbarError);
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
