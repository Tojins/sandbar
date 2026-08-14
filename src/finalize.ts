// Per-issue branch lifecycle + label flips + issue annotations.
//
// Runs after the merger. For each issue the orchestrator touched this
// iteration, dispatches to the right side-effects given its terminal state.
//
// Every kind calls removeWorktreeFor — sandbox.close() in the inner-loop
// usually has already removed the worktree, but leftover worktrees from
// crashes or non-merged terminals would otherwise block the next run's
// preflight cleanup (it can't `git branch -D` a branch a worktree is on).
//
// `git branch -d` is escalated to `-D` only where the caller owns the certainty
// that the work is preserved elsewhere. For `merged`/`fresh-attempt` that
// certainty is structural — the merger just landed the branch on the source
// branch (producing different bytes, so the tip is no longer an ancestor of
// HEAD and `-d` correctly refuses), or the silent-noop path is deliberately
// discarding it. `needs-ui-prototype` has no such guarantee (its `hasCommits`
// is per-sandbox-cycle, not per-branch), so it *verifies* containment via
// branchIsContainedInOrigin before forcing, and keeps the branch otherwise.
// `-d` refusing is never on its own a licence to force.
//
// Human-handoff terminals are guarded on live issue state (#16): stamping
// `agentStuck` + a failure comment on an already-CLOSED issue contradicts its
// state and reads as "merged work is broken". The planner's stale-search
// re-pick (the root cause) is fixed in plan-resolver, but a human can also
// close an issue mid-run, so finalize re-checks `issueState` before any handoff
// write and no-ops (skipped-closed) when the issue is closed.
//
// finalizeOne is pure orchestration over a FinalizeAdapter. realAdapter wires
// the adapter to git/gh.
//
// Handoff labels are configurable (LabelConfig in config.ts) and NOT
// auto-created — a missing/misconfigured label is a host config error. Every
// agent-failure terminal (merge-conflict, merge-gate-red, forge-unverified,
// silent-noop-exhausted, needs-human, review-budget-exhausted) parks the issue
// under the single `agentStuck` label; the *reason* lives in the bot comment.
//
// Required side-effects fail loud, they don't swallow (#8). The original bug was
// `editLabels` catching a "label doesn't exist" error, logging it, and returning
// as if the issue had been parked — so the run continued and the issue, never
// removed from the queue, was re-picked forever. Now the required git/gh
// operations (pushBranch, postComment, and the required label flips via
// requireFlip) throw SandbarError on failure; run() surfaces it as the final
// output and stops. editLabels still removes then adds as separate `gh` calls so
// a missing add-label can't abort the queue-removing --remove-label, and it
// returns its outcome structured so the benign `merged` cleanup can ignore a
// failure while the handoff arms turn it into a loud stop.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import type { LabelConfig } from "./config.js";
import { SandbarError } from "./errors.js";
import type { IssueRef } from "./merger.js";

const exec = promisify(execFile);

// The planner queue label sandbar removes when an issue leaves the queue. Fixed
// (not in LabelConfig) — it's the protocol entry label, shared with the
// planner's list filter and the merger; see config.ts LabelConfig.
export const READY_FOR_AGENT_LABEL = "ready-for-agent";

export const BOT_COMMENT_PREFIX = "**Sandbar:**";

export const NEEDS_INFO_COMMENT_TEMPLATE = (
  questions: string,
  needsInfoLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} the agent paused with NEEDS-INFO. Please answer the ` +
  `questions below, then drop \`${needsInfoLabel}\` and re-apply \`${readyLabel}\` ` +
  `when the answers are ready.\n\n---\n\n${questions}`;

// #21 — the implementer stopped before writing code because the issue implies
// non-trivial user-visible UI and carries no prototype. Same human round-trip
// as NEEDS-INFO (supply the missing artifact, re-label), so it reuses the
// needsInfo label; the comment is what makes the ask concrete.
//
// The unblocking routes are spelled out because most of them silently don't
// work: the agent reads this issue as text (`gh issue view --json`), so a
// pasted screenshot is a URL it can neither authenticate to nor see. An
// in-repo file must be on the source branch before re-labelling, because issue
// branches seed from `origin/<sourceBranch>`, not the operator's local.
// The escape phrase is deliberately verbatim in both this comment and
// prompts/implementer.md ("no prototype needed"): the human types it here and
// the next run's implementer must recognise it in the issue anchor. That
// coupling is pinned by a test.
export const NO_PROTOTYPE_NEEDED_PHRASE = "no prototype needed";

