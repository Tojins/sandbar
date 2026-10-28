// Database copies against real podman (#201): a base imported by the job, a
// sandbox stack beside an anchor, and a slot swapping a copy of the base in
// place of the fixtures sibling and out again.
//
// It runs through a remote client too, as db-base-podman.test.ts does: the
// anchor is a plain `sleep` container rather than an agent sandbox, and a
// container of the rootless user namespace stands in for `podman unshare`,
// which a remote client refuses. Where the shared tmpdir cannot clone, that
// stand-in copies with `--reflink=auto`; the refusal itself is asserted in
// db-copy.test.ts.

import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { afterAll, describe, it } from "vitest";

import { assertDatabaseCopiesTarget, resolveDatabaseCopies, resolveGateStack } from "./config.js";
import { type UsernsRun, UsernsCommandError, dbBaseLayout, runDbBaseJob } from "./db-base.js";
import { createDbCopies, createDbCopySlot, sweepDbCopies } from "./db-copy.js";
import type { DbCopyEvent } from "./db-copy-policy.js";
import { sandboxContainerNameFor, sandboxDbCopyContainerNameFor, scopedResourcePrefix } from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import { podmanTestScope } from "./podman-test-scope.test-util.js";
import { RUNTIME } from "./runtime.js";
import { type SandboxStack, startSandboxStack } from "./sandbox-stack.js";

const exec = promisify(execFile);
const IMAGE = "docker.io/library/mariadb:10.11";
const POOL = 64 * 1024 * 1024;

const available = podmanTestsEnabled({ what: "db-copy podman tests", image: IMAGE });
const { scope: SCOPE, cleanup } = podmanTestScope("db-copy-podman");

const roots: string[] = [];
let stack: SandboxStack | null = null;

// Whether the shared tmpdir can clone.
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

// `podman unshare`, as a container of the same user namespace.
const inUserns = (root: string): UsernsRun => async ([command, ...args]) => {
  const argv = tmpHasReflink ? args : args.map((a) => (a === "--reflink=always" ? "--reflink=auto" : a));
  try {
    return (await exec(RUNTIME, [
      "run", "--rm", "--network", "none", "--entrypoint", command!,
      "-v", `${root}:${root}:rw,z`, IMAGE, ...argv,
    ])).stdout;
  } catch (err) {
    throw new UsernsCommandError(`${command} failed: ${String(err)}`);
  }
};

