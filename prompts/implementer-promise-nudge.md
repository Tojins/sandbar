Your last message carried no recognised `<promise>` token. The orchestrator
reads only the exact tokens below — prose does not count, and neither does a
tag around any other word — so it cannot see this attempt's outcome.

Reply with exactly one tag and nothing else:

- `<promise>COMPLETE</promise>` — the work is done and committed.
- `<promise>NEEDS-INFO</promise>` — you are blocked on missing information.
  Include a `<questions>` block if your previous messages did not.
- `<promise>NEEDS-UI-PROTOTYPE</promise>` — the issue implies user-visible UI
  with no prototype to build from. Include a `<ui-impact>` block if your
  previous messages did not.

Do not start new work.
