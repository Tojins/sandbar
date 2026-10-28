// The egress allowlist's pure layer (#202): what an entry allows, what the
// proxy's log says, and the podman argv that puts a proxy on an owner's
// internal network. `egress-proxy-server.ts` enforces it inside the proxy
// container and `egress.ts` drives podman on the host.
//
// IMPORTS ONLY `node:*`. The proxy image carries this file and the server
// beside it and nothing else, so an import of any other sandbar module would
// fail inside the container, not at build time.
//
// An entry's `host` is resolved: lowercased, no trailing dot, and either an
// exact name or `*.suffix`, which matches subdomains only and never the apex.
// Config resolution (presets, provider defaults, refusing IP literals) is the
// config's job; entries reach this module already in that shape.
//
// DNS is steering and logging, not enforcement: a name the allowlist knows
// resolves to the proxy for every port, and the TCP route then decides on
// (host, port). What enforces is the internal network, which gives the client
// no other peer than the proxy.
//
// Private destinations (Decision 8). The proxy resolves an allowed name itself,
// so the client cannot choose the address. An address in loopback, RFC 1918,
// link-local, CGNAT, "this network", ULA, or an IPv4-mapped form of one of
// those, is reachable only through an entry that says `private: true`;
// otherwise a hostname would turn the proxy into a door to host services and
// to other containers on podman's bridge.

import { BlockList, isIP } from "node:net";

export type EgressMode = "enforce" | "report";

export type ResolvedEgressEntry = {
  readonly host: string;
  readonly ports: readonly number[];
  readonly private: boolean;
};

export type EgressPolicy = {
  readonly mode: EgressMode;
  readonly entries: readonly ResolvedEgressEntry[];
};

// Registries are opt-in by name (Decision 6): only a consumer's hooks run them
// inside a sandbox.
export const PRESETS: Readonly<Record<string, readonly string[]>> = {
  npm: ["registry.npmjs.org"],
  packagist: ["repo.packagist.org", "packagist.org"],
};

export const GITHUB_HOSTS: readonly string[] = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "*.githubusercontent.com",
];

export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function hostMatches(pattern: string, host: string): boolean {
  return pattern.startsWith("*.")
    ? host.endsWith(pattern.slice(1))
    : host === pattern;
}

// What a connection to (host, port) may reach: nothing, public addresses only,
// or private ones too.
export type EgressReach = "refuse" | "public" | "private";

export function decide(
  entries: readonly ResolvedEgressEntry[],
  host: string,
  port: number,
): EgressReach {
  const name = normalizeHost(host);
  const matching = entries.filter((entry) =>
    entry.ports.includes(port) && hostMatches(entry.host, name)
  );
  if (matching.length === 0) return "refuse";
  return matching.some((entry) => entry.private) ? "private" : "public";
}

export function decideDns(
  entries: readonly ResolvedEgressEntry[],
  name: string,
): boolean {
  const normalized = normalizeHost(name);
  return entries.some((entry) => hostMatches(entry.host, normalized));
}

const PRIVATE_RANGES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, "ipv6");
}

// `BlockList` checks an IPv4-mapped IPv6 address against the IPv4 ranges, so
// `::ffff:10.0.0.1` and `::ffff:a00:1` need no unwrapping here.
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) throw new Error(`not an IP address: ${ip}`);
  return PRIVATE_RANGES.check(ip, family === 4 ? "ipv4" : "ipv6");
}

// ---------------------------------------------------------------------------
// The proxy's policy file and log
// ---------------------------------------------------------------------------

export const PROXY_POLICY_PATH = "/egress/policy.json";
export const PROXY_LOG_PATH = "/egress/log.jsonl";

const fail = (what: string): never => {
  throw new Error(`egress policy file: ${what}`);
};

const isPort = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;

// The proxy's one input. Sandbar writes it, but it crosses a process and a
// container boundary, so the proxy checks the shape before serving on it.
export function parseEgressPolicy(json: string): EgressPolicy {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null) return fail("not an object");
  const { mode, entries } = value as Record<string, unknown>;
  if (mode !== "enforce" && mode !== "report") return fail(`bad mode ${String(mode)}`);
  if (!Array.isArray(entries)) return fail("entries is not an array");
  return {
    mode,
    entries: entries.map((entry: unknown): ResolvedEgressEntry => {
      const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
      if (typeof e.host !== "string" || e.host === "") return fail(`bad entry ${JSON.stringify(entry)}`);
      if (!Array.isArray(e.ports) || e.ports.length === 0 || !e.ports.every(isPort)) {
        return fail(`bad ports in ${JSON.stringify(entry)}`);
      }
      if (typeof e.private !== "boolean") return fail(`bad private in ${JSON.stringify(entry)}`);
      return { host: e.host, ports: e.ports, private: e.private };
    }),
  };
}

// How the proxy came to its decision: a DNS query, the TLS SNI, the HTTP
// `Host`, first bytes that name no destination, or an allowed name whose
// addresses are all private.
export type EgressVia = "dns" | "tls" | "http" | "opaque" | "private";

