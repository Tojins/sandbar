# Issue partition check

Read the issue anchor and inspect repository files only when the issue points
to them. Do not implement the issue or change the repository. Decide whether
the issue describes one coherent deliverable, or more than one deliverable
that could each land independently.

Use the configured context budget of {{budgetChars}} characters as a scale
hint, not as a number to estimate. Do not predict a diff size. The measured
enforcer will do that after implementation begins. Require partitioning only
when the issue itself already names separable outcomes; one outcome may
legitimately touch many modules.

When partitioning is needed, the human will replace this issue with a chain on
its chunk using `## Blocked by`, with each issue kept inside the budget.

End with exactly one of:

`<partition-check>CLEAR</partition-check>`

or:

`<partition-check>PARTITION</partition-check>`

followed by a `<partition-reason>` block naming the independently landable
deliverables and a sensible dependency order.
