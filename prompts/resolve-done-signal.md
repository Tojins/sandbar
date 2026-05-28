# Attempt {{attempt}} of {{maxAttempts}}

## Done signals

{{committedSignal}}
- `<promise>ABANDON</promise>` plus `<reason>…</reason>` — this can't be resolved automatically. Reason should be specific: which two intents collide, which branch you believe should lose, or what human decision is missing.

After you exit, the orchestrator inspects the working tree. A claim of COMMITTED with the merge still mid-merge, or with the gate still red, rolls you back into the next attempt with the updated trace.

Do not run the gate yourself.
Do not push.
