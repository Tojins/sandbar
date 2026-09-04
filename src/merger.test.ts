import { describe, expect, it } from "vitest";
import { classifyAgentRunEnd } from "./agent-run-end.js";

import { SandbarError } from "./errors.js";
import type { PushOutcome, VerifyAdapter } from "./forge-verify.js";
import type { ChunkRefLookup, MergerGateOutput } from "./merger.js";
import { LAND_LABEL, type ChunkLandTarget } from "./chunk-land.js";
import { NEEDS_REVIEW_LABEL } from "./chunks.js";
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

// The invocation's own outcome (#67) defaults to a clean exit: only the tests
// about a container that died or timed out say otherwise.
type AgentScript = {
  stdout: string;
  leavesConflict?: boolean;
  stderr?: string;
  end?: "exit" | "timeout" | "signal" | "spawn-error";
  exitCode?: number | null;
  signal?: string | null;
};

type Calls = {
  merges: string[];
  agentRuns: string[];
  // #64: the resolve prompt itself, which is the only place the BRANCH a unit
  // was described by is observable from out here.
  agentPrompts: string[];
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
  chunkPushes: {
    branch: string;
    members: readonly { readonly source: string; readonly destination: string }[];
  }[];
  chunkPrs: { chunkBranch: string; title: string; body: string }[];
  headReads: number;
  // #64
  chunkRefFetches: string[];
  chunkBranchDeletes: { branch: string; memberIssues: readonly number[] }[];
  prComments: { pr: number; body: string }[];
  prLabelRemovals: { pr: number; label: string }[];
  prCloses: number[];
  // #68: the mechanical version resolution, observed as what it wrote, what it
  // staged and whether it completed the merge itself.
  fileWrites: { path: string; contents: string }[];
  staged: string[];
  mergeCommits: number;
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
  // #64: what origin answers about a chunk branch being LANDED, by branch
  // name. A missing entry is `absent` — origin was reached and has no such
  // branch — which is a different script from an `unreadable` entry, and the
  // whole point of the three states.
  chunkRefs?: Record<string, ChunkRefLookup>;
  // #64: gh/git calls that throw, by operation name.
  wrapupFails?: Partial<
    Record<
      "deleteChunkBranch" | "commentOnPullRequest" | "removePullRequestLabel" | "closePullRequest",
      string
    >
  >;
  // #68: the conflicted worktree a scripted `conflict` merge leaves behind —
  // path to the file's text, conflict markers and all. Absent ⇒ no version file
  // is conflicted, which is what every test that predates #68 means.
  conflictFiles?: Record<string, string>;
  // Conflicted paths the mechanical resolution never touches. Defaulted to the
  // one `conflictDigest` has always reported, so a scripted conflict is a
  // conflict for both readers of the unmerged set.
  otherConflicts?: string[];
  // Whether `git commit --no-edit` succeeds, per call. Default true.
  mergeCommits?: boolean[];
  // Per-issue number of leading close attempts that throw before one succeeds.
  // A value >= total attempts means the close never succeeds. Default 0.
  closeFailsBeforeSuccess?: Record<number, number>;
  // Files visible only after the scripted merge, matching a branch-authored
  // prompt extension entering the merger worktree.
  promptExtensionPaths?: string[];
};

