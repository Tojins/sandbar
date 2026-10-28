// How `run()` threads the egress allowlist (#202): the context it builds is
// what the inner loop's config, a gate stack and the resolve adapter are
// handed, and open egress hands them nothing.
import { describe, expect, it, vi } from "vitest";

import type { EgressContext } from "./egress.js";
import type { ResolvedConfig } from "./config.js";
import { egressOf, innerLoopConfigOf } from "./run.js";

const context = { scope: "w1", image: "egress-image", logDir: "/log/egress" } as unknown as EgressContext;

describe("egressOf", () => {
  it("gives nothing under open egress", () => {
    expect(egressOf(null, vi.fn(), "gate")).toEqual({});
  });

  it("hands an allowlist context an owner that starts proxies", async () => {
    const { egress } = egressOf(context, vi.fn(), "resolve");
    expect(egress).toBeDefined();
    expect(egress).toEqual({ start: expect.any(Function) });
  });
});

describe("innerLoopConfigOf egress", () => {
  const parts = (egress: EgressContext | null) => ({
    layout: {} as never,
    issueSource: (async () => ({})) as never,
    scope: "w1" as never,
    env: {},
    codexAuthMount: undefined,
    agentImages: {} as never,
    egress,
  });
  const config = {} as ResolvedConfig;

  it("passes the allowlist's context to the inner loop", () => {
    expect(innerLoopConfigOf(config, parts(context)).egress).toBe(context);
  });

  it("passes null under open egress", () => {
    expect(innerLoopConfigOf(config, parts(null)).egress).toBeNull();
  });
});
