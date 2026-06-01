import { describe, expect, it } from "vitest";

import {
  BOT_COMMENT_PREFIX,
  type FinalizeAdapter,
  type FinalizeInput,
  NEEDS_HUMAN_COMMENT_TEMPLATE,
  NEEDS_HUMAN_LABEL,
  NEEDS_INFO_COMMENT_TEMPLATE,
  NEEDS_INFO_LABEL,
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE,
  finalizeAll,
  finalizeOne,
  issueNumberOf,
  worktreePathFor,
} from "./finalize.js";
import type { IssueRef } from "./merger.js";

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
  it("NEEDS-INFO body includes bot prefix and the questions verbatim", () => {
    const body = NEEDS_INFO_COMMENT_TEMPLATE("Q1?\nQ2?");
    expect(body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(body).toContain("Q1?");
    expect(body).toContain("Q2?");
  });
  it("NEEDS-HUMAN body includes bot prefix and the failure trace", () => {
    const body = NEEDS_HUMAN_COMMENT_TEMPLATE("E: boom\nstack…");
    expect(body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(body).toContain("E: boom");
    expect(body).toContain("stack…");
  });
  it("REVIEW_BUDGET_EXHAUSTED body includes bot prefix and the latest reviewer prose verbatim", () => {
    const body = REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE(
      "## Bar violations\n- foo not extracted\n- naming is unclear",
    );
    expect(body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(body).toContain("foo not extracted");
    expect(body).toContain("naming is unclear");
  });
});

describe("finalizeOne", () => {
  it("merged: removes worktree before deleting branch, drops ready-for-agent on the closed issue, no push, no comment", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne({ kind: "merged", issue: i }, adapter);

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.deletes).toEqual([i.branch]);
    expect(calls.pushes).toEqual([]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT_LABEL], add: [] },
    ]);
  });

  it("merged with -d refusal: escalates to -D and returns deleted-local", async () => {
    const { adapter, calls } = makeAdapter({
      deleteOk: false,
      deleteError: "branch X not fully merged",
    });
    const i = issue(45);
    const action = await finalizeOne({ kind: "merged", issue: i }, adapter);

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
    const action = await finalizeOne({ kind: "merged", issue: i }, adapter);

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
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.deletes).toEqual([]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [], add: [READY_FOR_HUMAN_LABEL] },
    ]);
  });

  it("merge-gate-red: removes worktree, pushes branch + adds ready-for-human (merger already commented + dropped ready-for-agent)", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "merge-gate-red", issue: i },
      adapter,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.deletes).toEqual([]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [], add: [READY_FOR_HUMAN_LABEL] },
    ]);
  });

  it("needs-info: removes worktree, pushes, comments with questions, swaps labels in one editLabels call", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "needs-info", issue: i, questions: "Should X be Y?" },
      adapter,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]!.n).toBe(45);
    expect(calls.comments[0]!.body).toContain("Should X be Y?");
    expect(calls.comments[0]!.body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT_LABEL], add: [NEEDS_INFO_LABEL] },
    ]);
  });

  it("needs-human: removes worktree, pushes, comments with failure trace, swaps labels", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "needs-human", issue: i, failureTrace: "AssertionError: red" },
      adapter,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]!.body).toContain("AssertionError: red");
    expect(calls.comments[0]!.body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT_LABEL], add: [NEEDS_HUMAN_LABEL] },
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
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]!.n).toBe(45);
    expect(calls.comments[0]!.body).toContain("too much indirection");
    expect(calls.comments[0]!.body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT_LABEL], add: [NEEDS_HUMAN_LABEL] },
    ]);
  });

  it("hard-error with commits: removes worktree, pushes only, no label flip, no comment", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "hard-error", issue: i, hasCommits: true },
      adapter,
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
    );

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.pushes).toEqual([]);
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]!.body).toContain("2 times");
    expect(calls.comments[0]!.body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT_LABEL], add: [READY_FOR_HUMAN_LABEL] },
    ]);
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

    const results = await finalizeAll(inputs, adapter);

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
      { n: 10, remove: [READY_FOR_AGENT_LABEL], add: [] },
      { n: 11, remove: [READY_FOR_AGENT_LABEL], add: [NEEDS_INFO_LABEL] },
      { n: 12, remove: [], add: [READY_FOR_HUMAN_LABEL] },
    ]);
  });

  it("empty inputs: empty results, no adapter calls", async () => {
    const { adapter, calls } = makeAdapter();
    const results = await finalizeAll([], adapter);

    expect(results).toEqual([]);
    expect(calls.pushes).toEqual([]);
    expect(calls.deletes).toEqual([]);
    expect(calls.worktreeRemoves).toEqual([]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
  });
});
