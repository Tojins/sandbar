# Idle task anchor

No issue asked for this work: wherever your instructions say "the issue", read
this task. This is sandbar's idle task `{{task}}`. Its commits accumulate on a
rolling branch that a human reviews as one draft pull request. A run's commits
are kept only if they pass the quality pass, the gate and a cold review.

## Scope of this run

{{scope}}

Change these paths, plus the tests, callers and docs that must change with
them. Leave everything else alone; later runs cover it.

## What to apply

{{source}}

## Rules

- Change no observable behavior unless a rule above requires it; then say so
  in the commit message.
- A few sharp changes beat many cosmetic ones. One coherent change per commit;
  its subject names the rule it applies.
- Add no new user-visible UI.
- If nothing in scope warrants a change, commit nothing and emit
  `<promise>NEEDS-INFO</promise>` with a `<questions>` block giving the reason
  in one or two lines. Nobody answers it; it ends the run cleanly.
