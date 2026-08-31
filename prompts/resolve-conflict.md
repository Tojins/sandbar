A `git merge --no-ff` of this branch into {{target}} is in progress and has hit
a conflict.

{{digest}}

Resolve every conflict, `git add` the files, and `git commit --no-edit` to
complete the merge. The orchestrator will then run the project's gate steps
against the result. Leave nothing uncommitted: the gate refuses to run against a
dirty tree, because a verdict about it would not be a verdict about any commit.

If a `version` field in `package.json` or `package-lock.json` is still
conflicted, the answer is one patch bump ABOVE the higher of the two sides —
never either side's own value, since every commit here moves the version and the
merge result must carry one nobody has used. Keep both files on that same value.
