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

Gate-1 runs the whole suite, unit and podman, and the structural checks on
every attempt, so a whole `npm test` of your own repeats it at ten minutes a
run. Run the test files your change reaches: `npx vitest run
src/<file>.test.ts`, or `npx vitest related --run <changed src files>` for every
test that imports them.

Every production line a branch adds needs a test that runs it and fails
without it: the gate's `missing-tests` check reds an added line no test
covers, a mutant of it no test kills, or a deleted line no test misses.
Before promising, run `npm run structure` over coverage from those same
related tests:

```sh
npx vitest related --run --coverage.enabled --coverage.reportsDirectory=coverage/unit <changed src files>
npm run structure
```
