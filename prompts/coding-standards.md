## Coding standards

Gate-1 runs every step this project defines as its gate against the branch,
over a clean worktree. What those steps cover is the project's choice —
usually a build and a test suite, but do not assume any particular one ran.
These standards cover what the gate can't see: structural health. Be ambitious
about simplification — prefer deleting a branch, helper, or layer over
polishing it.

### Violations (each one must be fixed before the branch ships)

1. **Complexity that doesn't pay for itself.** A change that shuffles
   complexity around without reducing it, or leaves an obviously simpler form
   on the table. It counts only when you can name that simpler form concretely.
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

### Not violations

- Pure taste or naming you can't tie to a rule above.
- "Could be nicer" with no concrete simpler form in hand.
- Choices the issue or project conventions already settled.

The standards — not anyone's preferences — decide what ships. Where you cannot
name a concrete violation, there is nothing to change.
