import { describe, expect, it } from "vitest";

import { DEFAULT_LABELS, type LabelConfig } from "./config.js";
import { SandbarError } from "./errors.js";
import {
  BOT_COMMENT_PREFIX,
  type FinalizeAdapter,
  type FinalizeInput,
  NEEDS_HUMAN_COMMENT_TEMPLATE,
  NEEDS_HUMAN_REVIEWER_BLOCKED_COMMENT_TEMPLATE,
  NEEDS_INFO_COMMENT_TEMPLATE,
  NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE,
  NO_PROTOTYPE_NEEDED_PHRASE,
  READY_FOR_AGENT_LABEL as READY_FOR_AGENT,
  REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE,
  finalizeAll,
  finalizeOne,
  issueNumberOf,
} from "./finalize.js";
import type { IssueRef } from "./merger.js";
import { repoLayout, worktreePathFor } from "./repo-cache.js";

const LABELS: LabelConfig = DEFAULT_LABELS;
const { needsInfo: NEEDS_INFO, agentStuck: AGENT_STUCK } = DEFAULT_LABELS;

function issue(n: number, title = `t-${n}`): IssueRef {
  return {
    id: String(n),
    title,
    branch: `sandbar/issue-${n}-${title}`,
  };
}

type Calls = {
  pushes: string[];
  deletes: string[];
  forceDeletes: string[];
  worktreeRemoves: string[];
  comments: { n: number; body: string }[];
  labelEdits: { n: number; remove: readonly string[]; add: readonly string[] }[];
  stateChecks: number[];
  containmentChecks: string[];
};

