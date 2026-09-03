import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Podman tests opt into `it.concurrent`. With the gate's eight workers this
    // admits 24 bodies per gate and an explicit ceiling of 72 across K=3.
    maxConcurrency: 3,
  },
});
