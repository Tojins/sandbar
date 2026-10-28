// Database copies against a real tmpdir (#201): the registry, the sweep, the
// volume refusal and the slot, over fakes of the sandbox stack and the
// sandbox. Plain `cp`/`rm` stand in for `podman unshare`, since nothing here
// is subuid-owned, and the tmpdir usually lacks reflink, so the stand-in
// copies with `--reflink=auto`; db-copy-podman.test.ts runs the copy itself.

import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type DatabaseCopiesSettings,
  assertDatabaseCopiesTarget,
  resolveDatabaseCopies,
  resolveGateStack,
} from "./config.js";
import { type UsernsRun, UsernsCommandError, dbBaseLayout, publishBase } from "./db-base.js";
import {
  type DbCopies,
  DB_COPY_HOOK_LOG,
  createDbCopies,
  createDbCopySlot,
  dbVolumeRefusals,
  sweepDbCopies,
} from "./db-copy.js";
import { type BaseMeta, type DbCopyEvent, specTokenOf, withDbCopy } from "./db-copy-policy.js";
import { MIN_DB_VOLUME_FREE_BYTES } from "./disk-space.js";
import { dbCopyDirName, runScope } from "./naming.js";

const exec = promisify(execFile);
const SCOPE = runScope("/some/workdir");

// `podman unshare` as the host user, with `cp` allowed to fall back where
// the tmpdir cannot clone.
const plainFs: UsernsRun = async ([command, ...args]) => {
  try {
    return (await exec(command!, args.map((a) => (a === "--reflink=always" ? "--reflink=auto" : a)))).stdout;
  } catch (err) {
    throw new UsernsCommandError(`${command} failed: ${String(err)}`);
  }
};

const target = (args: string[] = []) => assertDatabaseCopiesTarget(
  resolveGateStack({
    containers: [
      {
        name: "db",
        image: "docker.io/library/mariadb:10.11",
        inSandbox: true,
        args,
        readiness: { kind: "healthcheck", command: ["healthcheck.sh", "--connect"] },
      },
      { name: "runner", image: "localhost/runner", mountWorktree: "/w", hold: true },
    ],
    steps: [{ name: "s", in: "runner", command: ["true"] }],
  }),
  resolveDatabaseCopies({ dump: "/d", root: "/r", container: "db", database: "app" })!,
);

let root: string;
let cfg: DatabaseCopiesSettings;
let layout: ReturnType<typeof dbBaseLayout>;

const BASE = "b20261028T030000000Z";
const meta = (over: Partial<BaseMeta> = {}): BaseMeta => ({
  id: BASE,
  dump: { name: "app.sql.gz", size: 1, mtimeMs: Date.parse("2026-10-28T02:00:00Z"), ino: 1 },
  specToken: specTokenOf(target()),
  database: "app",
  image: "docker.io/library/mariadb:10.11",
  importedAt: "2026-10-28T03:30:00.000Z",
  durationMs: 1,
  baseBytes: 1,
  ...over,
});

const publish = async (m: BaseMeta = meta()) => {
  await mkdir(join(layout.bases, m.id, "mysql"), { recursive: true });
  await writeFile(join(layout.bases, m.id, "mysql", "user.frm"), "rows");
  await publishBase(layout, m, null, new Date());
};

const copies = (over: Partial<Parameters<typeof createDbCopies>[0]> = {}) => createDbCopies({
  cfg, scope: SCOPE, userns: plainFs,
  volumeSpace: async (r) => ({ root: r, availableBytes: MIN_DB_VOLUME_FREE_BYTES }),
  ...over,
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sandbar-db-copy-")));
  cfg = resolveDatabaseCopies({ dump: join(root, "app.sql.gz"), root, container: "db", database: "app" })!;
  layout = dbBaseLayout(root);
  await mkdir(layout.bases);
  await mkdir(layout.copies);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createDbCopies", () => {
  it("copies the current base into a scoped dir, and release removes it once", async () => {
    await publish();
    const got = await copies().acquire("221", target());
    expect(got.kind).toBe("ok");
    if (got.kind !== "ok") return;
    const { lease } = got;
    expect(lease).toMatchObject({
      hostPath: join(layout.copies, dbCopyDirName(SCOPE, "221", 1)),
      base: BASE,
      dumpDate: "2026-10-28",
    });
    expect(await readFile(join(lease.hostPath, "mysql", "user.frm"), "utf8")).toBe("rows");
    await Promise.all([lease.release(), lease.release()]);
    expect(await readdir(layout.copies)).toEqual([]);
  });

  it("allows one live copy per issue, and another once it is released", async () => {
    await publish();
    const registry = copies();
    const first = await registry.acquire("221", target());
    await expect(registry.acquire("221", target())).rejects.toThrow(/issue 221 already holds a copy/);
    expect((await registry.acquire("222", target())).kind).toBe("ok");
    if (first.kind === "ok") await first.lease.release();
    const second = await registry.acquire("221", target());
    expect(second.kind === "ok" && second.lease.hostPath).toBe(join(layout.copies, dbCopyDirName(SCOPE, "221", 3)));
  });

  it.each<[string, (r: DbCopies) => Promise<unknown>, Partial<Parameters<typeof createDbCopies>[0]>, string]>([
    ["no current base", async () => {}, {}, "no-base"],
    ["a current base without meta", async () => {
      await publish();
      await rm(join(layout.bases, `${BASE}.json`));
    }, {}, "no-base"],
    ["a base another server built", async () => publish(meta({ specToken: "other" })), {}, "base-mismatch"],
    ["a low volume", async () => publish(), {
      volumeSpace: async (r) => ({ root: r, availableBytes: MIN_DB_VOLUME_FREE_BYTES - 1n }),
    }, "volume-low"],
    ["a failed cp", async () => publish(), {
      userns: async (argv) => {
        if (argv[0] === "cp") {
          await mkdir(argv[4]!, { recursive: true });
          throw new UsernsCommandError("cp: failed to clone: Operation not supported");
        }
        return plainFs(argv);
      },
    }, "copy-failed"],
  ])("answers %s as unavailable, and leaves nothing behind", async (_, arrange, over, reason) => {
    const registry = copies(over);
    await arrange(registry);
    expect(await registry.acquire("221", target())).toEqual({ kind: "unavailable", reason });
    expect(await readdir(layout.copies)).toEqual([]);
    // The issue holds nothing, so it may ask again.
    expect(await registry.acquire("221", target())).toEqual({ kind: "unavailable", reason });
  });
});