function makeAdapter(script: Script): { adapter: MergerAdapter; calls: Calls } {
  const calls: Calls = {
    merges: [],
    agentRuns: [],
    agentPrompts: [],
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
    chunkRefFetches: [],
    chunkBranchDeletes: [],
    prComments: [],
    prLabelRemovals: [],
    prCloses: [],
    fileWrites: [],
    staged: [],
    mergeCommits: 0,
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
  let mcIdx = 0;
  let merging = false;
  // #68: the unmerged set the mechanical resolution reads and shrinks.
  let unmerged = new Map<string, string>();
  let otherUnmerged: string[] = [];

  const adapter: MergerAdapter = {
    worktreeFileExists: (path) =>
      calls.order.includes("merge") &&
      (script.promptExtensionPaths ?? []).includes(path),
    async mergeNoFf(i) {
      const r = script.merges[mIdx++];
      calls.merges.push(i.branch);
      calls.order.push("merge");
      if (r === "conflict") {
        merging = true;
        unmerged = new Map(Object.entries(script.conflictFiles ?? {}));
        otherUnmerged = [...(script.otherConflicts ?? ["foo"])];
      }
      return { ok: r === "ok" };
    },
    async runResolveAgent(prompt) {
      const entry = script.agents?.[aIdx++];
      if (!entry) throw new Error("runResolveAgent not scripted");
      calls.agentRuns.push("agent");
      calls.agentPrompts.push(prompt);
      calls.order.push("agent");
      if (entry.stdout.includes("<promise>COMMITTED</promise>")) {
        merging = entry.leavesConflict ?? false;
      } else if (
        entry.stdout.includes("<promise>ABANDON</promise>") &&
        entry.leavesConflict !== undefined
      ) {
        merging = entry.leavesConflict;
      }
      const end = entry.end ?? "exit";
      const exitCode = entry.exitCode ?? 0;
      const classification = classifyAgentRunEnd({
        end,
        exitCode,
        spoken: entry.stdout,
        stderr: entry.stderr,
        silentRunRecovery: "infra",
      });
      return {
        stdout: entry.stdout,
        output: entry.stdout,
        stderr: entry.stderr ?? "",
        end,
        exitCode,
        signal: entry.signal ?? null,
        durationMs: 5_000,
        container: `sandbar-wdeadbeef-resolve-${aIdx}-uuid`,
        cause: classification.cause,
        verdict: classification.verdict,
      };
    },
    async isMergeInProgress() {
      calls.isMergeChecks++;
      return merging;
    },
    async conflictDigest() {
      calls.conflictDigests++;
      return {
        status: "UU foo",
        diff: "<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>>",
        paths: ["foo"],
      };
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
    // #68.
    async unmergedPaths() {
      return [...unmerged.keys(), ...otherUnmerged];
    },
    async readWorktreeFile(path) {
      return unmerged.get(path) ?? null;
    },
    async writeWorktreeFile(path, contents) {
      calls.fileWrites.push({ path, contents });
      unmerged.set(path, contents);
    },
    async stagePath(path) {
      calls.staged.push(path);
      unmerged.delete(path);
    },
    async commitMerge() {
      calls.mergeCommits++;
      calls.order.push("merge-commit");
      const ok = script.mergeCommits?.[mcIdx++] ?? true;
      if (ok) merging = false;
      return { ok };
    },
    // #60. `chunkBases` scripts what origin has: a branch name mapped to its
    // remote-tracking ref, or nothing for a chunk that has never landed — in
    // which case the real adapter falls back to the source branch, so this
    // does too.
    async chunkBase(branch) {
      calls.chunkBases.push(branch);
      return script.chunkBases?.[branch] ?? "origin/main";
    },
    // #64. Unlike `chunkBase` there is no fallback: a chunk branch origin does
    // not have cannot be landed, and one origin could not be asked about is not
    // known to be either.
    async fetchChunkRef(branch) {
      calls.chunkRefFetches.push(branch);
      return script.chunkRefs?.[branch] ?? { kind: "absent" };
    },
    async deleteChunkBranch(branch, memberIssues) {
      calls.chunkBranchDeletes.push({ branch, memberIssues });
      calls.order.push("chunk-branch-delete");
      const e = script.wrapupFails?.deleteChunkBranch;
      if (e) throw new SandbarError(e);
    },
    async commentOnPullRequest(pr, body) {
      calls.prComments.push({ pr, body });
      calls.order.push("pr-comment");
      const e = script.wrapupFails?.commentOnPullRequest;
      if (e) throw new SandbarError(e);
    },
    async removePullRequestLabel(pr, label) {
      calls.prLabelRemovals.push({ pr, label });
      calls.order.push("pr-unlabel");
      const e = script.wrapupFails?.removePullRequestLabel;
      if (e) throw new SandbarError(e);
    },
    async closePullRequest(pr) {
      calls.prCloses.push(pr);
      calls.order.push("pr-close");
      const e = script.wrapupFails?.closePullRequest;
      if (e) throw new SandbarError(e);
    },
    async checkoutDetached(ref) {
      calls.checkouts.push(ref);
      calls.order.push("checkout");
      return undefined;
    },
    async pushChunkBranch(branch, members) {
      const r = script.chunkPushes?.[cpIdx++] ?? { kind: "ok" as const };
      calls.chunkPushes.push({ branch, members });
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
  it("probes a branch-local merger path after merging and includes only then", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      agents: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
      promptExtensionPaths: ["docs/MERGER.md"],
    });
    await runMergerWithAdapter([issue(42)], adapter, undefined, undefined, {
      promptExtension: { path: "docs/MERGER.md" },
    });
    expect(calls.agentPrompts[0]).toContain("@docs/MERGER.md");
  });

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

  // #67 — this comment is the only artefact a human reads when they find a
  // stuck issue in the morning, and it used to name no conflicted file, no
  // timing, no output and no log path.
  it("the abandon comment carries the conflicted paths, each attempt's outcome and the log paths", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      agents: [
        // Attempt 1: the ten-minute timeout. Attempts 2 and 3: the agent
        // committed nothing and left the tree conflicted. Attempt 4 gives up.
        { stdout: "", end: "timeout", exitCode: null, signal: "SIGTERM", leavesConflict: true },
        { stdout: "<promise>COMMITTED</promise>", leavesConflict: true },
        { stdout: "<promise>COMMITTED</promise>", leavesConflict: true },
        {
          stdout: "<reason>unresolvable</reason>\n<promise>ABANDON</promise>",
          leavesConflict: true,
        },
      ],
    });
    const written: string[] = [];
    await runMergerWithAdapter([issue(42)], adapter, undefined, undefined, {
      onResolveAttempt: async (key, record) => {
        const path = `/logs/cycle-1/resolve-${key}-attempt-${record.attempt}.log`;
        written.push(path);
        return path;
      },
    });

    // One file per attempt, keyed like the gate artefact beside it.
    expect(written).toEqual([
      "/logs/cycle-1/resolve-42-attempt-1.log",
      "/logs/cycle-1/resolve-42-attempt-2.log",
      "/logs/cycle-1/resolve-42-attempt-3.log",
      "/logs/cycle-1/resolve-42-attempt-4.log",
    ]);

    const msg = calls.comments[0]!.msg;
    // What conflicted — the fake's digest reports `foo`.
    expect(msg).toContain("Conflicted path");
    expect(msg).toContain("`foo`");
    // What each attempt did, and the timeout named as such.
    expect(msg).toContain("**Attempt 1**");
    expect(msg).toContain("10-minute per-attempt timeout");
    expect(msg).toContain("**Attempt 4**");
    // Where to read the output.
    expect(msg).toContain("/logs/cycle-1/resolve-42-attempt-1.log");
  });

  // The count in the lede is the journal's length, not the budget: the loop can
  // now leave early, and "4 attempts" describing one would be the same lie #67
  // was filed about.
  it("the abandon comment counts the attempts that actually ran", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      agents: [
        {
          stdout: "<reason>nope</reason>\n<promise>ABANDON</promise>",
          leavesConflict: true,
        },
      ],
    });
    await runMergerWithAdapter([issue(42)], adapter);
    expect(calls.comments[0]!.msg).toContain("bailed after 1 attempt.");
  });

  // The case from the run in #67: three sub-three-second containers that never
  // ran, laundered into "the agent tried and failed". They must halt instead,
  // and the halt is a MergerError so run.ts still finalises what was already
  // written to the tracker (#33).
  it("an attempt that produced no output halts rather than spending the budget", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      agents: [
        { stdout: "", exitCode: 1, stderr: "Error: image not known" },
        { stdout: "<promise>COMMITTED</promise>" },
        { stdout: "<promise>COMMITTED</promise>" },
        { stdout: "<promise>COMMITTED</promise>" },
      ],
    });
    const err = await runMergerWithAdapter([issue(42)], adapter).catch(
      (e: unknown) => e as MergerError,
    );
    expect(err).toBeInstanceOf(MergerError);
    expect(err.message).toContain("produced no output");
    expect(err.message).toContain("image not known");
    expect(calls.agentRuns).toHaveLength(1);
    // Nothing was said to the issue and nothing was de-queued: the failure is
    // about the host, so #42 keeps its place in the queue for the next run.
    expect(calls.comments).toEqual([]);
    expect(calls.removedLabels).toEqual([]);
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

