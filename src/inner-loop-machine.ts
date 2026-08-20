// Pure inner-loop state machine.
//
// Drives an issue-attempts loop without any I/O. After every observation the
// runner calls step(state, event) and executes the returned action; when the
// action is `terminate` the loop is done and the verdict is the runner's
// outcome. Every decision — COMPLETE/NEEDS-INFO/NO-SIGNAL routing, gate-1
// red re-prompt, reviewer APPROVED/CHANGES-REQUESTED routing, attempt and
// review-round budget exhaustion — lives here and is table-driven tested in
// inner-loop-machine.test.ts.
//
// Impl-attempt exhaustion carries a `cause` so the human-handoff message names
// the real blocker (#17): `gate-red` (last gate failing / no green gate) vs.
// `reviewer-blocked` (gate green, reviewer's last verdict CHANGES-REQUESTED).
// Each advanceAttempt caller supplies the exhaustion verdict because only it
// knows which case it's in.
//
// A COMPLETE claim is routed on THREE inputs, not one: the promise token,
// whether the worktree is clean (#24 D1), and whether HEAD is still the issue
// branch (#27).
//
// The gate bind-mounts the worktree, so a verdict over a dirty tree is not a
// verdict about any commit — and the merger only ever sees commits. COMPLETE +
// dirty therefore spends an attempt on a re-prompt to commit rather than
// dispatching the gate.
//
// The branch check (#27) is the same argument one level up, and it is checked
// FIRST because it subsumes the other: commits on a detached HEAD leave a CLEAN
// tree, so the dirty check passes and the gate goes green on a tree the branch
// does not contain. What DONE then lands is whatever the branch happens to hold
// — in the ordinary review round-trip, attempt 1's work without attempt 2's fix
// (git-ops.ts spells out why that, and not "nothing at all", is the reachable
// shape). It is applied to
// NO-SIGNAL as well as COMPLETE — every attempt spent off the branch produces
// work the merger can never see, so the sooner the agent is told, the fewer
// commits are stranded. The two hand-to-human terminals (NEEDS-INFO,
// NEEDS-UI-PROTOTYPE) are deliberately exempt: they land nothing by
// construction, the issue is parked for a human either way, and re-prompting
// would risk burning the budget on a question the agent had already formed.
//
// NEEDS-UI-PROTOTYPE (#21) is the second short-circuit terminal alongside
// NEEDS-INFO: the implementer judged the issue to imply non-trivial
// user-visible UI with no prototype to work from, so the loop stops before the
// gate rather than let an invented design reach the merger.
//
// Reviewer is strictly advisory: it never commits and the SM never asks the
// runner to revert anything. Convergence comes from the bar being sharp
// enough for the reviewer to issue a deterministic verdict, not from
// commit-and-revert round-trips.
//
// A reviewer that produced NO review is not a verdict and is not charged like
// one (#41). Whether an invocation reviewed anything is reviewer-run.ts's
// judgment; what arrives here is `reviewer-harness-failed`, and it differs from
// CHANGES-REQUESTED on every axis that costs the issue something: no review
// round is consumed (the budget bounds how many times the reviewer may reject
// this branch, and it rejected nothing), `latestReviewerProse` is left exactly
// as it was (a harness message quoted back as review prose is the fabrication
// the issue is named for, and that string is what finalize shows a human), and
// exhaustion names `reviewer-harness-failed` rather than `reviewer-blocked`,
// which would send its reader to look for a report nobody wrote — #17's
// mistake, one terminal along. The next implementer attempt is dispatched
// anyway, because gate-1 is green and unreviewed work must not read as DONE —
// but it gets an orchestrator note saying the harness failed, not a finding.
//
// A SECOND consecutive harness failure terminates instead. The argument is
// `uncommittable-worktree`'s: an implementer attempt sits between the two, so
// the branch is not what changed, and "the reviewer emits nothing" is not a
// claim about code that another attempt could answer. Left to run, a wedged
// reviewer costs the full attempt budget — each attempt an implementer run, a
// gate, and two idle timeouts — to arrive at the same report it could give now.
//
// Sandbox lifecycle (setup, HARD-ERROR retry-with-fresh-sandbox) sits one
// layer above this machine: decideAfterTerminal answers "retry or surface?"
// for the runner's outer loop. HARD-ERROR is not a verdict the SM ever emits
// itself — it's how the runner wraps unhandled exceptions (setup failures,
// container errors, etc.) so the outer loop can decide whether to retry.