export const NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE = (
  issueNum: number,
  uiImpact: string,
  needsInfoLabel: string,
  readyLabel: string,
  // The escalation normally lands before a line of code exists, but a late one
  // is accepted (see promise-parser) and then the branch was pushed. Saying
  // "stopped before writing any code" in that case tells the human the opposite
  // of what just happened.
  branchPushed: string | null,
): string =>
  `${BOT_COMMENT_PREFIX} the agent stopped ${
    branchPushed === null
      ? "before writing any code"
      : `and pushed what it had to \`${branchPushed}\``
  }. This issue implies user-visible UI that no human has seen, and no prototype ` +
  `was found in the issue body or comments — continuing would mean inventing the ` +
  `design and merging it unseen. The agent's assessment is below.\n\n` +
  `To unblock, either:\n\n` +
  `1. **Give it a prototype it can read.** Suggested route: commit a file to the ` +
  `repo (e.g. \`docs/prototypes/issue-${issueNum}.html\`) and reference it by path ` +
  `here — push it to the source branch first, because issue branches are seeded ` +
  `from origin, not your local checkout. An inline fenced markup block or ASCII ` +
  `wireframe in a comment works just as well, as does a prose spec precise enough ` +
  `to pin the decisions listed below. A screenshot on its own does not: the agent ` +
  `reads this issue as text and cannot see images.\n` +
  `2. **Reply "${NO_PROTOTYPE_NEEDED_PHRASE}"** — in your own comment, not by ` +
  `editing this one — if you're happy for the agent to make these design ` +
  `decisions itself.\n\n` +
  `Then drop \`${needsInfoLabel}\` and re-apply \`${readyLabel}\`.\n\n` +
  `---\n\n${uiImpact}`;

export const NEEDS_HUMAN_COMMENT_TEMPLATE = (
  failureTrace: string,
  stuckLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} exhausted the attempt budget without a green gate. ` +
  `Investigate the trace below and push a fix on this branch, then drop ` +
  `\`${stuckLabel}\` and re-apply \`${readyLabel}\` when ready.\n\n` +
  `<details><summary>Last failure trace</summary>\n\n` +
  `\`\`\`\n${failureTrace}\n\`\`\`\n\n</details>`;

// Impl-attempt budget exhausted while the gate was GREEN and the reviewer was
// the blocker (#17). Distinct from NEEDS_HUMAN_COMMENT_TEMPLATE (which claims
// "without a green gate") and from REVIEW_BUDGET_EXHAUSTED (a different budget):
// here the *attempt* budget ran out, not the reviewer-round budget.
export const NEEDS_HUMAN_REVIEWER_BLOCKED_COMMENT_TEMPLATE = (
  latestReviewerProse: string,
  stuckLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} exhausted the attempt budget with a green gate — the ` +
  `build and tests pass; the code reviewer's \`CHANGES-REQUESTED\` is the blocker, ` +
  `not a failing gate. The latest reviewer pass below is what the human needs to ` +
  `resolve. Push a fix on this branch (or rewrite the standards if the reviewer ` +
  `was wrong), then drop \`${stuckLabel}\` and re-apply \`${readyLabel}\` when ` +
  `ready.\n\n---\n\n${latestReviewerProse}`;

export const REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE = (
  latestReviewerProse: string,
  stuckLabel: string,
  readyLabel: string,
): string =>
  `${BOT_COMMENT_PREFIX} exhausted the reviewer-round budget without an ` +
  `\`APPROVED\` verdict. The latest reviewer pass below is the standards-violation ` +
  `report the human needs to resolve. Push a fix on this branch (or rewrite ` +
  `the standards if the reviewer was wrong), then drop \`${stuckLabel}\` and ` +
  `re-apply \`${readyLabel}\` when ready.\n\n---\n\n${latestReviewerProse}`;

export const SILENT_NOOP_EXHAUSTED_COMMENT_TEMPLATE = (attempts: number): string =>
  `${BOT_COMMENT_PREFIX} hit the silent-merge-abort failure mode ${attempts} time${attempts === 1 ? "" : "s"} ` +
  `this run. Each time, the merger's resolve-loop reported success but no merge commit landed on the source branch ` +
  `(the agent ran \`git merge --abort\` and exited without producing a merge commit). The branch was ` +
  `discarded after each attempt so the next cycle could re-implement against current source, but the ` +
  `integration drift hasn't healed. A human needs to land this — either by resolving the conflict manually ` +
  `or by re-scoping the issue.`;

