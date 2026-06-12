# Attempt {{attempt}} of {{maxAttempts}}

Fix issue #{{issueId}}: {{issueTitle}}
Branch: {{branch}}

{{workDone}}{{gateFailure}}{{reviewerFeedback}}{{orchestratorNote}}{{escalation}}## Commit discipline

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
