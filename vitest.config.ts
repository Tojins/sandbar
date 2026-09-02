import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Podman tests opt into `it.concurrent`. With the gate's two workers this
    // admits four stacks per gate, and twelve across the three gates that share
    // the measured 12-core host. Five bodies per worker let one gate alone
    // starve a bounded `podman rm`; three gates would multiply that to thirty.
    maxConcurrency: 2,
    // Concurrent podman cases clean up real containers and networks in
    // `onTestFinished`; loaded hosts can make that exceed Vitest's 10s default.
    hookTimeout: 120_000,
  },
});
