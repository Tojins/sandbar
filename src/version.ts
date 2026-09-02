// The package's own version, read from `package.json` at runtime.
//
// A module rather than a literal, because four unrelated callers need it and
// none may guess: `--version` prints it (cli.ts), the standalone gate's reuse
// token folds it in so a sandbar upgrade cannot silently adopt a container an
// older version's `containerRunArgs` created (#45), the run's opening line
// names it as the identification of what is driving the run (#69,
// `driver-identity.ts`), and `resolveConfig` compares it against the config's
// `requiresSandbar` floor (#66).
//
// `../package.json` resolves the same from `dist/version.js` and from
// `src/version.ts`, which is what lets the test suite ask the same question the
// bin does. It returns "unknown" rather than throwing, and what that answer
// COSTS depends on who asked — the two newest callers each took it somewhere
// the first two do not, so the three cases are worth stating separately:
//
//   - for `--version` and the reuse token it is a benign token like any other.
//     A package.json that cannot be read is not a reason to refuse a run, and
//     "unknown" simply compares unequal to a recorded real version, which
//     recreates.
//   - for the driver line it is a LOST ATTRIBUTION, which is neither of the
//     other two. The line still prints — it is a fact and never a refusal —
//     but under #66 a self-hosted driver is an installed release beneath a
//     gitignored `.sandbar/`, so its TREE state is `unknown` by construction
//     and this value is the whole of the identification that line carries. A
//     `sandbar unknown` there is the one line that says which release produced
//     a run, saying nothing; `driver-identity.ts`'s header owns why the tree
//     cannot answer in its place.
//   - for `checkRequiresSandbar` it is a REFUSAL. That check exists to prove a
//     floor is met, and a driver that cannot say which version it is has not
//     proved it; `requires-sandbar.ts`'s header owns the argument.

import { createRequire } from "node:module";

export function sandbarVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw err;
    return "unknown";
  }
}
