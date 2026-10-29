## Coding standards

These standards cover what the gate can't see: structural health. Assume no
particular gate check ran. Prefer deleting a branch, helper or layer over
polishing it. A standards fix changes structure, never behavior.

### Violations (each one must be fixed before the branch ships)

1. **Complexity that doesn't pay for itself.** Complexity moved rather than
   reduced, or a simpler form you can name left on the table. So are diff
   lines the issue doesn't need: remove them where that leaves the behavior it
   asks for intact.
2. **Spaghetti control flow.** Conditionals bolted onto existing flows; one
   special case re-checked in unrelated places instead of one abstraction;
   nesting that early returns would flatten. Restructure so every path behaves
   as before.
3. **Wrong abstraction.** Thin or identity wrappers, indirection that hides
   rather than clarifies, over-generic "magic" where a direct call reads
   better — and the inverse: copy-pasted logic that should be one helper.
4. **Logic in the wrong layer.** Feature code leaking into shared modules, a
   reimplemented existing helper, new code in a style its file doesn't use. A
   value threaded through several layers, or a call chain over three files
   deep, when you can name a direct path: take it, changing no caller's
   behavior.
5. **Loose contracts.** `any`, unjustified optional fields, implicit
   invariants, such as a "keep this order" comment: where a type, test,
   assertion or lint can enforce it, add that and delete the comment. Validate
   at boundaries, then trust the types: drop re-checks a boundary already
   guarantees. A `catch` either **classifies** (maps one named, expected
   condition to a value, checked explicitly) or **cleans up** (logs the
   secondary failure with its cause, then rethrows the original). Everything
   else propagates; blanket defaults, log-and-continue and empty catches are
   banned. A supervised run's boundary (the pool's issue loop, a janitor run)
   classifies any rejection as the run's recorded failed outcome.
6. **Non-atomic orchestration.** Multi-step state updates that can leave
   partial state on failure; independent async work serialized for no reason.
7. **Wrong or idle prose.** Headers, docs and prompts are part of the change:
   correct what contradicts the code or went stale, and delete filler that
   restates its subject or narrates process instead of result. A comment in a
   function or test body states a non-obvious why the code cannot show;
   delete narration, step labels and restated names. Commit messages you
   write count.

## Leave alone

- Pure taste, naming or wording you can't tie to a rule.
- "Could be nicer" with no simpler form in hand.
- Choices the issue or project conventions settled, such as headers they make
  authoritative: correct what is wrong there, never cut for length.
- Commit messages already on the branch.

The standards, not anyone's preferences, decide what ships. Where you cannot
name a concrete violation, change nothing.
