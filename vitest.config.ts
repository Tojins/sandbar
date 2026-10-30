import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Podman tests opt into `it.concurrent`. With the gate's eight workers this
    // admits 24 bodies per gate and an explicit ceiling of 72 across K=3.
    maxConcurrency: 3,
    // Off unless a run enables it: the gate's test steps write what the
    // `tests` structural check reads (scripts/structure/coverage.mjs).
    coverage: {
      provider: "v8",
      reporter: ["json"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.test-util.ts"],
    },
  },
});
