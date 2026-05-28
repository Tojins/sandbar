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
// For the `merged` kind, `git branch -d` is escalated to `-D` on failure:
// when the merger's resolve-loop lands a branch by producing different
// bytes on the source branch (e.g., conflict resolution), the local branch
// tip is no longer an ancestor of HEAD and `-d` correctly refuses. We own
// the certainty that the work is preserved on origin at this point.
//
// finalizeOne is pure orchestration over a FinalizeAdapter. realAdapter wires
// the adapter to git/gh.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import type { IssueRef } from "./merger.js";

const exec = promisify(execFile);

export const READY_FOR_AGENT_LABEL = "ready-for-agent";
export const READY_FOR_HUMAN_LABEL = "ready-for-human";
export const NEEDS_INFO_LABEL = "needs-info";
export const NEEDS_HUMAN_LABEL = "needs-human";

export const BOT_COMMENT_PREFIX = "**Sandbar:**";

export const NEEDS_INFO_COMMENT_TEMPLATE = (questions: string): string =>
  `${BOT_COMMENT_PREFIX} the agent paused with NEEDS-INFO. Please answer the ` +
  `questions below, then drop \`needs-info\` and re-apply \`ready-for-agent\` ` +
  `when the answers are ready.\n\n---\n\n${questions}`;

export const NEEDS_HUMAN_COMMENT_TEMPLATE = (failureTrace: string): string =>
  `${BOT_COMMENT_PREFIX} exhausted the attempt budget without a green gate. ` +
  `Investigate the trace below and push a fix on this branch, then drop ` +
  `\`needs-human\` and re-apply \`ready-for-agent\` when ready.\n\n` +
  `<details><summary>Last failure trace</summary>\n\n` +
  `\`\`\`\n${failureTrace}\n\`\`\`\n\n</details>`;

export const REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE = (
  latestReviewerProse: string,
): string =>
  `${BOT_COMMENT_PREFIX} exhausted the reviewer-round budget without an ` +
  `\`APPROVED\` verdict. The latest reviewer pass below is the bar violation ` +
  `report the human needs to resolve. Push a fix on this branch (or rewrite ` +
  `the standards if the reviewer was wrong), then drop \`needs-human\` and ` +
  `re-apply \`ready-for-agent\` when ready.\n\n---\n\n${latestReviewerProse}`;

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
  | {
      readonly kind: "needs-info";
      readonly issue: IssueRef;
      readonly questions: string;
    }
  | {
      readonly kind: "needs-human";
      readonly issue: IssueRef;
      readonly failureTrace: string;
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
  // Silent-noop retries exhausted: drop `ready-for-agent`, add
  // `ready-for-human`, post a comment explaining the failure mode. No
  // branch is pushed (each silent-noop deleted it; there's nothing on the
  // remote to inspect).
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
  postComment(issueNum: number, body: string): Promise<void>;
  // Atomic per `gh`: a single `gh issue edit` accepts both --remove-label and
  // --add-label flags, so the issue is never observed in a half-flipped state.
  editLabels(
    issueNum: number,
    remove: readonly string[],
    add: readonly string[],
  ): Promise<void>;
};

export type FinalizeAction =
  | { readonly kind: "deleted-local" }
  | { readonly kind: "delete-failed"; readonly error: string }
  | { readonly kind: "pushed" }
  | { readonly kind: "noop" };

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

