import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { connect as tlsConnect } from "node:tls";

import { describe, expect, it } from "vitest";

import {
  addressFacing,
  dnsQueryName,
  dnsResponse,
  parseDnsQuery,
  peekConnect,
  peekDestination,
  peekHttpHost,
  peekTlsSni,
} from "./egress-proxy-server.js";

// A standard recursive query: id, RD set, one question.
const query = (name: Buffer, type: number, id = 0x1234): Buffer =>
  Buffer.concat([
    Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]),
    name,
    Buffer.from([type >> 8, type & 0xff, 0, 1]),
  ]);

const encodeName = (name: string): Buffer =>
  Buffer.concat([
    ...name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0]),
  ]);

describe("DNS codec", () => {
  it("answers an A query with one record pointing back at the question", () => {
    const parsed = parseDnsQuery(query(encodeName("Api.Anthropic.com"), 1));
    expect(parsed).toEqual({
      id: 0x1234, flags: 0x0100, labels: ["Api", "Anthropic", "com"], type: 1, qclass: 1,
    });
    expect(dnsQueryName(parsed!)).toBe("api.anthropic.com");

    const reply = dnsResponse(parsed!, { kind: "a", address: "10.89.3.1" });
    expect(reply.readUInt16BE(0)).toBe(0x1234);
    // QR, AA, RD echoed, RA; NOERROR.
    expect(reply.readUInt16BE(2)).toBe(0x8580);
    expect([reply.readUInt16BE(4), reply.readUInt16BE(6)]).toEqual([1, 1]);
    // The question comes back with the case it was asked in.
    const question = query(encodeName("Api.Anthropic.com"), 1).subarray(12);
    expect(reply.subarray(12, 12 + question.length)).toEqual(question);
    expect([...reply.subarray(12 + question.length)]).toEqual([
      0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 5, 0, 4, 10, 89, 3, 1,
    ]);
  });

  it("answers NODATA with no records and NXDOMAIN with rcode 3", () => {
    const parsed = parseDnsQuery(query(encodeName("a.test"), 28))!;
    const nodata = dnsResponse(parsed, { kind: "nodata" });
    expect(nodata.readUInt16BE(2) & 0x000f).toBe(0);
    expect(nodata.readUInt16BE(6)).toBe(0);
    const nxdomain = dnsResponse(parsed, { kind: "nxdomain" });
    expect(nxdomain.readUInt16BE(2) & 0x000f).toBe(3);
    expect(nxdomain.readUInt16BE(6)).toBe(0);
  });

  it("follows a compression pointer in the question", () => {
    // "a" then a pointer to the "test" label at offset 12.
    const packet = Buffer.concat([
      Buffer.from([0, 7, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]),
      Buffer.from([1, 0x61, 0xc0, 0x0e]),
      Buffer.from([0, 1, 0, 1]),
    ]);
    // Offset 14 is the pointer itself, so it loops; a pointer to 12 reads "a" again.
    expect(parseDnsQuery(packet)).toBeNull();
    const named = Buffer.concat([
      Buffer.from([0, 7, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]),
      Buffer.from([1, 0x61, 0xc0, 0x14]),
      Buffer.from([0, 1, 0, 1]),
      Buffer.from([4, ...Buffer.from("test"), 0]),
    ]);
    expect(parseDnsQuery(named)?.labels).toEqual(["a", "test"]);
    expect(parseDnsQuery(named)?.type).toBe(1);
  });

  it.each([
    ["shorter than a header", Buffer.from([0, 1, 0])],
    ["truncated in the name", query(encodeName("a.test"), 1).subarray(0, 16)],
    ["truncated before its type", query(encodeName("a.test"), 1).subarray(0, 20)],
    ["a response", (() => {
      const packet = query(encodeName("a.test"), 1);
      packet[2] = 0x81;
      return packet;
    })()],
    ["two questions", (() => {
      const packet = query(encodeName("a.test"), 1);
      packet[5] = 2;
      return packet;
    })()],
    ["the root name", query(Buffer.from([0]), 1)],
  ])("drops a packet that is %s", (_what, packet) => {
    expect(parseDnsQuery(packet)).toBeNull();
  });
});

