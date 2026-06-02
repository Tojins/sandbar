import { describe, expect, it } from "vitest";

import { DEFAULT_LABELS, type LabelConfig } from "./config.js";
import { SandbarError } from "./errors.js";
import {
  BOT_COMMENT_PREFIX,
  type FinalizeAdapter,
  type FinalizeInput,
  NEEDS_HUMAN_COMMENT_TEMPLATE,
  NEEDS_INFO_COMMENT_TEMPLATE,
  READY_FOR_AGENT_LABEL as READY_FOR_AGENT,
  REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE,
  finalizeAll,
  finalizeOne,
  issueNumberOf,
  worktreePathFor,
} from "./finalize.js";
import type { IssueRef } from "./merger.js";

const LABELS: LabelConfig = DEFAULT_LABELS;
const { needsInfo: NEEDS_INFO, agentStuck: AGENT_STUCK } = DEFAULT_LABELS;

function issue(n: number, title = `t-${n}`): IssueRef {
  return {
    id: String(n),
    title,
    branch: `sandcastle/issue-${n}-${title}`,
  };
}

type Calls = {
  pushes: string[];
  deletes: string[];
  forceDeletes: string[];
  worktreeRemoves: string[];
  comments: { n: number; body: string }[];
  labelEdits: { n: number; remove: readonly string[]; add: readonly string[] }[];
};

type Script = {
  deleteOk?: boolean;
  deleteError?: string;
  forceDeleteOk?: boolean;
  forceDeleteError?: string;
  labelEditOk?: boolean;
  labelEditError?: string;
};

function makeAdapter(
  script: Script = {},
): { adapter: FinalizeAdapter; calls: Calls } {
  const calls: Calls = {
    pushes: [],
    deletes: [],
    forceDeletes: [],
    worktreeRemoves: [],
    comments: [],
    labelEdits: [],
  };
  const adapter: FinalizeAdapter = {
    async pushBranch(branch) {
      calls.pushes.push(branch);
    },
    async deleteBranch(branch) {
      calls.deletes.push(branch);
      if (script.deleteOk === false) {
        return { ok: false, error: script.deleteError ?? "not merged" };
      }
      return { ok: true };
    },
    async forceDeleteBranch(branch) {
      calls.forceDeletes.push(branch);
      if (script.forceDeleteOk === false) {
        return {
          ok: false,
          error: script.forceDeleteError ?? "force delete failed",
        };
      }
      return { ok: true };
    },
    async removeWorktreeFor(branch) {
      calls.worktreeRemoves.push(branch);
    },
    async postComment(n, body) {
      calls.comments.push({ n, body });
    },
    async editLabels(n, remove, add) {
      calls.labelEdits.push({ n, remove, add });
      if (script.labelEditOk === false) {
        return { ok: false, error: script.labelEditError ?? "'agent-stuck' not found" };
      }
      return { ok: true };
    },
  };
  return { adapter, calls };
}

describe("issueNumberOf", () => {
  it("parses positive integer ids", () => {
    expect(issueNumberOf(issue(45))).toBe(45);
  });
  it("rejects non-positive or non-integer ids", () => {
    expect(() => issueNumberOf({ id: "0", title: "x", branch: "y" })).toThrow();
    expect(() => issueNumberOf({ id: "-3", title: "x", branch: "y" })).toThrow();
    expect(() => issueNumberOf({ id: "abc", title: "x", branch: "y" })).toThrow();
  });
});

describe("worktreePathFor", () => {
  it("composes from repoDir + workDir + branch (slashes replaced)", () => {
    expect(worktreePathFor("/repo", ".sandbar", "sandcastle/issue-45-foo")).toBe(
      "/repo/.sandbar/worktrees/sandcastle-issue-45-foo",
    );
  });

  it("works with a different workDir", () => {
    expect(worktreePathFor("/repo", ".sandcastle", "sandcastle/issue-45-foo")).toBe(
      "/repo/.sandcastle/worktrees/sandcastle-issue-45-foo",
    );
  });
});

