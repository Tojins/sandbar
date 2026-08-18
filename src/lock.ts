// Single-instance lock for sandbar runs.
//
// Uses proper-lockfile for the atomic acquire (mkdir-based) and a sidecar PID
// file for stale-PID takeover: if the lock dir is left behind by a crashed
// prior run whose PID is no longer alive, we remove it and acquire fresh.
//
// The takeover removes proper-lockfile's lock DIRECTORY itself rather than
// calling `lockfile.unlock`, and that is the whole of it working. `unlock`
// resolves the path against a module-level registry of locks THIS process
// holds and returns ENOTACQUIRED for anything else, so against the only holder
// a takeover can ever face — a dead *other* process — it is a guaranteed no-op.
// It succeeds in exactly one arrangement: the same process locking twice, where
// the recorded pid is our own and therefore alive, so the takeover is never
// reached. Recovery from a crashed run was left entirely to proper-lockfile's
// own 10s mtime staleness — i.e. to the timer this sidecar exists to skip.
//
// Removing the dir directly is safe because it is gated on positive evidence
// the holder is dead (`process.kill(pid, 0)` → ESRCH). Two launches can race
// into it, but the acquire that follows is an atomic mkdir, so exactly one
// wins. The path is derived the way proper-lockfile derives it — `realpath` of
// the lock file plus `.lock` (`lockfile.js:11-23`, `realpath: true` is its
// default). That is alignment, not a fix for an observed break: a symlink on a
// directory component resolves transparently, so the naive path would find the
// same directory. Mirroring the library is still the right default for a path
// we compute only because it does not expose it.

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
  } catch {
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
  } catch {
    // Could not clear it — a permissions problem, or someone else got there
    // first. Leave the sidecar ALONE: it is the only evidence the next launch
    // has that the holder is dead, and deleting it here would demote the next
    // attempt to proper-lockfile's 10s staleness for no reason. The acquire
    // below will report the lock as held, which is the honest answer.
    return;
  }
  try {
    unlinkSync(paths.pidPath);
  } catch {
    // already gone
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
    await release().catch(() => {});
    throw err;
  }

  return async () => {
    try {
      unlinkSync(paths.pidPath);
    } catch {
      // ignore
    }
    await release();
  };
}
