# Attempt {{attempt}} of {{maxAttempts}}

Fix issue #{{issueId}}: {{issueTitle}}
Branch: {{branch}}

{{workDone}}{{gateFailure}}{{reviewerFeedback}}{{orchestratorNote}}{{escalation}}## UI impact check — do this first

Before writing any code, decide whether this issue has **non-trivial UI impact**:
would the change add, remove, or rearrange visible UI, or alter a user-facing
flow? Copy tweaks, styling adjustments to an element that already exists, and
backend or logic changes behind an unchanged UI are *not* non-trivial.

If it does, look for a **prototype** in the issue body and comments. A prototype
is any artifact you can actually read that pins the specific design decisions
this change would otherwise leave to you — a path to a file in the repo, an
inline markup block or ASCII wireframe, a fetchable URL, or a prose spec precise
enough to remove the guesswork. A human saying no prototype is needed also
counts: it is an explicit decision to let you choose. What does *not* count on
its own is an image you cannot see — a pasted screenshot reaches you as a URL
you can neither authenticate to nor render.

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

## Commit discipline

Commit each coherent unit of work as soon as it holds together — don't save
everything for one final commit at the end. If this session dies mid-task
(context limit, timeout), only commits survive: the next attempt is shown the
branch's commits as its "work done so far" diff, while uncommitted changes are
left behind unexplained. Small, frequent commits make an interrupted attempt
cheap to resume.

## Done signal

When the implementation is complete and committed, emit
`<promise>COMPLETE</promise>`. Gate-1 (project's `check` + `test`) is the
deciding authority on correctness — a passing claim with a red gate sends you to
the next attempt with the failure output.

If you need information you cannot derive from the issue or codebase, emit
`<promise>NEEDS-INFO</promise>` followed by a `<questions>` block.

If the blocker is specifically a missing UI prototype, use
`<promise>NEEDS-UI-PROTOTYPE</promise>` with a `<ui-impact>` block instead — see
the UI impact check above.