// The collision AGENTS.md guarantees on every multi-landing cycle (#68). The
// fixtures are the two files npm actually writes, because the whole safety
// argument is about what a hunk in them looks like.
describe("runMergerWithAdapter — the version collision is resolved without an agent", () => {
  const PKG_CONFLICT = [
    "{",
    '  "name": "@offergeist/sandbar",',
    "<<<<<<< HEAD",
    '  "version": "0.20.34",',
    "=======",
    '  "version": "0.20.35",',
    ">>>>>>> sandbar/issue-42",
    '  "type": "module"',
    "}",
    "",
  ].join("\n");

  const LOCK_CONFLICT = [
    "{",
    '  "name": "@offergeist/sandbar",',
    "<<<<<<< HEAD",
    '  "version": "0.20.34",',
    "=======",
    '  "version": "0.20.35",',
    ">>>>>>> sandbar/issue-42",
    '  "lockfileVersion": 3,',
    '  "packages": {',
    '    "": {',
    "<<<<<<< HEAD",
    '      "version": "0.20.34"',
    "=======",
    '      "version": "0.20.35"',
    ">>>>>>> sandbar/issue-42",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");

  it("resolves both files, commits the merge, and spends no resolve attempt", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      conflictFiles: {
        "package.json": PKG_CONFLICT,
        "package-lock.json": LOCK_CONFLICT,
      },
      otherConflicts: [],
      gates: [{ ok: true }],
    });
    const summary = await runMergerWithAdapter([issue(42)], adapter);

    // No agent at all, and the merge went down the SAME path a clean one takes.
    expect(calls.agentRuns).toEqual([]);
    expect(calls.order).toEqual(["merge", "merge-commit", "install", "gate"]);
    expect(summary.merged.map((i) => i.id)).toEqual(["42"]);
    expect(calls.staged).toEqual(["package.json", "package-lock.json"]);
  });

  it("writes max(ours, theirs) + 1 — a value neither side carried — into both files", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      conflictFiles: {
        "package.json": PKG_CONFLICT,
        "package-lock.json": LOCK_CONFLICT,
      },
      otherConflicts: [],
      gates: [{ ok: true }],
    });
    await runMergerWithAdapter([issue(42)], adapter);

    const pkg = calls.fileWrites.find((w) => w.path === "package.json");
    expect(pkg?.contents).toContain('"version": "0.20.36"');
    expect(pkg?.contents).not.toContain("0.20.34");
    expect(pkg?.contents).not.toContain("0.20.35");
    expect(pkg?.contents).not.toContain("<<<<<<<");
    // Everything git had already agreed on survives byte for byte.
    expect(pkg?.contents).toContain('  "name": "@offergeist/sandbar",');
    expect(pkg?.contents).toContain('  "type": "module"');

    const lock = calls.fileWrites.find((w) => w.path === "package-lock.json");
    // Both of npm's mirrors, on the same value as package.json.
    expect(lock?.contents.match(/"version": "0\.20\.36"/g)).toHaveLength(2);
  });

  it("says what it decided in the merger log", async () => {
    const { adapter } = makeAdapter({
      merges: ["conflict"],
      conflictFiles: { "package.json": PKG_CONFLICT },
      otherConflicts: [],
      gates: [{ ok: true }],
    });
    const lines: string[] = [];
    await runMergerWithAdapter([issue(42)], adapter, (line) => {
      lines.push(line);
    });
    expect(lines).toContain(
      "version-collision #42 package.json 0.20.34 vs 0.20.35 -> 0.20.36",
    );
    expect(lines).toContain(
      "version-collision #42 resolved the whole conflict at 0.20.36; no resolve attempt spent",
    );
    expect(lines.some((l) => l.includes("entering resolve-loop"))).toBe(false);
  });

  it("still calls the agent for the conflicts that need judgement, with the version files already staged", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      conflictFiles: { "package.json": PKG_CONFLICT },
      otherConflicts: ["src/merger.ts"],
      agents: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    const lines: string[] = [];
    const summary = await runMergerWithAdapter([issue(42)], adapter, (line) => {
      lines.push(line);
    });

    expect(calls.staged).toEqual(["package.json"]);
    expect(calls.mergeCommits).toBe(0);
    expect(calls.agentRuns).toEqual(["agent"]);
    expect(summary.merged.map((i) => i.id)).toEqual(["42"]);
    expect(lines).toContain(
      "version-collision #42 staged; still conflicted: src/merger.ts",
    );
  });

  it("leaves a package-lock.json whose DEPENDENCY versions conflicted entirely alone", async () => {
    const depConflict = [
      "{",
      '  "name": "@offergeist/sandbar",',
      '  "version": "0.20.34",',
      '  "packages": {',
      '    "node_modules/left-pad": {',
      "<<<<<<< HEAD",
      '      "version": "1.0.0"',
      "=======",
      '      "version": "1.1.0"',
      ">>>>>>> sandbar/issue-42",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      conflictFiles: { "package-lock.json": depConflict },
      otherConflicts: [],
      agents: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    const lines: string[] = [];
    await runMergerWithAdapter([issue(42)], adapter, (line) => {
      lines.push(line);
    });

    expect(calls.fileWrites).toEqual([]);
    expect(calls.staged).toEqual([]);
    expect(calls.agentRuns).toEqual(["agent"]);
    expect(lines).toContain(
      "version-collision #42 package-lock.json left to the resolve agent: " +
        "the conflict also touches packages.node_modules/left-pad.version",
    );
  });

  it("falls into the resolve loop when the merge commit itself fails", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      conflictFiles: { "package.json": PKG_CONFLICT },
      otherConflicts: [],
      mergeCommits: [false],
      agents: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    const lines: string[] = [];
    await runMergerWithAdapter([issue(42)], adapter, (line) => {
      lines.push(line);
    });

    expect(calls.mergeCommits).toBe(1);
    expect(calls.agentRuns).toEqual(["agent"]);
    expect(lines).toContain(
      "version-collision #42 resolved every conflict but the merge commit failed",
    );
  });

  it("does nothing at all when no version file is conflicted", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      otherConflicts: ["src/merger.ts"],
      agents: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
    });
    const lines: string[] = [];
    await runMergerWithAdapter([issue(42)], adapter, (line) => {
      lines.push(line);
    });

    expect(calls.fileWrites).toEqual([]);
    expect(calls.mergeCommits).toBe(0);
    expect(lines.some((l) => l.startsWith("version-collision"))).toBe(false);
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
  // A clock that never advances, so every `durationMs=` this module writes is
  // `0` and the log lines stay assertable by exact string (#82). That is the
  // whole reason `startTimer` takes one.
  const frozenClock = () => 0;

  it("emits expected log lines for clean-merge happy path", async () => {
    const { adapter } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
    });
    const lines: string[] = [];
    await runMergerWithAdapter(
      [issue(42)],
      adapter,
      (line) => {
        lines.push(line);
      },
      undefined,
      { clock: frozenClock },
    );
    expect(lines).toContain("merge-attempt #42 sandbar/issue-42-t-42");
    expect(lines).toContain("merged #42 durationMs=0");
    expect(lines).toContain("push attempt 1");
    // The gate-2 verdict is logged on GREEN too since #82 — it used to be
    // logged only on red, which left the gate that happens every time out of
    // the record entirely (#70). The fake adapter's green gate carries no
    // timings, and an absent measurement is absent rather than zero.
    expect(lines).toContain("gate-2 #42 ok=true");
    expect(lines).toContain("install #42 ok=true durationMs=0");
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
  const vCalls = {
    integrationPushes: [] as string[],
    fastForwards: [] as string[],
    prs: 0,
    // #64: the PR body lists `mergedIssues` in the order it is given, which is
    // the only place that order is observable from out here.
    prBodies: [] as string[],
  };
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
    async ensurePullRequest(args: { body: string }) {
      vCalls.prs += 1;
      vCalls.prBodies.push(args.body);
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
    expect(calls.chunkPushes).toEqual([{
      branch: "sandbar/chunk-42-c",
      members: [{
        source: "sandbar/issue-42-t-42",
        destination: "sandbar/member-42",
      }],
    }]);
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

  it("publishes every member in a chunk group under its durable member ref", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok", "ok"],
      gates: [{ ok: true }, { ok: true }],
    });

    await runMergerWithAdapter([chunkIssue(42), chunkIssue(43, 42)], adapter);

    expect(calls.chunkPushes).toEqual([{
      branch: "sandbar/chunk-42-c",
      members: [
        {
          source: "sandbar/issue-42-t-42",
          destination: "sandbar/member-42",
        },
        {
          source: "sandbar/issue-43-t-43",
          destination: "sandbar/member-43",
        },
      ],
    }]);
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
    expect(calls.chunkPushes.map((push) => push.branch)).toEqual([
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
    // earlier chunk's members are on origin and still owe their `needs-review`
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
    // still owe `needs-review`, so the partial has to carry them. What is lost is
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
    expect(calls.chunkPushes.map((push) => push.branch)).toEqual([
      "sandbar/chunk-42-c",
    ]);
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

// #64 — the third landing: a reviewed chunk onto the source branch. What these
// pin is that it shares the source pass (one gate, one push, one verified
// round), that a failure takes `land` off rather than retrying forever, and
// that the wrap-up runs only after the source branch has actually moved.
describe("runMergerWithAdapter — landing a reviewed chunk (#64)", () => {
  const request = (
    root: number,
    members: readonly number[] = [root],
  ): ChunkLandTarget => ({
    root,
    branch: `sandbar/chunk-${root}-c`,
    title: `chunk ${root}`,
    members: members.map((n) => ({ number: n, title: `t-${n}` })),
    // A chain, so the deepest member closes first and the root last — the
    // wrap-up acts on this list and `chunk-land.test.ts` owns why.
    closeOrder: [...members]
      .reverse()
      .map((n) => ({ number: n, title: `t-${n}` })),
    rework: [],
    pullRequest: 500 + root,
  });

  const landing = (
    ...requests: readonly ChunkLandTarget[]
  ): { chunkLanding: { requests: readonly ChunkLandTarget[]; sourceBranch: string } } => ({
    chunkLanding: { requests, sourceBranch: "main" },
  });

  const originHas = (
    ...roots: readonly number[]
  ): Record<string, ChunkRefLookup> =>
    Object.fromEntries(
      roots.map((r) => [
        `sandbar/chunk-${r}-c`,
        {
          kind: "present",
          ref: `refs/remotes/origin/sandbar/chunk-${r}-c`,
        } as const,
      ]),
    );

  it("defers a request for a chunk this cycle grew, keeping `land` on", async () => {
    // #61 plans a layer of a chunk per cycle, so Phase A can put a member on
    // the very branch a human labelled before Phase B reads the request. What
    // is on origin now is not what they said yes to, and the plan's member
    // list — read before phase 2 — does not name the new member, so landing
    // would put unreviewed commits on the source branch and delete the branch
    // the unclosed member lives on. Nothing merges and the label stays.
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      chunkPushes: [{ kind: "ok" }],
      chunkPrs: [{ number: 7, url: "u" }],
      chunkRefs: originHas(42),
    });
    const summary = await runMergerWithAdapter(
      [{ ...issue(43), chunk: { root: 42, branch: "sandbar/chunk-42-c" } }],
      adapter,
      undefined,
      undefined,
      landing(request(42)),
    );

    // Phase A's merge onto the chunk branch, and nothing else.
    expect(calls.merges).toEqual(["sandbar/issue-43-t-43"]);
    expect(calls.chunkRefFetches).toEqual([]);
    expect(summary.deferredChunks).toEqual([
      { target: request(42), landedNow: [{ number: 43, title: "t-43" }] },
    ]);
    expect(summary.skippedChunks).toEqual([]);
    expect(summary.mergedChunks).toEqual([]);
    expect(calls.prLabelRemovals).toEqual([]);
    expect(calls.prComments[0]?.pr).toBe(542);
    expect(calls.prComments[0]?.body).toContain("#43 — t-43");
    // The chunk landing itself is untouched: #43 is on the branch and owed its
    // `needs-review` display label.
    expect(summary.chunkLanded.map((c) => c.issue.id)).toEqual(["43"]);
  });

  it("defers landing while a member is queued for rework", async () => {
    const { adapter, calls } = makeAdapter({ chunkRefs: originHas(42) });
    const log: string[] = [];
    const target = {
      ...request(42),
      rework: [{ number: 42, title: "t-42" }],
    };
    const summary = await runMergerWithAdapter(
      [], adapter, (line) => log.push(line), undefined, landing(target),
    );

    expect(calls.merges).toEqual([]);
    expect(summary.deferredChunks).toEqual([
      { target, landedNow: [{ number: 42, title: "t-42" }] },
    ]);
    expect(calls.prLabelRemovals).toEqual([]);
    expect(calls.prComments[0]?.body).toContain("#42 — t-42");
    expect(calls.prComments[0]?.body).toContain("leave the `ready-for-agent` queue");
    expect(calls.prComments[0]?.body).not.toContain("description above now lists");
    expect(log).toContain(
      "chunk sandbar/chunk-42-c: not landed (queued for rework: #42); `land` kept",
    );
  });

  it("lands a chunk whose branch this cycle did not touch, beside one it did", async () => {
    // The deferral is per BRANCH, not per cycle: a chunk nothing landed on is
    // exactly as reviewed as it was when the label went on.
    const { adapter, calls } = makeAdapter({
      merges: ["ok", "ok"],
      gates: [{ ok: true }, { ok: true }],
      chunkPushes: [{ kind: "ok" }],
      chunkPrs: [{ number: 7, url: "u" }],
      chunkRefs: originHas(42, 99),
    });
    const summary = await runMergerWithAdapter(
      [{ ...issue(43), chunk: { root: 42, branch: "sandbar/chunk-42-c" } }],
      adapter,
      undefined,
      undefined,
      landing(request(42), request(99)),
    );

    expect(summary.deferredChunks.map((d) => d.target.root)).toEqual([42]);
    expect(summary.mergedChunks.map((m) => m.target.root)).toEqual([99]);
    expect(calls.chunkRefFetches).toEqual(["sandbar/chunk-99-c"]);
  });

  it("merges origin's chunk branch, lands it with the cycle, then wraps it up", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      chunkRefs: originHas(42),
    });
    const summary = await runMergerWithAdapter(
      [],
      adapter,
      undefined,
      undefined,
      landing(request(42, [42, 43])),
    );

    // The merge source is ORIGIN's copy: the chunk branch outlives the run and
    // nothing in the state directory is authoritative.
    expect(calls.chunkRefFetches).toEqual(["sandbar/chunk-42-c"]);
    expect(calls.merges).toEqual(["refs/remotes/origin/sandbar/chunk-42-c"]);
    // One gate over the composition, one push — the source pass's own.
    expect(calls.gates).toBe(1);
    expect(calls.pushes).toBe(1);
    expect(summary.pushed).toBe(true);
    // …and only then the wrap-up: every member closed — deepest first, the
    // root last — `needs-review` dropped, the pull request closed, the branch
    // deleted.
    expect(calls.closes.map((c) => c.n)).toEqual([43, 42]);
    expect(calls.removedLabels).toEqual([
      { n: 43, label: NEEDS_REVIEW_LABEL },
      { n: 42, label: NEEDS_REVIEW_LABEL },
    ]);
    // `land` off before the close, so a pull request that would not close is
    // still not a request the next cycle honours.
    expect(calls.prLabelRemovals).toEqual([{ pr: 542, label: LAND_LABEL }]);
    expect(calls.prCloses).toEqual([542]);
    expect(calls.chunkBranchDeletes).toEqual([{
      branch: "sandbar/chunk-42-c",
      memberIssues: [42, 43],
    }]);
    expect(summary.mergedChunks.map((c) => c.closed)).toEqual([[42, 43]]);
    expect(summary.mergedChunks[0]?.residue).toEqual([]);
    expect(summary.skippedChunks).toEqual([]);
  });

  it("merges the chunk before the cycle's own branches, into one landing", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok", "ok"],
      gates: [{ ok: true }, { ok: true }],
      chunkRefs: originHas(42),
    });
    const summary = await runMergerWithAdapter(
      [issue(10)],
      adapter,
      undefined,
      undefined,
      landing(request(42)),
    );

    expect(calls.merges).toEqual([
      "refs/remotes/origin/sandbar/chunk-42-c",
      "sandbar/issue-10-t-10",
    ]);
    expect(calls.pushes).toBe(1);
    expect(summary.merged.map((m) => m.id)).toEqual(["10"]);
    expect(summary.mergedChunks).toHaveLength(1);
  });

  it("nothing is closed or deleted when the push fails", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      chunkRefs: originHas(42),
      pushes: [{ kind: "fatal", reason: "no such remote" }],
    });
    await expect(
      runMergerWithAdapter([], adapter, undefined, undefined, landing(request(42))),
    ).rejects.toBeInstanceOf(MergerError);

    expect(calls.closes).toEqual([]);
    expect(calls.chunkBranchDeletes).toEqual([]);
    expect(calls.prCloses).toEqual([]);
    // `land` is untouched: a failed push says nothing about the chunk, so the
    // next run tries again.
    expect(calls.prLabelRemovals).toEqual([]);
  });

  it("parks the chunk and drops `land` when the resolve loop abandons the merge", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      agents: [{ stdout: "<promise>ABANDON</promise><reason>irreconcilable</reason>" }],
      chunkRefs: originHas(42),
    });
    const summary = await runMergerWithAdapter(
      [],
      adapter,
      undefined,
      undefined,
      landing(request(42)),
    );

    expect(summary.skippedChunks).toEqual([
      { target: request(42), reason: "conflict" },
    ]);
    expect(calls.prLabelRemovals).toEqual([{ pr: 542, label: LAND_LABEL }]);
    expect(calls.prComments[0]?.body).toContain("irreconcilable");
    // Reverted, nothing landed, nothing closed.
    expect(summary.pushed).toBe(false);
    expect(calls.pushes).toBe(0);
    expect(calls.closes).toEqual([]);
  });

  // #67 — a chunk's resolve attempts are filed under `chunk-<root>`, so a
  // chunk and its own root issue resolving in one cycle cannot overwrite each
  // other's capture; and the pull request carries the same diagnostics the auto
  // lane's issue comment does.
  it("files a chunk's resolve attempts under its own key and reports them on the PR", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      agents: [
        {
          stdout: "<promise>ABANDON</promise><reason>irreconcilable</reason>",
          exitCode: 1,
        },
      ],
      chunkRefs: originHas(42),
    });
    const keys: string[] = [];
    await runMergerWithAdapter([], adapter, undefined, undefined, {
      ...landing(request(42)),
      onResolveAttempt: async (key, record) => {
        keys.push(key);
        return `/logs/cycle-1/resolve-${key}-attempt-${record.attempt}.log`;
      },
    });

    expect(keys).toEqual(["chunk-42"]);
    const body = calls.prComments[0]?.body ?? "";
    expect(body).toContain("**Attempt 1**");
    expect(body).toContain("/logs/cycle-1/resolve-chunk-42-attempt-1.log");
    expect(body).toContain("Conflicted path");
  });

  it("halts, keeping `land`, when origin could not be asked about the branch", async () => {
    // The one that must NOT be read as `branch-missing`: nothing is known
    // about this chunk, so the human's request stands and the next run tries
    // again. Parking here would drop their label and tell them their branch
    // was deleted because a proxy dropped a connection.
    const { adapter, calls } = makeAdapter({
      chunkRefs: {
        "sandbar/chunk-42-c": { kind: "unreadable", detail: "could not read" },
      },
    });
    const err = await runMergerWithAdapter(
      [issue(10)],
      adapter,
      undefined,
      undefined,
      landing(request(42)),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MergerError);
    expect((err as MergerError).message).toContain("could not read");
    expect((err as MergerError).partial?.skippedChunks).toEqual([]);
    expect(calls.merges).toEqual([]);
    expect(calls.prComments).toEqual([]);
    expect(calls.prLabelRemovals).toEqual([]);
    expect(calls.pushes).toBe(0);
  });

  it("parks the chunk when origin no longer has its branch, and never merges", async () => {
    const { adapter, calls } = makeAdapter({ chunkRefs: {} });
    const summary = await runMergerWithAdapter(
      [],
      adapter,
      undefined,
      undefined,
      landing(request(42)),
    );

    expect(calls.merges).toEqual([]);
    expect(summary.skippedChunks.map((s) => s.reason)).toEqual(["branch-missing"]);
    expect(calls.prLabelRemovals).toEqual([{ pr: 542, label: LAND_LABEL }]);
  });

  it("keeps the branch, and the root open, when a member will not close", async () => {
    // #43 is first in the close order and it fails, so #42 — the root the
    // branch is NAMED after — is never asked. That is what the kept branch is
    // for: the next cycle re-derives the same chunk, under the same root, and
    // retries. `chunk-land.ts` owns the argument; this pins that the merge
    // phase's own landing runs it.
    const { adapter, calls } = makeAdapter({
      merges: ["ok"],
      gates: [{ ok: true }],
      chunkRefs: originHas(42),
      closeFailsBeforeSuccess: { 43: 99 },
    });
    const summary = await runMergerWithAdapter(
      [],
      adapter,
      undefined,
      undefined,
      landing(request(42, [42, 43])),
    );

    expect(summary.pushed).toBe(true);
    expect(summary.mergedChunks[0]?.closed).toEqual([]);
    expect(calls.closeAttempts.map((c) => c.n)).toEqual([43]);
    expect(summary.mergedChunks[0]?.branchDeleted).toBe(false);
    expect(calls.chunkBranchDeletes).toEqual([]);
    expect(summary.mergedChunks[0]?.residue.join("\n")).toContain("#43");
  });

  it("parks the chunk with the issues when the forge rejects the composition", async () => {
    const { adapter, calls } = makeAdapter({
      merges: ["ok", "ok"],
      gates: [{ ok: true }, { ok: true }],
      chunkRefs: originHas(42),
      heads: ["cycle-base", "p1", "p2", "verified"],
    });
    const summary = await runMergerWithAdapter(
      [issue(10)],
      adapter,
      undefined,
      undefined,
      {
        ...landing(request(42)),
        verified: {
          adapter: makeVerifyFake({ checkConclusion: "failure" }).verify,
          options: { ...VERIFIED_OPTIONS, maxRounds: 0 },
        },
      },
    );

    expect(summary.merged).toEqual([]);
    expect(summary.pushed).toBe(false);
    expect(summary.skippedChunks.map((s) => s.reason)).toEqual([
      "forge-unverified",
    ]);
    expect(calls.prLabelRemovals).toEqual([{ pr: 542, label: LAND_LABEL }]);
    // The comment says the forge judged the whole composition, naming the
    // issues that were in it beside this chunk.
    expect(calls.prComments[0]?.body).toContain("#10");
  });

  it("names the chunk's members by a ref that resolves, not by the chunk branch", async () => {
    // The merger worktree hangs off the BARE cache, whose imported
    // `refs/heads/*` are deleted, and nothing creates a local chunk head
    // afterwards — so `sandbar/chunk-42-c` resolves nowhere here. The resolve
    // agent is told to go and read the members' work, and only
    // `origin/sandbar/chunk-42-c` is somewhere it can go. The same refs anchor
    // the forge-red prompt one landing mode over.
    const { adapter, calls } = makeAdapter({
      merges: ["conflict"],
      agents: [{ stdout: "<promise>COMMITTED</promise>" }],
      gates: [{ ok: true }],
      chunkRefs: originHas(42),
    });
    await runMergerWithAdapter(
      [],
      adapter,
      undefined,
      undefined,
      landing(request(42, [42, 43])),
    );

    const prompt = calls.agentPrompts[0] ?? "";
    expect(prompt).toContain("Related issue #43");
    expect(prompt).toContain("Branch: refs/remotes/origin/sandbar/chunk-42-c");
    expect(prompt).not.toMatch(/Branch: sandbar\/chunk-42-c/);
  });

  it("hands the forge the composition in MERGE order, chunk members underneath", async () => {
    // `runVerifiedLanding` anchors its forge-red resolve prompt on the LAST
    // entry and documents it as the topmost merge. Chunks are merged first and
    // this cycle's branches on top, so the chunk's members have to come first
    // here — the other way round, the agent would be pointed at the bottom-most
    // commit in the composition and told it was the top.
    const { adapter } = makeAdapter({
      merges: ["ok", "ok"],
      gates: [{ ok: true }, { ok: true }],
      chunkRefs: originHas(42),
      heads: ["cycle-base", "p1", "p2", "verified"],
    });
    const { verify, vCalls } = makeVerifyFake();
    await runMergerWithAdapter([issue(10)], adapter, undefined, undefined, {
      ...landing(request(42, [42, 43])),
      verified: {
        adapter: verify,
        options: { ...VERIFIED_OPTIONS, openPullRequest: true },
      },
    });

    const body = vCalls.prBodies[0] ?? "";
    expect(body).toContain("- #42 — t-42");
    expect(body).toContain("- #10 — t-10");
    expect(body.indexOf("- #43 —")).toBeLessThan(body.indexOf("- #10 —"));
  });

  it("carries parked chunks on a MergerError partial", async () => {
    // The pull request has already been written to by the time a later issue
    // in the same cycle blows the loop up, so that write has to reach Phase 4.
    const { adapter } = makeAdapter({
      merges: ["conflict", "ok"],
      agents: [{ stdout: "<promise>ABANDON</promise><reason>nope</reason>" }],
      gates: [],
      chunkRefs: originHas(42),
    });
    const err = await runMergerWithAdapter(
      [issue(10)],
      adapter,
      undefined,
      undefined,
      landing(request(42)),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MergerError);
    expect((err as MergerError).partial?.skippedChunks.map((s) => s.reason)).toEqual([
      "conflict",
    ]);
    expect((err as MergerError).partial?.mergedChunks).toEqual([]);
  });
});