describe("sweepDbCopies", () => {
  it("removes this run's copies and leaves every other entry", async () => {
    const other = dbCopyDirName(runScope("/other/workdir"), "9", 1);
    for (const name of [dbCopyDirName(SCOPE, "221", 1), dbCopyDirName(SCOPE, "7", 4), other]) {
      await mkdir(join(layout.copies, name, "mysql"), { recursive: true });
    }
    const swept = await sweepDbCopies({ cfg, scope: SCOPE, userns: plainFs });
    expect([...swept.removed].sort()).toEqual([dbCopyDirName(SCOPE, "221", 1), dbCopyDirName(SCOPE, "7", 4)].sort());
    expect(swept.failures).toEqual([]);
    expect(await readdir(layout.copies)).toEqual([other]);
  });

  it("reports a copy it could not remove, and is empty without a copies dir", async () => {
    await mkdir(join(layout.copies, dbCopyDirName(SCOPE, "221", 1)));
    const stuck: UsernsRun = async () => {
      throw new UsernsCommandError("podman unshare rm -rf failed: busy");
    };
    expect(await sweepDbCopies({ cfg, scope: SCOPE, userns: stuck })).toEqual({
      removed: [],
      failures: [`  ${join(layout.copies, dbCopyDirName(SCOPE, "221", 1))}\n    podman unshare rm -rf failed: busy`],
    });
    await rm(layout.copies, { recursive: true });
    expect(await sweepDbCopies({ cfg, scope: SCOPE, userns: plainFs })).toEqual({ removed: [], failures: [] });
  });
});

