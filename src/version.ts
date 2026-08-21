// The package's own version, read from `package.json` at runtime.
//
// A module rather than a literal, because two unrelated callers need it and
// neither may guess: `--version` prints it, and the standalone gate's reuse
// token folds it in so a sandbar upgrade cannot silently adopt a container an
// older version's `containerRunArgs` created (#45).
//
// `../package.json` resolves the same from `dist/version.js` and from
// `src/version.ts`, which is what lets the test suite ask the same question the
// bin does. It returns "unknown" rather than throwing: a package.json that
// cannot be read is not a reason to refuse a run, and "unknown" is a token like
// any other — it simply compares unequal to a recorded real version, which
// recreates.

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