import type { HeadMismatch } from "./git-ops.js";
import type { ParseSignal } from "./promise-parser.js";

export const HARD_ERROR_MAX_RETRIES = 2;

export const NEEDS_HUMAN_BUDGET_EXHAUSTED_MESSAGE =
  "Attempt budget exhausted with no green gate.";

export const NEEDS_HUMAN_REVIEW_BUDGET_EXHAUSTED_MESSAGE =
  "Review-round budget exhausted without an APPROVED verdict.";

export type LoopPhase =
  | "needs-implementer"
  | "needs-gate-1"
  | "needs-reviewer"
  | "terminated";

export type LoopState = {
  readonly maxAttempts: number;
  readonly maxReviewRounds: number;
  readonly attempt: number;
  readonly reviewRoundsUsed: number;
  readonly lastFailureTrace: string;
  readonly extraReprompt: string | null;
  readonly latestReviewerProse: string | null;
  // The dirty set that sent the PREVIOUS attempt back to commit its work, or
  // null if the last attempt didn't end that way. Only used to detect that an
  // attempt changed nothing — see onImplementerResult.
  readonly lastDirtyPaths: readonly string[] | null;
  // Whether the PREVIOUS attempt was sent back because HEAD was not the issue
  // branch (#27). One re-prompt is offered; a second consecutive off-branch
  // attempt terminates — see onImplementerResult.
  readonly lastOffBranch: boolean;
  // Whether the review round on the PREVIOUS attempt yielded no review at all
  // (#41). Cleared by any other route out of an attempt, so it means "the
  // attempt immediately before this one ended that way" — a harness failure two
  // attempts apart, with a real gate red or a real verdict between them, is two
  // incidents and not a wedged reviewer.
  readonly lastReviewerHarnessFailed: boolean;
  readonly phase: LoopPhase;
};

// Verdict is the pure terminal value the SM emits. The runner translates it
// into a Terminal for the outer orchestrator. HARD-ERROR is never emitted by
// the SM itself — it's the runner's wrapper for unhandled exceptions and
// lives in this type only so decideAfterTerminal can pattern-match on it.
export type Verdict =
  | { readonly type: "DONE" }
  | {
      readonly type: "NEEDS-INFO";
      readonly questions: string;
      // Where HEAD was when the agent asked, if it was not the issue branch
      // (#27). These two terminals are exempt from the off-branch correction —
      // see onImplementerResult — but exempt must not mean silent: whatever the
      // agent committed off the branch is about to be deleted along with the
      // worktree, and this is the only record of where it went.
      readonly strandedHead: HeadMismatch | null;
    }
  | {
      // #21 — the implementer judged the issue to imply non-trivial
      // user-visible UI with no prototype to work from. Immediate terminal:
      // no gate, no reviewer, no further attempts (a second attempt would
      // re-read the same issue and reach the same conclusion), and no
      // retry-with-fresh-sandbox — the blocker is a missing human artifact,
      // not anything the loop can produce.
      readonly type: "NEEDS-UI-PROTOTYPE";
      readonly uiImpact: string;
      // As NEEDS-INFO above, and the case is sharper here: #21 accepts a LATE
      // escalation precisely so an agent that has already written code can stop,
      // and finalize pushes the branch when it has commits. Off the branch it
      // has none to push, so without this the partial work vanishes unrecorded.
      readonly strandedHead: HeadMismatch | null;
    }
  | {
      // Impl-attempt budget exhausted. `cause` names the real blocker so the
      // human-handoff message is accurate (#17):
      //   gate-red — ran out of attempts with the last gate failing, or never
      //     reaching a green gate; `failureTrace` carries the gate trace.
      //   reviewer-blocked — ran out of attempts while the gate was GREEN and
      //     the reviewer's last verdict was CHANGES-REQUESTED;
      //     `latestReviewerProse` carries that report (so the human is pointed
      //     at the reviewer request, not a non-existent failing test).
      //   uncommittable-worktree — the implementer reported COMPLETE over a
      //     dirty tree and a further attempt left the dirty set UNCHANGED, so
      //     it is something the agent cannot remove (a file written by a gate
      //     container under another uid, a step's non-gitignored exhaust).
      //     `failureTrace` carries the paths. Distinct from gate-red because
      //     no gate ever ran.
      //   off-branch-head — the implementer committed somewhere other than
      //     `refs/heads/<branch>` (detached HEAD, or a branch of its own) and a
      //     second consecutive attempt was still off it (#27). `failureTrace`
      //     carries where HEAD actually is, which is the only handle anyone has
      //     on the stranded commits once the worktree is removed.
      //   reviewer-harness-failed — gate-1 was green and the reviewer produced no
      //     review at all, twice running (#41). `failureTrace` carries why each
      //     invocation yielded nothing. Distinct from reviewer-blocked because the
      //     code was never judged: there is no CHANGES-REQUESTED to act on, and the
      //     thing to fix is the harness. `latestReviewerProse` is whatever an
      //     EARLIER round said, if any — never the harness error.
      readonly type: "NEEDS-HUMAN";
      readonly cause:
        | "gate-red"
        | "reviewer-blocked"
        | "uncommittable-worktree"
        | "off-branch-head"
        | "reviewer-harness-failed";
      readonly failureTrace: string;
      readonly latestReviewerProse: string | null;
      // Set only by `off-branch-head`, so finalize can render the rescue note
      // from structure rather than parse it back out of the trace prose.
      readonly strandedHead: HeadMismatch | null;
    }
  | {
      readonly type: "NEEDS-HUMAN-REVIEW";
      readonly latestReviewerProse: string;
    }
  | { readonly type: "HARD-ERROR"; readonly reason: string };

