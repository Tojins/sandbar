export { run, type RunOptions } from "./run.js";
// The gate stack on its own (#45), for the same reason `run` is exported: the
// bin is thin, so anything it can do a host embedding sandbar can do too. The
// exit codes are exported with it because the number IS the verdict and a host
// re-deriving 0/1/2 from a boolean would be a second statement of it.
export {
  GATE_EXIT_GREEN,
  GATE_EXIT_NO_VERDICT,
  GATE_EXIT_RED,
  type GateCommandOptions,
  runGateCommand,
} from "./gate-run.js";
// The relaunch contract's number (#65), for the same reason the gate codes
// above are exported: a host's launcher loop continues on exactly this exit
// code, and a re-derived or hand-copied 75 would be a second statement of it.
// (A launcher that cannot import it repeats it by hand instead —
// `scripts/sandbar-launch.mjs` runs before the package it would import exists,
// and a consumer's shell loop has nowhere to import to — which is why the
// constant's comment names that script and a test asserts the two agree.)
export { EXIT_CODE_RELAUNCH } from "./exit-conditions.js";
export { SandbarError } from "./errors.js";
// Opt-in, not contract (#38). `config.env` is a plain record; this is the
// convenience for hosts that keep their credentials in a dotenv-style file
// whose name and location THEY choose.
export { readEnvFile } from "./env-file.js";
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
// `implementerAgent`/`reviewerAgent`'s type (#72), exported under that same
// rule. The NAMES come with it for the reason `AUTO_LAND_LABEL` does: the set
// is closed and a driver refuses a name it cannot build, so a host that
// computes the field — the config is a program — should ask this list what
// this driver accepts rather than spell a string and find out at startup.
export {
  AGENT_PROVIDER_NAMES,
  CLAUDE_CODE_VERSION,
  CODEX_VERSION,
  type AgentProviderName,
} from "./agent-providers.js";
// `config.defaultLane`'s type, and the label a host writes on the issues that
// depart from it (#57) — exported for the same reason the exit codes are: the
// string IS the protocol, and a host spelling `"auto-land"` by hand in a
// labelling script has restated it.
export { AUTO_LAND_LABEL, type Lane } from "./lanes.js";
// The label sandbar puts on a review-gated issue once its work is on its
// chunk's branch (#60), exported on the same grounds as `AUTO_LAND_LABEL` and
// with one more: sandbar never creates labels, so a host on the review lane has
// to create this one before its first chunk lands, and the run that discovers
// otherwise stops mid-finalise. A host's setup script should spell it from
// here rather than by hand.
export { IN_CHUNK_LABEL } from "./chunks.js";
