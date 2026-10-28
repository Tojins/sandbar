# Attempt {{attempt}}

Fix issue #{{issueId}}: {{issueTitle}}
Branch: {{branch}}

{{chunkBase}}{{workDone}}{{qualityCommits}}{{sandboxStack}}{{dbCopy}}{{stackFile}}{{egress}}{{gateFailure}}{{reviewerFeedback}}{{orchestratorNote}}{{escalation}}If you realise mid-implementation that you are inventing non-trivial visible UI
the initial check did not cover, commit what you have, then stop and emit
`<promise>NEEDS-UI-PROTOTYPE</promise>` followed by a `<ui-impact>` block. A
late escalation is better than a merged guess.

## Commit discipline

**Commit on `{{branch}}`, and stay on it.** Everything downstream reads that ref
and nothing else: the merger runs `git merge {{branch}}`, and a commit that is
not reachable from it does not exist as far as this system is concerned. Do not
detach HEAD and do not work on a branch of your own — a detached HEAD leaves the
worktree perfectly clean, so nothing about your session will look wrong while
every commit you make goes nowhere. If you need to look at another commit, use
`git show`/`git log` rather than checking it out. `git rev-parse
--symbolic-full-name HEAD` must print `refs/heads/{{branch}}`; that exact command
is what is checked after every attempt.

Commit each coherent unit of work as soon as it holds together — don't save
everything for one final commit at the end. If this session dies mid-task
(context limit, timeout), only commits survive: the next attempt is shown the
branch's commit list and diff stat, while uncommitted changes are
left behind unexplained. Small, frequent commits make an interrupted attempt
cheap to resume.

The following is the text the quality pass applies to this branch after you;
read it before writing as well as before promising. Your work is what these
standards are applied to.

{{codingStandards}}

{{projectStandards}}## Pre-promise review

Before emitting the done signal, inspect everything you are about to promise
with `git diff {{baseRef}}...HEAD` and `git log {{baseRef}}..HEAD`, then:

1. Check the diff against every coding standard above.
2. Re-read {{conventionsRef}} and update prose your commits falsified.
3. Check that the diff does not contradict settled choices recorded in those
   conventions.
4. Re-read the issue, list its stated requirements, tick each against the diff,
   and delete anything the issue did not ask for.
{{commitRitual}}
## The quality pass

After you report COMPLETE and before gate-1, a quality pass may commit
standards fixes and new or rewritten tests on top of your work; its commits carry
`(quality)` in their author name. They are part of the branch from then on:

- A failing test the quality pass added reports a correctness defect in your
  implementation. The fix is to make that test pass, not to delete it.
- Modify or delete a quality-pass test only when it contradicts the issue, and
  then name the test and the reason in that commit's message. The correctness
  reviewer judges that call.

## Done signal

When the implementation is complete and committed, emit
`<promise>COMPLETE</promise>`. Gate-1 (the project's gate steps, run against
your commits) is the deciding authority on correctness — a passing claim with a
red gate sends you to the next attempt with the failure output.

COMPLETE means the worktree is CLEAN: `git status` empty, everything committed.
The gate runs against this worktree and the merger only ever sees commits, so a
COMPLETE claim over uncommitted changes describes nothing that can be merged.
It is not gated — it costs you an attempt and comes straight back.

COMPLETE also means the commits are on `{{branch}}` — see commit discipline
above. That is checked too, and unlike the clean-tree check you get exactly one
correction: a second attempt still off the branch hands the issue to a human.

If you need information you cannot derive from the issue or codebase, emit
`<promise>NEEDS-INFO</promise>` followed by a `<questions>` block.

If the blocker is specifically a missing UI prototype, use
`<promise>NEEDS-UI-PROTOTYPE</promise>` with a `<ui-impact>` block instead.