export type FinalizeInput =
  | { readonly kind: "merged"; readonly issue: IssueRef }
  | { readonly kind: "merge-conflict"; readonly issue: IssueRef }
  | { readonly kind: "merge-gate-red"; readonly issue: IssueRef }
  // Verified merge mode (#22): merged + locally gated green, but the forge
  // rejected the cycle's composed result, so the merge was reverted and nothing
  // landed. Same handoff shape as merge-gate-red — the merger already posted the
  // explanatory comment and dropped the queue label; finalize pushes the branch
  // (the human needs it on the forge to inspect) and parks it.
  | { readonly kind: "forge-unverified"; readonly issue: IssueRef }
  | {
      readonly kind: "needs-info";
      readonly issue: IssueRef;
      readonly questions: string;
    }
  // #21 — implementer escalated on non-trivial UI impact with no prototype.
  // Same handoff shape as needs-info (comment + `ready-for-agent` → needsInfo),
  // but the branch is pushed only when `hasCommits`: the escalation normally
  // fires before any code exists, and pushing then would publish a remote
  // branch identical to the source tip — one junk ref per escalation.
  | {
      readonly kind: "needs-ui-prototype";
      readonly issue: IssueRef;
      readonly uiImpact: string;
      readonly hasCommits: boolean;
    }
  | {
      // Impl-attempt budget exhausted. `cause` selects the comment so the human
      // is pointed at the real blocker (#17): gate-red surfaces the failure
      // trace; reviewer-blocked surfaces the reviewer's CHANGES-REQUESTED prose.
      readonly kind: "needs-human";
      readonly issue: IssueRef;
      readonly cause: "gate-red" | "reviewer-blocked";
      readonly failureTrace: string;
      readonly latestReviewerProse: string | null;
    }
  | {
      readonly kind: "review-budget-exhausted";
      readonly issue: IssueRef;
      readonly latestReviewerProse: string;
    }
  | {
      readonly kind: "hard-error";
      readonly issue: IssueRef;
      readonly hasCommits: boolean;
    }
  // Silent-noop under the retry cap: discard the branch + worktree so the
  // next cycle's implementer starts fresh against current source. The issue
  // stays `ready-for-agent` and the planner re-picks it.
  | { readonly kind: "fresh-attempt"; readonly issue: IssueRef }
  // Silent-noop retries exhausted: drop `ready-for-agent`, add the handoff
  // label, post a comment explaining the failure mode. No branch is pushed
  // (each silent-noop deleted it; there's nothing on the remote to inspect).
  | {
      readonly kind: "silent-noop-exhausted";
      readonly issue: IssueRef;
      readonly attempts: number;
    };

export type FinalizeAdapter = {
  pushBranch(branch: string): Promise<void>;
  // git branch -d — refuses if the branch isn't merged, which is desirable.
  // Returns ok=false with the error message instead of throwing so the
  // orchestrator can keep finalising the rest.
  deleteBranch(
    branch: string,
  ): Promise<{ readonly ok: boolean; readonly error?: string }>;
  // git branch -D — force-delete. Only safe in contexts where the caller
  // knows the work is already preserved elsewhere (e.g., the merger just
  // landed it on the source branch via the resolve-loop, where the merge
  // tree differs from the branch's diff so `-d` refuses).
  forceDeleteBranch(
    branch: string,
  ): Promise<{ readonly ok: boolean; readonly error?: string }>;
  // Best-effort: sandbox.close() in the inner-loop usually has already removed
  // the worktree. Adapter swallows errors.
  removeWorktreeFor(branch: string): Promise<void>;
  // True iff every commit on `branch` is already contained in
  // origin/<sourceBranch> — i.e. deleting it destroys nothing. This is the
  // *verified* form of the certainty forceDeleteBranch requires; `-d` refusing
  // is NOT that certainty (it also refuses when the local source branch merely
  // trails origin). Any error answers false: we never force-delete on a guess.
  branchIsContainedInOrigin(branch: string): Promise<boolean>;
  postComment(issueNum: number, body: string): Promise<void>;
  // Removes then adds, as SEPARATE `gh issue edit` calls (remove first). A
  // single `gh issue edit` is atomic: if any --add-label target doesn't exist,
  // gh rejects the whole command and the --remove-label is collateral damage —
  // the issue keeps `ready-for-agent` and the planner re-picks it forever (#8).
  // Splitting guarantees the queue-removal lands even when the handoff label is
  // missing/misconfigured, and the result reports what failed so the caller can
  // fail loud instead of swallowing.
  editLabels(
    issueNum: number,
    remove: readonly string[],
    add: readonly string[],
  ): Promise<LabelEditResult>;
  // Live issue state from the tracker. Read before any human-handoff write so a
  // closed issue (merged earlier this run, or human-closed mid-run) never gets
  // stamped with a handoff label + failure comment (#16).
  issueState(issueNum: number): Promise<"OPEN" | "CLOSED">;
};

