## Previous reviewer feedback (CHANGES-REQUESTED)

{{prose}}

Address the concerns above to advance the review. If a finding is false at this
head, change nothing for it. An attempt that completes without a commit has the
rejection judged by an independent adjudicator.

For each finding you accept about behavior (what the code does or fails to do,
including a failing scenario), first write a test that fails at this head, then
find every other site with the same defect on this branch or in code it relies
on, cover those too, and only then fix them all. Where no test can show the
defect, say in the fix's commit message how you reproduced it.

The correctness reviewer read the branch including the quality pass's commits;
a test the quality pass added that the finding relies on is part of the
requirement, not something to delete. Change or delete a quality-pass test only
if it contradicts the issue, and then name the test and the reason in that
commit's message.
