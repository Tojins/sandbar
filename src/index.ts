export { run } from "./run.js";
export { SandbarError } from "./errors.js";
export type {
  RunConfig,
  LabelConfig,
  MergeModeConfig,
  // The gate stack (#24) — every type a `gateStack` / `images` literal is
  // built from, so a consumer can factor pieces out into typed constants.
  GateStackConfig,
  StackContainer,
  StackMount,
  Readiness,
  GateStep,
  BuiltImage,
} from "./config.js";
// Every type a RunConfig field is declared with must be importable from the
// package root (the exports map exposes only "."), or consumers can't
// annotate factored-out values and declaration-emitting consumers hit TS4023.
export type { SandboxHooks } from "./agent-sandbox.js";
