// The db-base job's room checks before any container (#201): an import the
// volume has no room for is refused, sized from the current base.

import { readdir, readlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { publishBase, readImportStatus } from "./db-base.js";
import { dropDump, job, layout, makeBase, meta, useDbBaseRoot } from "./db-base-fs.test-util.js";
import { importSpaceNeeded } from "./db-copy-policy.js";

useDbBaseRoot();

describe("runDbBaseJob's room for an import", () => {
  it("refuses an import the volume has no room for, and does not retry that dump without --force", async () => {
    await dropDump();
    const current = meta("b20261027T030000000Z");
    await makeBase(current);
    await publishBase(layout, current, null, new Date());

    const first = job();
    await expect(first.result).resolves.toBe("import-failed");
    const status = await readImportStatus(layout);
    expect(status).toMatchObject({ outcome: "import-failed", detail: "insufficient-space" });
    expect(first.lines).toEqual([
      expect.stringMatching(/^db-base: importing app-latest\.sql\.gz as b\d{8}T\d{9}Z failed: insufficient-space$/),
    ]);
    // Nothing was created, and current stands.
    expect((await readdir(layout.bases)).sort()).toEqual([current.id, `${current.id}.json`]);
    expect(await readlink(layout.current)).toBe(`bases/${current.id}`);

    await expect(job().result).resolves.toBe("up-to-date");
    await expect(job({ force: true }).result).resolves.toBe("import-failed");
    expect((await readImportStatus(layout))!.attempt).not.toBe(status!.attempt);
  });

  it("sizes the room needed from the current base, not from the dump", async () => {
    await dropDump();
    const current = meta("b20261027T030000000Z", { baseBytes: 1_000_000_000 });
    await makeBase(current);
    await publishBase(layout, current, null, new Date());
    const needed = importSpaceNeeded(current.baseBytes, 13);
    // Room for a base grown from the dump alone, but not one the size of the last.
    expect(needed).toBeGreaterThan(importSpaceNeeded(null, 13));
    await expect(job({ freeBytes: async () => needed - 1n }).result).resolves.toBe("import-failed");
    expect(await readImportStatus(layout)).toMatchObject({ detail: "insufficient-space" });
  });
});
