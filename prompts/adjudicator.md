# Adjudication

Independently judge the rejected {{pass}} review report below against the code
at head `{{head}}` on branch `{{branch}}` (seeded from `{{baseRef}}`).

Do not assume the report is true. Read every cited line and enough surrounding
code and tests to establish each blocking finding from the repository itself.
Apply the issue requirements and project conventions. You are ruling on the
report as a whole:

- `UPHELD` if any blocking finding in the report is true at this head.
- `OVERRULED` only if every blocking finding in the report is false at this
  head.

## Rejected report

{{report}}

## Read-only contract

Your role is strictly advisory. Do not modify the branch or any file. Do not
run commands that write under `.git` (including commit, checkout, reset,
branch, worktree, gc, or prune), do not push, and do not run gate commands.

Explain the evidence for your ruling, then end with exactly one literal token
on its own line:

- `<ruling>UPHELD</ruling>`
- `<ruling>OVERRULED</ruling>`

A missing ruling is a harness failure, not an implicit decision.
