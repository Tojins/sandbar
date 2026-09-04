// Single-instance lock for sandbar runs.
//
// Uses proper-lockfile for the atomic acquire (mkdir-based) and a sidecar PID
// file for stale-PID takeover: if the lock dir is left behind by a crashed
// prior run whose PID is no longer alive, we remove it and acquire fresh.
//
// The takeover removes proper-lockfile's lock DIRECTORY itself, never
// `lockfile.unlock` — unlock resolves against a registry of locks THIS process
// holds, so against a dead *other* process it is a guaranteed no-op. Removing
// the dir directly is safe because it is gated on positive evidence the holder
// is dead (`process.kill(pid, 0)` → ESRCH); two launches can race into it, but
// the acquire that follows is an atomic mkdir, so exactly one wins. The path
// is derived the way proper-lockfile derives it — `realpath` of the lock file
// plus `.lock`.

import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { isErrno } from "./errors.js";

const staleLockRemovalRefused = (err: unknown): boolean =>
  ["EACCES", "EPERM", "EROFS"].some((code) => isErrno(err, code));

export type LockPaths = {
  readonly workDir: string;
  readonly lockPath: string;
  readonly pidPath: string;
};

export function lockPathsFor(workDir: string): LockPaths {
  return {
    workDir,
    lockPath: path.join(workDir, "run.lock"),
    pidPath: path.join(workDir, "run.pid"),
  };
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code !== "ESRCH";
  }
}

// proper-lockfile's lock directory for `lockPath`. `realpathSync` mirrors its
// own `resolveCanonicalPath`; the lock file is written by acquireLock before
// this is ever called, so it exists.
function lockDirFor(lockPath: string): string {
  return `${realpathSync(lockPath)}.lock`;
}

async function maybeReleaseStaleLock(paths: LockPaths): Promise<void> {
  if (!existsSync(paths.pidPath)) return;
  let oldPid: number;
  try {
    oldPid = Number.parseInt(readFileSync(paths.pidPath, "utf8").trim(), 10);
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
    return;
  }
  // Fail CLOSED on a sidecar we cannot read as a pid: a truncated or garbage
  // file is not evidence of death. (`pidIsAlive` maps every non-ESRCH outcome
  // to "alive" and would reach the same answer, but the two are independent on
  // purpose — this is the branch that decides whether to delete another
  // process's lock.) `<= 0` is separately load-bearing: `process.kill(0, 0)`
  // signals the whole process GROUP and would report a dead holder alive.
  if (!Number.isFinite(oldPid) || oldPid <= 0) return;
  if (pidIsAlive(oldPid)) return;

  try {
    rmSync(lockDirFor(paths.lockPath), { recursive: true, force: true });
  } catch (err) {
    // These conditions do not let us prove the stale lock was removed. Leave
    // its sidecar alone and let the atomic acquire below report it as held.
    if (!staleLockRemovalRefused(err)) throw err;
    return;
  }
  try {
    unlinkSync(paths.pidPath);
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
  }
}

export class LockHeldError extends Error {
  constructor(lockPath: string) {
    super(`Another sandbar run is in progress (lock held at ${lockPath}).`);
    this.name = "LockHeldError";
  }
}

export type Release = () => Promise<void>;

export async function acquireLock(paths: LockPaths): Promise<Release> {
  mkdirSync(paths.workDir, { recursive: true });
  if (!existsSync(paths.lockPath)) writeFileSync(paths.lockPath, "");

  await maybeReleaseStaleLock(paths);

  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(paths.lockPath, { retries: 0 });
  } catch (err) {
    if ((err as { code?: string }).code === "ELOCKED") {
      throw new LockHeldError(paths.lockPath);
    }
    throw err;
  }

  // The lock is HELD from here on, but the caller has no handle to release it
  // until we return one. A failing sidecar write (ENOSPC, a read-only workdir)
  // would otherwise throw out of here with the lock held and nothing registered
  // to give it back, so hand it back before rethrowing. Rethrow, not swallow:
  // without the sidecar a crash would fall back to the 10s staleness, and a
  // workdir we cannot write to fails everything downstream anyway.
  try {
    writeFileSync(paths.pidPath, String(process.pid));
  } catch (err) {
    try {
      await release();
    } catch (releaseErr) {
      console.error("Failed to release lock after PID sidecar write failed", {
        cause: releaseErr,
      });
    }
    throw err;
  }

  return async () => {
    try {
      unlinkSync(paths.pidPath);
    } catch (err) {
      if (!isErrno(err, "ENOENT")) throw err;
    } finally {
      // Removing the sidecar comes first so a successor cannot create its own
      // and have this holder unlink it. Releasing the real lock is mandatory
      // even when that sidecar cleanup fails.
      await release();
    }
  };
}
