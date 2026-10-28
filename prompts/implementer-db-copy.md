## Your production database copy

The `{{container}}` sibling runs on a copy of the production database dump of
{{dumpDate}}, in place of its fixtures and at the same address. {{hook}}

The copy is yours alone and is discarded when you hand over: your next attempt
starts on a fresh one. Gates run on the fixtures, so no test may depend on what
the copy holds.

It is unscrubbed production data. Never copy its rows into commits, tests,
fixtures or your final message.
