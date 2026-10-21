// What an installation's daemon would build and run, as one stable hash (#190).
//
// A daemon fixes its gate stack and image list when it imports its config, so
// a consumer change to either (an image tag rename, an added sibling, a new
// pulled tag) leaves a running daemon building the old graph while every
// per-issue sandbox is built from a source worktree that has the new one. The
// deployment play is what notices: it runs `sandbar config-digest` after it
// refreshes the consumer clone, compares the output with the digest it
// recorded, and asks for a restart through the ordinary request file (#146)
// when they differ. The daemon itself is unchanged.
//
// The input is the EVALUATED config, after `resolveConfig`, never a file: the
// config is a program that may compute its stack, and a hash of `stack.json`
// would also move for keys sandbar ignores (outdoor's `anchor`, `half`,
// `comment`). For the same reason each image is projected onto the fields of
// `BuiltImage` before hashing: `resolveImages` spreads its entries, so a key
// sandbar has no concept of would otherwise survive into the digest. The gate
// stack needs no projection — its resolved shape is built field by field.
//
// Object keys are sorted before serialising, so the digest does not depend on
// the order a config or a JSON file happens to spell them in. Array order is
// kept: images build in list order and containers come up in list order, so a
// reordering is a different graph. Nothing else is an input — an ordinary
// consumer landing must not restart the daemon (see restart-request.ts).

import { createHash } from "node:crypto";

import type { BuiltImage, ResolvedGateStack } from "./config.js";

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

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

function projectImage(image: BuiltImage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of IMAGE_FIELDS) {
    if (image[field] !== undefined) out[field] = image[field];
  }
  return out;
}

// `undefined` members are dropped, as `JSON.stringify` drops them, so an
// explicit `target: undefined` and an absent one hash alike.
function canonical(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) out[key] = canonical(member);
    }
    return out;
  }
  throw new TypeError(`config-digest: cannot serialise a ${typeof value}`);
}

// What `configDigest` hashes, exported so a test can read it: the canonical
// form of the evaluated gate stack and the projected images.
export function configDigestSubject(config: {
  readonly gateStack: ResolvedGateStack;
  readonly images: readonly BuiltImage[];
}): Json {
  return canonical({
    gateStack: config.gateStack,
    images: config.images.map(projectImage),
  });
}

export function configDigest(config: {
  readonly gateStack: ResolvedGateStack;
  readonly images: readonly BuiltImage[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify(configDigestSubject(config)))
    .digest("hex");
}
