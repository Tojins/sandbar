import { describe, expect, it } from "vitest";

import { resolveDatabaseCopies, resolveGateStack } from "./config.js";
import {
  type BaseMeta,
  type DbCopyHolder,
  type DumpIdentity,
  type ImportStatus,
  SUPERSEDED_GRACE_MS,
  baseIdAt,
  BASE_ID_RE,
  baseCompatible,
  basesToSweep,
  dbBaseComplaints,
  dbBaseEventOf,
  dbCopyHolderFor,
  importNeeded,
  importSpaceNeeded,
  planAlign,
  sanitizeImportError,
  specTokenOf,
  withDbCopy,
} from "./db-copy-policy.js";
import { MIN_DB_VOLUME_FREE_BYTES } from "./disk-space.js";
import type { LoopAction } from "./inner-loop-machine.js";

const dump: DumpIdentity = { name: "app-latest.sql.gz", size: 1000, mtimeMs: 1_700_000_000_000, ino: 42 };

const status = (over: Partial<DumpIdentity> = {}, token = "t1"): ImportStatus => ({
  attempt: "b20261028T030000000Z",
  outcome: "import-failed",
  detail: "not-ready",
  dump: { ...dump, ...over },
  specToken: token,
  durationMs: 5,
  finishedAt: "2026-10-28T03:00:05.000Z",
});

const db = (over: { image?: string; args?: string[]; env?: Record<string, string> } = {}) =>
  resolveGateStack({
    containers: [
      {
        name: "db",
        image: over.image ?? "docker.io/library/mariadb:10.11",
        args: over.args ?? ["--ft-min-word-len=2"],
        env: over.env ?? { TZ: "UTC" },
      },
      { name: "runner", image: "localhost/runner", mountWorktree: "/w", hold: true },
    ],
    steps: [{ name: "s", in: "runner", command: ["true"] }],
  }).containers[0]!;

describe("specTokenOf", () => {
  it("ignores env, so a branch's env overlay keeps the base", () => {
    expect(specTokenOf(db({ env: { TZ: "Europe/Brussels" } }))).toBe(specTokenOf(db()));
  });

  it("differs on image or args", () => {
    expect(specTokenOf(db({ image: "docker.io/library/mariadb:11.4" }))).not.toBe(specTokenOf(db()));
    expect(specTokenOf(db({ args: [] }))).not.toBe(specTokenOf(db()));
  });
});

describe("importNeeded", () => {
  it.each<[string, ImportStatus | null, boolean, boolean]>([
    ["with no attempt yet", null, false, true],
    ["for the same dump and token after a success", { ...status(), outcome: "imported", baseBytes: 9 }, false, false],
    ["for the same dump and token after a failure", status(), false, false],
    ["with --force over the same failure", status(), true, true],
    ["for a dump renamed into place since", status({ ino: 43 }), false, true],
    ["for a dump with a new mtime", status({ mtimeMs: 1 }), false, true],
    ["for a dump with a new size", status({ size: 1 }), false, true],
    ["after the target's server changed", status({}, "t0"), false, true],
  ])("%s", (_, last, force, needed) => {
    expect(importNeeded(last, dump, "t1", force)).toBe(needed);
  });
});

describe("baseIdAt", () => {
  it("is a sortable compact UTC timestamp", () => {
    const id = baseIdAt(new Date("2026-10-28T18:05:12.123Z"));
    expect(id).toBe("b20261028T180512123Z");
    expect(id).toMatch(BASE_ID_RE);
  });
});

describe("basesToSweep", () => {
  const now = Date.parse("2026-10-28T12:00:00.000Z");
  const meta = (id: string, supersededAt?: string): BaseMeta => ({
    id,
    dump,
    specToken: "t1",
    database: "app",
    image: "docker.io/library/mariadb:10.11",
    importedAt: "2026-10-27T03:00:00.000Z",
    durationMs: 1,
    baseBytes: 1,
    ...(supersededAt === undefined ? {} : { supersededAt }),
  });
  const at = (msBefore: number) => new Date(now - msBefore).toISOString();

  it("removes unfinished and long-superseded bases, stamps unmarked ones, and never touches current", () => {
    expect(basesToSweep([
      { id: "current", meta: meta("current") },
      { id: "unfinished", meta: null },
      { id: "old", meta: meta("old", at(SUPERSEDED_GRACE_MS)) },
      { id: "recent", meta: meta("recent", at(SUPERSEDED_GRACE_MS - 1)) },
      { id: "unmarked", meta: meta("unmarked") },
    ], "current", now)).toEqual({ remove: ["unfinished", "old"], stamp: ["unmarked"] });
  });

  it("keeps a current base even without meta", () => {
    expect(basesToSweep([{ id: "current", meta: null }], "current", now))
      .toEqual({ remove: [], stamp: [] });
  });
});

