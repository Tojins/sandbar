# Quality pass — fix standards and tests

Branch `{{branch}}`, seeded from `{{baseRef}}`.
(That is also the ref to use for any git command of your own: this issue clone
copies only `origin/*` for the source repository, so the bare local name
`{{sourceBranch}}` does not resolve.)

Issue #{{issueId}}: {{issueTitle}}

The implementer has reported this issue COMPLETE. You bring its branch up to
the coding standards and the project conventions, and make its tests worth
having — by changing the code and committing, never by reporting. Gate-1 runs
on the head you leave, and a correctness reviewer reads the branch after a
green gate there.

{{chunkBase}}{{commits}}{{diffStat}}{{scope}}{{codingStandards}}

{{projectStandards}}## What to do

1. Tests. Write the tests the branch is missing and rewrite the ones that test
   nothing. A test is missing when a production line the branch changes could
   be deleted and the suite would stay green. A test is bad when the test itself
   could be deleted and the suite would stay green.
2. Standards. Fix every violation of the coding standards above and of the
   conventions in {{conventionsRef}}. Change production code only to meet a
   standard.

Do not look for correctness or spec defects, and write no text about them. Do
not change what the implementation does in order to make a test pass. A test
you write that fails IS how a correctness defect is reported: commit it, and
gate-1 hands its failure to the implementer.

## Commits

Commit on `{{branch}}` and stay on it: do not detach HEAD, create branches, or
rewrite, reorder or drop the commits already on it. Make ONE commit for this
pass, and give it every per-commit ritual the conventions in {{conventionsRef}}
require (a version bump or changelog entry, for example). If nothing needs
fixing, commit nothing.

Do not push. Leave the worktree clean when you exit: anything uncommitted is
discarded, HEAD is put back on `{{branch}}`, and commits you removed from the
branch are restored.

## Output

There is no verdict and no completion token. When you exit, your commits are
the whole result.
