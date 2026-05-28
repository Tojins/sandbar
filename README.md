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
- Optionally, a `CODING_STANDARDS.md` (`codingStandardsPath`) — the reviewer ships with built-in default coding standards (`prompts/coding-standards.md`); this file *extends* them and is not required
- `.env` with `GH_TOKEN` and either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
- Project anchor paths (`CLAUDE.md`, optional `CONTEXT.md`, optional ADR directory)
