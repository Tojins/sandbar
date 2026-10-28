// Per-issue database copies (#201): a reflink copy of the current base, run
// beside the issue's sandbox stack in place of its target sibling. The pure
// decisions are db-copy-policy.ts's; this is the I/O that applies them.
//
// THE DAEMON OWNS `<root>/copies/` (decision 14); the base job owns the rest
// of the root (`db-base.ts`). A copy is `cp -a --reflink=always` of what
// `current` resolves to, run under `podman unshare` because the base is
// subuid-owned. `always`, never `auto`: on a volume without reflink, `auto`
// would silently make a full multi-GB copy. Each copy's dir is scoped by the
// run (`dbCopyDirName`), so everything under this run's prefix is either a
// live lease or debris from a dead run of the same workdir; `sweepDbCopies`
// removes them at startup and at quiescence, when no lease can be live.
// `dbVolumeRefusals` is preflight's question: the root exists and a reflink
// copy succeeds on it, which is what "the volume is mounted" means here.
//
// ONE COPY PER ISSUE (`createDbCopies`). A second live lease for the same
// issue is a programming error and throws. Each acquisition measures the
// volume first and is refused below the floor (`volume-low`, disk-space.ts),
// for issues already in flight too: ENOSPC under InnoDB corrupts what the
// agent reads. A lease's `release` removes the copy, is idempotent, and is
// registered with cleanup.ts so a signal removes it too.
//
// A COPY IS AN AID, NEVER A PRECONDITION (decision 10). No base, a base built
// by another server, a low volume, a failed `cp` or a copy that does not come
// up is an `unavailable` answer with a reason code and a `db-copy` `failed`
// event; the fixtures sibling keeps running and the holder proceeds without
// one. Only podman or the filesystem failing outright throws.
//
// THE SLOT (`createDbCopySlot`) is one sandbox's: `align(holder)` applies
// `planAlign` before each action. Dropping swaps the copy out of the stack,
// releases it and records `dropped` with the volume's used bytes. Acquiring
// swaps a fresh copy in, then runs `onDbCopyReady` in the agent container,
// its output appended to `db-copy-hook.log` in the sandbox's log dir; a
// failing hook keeps the copy up and is recorded, never retried. Events
// carry reason codes only, never server output (decision 13).