export type LoopAction =
  | {
      readonly kind: "run-implementer";
      readonly attempt: number;
      readonly failureTrace: string;
      readonly extraReprompt: string | null;
      readonly latestReviewerProse: string | null;
    }
  | { readonly kind: "run-gate-1"; readonly attempt: number }
  | {
      readonly kind: "run-reviewer";
      readonly attempt: number;
      readonly reviewRound: number;
    }
  | { readonly kind: "terminate"; readonly verdict: Verdict };

export type LoopEvent =
  | {
      readonly kind: "implementer-result";
      readonly signal: ParseSignal;
      // `git status --porcelain` lines in the issue worktree after the attempt
      // (#24 D1). A COMPLETE claim over a dirty tree is not a claim about any
      // commit — the gate bind-mounts this worktree, so gating it would produce
      // a verdict the merger cannot reproduce from the branch.
      readonly dirtyPaths: readonly string[];
      // Where HEAD is, when it is not `refs/heads/<branch>`; null when it is
      // (#27). A clean tree says nothing about this — that is the whole gap.
      readonly offBranch: HeadMismatch | null;
    }
  | {
      readonly kind: "gate-1-result";
      readonly ok: boolean;
      readonly failureTrace: string;
    }
  | {
      readonly kind: "reviewer-result";
      readonly verdict: "APPROVED" | "CHANGES-REQUESTED";
      readonly prose: string;
    }
  | {
      // The reviewer was invoked its full invocation budget and none of the runs
      // produced a review (#41). NOT a verdict — see the module header for what
      // that changes. `detail` says why each invocation yielded nothing; it is
      // diagnostics, never prose attributed to the reviewer.
      readonly kind: "reviewer-harness-failed";
      readonly detail: string;
    };

export type StepResult = {
  readonly state: LoopState;
  readonly action: LoopAction;
};

export type InitialStateOptions = {
  readonly maxAttempts: number;
  readonly maxReviewRounds: number;
};

