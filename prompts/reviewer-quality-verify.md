## Report under check

A fixer has worked through this quality report, starting from `{{anchor}}`:

{{report}}

Judge exactly two things, reading the fixer's changes in the "changed since" stat above with `git diff {{anchor}}..HEAD`:

1. Each finding in the report above: is it dealt with at this head?
2. The lines the fixer changed, on both dimensions below.

Raise nothing else: code the fixer did not change and the report did not name is not yours to review now. If you request changes, restate in full every finding still open — from the report and from the fixer's lines — because the next fixer sees only your report, not this one. Keep each finding you restate under the `[group: …]` line it came from.
