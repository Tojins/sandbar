## Escalation

This is attempt {{attempt}}. If you cannot make further
progress:

- Emit `<promise>NEEDS-INFO</promise>` with a `<questions>` block listing the
  specific decisions or facts you need.
- Or, if what's blocking you is that you'd be inventing user-visible UI with no
  prototype to build from, emit `<promise>NEEDS-UI-PROTOTYPE</promise>` with a
  `<ui-impact>` block instead.
- Or revert to the last-good commit and let the orchestrator route this to a
  human reviewer.
