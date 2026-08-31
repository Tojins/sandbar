# AGENTS.md

Working rules for anything that commits to this repo — Claude Code in a terminal,
or a sandbar implementer/reviewer inside its sandbox. Architecture notes are not
here — those are `CLAUDE.md` and the module headers.

## Bump the version on every commit

Every commit moves `version` in `package.json`, in the **same commit** as the
change it describes — never as a bump-only commit:

```sh
npm version patch --no-git-tag-version --ignore-scripts   # or `minor`
```

Both flags are required: `preversion`/`postversion` are written for a deliberate
release bump, and without `--ignore-scripts` the `postversion` push would publish
a mid-change HEAD. The command also updates the two matching entries in
`package-lock.json`; both files belong to the commit. Patch for a fix or an
internal change, minor for anything a host repo's config or expectations have to
move for.
