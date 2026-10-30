import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: { provider: "v8", reporter: ["json"], include: ["src/**/*.ts"], exclude: ["src/**/*.test.ts"] },
  },
});
