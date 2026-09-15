# Issue partition check

Read the issue anchor and inspect repository files only when the issue points
to them. Do not implement the issue or change the repository.

Partitioning exists for one reason: an issue whose whole change would not fit
the configured context budget of {{budgetChars}} characters. Answer PARTITION
only when both hold:

1. The issue, taken whole, plausibly exceeds that budget. Judge this from the
   scale of what it describes. The measured enforcer that runs after
   implementation begins is the authority; you are only its early warning.
2. The issue itself already names outcomes that could each land alone.

When the whole fits, answer CLEAR however many decisions, steps or modules the
issue lists. A numbered design, a small adjacent cleanup, or one change that
touches several execution paths is still one deliverable. When in doubt,
answer CLEAR.

When partitioning is needed, the human will replace this issue with a chain on
its chunk using `## Blocked by`, with each issue kept inside the budget. Give
each proposed piece a coarse, order-of-magnitude estimate of files touched and
changed lines so the human can check the split without re-deriving it. The
estimate is for that reader; it is never the reason to split.

End with exactly one of:

`<partition-check>CLEAR</partition-check>`

or:

`<partition-check>PARTITION</partition-check>`

followed by a `<partition-reason>` block naming the independently landable
pieces, each piece's estimated files and changed lines, and a sensible
dependency order.
