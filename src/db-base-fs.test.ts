// The nightly base's filesystem half against a real tmpdir (#201): the
// `current` swap, the sweep, the lock and the job's no-ops before any
// container; db-base-fs-room.test.ts has its room checks and
// db-base-podman.test.ts runs the import itself.

import { lstat, mkdir, readFile, readlink, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";

import { assertDatabaseCopiesTarget, resolveDatabaseCopies, resolveGateStack } from "./config.js";
import {
  createDbBaseWatch,
  importRunArgs,
  publishBase,
  readImportStatus,
  sweepBases,
} from "./db-base.js";
import { dropDump, job, layout, makeBase, meta, plainFs, root, useDbBaseRoot } from "./db-base-fs.test-util.js";
import { type BaseMeta, type ImportStatus, SUPERSEDED_GRACE_MS } from "./db-copy-policy.js";
import type { EventInput } from "./events.js";

const readMeta = async (id: string) =>
  JSON.parse(await readFile(join(layout.bases, `${id}.json`), "utf8")) as BaseMeta;

useDbBaseRoot();

describe("importRunArgs", () => {
  it("runs the target's server on the new base alone, offline, with the import args last", () => {
    const cfg = resolveDatabaseCopies({
      dump: "/d", root: "/r", container: "db", database: "app", datadir: "/data",
      importBufferPoolBytes: 1024,
    })!;
    const [target] = resolveGateStack({
      containers: [
        {
          name: "db",
          image: "docker.io/library/mariadb:10.11",
          inSandbox: true,
          env: { MARIADB_ALLOW_EMPTY_ROOT_PASSWORD: "1" },
          args: ["--ft-min-word-len=2"],
          // The fixture schema: its init must not run on a base.
          mounts: [{ hostPath: "tests/fixtures/schema.sql", containerPath: "/docker-entrypoint-initdb.d/schema.sql" }],
          readiness: { kind: "healthcheck", command: ["healthcheck.sh", "--connect"] },
        },
        { name: "runner", image: "localhost/runner", mountWorktree: "/w", hold: true },
      ],
      steps: [{ name: "s", in: "runner", command: ["true"] }],
    }).containers;

    expect(importRunArgs("sandbar-wx-db-import", assertDatabaseCopiesTarget({ containers: [target!], steps: [] }, cfg), cfg, "/r/bases/b1"))
      .toEqual({
        argv: [
          "run", "-d", "--name", "sandbar-wx-db-import",
          "--network", "none",
          "--image-volume=ignore",
          "--label", "sandbar=true",
          "-v", "/r/bases/b1:/data:rw,z",
          "--health-cmd", JSON.stringify(["healthcheck.sh", "--connect"]), "--health-interval=disable",
          "docker.io/library/mariadb:10.11",
          "--ft-min-word-len=2",
          "--innodb-buffer-pool-size=1024",
          "--innodb-flush-log-at-trx-commit=0",
          "--skip-log-bin",
        ],
        env: { MARIADB_ALLOW_EMPTY_ROOT_PASSWORD: "1" },
      });
  });
});

describe("publishBase", () => {
  it("swaps a relative current link over the old one and stamps the base it replaced", async () => {
    const old = meta("b20261027T030000000Z");
    await makeBase(old);
    await publishBase(layout, old, null, new Date());
    // A job killed between linking and renaming left its link behind.
    await symlink("bases/stale", `${layout.current}.tmp`);

    const next = meta("b20261028T030000000Z");
    await makeBase(null, next.id);
    const at = new Date("2026-10-28T03:30:00.000Z");
    await publishBase(layout, next, old, at);

    expect((await lstat(layout.current)).isSymbolicLink()).toBe(true);
    expect(await readlink(layout.current)).toBe(`bases/${next.id}`);
    expect(await realpath(layout.current)).toBe(join(layout.bases, next.id));
    expect(await readMeta(next.id)).toEqual(next);
    expect(await readMeta(old.id)).toEqual({ ...old, supersededAt: at.toISOString() });
    expect((await readdir(root)).sort()).toEqual(["bases", "current"]);
  });
});

describe("sweepBases", () => {
  it("removes unfinished and long-superseded bases, stamps an unmarked one, and keeps current", async () => {
    const now = new Date("2026-10-28T12:00:00.000Z");
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const current = meta("b20261028T030000000Z");
    await makeBase(current);
    await publishBase(layout, current, null, now);
    await makeBase(null, "b20261028T110000000Z");
    await makeBase(meta("b20261026T030000000Z", { supersededAt: ago(SUPERSEDED_GRACE_MS) }));
    const recent = meta("b20261027T030000000Z", { supersededAt: ago(1) });
    await makeBase(recent);
    const unmarked = meta("b20261025T030000000Z");
    await makeBase(unmarked);
    await writeFile(join(layout.bases, "notes.txt"), "not a base");

    await sweepBases(layout, current.id, now, plainFs);

    expect((await readdir(layout.bases)).sort()).toEqual([
      "b20261025T030000000Z", "b20261025T030000000Z.json",
      "b20261027T030000000Z", "b20261027T030000000Z.json",
      "b20261028T030000000Z", "b20261028T030000000Z.json",
      "notes.txt",
    ]);
    expect(await readMeta(unmarked.id)).toEqual({ ...unmarked, supersededAt: now.toISOString() });
    expect(await readMeta(recent.id)).toEqual(recent);
  });
});

describe("runDbBaseJob before any container", () => {
  it("is a no-op while another job holds the lock", async () => {
    await dropDump();
    await writeFile(layout.lock, "");
    const release = await lockfile.lock(layout.lock, { retries: 0 });
    try {
      await expect(job().result).resolves.toBe("locked");
    } finally {
      await release();
    }
    expect(await readImportStatus(layout)).toBeNull();
  });

  it("does nothing while the drop is empty", async () => {
    await expect(job().result).resolves.toBe("no-dump");
    expect(await readImportStatus(layout)).toBeNull();
  });
});

describe("readImportStatus", () => {
  it("rejects a status file that is not JSON rather than reading it as absent", async () => {
    await writeFile(layout.status, "{not json");
    await expect(readImportStatus(layout)).rejects.toThrow(SyntaxError);
  });
});

describe("createDbBaseWatch, the daemon's read of the job", () => {
  const dumpPath = () => join(root, "drop/app-latest.sql.gz");
  const failed = (attempt: string): ImportStatus => ({
    attempt,
    outcome: "import-failed",
    detail: "ERROR 1062 at dump line 3",
    dump: { name: "app-latest.sql.gz", size: 1, mtimeMs: 1, ino: 1 },
    specToken: "t",
    durationMs: 1,
    finishedAt: "2026-10-28T03:00:00.000Z",
  });
  const watch = (now: number) => {
    const events: EventInput[] = [];
    const w = createDbBaseWatch({
      cfg: resolveDatabaseCopies({
        dump: dumpPath(),
        root,
        container: "db",
        database: "app",
        staleAfterMs: 60_000,
      })!,
      emit: async (event) => {
        events.push(event);
      },
      now: () => now,
    });
    return { events, observe: w.observe };
  };

  it("records each attempt once and complains once per key", async () => {
    await mkdir(join(root, "drop"));
    await writeFile(dumpPath(), "x");
    const { events, observe } = watch(Date.now() + 120_000); // wall clock: against the dump's mtime
    await writeFile(layout.status, JSON.stringify(failed("b20261028T030000000Z")));
    await observe();
    await observe();
    expect(events).toEqual([
      expect.objectContaining({ kind: "db-base", action: "import-failed", attempt: "b20261028T030000000Z" }),
      { kind: "complaint", severity: "warning", message: expect.stringMatching(/^Database copies: the dump at .* older than 0h/) },
      { kind: "complaint", severity: "warning", message: expect.stringMatching(/importing app-latest\.sql\.gz as b20261028T030000000Z failed \(ERROR 1062 at dump line 3\)/) },
    ]);

    await writeFile(layout.status, JSON.stringify(failed("b20261029T030000000Z")));
    await observe();
    expect(events.slice(3)).toEqual([
      expect.objectContaining({ kind: "db-base", attempt: "b20261029T030000000Z" }),
      { kind: "complaint", severity: "warning", message: expect.stringContaining("as b20261029T030000000Z failed") },
    ]);
  });

  it("says only that the dump is missing before any attempt", async () => {
    const { events, observe } = watch(Date.now()); // wall clock: against the dump's mtime
    await observe();
    expect(events).toEqual([
      { kind: "complaint", severity: "warning", message: `Database copies: no dump at ${dumpPath()}, so no base can be imported.` },
    ]);
  });
});
