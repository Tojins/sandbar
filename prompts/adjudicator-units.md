The report is a list of tagged units; rule on each one on its own.

- A `[white-box]` unit is a code review: `UPHELD` if any blocking finding in
  it is true at this head, `OVERRULED` only if every one is false.
- A `[scenario S<n>]` unit is a hidden acceptance scenario someone ran against
  the branch, with what they observed and their evidence under
  `/sandbar/verifier/findings/S<n>/`. It is `UPHELD` when the evidence and the
  code show its Then does not hold at this head, and `OVERRULED` when the
  evidence does not show what the unit claims or the Then asks for something
  the issue does not require. An overruled scenario is never run again.

Explain the evidence for each ruling, then end with one literal token per
unit, each on its own line:

{{tokens}}
