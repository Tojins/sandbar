# sandbar

Issue-tracker-driven coding agent orchestrator. Plans unblocked issues, runs an inner-loop implementer (and reviewer) per issue inside an isolated sandbox, gates with the project's own `check + test`, and merges DONE branches into the source branch.

## Usage

```ts
import { run } from "@offergeist/sandbar";

await run({
  cwd: process.cwd(),
  workDir: ".sandbar",
  ghOwner: "your-org",
  ghRepo: "your-repo",
  sourceBranch: "main",
  // ... see Config in src/config.ts for the full surface
});
```

The host project supplies:
- A `Containerfile` for the sandbox image
- A `CODING_STANDARDS.md` consumed by the reviewer
- `.env` with `GH_TOKEN` and either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
- Project anchor paths (`CLAUDE.md`, optional `CONTEXT.md`, optional ADR directory)
