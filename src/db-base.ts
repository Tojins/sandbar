// The nightly database base (#201): `sandbar db-base` imports the consumer's
// dump into a fresh datadir and publishes it as `<root>/current`.
//
// A SYSTEMD TIMER RUNS IT, NEVER THE DAEMON (decision 1). Every 15 minutes the
// job asks whether the dump (by name, size, mtime and inode) or the target's
// server (`specTokenOf`) moved since the last attempt, and is a no-op when
// neither did; a dump and token that failed wait for one of them to move, or
// for `--force`. An import takes hours, so a daemon restart (#146) neither
// kills one nor waits for one. The daemon only reads `import-status.json`
// (`readImportStatus`) and reports it (`run.ts`).
//
// LAYOUT under `databaseCopies.root`, owned by this job and only ever written
// under `import.lock` (proper-lockfile; a held lock is a no-op exit):
//
//   import.lock          one job at a time per root
//   import-status.json   the last attempt's outcome, written by rename
//   bases/<id>/          a datadir, subuid-owned once the entrypoint chowns it
//   bases/<id>.json      its meta, written only after a clean shutdown
//   current              symlink to `bases/<id>`, swapped by rename
//
// THE DAEMON ONLY READS (`createDbBaseWatch`): at every recompute it reads the
// status and the drop's stat, records each new attempt once as a `db-base`
// event and raises `dbBaseComplaints` once per key per run, so the run header
// shows a missing or stale dump and a failed import.
//
// The daemon owns `copies/` (#201 part 2) and never deletes a base. A base dir
// without meta is an import that never finished; a superseded base is deleted
// by the first job run at least SUPERSEDED_GRACE_MS later (`basesToSweep`).
// Nothing is ever moved across directories: the datadir is subuid-owned, so
// the host user could not reparent it, and every removal or measurement under
// `root` runs inside the rootless user namespace (`podman unshare`, #200).
//
// THE IMPORT IS OUTSIDE EVERY AGENT'S REACH (decision 2). Its container runs
// with `--network none`, no worktree and no sandbox netns, and mounts only
// `bases/<id>` at the target's datadir: the stack's own mounts are left out,
// so the entrypoint's init runs no schema.sql. The image, env and args are the
// target container's, so the base is built by the server that will open it,
// with the import-only args appended last. The name is scoped by the root
// (`dbImportContainerName`), which no workdir run's sweep claims. The dump is
// read on the host and streamed through gunzip into the client's stdin: it is
// never bind-mounted, since its owner is outside the user namespace.
//
// A BASE IS SHUT DOWN CLEANLY (decision 5): `innodb_fast_shutdown=0`, then a
// stop with a ten-minute grace, and the exit code must be 0. Only then is the
// meta written, `current` swapped (`current.tmp` renamed over it) and the old
// base stamped superseded. A failure anywhere stops the container, deletes
// `bases/<id>` and records `import-failed` with a reason code, which is all
// the status carries (decision 13); `current` is untouched. SIGTERM takes the
// same teardown through cleanup.ts, recorded as `interrupted`.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import {
  mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import lockfile from "proper-lockfile";

import { registerDisposable } from "./cleanup.js";
import {
  type DatabaseCopiesSettings,
  type DbCopyTarget,
  type ResolvedConfig,
  assertDatabaseCopiesTarget,
} from "./config.js";
import {
  type BaseMeta,
  type DumpIdentity,
  type ImportStatus,
  BASE_ID_RE,
  baseIdAt,
  basesToSweep,
  dbBaseComplaints,
  dbBaseEventOf,
  importNeeded,
  importSpaceNeeded,
  sanitizeImportError,
  specTokenOf,
} from "./db-copy-policy.js";
import { freeBytes } from "./disk-space.js";
import { isErrno, SandbarError } from "./errors.js";
import type { EventInput } from "./events.js";
import {
  CONTAINER_RM_ARGS,
  CONTROL_TIMEOUT_MS,
  ContainerBringupError,
  LOG_READ_TIMEOUT_MS,
  boundedOk,
  boundedPodman,
  healthCheckArgs,
  pollUntilReady,
} from "./gate-stack.js";
import { dbImportContainerName, runScope } from "./naming.js";
import { RUNTIME, type RuntimeInvocation, withRuntimeEnv } from "./runtime.js";
import { readStackFrom } from "./stack-source.js";
import { startTimer } from "./timing.js";