// Whether this tmpdir can clone at all; the refusal is asserted where it
// cannot, the acceptance where it can.
const tmpHasReflink = (() => {
  const dir = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  try {
    execFileSync("sh", ["-c", `echo x > ${dir}/a && cp --reflink=always ${dir}/a ${dir}/b`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  } finally {
    execFileSync("rm", ["-rf", dir]);
  }
})();

describe("dbVolumeRefusals", () => {
  it("refuses a root that does not exist", async () => {
    const missing = { ...cfg, root: join(root, "unmounted") };
    expect(await dbVolumeRefusals(missing)).toEqual([
      `config.databaseCopies.root ${missing.root}: the database volume is not mounted ` +
        "or has no reflink support (it does not exist).",
    ]);
  });

  it.runIf(!tmpHasReflink)("refuses a filesystem without reflink, naming cp's reason", async () => {
    const [refusal] = await dbVolumeRefusals(cfg);
    expect(refusal).toMatch(/^config\.databaseCopies\.root .*: the database volume is not mounted or has no reflink support \(cp: failed to clone/);
    expect(await readdir(layout.copies)).toEqual([]);
  });

  it.runIf(tmpHasReflink)("accepts a filesystem with reflink, and leaves no probe behind", async () => {
    expect(await dbVolumeRefusals(cfg)).toEqual([]);
    expect(await readdir(layout.copies)).toEqual([]);
  });
});

describe("createDbCopySlot", () => {
  let logDir: string;
  beforeEach(async () => {
    logDir = join(root, "sandbox-logs");
    await mkdir(logDir);
  });

  const slotWith = (over: {
    readonly up?: boolean | Error;
    readonly hookOk?: boolean;
    readonly hooks?: number;
    readonly registry?: DbCopies;
  } = {}) => {
    const ops: string[] = [];
    const events: DbCopyEvent[] = [];
    const slot = createDbCopySlot({
      copies: over.registry ?? copies(),
      target: target(),
      stack: {
        swapDbCopyIn: async ({ container, label }) => {
          ops.push(`in ${label}`);
          expect(container).toEqual(withDbCopy(target(), container.mounts.at(-1)!.hostPath, cfg));
          if (over.up instanceof Error) throw over.up;
          return over.up ?? true;
        },
        swapDbCopyOut: async () => {
          ops.push("out");
        },
      },
      sandbox: {
        runHooks: async (hooks) => {
          ops.push(`hooks ${hooks.map((h) => h.command).join(",")}`);
          return { ok: over.hookOk ?? true, output: "migrated 3\n" };
        },
      },
      hooks: Array.from({ length: over.hooks ?? 1 }, (_, i) => ({ command: `prepare-${i}` })),
      issue: { id: "221", title: "Copies" },
      logDir,
      emit: async (event) => {
        events.push(event);
      },
    });
    return { slot, ops, events };
  };

  it("acquires for the implementer, keeps the copy across implementer actions, and drops it at handover", async () => {
    await publish();
    const { slot, ops, events } = slotWith();
    const held = { kind: "held", holder: "implementer", dumpDate: "2026-10-28", hook: "ok" };
    expect(await slot.align("implementer")).toEqual(held);
    expect(await slot.align("implementer")).toEqual(held);
    expect(await readdir(layout.copies)).toEqual([dbCopyDirName(SCOPE, "221", 1)]);
    expect(await slot.align(null)).toEqual({ kind: "none" });
    expect(await readdir(layout.copies)).toEqual([]);
    expect(await slot.align(null)).toEqual({ kind: "none" });
    expect(await slot.align("implementer")).toEqual(held);
    const label = (seq: number) => `${dbCopyDirName(SCOPE, "221", seq)} (dump of 2026-10-28)`;
    expect(ops).toEqual([`in ${label(1)}`, "hooks prepare-0", "out", `in ${label(2)}`, "hooks prepare-0"]);
    expect(events.map((e) => e.action)).toEqual(["created", "dropped", "created"]);
    expect(events[0]).toEqual({
      kind: "db-copy", issue: 221, title: "Copies", holder: "implementer", action: "created",
      durationMs: expect.any(Number), base: BASE, hook: "ok", hookMs: expect.any(Number),
    });
    expect(events[1]).toEqual({
      kind: "db-copy", issue: 221, title: "Copies", holder: "implementer", action: "dropped",
      durationMs: expect.any(Number), base: BASE, volumeUsedBytes: expect.any(Number),
    });
    expect(await readFile(join(logDir, DB_COPY_HOOK_LOG), "utf8"))
      .toBe(`[sandbar] onDbCopyReady for db copy ${label(1)}\nmigrated 3\n\n` +
        `[sandbar] onDbCopyReady for db copy ${label(2)}\nmigrated 3\n\n`);
  });

  it("gives the scenario runner a fresh copy after the implementer's", async () => {
    await publish();
    const { slot, ops } = slotWith({ hooks: 0 });
    await slot.align("implementer");
    expect(await slot.align("scenario-runner")).toEqual({
      kind: "held", holder: "scenario-runner", dumpDate: "2026-10-28", hook: "none",
    });
    expect(ops).toEqual([expect.stringMatching(/^in .*-1 /), "out", expect.stringMatching(/^in .*-2 /)]);
  });

  it("keeps a copy whose hook failed, and says so", async () => {
    await publish();
    const { slot, events } = slotWith({ hookOk: false });
    expect(await slot.align("implementer")).toMatchObject({ kind: "held", hook: "failed" });
    expect(events).toEqual([expect.objectContaining({ action: "created", hook: "failed" })]);
  });

  it("records an unavailable copy and proceeds without one", async () => {
    const { slot, ops, events } = slotWith();
    expect(await slot.align("implementer")).toEqual({ kind: "unavailable", reason: "no-base" });
    expect(ops).toEqual([]);
    expect(events).toEqual([{
      kind: "db-copy", issue: 221, title: "Copies", holder: "implementer", action: "failed",
      durationMs: expect.any(Number), detail: "no-base",
    }]);
  });

  it("releases a copy that did not come up", async () => {
    await publish();
    const { slot, ops, events } = slotWith({ up: false });
    expect(await slot.align("implementer")).toEqual({ kind: "unavailable", reason: "bringup-failed" });
    expect(ops).toEqual([expect.stringMatching(/^in /)]);
    expect(events.map((e) => e.action === "failed" && e.detail)).toEqual(["bringup-failed"]);
    expect(await readdir(layout.copies)).toEqual([]);
  });

  it("releases the copy when the swap throws, so the issue may copy again", async () => {
    await publish();
    const registry = copies();
    const { slot } = slotWith({ up: new Error("podman went away"), registry });
    await expect(slot.align("implementer")).rejects.toThrow("podman went away");
    expect(await readdir(layout.copies)).toEqual([]);
    expect((await registry.acquire("221", target())).kind).toBe("ok");
  });
});
