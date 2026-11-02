// The db-base filesystem tests' fixture (#201), shared by db-base-fs.test.ts
// and db-base-fs-room.test.ts: a fresh root per test, its bases, and a job run
// before any container. Plain `rm`/`du` stand in for `podman unshare`, since
// nothing here is subuid-owned.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach } from "vitest";

import { assertDatabaseCopiesTarget, resolveDatabaseCopies, resolveGateStack } from "./config.js";
import {
  type DbBaseJobOptions,
  type DbBaseLayout,
  type UsernsRun,
  dbBaseLayout,
  runDbBaseJob,
} from "./db-base.js";
import type { BaseMeta } from "./db-copy-policy.js";

const exec = promisify(execFile);
export const plainFs: UsernsRun = async ([command, ...args]) => (await exec(command!, args)).stdout;

export const meta = (id: string, over: Partial<BaseMeta> = {}): BaseMeta => ({
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

// The current test's root and its layout, set by `useDbBaseRoot`'s hooks.
export let root: string;
export let layout: DbBaseLayout;

export function useDbBaseRoot(): void {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "sandbar-db-base-")));
    layout = dbBaseLayout(root);
    await mkdir(layout.bases);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
}

export const makeBase = async (m: BaseMeta | null, id = m?.id) => {
  await mkdir(join(layout.bases, id!, "mysql"), { recursive: true });
  if (m !== null) await writeFile(join(layout.bases, `${id}.json`), JSON.stringify(m));
};

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

export const job = (over: Partial<DbBaseJobOptions> = {}) => {
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

export const dropDump = async () => {
  await mkdir(join(root, "drop"), { recursive: true });
  await writeFile(join(root, "drop/app-latest.sql.gz"), "not even gzip");
};
