# Issue partition check

Read the issue anchor and inspect repository files only when the issue points
to them. Do not implement the issue or change the repository. Decide whether
the issue describes one coherent deliverable, or more than one deliverable
that could each land independently.

Identify the issue's deliverables and estimate, coarsely, how many files each
would touch and how many lines it would change. Inspect the files named by the
issue when that helps. Order-of-magnitude estimates are enough: use the
configured context budget of {{budgetChars}} characters as a scale hint, but
do not pretend this is the measured enforcer that runs after implementation
begins.

A deliverable is sizeable when it is likely to change roughly 100 or more
lines, or touch 3 or more files. Deleting one config entry (about 1 line in 1
file) is not sizeable. A new config-driven set of prefix locations plus its
tests and a README section (a few hundred lines across 4 or more files) is.

Answer PARTITION only when the issue names at least two independently landable
deliverables that are each sizeable on their own. Fold anything below the
floor into the deliverable it belongs with; never propose it as its own piece.
One sizeable outcome surrounded by small chores remains one issue. When in
doubt, answer CLEAR; the measured enforcer will catch work that actually grows
past the budget.

When partitioning is needed, the human will replace this issue with a chain on
its chunk using `## Blocked by`, with each issue kept inside the budget.

End with exactly one of:

`<partition-check>CLEAR</partition-check>`

or:

`<partition-check>PARTITION</partition-check>`

followed by a `<partition-reason>` block naming the independently landable
pieces, each piece's estimated files and changed lines, and a sensible
dependency order.
