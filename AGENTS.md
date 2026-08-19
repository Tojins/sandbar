# AGENTS.md

Working rules for anything that commits to this repo — Claude Code in a terminal,
or a sandbar implementer/reviewer inside its sandbox. It is reached from both
contexts by two independent routes, so neither depends on the other holding:
`CLAUDE.md` imports it, and `sandbar.config.mjs` names it as an anchor doc, which
is what makes the prompt builders emit an `@ref` to it in every agent prompt.

Architecture notes are not here — those are `CLAUDE.md` and the module headers.

## Bump the version on every commit

Every commit moves `version` in `package.json`, in the **same commit** as the
change it describes:

```sh
npm version patch --no-git-tag-version --ignore-scripts   # or `minor`
```

That updates the two matching entries in `package-lock.json` as well; both files
belong to the commit.

**Both flags are required, and `--ignore-scripts` is the load-bearing one.** This
package's `preversion` runs the whole suite (~3 minutes) and its `postversion` is
`git push --follow-tags` — written for a deliberate release bump, and actively
wrong for a per-commit one: with `--no-git-tag-version` there is no commit and no
tag for that push to carry, so it would publish whatever HEAD happened to be,
mid-change, without being asked. Patch for a fix or an internal change, minor for anything a
host repo's config or expectations have to move for.

Why every commit rather than at release time: this repo *is* the package, and the
version is the only handle anyone has on which orchestrator produced a run —
including this repo running itself (#39), where the code driving a cycle is
whatever `dist/` held at launch. Bumped per commit, a reported version names one
tree; bumped at release, it names a range, and every "which build was that?"
becomes an archaeology exercise against the run log.

And never as a commit of its own: a `chore: bump` standing alone is a version
that no commit's content belongs to, which is the same ambiguity wearing a
tidier hat.
