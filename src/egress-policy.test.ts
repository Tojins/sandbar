import { describe, expect, it } from "vitest";

import {
  EMPTY_EGRESS_TALLY,
  type EgressPolicy,
  PROXY_CONNECT_PORT,
  type ProxyPolicy,
  type ResolvedEgressEntry,
  decide,
  decideConnect,
  decideDns,
  egressDnsArgs,
  egressProxyRunArgs,
  foldEgressLog,
  internalNetworkCreateArgs,
  isPrivateAddress,
  parseEgressLogLine,
  parseProxyPolicy,
  proxyAuthorization,
  proxyIpInspectArgs,
  secretProxyEnv,
} from "./egress-policy.js";

const entry = (
  host: string,
  ports: readonly number[] = [443, 80],
  isPrivate = false,
): ResolvedEgressEntry => ({ host, ports, private: isPrivate });

const policyOf = (
  entries: readonly ResolvedEgressEntry[],
  secretEntries: readonly ResolvedEgressEntry[] = [],
): EgressPolicy => ({ mode: "enforce", entries, secretEntries });

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
    expect(decide(policyOf(entries), host, port)).toBe(reach);
  });

  it("lets a private entry widen a public one that also matches", () => {
    expect(decide(policyOf([entry("*.test"), entry("a.test", [443], true)]), "a.test", 443))
      .toBe("private");
  });

  // #257: a secretAllow host is unlisted to the transparent path.
  it.each([
    ["a secret host", "api.adfinity.app", "refuse"],
    ["a secret host an allow wildcard also matches", "live.adfinity.app", "refuse"],
    ["a secret host on a port its entry lacks", "API.adfinity.app.", "refuse"],
    ["an allow host beside a secret one", "docs.adfinity.app", "public"],
  ])("%s", (_what, host, reach) => {
    const policy = policyOf(
      [entry("*.adfinity.app")],
      [entry("api.adfinity.app", [8443]), entry("live.adfinity.app")],
    );
    expect(decide(policy, host, 443)).toBe(reach);
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
    expect(decideDns(policyOf(entries), name)).toBe(allowed);
  });

  it("gives a secret host no answer, whatever allow matches", () => {
    const policy = policyOf([entry("*.adfinity.app")], [entry("api.adfinity.app")]);
    expect(decideDns(policy, "api.adfinity.app")).toBe(false);
    expect(decideDns(policy, "docs.adfinity.app")).toBe(true);
  });
});

describe("decideConnect", () => {
  const policy: ProxyPolicy = {
    ...policyOf([entry("github.com")], [entry("*.adfinity.app"), entry("db.internal", [5432], true)]),
    secret: "s3cr3t",
  };
  const good = proxyAuthorization("s3cr3t");

  it.each([
    ["a secret host with the secret", "api.adfinity.app", 443, good, "public"],
    ["a private secret entry", "db.internal", 5432, good, "private"],
    ["a secret host on a port its entry lacks", "api.adfinity.app", 8443, good, "refuse"],
    ["an allow host, which this path never reaches", "github.com", 443, good, "refuse"],
    ["no credential", "api.adfinity.app", 443, null, "unauthorized"],
    ["a wrong secret", "api.adfinity.app", 443, proxyAuthorization("guess"), "unauthorized"],
    ["the secret under another scheme", "api.adfinity.app", 443, good.replace("Basic", "Bearer"), "unauthorized"],
    ["the secret's prefix", "api.adfinity.app", 443, good.slice(0, -1), "unauthorized"],
  ])("%s", (_what, host, port, authorization, reach) => {
    expect(decideConnect(policy, { host, port, authorization })).toBe(reach);
  });

  it("refuses every credential where the owner has no secret", () => {
    expect(decideConnect({ ...policy, secret: null }, {
      host: "api.adfinity.app", port: 443, authorization: good,
    })).toBe("unauthorized");
  });
});

describe("secretProxyEnv", () => {
  it("names the authenticated listener with the secret, and keeps loopback off it", () => {
    const url = `http://sandbar:s3cr3t@10.89.3.1:${PROXY_CONNECT_PORT}`;
    expect(secretProxyEnv("s3cr3t", "10.89.3.1")).toEqual({
      HTTPS_PROXY: url,
      https_proxy: url,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    });
  });

  it("is the credential a client derives from that URL", () => {
    const { username, password } = new URL(secretProxyEnv("s3cr3t", "10.0.0.1").HTTPS_PROXY);
    expect(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`)
      .toBe(proxyAuthorization("s3cr3t"));
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

describe("parseProxyPolicy", () => {
  const valid = { mode: "enforce", entries: [], secretEntries: [], secret: null };

  it.each([
    ["without a secret", {
      mode: "report", entries: [entry("a.test"), entry("b.test", [8443], true)], secretEntries: [], secret: null,
    }],
    ["with a secret", { ...valid, secretEntries: [entry("c.test")], secret: "s3cr3t" }],
  ])("reads back what sandbar writes %s", (_what, policy) => {
    expect(parseProxyPolicy(JSON.stringify(policy))).toEqual(policy);
  });

  it.each([
    ["a bad mode", { ...valid, mode: "open" }, "bad mode"],
    ["no entries", { ...valid, entries: undefined }, "entries is not an array"],
    ["no secret entries", { ...valid, secretEntries: undefined }, "secretEntries is not an array"],
    ["an empty host", { ...valid, entries: [{ ...entry("a"), host: "" }] }, "bad entry"],
    ["a port out of range", { ...valid, entries: [entry("a", [0])] }, "bad ports"],
    ["no ports", { ...valid, secretEntries: [entry("a", [])] }, "bad ports"],
    ["no private flag", { ...valid, entries: [{ host: "a", ports: [443] }] }, "bad private"],
    ["an empty secret", { ...valid, secret: "" }, "bad secret"],
    ["no secret field", { ...valid, secret: undefined }, "bad secret"],
  ])("refuses %s", (_what, value, message) => {
    expect(() => parseProxyPolicy(JSON.stringify(value))).toThrow(message);
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

  // #257: a refused CONNECT is sighted even after a direct refusal of the
  // same destination, since it means a client tried the authenticated path.
  it("sights a refused CONNECT apart from a transparent refusal of its destination", () => {
    const first = foldEgressLog([
      line({ t: "refuse", via: "tls", host: "api.adfinity.app", port: 443 }),
      line({ t: "refuse", via: "connect", host: "api.adfinity.app", port: 443 }),
      line({ t: "refuse", via: "connect", host: "api.adfinity.app", port: 443 }),
      line({ t: "allow", via: "connect", host: "api.adfinity.app", port: 443 }),
    ], EMPTY_EGRESS_TALLY);
    expect(first.firstRefusals).toEqual([
      { host: "api.adfinity.app", port: 443, via: "tls", enforced: true },
      { host: "api.adfinity.app", port: 443, via: "connect", enforced: true },
    ]);
    expect(first.tally.refused).toEqual({ "api.adfinity.app:443": 3 });
    expect(first.tally.allowed).toEqual({ "api.adfinity.app:443": 1 });
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