export function initialState(opts: InitialStateOptions): LoopState {
  if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) {
    throw new Error(
      `maxAttempts must be a positive integer, got ${opts.maxAttempts}`,
    );
  }
  if (!Number.isInteger(opts.maxReviewRounds) || opts.maxReviewRounds < 1) {
    throw new Error(
      `maxReviewRounds must be a positive integer, got ${opts.maxReviewRounds}`,
    );
  }
  return {
    maxAttempts: opts.maxAttempts,
    maxReviewRounds: opts.maxReviewRounds,
    attempt: 1,
    reviewRoundsUsed: 0,
    lastFailureTrace: "",
    extraReprompt: null,
    latestReviewerProse: null,
    lastDirtyPaths: null,
    lastOffBranch: false,
    lastReviewerHarnessFailed: false,
    phase: "needs-implementer",
  };
}

export function initialAction(state: LoopState): LoopAction {
  return {
    kind: "run-implementer",
    attempt: state.attempt,
    failureTrace: state.lastFailureTrace,
    extraReprompt: state.extraReprompt,
    latestReviewerProse: state.latestReviewerProse,
  };
}

export function step(state: LoopState, event: LoopEvent): StepResult {
  if (state.phase === "terminated") {
    throw new Error("inner-loop machine stepped after termination");
  }

  switch (event.kind) {
    case "implementer-result":
      if (state.phase !== "needs-implementer") {
        throw new Error(
          `implementer-result event in phase ${state.phase}; expected needs-implementer`,
        );
      }
      return onImplementerResult(
        state,
        event.signal,
        event.dirtyPaths,
        event.offBranch,
      );

    case "gate-1-result":
      if (state.phase !== "needs-gate-1") {
        throw new Error(
          `gate-1-result event in phase ${state.phase}; expected needs-gate-1`,
        );
      }
      return onGate1Result(state, event.ok, event.failureTrace);

    case "reviewer-result":
      if (state.phase !== "needs-reviewer") {
        throw new Error(
          `reviewer-result event in phase ${state.phase}; expected needs-reviewer`,
        );
      }
      return onReviewerResult(state, event.verdict, event.prose);

    case "reviewer-harness-failed":
      if (state.phase !== "needs-reviewer") {
        throw new Error(
          `reviewer-harness-failed event in phase ${state.phase}; expected needs-reviewer`,
        );
      }
      return onReviewerHarnessFailed(state, event.detail);
  }
}

// How many dirty paths to name before eliding. The list is a prompt to an
// agent that can run `git status` itself; twenty is enough to make the problem
// concrete without spending the context window on it.
const MAX_DIRTY_PATHS_SHOWN = 20;

// The re-prompt for a COMPLETE claim over a dirty worktree (#24 D1). Exported
// so the wording is asserted where the routing is.
export function uncommittedWorkReprompt(
  dirtyPaths: readonly string[],
): string {
  const shown = dirtyPaths.slice(0, MAX_DIRTY_PATHS_SHOWN);
  const elided = dirtyPaths.length - shown.length;
  return [
    "You reported COMPLETE, but the worktree still has uncommitted changes, so",
    "there is no commit that means what you said. The gate runs against this",
    "worktree and the merger will only ever see your commits — anything left",
    "uncommitted is invisible to it and would be lost.",
    "",
    "`git status --porcelain` reports:",
    ...shown.map((p) => `  ${p}`),
    ...(elided > 0 ? [`  … and ${elided} more`] : []),
    "",
    "Commit the work that belongs to this issue (or remove what does not), then",
    "report COMPLETE again. Note that build artifacts your gate steps produce",
    "must be gitignored — if they are showing up here, that is the bug to fix.",
  ].join("\n");
}

