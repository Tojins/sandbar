## This branch is part of a chunk

Your branch was **not** cut from the source branch. It was seeded from
`{{chunkBranch}}` (read it as `{{baseRef}}`) — the branch a group of related,
review-gated issues land on together so a human can review them as one unit.

What follows from that:

- **The work your issue is blocked by is already under your feet**, on that
  branch and nowhere else. It is not on the source branch and will not be until
  a human has reviewed the whole chunk, so do not go looking for it there and do
  not re-implement it.
- **Everything already on `{{chunkBranch}}` is out of scope.** The diff below is
  measured from that tip, so it shows your commits and only yours. Add to it;
  don't restate it.
- **Any range of your own should start there too.** `{{baseRef}}..HEAD` is your
  work; `{{baseRef}}` is what the rest of the chunk looks like.
- Reworking an earlier member's code is fair game when your issue genuinely
  requires it — the chunk is reviewed as one diff — but say so in the commit
  message, because a reviewer reading this issue will not be expecting it.
