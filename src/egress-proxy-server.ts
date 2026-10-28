// The egress proxy (#202), run as root in its own container on one owner's
// internal network and on podman's bridge. `egress.ts` builds its image and
// starts it; `egress-policy.ts` decides for it.
//
// IMPORTS ONLY `node:*` AND `./egress-policy.js`: the image carries those two
// files and nothing else.
//
// DNS on UDP and TCP 53. An A query for an allowed name is answered with the
// proxy's own address on the asker's subnet, TTL 5; AAAA, HTTPS, SVCB and every
// other type for an allowed name get NODATA, so a client has no IPv6 and no
// ECH to try. Any other name gets NXDOMAIN and a log line. Malformed packets
// are dropped unanswered.
//
// TCP on the union of the entries' ports. The first bytes name the
// destination: the SNI of a TLS ClientHello, or the `Host` of an HTTP request.
// Anything else (no SNI, a ClientHello split across records, a protocol where
// the server speaks first and the client waits) is refused as `opaque`. An
// allowed destination is resolved by the proxy itself, checked against the
// private ranges unless its entry allows them, connected, handed the peeked
// bytes and spliced both ways unchanged: TLS is never intercepted, so the
// client still verifies the real upstream certificate.
//
// Refusals: TLS gets a close; HTTP gets a 403 naming the host. In `report`
// mode a refusal is logged as `would-refuse` and the connection or answer goes
// ahead, except for `opaque`, which names nowhere to forward to.
//
// One JSON line per decision goes to the bind-mounted log; `{"t":"ready"}` is
// written once every listener is bound, and is what `startEgress` waits for.

import { createSocket, type RemoteInfo } from "node:dgram";
import { lookup } from "node:dns/promises";
import { openSync, readFileSync, writeSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { fileURLToPath } from "node:url";

import {
  type EgressDecisionLine,
  type EgressPolicy,
  PROXY_LOG_PATH,
  PROXY_POLICY_PATH,
  decide,
  decideDns,
  isPrivateAddress,
  normalizeHost,
  parseEgressPolicy,
} from "./egress-policy.js";

// ---------------------------------------------------------------------------
// DNS codec
// ---------------------------------------------------------------------------

const DNS_HEADER_BYTES = 12;
const DNS_TYPE_A = 1;
const DNS_CLASS_IN = 1;
const DNS_RCODE_NXDOMAIN = 3;
const DNS_ANSWER_TTL_S = 5;
// A pointer chain longer than any name could need is a loop.
const DNS_MAX_POINTER_JUMPS = 16;

export type DnsQuery = {
  readonly id: number;
  readonly flags: number;
  // As asked, case included: a resolver may check that its question comes back
  // with the case it sent.
  readonly labels: readonly string[];
  readonly type: number;
  readonly qclass: number;
};

// The labels of the name at `offset`, following compression pointers, and the
// offset just past the name where it started. Null for anything malformed.
function readName(
  packet: Buffer,
  offset: number,
): { readonly labels: string[]; readonly end: number } | null {
  const labels: string[] = [];
  let at = offset;
  let end: number | null = null;
  for (let jumps = 0; jumps <= DNS_MAX_POINTER_JUMPS;) {
    const length = packet[at];
    if (length === undefined) return null;
    if (length === 0) return { labels, end: end ?? at + 1 };
    if ((length & 0xc0) === 0xc0) {
      const low = packet[at + 1];
      if (low === undefined) return null;
      end ??= at + 2;
      at = ((length & 0x3f) << 8) | low;
      jumps++;
      continue;
    }
    if ((length & 0xc0) !== 0 || at + 1 + length > packet.length) return null;
    const label = packet.toString("latin1", at + 1, at + 1 + length);
    // A dot inside a label would read as two labels to every decision below.
    if (label.includes(".")) return null;
    labels.push(label);
    at += 1 + length;
  }
  return null;
}

// One standard query with one question; anything else is null.
export function parseDnsQuery(packet: Buffer): DnsQuery | null {
  if (packet.length < DNS_HEADER_BYTES) return null;
  const flags = packet.readUInt16BE(2);
  const isResponse = (flags & 0x8000) !== 0;
  const opcode = (flags >> 11) & 0xf;
  if (isResponse || opcode !== 0 || packet.readUInt16BE(4) !== 1) return null;
  const name = readName(packet, DNS_HEADER_BYTES);
  if (name === null || name.labels.length === 0) return null;
  if (name.end + 4 > packet.length) return null;
  return {
    id: packet.readUInt16BE(0),
    flags,
    labels: name.labels,
    type: packet.readUInt16BE(name.end),
    qclass: packet.readUInt16BE(name.end + 2),
  };
}

export function dnsQueryName(query: DnsQuery): string {
  return normalizeHost(query.labels.join("."));
}

export type DnsAnswer =
  | { readonly kind: "a"; readonly address: string }
  | { readonly kind: "nodata" }
  | { readonly kind: "nxdomain" };

export function dnsResponse(query: DnsQuery, answer: DnsAnswer): Buffer {
  const header = Buffer.alloc(DNS_HEADER_BYTES);
  header.writeUInt16BE(query.id, 0);
  // QR, AA and RA set; RD echoed; NXDOMAIN or NOERROR.
  header.writeUInt16BE(
    0x8000 | 0x0400 | 0x0080 | (query.flags & 0x0100) |
      (answer.kind === "nxdomain" ? DNS_RCODE_NXDOMAIN : 0),
    2,
  );
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answer.kind === "a" ? 1 : 0, 6);
  const question = Buffer.concat([
    ...query.labels.map((label) =>
      Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "latin1")])
    ),
    Buffer.from([0, query.type >> 8, query.type & 0xff, query.qclass >> 8, query.qclass & 0xff]),
  ]);
  if (answer.kind !== "a") return Buffer.concat([header, question]);
  const record = Buffer.alloc(16);
  record.writeUInt16BE(0xc000 | DNS_HEADER_BYTES, 0);
  record.writeUInt16BE(DNS_TYPE_A, 2);
  record.writeUInt16BE(DNS_CLASS_IN, 4);
  record.writeUInt32BE(DNS_ANSWER_TTL_S, 6);
  record.writeUInt16BE(4, 10);
  answer.address.split(".").forEach((octet, i) => record.writeUInt8(Number(octet), 12 + i));
  return Buffer.concat([header, question, record]);
}

