// The nightly base's filesystem half against a real tmpdir (#201): the
// `current` swap, the sweep, the lock and the refusals that come before any
// container. Plain `rm`/`du` stand in for `podman unshare`, since nothing here
// is subuid-owned; db-base-podman.test.ts runs the import itself.

import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertDatabaseCopiesTarget, resolveDatabaseCopies, resolveGateStack } from "./config.js";
import {
  type DbBaseJobOptions,
  type UsernsRun,
  createDbBaseWatch,
  dbBaseLayout,
  publishBase,
  readImportStatus,
  runDbBaseJob,
  sweepBases,
} from "./db-base.js";
import { type BaseMeta, type ImportStatus, SUPERSEDED_GRACE_MS } from "./db-copy-policy.js";
import type { EventInput } from "./events.js";

const exec = promisify(execFile);
const plainFs: UsernsRun = async ([command, ...args]) => (await exec(command!, args)).stdout;

const meta = (id: string, over: Partial<BaseMeta> = {}): BaseMeta => ({
  id,
  dump: { name: "app.sql.gz", size: 1, mtimeMs: 1, ino: 1 },
  specToken: "t",
  database: "app",
  image: "docker.io/library/mariadb:10.11",
  importedAt: "2026-10-27T03:00:00.000Z",
  durationMs: 1,
  baseBytes: 1,
  ...over,
});

let root: string;
let layout: ReturnType<typeof dbBaseLayout>;
const readMeta = async (id: string) =>
  JSON.parse(await readFile(join(layout.bases, `${id}.json`), "utf8")) as BaseMeta;
const makeBase = async (m: BaseMeta | null, id = m?.id) => {
  await mkdir(join(layout.bases, id!, "mysql"), { recursive: true });
  if (m !== null) await writeFile(join(layout.bases, `${id}.json`), JSON.stringify(m));
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sandbar-db-base-")));
  layout = dbBaseLayout(root);
  await mkdir(layout.bases);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("publishBase", () => {
  it("swaps a relative current link over the old one and stamps the base it replaced", async () => {
    const old = meta("b20261027T030000000Z");
    await makeBase(old);
    await publishBase(layout, old, null, new Date());
    // A job killed between linking and renaming left its link behind.
    await writeFile(`${layout.current}.tmp`, "");

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
  const target = assertDatabaseCopiesTarget(
    resolveGateStack({
      containers: [
        {
          name: "db",
          image: "docker.io/library/mariadb:10.11",
          inSandbox: true,
          readiness: { kind: "healthcheck", command: ["healthcheck.sh"] },
        },
        { name: "runner", image: "localhost/runner", mountWorktree: "/w", hold: true },
      ],
      steps: [{ name: "s", in: "runner", command: ["true"] }],
    }),
    resolveDatabaseCopies({ dump: "/d", root: "/r", container: "db", database: "app" })!,
  );
  const job = (over: Partial<DbBaseJobOptions> = {}) => {
    const lines: string[] = [];
    const result = runDbBaseJob({
      cfg: resolveDatabaseCopies({
        dump: join(root, "drop/app-latest.sql.gz"),
        root,
        container: "db",
        database: "app",
      })!,
      target,
      force: false,
      log: (line) => lines.push(line),
      userns: plainFs,
      freeBytes: async () => 0n,
      ...over,
    });
    return { result, lines };
  };
  const dropDump = async () => {
    await mkdir(join(root, "drop"), { recursive: true });
    await writeFile(join(root, "drop/app-latest.sql.gz"), "not even gzip");
  };

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

  it("does nothing while the drop is empty", async () => {
    await expect(job().result).resolves.toBe("no-dump");
    expect(await readImportStatus(layout)).toBeNull();
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
    const { events, observe } = watch(Date.now() + 120_000);
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
    const { events, observe } = watch(Date.now());
    await observe();
    expect(events).toEqual([
      { kind: "complaint", severity: "warning", message: `Database copies: no dump at ${dumpPath()}, so no base can be imported.` },
    ]);
  });
});
