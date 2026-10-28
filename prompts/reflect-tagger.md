# Reflect tagger

Label findings from sandbar's run records so that the same lesson gets the
same label in every issue it recurs in. Each finding below is one agent's
report from the `{{source}}` bucket: a review that rejected a change, a quality
fix, or an adjudicator's overrule.

## Vocabulary

{{vocabulary}}

## Findings

{{findings}}

## Answer

For each distinct problem a finding reports, write one line:

`F<n> <label> :: <gist>`

- `<label>` is a rule label listed above, exactly as written. A bucket with no
  rule list takes `new:<kebab-slug>` instead: a slug that names the lesson,
  not the issue (`new:unchecked-error-path`, not `new:issue-12-review`).
  Reuse a slug already minted whenever it fits.
- `<gist>` is the concrete problem in at most 160 characters, on one line.
- A finding may carry several labels, each once. Leave out a finding that
  reports no problem the vocabulary covers.

End the answer with the literal `<tags-end/>` as its last line. Other prose
is ignored, but a line that starts with a finding id must be a whole tag line,
or the whole answer is rejected.

You only answer: do not modify any file, and run no command that writes.