// ---------------------------------------------------------------------------
// The destination in a connection's first bytes
// ---------------------------------------------------------------------------

export type Peek =
  | { readonly kind: "more" }
  | { readonly kind: "route"; readonly via: "tls" | "http"; readonly host: string }
  | { readonly kind: "opaque" };

const MORE: Peek = { kind: "more" };
const OPAQUE: Peek = { kind: "opaque" };

// A TLS record carries at most 2^14 bytes of plaintext; a ClientHello is never
// encrypted, so a longer first record is not one.
const TLS_MAX_RECORD_BYTES = 16_384;
const TLS_HANDSHAKE = 0x16;
const TLS_CLIENT_HELLO = 0x01;
const TLS_EXT_SERVER_NAME = 0x0000;

// The SNI of a ClientHello carried whole in the first record. Every length is
// bounds-checked, and an overrun is `opaque`, never a throw.
export function peekTlsSni(buf: Buffer): Peek {
  if (buf.length < 5) return MORE;
  if (buf[0] !== TLS_HANDSHAKE) return OPAQUE;
  const recordLength = buf.readUInt16BE(3);
  if (recordLength > TLS_MAX_RECORD_BYTES) return OPAQUE;
  if (buf.length < 5 + recordLength) return MORE;
  const record = buf.subarray(5, 5 + recordLength);
  if (record.length < 4 || record[0] !== TLS_CLIENT_HELLO) return OPAQUE;
  const helloLength = record.readUIntBE(1, 3);
  if (4 + helloLength > record.length) return OPAQUE;
  const hello = record.subarray(4, 4 + helloLength);
  // client_version (2) + random (32), then three length-prefixed vectors.
  let at = 34;
  const skip = (lengthBytes: 1 | 2): boolean => {
    if (at + lengthBytes > hello.length) return false;
    at += lengthBytes + hello.readUIntBE(at, lengthBytes);
    return at <= hello.length;
  };
  if (!skip(1) || !skip(2) || !skip(1)) return OPAQUE;
  if (at + 2 > hello.length) return OPAQUE;
  const extensionsEnd = at + 2 + hello.readUInt16BE(at);
  if (extensionsEnd > hello.length) return OPAQUE;
  at += 2;
  while (at + 4 <= extensionsEnd) {
    const type = hello.readUInt16BE(at);
    const length = hello.readUInt16BE(at + 2);
    if (at + 4 + length > extensionsEnd) return OPAQUE;
    const body = hello.subarray(at + 4, at + 4 + length);
    if (type === TLS_EXT_SERVER_NAME) {
      // server_name_list (2), then name_type (1) + host_name (2 + bytes).
      if (body.length < 5 || body[2] !== 0) return OPAQUE;
      const nameLength = body.readUInt16BE(3);
      if (5 + nameLength > body.length || nameLength === 0) return OPAQUE;
      return { kind: "route", via: "tls", host: body.toString("latin1", 5, 5 + nameLength) };
    }
    at += 4 + length;
  }
  return OPAQUE;
}