export type LabelEditResult = {
  readonly ok: boolean;
  // Present iff !ok. Describes which leg(s) failed (remove and/or add).
  readonly error?: string;
};

export type FinalizeAction =
  | { readonly kind: "deleted-local" }
  | { readonly kind: "delete-failed"; readonly error: string }
  | { readonly kind: "pushed" }
  // A human-handoff terminal landed on an already-CLOSED issue, so the label
  // flip + comment were skipped (the worktree was still reclaimed). See #16.
  | { readonly kind: "skipped-closed" }
  | { readonly kind: "noop" };

// Terminals that write a human-handoff annotation (handoff label + a comment)
// to the issue. These are the kinds guarded against an already-CLOSED issue in
// finalizeOne (#16); merged/hard-error/fresh-attempt touch no issue state and
// are exempt.
const HANDOFF_KINDS: ReadonlySet<FinalizeInput["kind"]> = new Set([
  "merge-conflict",
  "merge-gate-red",
  "forge-unverified",
  "needs-info",
  "needs-ui-prototype",
  "needs-human",
  "review-budget-exhausted",
  "silent-noop-exhausted",
]);

export type FinalizeResult = {
  readonly input: FinalizeInput;
  readonly action: FinalizeAction;
};

export function issueNumberOf(issue: IssueRef): number {
  const n = Number(issue.id);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid issue id (expected positive integer): ${issue.id}`);
  }
  return n;
}

// A required human-handoff label flip. The split-call adapter already ran the
// remove first (so the issue leaves the agent queue regardless), but if either
// leg failed we fail loud rather than report a successful handoff that didn't
// happen — the #8 bug. A failed flip is almost always a config error: the
// handoff label doesn't exist in the repo and sandbar never creates labels.
function requireFlip(r: LabelEditResult, issueNum: number): void {
  if (r.ok) return;
  throw new SandbarError(
    `Could not park issue #${issueNum} for a human: applying the handoff labels ` +
      `failed (${r.error ?? "unknown error"}). This is almost certainly a config ` +
      `error — the label does not exist in the repo (sandbar never creates ` +
      `labels). Create it or set config.labels, then re-run.`,
  );
}

// `-d`, escalating to `-D` when it refuses. ONLY for callers that own the
// certainty the work is preserved elsewhere — see the module header. Callers
// without that certainty must verify it (branchIsContainedInOrigin) instead of
// reaching for this.
async function deleteBranchForcing(
  adapter: FinalizeAdapter,
  branch: string,
): Promise<FinalizeAction> {
  const d = await adapter.deleteBranch(branch);
  if (d.ok) return { kind: "deleted-local" };
  const f = await adapter.forceDeleteBranch(branch);
  return f.ok
    ? { kind: "deleted-local" }
    : { kind: "delete-failed", error: f.error ?? d.error ?? "" };
}

