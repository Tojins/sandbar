# Review

Review the implementation on branch `{{branch}}` against `{{baseRef}}` — the ref
this branch was seeded from.
(That is also the ref to use for any git command of your own: this issue clone
copies only `origin/*` for the source repository, so the bare local name
`{{sourceBranch}}` does not resolve.)

Issue #{{issueId}}: {{issueTitle}}

{{chunkBase}}{{commits}}{{diff}}{{priorRounds}}## Review process

Gate-1 is green. Review for concrete correctness defects that its checks may
miss, using the project conventions in {{conventionsRef}} to understand the
implementation's invariants and settled choices.

Review correctness of logic only: does the implementation actually work? Look
for correctness gaps the tests miss: edge cases, off-by-one errors, broken
error paths, concurrency hazards, and other state hazards.
Explicitly exclude style, coding standards, test-quality, and test-coverage
judgments from this pass. A change request must name the defect's location,
explain the concrete failure, and state the change that clears it. Do not block
on speculation or preference: if you cannot name a concrete correctness defect,
APPROVE.

For each finding in the prior-round history from your correctness dimension,
state whether it is addressed at this head; an unaddressed one blocks. Then
review this branch as you would with no history at all. The history does not
narrow what you may find or make new correctness defects non-blocking.

A change requested in an earlier round may not be reversed without naming that
round and explaining why its request was wrong.

Your role is strictly advisory. You must not modify the branch.
Do not run any command that writes under `.git` (including commit, checkout,
reset, branch, worktree, gc, or prune), do not modify files, push, or run gate
commands. Read-only investigation only.

## Verdict

Your output is only the blocking correctness findings followed by the verdict
token. Do not include a summary, what you checked, non-blocking observations, or
a restatement of the change. When approving, emit the verdict token alone.

End your review with a single verdict token on its own:

- `<verdict>APPROVED</verdict>` — branch meets the bar, ship it.
- `<verdict>CHANGES-REQUESTED</verdict>` — list the correctness defects above and
  the implementer will address them in the next round.

A missing verdict is a failed reviewer invocation and will be retried. Emit exactly one verdict.
