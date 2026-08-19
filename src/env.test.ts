// The two readers of `config.env` must answer the same question (#38).
//
// They are separated by a whole run: `makeEnvReader` decides at preflight
// whether a credential is present, `resolveSandboxEnv` decides hours later
// what a container actually receives. Nothing between them re-checks, so any
// key the first accepts and the second drops is a green preflight over an
// unauthenticated agent — the failure the credential check exists to prevent,
// arrived at through the check. So the property is asserted directly, over
// every shape of declaration, rather than each reader being tested alone.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeEnvReader, resolveSandboxEnv } from "./env.js";

describe("makeEnvReader / resolveSandboxEnv", () => {
  let saved: Record<string, string | undefined>;
  const KEYS = ["SB_DECLARED", "SB_EMPTY", "SB_UNDECLARED"];

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const cases: ReadonlyArray<{
    name: string;
    env: Record<string, string>;
    host: Record<string, string>;
    key: string;
    expected: string | undefined;
  }> = [
    {
      name: "a declared literal value",
      env: { SB_DECLARED: "from-config" },
      host: {},
      key: "SB_DECLARED",
      expected: "from-config",
    },
    {
      name: "a declared literal wins over the host's",
      env: { SB_DECLARED: "from-config" },
      host: { SB_DECLARED: "from-host" },
      key: "SB_DECLARED",
      expected: "from-config",
    },
    {
      name: 'a declared-empty key inherits (the old bare `KEY=` line)',
      env: { SB_EMPTY: "" },
      host: { SB_EMPTY: "from-host" },
      key: "SB_EMPTY",
      expected: "from-host",
    },
    {
      name: "a declared-empty key the host does not set resolves to nothing",
      env: { SB_EMPTY: "" },
      host: {},
      key: "SB_EMPTY",
      expected: undefined,
    },
    // The case that was broken when #38 landed, and the reason this file
    // exists: the allowlist is what decides, so the host holding the value is
    // not enough. Reading it here and not exporting it there is the only
    // disagreement that is silent in the dangerous direction.
    {
      name: "an UNDECLARED key resolves to nothing however the host is set",
      env: {},
      host: { SB_UNDECLARED: "from-host" },
      key: "SB_UNDECLARED",
      expected: undefined,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: both readers agree`, () => {
      Object.assign(process.env, c.host);

      expect(makeEnvReader(c.env)(c.key)).toBe(c.expected);
      expect(resolveSandboxEnv(c.env)[c.key]).toBe(c.expected);
    });
  }

  it("never leaks an undeclared host variable into a container", () => {
    process.env["SB_UNDECLARED"] = "secret";

    expect(Object.keys(resolveSandboxEnv({}))).toEqual([]);
    expect(Object.keys(resolveSandboxEnv({ SB_DECLARED: "x" }))).toEqual([
      "SB_DECLARED",
    ]);
  });

  // `Object.prototype` is not a declaration. Without an own-property test the
  // allowlist would silently admit `toString`, `constructor` and friends.
  it("does not treat inherited properties as declared", () => {
    expect(makeEnvReader({})("toString")).toBeUndefined();
    expect(makeEnvReader({})("constructor")).toBeUndefined();
  });
});
