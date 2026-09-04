# Review

Review the implementation on branch `{{branch}}` against `{{baseRef}}` — the ref
this branch was seeded from.
(That is also the ref to use for any git command of your own: this issue clone
copies only `origin/*` for the source repository, so the bare local name
`{{sourceBranch}}` does not resolve.)

Issue #{{issueId}}: {{issueTitle}}

{{chunkBase}}{{commits}}{{diff}}{{priorRounds}}## Review process

Gate-1 is green and this round's tests-and-standards pass has already approved.
Review these two dimensions, using the project conventions in
{{conventionsRef}} to understand the implementation's invariants and settled
choices:

1. Correctness of logic: does the implementation actually work? Look for
   correctness gaps the tests miss: edge cases, off-by-one errors, broken error
   paths, concurrency hazards, and other state hazards.
2. Spec conformance: compare the issue body to the branch, including missing
   requirements and scope creep. An unmet requirement blocks wherever it is.

Explicitly exclude style, coding standards, test-quality, and test-coverage
judgments from this pass — the pass before it owns them. A change request must
name the defect's location, explain the concrete failure, and state the change
that clears it. Do not block on speculation or preference: if you cannot name a
concrete defect on either dimension, APPROVE.

For each finding in the prior-round history from your correctness and spec
dimensions, state whether it is addressed at this head; an unaddressed one
blocks. Then review this branch as you would with no history at all. The history
does not narrow what you may find or make new defects non-blocking.

A change requested in an earlier round may not be reversed without naming that
round and explaining why its request was wrong.

Your role is strictly advisory. You must not modify the branch.
Do not run any command that writes under `.git` (including commit, checkout,
reset, branch, worktree, gc, or prune), do not modify files, push, or run gate
commands. Read-only investigation only.

If a dimension requests changes, put only its actionable findings under its
exact heading: `### Correctness` or `### Spec`. Omit the heading of a dimension
that passes.

When, and only when, a fundamental implementation error was caused by a question
the issue and project conventions do not answer, declare the missing decision in
one optional free-text `<spec-gap>` block containing the unanswered question,
followed by the answer this review applied.

This is rare: issue vagueness alone is not a gap, nor is a finding whose answer
the issue or conventions already determine. The answer is yours to decide; the
block records that decision and never asks a human to make it. Prior review
rounds and the issue's comments contain earlier records. Do not repeat one that
has already been recorded. Emit at most one block, immediately before the
verdict token; when several missing decisions caused the same fundamental error,
record them together in that block.

## Verdict

Your output is only the blocking findings under their exact headings, an optional
spec-gap block, and the verdict token. Do not include a summary, what you checked, non-blocking
observations, or a restatement of the change.
When approving, emit the verdict token alone on its line, after any spec-gap block.

End your review with a single verdict token on its own:

- `<verdict>APPROVED</verdict>` — branch meets the bar, ship it.
- `<verdict>CHANGES-REQUESTED</verdict>` — list the defects above and the
  implementer will address them in the next round.

A missing verdict is a failed reviewer invocation and will be retried. Emit exactly one verdict.
