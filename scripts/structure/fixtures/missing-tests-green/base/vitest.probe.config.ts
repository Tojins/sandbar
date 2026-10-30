import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.config.js";

export default mergeConfig(base, defineConfig({
  test: { exclude: [...configDefaults.exclude, "**/*-podman.test.ts"] },
}));
