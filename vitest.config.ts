import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Podman tests opt into `it.concurrent`; cap the bodies admitted by each
    // worker so three simultaneous gates cannot multiply the default without
    // bound. The gate command pins the worker side of the same product.
    maxConcurrency: 5,
  },
});
