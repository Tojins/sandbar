## Gate selection

The gates do not run every test. Each runs the global sanity tests, core's
when a core path changes, the sanity tests of every domain whose paths a
change touches, the tests that import the changed files, and the changed test
files. Write a scenario only for issue-specific behavior that no global, core
or selected-domain sanity set covers.

Pick what else this issue's gates run: a domain whose behavior the change can
break without touching its paths, or an existing test file that guards such
behavior. Each pick needs a one-line reason. Pick nothing the gates already
run.

The seed declares:

{{declaration}}

Beside your answer, add a `<gate-selection>` block, one pick a line, empty when
you pick nothing:

domain <name>: <reason>
test <path>: <reason>
