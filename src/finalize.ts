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
//
// Handoff labels are configurable (LabelConfig in config.ts) and NOT
// auto-created — a missing/misconfigured label is a host config error. Every
// agent-failure terminal (merge-conflict, merge-gate-red, silent-noop-exhausted,
// needs-human, review-budget-exhausted) parks the issue under the single
// `agentStuck` label; the *reason* lives in the bot comment.
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

export async function finalizeOne(
  input: FinalizeInput,
  adapter: FinalizeAdapter,
  labels: LabelConfig,
): Promise<FinalizeAction> {
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
      // The merger already dropped `ready-for-agent`; finalize only parks it
      // under the handoff label.
      const r = await adapter.editLabels(n, [], [labels.agentStuck]);
      requireFlip(r, n);
      return { kind: "pushed" };
    }
    case "merge-gate-red": {
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
    case "needs-human": {
      const n = issueNumberOf(input.issue);
      await adapter.removeWorktreeFor(input.issue.branch);
      await adapter.pushBranch(input.issue.branch);
      await adapter.postComment(
        n,
        NEEDS_HUMAN_COMMENT_TEMPLATE(
          input.failureTrace,
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
  };
}