// The first bytes Node's TLS client sends, captured by a plain TCP listener.
async function captureClientHello(servername?: string): Promise<Buffer> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const received = new Promise<Buffer>((resolve) => {
      server.once("connection", (socket) => {
        let bytes = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length >= 5 && bytes.length >= 5 + bytes.readUInt16BE(3)) {
            socket.destroy();
            resolve(bytes);
          }
        });
      });
    });
    const client = tlsConnect({
      host: "127.0.0.1",
      port,
      ...(servername === undefined ? {} : { servername }),
      rejectUnauthorized: false,
    });
    client.on("error", () => client.destroy());
    const hello = await received;
    client.destroy();
    return hello;
  } finally {
    server.close();
  }
}

describe("peekTlsSni", () => {
  it("reads the SNI of a whole ClientHello", async () => {
    const hello = await captureClientHello("allowed.test");
    expect(peekTlsSni(hello)).toEqual({ kind: "route", via: "tls", host: "allowed.test" });
    expect(peekDestination(hello)).toEqual({ kind: "route", via: "tls", host: "allowed.test" });
  });

  it("asks for more until the record is whole", async () => {
    const hello = await captureClientHello("allowed.test");
    expect(peekTlsSni(hello.subarray(0, 3))).toEqual({ kind: "more" });
    expect(peekTlsSni(hello.subarray(0, 100))).toEqual({ kind: "more" });
    expect(peekTlsSni(Buffer.concat([hello.subarray(0, 100), hello.subarray(100)])))
      .toEqual({ kind: "route", via: "tls", host: "allowed.test" });
  });

  it("calls a ClientHello without SNI opaque", async () => {
    expect(peekTlsSni(await captureClientHello())).toEqual({ kind: "opaque" });
  });

  it("calls a corrupted ClientHello opaque rather than throwing", async () => {
    const hello = await captureClientHello("allowed.test");
    const corrupt = Buffer.from(hello);
    // The handshake length now claims more than the record holds.
    corrupt.writeUIntBE(0xffffff, 6, 3);
    expect(peekTlsSni(corrupt)).toEqual({ kind: "opaque" });
    expect(peekTlsSni(Buffer.from([0x16, 3, 1, 0xff, 0xff]))).toEqual({ kind: "opaque" });
    expect(peekTlsSni(Buffer.from([0x16, 3, 1, 0, 4, 1, 0, 0, 0]))).toEqual({ kind: "opaque" });
  });
});

describe("peekHttpHost", () => {
  const http = (text: string): Buffer => Buffer.from(text, "latin1");

  it.each([
    ["a Host with a port", "GET / HTTP/1.1\r\nHost: Example.com:8080\r\n\r\n", "Example.com"],
    ["a Host among other headers", "POST /x HTTP/1.1\r\nUser-Agent: t\r\nhost:a.test\r\nX: y\r\n\r\nbody", "a.test"],
    ["a bracketed IPv6 literal", "GET / HTTP/1.1\r\nHost: [::1]:80\r\n\r\n", "[::1]:80"],
  ])("routes %s", (_what, text, host) => {
    expect(peekHttpHost(http(text))).toEqual({ kind: "route", via: "http", host });
  });

  it.each([
    ["a method still arriving", "GE"],
    ["headers still arriving", "GET / HTTP/1.1\r\nHost: a.test\r\n"],
  ])("asks for more on %s", (_what, text) => {
    expect(peekHttpHost(http(text))).toEqual({ kind: "more" });
  });

  it.each([
    ["no Host", "GET / HTTP/1.0\r\n\r\n"],
    ["an empty Host", "GET / HTTP/1.1\r\nHost: \r\n\r\n"],
    ["a lowercase method", "get / HTTP/1.1\r\nHost: a.test\r\n\r\n"],
    ["a method with no space after it", "GET\r\nHost: a.test\r\n\r\n"],
    ["a method longer than any", `${"A".repeat(17)} / HTTP/1.1\r\n\r\n`],
    ["binary", "\u0000\u0001\u0002"],
  ])("calls %s opaque", (_what, text) => {
    expect(peekHttpHost(http(text))).toEqual({ kind: "opaque" });
  });

  it("calls an empty peek incomplete, not opaque", () => {
    expect(peekDestination(Buffer.alloc(0))).toEqual({ kind: "more" });
  });
});

