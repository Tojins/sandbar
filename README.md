# sandbar

Sandbar turns GitHub issues into merged code. You agree a design and file the
issues; sandbar builds, reviews and tests each one in its own sandbox; you
review the result.

## The GitHub workflow

![You run /grill-me and to-tickets to file 2-agent-build issues; sandbar picks unblocked issues, builds them and merges them to a chunk branch with a draft PR; you test it with /human-review, then approve with the land label or request changes](docs/github-workflow.svg)

`/grill-me`, `to-tickets` and `/human-review` are Claude Code skills in the
consumer repo.

## Inside sandbar: one issue, one sandbox

![Pre-checks, implementer, quality review (violations lister, fixer, verify), automatic tests, verifier, adjudicator, then merge with a resolve agent](docs/inner-loop.svg)

## Running it

```sh
npm i -D sandbar
npx sandbar          # reads ./sandbar.config.mjs
```

Configuration, daemon operation, images and the gate stack:
[docs/reference.md](docs/reference.md).
