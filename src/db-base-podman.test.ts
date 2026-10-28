// `sandbar db-base` against real podman (#201): a tiny dump imported into a
// base that a server opens with its rows, and a failing dump that leaves the
// previous base current.
//
// It runs through a remote client too. `podman unshare` is refused there, so a
// container of the same rootless user namespace stands in for it: its root is
// the invoking user, and the entrypoint's subuid-owned datadir is its to
// remove and measure, as it is the user's under `podman unshare`. The roots
// are under the host-shared tmpdir, which both clients see at the same path.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { afterAll, describe, it } from "vitest";

import { assertDatabaseCopiesTarget, resolveDatabaseCopies, resolveGateStack } from "./config.js";
import { type UsernsRun, dbBaseLayout, readImportStatus, runDbBaseJob } from "./db-base.js";
import type { BaseMeta } from "./db-copy-policy.js";
import { dbImportContainerName, runScope } from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);
const IMAGE = "docker.io/library/mariadb:10.11";

const available = podmanTestsEnabled({ what: "db-base podman tests", image: IMAGE });

const roots: string[] = [];
const inUserns = (root: string): UsernsRun => async ([command, ...args]) =>
  (await exec(RUNTIME, [
    "run", "--rm", "--network", "none", "--entrypoint", command!,
    "-v", `${root}:${root}:rw,z`, IMAGE, ...args,
  ])).stdout;

afterAll(async () => {
  if (!available) return;
  for (const root of roots) {
    await exec(RUNTIME, ["rm", "-f", "-t", "0", dbImportContainerName(runScope(root)), `${runScope(root)}-check`]);
    // The mount point is busy inside the container, so it empties it.
    await inUserns(root)(["find", root, "-mindepth", "1", "-delete"]);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

const target = assertDatabaseCopiesTarget(
  resolveGateStack({
    containers: [
      {
        name: "db",
        image: IMAGE,
        inSandbox: true,
        env: { MARIADB_ALLOW_EMPTY_ROOT_PASSWORD: "1" },
        args: ["--ft-min-word-len=2"],
        readiness: { kind: "healthcheck", command: ["healthcheck.sh", "--connect", "--innodb_initialized"] },
        readinessTimeoutMs: 120_000,
      },
      { name: "runner", image: IMAGE, mountWorktree: "/w", hold: true },
    ],
    steps: [{ name: "s", in: "runner", command: ["true"] }],
  }),
  resolveDatabaseCopies({ dump: "/d", root: "/r", container: "db", database: "app" })!,
);

const ROWS = "CREATE TABLE t (id INT PRIMARY KEY, email VARCHAR(64));\n" +
  "INSERT INTO t VALUES (1, 'a@example.com'), (2, 'b@example.com');\n";

// The rows of `t` as a server started on a copy of `base` sees them.
async function rowsIn(root: string, base: string): Promise<string> {
  const copy = join(root, "check");
  await inUserns(root)(["cp", "-a", base, copy]);
  const name = `${runScope(root)}-check`;
  await exec(RUNTIME, [
    "run", "-d", "--name", name, "--network", "none", "-v", `${copy}:/var/lib/mysql:rw,z`, IMAGE,
  ]);
  for (let tries = 0; ; tries++) {
    try {
      await exec(RUNTIME, ["exec", name, "healthcheck.sh", "--connect", "--innodb_initialized"]);
      break;
    } catch (err) {
      if (tries > 120) throw err;
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  const { stdout } = await exec(RUNTIME, [
    "exec", name, "mariadb", "-uroot", "app", "-N", "-e", "SELECT id, email FROM t ORDER BY id",
  ]);
  await exec(RUNTIME, ["rm", "-f", "-t", "0", name]);
  return stdout;
}

describe.runIf(available)("sandbar db-base against real podman", () => {
  it("imports a dump as current, and keeps it current through a failing one", async ({ expect }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sandbar-db-base-podman-")));
    roots.push(root);
    const drop = join(root, "drop");
    await mkdir(drop);
    const dump = join(drop, "app-latest.sql.gz");
    const layout = dbBaseLayout(root);
    const cfg = resolveDatabaseCopies({
      dump,
      root,
      container: "db",
      database: "app",
      importBufferPoolBytes: 64 * 1024 * 1024,
      importTimeoutMs: 180_000,
    })!;
    const lines: string[] = [];
    const job = () => runDbBaseJob({
      cfg,
      target,
      force: false,
      log: (line) => lines.push(line),
      userns: inUserns(root),
      // The host tmpdir is a small tmpfs; the space rule is the fs test's.
      freeBytes: async () => 1n << 50n,
    });

    await writeFile(dump, gzipSync(ROWS));
    await expect(job()).resolves.toBe("imported");
    const first = await readImportStatus(layout);
    expect(first).toMatchObject({ outcome: "imported", dump: { name: "app-latest.sql.gz" } });
    const firstId = first!.attempt;
    expect(await readlink(layout.current)).toBe(`bases/${firstId}`);
    const meta = JSON.parse(await readFile(join(layout.bases, `${firstId}.json`), "utf8")) as BaseMeta;
    expect(meta).toMatchObject({ id: firstId, database: "app", image: IMAGE });
    expect(meta.baseBytes).toBeGreaterThan(0);
    // The container is gone, and the base opens with the dump's rows.
    await expect(exec(RUNTIME, ["container", "exists", dbImportContainerName(runScope(root))]))
      .rejects.toMatchObject({ code: 1 });
    expect(await rowsIn(root, join(layout.bases, firstId)))
      .toBe("1\ta@example.com\n2\tb@example.com\n");
    // Nothing moved, so the next tick has nothing to do.
    await expect(job()).resolves.toBe("up-to-date");

    // Line 3 repeats a key: the server's message quotes the row, the record
    // must not.
    await writeFile(dump, gzipSync(`${ROWS}INSERT INTO t VALUES (1, 'jane@example.com');\n`));
    await expect(job()).resolves.toBe("import-failed");
    const failed = await readImportStatus(layout);
    expect(failed).toMatchObject({ outcome: "import-failed", detail: "ERROR 1062 at dump line 3" });
    expect(JSON.stringify(failed)).not.toContain("jane");
    expect(lines.join("\n")).not.toContain("jane");
    expect(await readlink(layout.current)).toBe(`bases/${firstId}`);
    expect((await readdir(layout.bases)).sort()).toEqual([firstId, `${firstId}.json`]);
  }, 600_000);
});
