import { describe, expect, it } from "vitest";

import type { IssueCloneReclaim } from "./agent-sandbox.js";

import { NEEDS_REVIEW_LABEL } from "./chunks.js";
import { DEFAULT_LABELS, type LabelConfig } from "./config.js";
import { SandbarError } from "./errors.js";
import {
  BOT_COMMENT_PREFIX,
  CHUNK_LANDED_COMMENT_TEMPLATE,
  type FinalizeAdapter,
  type FinalizeInput,
  NEEDS_HUMAN_COMMENT_TEMPLATE,
  NEEDS_INFO_COMMENT_TEMPLATE,
  NEEDS_PARTITION_COMMENT_TEMPLATE,
  NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE,
  NO_PROTOTYPE_NEEDED_PHRASE,
  READY_FOR_AGENT_LABEL as READY_FOR_AGENT,
  REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE,
  SPEC_GAPS_COMMENT,
  finalizeAll,
  finalizationIntendsNotReady,
  finalizeOne as finalizeOneImpl,
  issueNumberOf,
} from "./finalize.js";
import type { IssueRef } from "./merger.js";
import type { PushResult } from "./push-result.js";

const LABELS: LabelConfig = DEFAULT_LABELS;
const { needsInfo: NEEDS_INFO, agentStuck: AGENT_STUCK } = DEFAULT_LABELS;

// Most tests exercise terminal-specific behavior and predate the cross-cutting
// spec-gap field. Keep their fixtures terse while the focused tests below pass
// explicit gap lists through the real entry point.
const finalizeOne = (
  input: Omit<FinalizeInput, "specGaps"> & Partial<Pick<FinalizeInput, "specGaps">>,
  adapter: FinalizeAdapter,
  labels: LabelConfig,
) =>
  finalizeOneImpl(
    { ...input, specGaps: input.specGaps ?? [] } as FinalizeInput,
    adapter,
    labels,
  );

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
  reclaims: { branch: string; keep?: string }[];
  comments: { n: number; body: string }[];
  labelEdits: { n: number; remove: readonly string[]; add: readonly string[] }[];
  stateChecks: number[];
  containmentChecks: string[];
};

type Script = {
  pushError?: string;
  pushResult?: PushResult;
  postCommentError?: string;
  deleteOk?: boolean;
  deleteError?: string;
  forceDeleteOk?: boolean;
  forceDeleteError?: string;
  labelEditOk?: boolean;
  labelEditError?: string;
  addLabelEditOk?: boolean;
  addLabelEditError?: string;
  issueState?: "OPEN" | "CLOSED";
  containedInOrigin?: boolean;
  aheadOfSeed?: boolean;
  reclaim?: IssueCloneReclaim;
};