export type DbBaseLayout = {
  readonly lock: string;
  readonly status: string;
  readonly bases: string;
  readonly current: string;
};

export function dbBaseLayout(root: string): DbBaseLayout {
  return {
    lock: join(root, "import.lock"),
    status: join(root, "import-status.json"),
    bases: join(root, "bases"),
    current: join(root, "current"),
  };
}

// The stop grace of a clean shutdown, and what the client gets to print.
const SHUTDOWN_GRACE_S = 600;
const STDERR_KEPT_CHARS = 16_384;
// `rm -rf` or `du` of a multi-GB datadir.
const USERNS_TIMEOUT_MS = 30 * 60_000;

// Runs argv inside the rootless user namespace, where a subuid-owned datadir
// is the invoking user's to remove and measure, and returns its stdout.
// Throws when it fails.
export type UsernsRun = (argv: readonly string[]) => Promise<string>;

export const podmanUnshare: UsernsRun = async (argv) => {
  const r = await boundedPodman(["unshare", ...argv], USERNS_TIMEOUT_MS);
  if (!boundedOk(r)) {
    throw new Error(`${RUNTIME} unshare ${argv.join(" ")} failed: ${r.errorMessage || "timed out"}`);
  }
  return r.stdout;
};

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
    return null;
  }
};

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const incoming = `${path}.tmp-${process.pid}`;
  await writeFile(incoming, `${JSON.stringify(value, null, 2)}\n`);
  await rename(incoming, path);
}

export const readImportStatus = (layout: DbBaseLayout): Promise<ImportStatus | null> =>
  readJson<ImportStatus>(layout.status);

const metaPath = (layout: DbBaseLayout, id: string) => join(layout.bases, `${id}.json`);

// The dump as a rename identifies it, or null when there is none.
export async function statDump(path: string): Promise<DumpIdentity | null> {
  try {
    const s = await stat(path);
    return { name: basename(path), size: s.size, mtimeMs: s.mtimeMs, ino: s.ino };
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
    return null;
  }
}

async function currentBaseId(layout: DbBaseLayout): Promise<string | null> {
  try {
    return basename(await readlink(layout.current));
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
    return null;
  }
}

export type DbBaseWatch = {
  // Reads the job's outcome and the drop, and reports what is new.
  readonly observe: () => Promise<void>;
};

export function createDbBaseWatch(opts: {
  readonly cfg: DatabaseCopiesSettings;
  readonly emit: (event: Extract<EventInput, { kind: "db-base" | "complaint" }>) => Promise<unknown>;
  readonly now?: () => number;
}): DbBaseWatch {
  const { cfg } = opts;
  const layout = dbBaseLayout(cfg.root);
  let lastAttempt: string | null = null;
  const complained = new Set<string>();
  return {
    observe: async () => {
      const status = await readImportStatus(layout);
      if (status !== null && status.attempt !== lastAttempt) {
        lastAttempt = status.attempt;
        await opts.emit(dbBaseEventOf(status));
      }
      const complaints = dbBaseComplaints({
        status,
        drop: await statDump(cfg.dump),
        dumpPath: cfg.dump,
        now: (opts.now ?? Date.now)(),
        staleAfterMs: cfg.staleAfterMs,
      });
      for (const { key, message } of complaints) {
        if (complained.has(key)) continue;
        complained.add(key);
        await opts.emit({ kind: "complaint", severity: "warning", message });
      }
    },
  };
}

