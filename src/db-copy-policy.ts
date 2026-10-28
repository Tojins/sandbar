// The pure decisions behind database copies (#201), table-tested in
// db-copy-policy.test.ts. The nightly base's: what a base was built by, when
// a dump needs importing, which bases are swept, what an import failure may
// say, and what the run complains about; `db-base.ts` is the I/O that applies
// them. A copy's: which base it may be made from, what the sibling it runs as
// looks like, and when a slot keeps, drops or acquires one; `db-copy.ts`
// applies those.
//
// A BASE IS A FUNCTION OF ITS DUMP AND ITS SERVER. The dump is identified by
// what a rename changes — name, size, mtime and inode — never by its bytes,
// which would mean reading 500 MB every 15 minutes. The server is the target
// container's image and args (`specTokenOf`), the same server and options
// (outdoor's `--ft-min-word-len=2`) that will open a copy. Env is left out, so a
// branch's env overlay (#186) never invalidates a base. A dump and token that
// already failed are not retried until one of them moves, or `--force`.
//
// NO DUMP CONTENT LEAVES THROUGH ANYTHING SANDBAR WRITES (#201 decision 13).
// MariaDB echoes values in its errors (`Duplicate entry '<email>'`), so an
// import failure is recorded as a reason code: a client error keeps only its
// code and dump line (`sanitizeImportError`). That is all a status, an event
// or a complaint carries.
//
// A superseded base is deleted only after a grace, so a copy that resolved the
// old path just before the swap finishes first.
//
// ONE COPY PER HOLDER, NEVER HANDED ON (decision 8). A copy is dropped at
// every change of holder and a fresh one made for the next, because the last
// holder's experiments dirtied it. The one exception is the implementer
// followed by the implementer (a re-prompt or a nudge round), which keeps it.

import { canonicalSha256 } from "./canonical-json.js";
import type { DatabaseCopiesSettings, ResolvedStackContainer } from "./config.js";
import { MIN_DB_VOLUME_FREE_BYTES } from "./disk-space.js";

// What a rename of the dump changes.
export type DumpIdentity = {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
};

// `bases/<id>.json`, written once the base is shut down cleanly; a base
// directory without one is an import that never finished.
export type BaseMeta = {
  readonly id: string;
  readonly dump: DumpIdentity;
  readonly specToken: string;
  readonly database: string;
  readonly image: string;
  readonly importedAt: string;
  readonly durationMs: number;
  readonly baseBytes: number;
  // Set once `current` no longer points here.
  readonly supersededAt?: string;
};

// `import-status.json`: the last attempt's outcome, which the daemon reads.
export type ImportStatus = {
  readonly attempt: string;
  readonly dump: DumpIdentity;
  readonly specToken: string;
  readonly durationMs: number;
  readonly finishedAt: string;
} & (
  | { readonly outcome: "imported"; readonly baseBytes: number }
  // `detail` is a reason code, never a server message.
  | { readonly outcome: "import-failed"; readonly detail: string }
);

// One attempt, as the run records it (#194 dedupes by `attempt`).
export type DbBaseEvent = {
  readonly kind: "db-base";
  readonly action: ImportStatus["outcome"];
  readonly attempt: string;
  readonly dump: DumpIdentity;
  readonly durationMs: number;
  readonly baseBytes?: number;
  readonly detail?: string;
};

export function dbBaseEventOf(status: ImportStatus): DbBaseEvent {
  const { attempt, dump, durationMs } = status;
  return status.outcome === "imported"
    ? { kind: "db-base", action: status.outcome, attempt, dump, durationMs, baseBytes: status.baseBytes }
    : { kind: "db-base", action: status.outcome, attempt, dump, durationMs, detail: status.detail };
}

// The server a base is built by and a copy is opened by.
export function specTokenOf(container: ResolvedStackContainer): string {
  return canonicalSha256({ image: container.image, args: container.args });
}

// `b20261028T180512123Z`: sortable, and unique for a job that holds the lock.
export function baseIdAt(date: Date): string {
  return `b${date.toISOString().replace(/[-:.]/g, "")}`;
}

export const BASE_ID_RE = /^b\d{8}T\d{9}Z$/;

