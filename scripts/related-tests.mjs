#!/usr/bin/env node
// The `related` pass of sandbar's own gate (#259, #269): the test files whose
// imports reach any of the files named, as `vitest related` picks them, listed
// without running one. Stdout is one repository path a line and nothing else,
// since the gate reds a printed path its tree does not have. Run from the
// repository root.
//
// vitest's `forceRerunTriggers` are emptied: by default a changed
// `package.json` selects every test, and every branch bumps its version.
//
//   node scripts/related-tests.mjs <file>…

import { relative } from "node:path";
import { createVitest } from "vitest/node";

const vitest = await createVitest("test", {
  related: process.argv.slice(2),
  forceRerunTriggers: [],
  watch: false,
  passWithNoTests: true,
});
try {
  const specs = await vitest.getRelevantTestSpecifications();
  const files = [...new Set(specs.map((spec) => relative(process.cwd(), spec.moduleId)))].sort();
  process.stdout.write(files.map((file) => `${file}\n`).join(""));
} finally {
  await vitest.close();
}