export async function finalizeOne(
  input: FinalizeInput,
  adapter: FinalizeAdapter,
  labels: LabelConfig,
): Promise<FinalizeAction> {
  // #16: never write a handoff annotation to an issue that's already CLOSED.
  // The planner can re-pick a merged+closed issue while the `gh` search backend
  // lags (root cause fixed in plan-resolver), and a human can close an issue
  // mid-run — in both cases the handoff write would contradict the closed
  // state. Reclaim the worktree (local hygiene, always safe) and skip the
  // issue-facing side effects.
  if (HANDOFF_KINDS.has(input.kind)) {
    const n = issueNumberOf(input.issue);
    if ((await adapter.issueState(n)) === "CLOSED") {
      await adapter.removeWorktreeFor(input.issue.branch);
      return { kind: "skipped-closed" };
    }
  }
  switch (input.kind) {
    case "merged": {
      // AC: worktree first, then branch — so an interrupt mid-cleanup never
      // leaves a dangling worktree pointing at a deleted ref.
      await adapter.removeWorktreeFor(input.issue.branch);
      // The merger's merge commit auto-closes the issue, but GitHub doesn't
      // strip labels on close — drop `ready-for-agent` so the closed issue
      // isn't left advertising itself as plannable (#7). Best-effort: a failure
      // here is benign (the planner lists open issues, so a closed issue still
      // carrying the label is never re-picked).
      await adapter.editLabels(
        issueNumberOf(input.issue),
        [READY_FOR_AGENT_LABEL],
        [],
      );
      // `-d` may refuse: if the resolve loop produced a different tree on the
      // source branch than the branch's diff, the branch tip isn't an ancestor
      // of HEAD. The merger just landed this branch, so we own the certainty
      // and escalate to `-D`.
      return deleteBranchForcing(adapter, input.issue.branch);
    }
    case "merge-conflict": {
      const n = issueNumberOf(input.issue);
      await adapter.removeWorktreeFor(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      // The merger already dropped `ready-for-agent`; finalize only parks it
      // under the handoff label.
      const r = await adapter.editLabels(n, [], [labels.agentStuck]);
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "merge-gate-red":
    case "forge-unverified": {
      const n = issueNumberOf(input.issue);
      await adapter.removeWorktreeFor(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      const r = await adapter.editLabels(n, [], [labels.agentStuck]);
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "needs-info": {
      const n = issueNumberOf(input.issue);
      await adapter.removeWorktreeFor(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      await adapter.postComment(
        n,
        NEEDS_INFO_COMMENT_TEMPLATE(
          input.questions,
          labels.needsInfo,
          READY_FOR_AGENT_LABEL,
        ),
      );
      const r = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.needsInfo],
      );
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "needs-ui-prototype": {
      const n = issueNumberOf(input.issue);
      await adapter.removeWorktreeFor(input.issue.branch);
      if (input.hasCommits) {
        // Late escalation: the agent had already committed before it realised
        // it was inventing UI. Hand the partial work to the human.
        await adapter.pushBranch(input.issue.branch);
      }
      await adapter.postComment(
        n,
        NEEDS_UI_PROTOTYPE_COMMENT_TEMPLATE(
          n,
          input.uiImpact,
          labels.needsInfo,
          READY_FOR_AGENT_LABEL,
          input.hasCommits ? input.issue.branch : null,
        ),
      );
      const r = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.needsInfo],
      );
      requireFlip(r, n);
      if (input.hasCommits) return { kind: "pushed" };
      // Nothing was written this sandbox cycle, so drop the local branch:
      // ensureIssueBranch reuses an existing branch verbatim, and keeping an
      // empty one would pin the next run (after the human supplies the
      // prototype) to a stale origin tip.
      //
      // `-d` refusing is not permission to force: it also refuses when the
      // local source branch merely trails the origin tip we seeded from. And
      // `hasCommits` is per-sandbox-cycle, not per-branch — a HARD-ERROR retry
      // restarts the cycle with an empty commit list while the previous
      // attempts' commits are still on the branch, as does a branch left by an
      // interrupted earlier run. So escalate to `-D` only once the branch is
      // *verified* to contain nothing that isn't already on origin; otherwise
      // keep it and report the failure. The other force-deleting arms own that
      // certainty by construction (the merger just landed the work, or the
      // silent-noop path deliberately discards it) — this one does not.
      const d = await adapter.deleteBranch(input.issue.branch);
      if (d.ok) return { kind: "deleted-local" };
      if (!(await adapter.branchIsContainedInOrigin(input.issue.branch))) {
        return {
          kind: "delete-failed",
          error:
            `${d.error ?? "branch -d refused"} — kept: it carries commits that ` +
            `are not on origin (an earlier attempt's work), and this handoff ` +
            `did not push it.`,
        };
      }
      const f = await adapter.forceDeleteBranch(input.issue.branch);
      return f.ok
        ? { kind: "deleted-local" }
        : { kind: "delete-failed", error: f.error ?? d.error ?? "" };
    }
    case "needs-human": {
      const n = issueNumberOf(input.issue);
      await adapter.removeWorktreeFor(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      // #17: name the real blocker. reviewer-blocked → surface the reviewer's
      // CHANGES-REQUESTED prose; gate-red → the gate failure trace.
      const body =
        input.cause === "reviewer-blocked"
          ? NEEDS_HUMAN_REVIEWER_BLOCKED_COMMENT_TEMPLATE(
              input.latestReviewerProse ?? "",
              labels.agentStuck,
              READY_FOR_AGENT_LABEL,
            )
          : NEEDS_HUMAN_COMMENT_TEMPLATE(
              input.failureTrace,
              labels.agentStuck,
              READY_FOR_AGENT_LABEL,
            );
      await adapter.postComment(n, body);
      const r = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.agentStuck],
      );
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "review-budget-exhausted": {
      const n = issueNumberOf(input.issue);
      await adapter.removeWorktreeFor(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      await adapter.postComment(
        n,
        REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE(
          input.latestReviewerProse,
          labels.agentStuck,
          READY_FOR_AGENT_LABEL,
        ),
      );
      const r = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.agentStuck],
      );
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "hard-error": {
      if (input.hasCommits) {
        await adapter.removeWorktreeFor(input.issue.branch);
        await adapter.pushBranch(input.issue.branch);
        return { kind: "pushed" };
      }
      await adapter.removeWorktreeFor(input.issue.branch);
      const r = await adapter.deleteBranch(input.issue.branch);
      return r.ok
        ? { kind: "deleted-local" }
        : { kind: "delete-failed", error: r.error ?? "" };
    }
    case "fresh-attempt": {
      // Same shape as `merged`: worktree first, then branch (with `-D`
      // fallback because the silent-noop branch has commits that aren't on
      // the source branch and `-d` would refuse). No push, no comment, no
      // label flip — the issue stays `ready-for-agent` for the next cycle's
      // planner.
      await adapter.removeWorktreeFor(input.issue.branch);
      return deleteBranchForcing(adapter, input.issue.branch);
    }
    case "silent-noop-exhausted": {
      const n = issueNumberOf(input.issue);
      await adapter.removeWorktreeFor(input.issue.branch);
      // The branch from the final silent-noop attempt was already deleted by
      // the merger (we don't push it for human inspection because the work
      // didn't survive the abort). Best-effort delete in case anything's
      // left, but the primary side-effect is the comment + label flip.
      const r = await adapter.deleteBranch(input.issue.branch);
      if (!r.ok) await adapter.forceDeleteBranch(input.issue.branch);
      await adapter.postComment(
        n,
        SILENT_NOOP_EXHAUSTED_COMMENT_TEMPLATE(input.attempts),
      );
      const r2 = await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [labels.agentStuck],
      );
      requireFlip(r2, n);
      return { kind: "deleted-local" };
    }
  }
}

export async function finalizeAll(
  inputs: readonly FinalizeInput[],
  adapter: FinalizeAdapter,
  labels: LabelConfig,
): Promise<readonly FinalizeResult[]> {
  const results: FinalizeResult[] = [];
  for (const input of inputs) {
    const action = await finalizeOne(input, adapter, labels);
    results.push({ input, action });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Worktree paths
// ---------------------------------------------------------------------------

export function worktreePathFor(
  repoDir: string,
  workDir: string,
  branch: string,
): string {
  // Mirror the sandbox WorktreeManager.create: <repoDir>/<workDir>/worktrees/
  // <branch with '/' replaced by '-'>.
  return join(repoDir, workDir, "worktrees", branch.replace(/\//g, "-"));
}

// ---------------------------------------------------------------------------
// Real adapter — shells out to git and gh.
// ---------------------------------------------------------------------------

export type RealFinalizeAdapterDeps = {
  readonly cwd: string;
  readonly workDir: string;
  // Needed by branchIsContainedInOrigin: issue branches are seeded from
  // origin/<sourceBranch>, so that ref is what "already preserved" means here.
  readonly sourceBranch: string;
};

export function realAdapter(deps: RealFinalizeAdapterDeps): FinalizeAdapter {
  const cwd = deps.cwd;
  return {
    async pushBranch(branch) {
      // Required: the whole point of the non-merged terminals is to hand the
      // branch to a human. If the push fails we must NOT report success and
      // move on (the #8 class of bug) — fail loud.
      try {
        await exec("git", ["push", "origin", `${branch}:${branch}`], { cwd });
      } catch (err) {
        throw new SandbarError(
          `Failed to push branch '${branch}' to origin: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
    async deleteBranch(branch) {
      try {
        await exec("git", ["branch", "-d", branch], { cwd });
        return { ok: true };
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const msg = (e.stderr ?? "").trim() || e.message || String(err);
        return { ok: false, error: msg };
      }
    },
    async forceDeleteBranch(branch) {
      try {
        await exec("git", ["branch", "-D", branch], { cwd });
        return { ok: true };
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const msg = (e.stderr ?? "").trim() || e.message || String(err);
        return { ok: false, error: msg };
      }
    },
    async branchIsContainedInOrigin(branch) {
      // Exit 0 iff the branch tip is an ancestor of (or equal to) the origin
      // tip — every commit on it is already published. Any failure, including
      // a missing remote-tracking ref, answers false: the caller only ever
      // force-deletes on a true, so guessing wrong must not destroy work.
      try {
        await exec(
          "git",
          [
            "merge-base",
            "--is-ancestor",
            branch,
            `origin/${deps.sourceBranch}`,
          ],
          { cwd },
        );
        return true;
      } catch {
        return false;
      }
    },
    async removeWorktreeFor(branch) {
      const path = worktreePathFor(cwd, deps.workDir, branch);
      try {
        await exec("git", ["worktree", "remove", "--force", path], { cwd });
      } catch {
        /* already removed by the sandbox close() in normal operation */
      }
      try {
        await exec("git", ["worktree", "prune"], { cwd });
      } catch {
        /* best-effort */
      }
    },
    async postComment(issueNum, body) {
      // Required: the comment is the issue's handoff payload (questions, failure
      // trace, reviewer prose). A silently-dropped comment strands the human
      // without the context they need — fail loud.
      try {
        await exec(
          "gh",
          ["issue", "comment", String(issueNum), "--body", body],
          { cwd },
        );
      } catch (err) {
        throw new SandbarError(
          `Failed to post comment on issue #${issueNum}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
    async editLabels(issueNum, remove, add) {
      // Two separate `gh issue edit` calls, remove FIRST. A single combined
      // edit is atomic: if any --add-label target doesn't exist, gh rejects the
      // whole command and the --remove-label never applies — leaving the issue
      // on the agent queue forever. Removing first guarantees the queue-removal
      // lands even when the handoff label is missing/misconfigured (#8).
      const ghEdit = async (flag: "--remove-label" | "--add-label", labelsToApply: readonly string[]): Promise<string | undefined> => {
        if (labelsToApply.length === 0) return undefined;
        const args = ["issue", "edit", String(issueNum)];
        for (const l of labelsToApply) args.push(flag, l);
        try {
          await exec("gh", args, { cwd });
          return undefined;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      };

      const removeErr = await ghEdit("--remove-label", remove);
      const addErr = await ghEdit("--add-label", add);
      if (!removeErr && !addErr) return { ok: true };

      // Return the failure structured rather than logging-and-swallowing: a
      // required-handoff caller turns this into a loud SandbarError (requireFlip),
      // while the benign `merged` caller (#7 cosmetic cleanup on a closed issue)
      // ignores it.
      const parts: string[] = [];
      if (removeErr) parts.push(`remove [${remove.join(",")}]: ${removeErr}`);
      if (addErr) parts.push(`add [${add.join(",")}]: ${addErr}`);
      return { ok: false, error: parts.join("; ") };
    },
    async issueState(issueNum) {
      // Required precondition for the handoff guard (#16): if we can't read the
      // issue's state we don't guess — fail loud rather than risk stamping a
      // closed issue or skipping a live handoff. `gh issue view` works on
      // closed issues too.
      try {
        const { stdout } = await exec(
          "gh",
          ["issue", "view", String(issueNum), "--json", "state"],
          { cwd },
        );
        const parsed = JSON.parse(stdout) as { state?: string };
        return parsed.state === "CLOSED" ? "CLOSED" : "OPEN";
      } catch (err) {
        throw new SandbarError(
          `Failed to read state of issue #${issueNum} before finalising: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
  };
}
