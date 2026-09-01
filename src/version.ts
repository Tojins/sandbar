// The package's own version, read from `package.json` at runtime.
//
// A module rather than a literal, because three unrelated callers need it and
// none may guess: `--version` prints it, the standalone gate's reuse token
// folds it in so a sandbar upgrade cannot silently adopt a container an older
// version's `containerRunArgs` created (#45), and `resolveConfig` compares it
// against the config's `requiresSandbar` floor (#66).
//
// `../package.json` resolves the same from `dist/version.js` and from
// `src/version.ts`, which is what lets the test suite ask the same question the
// bin does. It returns "unknown" rather than throwing, and what that answer
// COSTS depends on who asked — the third caller inverted it, so the two halves
// are worth stating separately:
//
//   - for `--version` and the reuse token it is a benign token like any other.
//     A package.json that cannot be read is not a reason to refuse a run, and
//     "unknown" simply compares unequal to a recorded real version, which
//     recreates.
//   - for `checkRequiresSandbar` it is a REFUSAL. That check exists to prove a
//     floor is met, and a driver that cannot say which version it is has not
//     proved it; `requires-sandbar.ts`'s header owns the argument.

import { createRequire } from "node:module";

export function sandbarVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
