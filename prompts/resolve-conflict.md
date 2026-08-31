A `git merge --no-ff` of this branch into {{target}} is in progress and has hit
a conflict.

{{digest}}

Resolve every conflict, `git add` the files, and `git commit --no-edit` to
complete the merge. The orchestrator will then run the project's gate steps
against the result. Leave nothing uncommitted: the gate refuses to run against a
dirty tree, because a verdict about it would not be a verdict about any commit.