// The re-prompt for a HEAD that is not the issue branch (#27). Exported so the
// wording is asserted where the routing is, and reused verbatim as the
// NEEDS-HUMAN trace — the shas in it are the only handle on the stranded
// commits once the worktree (and its HEAD reflog) is removed.
//
// It deliberately does NOT tell the agent to run `git branch -f` unconditionally.
// Nothing here has inspected the two histories: if HEAD was detached at an OLDER
// commit, or the branch carries commits from an earlier attempt that HEAD does
// not, forcing the ref silently drops them — trading a visible failure for an
// invisible one. That is the same reason the orchestrator does not move the ref
// itself: it would be rewriting history it never authored, on evidence it never
// gathered.
export function offBranchHeadReprompt(m: HeadMismatch): string {
  const where =
    m.headRef === null
      ? `HEAD is DETACHED at ${m.headSha}`
      : `HEAD is on \`${m.headRef}\`, at ${m.headSha}`;
  return [
    `You are not on the issue branch. ${where}, but this issue's branch is`,
    `\`${m.branch}\`, still at ${m.branchSha ?? "(the branch does not exist)"}.`,
    "",
    "Any commit you made is therefore not on `" + m.branch + "`. The merger only",
    "ever reads that branch, so as things stand your work would be silently",
    "dropped and the issue closed with nothing landed.",
    "",
    "Get back onto `" + m.branch + "` with your commits on it:",
    "  - If `" + m.branch + "` is an ancestor of your current HEAD, nothing is at",
    "    risk: `git branch -f " + m.branch + " HEAD && git checkout " + m.branch + "`.",
    "  - Otherwise do NOT force the ref — it would discard whatever is on the",
    "    branch that your HEAD does not have. Check the branch out and bring your",
    "    commits over with `git cherry-pick` or `git merge`.",
    "",
    "Verify with `git rev-parse --symbolic-full-name HEAD` before you report",
    "again. Do not report COMPLETE until that prints `refs/heads/" + m.branch + "`.",
  ].join("\n");
}

// The orchestrator note for an attempt whose review round produced no review
// (#41). Exported so the wording is asserted where the routing is.
//
// It goes in the ORCHESTRATOR NOTE slot, not the reviewer-feedback slot, and
// that is the whole point of the terminal: the previous behaviour handed the
// implementer `reviewer run errored: Agent idle for 600 seconds` under a
// "Previous reviewer feedback (CHANGES-REQUESTED)" heading, so an agent whose
// work had just passed a green gate was told it had been reviewed and rejected,
// by a reviewer that never read a line of it. This note therefore says three
// things and no more: what happened, that nothing was said about the code THIS
// ROUND, and that the green gate still stands.
//
// Every claim it makes is scoped to this round, and that scoping is the whole
// of its correctness. `latestReviewerProse` is carried forward untouched, so
// `renderAttemptSlot` may well render an EARLIER round's real report directly
// above this note, under an "Address the reviewer's concerns" imperative. A
// note saying there is no reviewer feedback above would then be false — and
// handing an implementer a false statement about what the reviewer said is the
// thing this issue exists to stop, moved one slot over. So the note names the
// two cases explicitly rather than asserting either.
//
// It deliberately quotes NONE of the harness detail. The detail names an idle
// timeout in seconds and a podman exec — an implementer cannot act on any of it
// from inside its sandbox, and an agent handed a failure it cannot fix will
// try anyway. That text goes to the run log and, if this recurs, to the human
// handoff, which are the two places someone can do something with it.
export function reviewerHarnessFailedReprompt(): string {
  return [
    "The code reviewer could not be run this round: every invocation returned",
    "no review at all. That is a fault in the orchestrator's harness, not a",
    "finding about your work — nothing was said about your code this round, and",
    "no review round was charged for it.",
    "",
    "Gate-1 passed on your last commit, and that verdict stands. Do not rework",
    "or revert anything on the strength of this note. There is no NEW reviewer",
    "feedback: if a \"Previous reviewer feedback\" section appears above, it is an",
    "earlier round's, it still stands, and it is still what to address. If none",
    "appears, no reviewer has said anything about this branch at all.",
    "",
    "Use this attempt for whatever you already knew was outstanding. If the work",
    "is genuinely finished, confirm the worktree is clean and every commit is on",
    "the issue branch, then report COMPLETE again so the reviewer can be retried.",
  ].join("\n");
}

// Order-insensitive: `git status --porcelain` order is stable in practice, but
// "the same files are still dirty" is the question being asked, and a reordering
// is not progress.
function sameDirtySet(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((p) => seen.has(p));
}