describe("peekConnect", () => {
  const bytes = (text: string): Buffer => Buffer.from(text, "latin1");

  it.each([
    ["a credential", "CONNECT api.adfinity.app:443 HTTP/1.1\r\nHost: api.adfinity.app:443\r\n" +
      "Proxy-Authorization: Basic c2FuZGJhcjp4\r\n\r\n", "api.adfinity.app", 443, "Basic c2FuZGJhcjp4"],
    ["a lowercase header name", "CONNECT a.test:8443 HTTP/1.0\r\nproxy-authorization:  Basic x \r\n\r\n",
      "a.test", 8443, "Basic x"],
    ["no credential", "CONNECT a.test:443 HTTP/1.1\r\n\r\n", "a.test", 443, null],
    ["a bracketed IPv6 literal", "CONNECT [::1]:443 HTTP/1.1\r\n\r\n", "[::1]", 443, null],
  ])("routes a request with %s", (_what, text, host, port, authorization) => {
    expect(peekConnect(bytes(text))).toEqual({
      kind: "route", request: { host, port, authorization }, rest: Buffer.alloc(0),
    });
  });

  it("keeps what the client sent past the request head", () => {
    const peek = peekConnect(bytes("CONNECT a.test:443 HTTP/1.1\r\n\r\n\u0016\u0003\u0001"));
    expect(peek.kind === "route" && [...peek.rest]).toEqual([0x16, 0x03, 0x01]);
  });

  it("asks for more while the head is still arriving", () => {
    expect(peekConnect(bytes("CONNECT a.test:443 HTTP/1.1\r\n"))).toEqual({ kind: "more" });
  });

  it.each([
    ["a GET", "GET http://a.test/ HTTP/1.1\r\nHost: a.test\r\n\r\n"],
    ["no port", "CONNECT a.test HTTP/1.1\r\n\r\n"],
    ["port zero", "CONNECT a.test:0 HTTP/1.1\r\n\r\n"],
    ["a port out of range", "CONNECT a.test:70000 HTTP/1.1\r\n\r\n"],
    ["an unbracketed IPv6 literal", "CONNECT ::1:443 HTTP/1.1\r\n\r\n"],
    ["no version", "CONNECT a.test:443\r\n\r\n"],
    ["a head longer than any", `CONNECT a.test:443 HTTP/1.1\r\nX: ${"a".repeat(16_384)}`],
  ])("calls %s opaque", (_what, text) => {
    expect(peekConnect(bytes(text))).toEqual({ kind: "opaque" });
  });
});

describe("addressFacing", () => {
  const iface = (address: string, netmask: string, internal = false): NetworkInterfaceInfo => ({
    address, netmask, family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: null,
  });
  const interfaces = {
    lo: [iface("127.0.0.1", "255.0.0.0", true)],
    eth0: [iface("10.89.3.1", "255.255.255.0")],
    eth1: [iface("10.88.0.2", "255.255.0.0")],
  };

  it.each([
    ["the internal network", "10.89.3.7", "10.89.3.1"],
    ["podman's bridge", "10.88.200.9", "10.88.0.2"],
    ["no subnet of its own", "192.168.1.1", null],
  ])("answers an asker on %s", (_what, source, expected) => {
    expect(addressFacing(source, interfaces)).toBe(expected);
  });
});
