# Landing pass: re-merge onto origin

This cycle landed {{labels}} onto `{{target}}`, but origin's `{{target}}` moved
meanwhile: `{{oldTip}}..{{newTip}}` is what it added. HEAD, `{{mergedSha}}`,
re-merges this cycle's landings onto `{{newTip}}`. Re-apply the instructions to
this cycle's whole landing, `git diff {{newTip}} HEAD`, against the new tip:
run it yourself.