describe("comment templates", () => {
  it("NEEDS-INFO body includes bot prefix, the questions verbatim, and the configured labels", () => {
    const body = NEEDS_INFO_COMMENT_TEMPLATE("Q1?\nQ2?", NEEDS_INFO, READY_FOR_AGENT);
    expect(body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(body).toContain("Q1?");
    expect(body).toContain("Q2?");
    expect(body).toContain(NEEDS_INFO);
    expect(body).toContain(READY_FOR_AGENT);
  });
  it("NEEDS-HUMAN body includes bot prefix, the failure trace, and the configured labels", () => {
    const body = NEEDS_HUMAN_COMMENT_TEMPLATE("E: boom\nstack…", AGENT_STUCK, READY_FOR_AGENT);
    expect(body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(body).toContain("E: boom");
    expect(body).toContain("stack…");
    expect(body).toContain(AGENT_STUCK);
    expect(body).toContain(READY_FOR_AGENT);
  });
  it("REVIEW_BUDGET_EXHAUSTED body includes bot prefix, the latest reviewer prose verbatim, and the configured labels", () => {
    const body = REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE(
      "## Bar violations\n- foo not extracted\n- naming is unclear",
      AGENT_STUCK,
      READY_FOR_AGENT,
    );
    expect(body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(body).toContain("foo not extracted");
    expect(body).toContain("naming is unclear");
    expect(body).toContain(AGENT_STUCK);
  });
});

describe("finalizeOne", () => {
  it("merged: removes worktree before deleting branch, drops ready-for-agent on the closed issue, no push, no comment", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne({ kind: "merged", issue: i }, adapter, LABELS);

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.deletes).toEqual([i.branch]);
    expect(calls.pushes).toEqual([]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [] },
    ]);
  });

  it("merged with -d refusal: escalates to -D and returns deleted-local", async () => {
    const { adapter, calls } = makeAdapter({
      deleteOk: false,
      deleteError: "branch X not fully merged",
    });
    const i = issue(45);
    const action = await finalizeOne({ kind: "merged", issue: i }, adapter, LABELS);

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.deletes).toEqual([i.branch]);
    expect(calls.forceDeletes).toEqual([i.branch]);
  });

  it("merged with both -d and -D failing: surfaces force-delete error", async () => {
    const { adapter, calls } = makeAdapter({
      deleteOk: false,
      deleteError: "not fully merged",
      forceDeleteOk: false,
      forceDeleteError: "ref locked",
    });
    const i = issue(45);
    const action = await finalizeOne({ kind: "merged", issue: i }, adapter, LABELS);

    expect(action.kind).toBe("delete-failed");
    if (action.kind === "delete-failed") {
      expect(action.error).toContain("ref locked");
    }
    expect(calls.deletes).toEqual([i.branch]);
    expect(calls.forceDeletes).toEqual([i.branch]);
  });

  it("merge-conflict: removes worktree, pushes branch + adds ready-for-human (merger already commented + dropped ready-for-agent)", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "merge-conflict", issue: i },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.deletes).toEqual([]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [], add: [AGENT_STUCK] },
    ]);
  });

  it("merge-gate-red: removes worktree, pushes branch + adds ready-for-human (merger already commented + dropped ready-for-agent)", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "merge-gate-red", issue: i },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.deletes).toEqual([]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [], add: [AGENT_STUCK] },
    ]);
  });

  it("needs-info: removes worktree, pushes, comments with questions, swaps labels in one editLabels call", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "needs-info", issue: i, questions: "Should X be Y?" },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]!.n).toBe(45);
    expect(calls.comments[0]!.body).toContain("Should X be Y?");
    expect(calls.comments[0]!.body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [NEEDS_INFO] },
    ]);
  });

  it("needs-human: removes worktree, pushes, comments with failure trace, swaps labels", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "needs-human", issue: i, failureTrace: "AssertionError: red" },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]!.body).toContain("AssertionError: red");
    expect(calls.comments[0]!.body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
  });

  it("review-budget-exhausted: removes worktree, pushes, comments with latest reviewer prose, swaps labels to needs-human", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      {
        kind: "review-budget-exhausted",
        issue: i,
        latestReviewerProse: "## Bar violations\n- too much indirection",
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]!.n).toBe(45);
    expect(calls.comments[0]!.body).toContain("too much indirection");
    expect(calls.comments[0]!.body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
  });

  it("hard-error with commits: removes worktree, pushes only, no label flip, no comment", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "hard-error", issue: i, hasCommits: true },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.deletes).toEqual([]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
  });

  it("hard-error without commits: removes worktree, deletes branch, no push, no comment", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "hard-error", issue: i, hasCommits: false },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.deletes).toEqual([i.branch]);
    expect(calls.pushes).toEqual([]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
  });

  it("hard-error without commits + delete failure: surfaces delete-failed", async () => {
    const { adapter } = makeAdapter({
      deleteOk: false,
      deleteError: "ref locked",
    });
    const action = await finalizeOne(
      { kind: "hard-error", issue: issue(45), hasCommits: false },
      adapter,
      LABELS,
    );

    expect(action.kind).toBe("delete-failed");
  });

  it("fresh-attempt: removes worktree + force-deletes branch (its tip has commits not on source), no push, no comment, no labels", async () => {
    const { adapter, calls } = makeAdapter({
      deleteOk: false,
      deleteError: "not fully merged",
    });
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "fresh-attempt", issue: i },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.deletes).toEqual([i.branch]);
    expect(calls.forceDeletes).toEqual([i.branch]);
    expect(calls.pushes).toEqual([]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
  });

  it("fresh-attempt: -d alone succeeding skips the -D fallback", async () => {
    const { adapter, calls } = makeAdapter();
    const action = await finalizeOne(
      { kind: "fresh-attempt", issue: issue(45) },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.forceDeletes).toEqual([]);
  });

  it("silent-noop-exhausted: posts attempt-count comment, flips labels, no push", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "silent-noop-exhausted", issue: i, attempts: 2 },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.pushes).toEqual([]);
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]!.body).toContain("2 times");
    expect(calls.comments[0]!.body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
  });

  it("needs-human with a failed handoff label flip: still pushes + comments, then THROWS SandbarError (fail loud, #8)", async () => {
    const { adapter, calls } = makeAdapter({
      labelEditOk: false,
      labelEditError: "'agent-stuck' not found",
    });
    const i = issue(45);
    await expect(
      finalizeOne({ kind: "needs-human", issue: i, failureTrace: "boom" }, adapter, LABELS),
    ).rejects.toThrow(SandbarError);

    // The push, comment, and the (remove-first) flip were all still attempted
    // before the loud failure — only the missing handoff label is the problem.
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.comments.length).toBe(1);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
  });

  it("needs-human flip failure: the thrown error names the issue and the config cause", async () => {
    const { adapter } = makeAdapter({ labelEditOk: false, labelEditError: "'agent-stuck' not found" });
    await expect(
      finalizeOne({ kind: "needs-human", issue: issue(45), failureTrace: "boom" }, adapter, LABELS),
    ).rejects.toThrow(/#45.*agent-stuck.*config/s);
  });

  it("review-budget-exhausted with a failed handoff label flip: throws SandbarError", async () => {
    const { adapter } = makeAdapter({ labelEditOk: false });
    await expect(
      finalizeOne(
        { kind: "review-budget-exhausted", issue: issue(45), latestReviewerProse: "violations" },
        adapter,
        LABELS,
      ),
    ).rejects.toThrow(SandbarError);
  });

  it("merge-conflict with a failed handoff label flip: throws SandbarError", async () => {
    const { adapter } = makeAdapter({ labelEditOk: false });
    await expect(
      finalizeOne({ kind: "merge-conflict", issue: issue(45) }, adapter, LABELS),
    ).rejects.toThrow(SandbarError);
  });

  it("silent-noop-exhausted with a failed handoff label flip: throws SandbarError", async () => {
    const { adapter } = makeAdapter({ labelEditOk: false });
    await expect(
      finalizeOne({ kind: "silent-noop-exhausted", issue: issue(45), attempts: 2 }, adapter, LABELS),
    ).rejects.toThrow(SandbarError);
  });

  it("merged with a failed label cleanup: stays best-effort, does NOT throw (#7 cosmetic)", async () => {
    const { adapter, calls } = makeAdapter({ labelEditOk: false });
    const action = await finalizeOne({ kind: "merged", issue: issue(45) }, adapter, LABELS);
    // Closed-issue label cleanup is benign — the planner only lists open issues.
    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.labelEdits).toEqual([{ n: 45, remove: [READY_FOR_AGENT], add: [] }]);
  });

  it("a thrown required side-effect (push) propagates — finalizeOne does not swallow", async () => {
    const { adapter } = makeAdapter();
    const throwing: FinalizeAdapter = {
      ...adapter,
      async pushBranch() {
        throw new SandbarError("Failed to push branch 'x' to origin: boom");
      },
    };
    await expect(
      finalizeOne({ kind: "needs-human", issue: issue(45), failureTrace: "t" }, throwing, LABELS),
    ).rejects.toThrow(SandbarError);
  });

  it("custom labels: a host's configured handoff label is used in the flip + comment", async () => {
    const { adapter, calls } = makeAdapter();
    const custom: LabelConfig = {
      needsInfo: "blocked-q",
      agentStuck: "human-takeover",
    };
    const action = await finalizeOne(
      { kind: "needs-human", issue: issue(45), failureTrace: "boom" },
      adapter,
      custom,
    );

    expect(action).toEqual({ kind: "pushed" });
    // The queue label removed is the fixed protocol label; only the handoff
    // (add) label is host-configurable.
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: ["human-takeover"] },
    ]);
    expect(calls.comments[0]!.body).toContain("human-takeover");
  });
});

