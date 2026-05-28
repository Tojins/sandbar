// Single-instance lock for sandbar runs.
//
// Uses proper-lockfile for the atomic acquire (mkdir-based) and a sidecar
// PID file for stale-PID takeover: if the lock dir is left behind by a
// crashed prior run whose PID is no longer alive, we silently release it
// and acquire fresh.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

async function maybeReleaseStaleLock(paths: LockPaths): Promise<void> {
  if (!existsSync(paths.pidPath)) return;
  let oldPid: number;
  try {
    oldPid = Number.parseInt(readFileSync(paths.pidPath, "utf8").trim(), 10);
  } catch {
    return;
  }
  if (!Number.isFinite(oldPid) || oldPid <= 0) return;
  if (pidIsAlive(oldPid)) return;
  try {
    await lockfile.unlock(paths.lockPath);
  } catch {
    // already released
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

  writeFileSync(paths.pidPath, String(process.pid));

  return async () => {
    try {
      unlinkSync(paths.pidPath);
    } catch {
      // ignore
    }
    await release();
  };
}
