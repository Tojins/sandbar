import { describe, expect, it } from "vitest";

import {
  EMPTY_EGRESS_TALLY,
  type ResolvedEgressEntry,
  decide,
  decideDns,
  egressDnsArgs,
  egressProxyRunArgs,
  foldEgressLog,
  internalNetworkCreateArgs,
  isPrivateAddress,
  parseEgressLogLine,
  parseEgressPolicy,
  proxyIpInspectArgs,
} from "./egress-policy.js";

const entry = (
  host: string,
  ports: readonly number[] = [443, 80],
  isPrivate = false,
): ResolvedEgressEntry => ({ host, ports, private: isPrivate });

describe("decide", () => {
  const entries = [
    entry("api.anthropic.com"),
    entry("*.githubusercontent.com"),
    entry("registry.example", [8443]),
    entry("internal.test", [443], true),
  ];

  it.each([
    ["an exact host", "api.anthropic.com", 443, "public"],
    ["an exact host on its other default port", "api.anthropic.com", 80, "public"],
    ["a host differing only in case", "API.Anthropic.COM", 443, "public"],
    ["a host with a trailing dot", "api.anthropic.com.", 443, "public"],
    ["a subdomain of a wildcard", "raw.githubusercontent.com", 443, "public"],
    ["a deeper subdomain of a wildcard", "a.b.githubusercontent.com", 443, "public"],
    ["a wildcard's apex", "githubusercontent.com", 443, "refuse"],
    ["a name that only ends like a wildcard", "evilgithubusercontent.com", 443, "refuse"],
    ["a subdomain of an exact host", "x.api.anthropic.com", 443, "refuse"],
    ["an entry's extra port", "registry.example", 8443, "public"],
    ["a port the entry does not list", "registry.example", 443, "refuse"],
    ["a private entry", "internal.test", 443, "private"],
    ["an unknown host", "example.com", 443, "refuse"],
  ])("%s", (_what, host, port, reach) => {
    expect(decide(entries, host, port)).toBe(reach);
  });

  it("lets a private entry widen a public one that also matches", () => {
    expect(decide([entry("*.test"), entry("a.test", [443], true)], "a.test", 443))
      .toBe("private");
  });
});

describe("decideDns", () => {
  const entries = [entry("registry.example", [8443]), entry("*.example.org")];

  it.each([
    ["a host whatever its ports", "registry.example", true],
    ["case and a trailing dot", "Registry.Example.", true],
    ["a wildcard's subdomain", "a.example.org", true],
    ["a wildcard's apex", "example.org", false],
    ["an unknown name", "example.com", false],
  ])("%s", (_what, name, allowed) => {
    expect(decideDns(entries, name)).toBe(allowed);
  });
});