function sameDump(a: DumpIdentity, b: DumpIdentity): boolean {
  return a.name === b.name && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

export function importNeeded(
  status: ImportStatus | null,
  dump: DumpIdentity,
  specToken: string,
  force: boolean,
): boolean {
  if (force || status === null) return true;
  return !sameDump(status.dump, dump) || status.specToken !== specToken;
}

export const SUPERSEDED_GRACE_MS = 10 * 60_000;

// What a job run does to `bases/` before importing: `remove` the bases that
// never finished and the superseded ones past the grace; `stamp` a base that
// lost `current` without being marked (a job that died between the swap and
// the mark), so its grace starts now. `current` is never touched.
export function basesToSweep(
  bases: readonly { readonly id: string; readonly meta: BaseMeta | null }[],
  currentId: string | null,
  now: number,
): { readonly remove: readonly string[]; readonly stamp: readonly string[] } {
  const remove: string[] = [];
  const stamp: string[] = [];
  for (const { id, meta } of bases) {
    if (id === currentId) continue;
    if (meta === null) remove.push(id);
    else if (meta.supersededAt === undefined) stamp.push(id);
    else if (now - Date.parse(meta.supersededAt) >= SUPERSEDED_GRACE_MS) remove.push(id);
  }
  return { remove, stamp };
}

// The free space an import needs on the volume, beyond which the floor must
// still hold: a quarter more than the base it replaces, or, with none to go
// by, twenty times the gzipped dump.
export function importSpaceNeeded(
  previousBaseBytes: number | null,
  dumpBytes: number,
): bigint {
  const base = previousBaseBytes === null
    ? 20n * BigInt(dumpBytes)
    : (BigInt(previousBaseBytes) * 5n + 3n) / 4n;
  return base + MIN_DB_VOLUME_FREE_BYTES;
}

// The `mariadb` client's own error line: `ERROR 1062 (23000) at line 412: …`.
const CLIENT_ERROR = /^ERROR (\d+)(?: \([0-9A-Z]{5}\))?(?: at line (\d+))?/m;

// The client's stderr as a reason code: its error number and dump line, with
// the message, which may quote a row, dropped.
export function sanitizeImportError(stderr: string): string {
  const match = CLIENT_ERROR.exec(stderr);
  if (match === null) return "client-failed";
  return match[2] === undefined
    ? `ERROR ${match[1]}`
    : `ERROR ${match[1]} at dump line ${match[2]}`;
}

export type DbBaseComplaint = { readonly key: string; readonly message: string };

// What the run header should say about the base, keyed so a run says each
// once: per failed attempt, per stale dump, and once for a missing one.
export function dbBaseComplaints(input: {
  readonly status: ImportStatus | null;
  readonly drop: DumpIdentity | null;
  readonly dumpPath: string;
  readonly now: number;
  readonly staleAfterMs: number;
}): readonly DbBaseComplaint[] {
  const { status, drop, dumpPath } = input;
  const complaints: DbBaseComplaint[] = [];
  if (drop === null) {
    complaints.push({
      key: "dump-missing",
      message: `Database copies: no dump at ${dumpPath}, so no base can be imported.`,
    });
  } else if (input.now - drop.mtimeMs > input.staleAfterMs) {
    complaints.push({
      key: `dump-stale:${drop.ino}:${drop.mtimeMs}`,
      message: `Database copies: the dump at ${dumpPath} is from ` +
        `${new Date(drop.mtimeMs).toISOString()}, older than ` +
        `${Math.round(input.staleAfterMs / 3_600_000)}h; no newer one has arrived.`,
    });
  }
  if (status?.outcome === "import-failed") {
    complaints.push({
      key: `import-failed:${status.attempt}`,
      message: `Database copies: importing ${status.dump.name} as ${status.attempt} ` +
        `failed (${status.detail}); the previous base stays current.`,
    });
  }
  return complaints;
}

// Who a copy is made for.
export type DbCopyHolder = "implementer" | "scenario-runner";

// Why a holder proceeds without a copy (decision 10): no base yet, a base
// built by another server, a low volume, a failed `cp`, or a copy that did
// not come up.
export type DbCopyUnavailable =
  | "no-base"
  | "base-mismatch"
  | "volume-low"
  | "copy-failed"
  | "bringup-failed";

// One change to an issue's copy, as the run records it (#194). `durationMs`
// is the `cp` through readiness for `created`, the swap-out for `dropped`.
// `volumeUsedBytes` is the volume's statfs at the drop: XFS shares extents,
// so a copy's own bytes have no exact measure and are not recorded.
export type DbCopyEvent = {
  readonly kind: "db-copy";
  readonly issue: number;
  readonly title: string;
  readonly holder: DbCopyHolder;
  readonly durationMs: number;
} & (
  | {
      readonly action: "created";
      readonly base: string;
      readonly hook: "ok" | "failed" | "none";
      readonly hookMs?: number;
    }
  | { readonly action: "dropped"; readonly base: string; readonly volumeUsedBytes: number }
  | { readonly action: "failed"; readonly detail: DbCopyUnavailable }
);

// What a slot does to move from the copy it holds to the holder the next
// action wants: drop the current copy, acquire a new one, both, or neither.
export function planAlign(
  current: DbCopyHolder | null,
  desired: DbCopyHolder | null,
): { readonly drop: boolean; readonly acquire: DbCopyHolder | null } {
  if (current === "implementer" && desired === "implementer") return { drop: false, acquire: null };
  return { drop: current !== null, acquire: desired };
}

// Whether a copy of the base `meta` describes may be opened by `target`: the
// same server built it, into the configured schema.
export function baseCompatible(
  meta: BaseMeta,
  target: ResolvedStackContainer,
  cfg: DatabaseCopiesSettings,
): boolean {
  return meta.specToken === specTokenOf(target) && meta.database === cfg.database;
}

// The target sibling as it runs on a copy: the copy mounted read-write at its
// datadir, and the copy's buffer pool appended last so it wins. Its own
// mounts and env pass through unchanged; the entrypoint skips its init,
// schema.sql included, because the copy already has `<datadir>/mysql`
// (decision 7).
export function withDbCopy(
  target: ResolvedStackContainer,
  hostPath: string,
  cfg: DatabaseCopiesSettings,
): ResolvedStackContainer {
  return {
    ...target,
    mounts: [...target.mounts, { hostPath, containerPath: cfg.datadir, mode: "rw" }],
    args: [...target.args, `--innodb-buffer-pool-size=${cfg.bufferPoolBytes}`],
  };
}
