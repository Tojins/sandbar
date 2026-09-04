This cycle's merge result is already on the source branch **locally**, and the
project's own gate steps passed against it. It has not been landed:
the merge result was pushed to a scratch integration branch and the forge's CI
disagreed.

Failing checks: {{failedChecks}}

## CI job output (failing steps)

{{trace}}

"The local gate is green" is not evidence against this failure. Read the job
output for what CI actually did differently before assuming the test is flaky.

Commit a fix on top of HEAD. The merge commits themselves stay in place; your
work is a follow-up commit. The orchestrator re-runs the local gate, then pushes
again and asks the forge again.

If the failure is a genuine contradiction between the branches merged in this
cycle, or needs a decision no code change can make, declare ABANDON with a
`<reason>` that names the colliding issues and which one should lose. Abandoning
here reverts the whole cycle's merges — none of the issues land — so use it only
when a fix genuinely isn't available.
