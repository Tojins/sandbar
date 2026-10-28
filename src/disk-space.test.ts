import { describe, expect, it } from "vitest";

import {
  MIN_DB_VOLUME_FREE_BYTES,
  MIN_GRAPHROOT_FREE_BYTES,
  dbVolumeSpace,
  dbVolumeSpaceIsLow,
  formatLowDbVolumeSpace,
  usedBytes,
  formatBytes,
  formatLowGraphRootSpace,
  graphRootSpace,
  graphRootSpaceIsLow,
  podmanGraphRoot,
} from "./disk-space.js";

describe("Podman graphroot space", () => {
  it("reads the graphroot from Podman rather than assuming cwd or root", async () => {
    const calls: readonly string[][] = [];
    const path = await podmanGraphRoot(async (args) => {
      (calls as string[][]).push([...args]);
      return { stdout: " /var/lib/containers/storage\n" };
    });
    expect(path).toBe("/var/lib/containers/storage");
    expect(calls).toEqual([["info", "--format", "{{.Store.GraphRoot}}"]]);
  });

  it("refuses an absent graphroot instead of measuring an unrelated path", async () => {
    await expect(podmanGraphRoot(async () => ({ stdout: "\n" })))
      .rejects.toThrow(/empty graphroot/);
  });

  it("uses blocks available to the unprivileged installation user", async () => {
    const paths: string[] = [];
    const space = await graphRootSpace("/store", async (path) => {
      paths.push(path);
      return { bavail: 7n, bsize: 4096n };
    });
    expect(paths).toEqual(["/store"]);
    expect(space).toEqual({ graphRoot: "/store", availableBytes: 28_672n });
  });

  it("has a strict fixed floor and reports exact bytes with readable GiB", () => {
    expect(graphRootSpaceIsLow({
      graphRoot: "/store",
      availableBytes: MIN_GRAPHROOT_FREE_BYTES - 1n,
    })).toBe(true);
    expect(graphRootSpaceIsLow({
      graphRoot: "/store",
      availableBytes: MIN_GRAPHROOT_FREE_BYTES,
    })).toBe(false);
    expect(formatBytes(12_589_990_707n)).toBe("12589990707 bytes (11.7 GiB)");
    expect(formatLowGraphRootSpace({ graphRoot: "/store", availableBytes: 42n }))
      .toContain("'/store' has 42 bytes (0.0 GiB) free");
  });
});

describe("database volume space", () => {
  it("measures the root with the same fixed floor kind as the graphroot", async () => {
    const space = await dbVolumeSpace("/srv/db", async () => ({ bavail: 2n, bsize: 4096n }));
    expect(space).toEqual({ root: "/srv/db", availableBytes: 8192n });
    expect(dbVolumeSpaceIsLow({ root: "/srv/db", availableBytes: MIN_DB_VOLUME_FREE_BYTES - 1n })).toBe(true);
    expect(dbVolumeSpaceIsLow({ root: "/srv/db", availableBytes: MIN_DB_VOLUME_FREE_BYTES })).toBe(false);
    expect(await usedBytes("/srv/db", async () => ({ blocks: 10n, bfree: 4n, bavail: 2n, bsize: 4096n })))
      .toBe(24_576n);
    expect(formatLowDbVolumeSpace(space)).toBe(
      "Database volume '/srv/db' has 8192 bytes (0.0 GiB) free, below sandbar's " +
        "10737418240 bytes (10.0 GiB) floor",
    );
  });
});