// The target in the stack on disk: the inline stack, or the stack file in the
// config's cwd, which the play has just updated, as `pulled-images` reads it.
export async function dbBaseTargetOf(
  config: ResolvedConfig,
  dbc: DatabaseCopiesSettings,
): Promise<DbCopyTarget> {
  const { gateStack } = config;
  const { stack } = await readStackFrom(gateStack, config.cwd, config.env);
  return assertDatabaseCopiesTarget(
    stack,
    dbc,
    gateStack.kind === "inline" ? undefined : join(config.cwd, gateStack.path),
  );
}

// The import container: the target's image, env and args with the import-only
// args last, its datadir the new base, and nothing else mounted.
export function importRunArgs(
  containerName: string,
  target: DbCopyTarget,
  cfg: DatabaseCopiesSettings,
  baseDir: string,
): RuntimeInvocation {
  return {
    argv: [
      "run", "-d", "--name", containerName,
      "--network", "none",
      "--image-volume=ignore",
      "--label", "sandbar=true",
      "-v", `${baseDir}:${cfg.datadir}:rw,z`,
      ...healthCheckArgs(target),
      target.image,
      ...target.args,
      `--innodb-buffer-pool-size=${cfg.importBufferPoolBytes}`,
      "--innodb-flush-log-at-trx-commit=0",
      "--skip-log-bin",
    ],
    env: target.env,
  };
}

export type DbBaseJobOptions = {
  readonly cfg: DatabaseCopiesSettings;
  readonly target: DbCopyTarget;
  readonly force: boolean;
  readonly log: (line: string) => void;
  readonly userns?: UsernsRun;
  readonly freeBytes?: (path: string) => Promise<bigint>;
  readonly now?: () => Date;
};

export type DbBaseJobResult = "locked" | "no-dump" | "up-to-date" | ImportStatus["outcome"];

export async function runDbBaseJob(opts: DbBaseJobOptions): Promise<DbBaseJobResult> {
  const layout = dbBaseLayout(opts.cfg.root);
  // proper-lockfile locks an existing file.
  await writeFile(layout.lock, "", { flag: "a" });
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(layout.lock, { retries: 0 });
  } catch (err) {
    if (!isErrno(err, "ELOCKED")) throw err;
    opts.log(`db-base: another import holds ${layout.lock}`);
    return "locked";
  }
  try {
    return await importIfNeeded(opts, layout);
  } finally {
    await release();
  }
}