export type EgressDecisionLine = {
  readonly t: "allow" | "refuse" | "would-refuse" | "upstream-error";
  readonly via: EgressVia;
  // Null only for `opaque`, which by definition named no destination.
  readonly host: string | null;
  // Null only for `dns`, which is asked before any port is.
  readonly port: number | null;
};

export type EgressLogLine = { readonly t: "ready" } | EgressDecisionLine;

const LINE_KINDS: ReadonlySet<string> = new Set([
  "ready", "allow", "refuse", "would-refuse", "upstream-error",
]);
const VIAS: ReadonlySet<string> = new Set(["dns", "tls", "http", "opaque", "private"]);

// Every line is the proxy's own output, so one that does not parse is a defect
// in the proxy rather than something to skip.
export function parseEgressLogLine(line: string): EgressLogLine {
  const value: unknown = JSON.parse(line);
  const bad = (): never => {
    throw new Error(`egress proxy wrote an unrecognised log line: ${line}`);
  };
  if (typeof value !== "object" || value === null) return bad();
  const { t, via, host, port } = value as Record<string, unknown>;
  if (typeof t !== "string" || !LINE_KINDS.has(t)) return bad();
  if (t === "ready") return { t };
  if (typeof via !== "string" || !VIAS.has(via)) return bad();
  if (host !== null && typeof host !== "string") return bad();
  if (port !== null && !isPort(port)) return bad();
  return value as EgressDecisionLine;
}

export type EgressRefusal = {
  readonly host: string | null;
  readonly port: number | null;
  readonly via: EgressVia;
  readonly enforced: boolean;
};

// Counts per destination (`host:port`, or `host` for DNS), reports only.
export type EgressCounts = Readonly<Record<string, number>>;

export type EgressTally = {
  // Destinations whose refusal has already been reported.
  readonly seen: ReadonlySet<string>;
  readonly allowed: EgressCounts;
  readonly refused: EgressCounts;
  readonly upstreamErrors: EgressCounts;
};

export const EMPTY_EGRESS_TALLY: EgressTally = {
  seen: new Set(),
  allowed: {},
  refused: {},
  upstreamErrors: {},
};

export function egressDestination(
  host: string | null,
  port: number | null,
): string {
  const name = host ?? "(no host)";
  return port === null ? name : `${name}:${port}`;
}

const bump = (counts: EgressCounts, key: string): EgressCounts => ({
  ...counts,
  [key]: (counts[key] ?? 0) + 1,
});

// Folds complete log lines into the tally a proxy's earlier drains built, and
// names the refusals sighted for the first time. A `would-refuse` is a refusal
// that was not enforced (report mode); both count as refused.
export function foldEgressLog(
  lines: readonly string[],
  tally: EgressTally,
): { readonly firstRefusals: readonly EgressRefusal[]; readonly tally: EgressTally } {
  const firstRefusals: EgressRefusal[] = [];
  const seen = new Set(tally.seen);
  let { allowed, refused, upstreamErrors } = tally;
  for (const line of lines) {
    const entry = parseEgressLogLine(line);
    if (entry.t === "ready") continue;
    const key = egressDestination(entry.host, entry.port);
    if (entry.t === "allow") allowed = bump(allowed, key);
    else if (entry.t === "upstream-error") upstreamErrors = bump(upstreamErrors, key);
    else {
      refused = bump(refused, key);
      if (!seen.has(key)) {
        seen.add(key);
        firstRefusals.push({
          host: entry.host,
          port: entry.port,
          via: entry.via,
          enforced: entry.t === "refuse",
        });
      }
    }
  }
  return { firstRefusals, tally: { seen, allowed, refused, upstreamErrors } };
}

// ---------------------------------------------------------------------------
// Podman argv
// ---------------------------------------------------------------------------

// No route out and no aardvark: the proxy is the only peer and the only DNS.
export function internalNetworkCreateArgs(name: string): string[] {
  return ["network", "create", "--internal", "--disable-dns", name];
}

// On the owner's internal network and on podman's default bridge, which is its
// way out. No env: the policy file is its whole input.
export function egressProxyRunArgs(opts: {
  readonly name: string;
  readonly internalNet: string;
  readonly image: string;
  readonly logHostPath: string;
  readonly policyHostPath: string;
}): string[] {
  return [
    "run",
    "-d",
    "--name",
    opts.name,
    "--label",
    "sandbar=true",
    "--image-volume=ignore",
    "--network",
    opts.internalNet,
    "--network",
    "podman",
    "-v",
    `${opts.policyHostPath}:${PROXY_POLICY_PATH}:ro,z`,
    "-v",
    `${opts.logHostPath}:${PROXY_LOG_PATH}:rw,z`,
    opts.image,
  ];
}

export function proxyIpInspectArgs(name: string, net: string): string[] {
  return [
    "inspect",
    "--format",
    `{{(index .NetworkSettings.Networks ${JSON.stringify(net)}).IPAddress}}`,
    name,
  ];
}

// `--dns-search .` leaves resolv.conf without a search list, so a short name is
// asked as itself rather than as a suffixed variant of an allowed name.
export function egressDnsArgs(ip: string): string[] {
  return ["--dns", ip, "--dns-search", "."];
}
