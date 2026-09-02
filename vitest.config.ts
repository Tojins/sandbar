import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Podman tests opt into `it.concurrent`. With the gate's four workers this
    // admits twelve bodies per gate, enough to put the retained podman work
    // below the old eight-file ceiling while keeping the x3 ceiling explicit.
    maxConcurrency: 3,
    // Concurrent podman cases clean up real containers and networks in
    // `onTestFinished`; loaded hosts can make that exceed Vitest's 10s default.
    hookTimeout: 120_000,
  },
});
