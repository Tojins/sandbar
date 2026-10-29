# Adjudication

Independently judge the rejected {{pass}} review report below against the code
at head `{{head}}` on branch `{{branch}}` (seeded from `{{baseRef}}`).

Do not assume the report is true. Read every cited line and enough surrounding
code and tests to establish each blocking finding from the repository itself.
Apply the issue requirements and project conventions.

## Rejected report

{{report}}

## Read-only contract

Your role is strictly advisory. Do not modify the branch or any file. Do not
run commands that write under `.git` (including commit, checkout, reset,
branch, worktree, gc, or prune), do not push, and do not run gate commands.

## Ruling

{{ruling}}

A missing ruling is a harness failure, not an implicit decision.
