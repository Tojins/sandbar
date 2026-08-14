export { run } from "./run.js";
export { SandbarError } from "./errors.js";
export type {
  RunConfig,
  GateCommand,
  LabelConfig,
  DbSidecarConfig,
  DbInitMount,
} from "./config.js";
// Every type a RunConfig field is declared with must be importable from the
// package root (the exports map exposes only "."), or consumers can't
// annotate factored-out values and declaration-emitting consumers hit TS4023.
export type { SandboxHooks } from "./agent-sandbox.js";