const HTTP_MAX_HEADER_BYTES = 16_384;
const HTTP_METHOD_MAX_CHARS = 16;

// The `Host` of an HTTP/1.x request, without its port.
export function peekHttpHost(buf: Buffer): Peek {
  const start = buf.toString("latin1", 0, Math.min(buf.length, HTTP_METHOD_MAX_CHARS + 1));
  const method = /^[A-Z]+/.exec(start)?.[0] ?? "";
  if (method.length === start.length) {
    return start.length <= HTTP_METHOD_MAX_CHARS ? MORE : OPAQUE;
  }
  if (method === "" || start[method.length] !== " ") return OPAQUE;
  const headerEnd = buf.indexOf("\r\n\r\n");
  if (headerEnd === -1) return buf.length < HTTP_MAX_HEADER_BYTES ? MORE : OPAQUE;
  const lines = buf.toString("latin1", 0, headerEnd).split("\r\n").slice(1);
  const value = lines
    .map((line) => /^host:[ \t]*(.*?)[ \t]*$/i.exec(line)?.[1])
    .find((host) => host !== undefined);
  if (value === undefined || value === "") return OPAQUE;
  // `[v6]:port` keeps its brackets and is refused as the IP literal it is.
  const host = value.startsWith("[") ? value : value.replace(/:\d*$/, "");
  return host === "" ? OPAQUE : { kind: "route", via: "http", host };
}

export function peekDestination(buf: Buffer): Peek {
  if (buf.length === 0) return MORE;
  return buf[0] === TLS_HANDSHAKE ? peekTlsSni(buf) : peekHttpHost(buf);
}