describe("finalizeAll", () => {
  it("processes inputs in order and returns one result per input", async () => {
    const { adapter, calls } = makeAdapter();
    const inputs: FinalizeInput[] = [
      { kind: "merged", issue: issue(10) },
      { kind: "needs-info", issue: issue(11), questions: "?" },
      { kind: "merge-gate-red", issue: issue(12) },
      { kind: "hard-error", issue: issue(13), hasCommits: true },
    ];

    const results = await finalizeAll(inputs, adapter, LABELS);

    expect(results.map((r) => r.action.kind)).toEqual([
      "deleted-local",
      "pushed",
      "pushed",
      "pushed",
    ]);
    expect(calls.pushes).toEqual([
      "sandcastle/issue-11-t-11",
      "sandcastle/issue-12-t-12",
      "sandcastle/issue-13-t-13",
    ]);
    expect(calls.deletes).toEqual(["sandcastle/issue-10-t-10"]);
    expect(calls.worktreeRemoves).toEqual([
      "sandcastle/issue-10-t-10",
      "sandcastle/issue-11-t-11",
      "sandcastle/issue-12-t-12",
      "sandcastle/issue-13-t-13",
    ]);
    expect(calls.labelEdits).toEqual([
      { n: 10, remove: [READY_FOR_AGENT], add: [] },
      { n: 11, remove: [READY_FOR_AGENT], add: [NEEDS_INFO] },
      { n: 12, remove: [], add: [AGENT_STUCK] },
    ]);
  });

  it("empty inputs: empty results, no adapter calls", async () => {
    const { adapter, calls } = makeAdapter();
    const results = await finalizeAll([], adapter, LABELS);

    expect(results).toEqual([]);
    expect(calls.pushes).toEqual([]);
    expect(calls.deletes).toEqual([]);
    expect(calls.worktreeRemoves).toEqual([]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
  });
});