async function importIfNeeded(
  opts: DbBaseJobOptions,
  layout: DbBaseLayout,
): Promise<DbBaseJobResult> {
  const { cfg, target, log } = opts;
  const userns = opts.userns ?? podmanUnshare;
  const now = opts.now ?? (() => new Date());
  const dump = await statDump(cfg.dump);
  if (dump === null) {
    log(`db-base: no dump at ${cfg.dump}`);
    return "no-dump";
  }
  const specToken = specTokenOf(target);
  if (!importNeeded(await readImportStatus(layout), dump, specToken, opts.force)) {
    log(`db-base: ${dump.name} was already attempted with this server; nothing to do`);
    return "up-to-date";
  }

  const containerName = dbImportContainerName(runScope(await realpath(cfg.root)));
  // A killed job's container; a missing one is the usual answer.
  await boundedPodman(CONTAINER_RM_ARGS(containerName), CONTROL_TIMEOUT_MS);
  await mkdir(layout.bases, { recursive: true });
  const currentId = await currentBaseId(layout);
  await sweepBases(layout, currentId, now(), userns);

  const id = baseIdAt(now());
  const baseDir = join(layout.bases, id);
  const elapsed = startTimer();
  const record = async (status: ImportStatus) => {
    await writeJsonAtomic(layout.status, status);
    return status.outcome;
  };
  const fail = async (detail: string) => {
    log(`db-base: importing ${dump.name} as ${id} failed: ${detail}`);
    return await record({
      attempt: id, outcome: "import-failed", detail, dump, specToken,
      durationMs: elapsed(), finishedAt: now().toISOString(),
    });
  };

  const previous = currentId === null ? null : await readJson<BaseMeta>(metaPath(layout, currentId));
  const free = await (opts.freeBytes ?? freeBytes)(cfg.root);
  if (free < importSpaceNeeded(previous?.baseBytes ?? null, dump.size)) {
    return await fail("insufficient-space");
  }

  // Registered before the container exists, so a signal at any point after
  // this tears down whatever got created.
  let tornDown = false;
  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    withdraw();
    const removed = await boundedPodman(CONTAINER_RM_ARGS(containerName), CONTROL_TIMEOUT_MS);
    if (!boundedOk(removed)) log(`db-base: could not remove ${containerName}: ${removed.errorMessage}`);
    await userns(["rm", "-rf", baseDir]);
  };
  const withdraw = registerDisposable(async () => {
    if (tornDown) return;
    await teardown();
    await fail("interrupted");
  });

  await mkdir(baseDir);
  log(`db-base: importing ${dump.name} (${dump.size} bytes) as ${id}`);
  let detail: string | null;
  try {
    detail = await buildBase(opts, containerName, baseDir);
  } catch (err) {
    try {
      await teardown();
      await fail("job-error");
    } catch (cleanupErr) {
      log(`db-base: cleaning up ${id} after a job error also failed: ${String(cleanupErr)}`);
    }
    throw err;
  }
  if (detail !== null) {
    await teardown();
    return await fail(detail);
  }
  withdraw();

  const du = await userns(["du", "-sb", baseDir]);
  const baseBytes = Number(du.split(/\s/)[0]);
  if (!Number.isSafeInteger(baseBytes)) {
    throw new SandbarError(`db-base: du -sb ${baseDir} printed ${JSON.stringify(du)}`);
  }
  const meta: BaseMeta = {
    id, dump, specToken, database: cfg.database, image: target.image,
    importedAt: now().toISOString(), durationMs: elapsed(), baseBytes,
  };
  await publishBase(layout, meta, previous, now());
  log(`db-base: ${id} is current (${baseBytes} bytes, ${meta.durationMs}ms)`);
  return await record({
    attempt: id, outcome: "imported", baseBytes, dump, specToken,
    durationMs: meta.durationMs, finishedAt: now().toISOString(),
  });
}

// Makes `meta`'s base current: its meta first, then `current` swapped by a
// rename, so a reader resolves either the old base or a complete new one;
// then the base it replaced is stamped superseded.
export async function publishBase(
  layout: DbBaseLayout,
  meta: BaseMeta,
  previous: BaseMeta | null,
  now: Date,
): Promise<void> {
  await writeJsonAtomic(metaPath(layout, meta.id), meta);
  const incoming = `${layout.current}.tmp`;
  // A job killed between these two steps leaves its link behind.
  await rm(incoming, { force: true });
  await symlink(join("bases", meta.id), incoming);
  await rename(incoming, layout.current);
  if (previous !== null) {
    await writeJsonAtomic(metaPath(layout, previous.id), { ...previous, supersededAt: now.toISOString() });
  }
}

export async function sweepBases(
  layout: DbBaseLayout,
  currentId: string | null,
  now: Date,
  userns: UsernsRun,
): Promise<void> {
  const ids = new Set(
    (await readdir(layout.bases))
      .map((name) => name.replace(/\.json$/, ""))
      .filter((id) => BASE_ID_RE.test(id)),
  );
  const bases = await Promise.all([...ids].map(async (id) => ({
    id,
    meta: await readJson<BaseMeta>(metaPath(layout, id)),
  })));
  const { remove, stamp } = basesToSweep(bases, currentId, now.getTime());
  for (const id of remove) {
    await userns(["rm", "-rf", join(layout.bases, id)]);
    await rm(metaPath(layout, id), { force: true });
  }
  for (const { id, meta } of bases) {
    if (meta !== null && stamp.includes(id)) {
      await writeJsonAtomic(metaPath(layout, id), { ...meta, supersededAt: now.toISOString() });
    }
  }
}

