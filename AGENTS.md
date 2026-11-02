# AGENTS.md

Working rules for anything that commits to this repo — Claude Code in a terminal,
or a sandbar implementer/reviewer inside its sandbox. Architecture notes are not
here — those are `CLAUDE.md` and the module headers.

## Never run a replay

Agents never run `npm run replay`: it reruns past issues on real agents and
spends real tokens, so only a human starts one (#195).

## Bump the version on every branch

Every branch moves `version` in `package.json` above its base (its merge base
with `origin/main`); a commit made directly on `main` bumps itself. The bump
rides in a commit with the change it describes — never a bump-only commit —
and the gate's `version` step checks it (`npm run structure` locally):

```sh
npm version patch --no-git-tag-version --ignore-scripts   # or `minor`
```

Both flags are required: `preversion`/`postversion` are written for a deliberate
release bump, and without `--ignore-scripts` the `postversion` push would publish
a mid-change HEAD. The command also updates the two matching entries in
`package-lock.json`; both files belong to the commit. Patch for a fix or an
internal change, minor for anything a host repo's config or expectations have to
move for.

## Run the tests your change reaches, not the suite

Gate-1 runs the structural checks and a selection of whole test files on
every attempt, not the whole suite: the global sanity set, core's set when a
core file changed, the sets of the domains the branch's changes reach, the
tests whose imports reach a changed file (`scripts/related-tests.mjs`), and
the test files the branch adds or changes (`gateStack` in
`deploy/ansible/installations/sandbar/sandbar.config.mjs`, #259). A whole
`npm test` of your own runs far more, at ten minutes a run. Run the test files
your change reaches: `npx vitest run src/<file>.test.ts`, or `npx vitest
related --run <changed src files>` for every test that imports them.

A test in a file of a `sanity` set stays under 500 ms in an idle unit run and
needs no podman; a slower one moves to a file of its own.

Every behaviour a branch adds or changes needs a test that would notice it
breaking, and every production line it adds must run in some test: the
gate's `missing-tests` check reds an added statement line no test covers,
on the branch and again on the merge result at landing. Before promising,
run `npm run structure` over coverage from those same related tests:

```sh
npx vitest related --run --coverage.enabled --coverage.reportsDirectory=coverage/unit <changed src files>
npm run structure
```

Without `coverage/podman/` a line only a podman test runs is red there too;
run those tests with `--coverage.reportsDirectory=coverage/podman` as well.
