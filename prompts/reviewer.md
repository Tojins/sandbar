# Review

Review the implementation on branch `{{branch}}` against `{{baseRef}}` — the ref
this branch was seeded from.
(That is also the ref to use for any git command of your own: this worktree comes
from a bare object cache that holds no local `{{sourceBranch}}`, so the bare name
does not resolve.)

Issue #{{issueId}}: {{issueTitle}}

{{chunkBase}}{{commits}}{{diff}}## Review process

Review correctness of logic only: does the implementation actually work? Look
for edge cases, off-by-one errors, broken error handling, and state hazards.
Explicitly exclude style, coding standards, test-quality, and test-coverage
judgments from this pass. Your role is strictly advisory. You must not modify the branch.
Do not commit, push, or run gate commands. Read-only investigation only.

## Verdict

End your review with a single verdict token on its own:

- `<verdict>APPROVED</verdict>` — branch meets the bar, ship it.
- `<verdict>CHANGES-REQUESTED</verdict>` — list the correctness defects above and
  the implementer will address them in the next round.

A missing verdict defaults to CHANGES-REQUESTED. Emit exactly one verdict.
