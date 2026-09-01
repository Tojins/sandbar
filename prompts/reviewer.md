# Review

Review the implementation on branch `{{branch}}` against `{{baseRef}}` — the ref
this branch was seeded from.
(That is also the ref to use for any git command of your own: this worktree comes
from a bare object cache that holds no local `{{sourceBranch}}`, so the bare name
does not resolve.)

Issue #{{issueId}}: {{issueTitle}}

{{chunkBase}}{{commits}}{{diff}}## Review process

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

Your role is strictly advisory. You must not modify the branch. Do not commit,
push, or run gate commands. Read-only investigation only.

## Verdict

End your review with a single verdict token on its own:

- `<verdict>APPROVED</verdict>` — branch meets the bar, ship it.
- `<verdict>CHANGES-REQUESTED</verdict>` — list the correctness defects above and
  the implementer will address them in the next round.

A missing verdict defaults to CHANGES-REQUESTED. Emit exactly one verdict.