type Script = {
  deleteOk?: boolean;
  deleteError?: string;
  forceDeleteOk?: boolean;
  forceDeleteError?: string;
  labelEditOk?: boolean;
  labelEditError?: string;
  issueState?: "OPEN" | "CLOSED";
  containedInOrigin?: boolean;
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
    stateChecks: [],
    containmentChecks: [],
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
    async branchIsContainedInOrigin(branch) {
      calls.containmentChecks.push(branch);
      // Default true: the common case is a branch still sitting at the origin
      // tip it was seeded from. Cases that model leftover commits set it false.
      return script.containedInOrigin ?? true;
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
    async issueState(n) {
      calls.stateChecks.push(n);
      return script.issueState ?? "OPEN";
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
  it("composes from the worktrees dir + branch (slashes replaced)", () => {
    expect(
      worktreePathFor("/repo/.sandbar/worktrees", "sandbar/issue-45-foo"),
    ).toBe("/repo/.sandbar/worktrees/sandbar-issue-45-foo");
  });

  it("works with a different workDir", () => {
    expect(
      worktreePathFor(
        repoLayout("/repo", ".custom-wd").worktreesDir,
        "sandbar/issue-45-foo",
      ),
    ).toBe("/repo/.custom-wd/worktrees/sandbar-issue-45-foo");
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
  it("NEEDS-UI-PROTOTYPE body includes bot prefix, the impact prose, both unblock routes, and the configured labels", () => {
    const body = NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE(
      45,
      "New settings screen; tab order and empty state invented.",
      NEEDS_INFO,
      READY_FOR_AGENT,
      null,
    );
    expect(body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(body).toContain("tab order and empty state invented");
    // Both ways out must be stated: attach a readable artifact, or say the
    // agent may decide for itself (#21 — the acknowledgement is what stops the
    // next run from escalating again).
    expect(body).toContain(NO_PROTOTYPE_NEEDED_PHRASE);
    expect(body).toContain("cannot see images");
    expect(body).toContain(NEEDS_INFO);
    expect(body).toContain(READY_FOR_AGENT);
    // The suggested path carries the real issue number, not a literal <n>.
    expect(body).toContain("docs/prototypes/issue-45.html");
    expect(body).not.toContain("issue-<n>");
  });

  // The escalation is accepted after commits (see promise-parser), and then the
  // branch IS pushed — telling the human nothing was written would contradict
  // the branch they've just been handed.
  it("NEEDS-UI-PROTOTYPE body claims 'before writing any code' only when nothing was pushed", () => {
    const early = NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE(
      45,
      "x",
      NEEDS_INFO,
      READY_FOR_AGENT,
      null,
    );
    expect(early).toContain("before writing any code");
    expect(early).not.toContain("pushed");

    const late = NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE(
      45,
      "x",
      NEEDS_INFO,
      READY_FOR_AGENT,
      "sandbar/issue-45-t-45",
    );
    expect(late).not.toContain("before writing any code");
    expect(late).toContain("sandbar/issue-45-t-45");
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

  it("forge-unverified: pushes the branch + parks it (the merger already commented + dropped ready-for-agent)", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "forge-unverified", issue: i },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    // The branch must reach the forge: it is what the human inspects against
    // the failing check runs.
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.deletes).toEqual([]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [], add: [AGENT_STUCK] },
    ]);
  });

  it("forge-unverified on an already-CLOSED issue: no push, no label flip (#16)", async () => {
    const { adapter, calls } = makeAdapter({ issueState: "CLOSED" });
    const action = await finalizeOne(
      { kind: "forge-unverified", issue: issue(45) },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "skipped-closed" });
    expect(calls.pushes).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
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

  // #21. The escalation normally fires before a line of code exists, so there
  // is nothing to push and nothing worth keeping on the branch.
  it("needs-ui-prototype without commits: no push, comments, swaps labels, drops the local branch", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      {
        kind: "needs-ui-prototype",
        issue: i,
        uiImpact: "New settings screen; tab order invented.",
        hasCommits: false,
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.pushes).toEqual([]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.deletes).toEqual([i.branch]);
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]!.n).toBe(45);
    expect(calls.comments[0]!.body).toContain("New settings screen; tab order invented.");
    expect(calls.comments[0]!.body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [NEEDS_INFO] },
    ]);
  });

  // `-d` also refuses when the local source branch merely trails the origin tip
  // the branch was seeded from — so a refusal alone is not licence to force.
  // Containment on origin is what makes forcing safe.
  it("needs-ui-prototype without commits: force-deletes when -d refuses but the branch is contained in origin", async () => {
    const { adapter, calls } = makeAdapter({
      deleteOk: false,
      containedInOrigin: true,
    });
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "needs-ui-prototype", issue: i, uiImpact: "x", hasCommits: false },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.containmentChecks).toEqual([i.branch]);
    expect(calls.forceDeletes).toEqual([i.branch]);
  });

  // The regression this guard exists for: `hasCommits` is per-sandbox-cycle, so
  // a HARD-ERROR retry (or a branch left by an interrupted earlier run) reports
  // false while unpushed commits sit on the branch. Forcing would destroy work
  // that was never pushed anywhere.
  it("needs-ui-prototype without commits: keeps the branch when it carries commits not on origin", async () => {
    const { adapter, calls } = makeAdapter({
      deleteOk: false,
      deleteError: "not fully merged",
      containedInOrigin: false,
    });
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "needs-ui-prototype", issue: i, uiImpact: "x", hasCommits: false },
      adapter,
      LABELS,
    );

    expect(action.kind).toBe("delete-failed");
    if (action.kind === "delete-failed") {
      expect(action.error).toContain("not on origin");
    }
    expect(calls.forceDeletes).toEqual([]);
    // The handoff itself still completed — the human gets the comment and the
    // label flip regardless of what happened to the local branch.
    expect(calls.comments.length).toBe(1);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [NEEDS_INFO] },
    ]);
  });

  it("needs-ui-prototype without commits: never checks containment when -d succeeds", async () => {
    const { adapter, calls } = makeAdapter();
    const action = await finalizeOne(
      {
        kind: "needs-ui-prototype",
        issue: issue(45),
        uiImpact: "x",
        hasCommits: false,
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.containmentChecks).toEqual([]);
  });

  it("needs-ui-prototype: a failed label flip throws before the branch is deleted", async () => {
    const { adapter, calls } = makeAdapter({ labelEditOk: false });
    const i = issue(45);
    await expect(
      finalizeOne(
        { kind: "needs-ui-prototype", issue: i, uiImpact: "x", hasCommits: false },
        adapter,
        LABELS,
      ),
    ).rejects.toBeInstanceOf(SandbarError);
    // The branch survives the loud failure, so a re-run has something to work
    // with once the operator fixes the label config.
    expect(calls.deletes).toEqual([]);
    expect(calls.forceDeletes).toEqual([]);
  });

  it("needs-ui-prototype with commits on an already-CLOSED issue: no push, branch kept (#16)", async () => {
    const { adapter, calls } = makeAdapter({ issueState: "CLOSED" });
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "needs-ui-prototype", issue: i, uiImpact: "x", hasCommits: true },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "skipped-closed" });
    expect(calls.pushes).toEqual([]);
    // Committed work is not pushed, but nothing destroys it either — the local
    // branch is left intact for the operator.
    expect(calls.deletes).toEqual([]);
    expect(calls.forceDeletes).toEqual([]);
  });

  // A late escalation: the agent committed before it realised it was inventing
  // UI, so the partial work is handed to the human and the branch is kept.
  it("needs-ui-prototype with commits: pushes and keeps the branch", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "needs-ui-prototype", issue: i, uiImpact: "x", hasCommits: true },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.deletes).toEqual([]);
    expect(calls.forceDeletes).toEqual([]);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [NEEDS_INFO] },
    ]);
  });

  it("needs-ui-prototype on an already-CLOSED issue: no comment, no label flip (#16)", async () => {
    const { adapter, calls } = makeAdapter({ issueState: "CLOSED" });
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "needs-ui-prototype", issue: i, uiImpact: "x", hasCommits: false },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "skipped-closed" });
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
  });

  it("needs-human: removes worktree, pushes, comments with failure trace, swaps labels", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      {
        kind: "needs-human",
        issue: i,
        cause: "gate-red",
        failureTrace: "AssertionError: red",
        latestReviewerProse: null,
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]!.body).toContain("AssertionError: red");
    expect(calls.comments[0]!.body).toContain("without a green gate");
    expect(calls.comments[0]!.body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
  });

  it("needs-human reviewer-blocked: comments with the reviewer prose and names the green gate, not 'no green gate' (#17)", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      {
        kind: "needs-human",
        issue: i,
        cause: "reviewer-blocked",
        failureTrace: "",
        latestReviewerProse: "## Extract the duplicated lifecycle dispatch",
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.comments.length).toBe(1);
    const body = calls.comments[0]!.body;
    expect(body).toContain("Extract the duplicated lifecycle dispatch");
    expect(body).toContain("green gate");
    expect(body).toContain("CHANGES-REQUESTED");
    // Must NOT misreport the gate as the blocker.
    expect(body).not.toContain("without a green gate");
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
  });

  it("needs-human off-branch-head: names the branch, the stranded sha, and how to rescue it (#27)", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      {
        kind: "needs-human",
        issue: i,
        cause: "off-branch-head",
        failureTrace:
          "You are not on the issue branch. HEAD is DETACHED at deadbeef1234,",
        latestReviewerProse: null,
        strandedHead: {
          branch: `sandbar/issue-45-t-45`,
          headRef: null,
          headSha: "deadbeef1234",
          branchSha: "base00",
        },
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    const body = calls.comments[0]!.body;
    expect(body).toContain(i.branch);
    // The comment is the last place this sha survives: removeWorktreeFor takes
    // the per-worktree HEAD reflog with it.
    expect(body).toContain("deadbeef1234");
    expect(body).toContain("git branch <rescue-name> deadbeef1234");
    // Must NOT claim no gate ran / the branch never moved: on the path that
    // actually reaches this terminal, attempt 1 committed on the branch and a
    // gate went green on it.
    expect(body).not.toContain("without a green gate");
    expect(body).not.toContain("No gate ran");
    expect(body).not.toContain("never moved");
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
  });

  // #27. The exemption that lets an off-branch NEEDS-UI-PROTOTYPE through must
  // not also lose the work: hasCommits is false (commits are counted on the
  // branch), so this arm deletes the branch, and without the note the detached
  // sha would appear in no comment, no log and no ref.
  it("needs-ui-prototype: names the stranded sha even though it deletes the branch (#27)", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      {
        kind: "needs-ui-prototype",
        issue: i,
        uiImpact: "a new settings screen",
        hasCommits: false,
        strandedHead: {
          branch: i.branch,
          headRef: null,
          headSha: "abc9999",
          branchSha: "base00",
        },
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.pushes).toEqual([]);
    const body = calls.comments[0]!.body;
    expect(body).toContain("a new settings screen");
    expect(body).toContain("abc9999");
    expect(body).toContain("git branch <rescue-name> abc9999");
  });

  it("needs-info: appends the stranded-commits note when the run went off-branch (#27)", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    await finalizeOne(
      {
        kind: "needs-info",
        issue: i,
        questions: "which currency?",
        strandedHead: {
          branch: i.branch,
          headRef: null,
          headSha: "abc9999",
          branchSha: "base00",
        },
      },
      adapter,
      LABELS,
    );
    const body = calls.comments[0]!.body;
    expect(body).toContain("which currency?");
    expect(body).toContain("abc9999");
  });

  it("says nothing about stranded work on an ordinary on-branch handoff", async () => {
    const { adapter, calls } = makeAdapter();
    await finalizeOne(
      {
        kind: "needs-info",
        issue: issue(45),
        questions: "which currency?",
        strandedHead: null,
      },
      adapter,
      LABELS,
    );
    expect(calls.comments[0]!.body).not.toContain("Work was left off");
  });

  // A scratch branch is a real local ref: it survives worktree removal and gc.
  // Telling that reader the commits are unreachable and about to be pruned
  // sends them to rescue something in no danger, under a false description of
  // their own repo.
  it("does not claim a scratch branch's commits are unreachable (#27)", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    await finalizeOne(
      {
        kind: "needs-info",
        issue: i,
        questions: "which currency?",
        strandedHead: {
          branch: i.branch,
          headRef: "refs/heads/my-work",
          headSha: "abc9999",
          branchSha: "base00",
        },
      },
      adapter,
      LABELS,
    );
    const body = calls.comments[0]!.body;
    expect(body).toContain("refs/heads/my-work");
    expect(body).not.toContain("git gc");
    expect(body).not.toContain("rescue-name");
    expect(body).toContain("cherry-pick");
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
      finalizeOne(
        {
          kind: "needs-human",
          issue: i,
          cause: "gate-red",
          failureTrace: "boom",
          latestReviewerProse: null,
        },
        adapter,
        LABELS,
      ),
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
      finalizeOne(
        {
          kind: "needs-human",
          issue: issue(45),
          cause: "gate-red",
          failureTrace: "boom",
          latestReviewerProse: null,
        },
        adapter,
        LABELS,
      ),
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
      finalizeOne(
        {
          kind: "needs-human",
          issue: issue(45),
          cause: "gate-red",
          failureTrace: "t",
          latestReviewerProse: null,
        },
        throwing,
        LABELS,
      ),
    ).rejects.toThrow(SandbarError);
  });

  it("custom labels: a host's configured handoff label is used in the flip + comment", async () => {
    const { adapter, calls } = makeAdapter();
    const custom: LabelConfig = {
      needsInfo: "blocked-q",
      agentStuck: "human-takeover",
    };
    const action = await finalizeOne(
      {
        kind: "needs-human",
        issue: issue(45),
        cause: "gate-red",
        failureTrace: "boom",
        latestReviewerProse: null,
      },
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

  // #16: a handoff terminal must never annotate an already-CLOSED issue.
  it("needs-human on a CLOSED issue: skips comment + labels + push, only reclaims the worktree", async () => {
    const { adapter, calls } = makeAdapter({ issueState: "CLOSED" });
    const i = issue(45);
    const action = await finalizeOne(
      {
        kind: "needs-human",
        issue: i,
        cause: "gate-red",
        failureTrace: "boom",
        latestReviewerProse: null,
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "skipped-closed" });
    expect(calls.stateChecks).toEqual([45]);
    expect(calls.worktreeRemoves).toEqual([i.branch]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
    expect(calls.pushes).toEqual([]);
  });

  it("merge-conflict on a CLOSED issue: skipped-closed, no handoff label flip", async () => {
    const { adapter, calls } = makeAdapter({ issueState: "CLOSED" });
    const action = await finalizeOne(
      { kind: "merge-conflict", issue: issue(45) },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "skipped-closed" });
    expect(calls.labelEdits).toEqual([]);
    expect(calls.pushes).toEqual([]);
  });

  it("merged is exempt from the closed-issue guard (the merge closed it by design)", async () => {
    // CLOSED is the expected state for a merged issue; it must still run its
    // worktree+branch cleanup and the cosmetic ready-for-agent drop.
    const { adapter, calls } = makeAdapter({ issueState: "CLOSED" });
    const action = await finalizeOne({ kind: "merged", issue: issue(45) }, adapter, LABELS);

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.stateChecks).toEqual([]);
    expect(calls.labelEdits).toEqual([{ n: 45, remove: [READY_FOR_AGENT], add: [] }]);
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
      "sandbar/issue-11-t-11",
      "sandbar/issue-12-t-12",
      "sandbar/issue-13-t-13",
    ]);
    expect(calls.deletes).toEqual(["sandbar/issue-10-t-10"]);
    expect(calls.worktreeRemoves).toEqual([
      "sandbar/issue-10-t-10",
      "sandbar/issue-11-t-11",
      "sandbar/issue-12-t-12",
      "sandbar/issue-13-t-13",
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
