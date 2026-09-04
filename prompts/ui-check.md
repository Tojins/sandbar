# UI prototype check

Read the issue anchor and inspect repository files only when the issue points
to them. Do not implement the issue or change the repository. Decide whether
the issue has **non-trivial UI impact**: would it add, remove, or rearrange
visible UI, or alter a user-facing flow? Copy tweaks, styling adjustments to an
element that already exists, and backend or logic changes behind an unchanged
UI are not non-trivial.

If it does, look for a **prototype** in the issue body and comments. A prototype
is any artifact you can actually read that pins the specific design decisions
implementation would otherwise have to invent: a path to a file in this repo,
an inline markup block or ASCII wireframe, a fetchable URL, or a prose spec
precise enough to remove the guesswork. A human replying "no prototype needed"
also counts as an explicit decision to let the implementer choose. An image you
cannot see does not count on its own: a pasted screenshot may reach you as a URL
you can neither authenticate to nor render.

When genuinely unsure whether the impact is non-trivial, require a prototype.
A false positive costs one human round-trip; a false negative merges UI nobody
has seen, and undoing a merged design decision is far more expensive.

End with exactly one of:

`<ui-check>CLEAR</ui-check>`

or, for non-trivial UI impact with no readable prototype:

`<ui-check>PROTOTYPE-NEEDED</ui-check>`

followed by a `<ui-impact>` block covering (a) what visible UI the issue would
create or alter, (b) which design decisions implementation would invent, and
(c) what artifact would unblock it.
