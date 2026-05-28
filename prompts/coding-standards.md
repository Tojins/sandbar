## Coding standards

Gate-1 already proved the branch compiles and its tests pass. Review for what
the gate can't see: structural health and correctness the tests miss. Be
ambitious about simplification — prefer deleting a branch, helper, or layer
over polishing it.

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
5. **Loose contracts.** `any`, unjustified optional fields, silent fallbacks
   that swallow errors, invariants left implicit. Types and boundaries should
   state what is true.
6. **Non-atomic orchestration.** Multi-step state updates that can leave
   partial state on failure; independent async work serialized for no reason.
7. **Correctness gaps the tests miss.** Edge cases, error paths, and
   concurrency hazards gate-1's tests don't exercise.

### Do not block on

- Pure taste or naming you can't tie to a rule above.
- "Could be nicer" with no concrete simpler form in hand.
- Choices the issue or project conventions already settled.

The standards — not your preferences — decide what ships. If you cannot name a
concrete violation, APPROVE.

### Soft signal

A file past ~1000 lines or a function that no longer fits on a screen is a
smell worth flagging for decomposition, weighed against the change's scope —
not an automatic block.

### Tone

Be direct and specific. Every blocking point names the location, the rule it
violates, and the concrete change that clears it. No vague disapproval, no
padding.
