## The database

The `{{container}}` sibling runs on a fresh copy of the production database dump
of {{dumpDate}}, in place of its fixtures. It is yours for this run and
discarded afterwards. {{hook}}

It is unscrubbed production data. Never copy its rows anywhere but a failing
scenario's evidence, and then only the rows the failure needs.
