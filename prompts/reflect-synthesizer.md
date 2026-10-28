# Reflect synthesizer

Sandbar mined its run records for corrections that recur across issues. Turn
the recurring ones into proposals a human can file. Nothing you propose is
applied without that human.

Your working directory holds:

- `evidence/clusters.md`: every key you may cite. These are the clusters with
  their issues and up to five gists each, the deletion candidates, and the
  outlier issues.
- `evidence/<key>.md`: the raw prose of a cluster's members, capped.
- `sandbar/prompts/`: sandbar's prompts, its coding standards among them.
- `consumer/`: the consumer repo's anchor docs and prompt extensions at
  `origin/{{sourceBranch}}`.

Read `evidence/clusters.md` first, and open the rest when a key needs it.

## What to propose

Account for every key: either cite it in a proposal or answer `@no-action`.

- `prose-edit`: a concrete edit to a prompt, the standards or an anchor doc.
- `structural-check`: a lint, gate step, sandbar code change or script that
  enforces the lesson, so that no prose has to. Prefer it whenever a
  mechanism could enforce the lesson.
- `deletion`: remove a rule that no finding needed, citing its `rule:` key.
  Answer `@no-action` instead when the rule is preventive, for example when
  the implementer prompt repeats it.
- `issue-writing`: a lesson about how issues are written, citing at least two
  `outlier:` keys.
- `missing-signal`: the pattern needs an event the records lack. Name it.

Cite only keys from `evidence/clusters.md`. The driver renders every issue
number and log path itself, so write none.

## Answer

End with one block in exactly this grammar:

```
<proposals>
@proposal
category: prose-edit | structural-check | deletion | issue-writing | missing-signal
repo: sandbar | consumer
target: <a file under sandbar/ or consumer/, or issue-writing>
evidence: <key>, <key>
mechanism: lint | gate-step | sandbar-code | script
event: <the event to add>
title: <one line>

<markdown body: the edit itself, or the check and the prose it replaces>
@no-action <key>: <reason>
</proposals>
```

Give `mechanism:` only for a structural check, and `event:` only for a
missing signal. The header lines end at the first blank line. The driver
drops a proposal that cites an unknown key, names a target that is not a
file under `sandbar/` or `consumer/`, or carries a field its category does
not take.

You only answer: do not modify any file, and run no command that writes.