function makeAdapter(
  script: Script = {},
): { adapter: FinalizeAdapter; calls: Calls } {
  const calls: Calls = {
    pushes: [],
    deletes: [],
    forceDeletes: [],
    reclaims: [],
    comments: [],
    labelEdits: [],
    stateChecks: [],
    containmentChecks: [],
  };
  const adapter: FinalizeAdapter = {
    async pushBranch(branch) {
      calls.pushes.push(branch);
      if (script.pushError !== undefined) throw new SandbarError(script.pushError);
      return script.pushResult ?? { kind: "ok" };
    },
    async localBranchRecovery(branch) {
      return {
        tipSha: "abc123",
        ref: `refs/heads/${branch}`,
        repoDir: "/host/.sandbar/repo.git",
      };
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
    async reclaimIssueClone(branch, keep) {
      calls.reclaims.push(keep === undefined ? { branch } : { branch, keep });
      return script.reclaim ?? (keep === undefined
        ? { kind: "removed" }
        : {
            kind: "preserved",
            reason: keep,
            worktreePath: `/host/.sandbar/worktrees/${branch.replaceAll("/", "-")}`,
          });
    },
    async branchIsContainedInOrigin(branch) {
      calls.containmentChecks.push(branch);
      // Default true: the common case is a branch still sitting at the origin
      // tip it was seeded from. Cases that model leftover commits set it false.
      return script.containedInOrigin ?? true;
    },
    async branchIsAheadOfSeed() {
      return script.aheadOfSeed ?? false;
    },
    async postComment(n, body) {
      calls.comments.push({ n, body });
      if (script.postCommentError !== undefined) {
        throw new SandbarError(script.postCommentError);
      }
    },
    async editLabels(n, remove, add) {
      calls.labelEdits.push({ n, remove, add });
      if (add.length > 0 && script.addLabelEditOk === false) {
        return {
          ok: false,
          error: script.addLabelEditError ?? "'needs-review' not found",
        };
      }
      if (script.labelEditOk === false) {
        return { ok: false, error: script.labelEditError ?? "'agent-stuck' not found" };
      }
      return { ok: true };
    },
    async issueState(n) {
      calls.stateChecks.push(n);
      return script.issueState ?? "OPEN";
    },
    async issueLabels() {
      return [];
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

describe("comment templates", () => {
  it("NEEDS-INFO body includes bot prefix, the branch, the questions verbatim, and the configured labels", () => {
    const body = NEEDS_INFO_COMMENT_TEMPLATE(
      "sandbar/issue-45-t-45",
      "Q1?\nQ2?",
      NEEDS_INFO,
      READY_FOR_AGENT,
      null,
      { kind: "removed" },
    );
    expect(body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(body).toContain("sandbar/issue-45-t-45"); // #70
    expect(body).toContain("Q1?");
    expect(body).toContain("Q2?");
    expect(body).toContain(NEEDS_INFO);
    expect(body).toContain(READY_FOR_AGENT);
    // The branch is a LOCATION here and nothing more. STRANDED_COMMITS_NOTE is
    // appended to this same body when the run went off-branch, and it says none
    // of the work is on the branch — so this template may not claim it is.
    // Asserted as the absence of the WORD, not of the sentence that once said
    // it: "push" is what a payload claim is built out of, and the note below
    // this one in the composed comment is the only part entitled to use it.
    expect(body.endsWith("re-apply `ready-for-agent`.")).toBe(true);
  });
  it("NEEDS-UI-PROTOTYPE body includes bot prefix, the impact prose, both unblock routes, and the configured labels", () => {
    const body = NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE(
      45,
      "New settings screen; tab order and empty state invented.",
      NEEDS_INFO,
      READY_FOR_AGENT,
      null,
      null,
      { kind: "removed" },
    );
    expect(body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(body).toContain("tab order and empty state invented");
    // Both ways out must be stated: attach a readable artifact, or say the
    // agent may decide for itself (#21 — the acknowledgement is what stops the
    // next run from escalating again).
    expect(body).toContain(NO_PROTOTYPE_NEEDED_PHRASE);
    expect(body).toContain("A screenshot alone does not work");
    expect(body).toContain("inline fenced markup");
    expect(body).toContain("ASCII wireframe");
    expect(body).toContain("precise prose specification");
    expect(body).toContain("push it to the source branch before re-labelling");
    expect(body).toContain(NEEDS_INFO);
    expect(body).toContain(READY_FOR_AGENT);
    // The suggested path carries the real issue number, not a literal <n>.
    expect(body).toContain("docs/prototypes/issue-45.html");
    expect(body).not.toContain("issue-<n>");
  });

  // The escalation is accepted after commits (see promise-parser), and then the
  // branch IS pushed — telling the human nothing was written would contradict
  // the branch they've just been handed.
  it("NEEDS-UI-PROTOTYPE action names whether a branch was pushed", () => {
    const early = NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE(
      45,
      "x",
      NEEDS_INFO,
      READY_FOR_AGENT,
      null,
      null,
      { kind: "removed" },
    );
    expect(early).toContain("no issue branch was pushed");

    const late = NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE(
      45,
      "x",
      NEEDS_INFO,
      READY_FOR_AGENT,
      "sandbar/issue-45-t-45",
      null,
      { kind: "removed" },
    );
    expect(late).toContain("sandbar/issue-45-t-45");
  });
  it("NEEDS-PARTITION names the cause, slot, size, chain, and pushed branch", () => {
    const body = NEEDS_PARTITION_COMMENT_TEMPLATE(
      "measured",
      "review-quality",
      700_000,
      600_000,
      "The branch is too broad.",
      NEEDS_INFO,
      READY_FOR_AGENT,
      "sandbar/issue-45-t-45",
    );
    expect(body).toContain("stopped for partitioning (measured");
    expect(body).toContain("`review-quality`");
    expect(body).toContain("700,000");
    expect(body).toContain("600,000");
    expect(body).toContain("## Blocked by");
    expect(body).toContain("sandbar/issue-45-t-45");
  });
  it("NEEDS-HUMAN body includes bot prefix, the branch, the failure trace, and the configured labels", () => {
    const body = NEEDS_HUMAN_COMMENT_TEMPLATE(
      "sandbar/issue-45-t-45",
      "tests",
      4,
      "E: boom\nstack…",
      "Reviewer report",
      AGENT_STUCK,
      READY_FOR_AGENT,
    );
    expect(body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(body).toContain("sandbar/issue-45-t-45"); // #70
    expect(body).toContain("E: boom");
    expect(body).toContain("stack…");
    expect(body).toContain(AGENT_STUCK);
    expect(body).toContain(READY_FOR_AGENT);
    expect(body).toContain("gate-1 was red for 4 consecutive rounds");
    expect(body).toContain("latest failing step: `tests`");
    expect(body).not.toContain("step `tests` was red for 4");
    expect(body.indexOf("Latest quality review")).toBeLessThan(
      body.indexOf("<details>"),
    );
    expect(body.endsWith("re-apply `ready-for-agent`.")).toBe(true);
  });
  it("REVIEW_BUDGET_EXHAUSTED body includes bot prefix, the branch, the latest reviewer prose verbatim, and the configured labels", () => {
    const body = REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE(
      "sandbar/issue-45-t-45",
      "quality",
      4,
      "## Bar violations\n- foo not extracted\n- naming is unclear",
      AGENT_STUCK,
      READY_FOR_AGENT,
    );
    expect(body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(body).toContain("sandbar/issue-45-t-45"); // #70
    expect(body).toContain("foo not extracted");
    expect(body).toContain("naming is unclear");
    expect(body).toContain(AGENT_STUCK);
    // The LAST positional argument, which is what a signature shift silently
    // drops off the end: without this the whole call could slide one slot and
    // every other assertion here would still pass.
    expect(body).toContain(READY_FOR_AGENT);
    expect(body).toContain(
      "quality review pass stopped after 4 consecutive failures",
    );
    expect(body).not.toContain("consecutive rejections");
    expect(body.indexOf("foo not extracted")).toBeLessThan(
      body.indexOf("Action:"),
    );
  });

  // A comment body is posted into the HOST repository, where `#64` is not this
  // repo's issue 64: GitHub autolinks it to whatever the host's issue or pull
  // request 64 happens to be, renders it as a link, and files a cross-reference
  // event and a notification on it. Citing the sandbar issue that built a
  // mechanism belongs in the module header, never in the prose. The only `#N`
  // any template here may carry is one it was HANDED — a host issue number.
  it("chunk-landed body cites no sandbar issue number, which would autolink in the host repo", () => {
    const body = CHUNK_LANDED_COMMENT_TEMPLATE("sandbar/chunk-42-alpha", null);
    expect(body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(body).toContain("sandbar/chunk-42-alpha");
    expect(body).toBe(
      "**Sandbar:** merged to `sandbar/chunk-42-alpha`; lands with chunk PR.",
    );
    expect(body).not.toMatch(/#\d/);
    expect(CHUNK_LANDED_COMMENT_TEMPLATE("sandbar/chunk-42-alpha", 17))
      .toContain("chunk PR #17");
  });
});

describe("finalizeOne", () => {
  it("requires queue-label readback for a refusal park from a normally queued terminal", () => {
    expect(finalizationIntendsNotReady({
      input: {
        kind: "hard-error",
        issue: issue(64),
        specGaps: [],
      },
      action: { kind: "parked-local" },
    })).toBe(true);
  });

  it("posts one ordered spec-gap comment before a merged terminal's effects", async () => {
    const { adapter, calls } = makeAdapter({ aheadOfSeed: true });
    const gaps = [
      { round: 2, text: "Which source? Use the request record." },
      { round: 5, text: "What fallback? Emit no measurement." },
    ];
    await finalizeOne(
      { kind: "merged", issue: issue(45), specGaps: gaps },
      adapter,
      LABELS,
    );
    expect(calls.comments).toEqual([{ n: 45, body: SPEC_GAPS_COMMENT(gaps) }]);
    expect(calls.comments[0]!.body).toMatch(
      /Review round 2[\s\S]*Use the request record[\s\S]*Review round 5[\s\S]*Emit no measurement/,
    );
  });

  it("posts no spec-gap comment when the list is empty", async () => {
    const { adapter, calls } = makeAdapter();
    await finalizeOne(
      { kind: "merged", issue: issue(45), specGaps: [] },
      adapter,
      LABELS,
    );
    expect(calls.comments).toEqual([]);
  });

  it("quota reclaims then pushes and comments without editing labels", async () => {
    const { adapter, calls } = makeAdapter();
    const order: string[] = [];
    const ordered: FinalizeAdapter = {
      ...adapter,
      async reclaimIssueClone(branch, keep) {
        order.push("reclaim");
        return adapter.reclaimIssueClone(branch, keep);
      },
      async pushBranch(branch) {
        order.push("push");
        return adapter.pushBranch(branch);
      },
      async postComment(n, body) {
        order.push("comment");
        return adapter.postComment(n, body);
      },
    };
    const i = issue(45);
    const action = await finalizeOne({
      kind: "quota", issue: i, provider: "codex", window: "seven_day", resetsAt: 42,
    }, ordered, LABELS);

    expect(action).toEqual({ kind: "pushed" });
    expect(order).toEqual(["reclaim", "push", "comment"]);
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.comments).toHaveLength(1);
    expect(calls.comments[0]!.body).toContain("`codex`");
    expect(calls.comments[0]!.body).toContain("`seven_day`");
    expect(calls.comments[0]!.body).toContain("1970-01-01T00:00:42.000Z");
    expect(calls.comments[0]!.body).toContain("remains `ready-for-agent`");
    expect(calls.labelEdits).toEqual([]);
  });

  it.each(["push", "comment"] as const)(
    "quota propagates a required %s failure",
    async (operation) => {
      const { adapter } = makeAdapter(operation === "push"
        ? { pushError: "push failed" }
        : { postCommentError: "comment failed" });
      await expect(finalizeOne({
        kind: "quota", issue: issue(45), provider: "claude", window: "five_hour",
      }, adapter, LABELS)).rejects.toThrow(`${operation} failed`);
    },
  );
  it("credential reclaims, pushes, and tells the operator which configured value to refresh", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(134);
    const action = await finalizeOne({
      kind: "credential",
      issue: i,
      provider: "codex",
      detail: "Your access token could not be refreshed.",
    }, adapter, LABELS);

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.comments[0]?.body).toContain("refused its credential");
    expect(calls.comments[0]?.body).toContain("CODEX_AUTH_JSON");
    expect(calls.comments[0]?.body).toContain("Log in again on the host");
    expect(calls.comments[0]?.body).toContain("remains `ready-for-agent`");
    expect(calls.labelEdits).toEqual([]);
  });
  it("merged: removes worktree before deleting branch, drops ready-for-agent on the closed issue, no push, no comment", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne({ kind: "merged", issue: i }, adapter, LABELS);

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
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

  // #60 — the third success shape. Everything here is deliberately NOT what
  // `merged` does: the issue is not closed, it is not left carrying the queue
  // label, and it gets a comment.
  it("chunk-landed: swaps ready-for-agent for needs-review, comments the branch, deletes the local branch", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      {
        kind: "chunk-landed",
        issue: i,
        chunkBranch: "sandbar/chunk-45-x",
        pullRequestNumber: null,
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [] },
      { n: 45, remove: [], add: [NEEDS_REVIEW_LABEL] },
    ]);
    expect(calls.deletes).toEqual([i.branch]);
    // The branch is on origin under the chunk's name, so it is never pushed
    // under its own — a chunk member's issue branch is not a review artifact.
    expect(calls.pushes).toEqual([]);
    expect(calls.comments).toHaveLength(1);
    expect(calls.comments[0]!.body).toContain("sandbar/chunk-45-x");
    expect(calls.comments[0]!.body).toContain("lands with chunk PR");
  });

  it("chunk-landed with -d refusal: escalates to -D, on the merger's certainty", async () => {
    // The member's commits differ from the chunk branch's tree (the resolve
    // loop composed it), so `-d` refuses — and the work is on origin.
    const { adapter, calls } = makeAdapter({
      deleteOk: false,
      deleteError: "branch X not fully merged",
    });
    const action = await finalizeOne(
      {
        kind: "chunk-landed",
        issue: issue(45),
        chunkBranch: "sandbar/chunk-45-x",
        pullRequestNumber: null,
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.forceDeletes).toEqual(["sandbar/issue-45-t-45"]);
  });

  it("chunk-landed with a failing queue-label flip halts before comment and deletion", async () => {
    const { adapter, calls } = makeAdapter({
      labelEditOk: false,
      labelEditError: "label not found",
    });
    await expect(
      finalizeOne(
      {
        kind: "chunk-landed",
        issue: issue(45),
        chunkBranch: "sandbar/chunk-45-x",
        pullRequestNumber: null,
      },
        adapter,
        LABELS,
      ),
    ).rejects.toThrow(/Could not move chunk member #45 into review/);
    expect(calls.deletes).toEqual([]);
    expect(calls.comments).toEqual([]);
  });

  it("chunk-landed with a missing display label still comments and cleans up", async () => {
    const { adapter, calls } = makeAdapter({ addLabelEditOk: false });
    const i = issue(45);

    await expect(finalizeOne(
      {
        kind: "chunk-landed",
        issue: i,
        chunkBranch: "sandbar/chunk-45-x",
        pullRequestNumber: null,
      },
      adapter,
      LABELS,
    )).resolves.toEqual({ kind: "deleted-local" });
    expect(calls.comments[0]?.body).toContain("sandbar/chunk-45-x");
    expect(calls.deletes).toEqual([i.branch]);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [] },
      { n: 45, remove: [], add: [NEEDS_REVIEW_LABEL] },
    ]);
  });

  it("chunk-landed on an issue a human closed mid-run: still records and cleans up", async () => {
    // Not a handoff, so not guarded on issue state (#16): the comment is a
    // statement of fact that stays true, containment already records the
    // membership, and the optional display-label edit remains harmless.
    const { adapter, calls } = makeAdapter({ issueState: "CLOSED" });
    const action = await finalizeOne(
      {
        kind: "chunk-landed",
        issue: issue(45),
        chunkBranch: "sandbar/chunk-45-x",
        pullRequestNumber: null,
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.stateChecks).toEqual([]);
    expect(calls.labelEdits).toHaveLength(2);
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
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
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
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
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
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
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
      { kind: "needs-info", issue: i, questions: "Should X be Y?", strandedHead: null },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]!.n).toBe(45);
    expect(calls.comments[0]!.body).toContain("Should X be Y?");
    // #70 — the branch it was pushed to, named where the human is standing.
    expect(calls.comments[0]!.body).toContain(i.branch);
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
        strandedHead: null,
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.pushes).toEqual([]);
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
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
      { kind: "needs-ui-prototype", issue: i, uiImpact: "x", strandedHead: null },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.containmentChecks).toEqual([i.branch]);
    expect(calls.forceDeletes).toEqual([i.branch]);
  });

  // The regression this guard exists for: a HARD-ERROR retry (or a branch left
  // by an interrupted earlier run) can carry unpushed commits that the current
  // cycle did not create. Forcing would destroy work that was never published.
  it("needs-ui-prototype without commits: keeps the branch when it carries commits not on origin", async () => {
    const { adapter, calls } = makeAdapter({
      deleteOk: false,
      deleteError: "not fully merged",
      containedInOrigin: false,
    });
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "needs-ui-prototype", issue: i, uiImpact: "x", strandedHead: null },
      adapter,
      LABELS,
    );

    expect(action.kind).toBe("kept-branch");
    if (action.kind === "kept-branch") {
      expect(action.reason).toContain("not on origin");
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
        strandedHead: null,
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
        { kind: "needs-ui-prototype", issue: i, uiImpact: "x", strandedHead: null },
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
      { kind: "needs-ui-prototype", issue: i, uiImpact: "x", strandedHead: null },
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
    const { adapter, calls } = makeAdapter({ aheadOfSeed: true });
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "needs-ui-prototype", issue: i, uiImpact: "x", strandedHead: null },
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

  it("needs-partition publishes an ahead branch and parks under needs-info", async () => {
    const { adapter, calls } = makeAdapter({ aheadOfSeed: true });
    const i = issue(45);
    const action = await finalizeOne({
      kind: "needs-partition",
      issue: i,
      cause: "provider-refused",
      slot: "implementer",
      size: 1_064_340,
      budget: 600_000,
      detail: "input_too_large",
    }, adapter, LABELS);

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.comments[0]?.body).toContain("input_too_large");
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [NEEDS_INFO] },
    ]);
  });

  it("needs-partition does not publish a seed-only branch", async () => {
    const { adapter, calls } = makeAdapter({ aheadOfSeed: false });
    const action = await finalizeOne({
      kind: "needs-partition",
      issue: issue(45),
      cause: "classifier",
      slot: "partition-check",
      size: 12_000,
      budget: 600_000,
      detail: "two deliverables",
    }, adapter, LABELS);

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.pushes).toEqual([]);
  });

  it("needs-ui-prototype on an already-CLOSED issue: no comment, no label flip (#16)", async () => {
    const { adapter, calls } = makeAdapter({ issueState: "CLOSED" });
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "needs-ui-prototype", issue: i, uiImpact: "x", strandedHead: null },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "skipped-closed" });
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
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
        latestReviewerProse: "quality review from the red round",
          budgetExhausted: { budget: "gate", roundsUsed: 4, failedStep: "tests" },
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]!.body).toContain("AssertionError: red");
    expect(calls.comments[0]!.body).toContain("latest failing step: `tests`");
    expect(calls.comments[0]!.body).toContain("4 consecutive rounds");
    expect(calls.comments[0]!.body).toContain("quality review from the red round");
    // #70 — "push a fix on this branch" used to never say which.
    expect(calls.comments[0]!.body).toContain(i.branch);
    expect(calls.comments[0]!.body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
  });

  it("needs-human no-signal exhaustion points at transcripts without guessing why", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    await finalizeOne(
      {
        kind: "needs-human",
        issue: i,
        cause: "no-signal-exhausted",
        failureTrace: "The final implementer signal failed validation: guard correction",
        latestReviewerProse: null,
        budgetExhausted: { budget: "quality", roundsUsed: 4 },
      },
      adapter,
      LABELS,
    );

    expect(calls.comments[0]!.body).toContain("no actionable signal");
    expect(calls.comments[0]!.body).toContain("Attempt summary");
    expect(calls.comments[0]!.body).toContain("guard correction");
    expect(calls.comments[0]!.body).not.toContain("never emitted");
    expect(calls.comments[0]!.body).not.toContain("no gate ran");
    expect(calls.comments[0]!.body).not.toContain("Last failure trace");
    expect(calls.comments[0]!.body).toContain("quality pass stopped after 4 consecutive failures");
  });

  it("quality review exhaustion names its budget, count, and latest prose", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      {
        kind: "review-budget-exhausted",
        issue: i,
        budget: "quality",
        roundsUsed: 4,
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
    expect(body).toContain(
      "quality review pass stopped after 4 consecutive failures",
    );
    expect(body).toContain(i.branch); // #70
    expect(body).not.toContain("standards-violation report");
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
  });

  it("needs-human reviewer-harness-failed, nothing ever reviewed: says so in the strongest form (#41)", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      {
        kind: "needs-human",
        issue: i,
        cause: "reviewer-harness-failed",
        failureTrace:
          "invocation 1/2: the run failed and emitted no output at all: Agent idle for 600 seconds — no output received.",
        // No round ever produced a report, so the global claim is the true one.
        latestReviewerProse: null,
        budgetExhausted: null,
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    // The branch is green and pushed: the reader may well be able to merge it.
    expect(calls.pushes).toEqual([i.branch]);
    const body = calls.comments[0]!.body;
    expect(body).toContain("Agent idle for 600 seconds");
    expect(body).toContain("no reviewer verdict was produced in the failing round");
    expect(body).toContain("Reviewer-harness trace");
    // #70 — and this one is telling the reader to review it themselves, so it
    // had better say what to check out.
    expect(body).toContain(i.branch);
    // The claim a review-rejection comment would make, and it is false
    // here: that a standards complaint is what the human has to resolve.
    expect(body).not.toContain("the code reviewer's `CHANGES-REQUESTED` is the blocker");
    // Nor is it a gate failure — the gate is what went green.
    expect(body).not.toContain("without a green gate");
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
  });

  it("needs-human reviewer-harness-failed with an earlier round's report: renders it, scoped to that round (#41)", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    // The reachable shape: round 1 reviewed and asked for changes, and the
    // reviewer that ended the issue produced nothing. Every global claim ("no
    // verdict was ever reached", "the reviewer did not ask for changes") is
    // false here, and the earlier report is the only review this branch ever
    // got — dropped, it survives nowhere a human will look, precisely as the
    // comment tells them to review the branch themselves.
    const earlier = "## Extract the duplicated lifecycle dispatch";
    const action = await finalizeOne(
      {
        kind: "needs-human",
        issue: i,
        cause: "reviewer-harness-failed",
        failureTrace:
          "invocation 1/2: the run failed and emitted no output at all: Agent idle for 600 seconds — no output received.",
        latestReviewerProse: earlier,
        budgetExhausted: null,
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    const body = calls.comments[0]!.body;
    expect(body).toContain("Agent idle for 600 seconds");
    expect(body).toContain(earlier);
    expect(body).toContain("Earlier-round reviewer report");
    expect(body).toContain("not a verdict on the current commits");
    // Scoped, not global — the two sentences that would be untrue.
    expect(body).toContain("stopped after 2 reviewer-harness failures");
    expect(body).not.toContain("No reviewer has said anything about this branch at all");
    // And still not presented as the blocker: this is not a CHANGES-REQUESTED
    // terminal, and the harness trace is not the reviewer speaking.
    expect(body).not.toContain("the code reviewer's `CHANGES-REQUESTED` is the blocker");
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
  });

  it("needs-human uncommittable-worktree: names the branch whose worktree stayed dirty (#70)", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      {
        kind: "needs-human",
        issue: i,
        cause: "uncommittable-worktree",
        failureTrace: "?? node_modules/.cache/foo",
        latestReviewerProse: null,
        budgetExhausted: null,
        strandedHead: null,
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    const body = calls.comments[0]!.body;
    expect(body).toContain("?? node_modules/.cache/foo");
    expect(body).toContain(i.branch);
    // The gate never ran, so the reader must not be sent looking for a red one.
    expect(body).not.toContain("without a green gate");
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
        budgetExhausted: null,
        strandedHead: {
          branch: `sandbar/issue-45-t-45`,
          headRef: null,
          headSha: "deadbeef1234",
          branchSha: "base00",
          branchIsAncestor: false,
        },
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    const body = calls.comments[0]!.body;
    expect(body).toContain(i.branch);
    // The comment and the cache pin it names are the only places this sha
    // survives: reclaiming the clone takes the per-worktree HEAD reflog with it.
    expect(body).toContain("deadbeef1234");
    expect(body).toContain("git branch <rescue-name> deadbeef1234");
    // Must NOT claim no gate ran / the branch never moved: on the path that
    // actually reaches this terminal, attempt 1 committed on the branch and a
    // gate went green on it.
    expect(body).not.toContain("without a green gate");
    expect(body).not.toContain("No gate ran");
    expect(body).not.toContain("never moved");
    expect(body).toContain("refs/sandbar/stranded/deadbeef1234");
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
  });

  // #27, #98. The structural branch check cannot see an off-branch UI
  // escalation's detached commit. Its private clone remains the only store for
  // that commit, and the cache branch is the sweep's liveness
  // record for that clone; both must survive the handoff.
  it("needs-ui-prototype: keeps the cache branch when the clone could not be reclaimed", async () => {
    const { adapter, calls } = makeAdapter({
      reclaim: {
        kind: "preserved",
        reason: "could not publish its git state into the cache: cannot lock ref",
        worktreePath: "/host/.sandbar/worktrees/sandbar-issue-45-t-45",
      },
    });
    const i = issue(45);
    const action = await finalizeOne(
      {
        kind: "needs-ui-prototype",
        issue: i,
        uiImpact: "a new settings screen",
        strandedHead: {
          branch: i.branch,
          headRef: null,
          headSha: "abc9999",
          branchSha: "base00",
          branchIsAncestor: false,
        },
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({
      kind: "kept-branch",
      reason: expect.stringContaining("cannot lock ref"),
    });
    expect(calls.pushes).toEqual([]);
    expect(calls.deletes).toEqual([]);
    expect(calls.forceDeletes).toEqual([]);
    const body = calls.comments[0]!.body;
    expect(body).toContain("a new settings screen");
    expect(body).toContain("abc9999");
    expect(body).toContain(
      "git -C '/host/.sandbar/worktrees/sandbar-issue-45-t-45' branch <rescue-name> abc9999",
    );
    expect(body).not.toContain("refs/sandbar/stranded/abc9999");
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
  });

  it("needs-ui-prototype: recovers a stranded scratch branch from its preserved clone", async () => {
    const worktreePath = "/host/.sandbar/worktrees/sandbar-issue-45-t-45";
    const { adapter, calls } = makeAdapter({
      reclaim: {
        kind: "preserved",
        reason: "could not publish its git state into the cache: cannot lock ref",
        worktreePath,
      },
    });
    const i = issue(45);
    const action = await finalizeOne(
      {
        kind: "needs-ui-prototype",
        issue: i,
        uiImpact: "a new settings screen",
        strandedHead: {
          branch: i.branch,
          headRef: "scratch/settings-screen",
          headSha: "abc9999",
          branchSha: "base00",
          branchIsAncestor: false,
        },
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({
      kind: "kept-branch",
      reason: expect.stringContaining("cannot lock ref"),
    });
    const body = calls.comments[0]!.body;
    expect(body).toContain(`preserved clone \`${worktreePath}\``);
    expect(body).toContain(
      "from that clone, cherry-pick or merge it into `sandbar/issue-45-t-45`",
    );
    expect(body).not.toContain("refs/sandbar/stranded/abc9999");
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
          branchIsAncestor: false,
        },
      },
      adapter,
      LABELS,
    );
    const body = calls.comments[0]!.body;
    expect(body).toContain("which currency?");
    expect(body).toContain("abc9999");
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
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
          branchIsAncestor: false,
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
        budget: "correctness",
        roundsUsed: 4,
        latestReviewerProse: "## Bar violations\n- too much indirection",
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
    expect(calls.comments.length).toBe(1);
    expect(calls.comments[0]!.n).toBe(45);
    expect(calls.comments[0]!.body).toContain("too much indirection");
    expect(calls.comments[0]!.body).toContain(
      "correctness review pass stopped after 4 consecutive rejections",
    );
    expect(calls.comments[0]!.body).toContain(
      "correct the governing instructions",
    );
    expect(calls.comments[0]!.body).not.toContain("rewrite the standards");
    // #70 — "Push a fix on this branch" is only actionable with a name on it.
    expect(calls.comments[0]!.body).toContain(i.branch);
    expect(calls.comments[0]!.body.startsWith(BOT_COMMENT_PREFIX)).toBe(true);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
  });

  it("read-only-agent-wrote: leaves the preserved clone in place and publishes the handoff", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      {
        kind: "read-only-agent-wrote",
        issue: i,
        actor: "reviewer",
        latestReviewerProse: "Reviewer changed git state. Branch tip before: a; after: b.",
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.reclaims).toEqual([
      { branch: i.branch, keep: expect.stringContaining("human inspection") },
    ]);
    expect(calls.comments[0]!.body).toContain("inspect the preserved clone");
    expect(calls.comments[0]!.body).toContain("read-only reviewer");
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
  });

  it("read-only-agent-wrote names the UI checker in its handoff", async () => {
    const { adapter, calls } = makeAdapter();
    await finalizeOne(
      {
        kind: "read-only-agent-wrote",
        issue: issue(126),
        actor: "UI checker",
        latestReviewerProse: "UI checker changed git state.",
      },
      adapter,
      LABELS,
    );
    expect(calls.comments[0]!.body).toContain("read-only UI checker");
  });

  it("read-only-agent-wrote fails before publishing when its preserved clone is missing", async () => {
    const { adapter, calls } = makeAdapter({ reclaim: { kind: "absent" } });

    await expect(finalizeOne(
      {
        kind: "read-only-agent-wrote",
        issue: issue(45),
        actor: "reviewer",
        latestReviewerProse: "Reviewer changed git state.",
      },
      adapter,
      LABELS,
    )).rejects.toThrow("missing its preserved clone");

    expect(calls.pushes).toEqual([]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
  });

  it("read-only-agent-wrote: parks and comments when origin refuses the branch", async () => {
    const refusal =
      "! [remote rejected] topic -> topic (push protection declined)";
    const { adapter, calls } = makeAdapter({
      pushResult: { kind: "refused", reasons: [refusal] },
      reclaim: {
        kind: "preserved",
        reason: "kept for human inspection",
        worktreePath: "/host/.sandbar/worktrees/sandbar-issue-45-t-45",
      },
    });
    const i = issue(45);

    const action = await finalizeOne(
      {
        kind: "read-only-agent-wrote",
        issue: i,
        actor: "reviewer",
        latestReviewerProse: "Reviewer rewound the branch.",
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "parked-local" });
    expect(calls.reclaims).toEqual([
      { branch: i.branch, keep: expect.stringContaining("human inspection") },
    ]);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
    expect(calls.comments[0]!.body).toContain(refusal);
    expect(calls.comments[0]!.body).toContain("abc123");
    expect(calls.comments[0]!.body).toContain("refs/heads/");
    expect(calls.comments[0]!.body).toContain("/host/.sandbar/repo.git");
    expect(calls.comments[0]!.body).toContain(
      "stopped because the read-only reviewer changed the repository",
    );
    expect(calls.comments[0]!.body).toContain(
      "/host/.sandbar/worktrees/sandbar-issue-45-t-45",
    );
    expect(calls.comments[0]!.body).toContain("Reviewer rewound the branch");
    expect(calls.comments[0]!.body.endsWith(
      "resolve the handoff above, then drop `agent-stuck` and re-apply `ready-for-agent`.",
    )).toBe(true);
  });

  it.each([
    {
      result: { kind: "race" } as const,
      failure: "non-fast-forward",
    },
    {
      result: { kind: "fatal", reason: "ssh: handshake failed" } as const,
      failure: "ssh: handshake failed",
    },
  ])("read-only-agent-wrote: parks and comments after a $result.kind push failure", async ({
    result,
    failure,
  }) => {
    const { adapter, calls } = makeAdapter({ pushResult: result });
    const i = issue(45);

    const action = await finalizeOne(
      {
        kind: "read-only-agent-wrote",
        issue: i,
        actor: "reviewer",
        latestReviewerProse: "Reviewer rewound the branch.",
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "parked-local" });
    expect(calls.reclaims).toEqual([
      { branch: i.branch, keep: expect.stringContaining("human inspection") },
    ]);
    expect(calls.comments[0]!.body).toContain(failure);
    expect(calls.comments[0]!.body).toContain("Inspect the preserved clone");
    expect(calls.comments[0]!.body).toContain("Reviewer rewound the branch");
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [READY_FOR_AGENT], add: [AGENT_STUCK] },
    ]);
  });

  it("read-only-agent-wrote: does not park before the handoff comment succeeds", async () => {
    const { adapter, calls } = makeAdapter({ postCommentError: "comment failed" });

    await expect(
      finalizeOne(
        {
          kind: "read-only-agent-wrote",
          issue: issue(45),
          actor: "reviewer",
          latestReviewerProse: "Reviewer changed git state.",
        },
        adapter,
        LABELS,
      ),
    ).rejects.toThrow("comment failed");

    expect(calls.comments).toHaveLength(1);
    expect(calls.labelEdits).toEqual([]);
  });

  it("needs-info turns a server refusal into an actionable local park", async () => {
    const refusal =
      "! [remote rejected] topic -> topic (secret scanning push protection)";
    const { adapter, calls } = makeAdapter({
      pushResult: { kind: "refused", reasons: [refusal] },
    });
    const i = issue(63);

    const action = await finalizeOne(
      {
        kind: "needs-info",
        issue: i,
        questions: "Which deployment account should this use?",
        strandedHead: null,
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "parked-local" });
    expect(calls.comments).toHaveLength(1);
    expect(calls.comments[0]!.body).toContain(refusal);
    expect(calls.comments[0]!.body).toContain("Which deployment account");
    expect(calls.comments[0]!.body).toContain("abc123");
    expect(calls.comments[0]!.body).toContain(i.branch);
    expect(calls.comments[0]!.body).toContain("<details><summary>Git refusal</summary>");
    expect(calls.comments[0]!.body).toContain("git -C '/host/.sandbar/repo.git' push");
    expect(calls.comments[0]!.body.endsWith(
      "resolve the handoff above, then drop `agent-stuck` and re-apply `ready-for-agent`.",
    )).toBe(true);
    expect(calls.labelEdits).toEqual([{
      n: 63,
      remove: [READY_FOR_AGENT],
      add: [AGENT_STUCK],
    }]);
  });

  it("hard-error with unpublished work parks when origin refuses that branch", async () => {
    const { adapter, calls } = makeAdapter({
      aheadOfSeed: true,
      pushResult: {
        kind: "refused",
        reasons: ["! [remote rejected] topic -> topic (hook declined)"],
      },
    });

    const action = await finalizeOne(
      { kind: "hard-error", issue: issue(64) },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "parked-local" });
    expect(calls.comments).toHaveLength(1);
    expect(calls.comments[0]!.body).not.toContain("resolve the handoff above");
    expect(calls.labelEdits).toEqual([{
      n: 64,
      remove: [READY_FOR_AGENT],
      add: [AGENT_STUCK],
    }]);
  });

  it.each([
    {
      name: "quota",
      input: {
        kind: "quota",
        issue: issue(70),
        provider: "codex",
        window: "seven_day",
        resetsAt: 42,
      } as const,
      context: "subscription quota window",
      remove: [READY_FOR_AGENT],
    },
    {
      name: "credential",
      input: {
        kind: "credential",
        issue: issue(71),
        provider: "codex",
        detail: "token revoked",
      } as const,
      context: "CODEX_AUTH_JSON",
      remove: [READY_FOR_AGENT],
    },
    {
      name: "UI prototype",
      input: {
        kind: "needs-ui-prototype",
        issue: issue(72),
        uiImpact: "invented navigation",
        strandedHead: null,
      } as const,
      context: "invented navigation",
      remove: [READY_FOR_AGENT],
    },
    {
      name: "partition",
      input: {
        kind: "needs-partition",
        issue: issue(73),
        cause: "measured",
        slot: "review-quality",
        size: 700_000,
        budget: 600_000,
        detail: "split the migrations",
      } as const,
      context: "split the migrations",
      remove: [READY_FOR_AGENT],
    },
    {
      name: "gate-red",
      input: {
        kind: "needs-human",
        issue: issue(74),
        cause: "gate-red",
        failureTrace: "gate exploded",
        latestReviewerProse: null,
        budgetExhausted: { budget: "gate", roundsUsed: 4, failedStep: "tests" },
        strandedHead: null,
      } as const,
      context: "gate exploded",
      remove: [READY_FOR_AGENT],
    },
    {
      name: "uncommittable worktree",
      input: {
        kind: "needs-human",
        issue: issue(741),
        cause: "uncommittable-worktree",
        failureTrace: "?? node_modules/.cache/foo",
        latestReviewerProse: null,
        budgetExhausted: null,
        strandedHead: null,
      } as const,
      context: "stopped because the worktree stayed uncommitted",
      remove: [READY_FOR_AGENT],
    },
    {
      name: "no-signal exhaustion",
      input: {
        kind: "needs-human",
        issue: issue(742),
        cause: "no-signal-exhausted",
        failureTrace: "attempt produced no commit or promise",
        latestReviewerProse: null,
        budgetExhausted: { budget: "quality", roundsUsed: 4 },
        strandedHead: null,
      } as const,
      context: "quality pass stopped after 4 consecutive failures",
      remove: [READY_FOR_AGENT],
    },
    {
      name: "reviewer harness failure",
      input: {
        kind: "needs-human",
        issue: issue(743),
        cause: "reviewer-harness-failed",
        failureTrace: "reviewer emitted no verdict",
        latestReviewerProse: "Earlier report",
        budgetExhausted: null,
        strandedHead: null,
      } as const,
      context: "stopped after 2 reviewer-harness failures",
      remove: [READY_FOR_AGENT],
    },
    {
      name: "off-branch head",
      input: {
        kind: "needs-human",
        issue: issue(744),
        cause: "off-branch-head",
        failureTrace: "HEAD stayed detached",
        latestReviewerProse: null,
        budgetExhausted: null,
        strandedHead: {
          branch: "sandbar/issue-744-t-744",
          headRef: null,
          headSha: "deadbeef744",
          branchSha: "base744",
          branchIsAncestor: false,
        },
      } as const,
      context: "implementer remained off `sandbar/issue-744-t-744`",
      remove: [READY_FOR_AGENT],
    },
    {
      name: "review budget",
      input: {
        kind: "review-budget-exhausted",
        issue: issue(75),
        budget: "correctness",
        roundsUsed: 4,
        latestReviewerProse: "still violates the contract",
      } as const,
      context: "still violates the contract",
      remove: [READY_FOR_AGENT],
    },
    {
      name: "landing conflict",
      input: { kind: "merge-conflict", issue: issue(76) } as const,
      context: "origin refused to publish",
      remove: [],
    },
    {
      name: "landing gate",
      input: { kind: "merge-gate-red", issue: issue(77) } as const,
      context: "origin refused to publish",
      remove: [],
    },
    {
      name: "landing verification",
      input: { kind: "forge-unverified", issue: issue(78) } as const,
      context: "origin refused to publish",
      remove: [],
    },
  ])("parks a refused $name publication with its terminal context", async ({
    input,
    context,
    remove,
  }) => {
    const refusal =
      `! [remote rejected] ${input.issue.branch} -> ${input.issue.branch} (policy declined)`;
    const { adapter, calls } = makeAdapter({
      aheadOfSeed: true,
      pushResult: { kind: "refused", reasons: [refusal] },
    });

    const action = await finalizeOne(input, adapter, LABELS);

    expect(action).toEqual({ kind: "parked-local" });
    expect(calls.comments).toHaveLength(1);
    expect(calls.comments[0]).toMatchObject({ n: Number(input.issue.id) });
    expect(calls.comments[0]!.body).toContain(refusal);
    expect(calls.comments[0]!.body).toContain(context);
    expect(calls.labelEdits).toEqual([{
      n: Number(input.issue.id),
      remove,
      add: [AGENT_STUCK],
    }]);
    expect(calls.deletes).toEqual([]);
    expect(calls.forceDeletes).toEqual([]);
  });

  it("keeps stranded-commit recovery beside a refused UI handoff", async () => {
    const i = issue(79);
    const { adapter, calls } = makeAdapter({
      aheadOfSeed: true,
      pushResult: {
        kind: "refused",
        reasons: ["! [remote rejected] topic -> topic (policy declined)"],
      },
    });

    await finalizeOne({
      kind: "needs-ui-prototype",
      issue: i,
      uiImpact: "new settings hierarchy",
      strandedHead: {
        branch: i.branch,
        headRef: null,
        headSha: "stranded999",
        branchSha: "base000",
        branchIsAncestor: false,
      },
    }, adapter, LABELS);

    expect(calls.comments).toHaveLength(1);
    expect(calls.comments[0]!.body).toContain("new settings hierarchy");
    expect(calls.comments[0]!.body).toContain("stranded999");
    expect(calls.comments[0]!.body).toContain("git branch <rescue-name> stranded999");
  });

  it("does not label a refused publishing handoff when its comment fails", async () => {
    const { adapter, calls } = makeAdapter({
      pushResult: {
        kind: "refused",
        reasons: ["! [remote rejected] topic -> topic (policy declined)"],
      },
      postCommentError: "comment failed",
    });

    await expect(finalizeOne({
      kind: "needs-info",
      issue: issue(80),
      questions: "which account?",
      strandedHead: null,
    }, adapter, LABELS)).rejects.toThrow("comment failed");
    expect(calls.comments).toHaveLength(1);
    expect(calls.labelEdits).toEqual([]);
  });

  it("fails loud when refused publishing cannot apply its handoff label", async () => {
    const { adapter, calls } = makeAdapter({
      pushResult: {
        kind: "refused",
        reasons: ["! [remote rejected] topic -> topic (policy declined)"],
      },
      labelEditOk: false,
    });

    await expect(finalizeOne({
      kind: "needs-info",
      issue: issue(81),
      questions: "which account?",
      strandedHead: null,
    }, adapter, LABELS)).rejects.toBeInstanceOf(SandbarError);
    expect(calls.comments).toHaveLength(1);
    expect(calls.labelEdits).toHaveLength(1);
  });

  it.each([
    {
      name: "quota",
      input: {
        kind: "quota",
        issue: issue(82),
        provider: "codex",
        window: "seven_day",
      } as const,
    },
    {
      name: "credential",
      input: {
        kind: "credential",
        issue: issue(83),
        provider: "codex",
        detail: "token revoked",
      } as const,
    },
    {
      name: "hard error",
      input: { kind: "hard-error", issue: issue(84) } as const,
    },
  ])("skips refused $name tracker writes when the issue has closed", async ({ input }) => {
    const { adapter, calls } = makeAdapter({
      aheadOfSeed: true,
      issueState: "CLOSED",
      pushResult: {
        kind: "refused",
        reasons: ["! [remote rejected] topic -> topic (policy declined)"],
      },
    });

    await expect(finalizeOne(input, adapter, LABELS))
      .resolves.toEqual({ kind: "skipped-closed" });
    expect(calls.reclaims).toEqual([{ branch: input.issue.branch }]);
    expect(calls.pushes).toEqual([input.issue.branch]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
    expect(calls.deletes).toEqual([]);
    expect(calls.forceDeletes).toEqual([]);
  });

  it.each([
    { result: { kind: "race" } as const, message: "remote branch moved" },
    {
      result: { kind: "fatal", reason: "ssh: handshake failed" } as const,
      message: "handshake failed",
    },
  ])("keeps $result.kind push failures loud", async ({ result, message }) => {
    const { adapter, calls } = makeAdapter({ pushResult: result });

    await expect(finalizeOne(
      {
        kind: "needs-info",
        issue: issue(65),
        questions: "q",
        strandedHead: null,
      },
      adapter,
      LABELS,
    )).rejects.toThrow(message);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
  });

  it("read-only-agent-wrote on a CLOSED issue skips tracker writes and preserves the clone", async () => {
    const { adapter, calls } = makeAdapter({ issueState: "CLOSED" });
    const i = issue(45);
    const action = await finalizeOne(
      {
        kind: "read-only-agent-wrote",
        issue: i,
        actor: "reviewer",
        latestReviewerProse: "Reviewer deleted the issue ref.",
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "skipped-closed" });
    expect(calls.reclaims).toEqual([
      { branch: i.branch, keep: expect.stringContaining("human inspection") },
    ]);
    expect(calls.pushes).toEqual([]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
  });

  it("hard-error with commits: removes worktree, pushes only, no label flip, no comment", async () => {
    const { adapter, calls } = makeAdapter({ aheadOfSeed: true });
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "hard-error", issue: i },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "pushed" });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.deletes).toEqual([]);
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
  });

  it("hard-error without commits: removes worktree, deletes branch, no push, no comment", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "hard-error", issue: i },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "deleted-local" });
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
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
      {
        kind: "hard-error",
        issue: issue(45),
      },
      adapter,
      LABELS,
    );

    expect(action.kind).toBe("delete-failed");
  });

  // #98: the clone is the only repository holding an attempt's commits until
  // the publish into the cache succeeds. A reclaim that could not publish keeps
  // the clone, and the arm must then keep the cache branch too — deleting it
  // would hand the clone to the next stale-clone sweep.
  it("hard-error without commits: keeps the cache branch when the clone could not be reclaimed", async () => {
    const { adapter, calls } = makeAdapter({
      reclaim: {
        kind: "preserved",
        reason: "could not publish its git state into the cache: cannot lock ref",
        worktreePath: "/host/.sandbar/worktrees/sandbar-issue-45-t-45",
      },
    });
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "hard-error", issue: i },
      adapter,
      LABELS,
    );

    expect(action).toEqual({
      kind: "kept-branch",
      reason: expect.stringContaining("cannot lock ref"),
    });
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
    expect(calls.deletes).toEqual([]);
    expect(calls.forceDeletes).toEqual([]);
    expect(calls.pushes).toEqual([]);
  });

  it("hard-error with commits: still pushes when the clone was preserved, and says the clone may hold more", async () => {
    const { adapter, calls } = makeAdapter({
      aheadOfSeed: true,
      reclaim: {
        kind: "preserved",
        reason: "the worktree has uncommitted changes",
        worktreePath: "/host/.sandbar/worktrees/sandbar-issue-45-t-45",
      },
    });
    const i = issue(45);
    const action = await finalizeOne(
      { kind: "hard-error", issue: i },
      adapter,
      LABELS,
    );

    expect(action).toEqual({
      kind: "kept-branch",
      reason: expect.stringContaining("uncommitted changes"),
    });
    expect(calls.pushes).toEqual([i.branch]);
    expect(calls.deletes).toEqual([]);
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
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
    expect(calls.deletes).toEqual([i.branch]);
    expect(calls.forceDeletes).toEqual([i.branch]);
    expect(calls.pushes).toEqual([]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
  });

  it("fresh-attempt: -d alone succeeding skips the -D fallback", async () => {
    const { adapter, calls } = makeAdapter({ aheadOfSeed: true });
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
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
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
          budgetExhausted: { budget: "gate", roundsUsed: 4, failedStep: "tests" },
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
          budgetExhausted: { budget: "gate", roundsUsed: 4, failedStep: "tests" },
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
        {
          kind: "review-budget-exhausted",
          issue: issue(45),
          budget: "correctness",
          roundsUsed: 4,
          latestReviewerProse: "violations",
        },
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

  it("landing-push-refused parks from the cache without retrying the refused push", async () => {
    const { adapter, calls } = makeAdapter();
    const i = issue(45);

    const action = await finalizeOne(
      { kind: "landing-push-refused", issue: i },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "parked-local" });
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
    expect(calls.pushes).toEqual([]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([
      { n: 45, remove: [], add: [AGENT_STUCK] },
    ]);
  });

  it("landing-push-refused fails loud when its handoff label cannot be applied", async () => {
    const { adapter, calls } = makeAdapter({ labelEditOk: false });

    await expect(finalizeOne(
      { kind: "landing-push-refused", issue: issue(45) },
      adapter,
      LABELS,
    )).rejects.toBeInstanceOf(SandbarError);
    expect(calls.pushes).toEqual([]);
    expect(calls.labelEdits).toEqual([{
      n: 45,
      remove: [],
      add: [AGENT_STUCK],
    }]);
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
          budgetExhausted: { budget: "gate", roundsUsed: 4, failedStep: "tests" },
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
          budgetExhausted: { budget: "gate", roundsUsed: 4, failedStep: "tests" },
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
          budgetExhausted: { budget: "gate", roundsUsed: 4, failedStep: "tests" },
        specGaps: [{ round: 1, text: "must not be posted" }],
      },
      adapter,
      LABELS,
    );

    expect(action).toEqual({ kind: "skipped-closed" });
    expect(calls.stateChecks).toEqual([45]);
    expect(calls.reclaims).toEqual([{ branch: i.branch }]);
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
    const { adapter, calls } = makeAdapter({ aheadOfSeed: true });
    const inputs: FinalizeInput[] = [
      { kind: "merged", issue: issue(10), specGaps: [] },
      {
        kind: "needs-info",
        issue: issue(11),
        questions: "?",
        strandedHead: null,
        specGaps: [],
      },
      { kind: "merge-gate-red", issue: issue(12), specGaps: [] },
      {
        kind: "hard-error",
        issue: issue(13),
        specGaps: [],
      },
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
    expect(calls.reclaims).toEqual([
      { branch: "sandbar/issue-10-t-10" },
      { branch: "sandbar/issue-11-t-11" },
      { branch: "sandbar/issue-12-t-12" },
      { branch: "sandbar/issue-13-t-13" },
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
    expect(calls.reclaims).toEqual([]);
    expect(calls.comments).toEqual([]);
    expect(calls.labelEdits).toEqual([]);
  });
});