import { readdir, realpath, rm, stat, writeFile, appendFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import type { SandboxHook, Sandbox } from "./agent-sandbox.js";
import { registerDisposable, reportCleanupNotice } from "./cleanup.js";
import type { DatabaseCopiesSettings, DbCopyTarget } from "./config.js";
import type { SweepResult } from "./containers.js";
import {
  type UsernsRun,
  UsernsCommandError,
  dbBaseLayout,
  podmanUnshare,
  readBaseMeta,
} from "./db-base.js";
import {
  type DbCopyEvent,
  type DbCopyHolder,
  type DbCopyUnavailable,
  baseCompatible,
  planAlign,
  withDbCopy,
} from "./db-copy-policy.js";
import { type DbVolumeSpace, dbVolumeSpace, dbVolumeSpaceIsLow, usedBytes } from "./disk-space.js";
import { hasExitCode, isErrno, SandbarError } from "./errors.js";
import { type RunScope, dbCopyDirName, isOwnDbCopyDir } from "./naming.js";
import type { SandboxStack } from "./sandbox-stack.js";
import { startTimer } from "./timing.js";

const exec = promisify(execFile);

export type DbCopyLease = {
  readonly hostPath: string;
  // The base's id, and the day its dump was taken (UTC).
  readonly base: string;
  readonly dumpDate: string;
  readonly release: () => Promise<void>;
};

export type DbCopyAcquired =
  | { readonly kind: "ok"; readonly lease: DbCopyLease }
  | { readonly kind: "unavailable"; readonly reason: DbCopyUnavailable };

export type DbCopies = {
  readonly cfg: DatabaseCopiesSettings;
  readonly acquire: (issueId: string, target: DbCopyTarget) => Promise<DbCopyAcquired>;
};

export function createDbCopies(opts: {
  readonly cfg: DatabaseCopiesSettings;
  readonly scope: RunScope;
  readonly userns?: UsernsRun;
  readonly volumeSpace?: (root: string) => Promise<DbVolumeSpace>;
}): DbCopies {
  const { cfg, scope } = opts;
  const userns = opts.userns ?? podmanUnshare;
  const layout = dbBaseLayout(cfg.root);
  const live = new Set<string>();
  let seq = 0;

  const copyOf = async (issueId: string, target: DbCopyTarget): Promise<DbCopyAcquired> => {
    const unavailable = (reason: DbCopyUnavailable): DbCopyAcquired => ({ kind: "unavailable", reason });
    if (dbVolumeSpaceIsLow(await (opts.volumeSpace ?? dbVolumeSpace)(cfg.root))) {
      return unavailable("volume-low");
    }
    let basePath: string;
    try {
      basePath = await realpath(layout.current);
    } catch (err) {
      if (!isErrno(err, "ENOENT")) throw err;
      return unavailable("no-base");
    }
    const meta = await readBaseMeta(layout, basename(basePath));
    if (meta === null) return unavailable("no-base");
    if (!baseCompatible(meta, target, cfg)) return unavailable("base-mismatch");

    const hostPath = join(layout.copies, dbCopyDirName(scope, issueId, ++seq));
    try {
      await userns(["cp", "-a", "--reflink=always", basePath, hostPath]);
    } catch (err) {
      if (!(err instanceof UsernsCommandError)) throw err;
      // A partial copy would hold its pages until the next sweep.
      await userns(["rm", "-rf", hostPath]);
      return unavailable("copy-failed");
    }
    let released: Promise<void> | null = null;
    const release = (): Promise<void> => {
      released ??= (async () => {
        withdraw();
        live.delete(issueId);
        await userns(["rm", "-rf", hostPath]);
      })();
      return released;
    };
    const withdraw = registerDisposable(release);
    return {
      kind: "ok",
      lease: {
        hostPath,
        base: meta.id,
        dumpDate: new Date(meta.dump.mtimeMs).toISOString().slice(0, 10),
        release,
      },
    };
  };

  return {
    cfg,
    acquire: async (issueId, target) => {
      if (live.has(issueId)) {
        throw new SandbarError(`database copies: issue ${issueId} already holds a copy`);
      }
      live.add(issueId);
      let acquired: DbCopyAcquired | null = null;
      try {
        acquired = await copyOf(issueId, target);
        return acquired;
      } finally {
        if (acquired?.kind !== "ok") live.delete(issueId);
      }
    },
  };
}

// Removes every copy under this run's prefix. Only where no lease can be
// live: at startup, and when the pool is quiescent.
export async function sweepDbCopies(opts: {
  readonly cfg: DatabaseCopiesSettings;
  readonly scope: RunScope;
  readonly userns?: UsernsRun;
}): Promise<SweepResult> {
  const { copies } = dbBaseLayout(opts.cfg.root);
  const userns = opts.userns ?? podmanUnshare;
  let names: string[];
  try {
    names = await readdir(copies);
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
    return { removed: [], failures: [] };
  }
  const removed: string[] = [];
  const failures: string[] = [];
  for (const name of names.filter((n) => isOwnDbCopyDir(opts.scope, n))) {
    try {
      await userns(["rm", "-rf", join(copies, name)]);
      removed.push(name);
    } catch (err) {
      if (!(err instanceof UsernsCommandError)) throw err;
      failures.push(`  ${join(copies, name)}\n    ${err.message}`);
    }
  }
  return { removed, failures };
}

// Preflight's refusals for the volume: the root must exist, and a reflink
// copy must succeed in `copies/`, which is created here.
export async function dbVolumeRefusals(cfg: DatabaseCopiesSettings): Promise<string[]> {
  const refuse = (why: string) => [
    `config.databaseCopies.root ${cfg.root}: the database volume is not mounted ` +
      `or has no reflink support (${why}).`,
  ];
  try {
    if (!(await stat(cfg.root)).isDirectory()) return refuse("not a directory");
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
    return refuse("it does not exist");
  }
  const { copies } = dbBaseLayout(cfg.root);
  await mkdir(copies, { recursive: true });
  const probe = join(copies, `.reflink-probe-${process.pid}`);
  await writeFile(probe, "reflink probe\n");
  try {
    await exec("cp", ["--reflink=always", probe, `${probe}.copy`]);
    return [];
  } catch (err) {
    if (!hasExitCode(err)) throw err;
    const { stderr } = err as { stderr?: unknown };
    return refuse(String(stderr ?? "").trim() || "cp --reflink=always failed");
  } finally {
    await rm(probe, { force: true });
    await rm(`${probe}.copy`, { force: true });
  }
}

export type DbCopyStatus =
  | {
      readonly kind: "held";
      readonly holder: DbCopyHolder;
      readonly dumpDate: string;
      readonly hook: "ok" | "failed" | "none";
    }
  | { readonly kind: "none" }
  | { readonly kind: "unavailable"; readonly reason: DbCopyUnavailable };

export type DbCopySlot = {
  // Keeps, drops or replaces the sandbox's copy for the holder the next
  // action wants; null drops it.
  readonly align: (desired: DbCopyHolder | null) => Promise<DbCopyStatus>;
};

export const DB_COPY_HOOK_LOG = "db-copy-hook.log";

export function createDbCopySlot(opts: {
  readonly copies: DbCopies;
  readonly target: DbCopyTarget;
  readonly stack: Pick<SandboxStack, "swapDbCopyIn" | "swapDbCopyOut">;
  readonly sandbox: Pick<Sandbox, "runHooks">;
  readonly hooks: ReadonlyArray<SandboxHook>;
  readonly issue: { readonly id: string; readonly title: string };
  // The sandbox's log dir, mounted in the agent container.
  readonly logDir: string;
  readonly emit: (event: DbCopyEvent) => Promise<unknown>;
}): DbCopySlot {
  const { copies, issue } = opts;
  const { cfg } = copies;
  type Held = {
    readonly lease: DbCopyLease;
    readonly status: Extract<DbCopyStatus, { kind: "held" }>;
  };
  let held: Held | null = null;
  const record = { issue: Number(issue.id), title: issue.title };

  // Runs `step`; if it throws, the lease is released before the throw goes
  // on, so the issue is not left holding a copy nothing runs on.
  const releasingOnThrow = async <T>(lease: DbCopyLease, step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (err) {
      try {
        await lease.release();
      } catch (cleanupErr) {
        await reportCleanupNotice(
          "cleanup-failure",
          `Database copy ${lease.hostPath} for issue ${issue.id} could not be removed`,
          cleanupErr,
        );
      }
      throw err;
    }
  };

  const drop = async ({ lease, status }: Held): Promise<void> => {
    const elapsed = startTimer();
    held = null;
    await releasingOnThrow(lease, () => opts.stack.swapDbCopyOut());
    await lease.release();
    await opts.emit({
      kind: "db-copy", ...record, holder: status.holder, action: "dropped",
      durationMs: elapsed(), base: lease.base, volumeUsedBytes: Number(await usedBytes(cfg.root)),
    });
  };

  const acquire = async (holder: DbCopyHolder): Promise<DbCopyStatus> => {
    const elapsed = startTimer();
    const fail = async (reason: DbCopyUnavailable): Promise<DbCopyStatus> => {
      await opts.emit({ kind: "db-copy", ...record, holder, action: "failed", durationMs: elapsed(), detail: reason });
      return { kind: "unavailable", reason };
    };
    const got = await copies.acquire(issue.id, opts.target);
    if (got.kind === "unavailable") return await fail(got.reason);
    const { lease } = got;
    const label = `${basename(lease.hostPath)} (dump of ${lease.dumpDate})`;
    const up = await releasingOnThrow(lease, () => opts.stack.swapDbCopyIn({
      container: withDbCopy(opts.target, lease.hostPath, cfg),
      label,
    }));
    if (!up) {
      await lease.release();
      return await fail("bringup-failed");
    }
    const durationMs = elapsed();
    let hook: Held["status"]["hook"] = "none";
    let hookMs: number | undefined;
    if (opts.hooks.length > 0) {
      const hookElapsed = startTimer();
      const ran = await opts.sandbox.runHooks(opts.hooks);
      hookMs = hookElapsed();
      hook = ran.ok ? "ok" : "failed";
      await appendFile(
        join(opts.logDir, DB_COPY_HOOK_LOG),
        `[sandbar] onDbCopyReady for db copy ${label}\n${ran.output}\n`,
        "utf8",
      );
    }
    const status = { kind: "held", holder, dumpDate: lease.dumpDate, hook } as const;
    held = { lease, status };
    await opts.emit({
      kind: "db-copy", ...record, holder, action: "created", durationMs, base: lease.base, hook,
      ...(hookMs === undefined ? {} : { hookMs }),
    });
    return status;
  };

  return {
    align: async (desired) => {
      const plan = planAlign(held?.status.holder ?? null, desired);
      if (plan.drop && held !== null) await drop(held);
      if (plan.acquire !== null) return await acquire(plan.acquire);
      return held?.status ?? { kind: "none" };
    },
  };
}