function onImplementerResult(
  state: LoopState,
  signal: ParseSignal,
  dirtyPaths: readonly string[],
  offBranch: HeadMismatch | null,
): StepResult {
  // These two hand the issue to a human and land nothing, so they are exempt
  // from the off-branch correction below (re-prompting would risk spending the
  // budget on a question the agent had already formed, and would swap a precise
  // handoff — the question, the UI assessment — for a generic one). They carry
  // the mismatch instead, so the commits the agent stranded are named in the
  // handoff rather than deleted in silence.
  if (signal.kind === "NEEDS-INFO") {
    return terminate(state, {
      type: "NEEDS-INFO",
      questions: signal.questions,
      strandedHead: offBranch,
    });
  }
  if (signal.kind === "NEEDS-UI-PROTOTYPE") {
    return terminate(state, {
      type: "NEEDS-UI-PROTOTYPE",
      uiImpact: signal.uiImpact,
      strandedHead: offBranch,
    });
  }
  // #27 — before anything that treats this attempt's work as real. A detached
  // HEAD leaves a CLEAN tree, so the dirty check below cannot see it, and the
  // gate would go green on a tree `refs/heads/<branch>` does not contain.
  //
  // ONE re-prompt, then terminate — and the asymmetry with the dirty-set rule
  // above is deliberate. There, "the same paths are still dirty" is what proves
  // the agent cannot win, because partial progress is possible and worth waiting
  // for. Here there is no partial progress: either HEAD is the branch or it is
  // not, and the corrective is two mechanical git commands that were spelled out
  // in full. An attempt that had those instructions and is still off the branch
  // is not one that needs another go — and each further attempt buries the
  // stranded commits under more stranded commits. Note the test is on the
  // PREVIOUS attempt having been off-branch, not on it having been off-branch in
  // the same PLACE: a new detached sha is not progress toward being on the
  // branch, so comparing positions would let an agent grind the whole budget by
  // committing again.
  if (offBranch !== null) {
    const trace = offBranchHeadReprompt(offBranch);
    const exhausted: Verdict = {
      type: "NEEDS-HUMAN",
      cause: "off-branch-head",
      failureTrace: trace,
      latestReviewerProse: state.latestReviewerProse,
      strandedHead: offBranch,
    };
    if (state.lastOffBranch) return terminate(state, exhausted);
    return advanceAttempt(
      state,
      {
        // Becomes the NEEDS-HUMAN trace if this was the last attempt, so the
        // handoff names where the commits went rather than a gate that never ran.
        failureTrace: trace,
        extraReprompt: trace,
        latestReviewerProse: state.latestReviewerProse,
        offBranch: true,
      },
      exhausted,
    );
  }
  if (signal.kind === "COMPLETE") {
    // Dirty tree: another attempt with "commit your work", NOT the gate. Cheaper
    // than letting the gate refuse (no attempt containers get built) and far
    // more actionable than a red verdict, and it is the only routing that keeps
    // the forgotten `git add` — the overwhelmingly common cause — rather than
    // letting a `git clean` destroy it.
    if (dirtyPaths.length > 0) {
      const trace = uncommittedWorkReprompt(dirtyPaths);
      // An attempt that was told to commit and came back with the IDENTICAL
      // dirty set did not fail to try — it cannot succeed. The realistic causes
      // are all outside the implementer's reach: a file a gate container wrote
      // as a uid the sandbox user cannot unlink, a path an issue-lifecycle
      // container keeps recreating, a gate step's non-gitignored exhaust.
      // Without this check every one of the remaining attempts is a full agent
      // run ending in the same reprompt, and the budget dies pointing at a gate
      // that never ran.
      if (
        state.lastDirtyPaths !== null &&
        sameDirtySet(state.lastDirtyPaths, dirtyPaths)
      ) {
        return terminate(state, {
          type: "NEEDS-HUMAN",
          cause: "uncommittable-worktree",
          failureTrace: trace,
          latestReviewerProse: state.latestReviewerProse,
          strandedHead: null,
        });
      }
      return advanceAttempt(
        state,
        {
          // Becomes the NEEDS-HUMAN trace if the budget runs out here, so the
          // human gets the paths rather than "budget exhausted with no green
          // gate" for a run in which the gate never executed.
          failureTrace: trace,
          extraReprompt: trace,
          latestReviewerProse: state.latestReviewerProse,
          dirtyPaths,
        },
        // Built from the dirty trace, not from state.lastFailureTrace: the gate
        // never ran on this route, so the generic "budget exhausted with no
        // green gate" would describe a failure that did not happen.
        {
          type: "NEEDS-HUMAN",
          cause: "uncommittable-worktree",
          failureTrace: trace,
          latestReviewerProse: null,
          strandedHead: null,
        },
      );
    }
    return {
      state: {
        ...state,
        phase: "needs-gate-1",
        extraReprompt: null,
        lastDirtyPaths: null,
        lastOffBranch: false,
      },
      action: { kind: "run-gate-1", attempt: state.attempt },
    };
  }
  // NO-SIGNAL — either re-prompt for next attempt or exhaust the budget. The
  // implementer didn't reach a green gate this attempt, so exhaustion here is
  // the gate-red flavour.
  return advanceAttempt(
    state,
    {
      failureTrace: state.lastFailureTrace,
      extraReprompt: signal.reprompt ?? null,
      latestReviewerProse: state.latestReviewerProse,
    },
    gateRedExhaustion(state),
  );
}

