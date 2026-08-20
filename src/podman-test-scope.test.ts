// The one part of #47 a gate with no podman can see.
//
// Everything else the issue buys is asserted by running two copies of a podman
// test file concurrently and watching both pass, which the gate structurally
// cannot do. This catches the one realistic regression that would silently
// give it all back: somebody restoring a constant "for reproducibility".

import { describe, expect, it } from "vitest";

import { podmanTestScope } from "./podman-test-scope.test-util.js";

describe("podmanTestScope", () => {
  it("gives every call its own scope and its own fixture tags", () => {
    const a = podmanTestScope("x");
    const b = podmanTestScope("x");

    // Per CALL, not per file: a module-level const would draw its uniqueness
    // from vitest's per-file isolation, which `--no-isolate` removes.
    expect(a.scope).not.toBe(b.scope);
    expect(a.testImageTag("probe")).not.toBe(b.testImageTag("probe"));

    // The sibling scope is a scope the sweeps must be blind to, so it must not
    // be the process's own — nor another process's, which is why it is derived
    // from the same token rather than hardcoded.
    expect(a.otherScope).not.toBe(a.scope);
    expect(a.otherScope).not.toBe(b.otherScope);
  });
});
