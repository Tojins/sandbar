# Review — tests and standards

Review the implementation on branch `{{branch}}` against `{{baseRef}}` — the ref
this branch was seeded from.
(That is also the ref to use for any git command of your own: this issue clone
copies only `origin/*` for the source repository, so the bare local name
`{{sourceBranch}}` does not resolve.)

Issue #{{issueId}}: {{issueTitle}}

{{chunkBase}}{{commits}}{{diff}}{{priorRounds}}{{qualityMode}}{{changedSinceDiff}}{{codingStandards}}

{{projectStandards}}## Review process

This is the first of the round's two passes. A correctness pass follows it, and
only if you approve. Review these two dimensions, in order:

1. Test quality and coverage. A test finding must name a line whose deletion
   leaves the suite green: either a production line no test covers, or a test
   line whose deletion changes nothing.
2. Project standards: the coding standards above plus the conventions in
   {{conventionsRef}}.

Do not search for correctness or spec defects: the pass after this one owns
whether the implementation works and whether it delivers what the issue asks.
If you independently notice a concrete correctness defect while checking these
dimensions, however, report it under `### Correctness` and request changes.

For each finding in the prior-round history from your tests and project
standards dimensions, state whether it is addressed at this head; an
unaddressed one blocks.

A change requested in an earlier round may not be reversed without naming that
round and explaining why its request was wrong.

Your role is strictly advisory: you must not modify the branch.
Do not run any command that writes under `.git` (including commit, checkout,
reset, branch, worktree, gc, or prune), do not modify files, push, or run gate
commands. Read-only investigation only.

If a dimension requests changes, put only its actionable findings under its
exact heading: `### Correctness`, `### Tests`, or `### Standards`.
Omit headings for dimensions that pass. `### Non-blocking` is allowed only
where the instructions above explicitly permit it.

## Verdict

Your output is only the actionable findings the instructions above allow under
their exact headings, followed by the verdict token. Do not include a summary,
what you checked, other observations, or a restatement of the change. When
approving, emit the verdict token alone.

End your review with a single verdict token on its own:

- `<verdict>APPROVED</verdict>` — both dimensions meet the bar.
- `<verdict>CHANGES-REQUESTED</verdict>` — at least one dimension has actionable
  findings under its heading above.

A missing verdict is a failed reviewer invocation and will be retried. Emit exactly one verdict.
