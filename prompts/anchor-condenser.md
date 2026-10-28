# Condense an issue thread

Below is a GitHub issue: its body, then its comments C1…C{{count}}, oldest
first. Coding agents read this thread as their specification. Mark the
comments they no longer need.

DROP a comment only when a LATER comment supersedes all of it:
- a proposal or option a later comment overruled or replaced;
- a question a later comment answered, when the answer reads on its own;
- status chatter (progress notes, bot status) a later comment made out of date.

KEEP everything else — above all any comment that states an accepted
decision, requirement, constraint, instruction or answer still in force,
however old. A comment that mixes stale and valid content is KEPT. When
unsure, KEEP. You rewrite nothing: kept comments are passed on verbatim.
The body is context only and always kept. Do not run tools or change files;
everything you need is below.

Answer with exactly one block, every comment once, in order:

<condense>
C1 KEEP
C2 DROP C4 overruled: option B chosen
</condense>

`DROP Cj` names the later comment j that supersedes it. The reason is
optional, one line, at most 120 characters; agents see it in place of the
dropped comment.