// The proxy's own IPv4 address on the subnet a DNS query came from: the only
// address of its own that the asker can reach.
export function addressFacing(
  source: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string | null {
  const toInt = (ip: string): number =>
    ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
  const from = toInt(source);
  for (const info of Object.values(interfaces).flat()) {
    if (info === undefined || info.family !== "IPv4" || info.internal) continue;
    const mask = toInt(info.netmask);
    // `>>> 0` keeps the AND of two 32-bit masks unsigned.
    if (((from & mask) >>> 0) === ((toInt(info.address) & mask) >>> 0)) {
      return info.address;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The program
// ---------------------------------------------------------------------------

// A client that has said nothing routable by then never will.
const PEEK_TIMEOUT_MS = 10_000;
const PEEK_MAX_BYTES = 5 + TLS_MAX_RECORD_BYTES;

async function serve(): Promise<void> {
  const policy: EgressPolicy = parseEgressPolicy(readFileSync(PROXY_POLICY_PATH, "utf8"));
  const enforce = policy.mode === "enforce";
  const refusal = enforce ? "refuse" : "would-refuse";
  const logFd = openSync(PROXY_LOG_PATH, "a");
  const record = (line: EgressDecisionLine | { readonly t: "ready" }): void => {
    writeSync(logFd, `${JSON.stringify(line)}\n`);
  };

  const answer = (packet: Buffer, source: string): Buffer | null => {
    const query = parseDnsQuery(packet);
    if (query === null) return null;
    const name = dnsQueryName(query);
    if (!decideDns(policy.entries, name)) {
      record({ t: refusal, via: "dns", host: name, port: null });
      if (enforce) return dnsResponse(query, { kind: "nxdomain" });
    }
    if (query.type !== DNS_TYPE_A) return dnsResponse(query, { kind: "nodata" });
    const address = addressFacing(source, networkInterfaces());
    return address === null ? null : dnsResponse(query, { kind: "a", address });
  };

  const udp = createSocket("udp4");
  udp.on("message", (packet: Buffer, peer: RemoteInfo) => {
    const reply = answer(packet, peer.address);
    if (reply !== null) udp.send(reply, peer.port, peer.address);
  });

  // DNS over TCP frames each message with a two-byte length.
  const dnsTcp = createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2 && pending.length >= 2 + pending.readUInt16BE(0)) {
        const length = pending.readUInt16BE(0);
        const reply = answer(pending.subarray(2, 2 + length), socket.remoteAddress ?? "");
        pending = pending.subarray(2 + length);
        if (reply === null) continue;
        const frame = Buffer.alloc(2);
        frame.writeUInt16BE(reply.length, 0);
        socket.write(Buffer.concat([frame, reply]));
      }
    });
  });

  const refuse = (socket: Socket, via: "tls" | "http", host: string): void => {
    if (via === "tls") {
      socket.destroy();
      return;
    }
    const body = `sandbar egress: ${host} is not on the allowlist\n`;
    // Resumed so the client's FIN is read and the half-open socket closes.
    socket.resume();
    socket.end(
      "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  };

  const forward = async (
    socket: Socket,
    peeked: Buffer,
    via: "tls" | "http",
    host: string,
    port: number,
  ): Promise<void> => {
    const reach = decide(policy.entries, host, port);
    // Set once this connection has been logged as refused, so a report-mode
    // forward is one `would-refuse` and not also an `allow`.
    let refused = reach === "refuse";
    if (refused) {
      record({ t: refusal, via, host, port });
      if (enforce) return refuse(socket, via, host);
    }
    // Every way a lookup can fail (no such name, a timeout, a SERVFAIL) is the
    // upstream's, and is recorded as such rather than thrown.
    const resolved = await lookup(host, { all: true, order: "ipv4first" }).then(
      (addresses) => addresses,
      () => [],
    );
    if (resolved.length === 0) {
      record({ t: "upstream-error", via, host, port });
      socket.destroy();
      return;
    }
    let candidates = reach === "public"
      ? resolved.filter((a) => !isPrivateAddress(a.address))
      : resolved;
    if (candidates.length === 0) {
      refused = true;
      record({ t: refusal, via: "private", host, port });
      if (enforce) return refuse(socket, via, host);
      candidates = resolved;
    }
    let connected = false;
    const upstream = connect({ host: candidates[0]!.address, port, allowHalfOpen: true });
    upstream.on("connect", () => {
      connected = true;
      if (!refused) record({ t: "allow", via, host, port });
      upstream.write(peeked);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => {
      if (!connected) record({ t: "upstream-error", via, host, port });
      upstream.destroy();
      socket.destroy();
    });
    socket.on("error", () => upstream.destroy());
  };

  const route = (socket: Socket, port: number): void => {
    let peeked = Buffer.alloc(0);
    let decided = false;
    const settle = (): boolean => {
      if (decided) return false;
      decided = true;
      clearTimeout(timer);
      socket.pause();
      socket.off("data", onData);
      return true;
    };
    const opaque = (): void => {
      if (!settle()) return;
      record({ t: "refuse", via: "opaque", host: null, port });
      socket.destroy();
    };
    const onData = (chunk: Buffer): void => {
      peeked = Buffer.concat([peeked, chunk]);
      const peek = peekDestination(peeked);
      if (peek.kind === "more" && peeked.length < PEEK_MAX_BYTES) return;
      if (peek.kind !== "route") return opaque();
      settle();
      void forward(socket, peeked, peek.via, peek.host, port);
    };
    const timer = setTimeout(opaque, PEEK_TIMEOUT_MS);
    socket.on("data", onData);
    socket.on("error", () => {
      settle();
      socket.destroy();
    });
    socket.on("end", opaque);
  };

  const ports = [...new Set(policy.entries.flatMap((entry) => entry.ports))];
  const listen = (server: ReturnType<typeof createServer>, port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", resolve);
    });
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(53, "0.0.0.0", resolve);
    }),
    listen(dnsTcp, 53),
    ...ports.map((port) =>
      listen(createServer({ allowHalfOpen: true }, (socket) => route(socket, port)), port)
    ),
  ]);
  record({ t: "ready" });
}

// Only as the image's entrypoint; the unit tests import the codecs above.
if (process.argv[1] === fileURLToPath(import.meta.url)) await serve();

