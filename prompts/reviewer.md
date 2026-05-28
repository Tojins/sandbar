# Review

Review the implementation on branch `{{branch}}` against `{{sourceBranch}}`.
Issue #{{issueId}}: {{issueTitle}}

{{commits}}{{diff}}{{codingStandards}}

{{projectStandards}}## Review process

Check the branch against the coding standards above, plus the conventions in
{{conventionsRef}}. Your role is strictly advisory: you must not modify the branch,
commit, push, or run gate commands. Read-only investigation only.

## Verdict

End your review with a single verdict token on its own:

- `<verdict>APPROVED</verdict>` — branch meets the bar, ship it.
- `<verdict>CHANGES-REQUESTED</verdict>` — list the standards violations above and
  the implementer will address them in the next round.

A missing verdict defaults to CHANGES-REQUESTED. Emit exactly one verdict.
