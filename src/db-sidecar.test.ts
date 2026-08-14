import { describe, expect, it } from "vitest";

import type { ResolvedDbSidecarConfig } from "./config.js";
import {
  containerNameFor,
  dbIpForGateway,
  initMountSpec,
  networkNameFor,
  sidecarRunArgs,
} from "./db-sidecar.js";

describe("dbIpForGateway (#18)", () => {
  it("derives the next host (.2) from a .1 gateway", () => {
    expect(dbIpForGateway("10.89.0.1")).toBe("10.89.0.2");
    expect(dbIpForGateway("10.89.7.1")).toBe("10.89.7.2");
  });

  it("works regardless of the IPAM-assigned subnet (parallel issues collide-free)", () => {
    // Each parallel per-issue network gets a distinct subnet from podman's pool;
    // the helper must track whatever gateway came back, not a fixed prefix.
    expect(dbIpForGateway("10.123.45.1")).toBe("10.123.45.2");
    expect(dbIpForGateway("172.20.3.1")).toBe("172.20.3.2");
  });

  it("increments the last octet even when the gateway is not .1", () => {
    expect(dbIpForGateway("10.0.0.10")).toBe("10.0.0.11");
  });

  it("throws on a malformed gateway rather than handing back a bogus DB_HOST", () => {
    expect(() => dbIpForGateway("")).toThrow();
    expect(() => dbIpForGateway("10.0.0")).toThrow();
    expect(() => dbIpForGateway("10.0.0.1.1")).toThrow();
    expect(() => dbIpForGateway("not-an-ip")).toThrow();
    expect(() => dbIpForGateway("10.0.0.300")).toThrow();
  });

  it("throws when the last octet would overflow the /24 host range", () => {
    // .254 → .255 (broadcast) and .255 → .256 are both invalid host pins.
    expect(() => dbIpForGateway("10.0.0.254")).toThrow();
    expect(() => dbIpForGateway("10.0.0.255")).toThrow();
  });
});

describe("resource naming", () => {
  it("derives stable per-issue network and container names", () => {
    expect(networkNameFor("42")).toBe("sandbar-net-42");
    expect(containerNameFor("42")).toBe("sandbar-db-42");
  });
});

describe("initMountSpec (#20)", () => {
  it("resolves a relative hostPath against the worktree, read-only", () => {
    expect(
      initMountSpec("/work/tree", {
        hostPath: "tests/fixtures/schema.sql",
        containerPath: "/docker-entrypoint-initdb.d/schema.sql",
      }),
    ).toBe("/work/tree/tests/fixtures/schema.sql:/docker-entrypoint-initdb.d/schema.sql:ro");
  });

  it("passes an absolute hostPath through untouched", () => {
    expect(
      initMountSpec("/work/tree", {
        hostPath: "/fixtures/seed.sql",
        containerPath: "/docker-entrypoint-initdb.d/seed.sql",
      }),
    ).toBe("/fixtures/seed.sql:/docker-entrypoint-initdb.d/seed.sql:ro");
  });

  it("rejects a colon in either path — -v specs are colon-delimited", () => {
    expect(() =>
      initMountSpec("/w", { hostPath: "a:b.sql", containerPath: "/init/x.sql" }),
    ).toThrow(/must not contain ":"/);
    expect(() =>
      initMountSpec("/w", { hostPath: "a.sql", containerPath: "/init/x:y.sql" }),
    ).toThrow(/must not contain ":"/);
  });
});

describe("sidecarRunArgs (#20)", () => {
  const spec: ResolvedDbSidecarConfig = {
    image: "docker.io/library/mariadb:10.11",
    containerEnv: { MYSQL_ALLOW_EMPTY_PASSWORD: "yes", MYSQL_DATABASE: "app" },
    port: 3306,
    readinessCommand: ["mysql", "-uroot", "-e", "SELECT 1"],
    readinessTimeoutMs: 60_000,
    containerArgs: ["--sql-mode=NO_ENGINE_SUBSTITUTION"],
    initMounts: [
      { hostPath: "tests/schema.sql", containerPath: "/docker-entrypoint-initdb.d/schema.sql" },
    ],
    postReadyCommands: [],
    gateEnv: {},
  };

  it("assembles env, mounts, image, then image CMD args — in that order", () => {
    const args = sidecarRunArgs({
      containerName: "sandbar-db-42",
      networkName: "sandbar-net-42",
      dbHost: "10.89.0.2",
      spec,
      worktreePath: "/work/tree",
    });
    const imageIdx = args.indexOf(spec.image);
    expect(imageIdx).toBeGreaterThan(-1);
    // containerArgs are the image CMD: strictly after the image ref.
    expect(args.slice(imageIdx + 1)).toEqual(["--sql-mode=NO_ENGINE_SUBSTITUTION"]);
    // Everything podman-side sits before the image ref.
    expect(args.slice(0, imageIdx)).toEqual(
      expect.arrayContaining([
        "-e",
        "MYSQL_ALLOW_EMPTY_PASSWORD=yes",
        "-e",
        "MYSQL_DATABASE=app",
        "-v",
        "/work/tree/tests/schema.sql:/docker-entrypoint-initdb.d/schema.sql:ro",
        "--ip",
        "10.89.0.2",
        "--network",
        "sandbar-net-42",
        "--name",
        "sandbar-db-42",
      ]),
    );
  });

  it("omits -v flags entirely when there are no initMounts", () => {
    const args = sidecarRunArgs({
      containerName: "c",
      networkName: "n",
      dbHost: "10.0.0.2",
      spec: { ...spec, initMounts: [], containerArgs: [] },
      worktreePath: "/w",
    });
    expect(args).not.toContain("-v");
    expect(args.at(-1)).toBe(spec.image);
  });
});
