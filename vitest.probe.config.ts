// The suite the Stryker probe runs (scripts/structure/probe.mjs): the unit
// suite, as the gate's `test` step runs it, without the podman tests.
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.config.js";

export default mergeConfig(base, defineConfig({
  test: { exclude: [...configDefaults.exclude, "**/*-podman.test.ts"] },
}));
