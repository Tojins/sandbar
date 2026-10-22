Your last message carried no recognised `<promise>` token, and your turn ended
while background tasks were still running. Your session ended with that turn,
so those tasks were cut off: their completion notices will never reach you, and
nothing you were waiting on will finish by itself.

You may finish the step you were waiting on. Rerun what is needed in the
foreground (narrow its scope if it was slow), commit the work, then reply with
exactly one tag:

- `<promise>COMPLETE</promise>` — the work is done and committed.
- `<promise>NEEDS-INFO</promise>` — you are blocked on missing information.
  Include a `<questions>` block if your previous messages did not.
- `<promise>NEEDS-UI-PROTOTYPE</promise>` — the issue implies user-visible UI
  with no prototype to build from. Include a `<ui-impact>` block if your
  previous messages did not.

Finish only the work you were waiting on; do not start anything new. Do not
end your turn to wait again.