describe("isPrivateAddress", () => {
  it.each([
    ["0.0.0.0", true],
    ["10.1.2.3", true],
    ["100.64.0.1", true],
    ["100.127.255.255", true],
    ["100.128.0.1", false],
    ["127.0.0.1", true],
    ["169.254.1.2", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["8.8.8.8", false],
    ["::", true],
    ["::1", true],
    ["fd00::1", true],
    ["fc00::1", true],
    ["fe80::1", true],
    ["2606:4700::1111", false],
    ["::ffff:10.0.0.1", true],
    ["::ffff:a00:1", true],
    ["::ffff:8.8.8.8", false],
  ])("%s → %s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });

  it("refuses to classify a name", () => {
    expect(() => isPrivateAddress("example.com")).toThrow("not an IP address");
  });
});

describe("parseEgressPolicy", () => {
  it("reads back what sandbar writes", () => {
    const policy = { mode: "report", entries: [entry("a.test"), entry("b.test", [8443], true)] };
    expect(parseEgressPolicy(JSON.stringify(policy))).toEqual(policy);
  });

  it.each([
    ["a bad mode", { mode: "open", entries: [] }, "bad mode"],
    ["no entries", { mode: "enforce" }, "entries is not an array"],
    ["an empty host", { mode: "enforce", entries: [{ ...entry("a"), host: "" }] }, "bad entry"],
    ["a port out of range", { mode: "enforce", entries: [entry("a", [0])] }, "bad ports"],
    ["no ports", { mode: "enforce", entries: [entry("a", [])] }, "bad ports"],
    ["no private flag", { mode: "enforce", entries: [{ host: "a", ports: [443] }] }, "bad private"],
  ])("refuses %s", (_what, value, message) => {
    expect(() => parseEgressPolicy(JSON.stringify(value))).toThrow(message);
  });
});

describe("foldEgressLog", () => {
  const line = (value: object): string => JSON.stringify(value);

  it("reports each refused destination once across drains and counts every line", () => {
    const first = foldEgressLog([
      line({ t: "ready" }),
      line({ t: "refuse", via: "dns", host: "evil.test", port: null }),
      line({ t: "allow", via: "tls", host: "api.anthropic.com", port: 443 }),
      line({ t: "refuse", via: "dns", host: "evil.test", port: null }),
      line({ t: "refuse", via: "opaque", host: null, port: 443 }),
    ], EMPTY_EGRESS_TALLY);
    expect(first.firstRefusals).toEqual([
      { host: "evil.test", port: null, via: "dns", enforced: true },
      { host: null, port: 443, via: "opaque", enforced: true },
    ]);

    const second = foldEgressLog([
      line({ t: "refuse", via: "dns", host: "evil.test", port: null }),
      line({ t: "refuse", via: "http", host: "evil.test", port: 80 }),
      line({ t: "upstream-error", via: "tls", host: "gone.test", port: 443 }),
      line({ t: "allow", via: "tls", host: "api.anthropic.com", port: 443 }),
    ], first.tally);
    expect(second.firstRefusals).toEqual([
      { host: "evil.test", port: 80, via: "http", enforced: true },
    ]);
    expect(second.tally).toEqual({
      seen: new Set(["evil.test", "(no host):443", "evil.test:80"]),
      allowed: { "api.anthropic.com:443": 2 },
      refused: { "evil.test": 3, "(no host):443": 1, "evil.test:80": 1 },
      upstreamErrors: { "gone.test:443": 1 },
    });
  });

  // A gate run's trace names what it was refused even when an earlier run
  // sighted it first (#202, gate-stack.ts).
  it("names every destination refused in the lines it read, first sighting or not", () => {
    const first = foldEgressLog([
      line({ t: "refuse", via: "dns", host: "evil.test", port: null }),
    ], EMPTY_EGRESS_TALLY);
    expect(first.refused).toEqual(["evil.test"]);
    const second = foldEgressLog([
      line({ t: "refuse", via: "dns", host: "evil.test", port: null }),
      line({ t: "would-refuse", via: "tls", host: "x.test", port: 443 }),
      line({ t: "refuse", via: "dns", host: "evil.test", port: null }),
      line({ t: "allow", via: "tls", host: "api.anthropic.com", port: 443 }),
    ], first.tally);
    expect(second.firstRefusals).toEqual([
      { host: "x.test", port: 443, via: "tls", enforced: false },
    ]);
    expect(second.refused).toEqual(["evil.test", "x.test:443"]);
    expect(foldEgressLog([], second.tally).refused).toEqual([]);
  });

  it("reports a report-mode refusal as not enforced", () => {
    const { firstRefusals } = foldEgressLog(
      [line({ t: "would-refuse", via: "private", host: "a.test", port: 443 })],
      EMPTY_EGRESS_TALLY,
    );
    expect(firstRefusals).toEqual([{ host: "a.test", port: 443, via: "private", enforced: false }]);
  });

  it("leaves the tally it was given untouched", () => {
    foldEgressLog([line({ t: "refuse", via: "dns", host: "a.test", port: null })], EMPTY_EGRESS_TALLY);
    expect(EMPTY_EGRESS_TALLY.seen.size).toBe(0);
    expect(EMPTY_EGRESS_TALLY.refused).toEqual({});
  });

  it.each([
    ["not JSON", "{"],
    ["an unknown kind", line({ t: "maybe", via: "dns", host: "a", port: null })],
    ["an unknown via", line({ t: "refuse", via: "smtp", host: "a", port: null })],
    ["a bad port", line({ t: "refuse", via: "tls", host: "a", port: 70_000 })],
  ])("throws on a line that is %s", (_what, text) => {
    expect(() => parseEgressLogLine(text)).toThrow();
  });
});

describe("egress podman argv", () => {
  it("creates an internal network without aardvark", () => {
    expect(internalNetworkCreateArgs("sandbar-w1-net-sbx-7")).toEqual([
      "network", "create", "--internal", "--disable-dns", "sandbar-w1-net-sbx-7",
    ]);
  });

  it("runs the proxy on the owner's network and podman's bridge, with no env", () => {
    expect(egressProxyRunArgs({
      name: "sandbar-w1-egress-sbx-7",
      internalNet: "sandbar-w1-net-sbx-7",
      image: "localhost/sandbar-egress:x",
      logHostPath: "/run/egress/sbx-7.jsonl",
      policyHostPath: "/run/egress/sbx-7.policy.json",
    })).toEqual([
      "run", "-d", "--name", "sandbar-w1-egress-sbx-7",
      "--label", "sandbar=true", "--image-volume=ignore",
      "--network", "sandbar-w1-net-sbx-7", "--network", "podman",
      "-v", "/run/egress/sbx-7.policy.json:/egress/policy.json:ro,z",
      "-v", "/run/egress/sbx-7.jsonl:/egress/log.jsonl:rw,z",
      "localhost/sandbar-egress:x",
    ]);
  });

  it("pins the proxy's address on the owner's network when given one", () => {
    const args = egressProxyRunArgs({
      name: "p",
      internalNet: "sandbar-w1-net-7",
      image: "i",
      logHostPath: "/l",
      policyHostPath: "/p",
      ip: "10.89.4.2",
    });
    expect(args).toEqual(expect.arrayContaining([
      "--network", "sandbar-w1-net-7:ip=10.89.4.2", "--network", "podman",
    ]));
  });

  it("reads the proxy's address on one network", () => {
    expect(proxyIpInspectArgs("p", "sandbar-w1-net-7")).toEqual([
      "inspect", "--format", '{{(index .NetworkSettings.Networks "sandbar-w1-net-7").IPAddress}}', "p",
    ]);
  });

  it("points a client's DNS at the proxy with no search list", () => {
    expect(egressDnsArgs("10.89.3.1")).toEqual(["--dns", "10.89.3.1", "--dns-search", "."]);
  });
});
