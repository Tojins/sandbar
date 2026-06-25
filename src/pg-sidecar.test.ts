import { describe, expect, it } from "vitest";

import { containerNameFor, networkNameFor, pgIpForGateway } from "./pg-sidecar.js";

describe("pgIpForGateway (#18)", () => {
  it("derives the next host (.2) from a .1 gateway", () => {
    expect(pgIpForGateway("10.89.0.1")).toBe("10.89.0.2");
    expect(pgIpForGateway("10.89.7.1")).toBe("10.89.7.2");
  });

  it("works regardless of the IPAM-assigned subnet (parallel issues collide-free)", () => {
    // Each parallel per-issue network gets a distinct subnet from podman's pool;
    // the helper must track whatever gateway came back, not a fixed prefix.
    expect(pgIpForGateway("10.123.45.1")).toBe("10.123.45.2");
    expect(pgIpForGateway("172.20.3.1")).toBe("172.20.3.2");
  });

  it("increments the last octet even when the gateway is not .1", () => {
    expect(pgIpForGateway("10.0.0.10")).toBe("10.0.0.11");
  });

  it("throws on a malformed gateway rather than handing back a bogus DB_HOST", () => {
    expect(() => pgIpForGateway("")).toThrow();
    expect(() => pgIpForGateway("10.0.0")).toThrow();
    expect(() => pgIpForGateway("10.0.0.1.1")).toThrow();
    expect(() => pgIpForGateway("not-an-ip")).toThrow();
    expect(() => pgIpForGateway("10.0.0.300")).toThrow();
  });

  it("throws when the last octet would overflow the /24 host range", () => {
    // .254 → .255 (broadcast) and .255 → .256 are both invalid host pins.
    expect(() => pgIpForGateway("10.0.0.254")).toThrow();
    expect(() => pgIpForGateway("10.0.0.255")).toThrow();
  });
});

describe("resource naming", () => {
  it("derives stable per-issue network and container names", () => {
    expect(networkNameFor("42")).toBe("sandbar-net-42");
    expect(containerNameFor("42")).toBe("sandbar-pg-42");
  });
});