// Brings the import container up on `baseDir`, loads the dump and shuts the
// server down cleanly. Null on success, else the failure's reason code.
async function buildBase(
  opts: DbBaseJobOptions,
  containerName: string,
  baseDir: string,
): Promise<string | null> {
  const { cfg, target } = opts;
  const deadline = Date.now() + cfg.importTimeoutMs;
  const remainingMs = () => Math.max(1, deadline - Date.now());
  const started = await withRuntimeEnv(
    importRunArgs(containerName, target, cfg, baseDir),
    (argv) => boundedPodman(argv, CONTROL_TIMEOUT_MS),
  );
  if (!boundedOk(started)) return "container-failed";
  try {
    await pollUntilReady(
      containerName,
      { ...target, readinessTimeoutMs: remainingMs() },
      target.readiness,
      "database import",
    );
  } catch (err) {
    if (!(err instanceof ContainerBringupError)) throw err;
    // Server startup output, from before any row was loaded.
    opts.log(`db-base: ${err.message}`);
    return "not-ready";
  }
  const client = ["exec", containerName, "mariadb", "-uroot", "--execute"];
  // The database is an identifier the config's grammar admits.
  const created = await boundedPodman(
    [...client, `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\``],
    remainingMs(),
  );
  if (!boundedOk(created)) return created.timedOut ? "timeout" : sanitizeImportError(created.stderr);
  const loaded = await streamDump(cfg, containerName, remainingMs());
  if (loaded !== null) return loaded;

  const slow = await boundedPodman([...client, "SET GLOBAL innodb_fast_shutdown=0"], CONTROL_TIMEOUT_MS);
  if (!boundedOk(slow)) return "shutdown-failed";
  const stopped = await boundedPodman(
    ["stop", "-t", String(SHUTDOWN_GRACE_S), containerName],
    SHUTDOWN_GRACE_S * 1000 + CONTROL_TIMEOUT_MS,
  );
  const exit = await boundedPodman(
    ["inspect", "--format", "{{.State.ExitCode}}", containerName],
    LOG_READ_TIMEOUT_MS,
  );
  if (!boundedOk(stopped) || !boundedOk(exit) || exit.stdout.trim() !== "0") return "shutdown-failed";
  const removed = await boundedPodman(CONTAINER_RM_ARGS(containerName), CONTROL_TIMEOUT_MS);
  if (!boundedOk(removed)) {
    throw new SandbarError(`db-base: could not remove ${containerName}: ${removed.errorMessage}`);
  }
  return null;
}

// The dump, read on the host and gunzipped into the client's stdin. Null when
// the client took all of it, else a reason code. Only the client's stderr
// tail is kept, for `sanitizeImportError`.
async function streamDump(
  cfg: DatabaseCopiesSettings,
  containerName: string,
  timeoutMs: number,
): Promise<string | null> {
  const child = spawn(
    RUNTIME,
    ["exec", "-i", containerName, "mariadb", "-uroot", cfg.database],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEPT_CHARS);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const exited = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  // Settled to a value, so the exit is awaited however the stream ended; it is
  // classified below and rethrown when it is none of the expected endings.
  const streamed = pipeline(createReadStream(cfg.dump), createGunzip(), child.stdin)
    .then(() => null, (err: unknown) => err);
  let streamError: unknown;
  let code: number | null;
  try {
    [streamError, [code]] = await Promise.all([streamed, exited]);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) return "timeout";
  if (code !== 0) return sanitizeImportError(stderr);
  if (streamError === null) return null;
  // zlib's codes: a truncated or corrupt gzip.
  if (String((streamError as { code?: unknown }).code).startsWith("Z_")) return "dump-unreadable";
  throw streamError;
}