afterAll(async () => {
  if (!available) return;
  await stack?.stop();
  await cleanup();
  for (const root of roots) {
    await inUserns(root)(["find", root, "-mindepth", "1", "-delete"]);
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);

const ROWS = "CREATE TABLE t (id INT PRIMARY KEY, email VARCHAR(64));\n" +
  "INSERT INTO t VALUES (1, 'a@example.com'), (2, 'b@example.com');\n";

// What the fixtures sibling's entrypoint runs on a fresh datadir, and a copy's
// must not.
const INITDB = "CREATE DATABASE initdb_marker;\n" +
  "CREATE TABLE app.fixture (id INT PRIMARY KEY);\nINSERT INTO app.fixture VALUES (1);\n";

describe.runIf(available)("database copies against real podman", () => {
  it("swaps a copy of the base in place of the fixtures sibling, and the fixtures back", async ({ expect }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sandbar-db-copy-podman-")));
    roots.push(root);
    const worktree = join(root, "worktree");
    await mkdir(join(worktree, "initdb"), { recursive: true });
    await writeFile(join(worktree, "initdb", "fixture.sql"), INITDB);
    await mkdir(join(root, "drop"));
    const dump = join(root, "drop", "app-latest.sql.gz");
    await writeFile(dump, gzipSync(ROWS));

    const spec = resolveGateStack({
      containers: [
        {
          name: "db",
          image: IMAGE,
          inSandbox: true,
          env: { MARIADB_ALLOW_EMPTY_ROOT_PASSWORD: "1", MARIADB_DATABASE: "app" },
          mounts: [{ hostPath: "initdb", containerPath: "/docker-entrypoint-initdb.d" }],
          readiness: { kind: "healthcheck", command: ["healthcheck.sh", "--connect", "--innodb_initialized"] },
          readinessTimeoutMs: 120_000,
        },
        { name: "runner", image: IMAGE, mountWorktree: "/w", hold: true },
      ],
      steps: [{ name: "s", in: "runner", command: ["true"] }],
    });
    const cfg = resolveDatabaseCopies({
      dump, root, container: "db", database: "app",
      bufferPoolBytes: POOL, importBufferPoolBytes: POOL, importTimeoutMs: 180_000,
    })!;
    const target = assertDatabaseCopiesTarget(spec, cfg);
    const userns = inUserns(root);
    await expect(runDbBaseJob({
      cfg, target, force: false, log: () => undefined, userns, freeBytes: async () => 1n << 50n,
    })).resolves.toBe("imported");
    const layout = dbBaseLayout(root);
    await mkdir(layout.copies);

    const anchor = `${scopedResourcePrefix(SCOPE)}anchor`;
    await exec(RUNTIME, ["run", "-d", "--name", anchor, "--entrypoint", "sleep", IMAGE, "infinity"]);
    const logDir = join(root, "logs");
    await mkdir(logDir);
    stack = await startSandboxStack({
      issueId: "221", scope: SCOPE, spec, worktreePath: worktree, anchorContainerName: anchor, logDir,
    });
    const fixtures = sandboxContainerNameFor(SCOPE, "221", "db");
    const copy = sandboxDbCopyContainerNameFor(SCOPE, "221", "db");
    // The agent's view: the sibling at the loopback address it shares.
    const query = async (sql: string) => (await exec(RUNTIME, [
      "exec", anchor, "mariadb", "-h127.0.0.1", "-uroot", "-N", "-e", sql,
    ])).stdout;
    await query("INSERT INTO app.fixture VALUES (2)");

    const copies = createDbCopies({
      cfg, scope: SCOPE, userns,
      volumeSpace: async (r) => ({ root: r, availableBytes: 1n << 50n }),
    });
    const events: DbCopyEvent[] = [];
    const slot = createDbCopySlot({
      copies, target, stack,
      sandbox: { runHooks: async () => ({ ok: true, output: "" }) },
      hooks: [],
      issue: { id: "221", title: "Copies" },
      logDir,
      emit: async (event) => {
        events.push(event);
      },
    });

    await expect(slot.align("implementer")).resolves.toMatchObject({ kind: "held", hook: "none" });
    expect(await query("SELECT id, email FROM app.t ORDER BY id")).toBe("1\ta@example.com\n2\tb@example.com\n");
    // The entrypoint found `mysql/` and initialised nothing.
    expect(await query("SHOW DATABASES LIKE 'initdb_marker'")).toBe("");
    expect(await query("SHOW TABLES IN app LIKE 'fixture'")).toBe("");
    expect(await query("SELECT @@innodb_buffer_pool_size")).toBe(`${POOL}\n`);
    expect((await exec(RUNTIME, ["inspect", "--format", "{{.State.Running}}", fixtures])).stdout.trim()).toBe("false");

    await expect(slot.align(null)).resolves.toEqual({ kind: "none" });
    await expect(exec(RUNTIME, ["container", "exists", copy])).rejects.toMatchObject({ code: 1 });
    expect(await readdir(layout.copies)).toEqual([]);
    expect(await query("SELECT id FROM app.fixture ORDER BY id")).toBe("1\n2\n");
    expect(events.map((e) => e.action)).toEqual(["created", "dropped"]);

    // A copy nothing released, as a dead run leaves it: subuid-owned, and
    // still the run's to remove.
    const leaked = await copies.acquire("222", target);
    expect(leaked.kind).toBe("ok");
    const swept = await sweepDbCopies({ cfg, scope: SCOPE, userns });
    expect(swept).toEqual({ removed: [expect.stringContaining("issue-222-")], failures: [] });
    expect(await readdir(layout.copies)).toEqual([]);
  }, 900_000);
});
