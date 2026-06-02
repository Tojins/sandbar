# sandbar

Issue-tracker-driven coding agent orchestrator. Plans unblocked issues, runs an inner-loop implementer (and reviewer) per issue inside an isolated sandbox, gates with the project's own `check + test`, and merges DONE branches into the source branch.

## Releasing

Consumers pin to a `vX.Y.Z` tag, so every version bump **must** be tagged. Don't bump `package.json` by hand — run:

```sh
npm version minor   # or patch / major
```

This is wired (see `package.json` scripts + `.npmrc`) to atomically: gate (`preversion`: check + test) → bump `package.json`/lockfile → commit `chore: bump version to X.Y.Z` → create the lightweight `vX.Y.Z` tag → push commit **and** tag (`postversion`). No separate tag step to forget.

If a version ever lands untagged anyway (e.g. hand-edited inside a feature commit), the `.github/workflows/auto-tag.yml` CI job is a backstop: on every push to `main` it creates the missing `vX.Y.Z` tag from `package.json`.

## Usage

`RunConfig` is **deviations-only**. Supply the repo-specific facts sandbar can't guess (required) plus only the knobs you want different from the defaults. Everything else falls through — don't restate a default.

```ts
import { run } from "@offergeist/sandbar";

await run({
  // Required — no sensible default exists:
  ghOwner: "your-org",
  ghRepo: "your-repo",
  gateImage: "localhost/your-repo-sandbar:latest",
  gateCommands: {
    check: { cmd: "npm", args: ["run", "check"] },
    test: { cmd: "npm", args: ["test"] },
  },
  botName: "your-bot",
  botEmail: "bot@your-org.dev",
  sandboxHooks: { /* per-sandbox build/setup commands */ },

  // Everything below is OPTIONAL — shown here only to document the defaults.
  // Omit any line you're happy with.
});
```

### Required fields

| Field | Why it can't default |
| --- | --- |
| `ghOwner`, `ghRepo` | Repo identity. |
| `gateImage` | The sandbox/gate image tag. |
| `gateCommands` | The host's own `check` + `test` gate. |
| `botName`, `botEmail` | Commit/author identity. |
| `sandboxHooks` | Host-specific build/setup. |

### Optional fields and their defaults

| Field | Default |
| --- | --- |
| `cwd` | `process.cwd()` |
| `workDir` | `.sandbar` |
| `sourceBranch` | `main` |
| `containerfilePath` | `Containerfile` |
| `modelId` | `claude-opus-4-8` |
| `coauthorTrailer` | `Co-authored-by: <botName> <<botEmail>>` |
| `claudeMdPath` | `CLAUDE.md` |
| `contextMdPath` | `CONTEXT.md` (referenced only if the file exists) |
| `adrDir` | `docs/adr` (referenced only if the dir exists) |
| `envFilePath` | `.env` |
| `copyToWorktree` | `[]` |
| `maxImplAttempts` | `8` |
| `maxReviewRounds` | `5` |
| `maxTotalIssues` | `50` |
| `labels` | `{ needsInfo: "needs-info", agentStuck: "agent-stuck" }` (override any subset) |
| `codingStandardsPath` | *(unset)* — no conventional path; see below |

The host project also supplies on disk:
- A `Containerfile` (at `containerfilePath`) for the sandbox image
- Optionally, a `CODING_STANDARDS.md` (`codingStandardsPath`) — the reviewer ships with built-in default coding standards (`prompts/coding-standards.md`); this file *extends* them and is not required
- `.env` (at `envFilePath`) with `GH_TOKEN` and either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
- Project anchor docs (`CLAUDE.md`, optional `CONTEXT.md`, optional ADR directory)