describe("importSpaceNeeded", () => {
  it("is a quarter more than the previous base, rounded up, plus the floor", () => {
    expect(importSpaceNeeded(8, 1)).toBe(10n + MIN_DB_VOLUME_FREE_BYTES);
    expect(importSpaceNeeded(9, 1)).toBe(12n + MIN_DB_VOLUME_FREE_BYTES);
  });

  it("is twenty times the dump plus the floor with no base to go by", () => {
    expect(importSpaceNeeded(null, 1000)).toBe(20_000n + MIN_DB_VOLUME_FREE_BYTES);
  });
});

describe("sanitizeImportError", () => {
  it.each([
    [
      "ERROR 1062 (23000) at line 412: Duplicate entry 'jane@example.com' for key 'email'\n",
      "ERROR 1062 at dump line 412",
    ],
    [
      "mariadb: Deprecated program name.\nERROR 1366 (22007) at line 7: Incorrect string value: '\\xF0\\x9F' for column 'note' at row 3\n",
      "ERROR 1366 at dump line 7",
    ],
    ["ERROR 2013 (HY000): Lost connection to server during query\n", "ERROR 2013"],
    ["Segmentation fault 'row value'\n", "client-failed"],
    ["", "client-failed"],
  ])("keeps only the code and line of %j", (stderr, detail) => {
    expect(sanitizeImportError(stderr)).toBe(detail);
    expect(detail).not.toMatch(/'/);
  });
});

describe("dbBaseComplaints", () => {
  const now = dump.mtimeMs + 10_000;
  const complaints = (over: Partial<Parameters<typeof dbBaseComplaints>[0]>) =>
    dbBaseComplaints({
      status: null,
      drop: dump,
      dumpPath: "/srv/drops/app/app-latest.sql.gz",
      now,
      staleAfterMs: 10_000,
      ...over,
    });

  it("says nothing for a fresh dump and a good import", () => {
    expect(complaints({ status: { ...status(), outcome: "imported", baseBytes: 1 } })).toEqual([]);
  });

  it("complains about a missing dump", () => {
    expect(complaints({ drop: null })).toEqual([{
      key: "dump-missing",
      message: "Database copies: no dump at /srv/drops/app/app-latest.sql.gz, so no base can be imported.",
    }]);
  });

  it("complains about a dump past the threshold, keyed by the dump", () => {
    expect(complaints({ now: now + 1 })).toEqual([{
      key: `dump-stale:42:${dump.mtimeMs}`,
      message: expect.stringMatching(/^Database copies: the dump at \/srv\/drops\/app\/app-latest\.sql\.gz is from 2023-11-14T22:13:20\.000Z, older than 0h/),
    }]);
  });

  it("complains about a failed import, keyed by its attempt and naming its reason code", () => {
    expect(complaints({ status: status() })).toEqual([{
      key: "import-failed:b20261028T030000000Z",
      message: "Database copies: importing app-latest.sql.gz as b20261028T030000000Z failed " +
        "(not-ready); the previous base stays current.",
    }]);
  });
});

describe("dbBaseEventOf", () => {
  it("carries a failure's detail and a success's size, and nothing else", () => {
    expect(dbBaseEventOf(status())).toEqual({
      kind: "db-base", action: "import-failed", attempt: "b20261028T030000000Z", dump, durationMs: 5, detail: "not-ready",
    });
    expect(dbBaseEventOf({ ...status(), outcome: "imported", baseBytes: 7 })).toEqual({
      kind: "db-base", action: "imported", attempt: "b20261028T030000000Z", dump, durationMs: 5, baseBytes: 7,
    });
  });
});

const cfg = resolveDatabaseCopies({
  dump: "/srv/drops/app/app-latest.sql.gz",
  root: "/srv/installations/app",
  container: "db",
  database: "app",
  bufferPoolBytes: 64 * 1024 * 1024,
})!;

describe("dbCopyHolderFor", () => {
  // One action of every other kind; only the kind is read.
  const kinds: readonly [Exclude<LoopAction["kind"], "run-verifier">, DbCopyHolder | null][] = [
    ["run-anchor-condense", null],
    ["run-partition-check", null],
    ["run-ui-check", null],
    ["start-scenario-writer", null],
    ["run-implementer", "implementer"],
    ["run-quality-list", null],
    ["run-quality-fix", null],
    ["run-quality-verify", null],
    ["run-gate", null],
    ["await-scenario-writer", null],
    ["run-adjudicator", null],
    ["terminate", null],
  ];

  it.each(kinds)("%s is held by %s", (kind, holder) => {
    expect(dbCopyHolderFor({ kind } as LoopAction)).toBe(holder);
  });

  // #180: the scenario runner holds one only in a round that runs scenarios.
  it("gives a verifier round's copy to its scenario runner, and none to the white-box review alone", () => {
    const set = {
      version: 1,
      issue: 1,
      seed: { ref: "origin/main", sha: "seed" },
      writer: { provider: "claude", model: "opus", effort: null },
      scenarios: [],
    } as const;
    expect(dbCopyHolderFor({ kind: "run-verifier", attempt: 1, scenarios: set })).toBe("scenario-runner");
    expect(dbCopyHolderFor({ kind: "run-verifier", attempt: 1, scenarios: null })).toBeNull();
  });
});

describe("planAlign", () => {
  it.each<[DbCopyHolder | null, DbCopyHolder | null, boolean, DbCopyHolder | null]>([
    [null, null, false, null],
    [null, "implementer", false, "implementer"],
    ["implementer", "implementer", false, null],
    ["implementer", null, true, null],
    ["implementer", "scenario-runner", true, "scenario-runner"],
    ["scenario-runner", "implementer", true, "implementer"],
    ["scenario-runner", "scenario-runner", true, "scenario-runner"],
  ])("%s -> %s drops %s and acquires %s", (current, desired, drop, acquire) => {
    expect(planAlign(current, desired)).toEqual({ drop, acquire });
  });

  it("re-acquires for an implementer round that follows another action", () => {
    const steps: (DbCopyHolder | null)[] = ["implementer", null, null, "implementer"];
    let current: DbCopyHolder | null = null;
    const acquired: DbCopyHolder[] = [];
    for (const desired of steps) {
      const plan = planAlign(current, desired);
      if (plan.drop) current = null;
      if (plan.acquire !== null) acquired.push(current = plan.acquire);
    }
    expect(acquired).toEqual(["implementer", "implementer"]);
  });
});

describe("baseCompatible", () => {
  const meta = (over: Partial<BaseMeta> = {}): BaseMeta => ({
    id: "b20261028T030000000Z", dump, specToken: specTokenOf(db()), database: "app",
    image: "docker.io/library/mariadb:10.11", importedAt: "2026-10-28T04:00:00.000Z",
    durationMs: 1, baseBytes: 1, ...over,
  });

  it("accepts a base the target's server built into the configured schema", () => {
    expect(baseCompatible(meta(), db({ env: { TZ: "Europe/Brussels" } }), cfg)).toBe(true);
  });

  it("refuses a base built by another server or into another schema", () => {
    expect(baseCompatible(meta(), db({ image: "docker.io/library/mariadb:11.4" }), cfg)).toBe(false);
    expect(baseCompatible(meta({ database: "other" }), db(), cfg)).toBe(false);
  });
});

describe("withDbCopy", () => {
  it("adds only the datadir mount and a final buffer-pool arg", () => {
    const target = db();
    expect(withDbCopy(target, "/srv/installations/app/copies/c1", cfg)).toEqual({
      ...target,
      mounts: [...target.mounts, { hostPath: "/srv/installations/app/copies/c1", containerPath: "/var/lib/mysql", mode: "rw" }],
      args: ["--ft-min-word-len=2", `--innodb-buffer-pool-size=${64 * 1024 * 1024}`],
    });
  });
});
