# Attempt {{attempt}} of {{maxAttempts}}

Fix issue #{{issueId}}: {{issueTitle}}
Branch: {{branch}}

{{workDone}}{{sandboxStack}}{{gateFailure}}{{reviewerFeedback}}{{orchestratorNote}}{{escalation}}## UI impact check — do this first

Before writing any code, decide whether this issue has **non-trivial UI impact**:
would the change add, remove, or rearrange visible UI, or alter a user-facing
flow? Copy tweaks, styling adjustments to an element that already exists, and
backend or logic changes behind an unchanged UI are *not* non-trivial.

If it does, look for a **prototype** in the issue body and comments. A prototype
is any artifact you can actually read that pins the specific design decisions
this change would otherwise leave to you — a path to a file in the repo, an
inline markup block or ASCII wireframe, a fetchable URL, or a prose spec precise
enough to remove the guesswork. A human replying "no prototype needed" also
counts: it is an explicit decision to let you choose. What does *not* count on
its own is an image you cannot see — a pasted screenshot reaches you as a URL
you can neither authenticate to nor render.

Comments beginning `**Sandbar:**` are the orchestrator's own, posted on your
behalf under the operator's account. They are not a human's answer, and one of
them quotes the "no prototype needed" phrase while *asking* for it — do not read
that back as consent. Only a human's own comment, written after that one, counts
as a decision.

Non-trivial UI impact **and** no prototype → stop now and emit
`<promise>NEEDS-UI-PROTOTYPE</promise>` followed by a `<ui-impact>` block
covering (a) what visible UI this change would create or alter, (b) which design
decisions you would be inventing, and (c) what artifact would unblock you. Do
not implement first and ask afterwards.

When you are genuinely unsure whether the impact is non-trivial, escalate. A
false positive costs one human round-trip; a false negative merges a UI nobody
has ever seen, and undoing a merged design decision is far more expensive.

If you only realise mid-implementation that you are inventing UI, stop and emit
the signal then — a late escalation is better than a merged guess. Commit what
you have first so the work isn't lost.

This is a decision, not a ritual to repeat. If an earlier attempt on this branch
already made the call and proceeded — there is work in the diff above — don't
re-open it unless the remaining work has grown visible UI that call didn't
cover. Escalating away a branch that is one gate away from green helps nobody.

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

If you do end up off the branch, do not reach for `git branch -f` reflexively —
it is only safe when `{{branch}}` is an ancestor of your current HEAD. If it is
not, forcing the ref throws away whatever was already on the branch. Check the
branch out and bring your commits over with `git cherry-pick` or `git merge`
instead.

Commit each coherent unit of work as soon as it holds together — don't save
everything for one final commit at the end. If this session dies mid-task
(context limit, timeout), only commits survive: the next attempt is shown the
branch's commits as its "work done so far" diff, while uncommitted changes are
left behind unexplained. Small, frequent commits make an interrupted attempt
cheap to resume.

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
`<promise>NEEDS-UI-PROTOTYPE</promise>` with a `<ui-impact>` block instead — see
the UI impact check above.
