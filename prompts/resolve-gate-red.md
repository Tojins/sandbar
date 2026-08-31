This branch merged cleanly into {{target}}, but the post-merge gate
(the project's gate steps) is failing against the merged tree.

## Gate output (last 200 lines)

```
{{trace}}
```

Commit a fix on top of HEAD. The merge commit itself stays in place; your work
is a follow-up commit. If the two branches' intents genuinely contradict and the
failure can't be reconciled with a small fix, declare ABANDON with a `<reason>`
that names the colliding issues and which one should lose.
