## Coding standards

Gate-1 is green: every step this project defines as its gate passed on this
branch, over a clean worktree. What those steps cover is the project's choice —
usually a build and a test suite, but do not assume any particular one ran.
Review for what the gate can't see: structural health. Be ambitious about
simplification — prefer deleting a branch, helper, or layer over polishing it.

### Block on these (each is a CHANGES-REQUESTED reason)

1. **Complexity that doesn't pay for itself.** A change that shuffles
   complexity around without reducing it, or leaves an obviously simpler form
   on the table. Only block when you can name that simpler form concretely.
2. **Spaghetti control flow.** Ad-hoc conditionals bolted onto existing flows;
   the same special case re-checked in several unrelated places instead of one
   dedicated abstraction.
3. **Wrong abstraction.** Thin or identity wrappers, indirection that hides
   rather than clarifies, over-generic "magic" where a direct call reads
   better — and the inverse: copy-pasted logic that should be one helper.
4. **Logic in the wrong layer.** Feature-specific code leaking into shared
   modules, or a bespoke reimplementation of a helper that already exists.
   Logic belongs in its canonical home and reuses what's there.
5. **Loose contracts.** `any`, unjustified optional fields, invariants left
   implicit. Types and boundaries should state what is true. A `catch` may do
   exactly one of two things: **classify** — map one named, expected condition
   to a value, checked explicitly — or **clean up** — on a failure path, report
   the secondary failure to the log with its cause, then rethrow the original
   error. Everything else propagates. Blanket defaults, log-and-continue, and
   empty catches are banned.
6. **Non-atomic orchestration.** Multi-step state updates that can leave
   partial state on failure; independent async work serialized for no reason.

### Do not block on

- Pure taste or naming you can't tie to a rule above.
- "Could be nicer" with no concrete simpler form in hand.
- Choices the issue or project conventions already settled.

The standards — not your preferences — decide what ships. If you cannot name a
concrete violation, APPROVE.
