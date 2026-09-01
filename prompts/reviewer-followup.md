# Review follow-up

Review the implementation on branch `{{branch}}` against `{{baseRef}}` — the ref
this branch was seeded from.
(That is also the ref to use for any git command of your own: this worktree comes
from a bare object cache that holds no local `{{sourceBranch}}`, so the bare name
does not resolve.)

Issue #{{issueId}}: {{issueTitle}}

{{chunkBase}}{{commits}}{{diff}}{{codingStandards}}

{{projectStandards}}## Review process

Correctness has already passed. Review only these remaining dimensions, in
order:

1. Test quality and coverage.
2. Spec conformance: compare the issue body to the branch, including missing
   requirements and scope creep.
3. Project standards: the coding standards above plus the conventions in
   {{conventionsRef}}.

Do not search for correctness defects or relitigate the first pass's judgment.
If you independently notice a concrete correctness defect while checking these
dimensions, however, report it under `### Correctness` and request changes.

Your role is strictly advisory: you must not modify the branch, commit, push, or
run gate commands. Read-only investigation only.

If a dimension requests changes, put only its actionable findings under its
exact heading: `### Correctness`, `### Tests`, `### Spec`, or `### Standards`.
Omit headings for dimensions that pass.

## Verdict

End your review with a single verdict token on its own:

- `<verdict>APPROVED</verdict>` — all three dimensions meet the bar.
- `<verdict>CHANGES-REQUESTED</verdict>` — at least one dimension has actionable
  findings under its heading above.

A missing verdict defaults to CHANGES-REQUESTED. Emit exactly one verdict.
