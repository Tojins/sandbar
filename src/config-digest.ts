// What an installation's daemon would build and run, as one stable hash (#190).
//
// A daemon fixes its image list when it imports its config, so a consumer
// change to it (an image tag rename, a new built image) leaves a running daemon
// building the old graph while every per-issue sandbox is built from a source
// worktree that has the new one. The deployment play is what notices: it runs
// `sandbar config-digest` after it refreshes the consumer clone, compares the
// output with the digest it recorded, and asks for a restart through the
// ordinary request file (#146) when they differ. The daemon itself is
// unchanged.
//
// The gate stack is an input only in its inline form, which the daemon fixes
// at import like the images. The file form (`gateStack: { path }`, #186) is
// read from the source tip at every gate, so a landed change to its env,
// mounts or steps reaches the daemon without a restart, and only the path is
// hashed. A change to the image graph still restarts it: `images` is evaluated
// at import whichever form the stack takes.
//
// The input is the EVALUATED config, after `resolveConfig`, never a file: the
// config is a program that may compute its stack, and a hash of `stack.json`
// would also move for keys sandbar ignores (outdoor's `anchor`, `half`,
// `comment`). For the same reason each image is projected onto the fields of
// `BuiltImage` before hashing: `resolveImages` spreads its entries, so a key
// sandbar has no concept of would otherwise survive into the digest. The gate
// stack needs no projection — its resolved shape is built field by field.
//
// Key order does not matter (`canonical-json.ts`); array order does: images
// build in list order and containers come up in list order, so a reordering is
// a different graph. Nothing else is an input — an ordinary consumer landing
// must not restart the daemon (see restart-request.ts).

import { canonicalSha256 } from "./canonical-json.js";
import type { BuiltImage, ResolvedStackSource } from "./config.js";

// The `BuiltImage` fields, listed rather than derived from the type so that a
// new field reaching the digest is a decision made here.
const IMAGE_FIELDS = [
  "tag",
  "containerfile",
  "context",
  "target",
  "stdinContext",
  "buildArgs",
  "rebuildOn",
  "buildTimeoutMs",
] as const satisfies readonly (keyof BuiltImage)[];

type DigestInput = {
  readonly gateStack: ResolvedStackSource;
  readonly images: readonly BuiltImage[];
};

export function configDigest(config: DigestInput): string {
  return canonicalSha256({
    gateStack: config.gateStack.kind === "inline"
      ? config.gateStack.stack
      : { path: config.gateStack.path },
    images: config.images.map((image) =>
      Object.fromEntries(IMAGE_FIELDS.map((field) => [field, image[field]]))),
  });
}
