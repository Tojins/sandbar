// A sha256 of a value that does not depend on how its objects spell their key
// order (#190, #186). Four readers: `config-digest.ts`, which decides whether a
// daemon restarts, `stackSpecToken` in stack-source.ts, which decides
// whether a running gate stack is still the one in effect, stack-change.ts,
// which decides whether a branch changed a field of its gate stack, and
// `specTokenOf` in db-copy-policy.ts, which decides whether a database base
// was built by the server in effect (#201).
//
// Object keys are sorted before serialising; array order is kept, because in
// both readers a list's order is meaning (build order, bringup order, step
// order). `undefined` members are dropped, as `JSON.stringify` drops them, so
// an explicit `target: undefined` and an absent one hash alike.

import { createHash } from "node:crypto";

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

function canonical(value: unknown): Json {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) out[key] = canonical(member);
    }
    return out;
  }
  throw new TypeError(`canonical-json: cannot serialise a ${typeof value}`);
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
