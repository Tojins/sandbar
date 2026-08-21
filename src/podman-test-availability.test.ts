// The half of #48 a gate can prove about itself.
//
// The gate runner cannot observe its own wiring — the config and `dist/` it
// runs under were fixed when the run launched, so the socket mount, the env
// vars and the `podman-test` step first exist on the NEXT launch. What it can
// prove is the policy: given an unreachable podman and the require flag, does
// the suite fail rather than skip. That is the whole of #48's D4, and the
// regression it guards against is somebody restoring a two-way skip.

import { describe, expect, it } from "vitest";

import {
  type PodmanTestInputs,
  decidePodmanTests,
} from "./podman-test-availability.test-util.js";

const UNREACHABLE = { ok: false, reason: "podman unavailable" } as const;

const inputs = (over: Partial<PodmanTestInputs> = {}): PodmanTestInputs => ({
  what: "gate-stack podman tests",
  probe: { ok: true },
  skipRequested: false,
  required: false,
  needsLocalClient: false,
  clientIsLocal: true,
  ...over,
});

describe("decidePodmanTests", () => {
  it("runs when podman answered and nothing objects", () => {
    expect(decidePodmanTests(inputs()).kind).toBe("run");
  });

  // Today's behaviour on a contributor's machine, and it is deliberately kept:
  // a missing podman should not redden a suite nobody promised it to.
  it("skips an unreachable podman when it was not required", () => {
    const d = decidePodmanTests(inputs({ probe: UNREACHABLE }));
    expect(d.kind).toBe("skip");
    expect(d.kind === "skip" && d.reason).toMatch(/podman unavailable/);
  });

  // The issue itself: a silent skip in the gate is a green verdict over a layer
  // that was never exercised, which is worse than no verdict at all.
  it("FAILS an unreachable podman when it was required", () => {
    const d = decidePodmanTests(inputs({ probe: UNREACHABLE, required: true }));
    expect(d.kind).toBe("fail");
    // The message has to send its reader to the socket, which is the only
    // thing that can have broken in the gate.
    expect(d.kind === "fail" && d.reason).toMatch(/CONTAINER_HOST/);
  });

  // The second axis, and conflating it with the first makes the gate red
  // forever: the gate drives podman over a socket BY DESIGN, so a file that
  // pins what a local client does is not a file it can run.
  it("skips a local-client-only file under a remote client, even when required", () => {
    const d = decidePodmanTests(
      inputs({ needsLocalClient: true, clientIsLocal: false, required: true }),
    );
    expect(d.kind).toBe("skip");
    expect(d.kind === "skip" && d.reason).toMatch(/LOCAL/);
  });

  it("runs a local-client-only file under a local client", () => {
    expect(
      decidePodmanTests(inputs({ needsLocalClient: true, clientIsLocal: true }))
        .kind,
    ).toBe("run");
  });

  it("honours an explicit skip request when nothing required otherwise", () => {
    expect(decidePodmanTests(inputs({ skipRequested: true })).kind).toBe("skip");
  });

  // Both flags set is a run that has been told opposite things. Honouring
  // either one silently is the exact failure mode the require flag exists to
  // remove, so it is neither honoured — it is reported.
  it("fails when the skip and require flags are both set", () => {
    const d = decidePodmanTests(inputs({ skipRequested: true, required: true }));
    expect(d.kind).toBe("fail");
    expect(d.kind === "fail" && d.reason).toMatch(
      /SANDBAR_REQUIRE_PODMAN_TESTS[\s\S]*SANDBAR_SKIP_PODMAN_TESTS/,
    );
  });

  // …but the local-client axis is not a flag and is decided first: a host-only
  // file under a remote client skips whatever the flags say, or a developer
  // who set both would get a message about the wrong thing.
  it("puts the client axis ahead of the contradictory flags", () => {
    expect(
      decidePodmanTests(
        inputs({
          skipRequested: true,
          required: true,
          needsLocalClient: true,
          clientIsLocal: false,
        }),
      ).kind,
    ).toBe("skip");
  });
});
