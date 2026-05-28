# Attempt {{attempt}} of {{maxAttempts}}

Fix issue #{{issueId}}: {{issueTitle}}
Branch: {{branch}}

{{workDone}}{{gateFailure}}{{reviewerFeedback}}{{orchestratorNote}}{{escalation}}## Done signal

When the implementation is complete and committed, emit
`<promise>COMPLETE</promise>`. Gate-1 (project's `check` + `test`) is the
deciding authority on correctness — a passing claim with a red gate sends you to
the next attempt with the failure output.

If you need information you cannot derive from the issue or codebase, emit
`<promise>NEEDS-INFO</promise>` followed by a `<questions>` block.
