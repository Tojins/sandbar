# Quality pass — fix the quality report

Branch `{{branch}}`, seeded from `{{baseRef}}`.
(That is also the ref to use for any git command of your own: this issue clone
copies only `origin/*` for the source repository, so the bare local name
`{{sourceBranch}}` does not resolve.)

{{subject}}

The implementer has reported this issue COMPLETE, and a read-only quality
review of its branch reported the tests and standards findings below. You fix
them by changing the code and committing, never by reporting. A cold reviewer
then checks your commit against this report; gate-1 runs on the head you leave,
and the verifier reads the branch after a green gate there.

{{chunkBase}}{{commits}}{{diffStat}}{{standards}}

## Quality report

{{report}}

{{ruling}}## What to do

1. Read. Open the code each finding names, and read the branch's hunks around
   it with `git diff {{baseRef}}...HEAD -- <file>`.
2. Tests. Write the tests the report says are missing and rewrite the ones it
   says test nothing. A test is missing when a production line the branch
   changes could be deleted and the suite would stay green. A test is bad when
   the test itself could be deleted and the suite would stay green.
3. Standards. Fix each violation of the coding standards above and of the
   conventions in {{conventionsRef}} that the report names. Change production
   code only to meet a standard.

A finding that is wrong — the code already meets the standard it cites, or the
test it asks for exists — leave as it is; do not change code merely to quiet
it. A violation you find that the report missed, fix as well.

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

Your text output is not read. When you exit, your commits are the whole
result.