function onGate1Result(
  state: LoopState,
  ok: boolean,
  failureTrace: string,
): StepResult {
  if (ok) {
    return {
      state: { ...state, phase: "needs-reviewer" },
      action: {
        kind: "run-reviewer",
        attempt: state.attempt,
        reviewRound: state.reviewRoundsUsed + 1,
      },
    };
  }
  const advanced = { ...state, lastFailureTrace: failureTrace };
  return advanceAttempt(
    advanced,
    {
      failureTrace,
      extraReprompt: null,
      latestReviewerProse: state.latestReviewerProse,
    },
    gateRedExhaustion(advanced),
  );
}

function onReviewerResult(
  state: LoopState,
  verdict: "APPROVED" | "CHANGES-REQUESTED",
  prose: string,
): StepResult {
  const reviewRoundsUsed = state.reviewRoundsUsed + 1;
  if (verdict === "APPROVED") {
    return terminate({ ...state, reviewRoundsUsed }, { type: "DONE" });
  }
  // CHANGES-REQUESTED. If the review-round budget is now exhausted, surface
  // NEEDS-HUMAN-REVIEW with the latest prose. Otherwise dispatch another
  // implementer attempt carrying the prose (and clearing the gate trace —
  // gate-1 was green this attempt).
  if (reviewRoundsUsed >= state.maxReviewRounds) {
    return terminate(
      { ...state, reviewRoundsUsed, latestReviewerProse: prose },
      { type: "NEEDS-HUMAN-REVIEW", latestReviewerProse: prose },
    );
  }
  // Gate was green this attempt; the reviewer is the blocker. If the impl-attempt
  // budget is exhausted here, surface that — gate green, reviewer rejected (#17).
  return advanceAttempt(
    {
      ...state,
      reviewRoundsUsed,
      latestReviewerProse: prose,
      lastFailureTrace: "",
    },
    { failureTrace: "", extraReprompt: null, latestReviewerProse: prose },
    {
      type: "NEEDS-HUMAN",
      cause: "reviewer-blocked",
      failureTrace: "",
      latestReviewerProse: prose,
      strandedHead: null,
    },
  );
}

// The reviewer produced no review at all (#41). Gate-1 was green to get here,
// so this attempt's work is not in question and nothing about it is being
// charged: the review round is NOT consumed and `latestReviewerProse` keeps
// whatever an earlier round actually said.
//
// Note the impl attempt IS consumed, and that is the residual this terminal
// accepts rather than hides. The alternative — re-dispatching the reviewer from
// here — is an unbounded loop against a component that has just failed twice,
// bounded by nothing the SM can see; one more implementer attempt at least does
// real work and re-reaches the reviewer through a fresh gate. The
// second-consecutive rule below is what keeps the price at two attempts.
function onReviewerHarnessFailed(state: LoopState, detail: string): StepResult {
  const exhausted: Verdict = {
    type: "NEEDS-HUMAN",
    cause: "reviewer-harness-failed",
    failureTrace: detail,
    // An earlier round's real report, if there was one. Never `detail` — the
    // handoff renders this as the reviewer speaking.
    latestReviewerProse: state.latestReviewerProse,
    strandedHead: null,
  };
  if (state.lastReviewerHarnessFailed) return terminate(state, exhausted);
  return advanceAttempt(
    // Gate-1 was green this attempt, so there is no gate trace to carry: an
    // older red would be re-shown to the implementer as if it were this
    // attempt's, the same way onReviewerResult clears it.
    { ...state, lastFailureTrace: "" },
    {
      failureTrace: "",
      extraReprompt: reviewerHarnessFailedReprompt(),
      latestReviewerProse: state.latestReviewerProse,
      reviewerHarnessFailed: true,
    },
    exhausted,
  );
}

