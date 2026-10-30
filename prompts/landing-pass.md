{{landing}}{{issues}}

## The project's landing instructions

{{instructions}}

## Task

Make only the changes these instructions ask for, as new commits on HEAD. Do
not amend, rebase or merge, do not push, and do not run the gate: sandbar gates
the result. Nothing to do is a normal outcome: say DONE.

# Attempt {{attempt}} of {{maxAttempts}}
{{retry}}
## Done signals

- `<promise>DONE</promise>`: you finished, with commits or without.
- `<promise>ABANDON</promise>` plus `<reason>…</reason>`: the instructions can't be carried out for this landing. Name what a human must decide.

After you exit, sandbar checks that HEAD descends from `{{mergedSha}}` through
single-parent commits, with no merge in progress and a clean worktree. Anything
else is reset and costs the attempt.