export async function finalizeOne(
  input: FinalizeInput,
  adapter: FinalizeAdapter,
): Promise<FinalizeAction> {
  switch (input.kind) {
    case "merged": {
      // AC: worktree first, then branch — so an interrupt mid-cleanup never
      // leaves a dangling worktree pointing at a deleted ref.
      await adapter.removeWorktreeFor(input.issue.branch);
      const r = await adapter.deleteBranch(input.issue.branch);
      if (r.ok) return { kind: "deleted-local" };
      // `-d` refused. The merger just landed this branch — if the resolve
      // loop produced a different tree on the source branch than the branch's
      // diff, the branch tip isn't an ancestor of HEAD and -d will always
      // refuse here. We own the certainty, so escalate.
      const f = await adapter.forceDeleteBranch(input.issue.branch);
      return f.ok
        ? { kind: "deleted-local" }
        : { kind: "delete-failed", error: f.error ?? r.error ?? "" };
    }
    case "merge-conflict": {
      const n = issueNumberOf(input.issue);
      await adapter.removeWorktreeFor(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      await adapter.editLabels(n, [], [READY_FOR_HUMAN_LABEL]);
      return { kind: "pushed" };
    }
    case "merge-gate-red": {
      const n = issueNumberOf(input.issue);
      await adapter.removeWorktreeFor(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      await adapter.editLabels(n, [], [READY_FOR_HUMAN_LABEL]);
      return { kind: "pushed" };
    }
    case "needs-info": {
      const n = issueNumberOf(input.issue);
      await adapter.removeWorktreeFor(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      await adapter.postComment(n, NEEDS_INFO_COMMENT_TEMPLATE(input.questions));
      await adapter.editLabels(n, [READY_FOR_AGENT_LABEL], [NEEDS_INFO_LABEL]);
      return { kind: "pushed" };
    }
    case "needs-human": {
      const n = issueNumberOf(input.issue);
      await adapter.removeWorktreeFor(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      await adapter.postComment(
        n,
        NEEDS_HUMAN_COMMENT_TEMPLATE(input.failureTrace),
      );
      await adapter.editLabels(n, [READY_FOR_AGENT_LABEL], [NEEDS_HUMAN_LABEL]);
      return { kind: "pushed" };
    }
    case "review-budget-exhausted": {
      const n = issueNumberOf(input.issue);
      await adapter.removeWorktreeFor(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      await adapter.postComment(
        n,
        REVIEW_BUDGET_EXHAUSTED_COMMENT_TEMPLATE(input.latestReviewerProse),
      );
      await adapter.editLabels(n, [READY_FOR_AGENT_LABEL], [NEEDS_HUMAN_LABEL]);
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
      const r = await adapter.deleteBranch(input.issue.branch);
      if (r.ok) return { kind: "deleted-local" };
      const f = await adapter.forceDeleteBranch(input.issue.branch);
      return f.ok
        ? { kind: "deleted-local" }
        : { kind: "delete-failed", error: f.error ?? r.error ?? "" };
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
      await adapter.editLabels(
        n,
        [READY_FOR_AGENT_LABEL],
        [READY_FOR_HUMAN_LABEL],
      );
      return { kind: "deleted-local" };
    }
  }
}

export async function finalizeAll(
  inputs: readonly FinalizeInput[],
  adapter: FinalizeAdapter,
): Promise<readonly FinalizeResult[]> {
  const results: FinalizeResult[] = [];
  for (const input of inputs) {
    const action = await finalizeOne(input, adapter);
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
  // Mirror sandcastle's WorktreeManager.create: <repoDir>/<workDir>/worktrees/
  // <branch with '/' replaced by '-'>.
  return join(repoDir, workDir, "worktrees", branch.replace(/\//g, "-"));
}

// ---------------------------------------------------------------------------
// Real adapter — shells out to git and gh.
// ---------------------------------------------------------------------------

export type RealFinalizeAdapterDeps = {
  readonly cwd: string;
  readonly workDir: string;
};

export function realAdapter(deps: RealFinalizeAdapterDeps): FinalizeAdapter {
  const cwd = deps.cwd;
  return {
    async pushBranch(branch) {
      try {
        await exec("git", ["push", "origin", `${branch}:${branch}`], { cwd });
      } catch (err) {
        console.error(
          `  finalize: failed to push ${branch}: ${
            err instanceof Error ? err.message : String(err)
          }`,
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
    async removeWorktreeFor(branch) {
      const path = worktreePathFor(cwd, deps.workDir, branch);
      try {
        await exec("git", ["worktree", "remove", "--force", path], { cwd });
      } catch {
        /* already removed by sandcastle.close() in normal operation */
      }
      try {
        await exec("git", ["worktree", "prune"], { cwd });
      } catch {
        /* best-effort */
      }
    },
    async postComment(issueNum, body) {
      try {
        await exec(
          "gh",
          ["issue", "comment", String(issueNum), "--body", body],
          { cwd },
        );
      } catch (err) {
        console.error(
          `  finalize: failed to comment on issue #${issueNum}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    async editLabels(issueNum, remove, add) {
      const args: string[] = ["issue", "edit", String(issueNum)];
      for (const l of remove) args.push("--remove-label", l);
      for (const l of add) args.push("--add-label", l);
      try {
        await exec("gh", args, { cwd });
      } catch (err) {
        console.error(
          `  finalize: failed to edit labels on issue #${issueNum} (remove=${remove.join(
            ",",
          )}, add=${add.join(",")}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  };
}
