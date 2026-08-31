Your last message ended without a `<promise>` tag. The orchestrator reads only
the tag — prose does not count — so it cannot see this attempt's outcome.

Reply with exactly one tag and nothing else:

- `<promise>COMPLETE</promise>` — the work is done and committed.
- `<promise>NEEDS-INFO</promise>` — you are blocked on missing information.
  Include a `<questions>` block if your previous messages did not.
- `<promise>NEEDS-UI-PROTOTYPE</promise>` — the issue implies user-visible UI
  with no prototype to build from. Include a `<ui-impact>` block if your
  previous messages did not.

Do not start new work.