// The gate-red flavour of impl-budget exhaustion: surface the last recorded
// gate trace, or the sentinel when no gate ever ran (NO-SIGNAL only).
function gateRedExhaustion(state: LoopState): Verdict {
  return {
    type: "NEEDS-HUMAN",
    cause: "gate-red",
    failureTrace: state.lastFailureTrace || NEEDS_HUMAN_BUDGET_EXHAUSTED_MESSAGE,
    latestReviewerProse: null,
    strandedHead: null,
  };
}

function advanceAttempt(
  state: LoopState,
  next: {
    readonly failureTrace: string;
    readonly extraReprompt: string | null;
    readonly latestReviewerProse: string | null;
    // Carried only by the COMPLETE-over-a-dirty-tree route, so the next
    // attempt can tell "still dirty in a new way" from "changed nothing".
    // Every other route clears it.
    readonly dirtyPaths?: readonly string[];
    // Same shape for #27: only the off-branch route sets it, so "the previous
    // attempt was told to get back on the branch" stays a statement about the
    // attempt immediately before this one.
    readonly offBranch?: boolean;
    // And for #41: only the harness-failure route sets it, so two failures with
    // a real verdict or a gate red between them do not read as consecutive.
    readonly reviewerHarnessFailed?: boolean;
  },
  // The verdict to emit if this attempt was the last. Caller-supplied because
  // only the caller knows the terminal cause: a gate-red trace vs. a green-gate
  // reviewer rejection (#17).
  onExhausted: Verdict,
): StepResult {
  if (state.attempt >= state.maxAttempts) {
    return terminate(state, onExhausted);
  }
  const newAttempt = state.attempt + 1;
  const ns: LoopState = {
    ...state,
    attempt: newAttempt,
    phase: "needs-implementer",
    extraReprompt: next.extraReprompt,
    latestReviewerProse: next.latestReviewerProse,
    lastDirtyPaths: next.dirtyPaths ?? null,
    lastOffBranch: next.offBranch ?? false,
    lastReviewerHarnessFailed: next.reviewerHarnessFailed ?? false,
  };
  return {
    state: ns,
    action: {
      kind: "run-implementer",
      attempt: newAttempt,
      failureTrace: next.failureTrace,
      extraReprompt: next.extraReprompt,
      latestReviewerProse: next.latestReviewerProse,
    },
  };
}

function terminate(state: LoopState, verdict: Verdict): StepResult {
  return {
    state: { ...state, phase: "terminated" },
    action: { kind: "terminate", verdict },
  };
}

// Outer-layer decision: should the runner re-create the sandbox and run the
// machine again, or surface this verdict? Crosses the sandbox lifecycle
// boundary so it lives outside the in-sandbox SM. Pure for testability.
export type RetryDecision =
  | { readonly kind: "retry-with-fresh-sandbox"; readonly nextRetriesUsed: number }
  | { readonly kind: "surface" };

export function decideAfterTerminal(
  verdict: Verdict,
  retriesUsed: number,
  maxRetries: number = HARD_ERROR_MAX_RETRIES,
): RetryDecision {
  if (verdict.type !== "HARD-ERROR") return { kind: "surface" };
  if (retriesUsed >= maxRetries) return { kind: "surface" };
  return { kind: "retry-with-fresh-sandbox", nextRetriesUsed: retriesUsed + 1 };
}
